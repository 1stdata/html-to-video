export class PreviewPanel {
  constructor() {
    this.iframe = document.getElementById('preview-iframe');
    this.container = document.getElementById('preview-container');
    this.beatInfo = document.getElementById('beat-info');
    this.clickCounter = document.getElementById('click-counter');
    this.btnClick = document.getElementById('btn-click-preview');
    this.btnReset = document.getElementById('btn-reset-preview');
    this.btnAnalyze = document.getElementById('btn-analyze');

    this.clickCount = 0;
    this.currentFile = null;
    this.onAnalyze = null;

    this.btnClick.addEventListener('click', () => this.advanceClick());
    this.btnReset.addEventListener('click', () => this.resetPreview());
    this.btnAnalyze.addEventListener('click', () => {
      if (this.onAnalyze) this.onAnalyze(this.currentFile);
    });

    this.updateScale();
    window.addEventListener('resize', () => this.updateScale());
  }

  updateScale() {
    const containerWidth = this.container.clientWidth || 710;
    const scale = containerWidth / 1920;
    this.iframe.style.transform = `scale(${scale})`;
    this.container.style.height = `${1080 * scale}px`;
  }

  loadFile(name, analysis) {
    this.currentFile = name;
    this.clickCount = 0;
    this.clickCounter.textContent = 'Clicks: 0';
    this.iframe.src = `/input/${name}`;

    if (analysis) {
      this.beatInfo.textContent = `${analysis.beatCount} beats | ${analysis.slideCount} slides | ${analysis.stepItemCount} step-items`;
    } else {
      this.beatInfo.textContent = 'Not analyzed yet';
    }

    // Re-scale after a moment to account for layout
    setTimeout(() => this.updateScale(), 100);
  }

  updateAnalysis(analysis) {
    if (analysis) {
      this.beatInfo.textContent = `${analysis.beatCount} beats | ${analysis.slideCount} slides | ${analysis.stepItemCount} step-items`;
    }
  }

  advanceClick() {
    try {
      const doc = this.iframe.contentDocument || this.iframe.contentWindow.document;
      // Try known click targets first, then fallback to body
      const target = doc.querySelector('#stage')
        || doc.querySelector('#presentation')
        || doc.querySelector('#app')
        || doc.querySelector('.slides')
        || doc.body;
      target.click();
      this.clickCount++;
      this.clickCounter.textContent = `Clicks: ${this.clickCount}`;
    } catch {
      // Cross-origin — can't interact
      this.clickCounter.textContent = 'Cannot interact (cross-origin)';
    }
  }

  resetPreview() {
    this.clickCount = 0;
    this.clickCounter.textContent = 'Clicks: 0';
    if (this.currentFile) {
      this.iframe.src = `/input/${this.currentFile}`;
    }
  }
}
