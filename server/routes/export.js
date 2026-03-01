const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const config = require('../config');

const { parseSrt } = require('../services/srt-parser');

const MIN_CLIP_DURATION_SEC = 1.0;

// Parse timeline offset and option number from rendered filename
// Pattern: {seq}_{baseName}_@{mm}m{ss}s{ms}.mp4
function parseOutputFilename(filename) {
  const match = filename.match(
    /^(\d{3})_(.+?)_@(\d{2})m(\d{2})s(\d{3})(?:_([^.]+))?\.mp4$/
  );
  if (!match) return null;

  const [, seq, baseName, mm, ss, ms, variant] = match;
  const offsetSec = parseInt(mm) * 60 + parseInt(ss) + parseInt(ms) / 1000;

  // Extract option number from baseName (e.g. SEGMENT_0001_Option2 -> 2)
  const optMatch = baseName.match(/Option(\d+)/);
  const optionNum = optMatch ? parseInt(optMatch[1]) : 1;

  return {
    seq: parseInt(seq),
    baseName,
    variant: variant || null,
    offsetSec,
    optionNum,
    htmlName: baseName + '.html',
  };
}

function buildClipitem(clip, index, fps, width, height) {
  const fileId = `file-${index}`;
  const startFrame = Math.round(clip.offsetSec * fps);
  const durationFrames = Math.round(clip.durationSec * fps);
  const endFrame = startFrame + durationFrames;
  const fileUrl = `file://localhost${clip.filePath}`;

  return `
          <clipitem id="clip-${index}">
            <name>${escapeXml(clip.filename)}</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>0</in>
            <out>${durationFrames}</out>
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
            </file>
          </clipitem>`;
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
  const allClips = [];
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

    allClips.push({
      filename: file,
      seq: parsed.seq,
      offsetSec: parsed.offsetSec,
      durationSec,
      optionNum: parsed.optionNum,
      filePath: path.resolve(config.OUTPUT_DIR, file),
    });
  }

  if (allClips.length === 0) {
    return res.status(404).json({ error: 'No clips matched the expected filename pattern' });
  }

  // 3. Separate short clips from normal clips
  const normalClips = allClips.filter(c => c.durationSec >= MIN_CLIP_DURATION_SEC);
  const shortClips = allClips.filter(c => c.durationSec < MIN_CLIP_DURATION_SEC);

  // 4. Sort normal clips by timeline offset
  normalClips.sort((a, b) => a.offsetSec - b.offsetSec);
  shortClips.sort((a, b) => a.offsetSec - b.offsetSec);

  // 5. Group normal clips by option number into separate tracks
  const optionTracks = new Map();
  for (const clip of normalClips) {
    if (!optionTracks.has(clip.optionNum)) {
      optionTracks.set(clip.optionNum, []);
    }
    optionTracks.get(clip.optionNum).push(clip);
  }

  const fps = config.FPS;
  const width = config.WIDTH;
  const height = config.HEIGHT;

  // 6. Build tracks — one per option
  let clipIndex = 1;
  const sortedOptionNums = [...optionTracks.keys()].sort((a, b) => a - b);
  const trackXmls = [];

  for (const optNum of sortedOptionNums) {
    const clips = optionTracks.get(optNum);
    const items = clips.map(clip => buildClipitem(clip, clipIndex++, fps, width, height));
    trackXmls.push(`
        <track><!-- Option ${optNum} -->${items.join('')}
        </track>`);
  }

  // 7. Build "Unmatched" track for short clips placed after the timeline
  if (shortClips.length > 0) {
    // Place short clips after the last normal clip, spaced 1 second apart
    const lastNormal = normalClips[normalClips.length - 1];
    let cursorSec = lastNormal
      ? lastNormal.offsetSec + lastNormal.durationSec + 2
      : 0;

    const unmatchedItems = shortClips.map(clip => {
      const relocated = { ...clip, offsetSec: cursorSec };
      cursorSec += clip.durationSec + 1;
      return buildClipitem(relocated, clipIndex++, fps, width, height);
    });

    trackXmls.push(`
        <track><!-- Unmatched (short clips) -->${unmatchedItems.join('')}
        </track>`);
  }

  // 8. Build SRT captions track
  const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
  let srtTrackXml = '';
  if (fs.existsSync(srtCacheFile)) {
    const srtContent = fs.readFileSync(srtCacheFile, 'utf-8');
    const cues = parseSrt(srtContent);

    if (cues.length > 0) {
      const captionItems = cues.map((cue, i) => {
        const startFrame = Math.round(cue.startTime * fps);
        const endFrame = Math.round(cue.endTime * fps);
        const durationFrames = endFrame - startFrame;
        return `
          <generatoritem id="caption-${i + 1}">
            <name>${escapeXml(cue.text)}</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>0</in>
            <out>${durationFrames}</out>
            <effect>
              <name>Text</name>
              <effectid>Text</effectid>
              <effecttype>generator</effecttype>
              <mediatype>video</mediatype>
              <parameter>
                <parameterid>str</parameterid>
                <name>Text</name>
                <value>${escapeXml(cue.text)}</value>
              </parameter>
            </effect>
          </generatoritem>`;
      });

      srtTrackXml = `
        <track><!-- SRT Captions -->${captionItems.join('')}
        </track>`;
    }
  }

  // 9. Calculate total sequence duration
  const allEndFrames = [];
  for (const clip of normalClips) {
    allEndFrames.push(Math.round((clip.offsetSec + clip.durationSec) * fps));
  }
  if (shortClips.length > 0) {
    // Account for relocated short clips at the end
    const lastNormal = normalClips[normalClips.length - 1];
    let cursor = lastNormal ? lastNormal.offsetSec + lastNormal.durationSec + 2 : 0;
    for (const clip of shortClips) {
      allEndFrames.push(Math.round((cursor + clip.durationSec) * fps));
      cursor += clip.durationSec + 1;
    }
  }
  const totalFrames = Math.max(...allEndFrames);

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
    <timecode>
      <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${width}</width>
            <height>${height}</height>
          </samplecharacteristics>
        </format>${trackXmls.join('')}${srtTrackXml}
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
