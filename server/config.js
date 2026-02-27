const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  PORT: 3847,
  ROOT,
  INPUT_DIR: path.join(ROOT, 'input'),
  OUTPUT_DIR: path.join(ROOT, 'output'),
  DATA_DIR: path.join(ROOT, 'data'),

  // Render defaults
  WIDTH: 1920,
  HEIGHT: 1080,
  FPS: 30,
  FRAME_INTERVAL_MS: 1000 / 30, // ~33.33ms

  // ffmpeg encoding
  CRF: 18,
  PRESET: 'slow',
  TUNE: 'animation',
  PIXEL_FMT: 'yuv420p',

  // Beat detection selectors
  SLIDE_SELECTOR: '.slide',
  STEP_ITEM_SELECTOR: '.step-item',

  // How long to wait after a click for CSS transitions to finish (ms)
  DEFAULT_TRANSITION_DURATION: 600,
};
