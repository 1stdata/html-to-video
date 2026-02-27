const puppeteer = require('puppeteer');
const config = require('../config');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CLICK_TARGET_CANDIDATES = ['#stage', '#presentation', '#app', '.slides', 'body'];

/**
 * Capture frames from an HTML animation.
 *
 * COMPACT MODE: only renders the animation segment.
 * - Shifts beat times so the first beat starts at time 0
 * - Total duration = (last beat - first beat) + transition + small pad
 * - Returns timelineOffset (where to place clip in Premiere)
 *
 * For static hold periods between beats, reuses the last captured frame
 * instead of re-screenshotting (huge speed boost).
 *
 * Uses JPEG for frame capture (3-5x faster than PNG).
 */
async function* captureFrames(filePath, beatTimes, transitionMs, onProgress, signal, clickTarget) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: config.WIDTH, height: config.HEIGHT });
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0', timeout: 15000 });

    // Hide hint text
    await page.addStyleTag({
      content: '.hint, [class*="hint"], [class*="instruction"] { display: none !important; }'
    });

    // Auto-detect click target
    if (!clickTarget) {
      clickTarget = await page.evaluate((candidates) => {
        for (const sel of candidates) {
          if (sel === 'body') continue;
          if (document.querySelector(sel)) return sel;
        }
        return 'body';
      }, CLICK_TARGET_CANDIDATES);
    }

    // Sort beat times chronologically (safety net — matcher should already be ordered)
    const sortedBeats = [...beatTimes].sort((a, b) => a - b);

    // Compact timing: shift so first beat = 0
    const timelineOffset = sortedBeats[0] || 0;
    const localBeats = sortedBeats.map(t => t - timelineOffset);

    const lastLocalBeat = localBeats[localBeats.length - 1] || 0;
    const totalDuration = lastLocalBeat + (transitionMs / 1000) + 0.5;
    const totalFrames = Math.ceil(totalDuration * config.FPS);
    const frameIntervalMs = 1000 / config.FPS;

    let frameIndex = 0;
    let nextBeatIdx = 0;
    let clickedAt = -Infinity;
    let lastFrame = null;

    for (let f = 0; f < totalFrames; f++) {
      if (signal && signal.aborted) {
        throw new Error('Render cancelled');
      }

      const currentTimeMs = f * frameIntervalMs;
      const currentTimeSec = currentTimeMs / 1000;

      // Click for the next beat
      let justClicked = false;
      if (nextBeatIdx < localBeats.length && currentTimeSec >= localBeats[nextBeatIdx]) {
        await page.click(clickTarget);
        clickedAt = currentTimeMs;
        nextBeatIdx++;
        justClicked = true;
        await delay(1);
      }

      const timeSinceClick = currentTimeMs - clickedAt;
      const inTransition = timeSinceClick >= 0 && timeSinceClick <= transitionMs;

      if (inTransition) {
        // During transition: wait real-time so CSS animates, capture fresh frame
        if (!justClicked && f > 0) {
          await delay(frameIntervalMs);
        }
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 95, encoding: 'binary' });
        lastFrame = screenshot;
        yield screenshot;
      } else if (lastFrame) {
        // Static hold: reuse last frame (no screenshot needed = fast)
        yield lastFrame;
      } else {
        // First frame before any click
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 95, encoding: 'binary' });
        lastFrame = screenshot;
        yield screenshot;
      }

      frameIndex++;

      if (onProgress) {
        onProgress({
          frame: frameIndex,
          totalFrames,
          percent: Math.round((frameIndex / totalFrames) * 100),
          timelineOffset,
        });
      }
    }
  } finally {
    await browser.close();
  }
}

module.exports = { captureFrames };
