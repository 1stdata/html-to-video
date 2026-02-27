const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { startRender, getJob, getJobRaw, getAllJobs, cancelJob } = require('../services/renderer');

function resolveTimes(fileName, beatTimes) {
  let times = beatTimes;
  if (!times) {
    const timingFile = path.join(config.DATA_DIR, `${fileName}.timing.json`);
    if (fs.existsSync(timingFile)) {
      const saved = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
      times = saved.beatTimes;
    }
  }
  return times;
}

/**
 * Get the sequence number for a file based on its timeline position
 * relative to all files that have timing saved.
 */
function getSequenceNum(fileName) {
  const timingFiles = fs.readdirSync(config.DATA_DIR)
    .filter(f => f.endsWith('.timing.json'));

  const entries = [];
  for (const tf of timingFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, tf), 'utf-8'));
    if (data.beatTimes && data.beatTimes.length > 0) {
      const htmlName = tf.replace('.timing.json', '');
      entries.push({ name: htmlName, offset: data.beatTimes[0] || 0 });
    }
  }

  entries.sort((a, b) => a.offset - b.offset);
  const idx = entries.findIndex(e => e.name === fileName);
  return idx >= 0 ? idx + 1 : null;
}

// POST /api/render — start a single render job
router.post('/', (req, res) => {
  const { fileName, beatTimes, sequenceNum } = req.body;

  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' });
  }

  const filePath = path.join(config.INPUT_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found in input/' });
  }

  const times = resolveTimes(fileName, beatTimes);
  if (!times || !Array.isArray(times) || times.length === 0) {
    return res.status(400).json({ error: 'No beat times provided and none saved. Set timing first.' });
  }

  const broadcast = req.app.get('broadcast');
  // Auto-assign sequence number from timeline position
  const seqNum = sequenceNum || getSequenceNum(fileName);
  const job = startRender(fileName, times.map(Number), broadcast, null, seqNum);
  res.json(job);
});

// POST /api/render/variants — render multiple variant files with the same timing
router.post('/variants', (req, res) => {
  const { fileNames, beatTimes, sequenceNum } = req.body;

  if (!Array.isArray(fileNames) || fileNames.length < 2) {
    return res.status(400).json({ error: 'fileNames must be an array of at least 2 files' });
  }

  for (const name of fileNames) {
    if (!fs.existsSync(path.join(config.INPUT_DIR, name))) {
      return res.status(404).json({ error: `File not found: ${name}` });
    }
  }

  if (!beatTimes || !Array.isArray(beatTimes) || beatTimes.length === 0) {
    return res.status(400).json({ error: 'beatTimes is required for variant rendering' });
  }

  const broadcast = req.app.get('broadcast');
  const times = beatTimes.map(Number);

  // Use first file's sequence number for all variants
  const seqNum = sequenceNum || getSequenceNum(fileNames[0]);
  const jobs = fileNames.map((name, i) => {
    const variantLabel = `v${i + 1}`;
    return startRender(name, times, broadcast, variantLabel, seqNum);
  });

  res.json({ jobs });
});

// POST /api/render/all — render files sequentially, sorted by timeline position
// Output: 001_name.mp4, 002_name.mp4, etc. — ready for Automate to Sequence
// Body: { variant: 1 } — optional, only render Option{N} files
let renderAllRunning = false;

router.post('/all', (req, res) => {
  if (renderAllRunning) {
    return res.status(409).json({ error: 'Render-all already in progress' });
  }

  const broadcast = req.app.get('broadcast');
  const variantFilter = req.body?.variant; // e.g. 1 for Option1 only

  // Find all HTML files with saved timing
  const htmlFiles = fs.readdirSync(config.INPUT_DIR).filter(f => f.endsWith('.html'));
  const renderItems = [];

  for (const name of htmlFiles) {
    // Apply variant filter if specified
    if (variantFilter != null) {
      const optMatch = name.match(/Option(\d+)/i);
      if (!optMatch || parseInt(optMatch[1], 10) !== variantFilter) continue;
    }

    const timingFile = path.join(config.DATA_DIR, `${name}.timing.json`);
    if (!fs.existsSync(timingFile)) continue;

    const timing = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
    if (!timing.beatTimes || timing.beatTimes.length === 0) continue;

    const times = timing.beatTimes.map(Number);
    const timelineOffset = times[0] || 0;

    renderItems.push({ name, times, timelineOffset });
  }

  if (renderItems.length === 0) {
    return res.status(400).json({ error: 'No files have timing set. Upload SRT or set timing first.' });
  }

  // Sort by timeline position
  renderItems.sort((a, b) => a.timelineOffset - b.timelineOffset);

  // Respond immediately
  res.json({ started: true, totalFiles: renderItems.length });

  // Run sequentially in background
  renderAllRunning = true;
  runRenderAll(renderItems, broadcast).finally(() => {
    renderAllRunning = false;
  });
});

async function runRenderAll(renderItems, broadcast) {
  let completed = 0;
  const total = renderItems.length;

  for (let i = 0; i < renderItems.length; i++) {
    const item = renderItems[i];

    broadcast({
      type: 'render-queue-progress',
      currentFile: item.name,
      completed,
      total,
      status: 'starting',
    });

    const jobInfo = startRender(item.name, item.times, broadcast, null, i + 1);
    const rawJob = getJobRaw(jobInfo.id);

    if (rawJob && rawJob.promise) {
      try {
        await rawJob.promise;
      } catch {
        // Error already handled by renderer's catch block
      }
    }

    completed++;
    broadcast({
      type: 'render-queue-progress',
      currentFile: item.name,
      completed,
      total,
      status: rawJob?.status || 'done',
    });
  }

  broadcast({
    type: 'render-all-complete',
    completed,
    total,
  });
}

// GET /api/render — list all jobs
router.get('/', (req, res) => {
  res.json(getAllJobs());
});

// GET /api/render/:id — get job status
router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST /api/render/:id/cancel — cancel a running job
router.post('/:id/cancel', (req, res) => {
  const cancelled = cancelJob(req.params.id);
  if (cancelled) {
    res.json({ cancelled: true });
  } else {
    res.status(400).json({ error: 'Job not running or not found' });
  }
});

module.exports = router;
