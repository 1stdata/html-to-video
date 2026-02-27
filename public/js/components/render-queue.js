function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const ms = Math.round((totalSec % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export class RenderQueue {
  constructor() {
    this.jobList = document.getElementById('job-list');
    this.jobs = new Map();
  }

  addJob(job) {
    this.jobs.set(job.id, { ...job, progress: { frame: 0, totalFrames: 0, percent: 0 } });
    this.render();
  }

  updateProgress(jobId, progress) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.progress = progress;
      this.updateJobCard(jobId);
    }
  }

  markDone(jobId, outputName, timelineOffset) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'done';
      job.outputName = outputName;
      if (timelineOffset !== undefined) job.timelineOffset = timelineOffset;
      this.render();
    }
  }

  markError(jobId, error) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = error;
      this.render();
    }
  }

  markCancelled(jobId) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'cancelled';
      this.render();
    }
  }

  async cancelJob(jobId) {
    await fetch(`/api/render/${jobId}/cancel`, { method: 'POST' });
  }

  render() {
    if (this.jobs.size === 0) {
      this.jobList.innerHTML = '<p class="empty-state">No renders yet</p>';
      return;
    }

    this.jobList.innerHTML = '';
    for (const [id, job] of [...this.jobs].reverse()) {
      const card = document.createElement('div');
      card.className = 'job-card';
      card.id = `job-${id}`;

      const percent = job.progress?.percent || 0;
      const frame = job.progress?.frame || 0;
      const total = job.progress?.totalFrames || 0;

      let actionsHtml = '';
      let timelineHtml = '';
      if (job.status === 'running') {
        actionsHtml = `<button class="cancel-btn" data-job="${id}">Cancel</button>`;
      } else if (job.status === 'done') {
        actionsHtml = `<a href="/output/${job.outputName}" download class="small-btn" style="text-decoration:none;display:inline-block">Download</a>`;
        if (job.timelineOffset > 0) {
          timelineHtml = `<div class="timeline-info">Place at <strong>${formatTime(job.timelineOffset)}</strong> on timeline</div>`;
        }
      }

      card.innerHTML = `
        <div class="job-name">${job.fileName}</div>
        <div class="job-status ${job.status}">${job.status}</div>
        ${job.status === 'running' ? `
          <div class="progress-bar"><div class="fill" style="width:${percent}%"></div></div>
          <div class="progress-text">
            <span>Frame ${frame}/${total}</span>
            <span>${percent}%</span>
          </div>
        ` : ''}
        ${job.status === 'error' ? `<div style="font-size:11px;color:var(--danger)">${job.error || 'Unknown error'}</div>` : ''}
        ${timelineHtml}
        <div class="job-actions">${actionsHtml}</div>
      `;

      // Cancel button handler
      const cancelBtn = card.querySelector('.cancel-btn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => this.cancelJob(id));
      }

      this.jobList.appendChild(card);
    }
  }

  updateJobCard(jobId) {
    const card = document.getElementById(`job-${jobId}`);
    if (!card) return;

    const job = this.jobs.get(jobId);
    if (!job) return;

    const fill = card.querySelector('.progress-bar .fill');
    const progressText = card.querySelector('.progress-text');

    if (fill) fill.style.width = `${job.progress.percent}%`;
    if (progressText) {
      progressText.innerHTML = `
        <span>Frame ${job.progress.frame}/${job.progress.totalFrames}</span>
        <span>${job.progress.percent}%</span>
      `;
    }
  }

  async loadExisting() {
    const res = await fetch('/api/render');
    const jobs = await res.json();
    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }
    this.render();
  }
}
