const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// Analyze MKV file to extract all streams
function analyzeStreams(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const streams = {
        video: [],
        audio: [],
        subtitle: [],
      };

      metadata.streams.forEach((stream, index) => {
        console.log(`Stream ${index}: ${stream.codec_type} - ${stream.codec_name}`);
        if (stream.codec_type === 'video') streams.video.push(index);
        if (stream.codec_type === 'audio') streams.audio.push(index);
        if (stream.codec_type === 'subtitle') streams.subtitle.push(index);
      });

      resolve(streams);
    });
  });
}

function isAudioStreamAAC(filePath, streamIndex) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const stream = metadata.streams.find((s, idx) => s.codec_type === 'audio' && idx === streamIndex);
      if (!stream) return resolve(false);

      const codec = stream.codec_name;
      resolve(codec === 'aac');
    });
  });
}

// Create HLS output for each stream
async function createHLSForStreams(filePath, fileName, streams) {
  const outputPath = path.join(outputDir, fileName);
  fs.mkdirSync(outputPath, { recursive: true });

    const playlistEntries = [];
    const audioEntries = [];
    const subtitleEntries = [];

  // Video streams
  for (let i = 0; i < streams.video.length; i++) {
    const streamIndex = streams.video[i];
    const output = `${outputPath}/master.mp4`;
    
    const streamInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.streams[streamIndex]);
      });
    });
    const isH264 = streamInfo.codec_name === 'h264';

    await new Promise((resolve, reject) => {
       ffmpeg(filePath)
        .addOption('-map', `0:${streamIndex}`)
        .addOption('-c:v', 'copy')
        .output(output)
        .on('end', () => {
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  

// Audio streams
for (let i = 0; i < streams.audio.length; i++) {
  const streamIndex = streams.audio[i];
  const isAAC = await isAudioStreamAAC(filePath, streamIndex);
  const streamInfo = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.streams[streamIndex]);
    });
  });
  const codec = streamInfo.codec_name;
  const lang = streamInfo?.tags?.language || `und`;
  const output = `${outputPath}/audio_${lang}.aac`;
  await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .addOption('-map', `0:${streamIndex}`)
        .addOption('-c:a', isAAC ? 'copy' : 'aac')
        .output(output)
        .on('end', () => {
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  // Subtitle streams
  for (let i = 0; i < streams.subtitle.length; i++) {
    const streamIndex = streams.subtitle[i];
    const streamInfo = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.streams[streamIndex]);
        });
    });
  
    if(streamInfo.codec_name === 'hdmv_pgs_subtitle' || streamInfo.codec_name === 'subrip') {
      console.log(`Skipping unsupported subtitle codec: ${streamInfo.codec_name}`);
      continue;
    }

  const lang = streamInfo?.tags?.language || `und`;
  const vttOutput = `${outputPath}/sub_${lang}.vtt`;
  await new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions('-map', `0:${streamIndex}`, '-f', 'webvtt')
      .output(vttOutput)
      .on('end', () => {
        resolve();
      })
      .on('error', reject)
      .run();
  });
  }
  
  console.log(`Processing completed for ${fileName}`);
  return `${fileName}/master.mp4`;
}

app.post('/upload', upload.single('video'), async (req, res) => {
  const filePath = req.file.path;
  const fileName = path.parse(req.file.filename).name;

  try {
    const streams = await analyzeStreams(filePath);
    const streamUrl = await createHLSForStreams(filePath, fileName, streams);

    res.json({
      message: 'Video processed with all streams.',
      streamUrl: `/streams/${streamUrl}`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing video.');
  }
});

app.use('/streams', express.static(outputDir));

app.get('/', (req, res) => {
  res.send(`
    <h2>Upload MKV File</h2>
    <form method="POST" enctype="multipart/form-data" action="/upload">
      <input type="file" name="video" />
      <button type="submit">Upload</button>
    </form>
  `);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

const fsPromises = require('fs/promises');

app.get('/videos', async (req, res) => {
  try {
    const dirs = await fsPromises.readdir(outputDir, { withFileTypes: true });
    const videos = [];

    for (const dirent of dirs) {
      if (dirent.isDirectory()) {
        const videoPath = path.join(outputDir, dirent.name, 'master.mp4');
        if (fs.existsSync(videoPath)) {
          videos.push({
            name: dirent.name,
            url: `/streams/${dirent.name}/master.mp4`
          });
        }
      }
    }

    res.json(videos);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error listing videos');
  }
});


app.get('/media-list', async (req, res) => {
  const dir = req.query.dir; // e.g., /streams/movie123

  if (!dir) {
    return res.status(400).json({ error: 'Missing dir param' });
  }

  // Normalize the folder path
  const relativePath = dir.replace('/streams/', '');
  const dirPath = path.join(__dirname, 'output', relativePath);

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  const files = await fs.promises.readdir(dirPath);
  
  const subtitles = files
    .filter(f => /^sub_.*\.*$/i.test(f))
    .map(f => `${dir}/${f}`);

  const audios = files
    .filter(f => /^audio_.*\.*$/i.test(f))
    .map(f => `${dir}/${f}`);

  res.json({ subtitles, audios });
});
