const SrtParser = require('srt-parser-2');

/**
 * Parse SRT content and extract cues.
 * Supports both HH:MM:SS,mmm and HH:MM:SS.mmm formats.
 */
function parseSrt(srtContent) {
  const normalized = srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  const parser = new SrtParser.default();
  const cues = parser.fromSrt(normalized);

  return cues.map(cue => ({
    index: cue.id,
    startTime: timeToSeconds(cue.startTime),
    endTime: timeToSeconds(cue.endTime),
    text: cue.text.replace(/<[^>]*>/g, '').trim(), // strip HTML tags some SRTs have
  }));
}

/**
 * Dumb 1:1 mapping — each cue's start time = a beat time, in order.
 */
function mapSrtToBeats(srtContent, beatCount) {
  const cues = parseSrt(srtContent);
  const beatTimes = cues.map(c => c.startTime);

  return {
    beatTimes,
    cueCount: cues.length,
    beatCount,
    matched: cues.length === beatCount,
    cues,
    mapping: null,
  };
}

/**
 * Smart mapping — fuzzy-match each beat's text to the best SRT cue,
 * constrained to chronological order (forward-only scan).
 *
 * Beats happen in click-order (1→2→3...) and the voiceover follows
 * the same order, so each beat's matched cue must come AFTER the
 * previous beat's matched cue. This ensures monotonically increasing
 * beat times.
 *
 * @param {string} srtContent - Raw SRT file text
 * @param {string[]} beatTexts - Text extracted from each beat in the HTML
 * @param {object} [opts] - Optional settings
 * @param {string[]} [opts.beatTypes] - Beat type classification per beat ('speech'|'label'|'data'|'silent')
 * @param {number} [opts.segStart] - Segment start time in seconds (for interpolation bounds)
 * @param {number} [opts.segEnd] - Segment end time in seconds (for interpolation bounds)
 * @returns {object} Mapping result with beatTimes, per-beat match info, etc.
 */
function mapSrtToBeatsIntelligent(srtContent, beatTexts, opts = {}) {
  const cues = parseSrt(srtContent);
  const { beatTypes, segStart, segEnd } = opts;

  if (!beatTexts || beatTexts.length === 0) {
    // Fall back to dumb mapping
    return {
      beatTimes: cues.map(c => c.startTime),
      cueCount: cues.length,
      beatCount: 0,
      matched: false,
      cues,
      mapping: null,
      method: 'fallback',
    };
  }

  const cueTexts = cues.map(c => normalize(c.text));

  // ── Helper: word-level containment check for label beats ──
  function labelWordMatch(beatText, targetText) {
    const beatCW = contentWordsOf(beatText);
    const targetWords = new Set(targetText.split(/\s+/));
    const matched = beatCW.filter(w =>
      targetWords.has(w) || [...targetWords].some(cw =>
        (w.length >= 4 && cw.length >= 4) && (cw.includes(w) || w.includes(cw))
      )
    );
    return matched.length > 0
      ? { has: true, score: 0.20 + matched.length * 0.05 }
      : { has: false, score: 0 };
  }

  // ── Scoring helper: score a beat against a single cue (+ consecutive combos) ──
  function scoreCue(beatText, isLabel, cueIdx) {
    let score = similarity(beatText, cueTexts[cueIdx]);
    let hasContainment = false;

    // Phrase-level containment: full beat text appears in cue
    if (cueTexts[cueIdx].includes(beatText) && beatText.length >= 3) {
      score = Math.max(score, 0.25);
      hasContainment = true;
    }
    // Word-level containment for labels: any content word appears in cue
    if (isLabel && !hasContainment) {
      const wm = labelWordMatch(beatText, cueTexts[cueIdx]);
      if (wm.has) { hasContainment = true; score = Math.max(score, wm.score); }
    }

    // Combined 2 consecutive cues
    if (cueIdx + 1 < cues.length) {
      const combined2 = cueTexts[cueIdx] + ' ' + cueTexts[cueIdx + 1];
      let cs = similarity(beatText, combined2);
      if (combined2.includes(beatText) && beatText.length >= 3) {
        cs = Math.max(cs, 0.25);
        hasContainment = true;
      }
      if (isLabel && !hasContainment) {
        const wm = labelWordMatch(beatText, combined2);
        if (wm.has) { hasContainment = true; cs = Math.max(cs, wm.score); }
      }
      score = Math.max(score, cs);
    }

    // Combined 3 consecutive cues
    if (cueIdx + 2 < cues.length) {
      const combined3 = cueTexts[cueIdx] + ' ' + cueTexts[cueIdx + 1] + ' ' + cueTexts[cueIdx + 2];
      let cs = similarity(beatText, combined3);
      if (combined3.includes(beatText) && beatText.length >= 3) {
        cs = Math.max(cs, 0.25);
        hasContainment = true;
      }
      if (isLabel && !hasContainment) {
        const wm = labelWordMatch(beatText, combined3);
        if (wm.has) { hasContainment = true; cs = Math.max(cs, wm.score); }
      }
      score = Math.max(score, cs);
    }

    return { score, hasContainment };
  }

  // ══════════════════════════════════════════════════════════════════
  // Pass 1: Anchor pass — confident matches only, forward-only
  // ══════════════════════════════════════════════════════════════════
  const ANCHOR_THRESHOLD = 0.35;
  const FILL_THRESHOLD = 0.20;
  let searchStart = 0;
  const mapping = new Array(beatTexts.length).fill(null);

  for (let beatIdx = 0; beatIdx < beatTexts.length; beatIdx++) {
    const beatType = beatTypes ? beatTypes[beatIdx] : null;

    // Skip silent and data beats — they have no speech equivalent
    if (beatType === 'silent' || beatType === 'data') {
      mapping[beatIdx] = { beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null, skipped: beatType };
      continue;
    }

    const beatText = normalize(beatTexts[beatIdx]);
    if (!beatText) {
      mapping[beatIdx] = { beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null };
      continue;
    }

    const isLabel = beatType === 'label';
    let bestIdx = -1;
    let bestScore = 0;
    let bestHasContainment = false;

    for (let cueIdx = searchStart; cueIdx < cues.length; cueIdx++) {
      const { score, hasContainment } = scoreCue(beatText, isLabel, cueIdx);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = cueIdx;
        bestHasContainment = hasContainment;
      }
    }

    // Labels require containment to match
    if (isLabel && !bestHasContainment) {
      bestScore = 0;
    }

    if (bestScore >= ANCHOR_THRESHOLD && bestIdx >= 0) {
      searchStart = bestIdx + 1;
      const trigger = findTriggerWordTime(beatTexts[beatIdx], cues[bestIdx], beatType);
      mapping[beatIdx] = {
        beatIdx,
        cueIdx: bestIdx,
        cueId: cues[bestIdx].index,
        score: Math.round(bestScore * 100),
        beatText: beatTexts[beatIdx],
        cueText: cues[bestIdx].text,
        time: trigger.time,
        triggerWord: trigger.triggerWord,
        triggerMethod: trigger.method,
        anchor: true,
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Pass 2: Fill pass — unmatched beats search within bounded ranges
  // ══════════════════════════════════════════════════════════════════
  for (let beatIdx = 0; beatIdx < beatTexts.length; beatIdx++) {
    if (mapping[beatIdx]) continue; // already anchored or skipped

    const beatType = beatTypes ? beatTypes[beatIdx] : null;
    const beatText = normalize(beatTexts[beatIdx]);
    if (!beatText) {
      mapping[beatIdx] = { beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null };
      continue;
    }

    const isLabel = beatType === 'label';

    // Find bounding anchors (nearest anchored beats before and after)
    let prevAnchorCue = -1;
    for (let j = beatIdx - 1; j >= 0; j--) {
      if (mapping[j] && mapping[j].cueIdx !== null && mapping[j].anchor) {
        prevAnchorCue = mapping[j].cueIdx;
        break;
      }
    }
    let nextAnchorCue = cues.length;
    for (let j = beatIdx + 1; j < beatTexts.length; j++) {
      if (mapping[j] && mapping[j].cueIdx !== null && mapping[j].anchor) {
        nextAnchorCue = mapping[j].cueIdx;
        break;
      }
    }

    // Search range: between anchors (exclusive of anchor cue positions)
    const rangeStart = prevAnchorCue + 1;
    const rangeEnd = nextAnchorCue - 1;

    if (rangeStart > rangeEnd) {
      mapping[beatIdx] = { beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null };
      continue;
    }

    let bestIdx = -1;
    let bestScore = 0;
    let bestHasContainment = false;

    for (let cueIdx = rangeStart; cueIdx <= rangeEnd; cueIdx++) {
      const { score, hasContainment } = scoreCue(beatText, isLabel, cueIdx);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = cueIdx;
        bestHasContainment = hasContainment;
      }
    }

    // Labels require containment to match
    if (isLabel && !bestHasContainment) {
      bestScore = 0;
    }

    if (bestScore >= FILL_THRESHOLD && bestIdx >= 0) {
      const trigger = findTriggerWordTime(beatTexts[beatIdx], cues[bestIdx], beatType);
      mapping[beatIdx] = {
        beatIdx,
        cueIdx: bestIdx,
        cueId: cues[bestIdx].index,
        score: Math.round(bestScore * 100),
        beatText: beatTexts[beatIdx],
        cueText: cues[bestIdx].text,
        time: trigger.time,
        triggerWord: trigger.triggerWord,
        triggerMethod: trigger.method,
        anchor: false,
      };
    } else {
      mapping[beatIdx] = { beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null };
    }
  }

  // Build beatTimes from mapping — unmatched beats get interpolated
  const beatTimes = interpolateMissing(mapping, cues, segStart, segEnd, beatTypes);

  const matchedCount = mapping.filter(m => m.cueIdx !== null).length;

  return {
    beatTimes,
    cueCount: cues.length,
    beatCount: beatTexts.length,
    matched: matchedCount === beatTexts.length,
    matchedCount,
    cues,
    mapping,
    method: 'text-match',
  };
}

/**
 * Normalize text for comparison: lowercase, strip punctuation, collapse whitespace.
 */
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word-overlap similarity between two strings (Jaccard-like on word n-grams).
 * Returns 0-1 where 1 = perfect match.
 */
function similarity(a, b) {
  if (!a || !b) return 0;

  const wordsA = a.split(' ').filter(Boolean);
  const wordsB = b.split(' ').filter(Boolean);

  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  // Word overlap
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap++;
  }
  const jaccard = overlap / Math.max(setA.size, setB.size);

  // Also check if one is a substring of the other (handles short text well)
  const substringBonus = (a.includes(b) || b.includes(a)) ? 0.3 : 0;

  // Bigram overlap for partial word matching
  const bigramsA = toBigrams(a);
  const bigramsB = toBigrams(b);
  let bigramOverlap = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) bigramOverlap++;
  }
  const bigramScore = bigramsA.size > 0
    ? bigramOverlap / Math.max(bigramsA.size, bigramsB.size)
    : 0;

  return Math.min(1, Math.max(jaccard, bigramScore) + substringBonus);
}

function toBigrams(str) {
  const bigrams = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Fill in beatTimes for unmatched beats by interpolating proportionally
 * within the segment's time range (or between matched anchors).
 * Enforces minimum intervals to prevent rapid-fire clicking.
 *
 * @param {object[]} mapping - Per-beat match results
 * @param {object[]} cues - Parsed SRT cues
 * @param {number} [segStart] - Segment start time (seconds), used as floor
 * @param {number} [segEnd] - Segment end time (seconds), used as ceiling
 * @param {string[]} [beatTypes] - Per-beat type classification for interval enforcement
 */
function interpolateMissing(mapping, cues, segStart, segEnd, beatTypes) {
  const times = new Array(mapping.length).fill(null);

  // Derive fallback bounds from cues if segment bounds not provided
  const floorTime = segStart != null ? segStart : (cues.length > 0 ? cues[0].startTime : 0);
  const ceilTime = segEnd != null ? segEnd : (cues.length > 0 ? cues[cues.length - 1].endTime : mapping.length * 2);

  // Fill matched times, clamping to segment bounds to prevent anchors outside the range
  for (const m of mapping) {
    if (m.cueIdx !== null) {
      times[m.beatIdx] = Math.max(floorTime, Math.min(ceilTime, m.time));
    }
  }

  // Check if we have any anchors at all
  const hasAnchors = times.some(t => t !== null);

  if (!hasAnchors) {
    // Zero matches — distribute all beats evenly across the segment range
    const total = times.length;
    for (let i = 0; i < total; i++) {
      if (total === 1) {
        times[i] = (floorTime + ceilTime) / 2;
      } else {
        times[i] = floorTime + (i / (total - 1)) * (ceilTime - floorTime);
      }
    }
    return times.map(t => Math.round(t * 1000) / 1000);
  }

  // Interpolate gaps between, before, and after anchors
  for (let i = 0; i < times.length; i++) {
    if (times[i] !== null) continue;

    // Find previous and next known times
    let prevIdx = -1, nextIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (times[j] !== null) { prevIdx = j; break; }
    }
    for (let j = i + 1; j < times.length; j++) {
      if (times[j] !== null) { nextIdx = j; break; }
    }

    if (prevIdx >= 0 && nextIdx >= 0) {
      // Between two anchors — linear interpolation
      const span = nextIdx - prevIdx;
      const frac = (i - prevIdx) / span;
      times[i] = times[prevIdx] + frac * (times[nextIdx] - times[prevIdx]);
    } else if (prevIdx >= 0) {
      // After last anchor — space forward toward segment end
      const unmatchedAfter = times.length - 1 - prevIdx;
      const availableTime = ceilTime - times[prevIdx];
      // Use at least 0.5s step so beats don't pile up when anchor is at/near ceiling
      const step = unmatchedAfter > 0 ? Math.max(0.5, availableTime / unmatchedAfter) : 0.5;
      times[i] = times[prevIdx] + (i - prevIdx) * step;
    } else if (nextIdx >= 0) {
      // Before first anchor — space backward from first anchor using segment start as floor
      const unmatchedBefore = nextIdx;
      const availableTime = times[nextIdx] - floorTime;
      const step = unmatchedBefore > 0 ? availableTime / unmatchedBefore : 0;
      times[i] = Math.max(floorTime, times[nextIdx] - (nextIdx - i) * step);
    }
  }

  // Enforce monotonicity — each beat time must be >= the previous one
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      times[i] = times[i - 1] + 0.1; // nudge forward by 100ms
    }
  }

  // Enforce minimum intervals to prevent rapid-fire clicking
  if (beatTypes) {
    for (let i = 1; i < times.length; i++) {
      const prevType = beatTypes[i - 1] || 'speech';
      const currType = beatTypes[i] || 'speech';

      // Label-to-label allows tighter stacking (0.4s) for visual layering
      // Everything else gets a 1.2s minimum to match natural speech pacing
      const minInterval = (prevType === 'label' && currType === 'label') ? 0.4 : 1.2;

      const gap = times[i] - times[i - 1];
      if (gap < minInterval) {
        times[i] = times[i - 1] + minInterval;
      }
    }
  }

  // Clamp to segment end so beats don't overflow
  const maxTime = segEnd != null ? segEnd : ceilTime;
  for (let i = 0; i < times.length; i++) {
    if (times[i] > maxTime) {
      times[i] = maxTime;
    }
  }

  return times.map(t => Math.round(t * 1000) / 1000);
}

/**
 * Convert "HH:MM:SS.mmm" or "HH:MM:SS,mmm" string to seconds.
 */
function timeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const clean = timeStr.replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return parseFloat(clean) || 0;
}

/**
 * Map SRT cues to project segments using their .txt voiceover scripts.
 *
 * Two-pass approach:
 *   Pass 1: Find best SRT window for each segment independently (asymmetric scoring).
 *   Pass 2: Enforce monotonicity — resolve overlaps by keeping highest-confidence matches.
 *
 * Asymmetric scoring: "what % of the SRT window's words appear in the script?"
 * This handles scripts that mix voiceover with stage directions — the extra
 * direction words don't penalize the score, only missing SRT words do.
 *
 * @param {string} srtContent - Raw SRT file text
 * @param {object[]} segments - Array of { num, script, htmlFiles }
 * @returns {object} { segmentMatches, matchedCount, totalSegments, cueCount, cues }
 */
function mapSrtToSegments(srtContent, segments) {
  const cues = parseSrt(srtContent);
  const cueTextsNorm = cues.map(c => normalize(c.text));

  // Build word sets for each cue (reusable)
  const cueWordSets = cueTextsNorm.map(t => new Set(t.split(' ').filter(Boolean)));

  // Common stop words to ignore (they match everything)
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'it', 'in', 'on', 'to', 'of', 'and', 'or', 'but',
    'that', 'this', 'with', 'for', 'not', 'are', 'was', 'be', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may',
    'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our',
    'their', 'its', 'if', 'so', 'at', 'by', 'from', 'up', 'out', 'no', 'yes',
    'just', 'all', 'more', 'some', 'than', 'then', 'when', 'what', 'how',
    'about', 'into', 'over', 'after', 'before', 'between', 'through',
  ]);

  function contentWords(wordSet) {
    const result = new Set();
    for (const w of wordSet) {
      if (w.length > 2 && !stopWords.has(w)) result.add(w);
    }
    return result;
  }

  // ── Pass 1: Find best window for each segment independently ──

  const rawMatches = [];

  for (const seg of segments) {
    const scriptNorm = normalize(seg.script);
    if (!scriptNorm || scriptNorm.length < 10) {
      rawMatches.push({
        num: seg.num,
        matched: false,
        confidence: 0,
        startCueIdx: null,
        endCueIdx: null,
        htmlFiles: seg.htmlFiles,
      });
      continue;
    }

    const scriptWordsFull = new Set(scriptNorm.split(' ').filter(Boolean));
    const scriptWordsContent = contentWords(scriptWordsFull);

    let bestScore = 0;
    let bestStart = -1;
    let bestEnd = -1;

    // Use expanding window: for each start position, grow the window
    // and track the best score. Stop growing when adding cues no longer helps.
    for (let start = 0; start < cues.length; start++) {
      const windowWords = new Set();
      const windowContentWords = new Set();
      let peakScore = 0;
      let noImprovementCount = 0;

      for (let end = start; end < cues.length && end < start + 40; end++) {
        // Add this cue's words to the window
        for (const w of cueWordSets[end]) {
          windowWords.add(w);
          if (w.length > 2 && !stopWords.has(w)) windowContentWords.add(w);
        }

        if (windowContentWords.size === 0) continue;

        // Asymmetric: what % of the SRT window's content words are in the script?
        let srtCoveredByScript = 0;
        for (const w of windowContentWords) {
          if (scriptWordsFull.has(w)) srtCoveredByScript++;
        }
        const srtCoverage = srtCoveredByScript / windowContentWords.size;

        // Also check: what % of the script's content words are in the SRT window?
        let scriptCoveredBySrt = 0;
        for (const w of scriptWordsContent) {
          if (windowWords.has(w)) scriptCoveredBySrt++;
        }
        const scriptCoverage = scriptWordsContent.size > 0
          ? scriptCoveredBySrt / scriptWordsContent.size
          : 0;

        // Combined score: weight SRT coverage higher (it's the reliable signal)
        // srtCoverage = "are the SRT words in the script?" (robust to stage directions)
        // scriptCoverage = "are the script words in the SRT?" (rewards good matches)
        const score = srtCoverage * 0.6 + scriptCoverage * 0.4;

        if (score > peakScore) {
          peakScore = score;
          noImprovementCount = 0;
        } else {
          noImprovementCount++;
        }

        if (score > bestScore) {
          bestScore = score;
          bestStart = start;
          bestEnd = end;
        }

        // Stop expanding if we haven't improved in 10 cues
        if (noImprovementCount > 10) break;
      }
    }

    const matched = bestScore >= 0.25 && bestStart >= 0;
    rawMatches.push({
      num: seg.num,
      matched,
      confidence: Math.round(bestScore * 100),
      startCueIdx: matched ? bestStart : null,
      endCueIdx: matched ? bestEnd : null,
      htmlFiles: seg.htmlFiles,
    });
  }

  // ── Pass 2: Enforce monotonicity ──
  // Sort matched segments by confidence (descending) and greedily assign
  // non-overlapping cue ranges, respecting segment order.

  const matchedIdxs = rawMatches
    .map((m, i) => ({ idx: i, ...m }))
    .filter(m => m.matched)
    .sort((a, b) => b.confidence - a.confidence);

  // Track assigned cue ranges: for each segment position, its cue range
  const assigned = new Array(segments.length).fill(null);

  for (const m of matchedIdxs) {
    const range = { start: m.startCueIdx, end: m.endCueIdx };

    // Check: does this overlap with any already-assigned range?
    // Also enforce: earlier segments must have earlier (or equal) cue ranges
    let valid = true;
    for (let i = 0; i < segments.length; i++) {
      if (assigned[i] === null) continue;
      if (i < m.idx) {
        // Earlier segment must end before this one starts
        if (assigned[i].end >= range.start) { valid = false; break; }
      } else if (i > m.idx) {
        // Later segment must start after this one ends
        if (assigned[i].start <= range.end) { valid = false; break; }
      }
    }

    if (valid) {
      assigned[m.idx] = range;
    } else {
      rawMatches[m.idx].matched = false;
      rawMatches[m.idx].startCueIdx = null;
      rawMatches[m.idx].endCueIdx = null;
    }
  }

  // ── Build final results with timing ──

  const segmentMatches = rawMatches.map(m => ({
    num: m.num,
    matched: m.matched,
    confidence: m.confidence,
    startCueIdx: m.startCueIdx,
    endCueIdx: m.endCueIdx,
    startTime: m.startCueIdx != null ? cues[m.startCueIdx].startTime : null,
    endTime: m.endCueIdx != null ? cues[m.endCueIdx].endTime : null,
    htmlFiles: m.htmlFiles,
  }));

  // Interpolate timing for unmatched segments between matched neighbors
  interpolateSegmentTiming(segmentMatches);

  const matchedCount = segmentMatches.filter(s => s.matched).length;

  return {
    segmentMatches,
    matchedCount,
    totalSegments: segments.length,
    cueCount: cues.length,
    cues,
  };
}

/**
 * Fill timing for unmatched segments by interpolating between matched neighbors.
 */
function interpolateSegmentTiming(matches) {
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].startTime !== null) continue;

    // Find previous and next matched segments
    let prevIdx = -1, nextIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (matches[j].startTime !== null) { prevIdx = j; break; }
    }
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[j].startTime !== null) { nextIdx = j; break; }
    }

    if (prevIdx >= 0 && nextIdx >= 0) {
      const span = nextIdx - prevIdx;
      const frac = (i - prevIdx) / span;
      const prevEnd = matches[prevIdx].endTime;
      const nextStart = matches[nextIdx].startTime;
      matches[i].startTime = prevEnd + frac * (nextStart - prevEnd);
      matches[i].endTime = prevEnd + ((i - prevIdx + 1) / span) * (nextStart - prevEnd);
    } else if (prevIdx >= 0) {
      const gap = 3; // 3s per unmatched segment
      matches[i].startTime = matches[prevIdx].endTime + (i - prevIdx) * gap;
      matches[i].endTime = matches[i].startTime + gap;
    } else if (nextIdx >= 0) {
      const gap = 3;
      matches[i].startTime = Math.max(0, matches[nextIdx].startTime - (nextIdx - i) * gap);
      matches[i].endTime = matches[i].startTime + gap;
    } else {
      matches[i].startTime = i * 3;
      matches[i].endTime = (i + 1) * 3;
    }
  }
}

// ── Stop words for trigger-word extraction ──
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'to', 'of', 'and', 'or', 'but',
  'that', 'this', 'with', 'for', 'not', 'are', 'was', 'be', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our',
  'their', 'its', 'if', 'so', 'at', 'by', 'from', 'up', 'out', 'no', 'yes',
  'just', 'all', 'more', 'some', 'than', 'then', 'when', 'what', 'how',
  'about', 'into', 'over', 'after', 'before', 'between', 'through',
  'very', 'most', 'much', 'many', 'also', 'even', 'still', 'already',
  'here', 'there', 'where', 'why', 'who', 'which', 'each', 'every',
  'any', 'both', 'few', 'own', 'other', 'such', 'only', 'same',
  'now', 'get', 'got', 'like', 'make', 'made', 'take', 'took',
  'come', 'came', 'go', 'went', 'see', 'saw', 'know', 'knew',
  'think', 'say', 'said', 'tell', 'told', 'use', 'used',
]);

/**
 * Extract content words from normalized text (length > 2, not stop words).
 */
function contentWordsOf(text) {
  return normalize(text).split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Estimate per-word timestamps within a single SRT cue by distributing
 * words proportionally across the cue duration based on character position.
 *
 * @param {{ startTime: number, endTime: number, text: string }} cue
 * @returns {{ word: string, normalizedWord: string, time: number }[]}
 */
function estimateWordTimings(cue) {
  const words = cue.text.replace(/<[^>]*>/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const duration = cue.endTime - cue.startTime;
  if (duration <= 0 || words.length === 1) {
    return words.map(w => ({
      word: w,
      normalizedWord: normalize(w),
      time: cue.startTime,
    }));
  }

  // Total character length (sum of all word lengths)
  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  let charPos = 0;

  return words.map(w => {
    // Place each word's time proportional to its character start position
    const frac = charPos / totalChars;
    const time = cue.startTime + frac * duration;
    charPos += w.length;
    return {
      word: w,
      normalizedWord: normalize(w),
      time: Math.round(time * 1000) / 1000,
    };
  });
}

/**
 * Dice coefficient on character bigrams for fuzzy single-word matching.
 * Returns 0-1 where 1 = identical.
 */
function bigramSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigramsA = [];
  const bigramsB = [];
  for (let i = 0; i < a.length - 1; i++) bigramsA.push(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.push(b.slice(i, i + 2));

  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const setB = new Set(bigramsB);
  let intersection = 0;
  for (const bg of bigramsA) {
    if (setB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

/**
 * Find the estimated time for a beat's trigger word within a matched SRT cue.
 *
 * - Speech beats → cue start time (they align with whole cues)
 * - Label beats → find the last matching content word, return its estimated time
 * - Data/silent → cue start time (fallback)
 *
 * Matching: exact → stem containment (4+ chars) → bigram similarity (>0.6) → fallback
 *
 * @param {string} beatText - Raw text extracted from the beat
 * @param {{ startTime: number, endTime: number, text: string }} cue - Matched SRT cue
 * @param {string|null} beatType - 'speech'|'label'|'data'|'silent'|null
 * @returns {{ time: number, triggerWord: string|null, method: string }}
 */
function findTriggerWordTime(beatText, cue, beatType) {
  const fallback = { time: cue.startTime, triggerWord: null, method: 'cue-start' };

  // Speech, data, silent beats → just use cue start
  if (beatType === 'speech' || beatType === 'data' || beatType === 'silent') {
    return fallback;
  }

  // Label beats → find the trigger word
  const beatWords = normalize(beatText).split(/\s+/).filter(Boolean);
  // Extract content words (filter stop words)
  const contentWords = beatWords.filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (contentWords.length === 0) {
    return fallback;
  }

  const wordTimings = estimateWordTimings(cue);
  if (wordTimings.length === 0) {
    return fallback;
  }

  // Find the LAST matching content word in the cue (key concept comes last)
  let bestMatch = null;

  for (const contentWord of contentWords) {
    // Search backwards through cue words to find last match
    for (let i = wordTimings.length - 1; i >= 0; i--) {
      const cueWord = wordTimings[i].normalizedWord;

      // 1. Exact match
      if (cueWord === contentWord) {
        if (!bestMatch || wordTimings[i].time > bestMatch.time) {
          bestMatch = { time: wordTimings[i].time, triggerWord: wordTimings[i].word, method: 'exact' };
        }
        break; // Found exact for this content word, try next content word
      }

      // 2. Stem containment (4+ chars): does one contain the other?
      if (contentWord.length >= 4 && (cueWord.includes(contentWord) || contentWord.includes(cueWord)) && cueWord.length >= 4) {
        if (!bestMatch || wordTimings[i].time > bestMatch.time) {
          bestMatch = { time: wordTimings[i].time, triggerWord: wordTimings[i].word, method: 'stem' };
        }
        break;
      }

      // 3. Bigram similarity (>0.6)
      if (contentWord.length >= 4 && cueWord.length >= 4) {
        const sim = bigramSimilarity(contentWord, cueWord);
        if (sim > 0.6) {
          if (!bestMatch || wordTimings[i].time > bestMatch.time) {
            bestMatch = { time: wordTimings[i].time, triggerWord: wordTimings[i].word, method: 'bigram' };
          }
          break;
        }
      }
    }
  }

  return bestMatch || fallback;
}

module.exports = { parseSrt, mapSrtToBeats, mapSrtToBeatsIntelligent, mapSrtToSegments, timeToSeconds, estimateWordTimings, findTriggerWordTime };
