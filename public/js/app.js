import { FileManager } from './components/file-manager.js';
import { PreviewPanel } from './components/preview-panel.js';
import { TimingEditor } from './components/timing-editor.js';
import { RenderQueue } from './components/render-queue.js';

// State
let currentFile = null;
let currentTiming = null;
let variantFiles = []; // files checked for group rendering

// Components
const renderQueue = new RenderQueue();

const timingEditor = new TimingEditor((beatTimes) => {
  currentTiming = beatTimes;
  updateRenderButtons();
});

const previewPanel = new PreviewPanel();

const fileManager = new FileManager(
  // onSelect — single file click
  async (name, analysis) => {
    currentFile = name;
    currentTiming = null;

    document.getElementById('no-selection').hidden = true;
    document.getElementById('editor-panel').hidden = false;

    previewPanel.loadFile(name, analysis);
    await timingEditor.loadFile(name);
    loadSegmentInfo(name);

    if (!analysis) {
      await analyzeFile(name);
    }

    updateRenderButtons();
  },
  // onGroupChange — checkboxes toggled
  (checkedFiles) => {
    variantFiles = checkedFiles;
    updateVariantUI();
    updateRenderButtons();
  }
);

// Preview analyze callback
previewPanel.onAnalyze = async (name) => {
  if (name) await analyzeFile(name);
};

// Variant UI
const variantSection = document.getElementById('variant-section');
const variantList = document.getElementById('variant-list');
const variantCount = document.getElementById('variant-count');
const btnRenderVariants = document.getElementById('btn-render-variants');

function updateVariantUI() {
  if (variantFiles.length < 2) {
    variantSection.hidden = true;
    btnRenderVariants.hidden = true;
    return;
  }

  variantSection.hidden = false;
  btnRenderVariants.hidden = false;
  variantCount.textContent = `${variantFiles.length} variants`;

  variantList.innerHTML = variantFiles.map((name, i) =>
    `<div class="variant-chip"><span class="variant-label">v${i + 1}</span>${name}</div>`
  ).join('');
}

// Render single file
const btnRender = document.getElementById('btn-render');
btnRender.addEventListener('click', async () => {
  if (!currentFile || !currentTiming) return;
  btnRender.disabled = true;

  const res = await fetch('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: currentFile, beatTimes: currentTiming }),
  });

  const job = await res.json();
  if (job.error) {
    alert(job.error);
  } else {
    renderQueue.addJob(job);
  }
  btnRender.disabled = false;
});

// Render all variants — same timing, different files
btnRenderVariants.addEventListener('click', async () => {
  if (variantFiles.length < 2 || !currentTiming) return;
  btnRenderVariants.disabled = true;

  const res = await fetch('/api/render/variants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileNames: variantFiles, beatTimes: currentTiming }),
  });

  const result = await res.json();
  if (result.error) {
    alert(result.error);
  } else {
    for (const job of result.jobs) {
      renderQueue.addJob(job);
    }
  }
  btnRenderVariants.disabled = false;
});

function updateRenderButtons() {
  const hasTiming = currentTiming && currentTiming.length > 0;
  btnRender.disabled = !(currentFile && hasTiming);
  btnRenderVariants.disabled = !(variantFiles.length >= 2 && hasTiming);
}

// ─── Script + SRT panel ─────────────────────────────────────────

const scriptSection = document.getElementById('script-section');
const scriptSegmentLabel = document.getElementById('script-segment-label');
const scriptTimeRange = document.getElementById('script-time-range');
const scriptContent = document.getElementById('script-content');

let currentSegmentNum = null;

async function loadSegmentInfo(fileName) {
  try {
    const res = await fetch(`/api/import/segment-info/${encodeURIComponent(fileName)}`);
    const data = await res.json();

    if (!data.segment) {
      scriptSection.hidden = true;
      currentSegmentNum = null;
      return;
    }

    const seg = data.segment;
    currentSegmentNum = seg.num;
    scriptSection.hidden = false;
    scriptSegmentLabel.textContent = `Segment ${seg.num}`;

    if (seg.startTime != null) {
      scriptTimeRange.textContent = `${formatTime(seg.startTime)} - ${formatTime(seg.endTime)}`;
    } else {
      scriptTimeRange.textContent = 'No timing';
    }

    scriptContent.textContent = seg.script || '(no script)';

    // Highlight this segment in the SRT timeline
    highlightSegmentInTimeline(seg.num);
  } catch {
    scriptSection.hidden = true;
    currentSegmentNum = null;
  }
}

// ─── Right Panel Tabs ───────────────────────────────────────────

document.querySelectorAll('.rp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.rp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.rp-tab-content').forEach(c => c.hidden = true);
    tab.classList.add('active');
    const target = document.getElementById(`rp-${tab.dataset.rpTab}`);
    if (target) target.hidden = false;
  });
});

// ─── SRT Timeline ───────────────────────────────────────────────

const srtTlList = document.getElementById('srt-tl-list');
const srtTlCueCount = document.getElementById('srt-tl-cue-count');
const srtTlSearch = document.getElementById('srt-tl-search');
const srtTlDropHint = document.getElementById('srt-tl-drop-hint');
let srtTimelineData = { cues: [], segments: [] };

async function loadSrtTimeline() {
  try {
    const res = await fetch('/api/import/srt-cues');
    srtTimelineData = await res.json();
    renderSrtTimeline();
  } catch {
    srtTlList.innerHTML = '<p class="empty-state">No SRT data</p>';
  }
}

function renderSrtTimeline(filter = '') {
  const { cues, segments } = srtTimelineData;
  if (!cues.length) {
    srtTlList.innerHTML = '<p class="empty-state">Upload an SRT file first</p>';
    srtTlCueCount.textContent = '';
    return;
  }

  srtTlCueCount.textContent = `${cues.length} cues`;
  const filterLower = filter.toLowerCase();

  // Build segment start time lookup
  const segStartMap = new Map();
  for (const s of segments) {
    if (s.startTime != null) segStartMap.set(s.startTime, s);
  }

  let html = '';
  let lastSegNum = null;

  for (const cue of cues) {
    // Filter
    if (filterLower && !cue.text.toLowerCase().includes(filterLower)) continue;

    // Insert segment marker if this cue starts a new segment
    const segAtThisCue = segStartMap.get(cue.startTime);
    if (segAtThisCue && segAtThisCue.num !== lastSegNum) {
      html += `
        <div class="srt-tl-segment-marker" data-seg-num="${segAtThisCue.num}">
          <span class="seg-marker-num">${segAtThisCue.num}</span>
          Segment ${segAtThisCue.num}
          <span class="seg-marker-script">${escapeHtml(segAtThisCue.script || '')}</span>
        </div>
      `;
      lastSegNum = segAtThisCue.num;
    }

    const isStart = segAtThisCue != null;
    const segBadge = cue.segmentNum ? `<span class="tl-seg-badge">${cue.segmentNum}</span>` : '';

    html += `
      <div class="srt-tl-cue${isStart ? ' is-segment-start' : ''}" data-start-time="${cue.startTime}">
        <span class="tl-time">${formatTime(cue.startTime)}</span>
        <span class="tl-text">${escapeHtml(cue.text)}</span>
        ${segBadge}
      </div>
    `;
  }

  srtTlList.innerHTML = html;
  setupTimelineDragDrop();
}

function setupTimelineDragDrop() {
  const cueEls = srtTlList.querySelectorAll('.srt-tl-cue');
  cueEls.forEach(el => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cueEls.forEach(c => c.classList.remove('drop-target'));
      el.classList.add('drop-target');
      srtTlDropHint.hidden = false;
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drop-target');
    });

    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      cueEls.forEach(c => c.classList.remove('drop-target'));
      srtTlDropHint.hidden = true;

      let dragData;
      try {
        dragData = JSON.parse(e.dataTransfer.getData('text/plain'));
      } catch { return; }

      if (!dragData.segmentNum) return;
      const newStartTime = parseFloat(el.dataset.startTime);

      // Call rematch
      try {
        const res = await fetch('/api/import/rematch-segment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segmentNum: dragData.segmentNum, newStartTime }),
        });
        const data = await res.json();

        if (data.error) {
          alert(data.error);
        } else {
          // Reload everything
          await fileManager.load();
          await loadSrtTimeline();
          if (currentFile) {
            loadSegmentInfo(currentFile);
            await timingEditor.loadFile(currentFile);
            updateRenderButtons();
          }
        }
      } catch (err) {
        alert(`Rematch failed: ${err.message}`);
      }
    });
  });

  // Also handle drag leaving the list entirely
  srtTlList.addEventListener('dragleave', (e) => {
    if (!srtTlList.contains(e.relatedTarget)) {
      srtTlDropHint.hidden = true;
      cueEls.forEach(c => c.classList.remove('drop-target'));
    }
  });
}

function highlightSegmentInTimeline(segNum) {
  // Scroll the SRT timeline to show this segment's marker
  const marker = srtTlList.querySelector(`.srt-tl-segment-marker[data-seg-num="${segNum}"]`);
  if (marker) {
    marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Search filter
srtTlSearch.addEventListener('input', () => {
  renderSrtTimeline(srtTlSearch.value);
});

function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

// Analyze helper
async function analyzeFile(name) {
  previewPanel.beatInfo.textContent = 'Analyzing...';
  try {
    const res = await fetch(`/api/files/${name}/analyze`, { method: 'POST' });
    const analysis = await res.json();
    previewPanel.updateAnalysis(analysis);

    const file = fileManager.files.find(f => f.name === name);
    if (file) file.analysis = analysis;
    fileManager.render();
  } catch (err) {
    previewPanel.beatInfo.textContent = 'Analysis failed';
  }
}

// ─── Pipeline: Analyze All + Render All ─────────────────────────

const pipelinePanel = document.getElementById('pipeline-panel');
const btnAnalyzeAll = document.getElementById('btn-analyze-all');
const btnRenderAll = document.getElementById('btn-render-all');
const btnRenderAllVariants = document.getElementById('btn-render-all-variants');
const pipelineStatus = document.getElementById('pipeline-status');
const pipelinePhase = document.getElementById('pipeline-phase');
const pipelineProgressFill = document.getElementById('pipeline-progress-fill');
const pipelineDetail = document.getElementById('pipeline-detail');

function showPipelinePanel() {
  pipelinePanel.hidden = false;
}

function updatePipelineProgress(phase, detail, pct, fillClass = '') {
  pipelineStatus.hidden = false;
  pipelinePhase.textContent = phase;
  pipelineDetail.textContent = detail;
  pipelineProgressFill.style.width = `${Math.min(100, pct)}%`;
  pipelineProgressFill.className = `pipeline-fill ${fillClass}`;
}

function hidePipelineProgress() {
  pipelineStatus.hidden = true;
}

btnAnalyzeAll.addEventListener('click', async () => {
  btnAnalyzeAll.disabled = true;
  btnAnalyzeAll.textContent = 'Analyzing...';

  try {
    const res = await fetch('/api/import/analyze-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      btnAnalyzeAll.disabled = false;
      btnAnalyzeAll.textContent = 'Analyze All';
    }
    // Progress comes via WebSocket
  } catch (err) {
    alert(`Analyze failed: ${err.message}`);
    btnAnalyzeAll.disabled = false;
    btnAnalyzeAll.textContent = 'Analyze All';
  }
});

btnRenderAll.addEventListener('click', async () => {
  btnRenderAll.disabled = true;
  btnRenderAll.textContent = 'Rendering...';

  try {
    const res = await fetch('/api/render/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: 1 }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      btnRenderAll.disabled = false;
      btnRenderAll.textContent = 'Render All (Option 1)';
    }
  } catch (err) {
    alert(`Render failed: ${err.message}`);
    btnRenderAll.disabled = false;
    btnRenderAll.textContent = 'Render All (Option 1)';
  }
});

btnRenderAllVariants.addEventListener('click', async () => {
  btnRenderAllVariants.disabled = true;
  btnRenderAllVariants.textContent = 'Rendering...';

  try {
    const res = await fetch('/api/render/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      btnRenderAllVariants.disabled = false;
      btnRenderAllVariants.textContent = 'Render All Variants';
    }
  } catch (err) {
    alert(`Render failed: ${err.message}`);
    btnRenderAllVariants.disabled = false;
    btnRenderAllVariants.textContent = 'Render All Variants';
  }
});

// ─── Import Project ─────────────────────────────────────────────

const importModal = document.getElementById('import-modal');
const importPathInput = document.getElementById('import-path-input');
const importStatus = document.getElementById('import-status');
const btnImportProject = document.getElementById('btn-import-project');
const btnImportConfirm = document.getElementById('btn-import-confirm');
const btnImportCancel = document.getElementById('btn-import-cancel');

btnImportProject.addEventListener('click', () => {
  importModal.hidden = false;
  importPathInput.value = '';
  importStatus.hidden = true;
  importPathInput.focus();
});

btnImportCancel.addEventListener('click', () => {
  importModal.hidden = true;
});

importModal.addEventListener('click', (e) => {
  if (e.target === importModal) importModal.hidden = true;
});

importPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnImportConfirm.click();
});

btnImportConfirm.addEventListener('click', async () => {
  const folderPath = importPathInput.value.trim();
  if (!folderPath) return;

  btnImportConfirm.disabled = true;
  btnImportConfirm.textContent = 'Importing...';
  importStatus.hidden = false;
  importStatus.className = 'import-status loading';
  importStatus.textContent = 'Scanning folder and copying files...';

  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });

    const data = await res.json();

    if (data.error) {
      importStatus.className = 'import-status error';
      importStatus.textContent = data.error;
      return;
    }

    importStatus.className = 'import-status success';
    importStatus.textContent = `Imported ${data.segmentCount} segments (${data.filesCopied} HTML files)`;

    // Reload file list and project data
    await fileManager.load();

    // Show pipeline panel (project loaded, ready for SRT upload)
    if (fileManager.project) {
      showPipelinePanel();
    }

    // Close modal after a brief pause
    setTimeout(() => {
      importModal.hidden = true;
    }, 1500);
  } catch (err) {
    importStatus.className = 'import-status error';
    importStatus.textContent = `Error: ${err.message}`;
  } finally {
    btnImportConfirm.disabled = false;
    btnImportConfirm.textContent = 'Import';
  }
});

// ─── Project-wide SRT Upload ────────────────────────────────────

const projectSrtUpload = document.getElementById('project-srt-upload');

projectSrtUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const summaryEl = document.getElementById('srt-match-summary');
  summaryEl.hidden = false;
  summaryEl.innerHTML = '<div class="srt-summary loading">Matching SRT to segments...</div>';

  const form = new FormData();
  form.append('srt', file);

  try {
    const res = await fetch('/api/import/match-srt', {
      method: 'POST',
      body: form,
    });

    const data = await res.json();

    if (data.error) {
      summaryEl.innerHTML = `<div class="srt-summary match-poor">${data.error}</div>`;
      return;
    }

    // Reload project and file data to pick up new timing
    await fileManager.load();
    showPipelinePanel();
    loadSrtTimeline();

  } catch (err) {
    summaryEl.innerHTML = `<div class="srt-summary match-poor">SRT matching failed: ${err.message}</div>`;
  }

  projectSrtUpload.value = '';
});

// ─── WebSocket for real-time updates ────────────────────────────

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'render-progress':
        renderQueue.updateProgress(data.jobId, {
          frame: data.frame,
          totalFrames: data.totalFrames,
          percent: data.percent,
        });
        break;
      case 'render-done':
        renderQueue.markDone(data.jobId, data.outputName, data.timelineOffset);
        break;
      case 'render-error':
        renderQueue.markError(data.jobId, data.error);
        break;
      case 'render-cancelled':
        renderQueue.markCancelled(data.jobId);
        break;
      case 'analyze-progress': {
        const pct = data.total > 0 ? (data.completed / data.total) * 100 : 0;
        let detail = '';
        if (data.status === 'analyzing') {
          detail = `Analyzing segment ${data.segmentNum}... ${data.fileName || ''}`;
        } else if (data.status === 'done') {
          detail = `Segment ${data.segmentNum} done (${data.beatCount} beats, cloned to ${data.clonedTo} variants)`;
        } else if (data.status === 'cached') {
          detail = `Segment ${data.segmentNum} cached`;
        } else if (data.status === 'error') {
          detail = `Segment ${data.segmentNum} error: ${data.error}`;
        } else if (data.status === 'skipped') {
          detail = `Segment ${data.segmentNum} skipped: ${data.reason}`;
        }
        updatePipelineProgress(
          `Analyzing ${data.completed}/${data.total}`,
          detail,
          pct
        );
        break;
      }
      case 'analyze-complete':
        updatePipelineProgress(
          `Analysis complete`,
          `${data.completed}/${data.total} segments${data.errors.length > 0 ? ` (${data.errors.length} errors)` : ''}`,
          100,
          data.errors.length > 0 ? 'error' : 'complete'
        );
        btnAnalyzeAll.disabled = false;
        btnAnalyzeAll.textContent = 'Analyze All';
        btnRenderAll.disabled = false;
        btnRenderAllVariants.hidden = false;
        btnRenderAllVariants.disabled = false;
        // Reload files to pick up new analysis data
        fileManager.load();
        break;
      case 'render-queue-progress': {
        const rPct = data.total > 0 ? (data.completed / data.total) * 100 : 0;
        updatePipelineProgress(
          `Rendering ${data.completed}/${data.total}`,
          data.currentFile || '',
          rPct,
          'rendering'
        );
        break;
      }
      case 'render-all-complete':
        updatePipelineProgress(
          `Rendering complete`,
          `${data.completed}/${data.total} files rendered`,
          100,
          'complete'
        );
        btnRenderAll.disabled = false;
        btnRenderAll.textContent = 'Render All (Option 1)';
        btnRenderAllVariants.disabled = false;
        btnRenderAllVariants.textContent = 'Render All Variants';
        break;
      case 'file-added':
        fileManager.addFile(data.name);
        break;
      case 'file-removed':
        fileManager.removeFile(data.name);
        break;
    }
  };

  ws.onclose = () => {
    setTimeout(connectWs, 2000);
  };
}

// Init
async function init() {
  await fileManager.load();
  await renderQueue.loadExisting();
  connectWs();

  // Show pipeline panel if project has SRT match
  if (fileManager.srtMatch) {
    showPipelinePanel();
    loadSrtTimeline();
    // Check if analysis already exists — enable render buttons
    const hasAnalysis = fileManager.files.some(f => f.analysis != null);
    if (hasAnalysis) {
      btnRenderAll.disabled = false;
      btnRenderAllVariants.hidden = false;
      btnRenderAllVariants.disabled = false;
    }
  }
}

init();
