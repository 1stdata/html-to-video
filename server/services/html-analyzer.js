const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CLICK_TARGET_CANDIDATES = ['#stage', '#presentation', '#app', '.slides', 'body'];

const THUMBS_DIR = path.join(config.DATA_DIR, 'thumbs');

/**
 * Analyze an HTML animation file to detect beats (clickable steps).
 *
 * Handles looping presentations by tracking which slide is active
 * and which step-items are revealed — stops when we loop back to
 * the initial state.
 *
 * Captures a thumbnail screenshot after each beat for the mapping UI.
 */
async function analyzeHtml(filePath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const baseName = path.basename(filePath);

  // Ensure thumbs dir exists
  if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

  // Clean old thumbs for this file
  const thumbPrefix = baseName + '_beat_';
  try {
    for (const f of fs.readdirSync(THUMBS_DIR)) {
      if (f.startsWith(thumbPrefix)) fs.unlinkSync(path.join(THUMBS_DIR, f));
    }
  } catch {}

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: config.WIDTH, height: config.HEIGHT });
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0', timeout: 15000 });

    // Hide hint/instruction text
    await page.addStyleTag({
      content: '.hint, [class*="hint"], [class*="instruction"] { display: none !important; }'
    });

    // Detect click target + DOM info
    const domInfo = await page.evaluate((slideSelector, stepSelector, candidates) => {
      const slides = document.querySelectorAll(slideSelector);
      const stepItems = document.querySelectorAll(stepSelector);

      const durations = new Set();
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const td = style.transitionDuration;
        if (td && td !== '0s') {
          const ms = parseFloat(td) * (td.includes('ms') ? 1 : 1000);
          if (ms > 0) durations.add(ms);
        }
      }

      let clickTarget = 'body';
      for (const sel of candidates) {
        if (sel === 'body') continue;
        if (document.querySelector(sel)) { clickTarget = sel; break; }
      }

      return {
        slideCount: slides.length,
        stepItemCount: stepItems.length,
        transitionDurations: [...durations],
        clickTarget,
      };
    }, config.SLIDE_SELECTOR, config.STEP_ITEM_SELECTOR, CLICK_TARGET_CANDIDATES);

    const maxTransMs = domInfo.transitionDurations.length > 0
      ? Math.max(...domInfo.transitionDurations)
      : config.DEFAULT_TRANSITION_DURATION;
    // Wait enough for slide transitions (at least 600ms) but cap it so analysis isn't painfully slow
    const waitAfterClick = Math.min(Math.max(600, maxTransMs + 100), 1200);
    const clickSelector = domInfo.clickTarget;

    // Capture initial state — only track active slide's revealed items
    const initialState = await getActiveState(page);

    // Click-counting pass
    let clickCount = 0;
    const maxClicks = 100;
    const beatTexts = [];
    const beatThumbs = []; // thumbnail filenames
    let noChangeStreak = 0;
    let passedFirstBeat = false;

    for (let i = 0; i < maxClicks; i++) {
      // Which items are revealed before this click?
      const revealedBefore = await getRevealedTexts(page);

      await page.click(clickSelector);
      await delay(waitAfterClick);

      const state = await getActiveState(page);

      // Loop detection: if we're back to initial state after at least one beat
      if (passedFirstBeat && state === initialState) {
        break;
      }

      // No-change detection
      const prevRevealedAfter = await getRevealedTexts(page);

      // Check if anything actually changed
      const changed = revealedBefore.join('|') !== prevRevealedAfter.join('|');
      if (!changed) {
        noChangeStreak++;
        if (noChangeStreak >= 2) break;
        continue;
      }

      noChangeStreak = 0;
      passedFirstBeat = true;

      // New text = items revealed after click that weren't before
      const beforeSet = new Set(revealedBefore);
      const newTexts = prevRevealedAfter.filter(t => !beforeSet.has(t));
      beatTexts.push(newTexts.join(' ').trim());

      // Capture thumbnail (small JPEG for fast loading)
      const thumbName = `${thumbPrefix}${clickCount + 1}.jpg`;
      const thumbPath = path.join(THUMBS_DIR, thumbName);
      await page.screenshot({
        path: thumbPath,
        type: 'jpeg',
        quality: 70,
        clip: { x: 0, y: 0, width: config.WIDTH, height: config.HEIGHT },
      });
      beatThumbs.push(thumbName);

      clickCount++;
    }

    const domEstimate = domInfo.stepItemCount + Math.max(0, domInfo.slideCount - 1);
    const beatCount = clickCount > 0 ? clickCount : domEstimate;

    return {
      beatCount,
      beatTexts,
      beatThumbs,
      clickTarget: clickSelector,
      domEstimate,
      clickDetected: clickCount,
      slideCount: domInfo.slideCount,
      stepItemCount: domInfo.stepItemCount,
      maxTransitionMs: maxTransMs,
      transitionDurations: domInfo.transitionDurations,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Snapshot of active slide index + which of ITS items are revealed.
 * Only looks at the currently active slide — ignores other slides' state.
 */
async function getActiveState(page) {
  return page.evaluate(() => {
    const slides = document.querySelectorAll('.slide');
    let activeIdx = -1;
    slides.forEach((s, i) => { if (s.classList.contains('active')) activeIdx = i; });
    if (activeIdx < 0) return 'none';

    const items = slides[activeIdx].querySelectorAll('.step-item');
    const revealed = [];
    items.forEach((el, i) => {
      if (el.classList.contains('revealed') || el.classList.contains('visible')) {
        revealed.push(i);
      }
    });
    return `S${activeIdx}:${revealed.join(',')}`;
  });
}

/**
 * Get text content of all currently revealed step-items across all slides.
 */
async function getRevealedTexts(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.step-item.revealed, .step-item.visible')]
      .map(el => el.textContent.trim());
  });
}

module.exports = { analyzeHtml };
