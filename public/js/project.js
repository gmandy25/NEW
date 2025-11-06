'use strict';

// Small utility helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const params = new URLSearchParams(location.search);
const projectId = params.get('id');

const els = {
  // Project header
  title: $('#projectTitle'),
  desc: $('#projectDesc'),
  meta: $('#projectMeta'),
 
  // Datasets
  uploadForm: $('#uploadForm'),
  datasetInput: $('#datasetInput'),
  previewWrap: $('#previewWrap'),
  previewHead: $('#datasetPreview thead'),
  previewBody: $('#datasetPreview tbody'),
  datasetsList: $('#datasetsList'),
  uploadBtn: $('#uploadBtn'),
 
  // Training config
  arch: $('#arch'),
  epochs: $('#epochs'),
  lr: $('#lr'),
  batch: $('#batch'),
  split: $('#split'),
  seed: $('#seed'),
  saveModel: $('#saveModel'),
  modelName: $('#modelName'),
  trainBtn: $('#trainBtn'),
 
  // Models
  modelsList: $('#modelsList'),
 
  // Jobs and metrics
  jobsList: $('#jobsList'),
  lossCanvas: $('#lossCanvas'),
  accCanvas: $('#accCanvas'),
  activeJobTitle: $('#activeJobTitle')
};

const state = {
  activeJobId: null,
  metricsCache: new Map(), // jobId -> metrics[]
  pollers: {
    jobs: null,
    metrics: null
  }
};

// ---------- Fetch helpers ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

// ---------- Formatting ----------
function toRelativeTime(iso) {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&').replace(/</g, '<')
    .replace(/>/g, '>').replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

// ---------- Project ----------
async function loadProject() {
  try {
    const p = await getJSON(`/api/projects/${projectId}`);
    if (els.title) els.title.textContent = `Project #${p.id} • ${p.name}`;
    if (els.desc) els.desc.textContent = p.description || '';
    if (els.meta) els.meta.textContent = `Created ${toRelativeTime(p.created_at)}`;
  } catch (err) {
    console.error('[project] failed to load project', err);
    if (els.title) els.title.textContent = 'Project (Failed to load)';
  }
}

// ---------- Datasets ----------
function simpleCSVParse(text, delimiter = ',') {
  // Lightweight CSV parser that handles quotes for preview purposes
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else { field += c; }
    }
  }
  // push last field
  row.push(field);
  rows.push(row);
  return rows;
}

function renderPreviewFromArray(arr) {
  // arr: array of arrays (rows)
  const maxRows = 25;
  const maxCols = 30;
  const rows = arr.slice(0, maxRows).map(r => r.slice(0, maxCols));

  const head = rows.length ? rows[0] : [];
  const body = rows.length > 1 ? rows.slice(1) : [];

  if (els.previewHead) {
    els.previewHead.innerHTML = head.length
      ? `<tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
      : '';
  }
  if (els.previewBody) {
    els.previewBody.innerHTML = body.map(r =>
      `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    ).join('');
  }
  if (els.previewWrap) els.previewWrap.style.display = rows.length ? 'block' : 'none';
}

async function handleFilePreview(file) {
  if (!file) {
    if (els.previewWrap) els.previewWrap.style.display = 'none';
    return;
  }
  try {
    const isJSON = /\.json$/i.test(file.name);
    const blob = file.slice(0, 128 * 1024); // first 128KB
    const text = await blob.text();

    if (isJSON || /^[\s\r\n]*[\[{]/.test(text)) {
      // JSON preview: array of objects or array of arrays
      let data = [];
      try { data = JSON.parse(text); } catch { data = []; }
      if (Array.isArray(data) && data.length > 0) {
        if (Array.isArray(data[0])) {
          renderPreviewFromArray([...(data.slice(0, 1))].concat(data.slice(1)));
        } else if (typeof data[0] === 'object' && data[0]) {
          const cols = Object.keys(data[0]);
          const rows = [cols].concat(
            data.slice(0, 24).map(r => cols.map(k => r[k]))
          );
          renderPreviewFromArray(rows);
        } else {
          renderPreviewFromArray([['value'], ...data.slice(0, 24).map(v => [String(v)])]);
        }
      } else {
        renderPreviewFromArray([]);
      }
    } else {
      // CSV/TSV preview
      const delim = /\.tsv$/i.test(file.name) ? '\t' : ',';
      const rows = simpleCSVParse(text, delim);
      renderPreviewFromArray(rows);
    }
  } catch (err) {
    console.error('[dataset] preview failed', err);
    renderPreviewFromArray([]);
  }
}

async function loadDatasets() {
  try {
    const list = await getJSON(`/api/projects/${projectId}/datasets`);
    if (!els.datasetsList) return;
    if (!list.length) {
      els.datasetsList.innerHTML = `<div class="muted">No datasets yet</div>`;
      return;
    }
    els.datasetsList.innerHTML = list.map(d => {
      const meta = [
        `#${d.id}`,
        escapeHtml(d.name),
        formatBytes(d.size_bytes),
        d.rows != null ? `${d.rows} rows` : 'rows —'
      ].join(' • ');
      return `<div class="badge"><span class="dot completed"></span>${meta}</div>`;
    }).join('');
  } catch (err) {
    console.error('[dataset] failed to load list', err);
    if (els.datasetsList) els.datasetsList.innerHTML =
      `<div class="muted" style="color:#fecaca">Failed to load datasets</div>`;
  }
}

// ---------- Models ----------
async function loadModels() {
  try {
    const list = await getJSON(`/api/projects/${projectId}/models`);
    renderModels(list);
  } catch (err) {
    console.error('[models] failed to load', err);
    if (els.modelsList) {
      els.modelsList.innerHTML = `<div class="muted" style="color:#fecaca">Failed to load models</div>`;
    }
  }
}

function renderModels(list) {
  if (!els.modelsList) return;
  if (!list || !list.length) {
    els.modelsList.innerHTML = `<div class="muted">No saved models</div>`;
    return;
  }
  els.modelsList.innerHTML = list.map(m => {
    const name = escapeHtml(m.name);
    const created = toRelativeTime(m.created_at);
    const cfg = m.config || {};
    const cfgSummary = [
      `arch=${escapeHtml(String(cfg.architecture ?? '—'))}`,
      `epochs=${Number.isFinite(Number(cfg.epochs)) ? Number(cfg.epochs) : '—'}`,
      `lr=${Number.isFinite(Number(cfg.learningRate)) ? Number(cfg.learningRate) : '—'}`,
      `batch=${Number.isFinite(Number(cfg.batchSize)) ? Number(cfg.batchSize) : '—'}`
    ].join(' · ');
    return `
      <div class="card" style="padding:10px">
        <div style="display:flex; gap:10px; align-items:center; justify-content:space-between">
          <div style="display:flex; gap:10px; align-items:center">
            <div class="badge"><span class="dot completed"></span>Model #${m.id}</div>
            <strong>${name}</strong>
            <span class="muted">${cfgSummary}</span>
          </div>
          <div style="display:flex; gap:8px">
            <button class="btn applyModelBtn" data-id="${m.id}">Apply to form</button>
          </div>
        </div>
        <div class="muted" style="margin-top:6px">Saved ${created}</div>
      </div>
    `;
  }).join('');

  $$('.applyModelBtn', els.modelsList).forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      const model = list.find(x => x.id === id);
      if (model && model.config) applyModelToForm(model.config, model.name);
    });
  });
}

function applyModelToForm(cfg, name) {
  if (els.arch && cfg.architecture != null) els.arch.value = String(cfg.architecture);
  if (els.epochs) els.epochs.value = Number(cfg.epochs ?? 5);
  if (els.lr) els.lr.value = Number(cfg.learningRate ?? 0.001);
  if (els.batch) els.batch.value = Number(cfg.batchSize ?? 32);
  if (els.split) els.split.value = Number(cfg.split ?? 0.8);
  if (els.seed) els.seed.value = Number(cfg.seed ?? 42);
  if (els.saveModel) els.saveModel.checked = true;
  if (els.modelName) { els.modelName.disabled = false; els.modelName.value = name || ''; }
}

// ---------- Training / Models ----------
function bindModelToggles() {
  if (!els.saveModel || !els.modelName) return;
  const sync = () => {
    const on = !!els.saveModel.checked;
    els.modelName.disabled = !on;
    if (!on) els.modelName.value = '';
  };
  els.saveModel.addEventListener('change', sync);
  sync();
}

async function startTraining() {
  if (!els.trainBtn) return;
  els.trainBtn.disabled = true;

  try {
    const config = {
      architecture: els.arch?.value || 'mlp',
      epochs: Number(els.epochs?.value || 5),
      learningRate: Number(els.lr?.value || 0.001),
      batchSize: Number(els.batch?.value || 32),
      split: Number(els.split?.value || 0.8),
      seed: Number(els.seed?.value || 42)
    };

    let modelId = null;
    if (els.saveModel?.checked) {
      const name = (els.modelName?.value || '').trim();
      if (!name) {
        alert('Enter a model name or uncheck "Save as model".');
        return;
      }
      const model = await postJSON(`/api/projects/${projectId}/models`, { name, config });
      modelId = model?.id ?? null;
      await loadModels();
    }

    const job = await postJSON(`/api/projects/${projectId}/jobs`, {
      type: 'train',
      modelId,
      config
    });

    // Prefer follow the newly created job
    state.activeJobId = job.id;
    els.activeJobTitle && (els.activeJobTitle.textContent = `Job #${job.id} • ${job.type}`);

    await loadJobs(); // refresh list
  } catch (err) {
    console.error('[train] failed to start', err);
    alert('Failed to start training');
  } finally {
    els.trainBtn.disabled = false;
  }
}

// ---------- Jobs ----------
function statusDot(status) {
  const cls = {
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    queued: 'queued'
  }[status] || 'queued';
  return `<span class="dot ${cls}"></span>`;
}

function renderJobs(list) {
  if (!els.jobsList) return;

  if (!list.length) {
    els.jobsList.innerHTML = `<div class="muted">No jobs yet</div>`;
    return;
  }

  els.jobsList.innerHTML = list.map(j => {
    const s = escapeHtml(j.status);
    const viewDisabled = !j.metrics || !j.metrics.length ? 'disabled' : '';
    const isActive = j.id === state.activeJobId;
    return `
      <div class="card" style="padding:10px">
        <div style="display:flex; gap:10px; align-items:center; justify-content:space-between">
          <div style="display:flex; gap:10px; align-items:center">
            <div class="badge">${statusDot(j.status)} Job #${j.id} • ${escapeHtml(j.type)}</div>
            <div class="muted">${toRelativeTime(j.created_at)}</div>
          </div>
          <div style="display:flex; gap:8px">
            <button class="btn ${isActive ? 'btn-success' : ''} viewBtn" data-id="${j.id}" ${viewDisabled}>${isActive ? 'Viewing' : 'View'}</button>
            <button class="btn btn-danger cancelBtn" data-id="${j.id}" ${j.status !== 'running' ? 'disabled' : ''}>Cancel</button>
          </div>
        </div>
        <div class="progress" style="margin-top:8px" aria-label="progress">
          <div class="bar" style="width:${j.progress}%;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:6px">
          <div class="muted">Status: ${s}</div>
          <div class="muted">${j.progress}%</div>
        </div>
      </div>
    `;
  }).join('');

  // Bind buttons
  $$('.cancelBtn', els.jobsList).forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-id'));
      try {
        await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
        await loadJobs();
      } catch (err) {
        console.error('[jobs] cancel failed', err);
      }
    });
  });
  $$('.viewBtn', els.jobsList).forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-id'));
      state.activeJobId = id;
      els.activeJobTitle && (els.activeJobTitle.textContent = `Job #${id} • metrics`);
      await refreshActiveJobMetrics(); // draw now
      await loadJobs(); // refresh highlighting
    });
  });
}

async function loadJobs() {
  try {
    const list = await getJSON(`/api/projects/${projectId}/jobs`);
    // Keep metrics parsed
    const normalized = list.map(j => ({ ...j, metrics: j.metrics || [] }));
    // Choose active job if none
    if (state.activeJobId == null) {
      const running = normalized.find(j => j.status === 'running');
      state.activeJobId = running?.id ?? (normalized[0]?.id ?? null);
      if (state.activeJobId && els.activeJobTitle) {
        const aj = normalized.find(j => j.id === state.activeJobId);
        els.activeJobTitle.textContent = aj ? `Job #${aj.id} • ${aj.type}` : 'No job selected';
      }
    }
    // Populate initial cache for quick render
    normalized.forEach(j => {
      if (j.metrics && j.metrics.length) state.metricsCache.set(j.id, j.metrics);
    });
    renderJobs(normalized);
  } catch (err) {
    console.error('[jobs] failed to load', err);
    if (els.jobsList) {
      els.jobsList.innerHTML =
        `<div class="muted" style="color:#fecaca">Failed to load jobs</div>`;
    }
  }
}

async function refreshActiveJobMetrics() {
  const id = state.activeJobId;
  if (!id) {
    drawLoss([]);
    drawAcc([]);
    return;
  }
  try {
    const job = await getJSON(`/api/jobs/${id}`);
    const metrics = job.metrics || [];
    state.metricsCache.set(id, metrics);
    drawLoss(metrics);
    drawAcc(metrics);
  } catch (err) {
    // Fall back to cached metrics if available
    const cached = state.metricsCache.get(id) || [];
    drawLoss(cached);
    drawAcc(cached);
  }
}

// ---------- Canvas charts ----------
function setupCanvasSize(canvas) {
  if (!canvas) return { ctx: null, w: 0, h: 0, pr: 1 };
  const pr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  canvas.width = w * pr;
  canvas.height = h * pr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pr, 0, 0, pr, 0, 0);
  return { ctx, w, h, pr };
}

function drawAxes(ctx, w, h, { margin, yTicks, yMin, yMax, colorGrid = '#1f2937', colorText = '#94a3b8' }) {
  ctx.save();
  ctx.strokeStyle = colorGrid;
  ctx.lineWidth = 1;
  // Grid horizontal
  const innerH = h - margin.top - margin.bottom;
  for (let i = 0; i <= yTicks; i++) {
    const y = margin.top + (innerH * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(w - margin.right, y);
    ctx.stroke();
  }
  // Y labels
  ctx.fillStyle = colorText;
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const t = i / yTicks;
    const y = margin.top + (innerH * i) / yTicks;
    const v = yMax - t * (yMax - yMin);
    ctx.fillText(v.toFixed(2), margin.left - 6, y);
  }
  ctx.restore();
}

function drawSeries(ctx, w, h, data, xAccessor, yAccessor, opts) {
  const margin = opts.margin;
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;
  const color = opts.color || '#60a5fa';
  const yMin = opts.yMin ?? 0;
  const yMax = opts.yMax ?? 1;

  if (!data.length) return;

  const x0 = Math.min(...data.map(xAccessor));
  const x1 = Math.max(...data.map(xAccessor));
  const xSpan = Math.max(1, x1 - x0);

  ctx.save();
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;

  data.forEach((d, i) => {
    const xv = xAccessor(d);
    const yv = yAccessor(d);
    const px = margin.left + ((xv - x0) / xSpan) * innerW;
    const py = margin.top + (1 - (yv - yMin) / (yMax - yMin || 1)) * innerH;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}

function niceRange(min, max) {
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: Math.max(0, min - 1), max: min + 1 };
  const span = max - min;
  const pow = Math.pow(10, Math.floor(Math.log10(span)));
  const niceStep = pow;
  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;
  return { min: niceMin, max: niceMax };
}

function drawLoss(metrics) {
  const { ctx, w, h } = setupCanvasSize(els.lossCanvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const margin = { top: 8, right: 12, bottom: 16, left: 42 };
  const losses = metrics.map(m => m.loss).filter(v => Number.isFinite(v));
  const min = losses.length ? Math.min(...losses) : 0;
  const max = losses.length ? Math.max(...losses) : 1;
  const { min: yMin, max: yMax } = niceRange(min, max);

  drawAxes(ctx, w, h, { margin, yTicks: 4, yMin, yMax });
  drawSeries(ctx, w, h, metrics, d => d.step, d => d.loss, { margin, yMin, yMax, color: '#60a5fa' });

  // Title
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText('Loss', 8, 14);
}

function drawAcc(metrics) {
  const { ctx, w, h } = setupCanvasSize(els.accCanvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const margin = { top: 8, right: 12, bottom: 16, left: 42 };
  const yMin = 0;
  const yMax = 1;

  drawAxes(ctx, w, h, { margin, yTicks: 4, yMin, yMax });
  drawSeries(ctx, w, h, metrics, d => d.step, d => d.accuracy, { margin, yMin, yMax, color: '#22c55e' });

  // Title
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText('Accuracy', 8, 14);
}

// ---------- Event bindings ----------
function bindEvents() {
  // File preview
  if (els.datasetInput) {
    els.datasetInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      handleFilePreview(file);
    });
  }

  // Upload form submit
  if (els.uploadForm) {
    els.uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!projectId) return;
      const file = els.datasetInput?.files && els.datasetInput.files[0];
      if (!file) {
        alert('Select a file to upload');
        return;
      }
      try {
        els.uploadBtn && (els.uploadBtn.disabled = true);
        const fd = new FormData(els.uploadForm);
        const res = await fetch(`/api/projects/${projectId}/datasets`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error(`Upload failed ${res.status}`);
        // Reset
        els.uploadForm.reset();
        if (els.previewWrap) els.previewWrap.style.display = 'none';
        await loadDatasets();
      } catch (err) {
        console.error('[dataset] upload failed', err);
        alert('Upload failed');
      } finally {
        els.uploadBtn && (els.uploadBtn.disabled = false);
      }
    });
  }

  // Train button
  if (els.trainBtn) {
    els.trainBtn.addEventListener('click', startTraining);
  }

  // Model toggles
  bindModelToggles();

  // Resize charts on window resize
  window.addEventListener('resize', () => {
    const metrics = state.metricsCache.get(state.activeJobId) || [];
    drawLoss(metrics);
    drawAcc(metrics);
  });
}

// ---------- Polling ----------
function startPolling() {
  stopPolling();
  state.pollers.jobs = setInterval(loadJobs, 1500);
  state.pollers.metrics = setInterval(refreshActiveJobMetrics, 800);
}
function stopPolling() {
  if (state.pollers.jobs) clearInterval(state.pollers.jobs);
  if (state.pollers.metrics) clearInterval(state.pollers.metrics);
  state.pollers.jobs = null;
  state.pollers.metrics = null;
}

// ---------- Boot ----------
async function boot() {
  if (!projectId) {
    alert('Missing project id');
    return;
  }
  bindEvents();
  await loadProject();
  await loadDatasets();
  await loadModels();
  await loadJobs();
  await refreshActiveJobMetrics();
  startPolling();
}
boot();