export class FileManager {
  constructor(onSelect, onGroupChange) {
    this.onSelect = onSelect;
    this.onGroupChange = onGroupChange;
    this.files = [];
    this.selected = null;
    this.checked = new Set(); // multi-select for grouping

    // Project mode state
    this.project = null;         // project.json data
    this.srtMatch = null;        // SRT match results per segment
    this.expandedSegments = new Set(); // which segment groups are expanded

    this.listEl = document.getElementById('file-list');
    this.uploadInput = document.getElementById('file-upload');

    this.uploadInput.addEventListener('change', (e) => this.handleUpload(e));
  }

  async load() {
    const res = await fetch('/api/files');
    this.files = await res.json();

    // Check if a project is loaded
    await this.loadProject();
    this.render();
  }

  async loadProject() {
    try {
      const res = await fetch('/api/import/project');
      const data = await res.json();
      this.project = data.project;
      if (this.project?.srtMatch) {
        this.srtMatch = this.project.srtMatch;
      }
    } catch {
      this.project = null;
    }
  }

  render() {
    this.listEl.innerHTML = '';

    if (this.project && this.project.segments) {
      this.renderProjectMode();
      this.updateProjectBanner();
    } else {
      this.renderFlatMode();
      this.hideProjectBanner();
    }
  }

  /**
   * Render segments as grouped entries (project mode).
   */
  renderProjectMode() {
    const segments = this.project.segments;
    if (segments.length === 0) {
      this.listEl.innerHTML = '<li class="empty-state">No segments in project</li>';
      return;
    }

    for (const seg of segments) {
      const isExpanded = this.expandedSegments.has(seg.num);
      const matchInfo = this.srtMatch?.segmentMatches?.find(m => m.num === seg.num);
      const hasTime = matchInfo && matchInfo.startTime != null;

      // Segment group header
      const groupEl = document.createElement('li');
      groupEl.className = 'segment-group';

      const timeLabel = hasTime
        ? `${this.formatTimeShort(matchInfo.startTime)} - ${this.formatTimeShort(matchInfo.endTime)}`
        : '';
      const confLabel = matchInfo?.confidence != null
        ? `${matchInfo.confidence}%`
        : '';
      const confClass = matchInfo?.matched ? 'conf-ok' : 'conf-miss';

      groupEl.innerHTML = `
        <div class="segment-header" data-seg="${seg.num}">
          <span class="segment-toggle">${isExpanded ? '&#9660;' : '&#9654;'}</span>
          <span class="segment-num">${seg.num}</span>
          <span class="segment-name">SEGMENTO_${String(seg.num).padStart(4, '0')}</span>
          <span class="segment-time">${timeLabel}</span>
          ${confLabel ? `<span class="segment-conf ${confClass}">${confLabel}</span>` : ''}
        </div>
      `;

      const header = groupEl.querySelector('.segment-header');
      header.addEventListener('click', () => {
        if (this.expandedSegments.has(seg.num)) {
          this.expandedSegments.delete(seg.num);
        } else {
          this.expandedSegments.add(seg.num);
        }
        this.render();
      });

      // Make segment headers draggable for SRT Timeline reassignment
      header.draggable = true;
      header.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ segmentNum: seg.num }));
        e.dataTransfer.effectAllowed = 'move';
        header.classList.add('dragging');
      });
      header.addEventListener('dragend', () => {
        header.classList.remove('dragging');
      });

      this.listEl.appendChild(groupEl);

      // Variant items (shown when expanded)
      if (isExpanded) {
        for (const htmlFile of seg.htmlFiles) {
          const file = this.files.find(f => f.name === htmlFile);
          const isSelected = htmlFile === this.selected;
          const isChecked = this.checked.has(htmlFile);
          const beats = file?.analysis ? `${file.analysis.beatCount} beats` : 'not analyzed';

          const li = document.createElement('li');
          li.className = `segment-variant ${isSelected ? 'active' : ''}`;

          // Extract option label
          const optMatch = htmlFile.match(/Option(\d+)/i);
          const optLabel = optMatch ? `Option ${optMatch[1]}` : htmlFile;

          li.innerHTML = `
            <div class="file-row variant-row">
              <input type="checkbox" class="file-check" data-name="${htmlFile}" ${isChecked ? 'checked' : ''}>
              <div class="file-info">
                <span class="file-name">${optLabel}</span>
                <span class="file-meta">${beats}</span>
              </div>
              <button class="file-delete" title="Delete file">&#10005;</button>
            </div>
          `;

          const fileInfo = li.querySelector('.file-info');
          fileInfo.addEventListener('click', () => this.select(htmlFile));

          const checkbox = li.querySelector('.file-check');
          checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (e.target.checked) {
              this.checked.add(htmlFile);
            } else {
              this.checked.delete(htmlFile);
            }
            this.onGroupChange([...this.checked]);
          });

          const deleteBtn = li.querySelector('.file-delete');
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteFile(htmlFile);
          });

          this.listEl.appendChild(li);
        }
      }
    }

    // Also show any files not in a segment (orphans)
    const segmentFiles = new Set(this.project.segments.flatMap(s => s.htmlFiles));
    const orphans = this.files.filter(f => !segmentFiles.has(f.name));
    if (orphans.length > 0) {
      const divider = document.createElement('li');
      divider.className = 'segment-divider';
      divider.textContent = 'Other files';
      this.listEl.appendChild(divider);

      for (const file of orphans) {
        this.renderFlatItem(file);
      }
    }
  }

  /**
   * Render flat file list (non-project mode, original behavior).
   */
  renderFlatMode() {
    if (this.files.length === 0) {
      this.listEl.innerHTML = '<li class="empty-state">No HTML files yet</li>';
      return;
    }

    // Compute sequence numbers from timeline offsets
    const withTiming = this.files
      .filter(f => f.timelineOffset != null)
      .sort((a, b) => a.timelineOffset - b.timelineOffset);
    const seqMap = new Map();
    withTiming.forEach((f, i) => seqMap.set(f.name, i + 1));

    for (const file of this.files) {
      this.renderFlatItem(file, seqMap);
    }
  }

  renderFlatItem(file, seqMap) {
    const li = document.createElement('li');
    li.className = file.name === this.selected ? 'active' : '';

    const isChecked = this.checked.has(file.name);
    const beats = file.analysis ? `${file.analysis.beatCount} beats` : 'not analyzed';
    const seqNum = seqMap?.get(file.name);
    const seqBadge = seqNum ? `<span class="seq-badge">${seqNum}</span>` : '';

    li.innerHTML = `
      <div class="file-row">
        <input type="checkbox" class="file-check" data-name="${file.name}" ${isChecked ? 'checked' : ''}>
        ${seqBadge}
        <div class="file-info">
          <span class="file-name">${file.name}</span>
          <span class="file-meta">${beats}</span>
        </div>
        <button class="file-delete" title="Delete file">&#10005;</button>
      </div>
    `;

    const fileInfo = li.querySelector('.file-info');
    fileInfo.addEventListener('click', () => this.select(file.name));

    const checkbox = li.querySelector('.file-check');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) {
        this.checked.add(file.name);
      } else {
        this.checked.delete(file.name);
      }
      this.onGroupChange([...this.checked]);
    });

    const deleteBtn = li.querySelector('.file-delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteFile(file.name);
    });

    this.listEl.appendChild(li);
  }

  updateProjectBanner() {
    const banner = document.getElementById('project-banner');
    const nameEl = document.getElementById('project-name');
    const statsEl = document.getElementById('project-stats');

    if (!this.project) {
      banner.hidden = true;
      return;
    }

    banner.hidden = false;
    const folderName = this.project.sourcePath.split('/').pop();
    nameEl.textContent = folderName;

    const segCount = this.project.segments.length;
    const fileCount = this.project.segments.reduce((n, s) => n + s.htmlFiles.length, 0);
    statsEl.textContent = `${segCount} segments, ${fileCount} files`;

    this.updateSrtMatchSummary();
  }

  updateSrtMatchSummary() {
    const summaryEl = document.getElementById('srt-match-summary');
    if (!this.srtMatch) {
      summaryEl.hidden = true;
      return;
    }

    summaryEl.hidden = false;
    const { matchedCount, totalSegments, srtFilename } = this.srtMatch;
    const pct = Math.round((matchedCount / totalSegments) * 100);
    const statusClass = pct >= 80 ? 'match-good' : pct >= 50 ? 'match-ok' : 'match-poor';

    summaryEl.innerHTML = `
      <div class="srt-summary ${statusClass}">
        <strong>${matchedCount}/${totalSegments}</strong> matched (${pct}%)
        <span class="srt-summary-file">${srtFilename}</span>
      </div>
    `;
  }

  hideProjectBanner() {
    document.getElementById('project-banner').hidden = true;
    document.getElementById('srt-match-summary').hidden = true;
  }

  select(name) {
    this.selected = name;
    this.render();
    const file = this.files.find(f => f.name === name);
    this.onSelect(name, file?.analysis);
  }

  /**
   * Select a segment's first variant and auto-check all variants for group render.
   */
  selectSegment(segNum) {
    if (!this.project) return;
    const seg = this.project.segments.find(s => s.num === segNum);
    if (!seg || seg.htmlFiles.length === 0) return;

    // Expand this segment
    this.expandedSegments.add(segNum);

    // Auto-check all variants
    for (const f of seg.htmlFiles) {
      this.checked.add(f);
    }

    // Select first variant
    this.select(seg.htmlFiles[0]);
    this.onGroupChange([...this.checked]);
  }

  getCheckedFiles() {
    return [...this.checked];
  }

  async handleUpload(e) {
    const files = e.target.files;
    if (!files.length) return;

    const form = new FormData();
    for (const f of files) form.append('files', f);

    await fetch('/api/files/upload', { method: 'POST', body: form });
    this.uploadInput.value = '';
    await this.load();
  }

  addFile(name) {
    if (!this.files.find(f => f.name === name)) {
      this.files.push({ name, analysis: null });
      this.render();
    }
  }

  async deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    this.removeFile(name);
  }

  removeFile(name) {
    this.files = this.files.filter(f => f.name !== name);
    this.checked.delete(name);
    if (this.selected === name) this.selected = null;
    this.render();
  }

  formatTimeShort(seconds) {
    if (seconds == null || isNaN(seconds)) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
