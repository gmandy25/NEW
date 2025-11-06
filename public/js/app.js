'use strict';

(() => {
  // Dom helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    grid: $('#projectsGrid'),
    search: $('#searchInput'),
    dialog: $('#createDialog'),
    openCreate: $('#openCreate'),
    closeCreate: $('#closeCreate'),
    createBtn: $('#createBtn'),
    name: $('#projName'),
    desc: $('#projDesc')
  };

  const state = {
    projects: [],
    filtered: []
  };

  // Utilities
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

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&').replace(/</g, '<')
      .replace(/>/g, '>').replace(/"/g, '"')
      .replace(/'/g, '&#39;');
  }

  function matchesQuery(p, q) {
    if (!q) return true;
    const t = q.toLowerCase();
    return (p.name?.toLowerCase().includes(t) || p.description?.toLowerCase().includes(t) || String(p.id).includes(t));
  }

  function renderProjects() {
    const items = state.filtered;
    if (!els.grid) return;
    if (!items.length) {
      els.grid.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align:center; padding:30px">
          <h2>No projects yet</h2>
          <p class="muted" style="margin:8px 0 16px">Create your first project to start uploading datasets and running training jobs.</p>
          <button class="btn btn-primary" id="ctaCreate">Create Project</button>
        </div>
      `;
      const cta = $('#ctaCreate');
      if (cta) cta.onclick = () => els.dialog?.showModal();
      return;
    }

    els.grid.innerHTML = items.map(p => projectCardHtml(p)).join('');
  }

  function projectCardHtml(p) {
    const name = escapeHtml(p.name);
    const desc = escapeHtml(p.description || '—');
    const created = toRelativeTime(p.created_at);
    const models = Number.isFinite(p?.model_count) ? p.model_count : '—';
    const datasets = Number.isFinite(p?.dataset_count) ? p.dataset_count : '—';
    return `
      <article class="card" aria-label="Project ${name}">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
          <h3 style="margin:0">${name}</h3>
          <span class="badge" title="Created ${p.created_at}">
            <span class="dot completed"></span>
            ${created}
          </span>
        </div>
        <p class="muted" style="margin:8px 0 14px">${desc}</p>
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
          <div style="display:flex; gap:8px; align-items:center">
            <span class="chip">#${p.id}</span>
            <span class="chip">Models: ${models}</span>
            <span class="chip">Datasets: ${datasets}</span>
          </div>
          <a class="btn btn-primary" href="/project.html?id=${encodeURIComponent(p.id)}" aria-label="Open project ${name}">Open</a>
        </div>
      </article>
    `;
  }

  async function loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.projects = data;
      applyFilter(els.search?.value || '');
    } catch (err) {
      console.error('[app] failed to load projects', err);
      if (els.grid) {
        els.grid.innerHTML = `
          <div class="card" style="grid-column: 1 / -1; color:#fecaca; border-color: rgba(239,68,68,.5)">
            <h3 style="color:#fecaca; margin:0 0 6px 0">Failed to load projects</h3>
            <div class="muted">Check the server is running (npm start). See console for details.</div>
          </div>
        `;
      }
    }
  }

  function applyFilter(q) {
    const query = (q || '').trim();
    state.filtered = state.projects.filter(p => matchesQuery(p, query));
    renderProjects();
  }

  async function createProject() {
    const name = (els.name?.value || '').trim();
    const description = (els.desc?.value || '').trim();
    if (!name) {
      alert('Please enter a project name');
      els.name?.focus();
      return;
    }
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Clear inputs, close dialog, reload
      if (els.dialog && typeof els.dialog.close === 'function') els.dialog.close();
      if (els.name) els.name.value = '';
      if (els.desc) els.desc.value = '';
      await loadProjects();
    } catch (err) {
      console.error('[app] failed to create project', err);
      alert('Failed to create project');
    }
  }

  function bindEvents() {
    // Search
    if (els.search) {
      els.search.addEventListener('input', (e) => {
        applyFilter(e.target.value);
      });
    }

    // Open/Close dialog
    if (els.openCreate && els.dialog?.showModal) {
      els.openCreate.addEventListener('click', () => els.dialog.showModal());
    }
    if (els.closeCreate && els.dialog?.close) {
      els.closeCreate.addEventListener('click', () => els.dialog.close());
    }

    // Create submit
    if (els.createBtn) {
      els.createBtn.addEventListener('click', createProject);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Focus search: Cmd/Ctrl + K
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        els.search?.focus();
      }
      // Close dialog with Escape
      if (e.key === 'Escape' && els.dialog?.open) {
        e.preventDefault();
        els.dialog.close();
      }
    });
  }

  // Boot
  bindEvents();
  loadProjects();
})();