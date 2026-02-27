const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { mapSrtToSegments } = require('../services/srt-parser');
const { analyzeHtml } = require('../services/html-analyzer');
const { remapBeatsToSegmentCues } = require('../services/beat-remap');

const srtUpload = multer({ storage: multer.memoryStorage() });

/**
 * POST /api/import — import a project folder.
 * Body: { folderPath: "/absolute/path/to/CreatorLuck_001" }
 *
 * Scans all SEGMENTO_XXXX/ subfolders, reads .txt scripts,
 * copies HTML files to input/, saves project.json.
 */
router.post('/', async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: 'folderPath is required' });
  }

  if (!fs.existsSync(folderPath)) {
    return res.status(400).json({ error: `Folder not found: ${folderPath}` });
  }

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const segmentDirs = entries
      .filter(e => e.isDirectory() && /^SEGMENT[O]?_\d{4}$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (segmentDirs.length === 0) {
      return res.status(400).json({ error: 'No SEGMENTO_XXXX folders found in the given path' });
    }

    const segments = [];
    let copiedCount = 0;

    for (const dir of segmentDirs) {
      const numMatch = dir.name.match(/(\d{4})$/);
      const num = numMatch ? parseInt(numMatch[1], 10) : 0;
      const segPath = path.join(folderPath, dir.name);

      // Read .txt script file
      const segFiles = fs.readdirSync(segPath);
      const txtFile = segFiles.find(f => f.endsWith('.txt'));
      let script = '';
      if (txtFile) {
        script = fs.readFileSync(path.join(segPath, txtFile), 'utf-8').trim();
      }

      // Find HTML option files (glob *Option*.html)
      const htmlFiles = segFiles.filter(f =>
        f.endsWith('.html') && /option/i.test(f)
      );

      // Copy HTML files to input/ with consistent naming: SEGMENT_XXXX_Option1.html
      const copiedNames = [];
      for (const htmlFile of htmlFiles) {
        // Extract option number
        const optMatch = htmlFile.match(/option\s*(\d+)/i);
        const optNum = optMatch ? optMatch[1] : '1';
        const destName = `SEGMENT_${String(num).padStart(4, '0')}_Option${optNum}.html`;

        const srcPath = path.join(segPath, htmlFile);
        const destPath = path.join(config.INPUT_DIR, destName);
        fs.copyFileSync(srcPath, destPath);
        copiedNames.push(destName);
        copiedCount++;
      }

      segments.push({
        num,
        script,
        htmlFiles: copiedNames.sort(),
        originalDir: dir.name,
      });
    }

    // Save project metadata
    const project = {
      sourcePath: folderPath,
      importedAt: new Date().toISOString(),
      segments,
    };

    const projectFile = path.join(config.DATA_DIR, 'project.json');
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    res.json({
      success: true,
      segmentCount: segments.length,
      filesCopied: copiedCount,
      segments: segments.map(s => ({
        num: s.num,
        hasScript: !!s.script,
        htmlFiles: s.htmlFiles,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

/**
 * GET /api/import/project — get current project metadata.
 */
router.get('/project', (req, res) => {
  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.json({ project: null });
  }
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
  res.json({ project });
});

/**
 * GET /api/import/segment-info/:fileName — get script + SRT cues for a file's segment.
 */
router.get('/segment-info/:fileName', (req, res) => {
  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.json({ segment: null });
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
  const fileName = req.params.fileName;

  // Find which segment this file belongs to
  const segment = project.segments.find(s => s.htmlFiles.includes(fileName));
  if (!segment) {
    return res.json({ segment: null });
  }

  // Get SRT match info
  let srtMatch = null;
  if (project.srtMatch) {
    srtMatch = project.srtMatch.segmentMatches.find(m => m.num === segment.num);
  }

  // Get SRT cues — wide range so the user can pick a different start
  let srtCues = [];
  let allSrtCues = [];
  if (srtMatch && srtMatch.startTime != null) {
    const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
    if (fs.existsSync(srtCacheFile)) {
      const { parseSrt } = require('../services/srt-parser');
      const srtContent = fs.readFileSync(srtCacheFile, 'utf-8');
      allSrtCues = parseSrt(srtContent);
      // Show cues in a wide window: 30s before to 30s after the segment range
      const wideBuffer = 30;
      srtCues = allSrtCues.filter(c =>
        c.startTime >= (srtMatch.startTime - wideBuffer) &&
        c.startTime <= (srtMatch.endTime + wideBuffer)
      );
    }
  }

  // Mark which cues are inside the current segment range
  const startT = srtMatch?.startTime ?? 0;
  const endT = srtMatch?.endTime ?? 0;
  const annotatedCues = srtCues.map(c => ({
    ...c,
    inRange: c.startTime >= (startT - 1) && c.startTime <= (endT + 1),
  }));

  res.json({
    segment: {
      num: segment.num,
      script: segment.script,
      startTime: srtMatch?.startTime ?? null,
      endTime: srtMatch?.endTime ?? null,
      confidence: srtMatch?.confidence ?? null,
      matched: srtMatch?.matched ?? false,
      srtCues: annotatedCues,
    },
  });
});

/**
 * GET /api/import/srt-cues — return ALL SRT cues with segment ownership markers.
 * Used by the SRT Timeline panel so users can drag-assign segments.
 */
router.get('/srt-cues', (req, res) => {
  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.json({ cues: [], segments: [] });
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
  const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
  if (!fs.existsSync(srtCacheFile)) {
    return res.json({ cues: [], segments: [] });
  }

  const { parseSrt } = require('../services/srt-parser');
  const srtContent = fs.readFileSync(srtCacheFile, 'utf-8');
  const allCues = parseSrt(srtContent);

  // Build segment ownership map: for each cue, which segment owns it?
  const segmentMatches = project.srtMatch?.segmentMatches || [];
  const cuesWithOwner = allCues.map(c => {
    let owner = null;
    for (const m of segmentMatches) {
      if (m.startTime != null && c.startTime >= m.startTime - 0.5 && c.startTime < (m.endTime || Infinity)) {
        owner = m.num;
        break;
      }
    }
    return {
      startTime: c.startTime,
      endTime: c.endTime,
      text: c.text,
      segmentNum: owner,
    };
  });

  // Segment summary for the timeline
  const segSummary = (project.segments || []).map(s => {
    const match = segmentMatches.find(m => m.num === s.num);
    return {
      num: s.num,
      script: (s.script || '').slice(0, 80),
      startTime: match?.startTime ?? null,
      endTime: match?.endTime ?? null,
      matched: match?.matched ?? false,
      confidence: match?.confidence ?? null,
    };
  });

  res.json({ cues: cuesWithOwner, segments: segSummary });
});

/**
 * POST /api/import/match-srt — upload SRT and match against all project segments.
 * Uses the .txt script content for matching, not HTML display text.
 * Saves per-file timing for each segment's HTML files.
 */
router.post('/match-srt', srtUpload.single('srt'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No SRT file uploaded' });
  }

  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.status(400).json({ error: 'No project imported. Import a project folder first.' });
  }

  try {
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
    const srtContent = req.file.buffer.toString('utf-8');

    // Cache the SRT so post-analysis beat remapping can access it
    const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
    fs.writeFileSync(srtCacheFile, srtContent);

    const result = mapSrtToSegments(srtContent, project.segments);

    // Save timing for each segment's HTML files
    let timedFiles = 0;
    for (const match of result.segmentMatches) {
      if (match.startTime === null) continue;

      // For each HTML variant in this segment, load its analysis and build timing
      for (const htmlFile of match.htmlFiles) {
        const analysisFile = path.join(config.DATA_DIR, `${htmlFile}.analysis.json`);
        let beatCount = 0;
        if (fs.existsSync(analysisFile)) {
          const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
          beatCount = analysis.beatCount || 0;
        }

        // Distribute beats evenly within the segment's time range
        let beatTimes;
        if (beatCount > 0) {
          const duration = match.endTime - match.startTime;
          beatTimes = [];
          for (let i = 0; i < beatCount; i++) {
            beatTimes.push(
              Math.round((match.startTime + (i / Math.max(1, beatCount - 1)) * duration) * 1000) / 1000
            );
          }
          // If only 1 beat, place at start
          if (beatCount === 1) {
            beatTimes = [Math.round(match.startTime * 1000) / 1000];
          }
        } else {
          // No analysis yet — single beat at start time
          beatTimes = [Math.round(match.startTime * 1000) / 1000];
        }

        const timing = {
          beatTimes,
          source: 'srt-project',
          method: 'script-match',
          segmentNum: match.num,
          confidence: match.confidence,
          startTime: match.startTime,
          endTime: match.endTime,
          savedAt: new Date().toISOString(),
        };

        const timingFile = path.join(config.DATA_DIR, `${htmlFile}.timing.json`);
        fs.writeFileSync(timingFile, JSON.stringify(timing, null, 2));
        timedFiles++;
      }
    }

    // Save SRT match results to project
    project.srtMatch = {
      srtFilename: req.file.originalname,
      matchedAt: new Date().toISOString(),
      matchedCount: result.matchedCount,
      totalSegments: result.totalSegments,
      cueCount: result.cueCount,
      segmentMatches: result.segmentMatches.map(m => ({
        num: m.num,
        matched: m.matched,
        confidence: m.confidence,
        startTime: m.startTime,
        endTime: m.endTime,
        htmlFiles: m.htmlFiles,
      })),
    };
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    res.json({
      success: true,
      matchedCount: result.matchedCount,
      totalSegments: result.totalSegments,
      timedFiles,
      srtFilename: req.file.originalname,
      segmentMatches: result.segmentMatches.map(m => ({
        num: m.num,
        matched: m.matched,
        confidence: m.confidence,
        startTime: m.startTime != null ? Math.round(m.startTime * 1000) / 1000 : null,
        endTime: m.endTime != null ? Math.round(m.endTime * 1000) / 1000 : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: `SRT matching failed: ${err.message}` });
  }
});

/**
 * POST /api/import/rematch-segment — update a segment's SRT start time and recalculate timing.
 * Body: { segmentNum: 5, newStartTime: 42.5 }
 * Shifts the segment match to start at the given SRT cue time, recalculates end time,
 * updates timing files for all variants, and re-runs beat remapping if analysis exists.
 */
router.post('/rematch-segment', (req, res) => {
  const { segmentNum, newStartTime } = req.body;
  if (segmentNum == null || newStartTime == null) {
    return res.status(400).json({ error: 'segmentNum and newStartTime are required' });
  }

  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.status(400).json({ error: 'No project imported.' });
  }

  try {
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
    if (!project.srtMatch) {
      return res.status(400).json({ error: 'No SRT match data. Upload SRT first.' });
    }

    const segMatch = project.srtMatch.segmentMatches.find(m => m.num === segmentNum);
    if (!segMatch) {
      return res.status(404).json({ error: `Segment ${segmentNum} not found in SRT match data` });
    }

    // Load all SRT cues
    const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
    if (!fs.existsSync(srtCacheFile)) {
      return res.status(400).json({ error: 'SRT cache not found' });
    }

    const { parseSrt } = require('../services/srt-parser');
    const srtContent = fs.readFileSync(srtCacheFile, 'utf-8');
    const allCues = parseSrt(srtContent);

    // Find the cue at or closest to newStartTime
    const startCue = allCues.reduce((best, c) =>
      Math.abs(c.startTime - newStartTime) < Math.abs(best.startTime - newStartTime) ? c : best
    , allCues[0]);

    // Determine new end time: use the next segment's start time, or the original duration
    const sortedMatches = [...project.srtMatch.segmentMatches].sort((a, b) => {
      if (a.startTime == null) return 1;
      if (b.startTime == null) return -1;
      return a.startTime - b.startTime;
    });
    const myIdx = sortedMatches.findIndex(m => m.num === segmentNum);
    let newEndTime;
    if (myIdx >= 0 && myIdx < sortedMatches.length - 1 && sortedMatches[myIdx + 1].startTime != null) {
      newEndTime = sortedMatches[myIdx + 1].startTime;
    } else {
      // Keep original duration
      const origDuration = (segMatch.endTime || 0) - (segMatch.startTime || 0);
      newEndTime = startCue.startTime + origDuration;
    }

    // Update the segment match
    const oldStart = segMatch.startTime;
    const oldEnd = segMatch.endTime;
    segMatch.startTime = startCue.startTime;
    segMatch.endTime = newEndTime;
    segMatch.matched = true;

    // Find segment's HTML files
    const segment = project.segments.find(s => s.num === segmentNum);
    const htmlFiles = segment ? segment.htmlFiles : segMatch.htmlFiles || [];

    // Update timing files for all variants
    for (const htmlFile of htmlFiles) {
      const timingFile = path.join(config.DATA_DIR, `${htmlFile}.timing.json`);
      const analysisFile = path.join(config.DATA_DIR, `${htmlFile}.analysis.json`);

      let beatCount = 1;
      let analysis = null;
      if (fs.existsSync(analysisFile)) {
        analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
        beatCount = analysis.beatCount || 1;
      }

      // Distribute beats evenly within the new time range
      const duration = newEndTime - startCue.startTime;
      let beatTimes;
      if (beatCount > 1) {
        beatTimes = [];
        for (let i = 0; i < beatCount; i++) {
          beatTimes.push(
            Math.round((startCue.startTime + (i / (beatCount - 1)) * duration) * 1000) / 1000
          );
        }
      } else {
        beatTimes = [Math.round(startCue.startTime * 1000) / 1000];
      }

      const timing = {
        beatTimes,
        source: 'srt-project',
        method: 'script-match',
        segmentNum,
        startTime: startCue.startTime,
        endTime: newEndTime,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(timingFile, JSON.stringify(timing, null, 2));

      // Re-run beat remapping if analysis exists
      if (analysis) {
        remapBeatsToSegmentCues(htmlFile, analysis);
      }
    }

    // Save updated project
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    res.json({
      success: true,
      segmentNum,
      oldStartTime: oldStart,
      oldEndTime: oldEnd,
      newStartTime: startCue.startTime,
      newEndTime,
      updatedFiles: htmlFiles.length,
    });
  } catch (err) {
    res.status(500).json({ error: `Rematch failed: ${err.message}` });
  }
});

/**
 * POST /api/import/analyze-all — analyze all segments sequentially.
 * Analyzes Option1 per segment, then clones analysis to Option2/Option3.
 * Broadcasts progress via WebSocket.
 * Body: { force: false } — set force:true to re-analyze even if cached.
 */
let analyzeAllRunning = false;

router.post('/analyze-all', (req, res) => {
  if (analyzeAllRunning) {
    return res.status(409).json({ error: 'Analysis already in progress' });
  }

  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) {
    return res.status(400).json({ error: 'No project imported.' });
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
  const force = req.body?.force === true;
  const broadcast = req.app.get('broadcast');

  const totalSegments = project.segments.length;

  // Respond immediately
  res.json({ started: true, totalSegments });

  // Run analysis in background
  analyzeAllRunning = true;
  runAnalyzeAll(project, force, broadcast).finally(() => {
    analyzeAllRunning = false;
  });
});

async function runAnalyzeAll(project, force, broadcast) {
  const segments = project.segments;
  let completed = 0;
  const errors = [];

  for (const seg of segments) {
    const segNum = seg.num;
    // Find the Option1 file
    const option1 = seg.htmlFiles.find(f => /Option1/i.test(f));
    if (!option1) {
      completed++;
      broadcast({
        type: 'analyze-progress',
        segmentNum: segNum,
        fileName: null,
        status: 'skipped',
        reason: 'no Option1 file',
        completed,
        total: segments.length,
      });
      continue;
    }

    // Check if already analyzed
    const dataFile = path.join(config.DATA_DIR, `${option1}.analysis.json`);
    if (!force && fs.existsSync(dataFile)) {
      completed++;
      broadcast({
        type: 'analyze-progress',
        segmentNum: segNum,
        fileName: option1,
        status: 'cached',
        completed,
        total: segments.length,
      });
      continue;
    }

    // Analyze Option1
    broadcast({
      type: 'analyze-progress',
      segmentNum: segNum,
      fileName: option1,
      status: 'analyzing',
      completed,
      total: segments.length,
    });

    try {
      const filePath = path.join(config.INPUT_DIR, option1);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${option1}`);
      }

      const analysis = await analyzeHtml(filePath);

      // Save analysis for Option1
      fs.writeFileSync(dataFile, JSON.stringify(analysis, null, 2));

      // Remap beats to SRT cues for Option1
      remapBeatsToSegmentCues(option1, analysis);

      // Clone analysis to other variants (Option2, Option3, etc.)
      const otherVariants = seg.htmlFiles.filter(f => f !== option1);
      for (const variant of otherVariants) {
        const variantDataFile = path.join(config.DATA_DIR, `${variant}.analysis.json`);
        fs.writeFileSync(variantDataFile, JSON.stringify(analysis, null, 2));
        // Remap beats for each variant too (they have their own timing files)
        remapBeatsToSegmentCues(variant, analysis);
      }

      completed++;
      broadcast({
        type: 'analyze-progress',
        segmentNum: segNum,
        fileName: option1,
        status: 'done',
        completed,
        total: segments.length,
        beatCount: analysis.beatCount,
        clonedTo: otherVariants.length,
      });
    } catch (err) {
      completed++;
      errors.push({ segmentNum: segNum, fileName: option1, error: err.message });
      broadcast({
        type: 'analyze-progress',
        segmentNum: segNum,
        fileName: option1,
        status: 'error',
        error: err.message,
        completed,
        total: segments.length,
      });
    }
  }

  broadcast({
    type: 'analyze-complete',
    completed,
    total: segments.length,
    errors,
  });
}

module.exports = router;
