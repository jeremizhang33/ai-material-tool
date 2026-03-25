const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = 9999;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 创建上传和输出目录
const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'outputs');
[uploadDir, outputDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

// multer 配置
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('[FFmpeg]', ffmpegPath, args.join(' '));
    execFile(ffmpegPath, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); }
      else { resolve(stdout); }
    });
  });
}

function cleanFiles(files) {
  files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
}

// ─── API：上传文件 ────────────────────────────────────────────────────────────

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  const files = req.files.map(f => ({ name: f.originalname, path: f.path, filename: f.filename }));
  res.json({ success: true, files });
});

// ─── API：视频合成 ────────────────────────────────────────────────────────────
// 参数：
//   videoFiles: [{filename}]   已上传的视频片段（按顺序）
//   logoFile: filename         logo文件（可选）
//   audioFile: filename        背景音乐文件（可选）
//   logoPos: 'topleft'|'topright'|'bottomleft'|'bottomright'（默认topright）
//   logoScale: 0.1-1.0（默认0.15）
//   audioVolume: 0.0-1.0（默认0.3）

app.post('/api/compose', async (req, res) => {
  const { videoFiles, logoFile, audioFile, logoPos = 'topright', logoScale = 0.15, audioVolume = 0.3 } = req.body;

  if (!videoFiles || videoFiles.length === 0) {
    return res.status(400).json({ success: false, error: '请至少上传一个视频片段' });
  }

  const tmpFiles = [];
  const outputFile = path.join(outputDir, `output_${Date.now()}.mp4`);

  try {
    let currentVideo;

    // ── Step 1: 合并多段视频 ──────────────────────────────────────────────────
    if (videoFiles.length === 1) {
      currentVideo = path.join(uploadDir, videoFiles[0].filename);
    } else {
      const concatList = path.join(uploadDir, `concat_${Date.now()}.txt`);
      tmpFiles.push(concatList);

      const listContent = videoFiles
        .map(v => `file '${path.join(uploadDir, v.filename).replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(concatList, listContent);

      const mergedVideo = path.join(uploadDir, `merged_${Date.now()}.mp4`);
      tmpFiles.push(mergedVideo);

      await runFFmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatList,
        '-c', 'copy',
        mergedVideo
      ]);
      currentVideo = mergedVideo;
    }

    // ── Step 2: 叠加 Logo（可选）────────────────────────────────────────────
    if (logoFile && logoFile.filename) {
      const logoPath = path.join(uploadDir, logoFile.filename);
      const withLogo = path.join(uploadDir, `logo_${Date.now()}.mp4`);
      tmpFiles.push(withLogo);

      // 计算位置
      const posMap = {
        topleft:     'overlay=10:10',
        topright:    `overlay=W-w-10:10`,
        bottomleft:  `overlay=10:H-h-10`,
        bottomright: `overlay=W-w-10:H-h-10`,
        center:      `overlay=(W-w)/2:(H-h)/2`
      };
      const overlayExpr = posMap[logoPos] || posMap.topright;
      const scaleFilter = `[1:v]scale=iw*${logoScale}:-1[logo];[0:v][logo]${overlayExpr}[v]`;

      await runFFmpeg([
        '-y',
        '-i', currentVideo,
        '-i', logoPath,
        '-filter_complex', scaleFilter,
        '-map', '[v]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'copy',
        withLogo
      ]);
      currentVideo = withLogo;
    }

    // ── Step 3: 合入背景音乐（可选）─────────────────────────────────────────
    if (audioFile && audioFile.filename) {
      const audioPath = path.join(uploadDir, audioFile.filename);

      await runFFmpeg([
        '-y',
        '-i', currentVideo,
        '-i', audioPath,
        '-filter_complex',
        `[0:a]volume=1.0[va];[1:a]volume=${audioVolume}[music];[va][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        outputFile
      ]);
    } else {
      // 无音乐，直接输出
      await runFFmpeg([
        '-y', '-i', currentVideo,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        outputFile
      ]);
    }

    // 清理中间文件
    cleanFiles(tmpFiles);

    res.json({ success: true, outputFile: path.basename(outputFile) });

  } catch (err) {
    cleanFiles(tmpFiles);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    console.error('[合成错误]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API：下载输出文件 ────────────────────────────────────────────────────────

app.get('/api/download/:filename', (req, res) => {
  const file = path.join(outputDir, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send('文件不存在');
  res.download(file);
});

// ─── API：获取视频信息（时长、分辨率）──────────────────────────────────────

app.post('/api/probe', async (req, res) => {
  const { filename } = req.body;
  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
  execFile(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath
  ], (err, stdout) => {
    if (err) return res.json({ error: '探测失败' });
    try { res.json(JSON.parse(stdout)); } catch(e) { res.json({ error: '解析失败' }); }
  });
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n🎬 视频合成服务已启动！\n');
  console.log('📌 本机：   http://localhost:' + PORT + '/video-composer.html');
  console.log('🌐 局域网： http://' + localIP + ':' + PORT + '/video-composer.html');
  console.log('\n按 Ctrl+C 停止服务\n');
});
