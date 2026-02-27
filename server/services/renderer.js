const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const config = require('../config');
const { captureFrames } = require('./puppeteer-capture');

// Active render jobs
const jobs = new Map();
let jobCounter = 0;

function startRender(fileName, beatTimes, broadcast, variantLabel, sequenceNum) {
  const jobId = String(++jobCounter);
  const filePath = path.join(config.INPUT_DIR, fileName);
  const baseName = fileName.replace('.html', '');

  // Build output name with optional sequence prefix + timeline time + variant label
  const timelineOffset = beatTimes[0] || 0;
  let outputName = baseName;
  if (sequenceNum != null) {
    outputName = `${String(sequenceNum).padStart(3, '0')}_${outputName}`;
  }
  // Add timeline timestamp: @00m12s345
  const tMins = Math.floor(timelineOffset / 60);
  const tSecs = Math.floor(timelineOffset % 60);
  const tMs = Math.round((timelineOffset % 1) * 1000);
  outputName += `_@${String(tMins).padStart(2, '0')}m${String(tSecs).padStart(2, '0')}s${String(tMs).padStart(3, '0')}`;
  if (variantLabel) {
    outputName += `_${variantLabel}`;
  }
  outputName += '.mp4';
  const outputPath = path.join(config.OUTPUT_DIR, outputName);

  // Load analysis
  let transitionMs = config.DEFAULT_TRANSITION_DURATION;
  let clickTarget = null;
  const analysisFile = path.join(config.DATA_DIR, `${fileName}.analysis.json`);
  if (fs.existsSync(analysisFile)) {
    const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
    if (analysis.maxTransitionMs) {
      transitionMs = Math.min(analysis.maxTransitionMs, 2000);
    }
    if (analysis.clickTarget) clickTarget = analysis.clickTarget;
  }

  const abortController = new AbortController();

  const job = {
    id: jobId,
    fileName,
    outputName,
    variantLabel: variantLabel || null,
    timelineOffset,
    status: 'running',
    progress: { frame: 0, totalFrames: 0, percent: 0 },
    startedAt: Date.now(),
    cancel: () => abortController.abort(),
    promise: null,
  };

  job.promise = runRender(job, filePath, outputPath, beatTimes, transitionMs, abortController.signal, broadcast, clickTarget)
    .then(() => {
      job.status = 'done';
      broadcast({ type: 'render-done', jobId, outputName, timelineOffset });
    })
    .catch(err => {
      if (err.message === 'Render cancelled') {
        job.status = 'cancelled';
        broadcast({ type: 'render-cancelled', jobId });
      } else {
        job.status = 'error';
        job.error = err.message;
        broadcast({ type: 'render-error', jobId, error: err.message });
      }
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch {}
      }
    });

  jobs.set(jobId, job);
  return { id: jobId, status: 'running', fileName, outputName, variantLabel: variantLabel || null, timelineOffset };
}

async function runRender(job, filePath, outputPath, beatTimes, transitionMs, signal, broadcast, clickTarget) {
  // Use faster preset + JPEG input for speed
  const ffmpeg = spawn(ffmpegPath, [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(config.FPS),
    '-i', '-',
    '-c:v', 'libx264',
    '-crf', String(config.CRF),
    '-preset', 'medium',    // faster than 'slow', still good quality
    '-tune', config.TUNE,
    '-pix_fmt', config.PIXEL_FMT,
    '-movflags', '+faststart',
    outputPath,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (chunk) => { ffmpegError += chunk.toString(); });

  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegError.slice(-500)}`));
    });
    ffmpeg.on('error', reject);
  });

  const frameGen = captureFrames(filePath, beatTimes, transitionMs, (progress) => {
    job.progress = progress;
    broadcast({ type: 'render-progress', jobId: job.id, ...progress });
  }, signal, clickTarget);

  for await (const frameBuf of frameGen) {
    if (signal.aborted) break;
    const canWrite = ffmpeg.stdin.write(frameBuf);
    if (!canWrite) {
      await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
    }
  }

  ffmpeg.stdin.end();
  await ffmpegDone;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id, fileName: job.fileName, outputName: job.outputName,
    status: job.status, progress: job.progress, error: job.error,
    startedAt: job.startedAt, timelineOffset: job.timelineOffset,
  };
}

function getAllJobs() {
  return [...jobs.values()].map(j => ({
    id: j.id, fileName: j.fileName, outputName: j.outputName,
    status: j.status, progress: j.progress, error: j.error,
    startedAt: j.startedAt, timelineOffset: j.timelineOffset,
  }));
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (job && job.status === 'running') { job.cancel(); return true; }
  return false;
}

function getJobRaw(jobId) {
  return jobs.get(jobId) || null;
}

module.exports = { startRender, getJob, getJobRaw, getAllJobs, cancelJob };
