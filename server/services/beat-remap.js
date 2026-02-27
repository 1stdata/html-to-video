const path = require('path');
const fs = require('fs');
const config = require('../config');
const { mapSrtToBeatsIntelligent, parseSrt } = require('./srt-parser');

/**
 * After Puppeteer analysis, if this file belongs to a project segment with SRT timing,
 * re-map beats to actual SRT cues within the segment's narrow time range.
 * Uses mapSrtToBeatsIntelligent scoped to just the segment's cues (~10-20 cues)
 * instead of all 483 — much more accurate.
 */
function remapBeatsToSegmentCues(fileName, analysis) {
  const timingFile = path.join(config.DATA_DIR, `${fileName}.timing.json`);
  if (!fs.existsSync(timingFile)) return;

  const timing = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
  if (timing.source !== 'srt-project') return;
  if (!analysis.beatTexts || analysis.beatTexts.length === 0) return;

  // Load the project to find the SRT file and segment cue range
  const projectFile = path.join(config.DATA_DIR, 'project.json');
  if (!fs.existsSync(projectFile)) return;

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
  if (!project.srtMatch) return;

  // Find this file's segment match
  const segMatch = project.srtMatch.segmentMatches.find(
    m => m.htmlFiles && m.htmlFiles.includes(fileName)
  );
  if (!segMatch || segMatch.startTime == null) return;

  // Load the original SRT content from the project source
  const srtCacheFile = path.join(config.DATA_DIR, 'project-srt.cache');
  if (!fs.existsSync(srtCacheFile)) return;

  const srtContent = fs.readFileSync(srtCacheFile, 'utf-8');
  const allCues = parseSrt(srtContent);

  // Filter cues to just this segment's time range (with a small buffer)
  const buffer = 2; // 2s buffer on each side
  const segCues = allCues.filter(c =>
    c.startTime >= (segMatch.startTime - buffer) &&
    c.startTime <= (segMatch.endTime + buffer)
  );

  if (segCues.length === 0) return;

  // Build a mini-SRT from just these cues
  const miniSrt = segCues.map((c, i) => {
    const startTs = secondsToSrtTime(c.startTime);
    const endTs = secondsToSrtTime(c.endTime);
    return `${i + 1}\n${startTs} --> ${endTs}\n${c.text}\n`;
  }).join('\n');

  // Run intelligent matching with beat texts against this narrow SRT range
  const result = mapSrtToBeatsIntelligent(miniSrt, analysis.beatTexts);

  if (result.beatTimes && result.beatTimes.length > 0) {
    const updatedTiming = {
      ...timing,
      beatTimes: result.beatTimes,
      method: 'script-match-refined',
      mapping: result.mapping,
      cues: segCues,
      matchedCount: result.matchedCount,
      refinedAt: new Date().toISOString(),
    };
    fs.writeFileSync(timingFile, JSON.stringify(updatedTiming, null, 2));
  }
}

function secondsToSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

module.exports = { remapBeatsToSegmentCues, secondsToSrtTime };
