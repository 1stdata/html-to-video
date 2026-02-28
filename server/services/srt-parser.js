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

  // Forward-only matching: each beat's match must come after the previous one
  let searchStart = 0;
  const mapping = [];

  for (let beatIdx = 0; beatIdx < beatTexts.length; beatIdx++) {
    const beatType = beatTypes ? beatTypes[beatIdx] : null;

    // Skip silent and data beats — they have no speech equivalent
    if (beatType === 'silent' || beatType === 'data') {
      mapping.push({ beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null, skipped: beatType });
      continue;
    }

    const beatText = normalize(beatTexts[beatIdx]);
    if (!beatText) {
      mapping.push({ beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null });
      continue;
    }

    // Adaptive threshold based on beat type
    const threshold = beatType === 'label' ? 0.08 : 0.15;

    let bestIdx = -1;
    let bestScore = 0;

    // Only search cues AFTER the last matched cue
    for (let cueIdx = searchStart; cueIdx < cues.length; cueIdx++) {
      let score = similarity(beatText, cueTexts[cueIdx]);

      // Word-in-cue containment bonus: if the beat text (as a phrase)
      // appears literally inside the cue text, guarantee a minimum score
      if (cueTexts[cueIdx].includes(beatText) && beatText.length >= 3) {
        score = Math.max(score, 0.25);
      }

      // Try combining consecutive cues (beat text might span 2-3 captions)
      if (cueIdx + 1 < cues.length) {
        const combined2 = cueTexts[cueIdx] + ' ' + cueTexts[cueIdx + 1];
        let combinedScore = similarity(beatText, combined2);
        if (combined2.includes(beatText) && beatText.length >= 3) {
          combinedScore = Math.max(combinedScore, 0.25);
        }
        score = Math.max(score, combinedScore);
      }
      if (cueIdx + 2 < cues.length) {
        const combined3 = cueTexts[cueIdx] + ' ' + cueTexts[cueIdx + 1] + ' ' + cueTexts[cueIdx + 2];
        let combinedScore = similarity(beatText, combined3);
        if (combined3.includes(beatText) && beatText.length >= 3) {
          combinedScore = Math.max(combinedScore, 0.25);
        }
        score = Math.max(score, combinedScore);
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = cueIdx;
      }
    }

    if (bestScore >= threshold && bestIdx >= 0) {
      searchStart = bestIdx + 1; // Next beat must match after this one
      mapping.push({
        beatIdx,
        cueIdx: bestIdx,
        cueId: cues[bestIdx].index,
        score: Math.round(bestScore * 100),
        beatText: beatTexts[beatIdx],
        cueText: cues[bestIdx].text,
        time: cues[bestIdx].startTime,
      });
    } else {
      mapping.push({ beatIdx, cueIdx: null, score: 0, beatText: beatTexts[beatIdx], cueText: null });
    }
  }

  // Build beatTimes from mapping — unmatched beats get interpolated
  const beatTimes = interpolateMissing(mapping, cues, segStart, segEnd);

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
 *
 * @param {object[]} mapping - Per-beat match results
 * @param {object[]} cues - Parsed SRT cues
 * @param {number} [segStart] - Segment start time (seconds), used as floor
 * @param {number} [segEnd] - Segment end time (seconds), used as ceiling
 */
function interpolateMissing(mapping, cues, segStart, segEnd) {
  const times = new Array(mapping.length).fill(null);

  // Fill matched times
  for (const m of mapping) {
    if (m.cueIdx !== null) {
      times[m.beatIdx] = m.time;
    }
  }

  // Derive fallback bounds from cues if segment bounds not provided
  const floorTime = segStart != null ? segStart : (cues.length > 0 ? cues[0].startTime : 0);
  const ceilTime = segEnd != null ? segEnd : (cues.length > 0 ? cues[cues.length - 1].endTime : mapping.length * 2);

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
      const step = unmatchedAfter > 0 ? availableTime / unmatchedAfter : 0;
      times[i] = times[prevIdx] + (i - prevIdx) * step;
    } else if (nextIdx >= 0) {
      // Before first anchor — space backward from first anchor using segment start as floor
      const unmatchedBefore = nextIdx;
      const availableTime = times[nextIdx] - floorTime;
      const step = unmatchedBefore > 0 ? availableTime / unmatchedBefore : 0;
      times[i] = Math.max(floorTime, times[nextIdx] - (nextIdx - i) * step);
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

module.exports = { parseSrt, mapSrtToBeats, mapSrtToBeatsIntelligent, mapSrtToSegments, timeToSeconds };
