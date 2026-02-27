const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { analyzeHtml } = require('../services/html-analyzer');
const { remapBeatsToSegmentCues } = require('../services/beat-remap');

// Upload config — save HTML files to input/
const storage = multer.diskStorage({
  destination: config.INPUT_DIR,
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.html') {
      cb(null, true);
    } else {
      cb(new Error('Only .html files are allowed'));
    }
  },
});

// GET /api/files — list HTML files in input/
router.get('/', (req, res) => {
  try {
    const files = fs.readdirSync(config.INPUT_DIR)
      .filter(f => f.endsWith('.html'))
      .map(name => {
        const stat = fs.statSync(path.join(config.INPUT_DIR, name));
        // Check if we have cached analysis
        const dataFile = path.join(config.DATA_DIR, `${name}.analysis.json`);
        let analysis = null;
        if (fs.existsSync(dataFile)) {
          analysis = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
        }
        // Check timing for timeline offset
        const timingFile = path.join(config.DATA_DIR, `${name}.timing.json`);
        let timelineOffset = null;
        if (fs.existsSync(timingFile)) {
          const timing = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
          if (timing.beatTimes && timing.beatTimes.length > 0) {
            timelineOffset = timing.beatTimes[0];
          }
        }
        return {
          name,
          size: stat.size,
          modified: stat.mtime,
          analysis,
          timelineOffset,
        };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/upload — upload HTML files
router.post('/upload', upload.array('files'), (req, res) => {
  res.json({
    uploaded: req.files.map(f => f.originalname),
  });
});

// POST /api/files/:name/analyze — run beat detection on a file
router.post('/:name/analyze', async (req, res) => {
  const filePath = path.join(config.INPUT_DIR, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const analysis = await analyzeHtml(filePath);

    // Cache result
    const dataFile = path.join(config.DATA_DIR, `${req.params.name}.analysis.json`);
    fs.writeFileSync(dataFile, JSON.stringify(analysis, null, 2));

    // If this file has project SRT timing, re-map beats to cues within its segment range
    remapBeatsToSegmentCues(req.params.name, analysis);

    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/files/:name
router.delete('/:name', (req, res) => {
  const filePath = path.join(config.INPUT_DIR, req.params.name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  // Also remove cached data
  const dataFile = path.join(config.DATA_DIR, `${req.params.name}.analysis.json`);
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  const timingFile = path.join(config.DATA_DIR, `${req.params.name}.timing.json`);
  if (fs.existsSync(timingFile)) fs.unlinkSync(timingFile);

  res.json({ deleted: req.params.name });
});

module.exports = router;
