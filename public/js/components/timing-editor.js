export class TimingEditor {
  constructor(onTimingChange) {
    this.onTimingChange = onTimingChange;
    this.currentFile = null;
    this.beatTimes = [];
    this.mapping = null;
    this.cues = []; // full SRT cue list for the browser panel

    this.timingInput = document.getElementById('timing-input');
    this.btnSave = document.getElementById('btn-save-timing');
    this.srtDropZone = document.getElementById('srt-drop-zone');
    this.srtUpload = document.getElementById('srt-upload');
    this.srtResult = document.getElementById('srt-result');
    this.timingPreview = document.getElementById('timing-preview');
    this.timingList = document.getElementById('timing-list');

    this.tabs = document.querySelectorAll('.timing-tabs .tab');
    this.tabManual = document.getElementById('tab-manual');
    this.tabSrt = document.getElementById('tab-srt');

    this.setupTabs();
    this.setupManual();
    this.setupSrt();
  }

  setupTabs() {
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        this.tabManual.hidden = target !== 'manual';
        this.tabSrt.hidden = target !== 'srt';
      });
    });
  }

  setupManual() {
    this.btnSave.addEventListener('click', () => this.saveManualTiming());
  }

  setupSrt() {
    this.srtDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.srtDropZone.classList.add('dragover');
    });
    this.srtDropZone.addEventListener('dragleave', () => {
      this.srtDropZone.classList.remove('dragover');
    });
    this.srtDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.srtDropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.srt')) {
        this.uploadSrt(file);
      }
    });

    this.srtUpload.addEventListener('change', (e) => {
      if (e.target.files[0]) this.uploadSrt(e.target.files[0]);
    });
  }

  async loadFile(name) {
    this.currentFile = name;
    this.srtResult.hidden = true;
    this.mapping = null;
    this.cues = [];

    const res = await fetch(`/api/timing/${name}`);
    const data = await res.json();

    if (data.beatTimes && data.beatTimes.length > 0) {
      this.beatTimes = data.beatTimes;
      this.timingInput.value = data.beatTimes.join(', ');
      this.mapping = data.mapping || null;
      this.cues = data.cues || [];

      if (this.mapping && this.mapping.length > 0) {
        await this.renderEditableMapping(data);
      }

      this.showTimingPreview();
      this.onTimingChange(this.beatTimes);
    } else {
      this.beatTimes = [];
      this.timingInput.value = '';
      this.timingPreview.hidden = true;
      this.onTimingChange(null);
    }
  }

  async saveManualTiming() {
    if (!this.currentFile) return;

    const raw = this.timingInput.value.trim();
    if (!raw) return;

    const times = raw.split(/[,\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => this.parseTime(s))
      .filter(n => !isNaN(n));

    if (times.length === 0) return;
    times.sort((a, b) => a - b);

    const res = await fetch(`/api/timing/${this.currentFile}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beatTimes: times }),
    });

    const data = await res.json();
    this.beatTimes = data.beatTimes;
    this.timingInput.value = this.beatTimes.join(', ');
    this.showTimingPreview();
    this.onTimingChange(this.beatTimes);
  }

  async uploadSrt(file) {
    if (!this.currentFile) return;

    const form = new FormData();
    form.append('srt', file);

    const res = await fetch(`/api/timing/${this.currentFile}/srt`, {
      method: 'POST',
      body: form,
    });

    const data = await res.json();

    if (data.error) {
      this.srtResult.hidden = false;
      this.srtResult.innerHTML = `<span style="color:var(--danger)">${data.error}</span>`;
      return;
    }

    this.beatTimes = data.beatTimes;
    this.mapping = data.mapping;
    this.cues = data.cues || [];
    this.timingInput.value = this.beatTimes.join(', ');

    await this.renderEditableMapping(data);
    this.showTimingPreview();
    this.onTimingChange(this.beatTimes);
  }

  /**
   * Render the split layout: beat mapping table (left) + SRT cue browser (right).
   */
  async renderEditableMapping(data) {
    const mapping = data.mapping;
    if (!mapping) {
      this.srtResult.hidden = true;
      return;
    }

    // Load thumbnails from analysis
    let beatThumbs = [];
    if (this.currentFile) {
      try {
        const analysisRes = await fetch(`/api/files`);
        const files = await analysisRes.json();
        const file = files.find(f => f.name === this.currentFile);
        if (file?.analysis?.beatThumbs) {
          beatThumbs = file.analysis.beatThumbs;
        }
      } catch {}
    }

    const matched = data.matchedCount || 0;
    const total = data.beatCount || mapping.length;
    const srtName = data.srtFilename || 'SRT';

    let html = `<div class="mapping-header">`;
    html += `<strong>${srtName}</strong> — ${matched}/${total} beats matched`;
    if (matched < total) {
      html += `<span class="mapping-warn">Drag SRT cues onto unmatched beats</span>`;
    }
    html += `</div>`;

    // Split layout: beats left, SRT browser right
    html += '<div class="mapping-split">';

    // LEFT: beat mapping table
    html += '<div class="mapping-beats-col">';
    html += '<div class="mapping-table" id="mapping-table">';
    for (let i = 0; i < mapping.length; i++) {
      const m = mapping[i];
      const isMatched = m.cueIdx !== null;
      const cls = isMatched ? 'match-ok' : 'match-miss';
      const icon = isMatched ? '&#10003;' : '&#10007;';
      const time = this.beatTimes[i] || 0;

      const beatLabel = m.beatText ? this.truncate(m.beatText, 45) : '(no text)';
      const cueLabel = m.cueText ? this.truncate(m.cueText, 45) : '';
      const scoreLabel = m.score > 0 ? `${m.score}%` : '';
      const thumbSrc = beatThumbs[i] ? `/data/thumbs/${beatThumbs[i]}` : null;

      html += `<div class="mapping-row-edit ${cls}" data-beat-idx="${i}">`;
      html += `  <button class="beat-delete" data-idx="${i}" title="Remove beat">&#10005;</button>`;
      html += `  <div class="map-beat-num">#${i + 1}</div>`;
      if (thumbSrc) {
        html += `  <div class="map-thumb"><img src="${thumbSrc}" alt="Beat ${i + 1}" loading="lazy" /></div>`;
      }
      html += `  <div class="map-time-col">`;
      html += `    <input type="text" class="map-time-input" data-beat="${i}" value="${this.formatTime(time)}" />`;
      html += `  </div>`;
      html += `  <div class="map-texts">`;
      html += `    <div class="map-beat-text">${beatLabel}</div>`;
      if (isMatched) {
        html += `  <div class="map-cue-text">${cueLabel} <span class="match-score">${scoreLabel}</span></div>`;
      } else {
        html += `  <div class="map-cue-text unmatched">Drop SRT cue here to assign</div>`;
      }
      html += `  </div>`;
      html += `</div>`;
    }
    html += '</div>'; // mapping-table
    html += `<button class="primary-btn mapping-save-btn" id="btn-apply-mapping">Save Adjusted Timing</button>`;
    html += '</div>'; // mapping-beats-col

    // RIGHT: SRT cue browser
    html += '<div class="srt-browser-col">';
    html += '<div class="srt-browser-header">';
    html += '  <strong>SRT Cues</strong>';
    html += `  <span class="srt-cue-count">${this.cues.length} cues</span>`;
    html += '</div>';
    html += '<input type="text" class="srt-search" id="srt-search" placeholder="Search transcript..." />';
    html += '<div class="srt-cue-list" id="srt-cue-list">';
    for (const cue of this.cues) {
      html += `<div class="srt-cue-item" draggable="true" data-time="${cue.startTime}" data-text="${this.escapeHtml(cue.text)}">`;
      html += `  <span class="srt-cue-time">${this.formatTime(cue.startTime)}</span>`;
      html += `  <span class="srt-cue-text">${this.truncate(cue.text, 60)}</span>`;
      html += `</div>`;
    }
    html += '</div>'; // srt-cue-list
    html += '</div>'; // srt-browser-col

    html += '</div>'; // mapping-split

    this.srtResult.innerHTML = html;
    this.srtResult.hidden = false;

    this.wireUpMappingEvents();
  }

  /**
   * Wire up all interactive events: delete, drag-drop, search, thumbnails.
   */
  wireUpMappingEvents() {
    // Delete beat buttons
    this.srtResult.querySelectorAll('.beat-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        this.deleteBeat(idx);
      });
    });

    // Save button
    document.getElementById('btn-apply-mapping').addEventListener('click', () => {
      this.applyMappingTiming();
    });

    // Highlight unmatched
    this.srtResult.querySelectorAll('.match-miss .map-time-input').forEach(input => {
      input.classList.add('needs-edit');
    });

    // Click thumbnail to expand
    this.srtResult.querySelectorAll('.map-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const src = thumb.querySelector('img').src;
        const overlay = document.createElement('div');
        overlay.className = 'thumb-expanded';
        overlay.innerHTML = `<img src="${src}" />`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      });
    });

    // SRT cue drag start
    this.srtResult.querySelectorAll('.srt-cue-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({
          time: parseFloat(item.dataset.time),
          text: item.dataset.text,
        }));
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
      });
    });

    // Beat rows as drop targets
    this.srtResult.querySelectorAll('.mapping-row-edit').forEach(row => {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drop-target');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          const beatIdx = parseInt(row.dataset.beatIdx);
          this.assignCueToBeat(beatIdx, data.time, data.text);
        } catch {}
      });
    });

    // SRT search
    const searchInput = document.getElementById('srt-search');
    const cueList = document.getElementById('srt-cue-list');
    if (searchInput && cueList) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim();
        cueList.querySelectorAll('.srt-cue-item').forEach(item => {
          const text = item.dataset.text.toLowerCase();
          item.hidden = query && !text.includes(query);
        });
      });
    }
  }

  /**
   * Assign a dragged SRT cue to a beat — updates time and cue text display.
   */
  assignCueToBeat(beatIdx, time, text) {
    // Update the time input
    const input = this.srtResult.querySelector(`.map-time-input[data-beat="${beatIdx}"]`);
    if (input) {
      input.value = this.formatTime(time);
      input.classList.remove('needs-edit');
      input.classList.add('just-assigned');
      setTimeout(() => input.classList.remove('just-assigned'), 1000);
    }

    // Update the cue text display
    const row = this.srtResult.querySelector(`.mapping-row-edit[data-beat-idx="${beatIdx}"]`);
    if (row) {
      row.classList.remove('match-miss');
      row.classList.add('match-ok');
      const iconEl = row.querySelector('.map-icon');
      if (iconEl) iconEl.innerHTML = '&#10003;';
      const cueTextEl = row.querySelector('.map-cue-text');
      if (cueTextEl) {
        cueTextEl.classList.remove('unmatched');
        cueTextEl.textContent = this.truncate(text, 45);
      }
    }

    // Update internal mapping
    if (this.mapping && this.mapping[beatIdx]) {
      this.mapping[beatIdx].cueText = text;
      this.mapping[beatIdx].time = time;
      this.mapping[beatIdx].cueIdx = -1; // mark as manually assigned
      this.mapping[beatIdx].score = 100;
    }
  }

  /**
   * Delete a beat from the mapping. Removes the row and its timing.
   */
  deleteBeat(idx) {
    if (!this.mapping) return;

    this.mapping.splice(idx, 1);
    this.beatTimes.splice(idx, 1);

    // Re-render by rebuilding from current state
    const data = {
      mapping: this.mapping,
      matchedCount: this.mapping.filter(m => m.cueIdx !== null).length,
      beatCount: this.mapping.length,
      srtFilename: this.srtResult.querySelector('.mapping-header strong')?.textContent || 'SRT',
      cues: this.cues,
    };
    this.renderEditableMapping(data);
    this.showTimingPreview();
    this.timingInput.value = this.beatTimes.join(', ');
  }

  /**
   * Read all time inputs from the mapping table and save.
   */
  async applyMappingTiming() {
    const inputs = this.srtResult.querySelectorAll('.map-time-input');
    const times = [];

    for (const input of inputs) {
      const val = input.value.trim();
      const seconds = this.parseTime(val);
      if (isNaN(seconds)) {
        input.classList.add('input-error');
        return;
      }
      input.classList.remove('input-error');
      times.push(seconds);
    }

    const res = await fetch(`/api/timing/${this.currentFile}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beatTimes: times }),
    });

    const data = await res.json();
    this.beatTimes = data.beatTimes;
    this.timingInput.value = this.beatTimes.join(', ');
    this.showTimingPreview();
    this.onTimingChange(this.beatTimes);

    const btn = document.getElementById('btn-apply-mapping');
    btn.textContent = 'Saved!';
    btn.style.background = 'var(--success)';
    setTimeout(() => {
      btn.textContent = 'Save Adjusted Timing';
      btn.style.background = '';
    }, 1500);
  }

  parseTime(str) {
    str = str.trim();
    if (!str) return NaN;
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
      }
      if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
      }
    }
    return parseFloat(str);
  }

  formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '0:00.000';
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(3);
    return `${m}:${s.padStart(6, '0')}`;
  }

  escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  showTimingPreview() {
    if (this.beatTimes.length === 0) {
      this.timingPreview.hidden = true;
      return;
    }
    this.timingPreview.hidden = false;
    this.timingList.innerHTML = this.beatTimes.map((t, i) =>
      `<span class="beat-chip"><span class="beat-num">#${i + 1}</span>${this.formatTime(t)}</span>`
    ).join('');
  }
}
