const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { mapSrtToBeats, mapSrtToBeatsIntelligent } = require('../services/srt-parser');

// Multer for SRT file uploads (memory storage — we just need the text)
const srtUpload = multer({ storage: multer.memoryStorage() });

// GET /api/timing/:name — get saved timing for a file
router.get('/:name', (req, res) => {
  const timingFile = path.join(config.DATA_DIR, `${req.params.name}.timing.json`);
  if (!fs.existsSync(timingFile)) {
    return res.json({ beatTimes: [], source: 'none' });
  }
  res.json(JSON.parse(fs.readFileSync(timingFile, 'utf-8')));
});

// POST /api/timing/:name — save manual timing
router.post('/:name', (req, res) => {
  const { beatTimes } = req.body;
  if (!Array.isArray(beatTimes)) {
    return res.status(400).json({ error: 'beatTimes must be an array of numbers' });
  }

  const timing = {
    beatTimes: beatTimes.map(Number),
    source: 'manual',
    savedAt: new Date().toISOString(),
  };

  const timingFile = path.join(config.DATA_DIR, `${req.params.name}.timing.json`);
  fs.writeFileSync(timingFile, JSON.stringify(timing, null, 2));
  res.json(timing);
});

// POST /api/timing/:name/srt — upload SRT and map to beats
router.post('/:name/srt', srtUpload.single('srt'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No SRT file uploaded' });
  }

  // Load analysis for beat count + beat texts
  const analysisFile = path.join(config.DATA_DIR, `${req.params.name}.analysis.json`);
  let beatCount = 0;
  let beatTexts = null;
  if (fs.existsSync(analysisFile)) {
    const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
    beatCount = analysis.beatCount;
    beatTexts = analysis.beatTexts;
  }

  try {
    const srtContent = req.file.buffer.toString('utf-8');

    // Use intelligent mapping if we have beat texts, otherwise fall back to 1:1
    const result = (beatTexts && beatTexts.length > 0)
      ? mapSrtToBeatsIntelligent(srtContent, beatTexts)
      : mapSrtToBeats(srtContent, beatCount);

    const timing = {
      beatTimes: result.beatTimes,
      source: 'srt',
      method: result.method || 'sequential',
      srtFilename: req.file.originalname,
      cueCount: result.cueCount,
      matched: result.matched,
      matchedCount: result.matchedCount || null,
      mapping: result.mapping || null,
      cues: result.cues,
      savedAt: new Date().toISOString(),
    };

    const timingFile = path.join(config.DATA_DIR, `${req.params.name}.timing.json`);
    fs.writeFileSync(timingFile, JSON.stringify(timing, null, 2));
    res.json(timing);
  } catch (err) {
    res.status(400).json({ error: `SRT parse error: ${err.message}` });
  }
});

module.exports = router;
