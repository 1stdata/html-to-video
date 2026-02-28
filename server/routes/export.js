const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Parse timeline offset from rendered filename
// Pattern: {seq}_{baseName}_@{mm}m{ss}s{ms}.mp4 or {seq}_{baseName}_@{mm}m{ss}s{ms}_{variant}.mp4
function parseOutputFilename(filename) {
  const match = filename.match(
    /^(\d{3})_(.+?)_@(\d{2})m(\d{2})s(\d{3})(?:_([^.]+))?\.mp4$/
  );
  if (!match) return null;

  const [, seq, baseName, mm, ss, ms, variant] = match;
  const offsetSec = parseInt(mm) * 60 + parseInt(ss) + parseInt(ms) / 1000;

  return {
    seq: parseInt(seq),
    baseName,
    variant: variant || null,
    offsetSec,
    htmlName: baseName + '.html',
  };
}

// GET /api/export/premiere-xml — generate FCP XML timeline
router.get('/premiere-xml', (req, res) => {
  // 1. Read all MP4 files from output dir
  let files;
  try {
    files = fs.readdirSync(config.OUTPUT_DIR).filter(f => f.endsWith('.mp4'));
  } catch (err) {
    return res.status(500).json({ error: 'Cannot read output directory' });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'No rendered clips found in output/' });
  }

  // 2. Parse each filename and load timing data
  const clips = [];
  for (const file of files) {
    const parsed = parseOutputFilename(file);
    if (!parsed) continue;

    // Load timing JSON for this HTML file
    const timingFile = path.join(config.DATA_DIR, `${parsed.htmlName}.timing.json`);
    let beatTimes = [];
    if (fs.existsSync(timingFile)) {
      const timing = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
      beatTimes = timing.beatTimes || [];
    }

    // Clip duration: last beat - first beat + transition hold
    let durationSec = 0;
    if (beatTimes.length >= 2) {
      durationSec = beatTimes[beatTimes.length - 1] - beatTimes[0]
        + config.DEFAULT_TRANSITION_DURATION / 1000;
    } else if (beatTimes.length === 1) {
      durationSec = config.DEFAULT_TRANSITION_DURATION / 1000;
    }

    clips.push({
      filename: file,
      seq: parsed.seq,
      offsetSec: parsed.offsetSec,
      durationSec,
      filePath: path.resolve(config.OUTPUT_DIR, file),
    });
  }

  if (clips.length === 0) {
    return res.status(404).json({ error: 'No clips matched the expected filename pattern' });
  }

  // 3. Sort by timeline offset
  clips.sort((a, b) => a.offsetSec - b.offsetSec);

  // 4. Build FCP XML
  const fps = config.FPS;
  const width = config.WIDTH;
  const height = config.HEIGHT;

  // Build file definitions and clipitems
  const fileDefs = [];
  const clipItems = [];

  clips.forEach((clip, i) => {
    const fileId = `file-${i + 1}`;
    const startFrame = Math.round(clip.offsetSec * fps);
    const durationFrames = Math.round(clip.durationSec * fps);
    const endFrame = startFrame + durationFrames;
    const fileUrl = `file://localhost${clip.filePath}`;

    fileDefs.push(`
        <file id="${fileId}">
          <name>${escapeXml(clip.filename)}</name>
          <pathurl>${escapeXml(fileUrl)}</pathurl>
          <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
          <duration>${durationFrames}</duration>
          <media>
            <video>
              <samplecharacteristics>
                <width>${width}</width>
                <height>${height}</height>
              </samplecharacteristics>
            </video>
          </media>
        </file>`);

    clipItems.push(`
          <clipitem id="clip-${i + 1}">
            <name>${escapeXml(clip.filename)}</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>0</in>
            <out>${durationFrames}</out>
            <file id="${fileId}"/>
          </clipitem>`);
  });

  // Calculate total sequence duration
  const lastClip = clips[clips.length - 1];
  const totalFrames = Math.round((lastClip.offsetSec + lastClip.durationSec) * fps);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence>
    <name>Project Timeline</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${fps}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${width}</width>
            <height>${height}</height>
          </samplecharacteristics>
        </format>
        <track>${clipItems.join('')}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;

  res.set('Content-Type', 'application/xml');
  res.set('Content-Disposition', 'attachment; filename="timeline.xml"');
  res.send(xml);
});

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
