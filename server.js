import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App constants
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure directories exist
for (const dir of [DATA_DIR, UPLOADS_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Initialize DB
const dbPath = path.join(DATA_DIR, 'app.db');
const db = new Database(dbPath);

// Pragmas for better behavior
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  rows INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  model_id INTEGER,
  type TEXT NOT NULL, -- e.g., "train"
  status TEXT NOT NULL, -- queued | running | completed | failed | canceled
  progress INTEGER NOT NULL DEFAULT 0, -- 0..100
  metrics_json TEXT DEFAULT '[]', -- JSON array of { step, loss, accuracy }
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
);

CREATE TRIGGER IF NOT EXISTS trg_jobs_updated_at
AFTER UPDATE ON jobs
BEGIN
  UPDATE jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
`);

// Express app
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(PUBLIC_DIR));

// Multer storage for uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    // Prefix filename with timestamp to avoid collisions
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({ storage });

// In-memory job timers to simulate long-running training
const jobTimers = new Map(); // jobId -> { intervalId, startTime }

// Helpers
function toJson(value) {
  return JSON.stringify(value);
}
function fromJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Routes: Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Routes: Projects
app.get('/api/projects', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      p.*,
      (SELECT COUNT(*) FROM datasets d WHERE d.project_id = p.id) AS dataset_count,
      (SELECT COUNT(*) FROM models m WHERE m.project_id = p.id) AS model_count
    FROM projects p
    ORDER BY p.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/projects', (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  const stmt = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)');
  const info = stmt.run(name.trim(), String(description));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT
      p.*,
      (SELECT COUNT(*) FROM datasets d WHERE d.project_id = p.id) AS dataset_count,
      (SELECT COUNT(*) FROM models m WHERE m.project_id = p.id) AS model_count
    FROM projects p
    WHERE p.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json(row);
});

// Routes: Datasets
app.get('/api/projects/:id/datasets', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM datasets WHERE project_id = ? ORDER BY created_at DESC').all(id);
  res.json(rows);
});

app.post('/api/projects/:id/datasets', upload.single('file'), (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    if (req.file) {
      // cleanup uploaded file
      fs.unlink(req.file.path, () => {});
    }
    return res.status(404).json({ error: 'Project not found' });
  }

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file field is required' });

  const { originalname, filename, size, path: filePath } = file;
  // Optional: attempt to estimate row count for CSV by counting line breaks (up to a cap)
  let rowsCount = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    const bufferSize = 1024 * 1024; // 1MB chunk
    const buffer = Buffer.alloc(bufferSize);
    let bytesRead = 0;
    let totalNewlines = 0;
    let totalRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, bufferSize, totalRead)) > 0 && totalRead < 10 * 1024 * 1024) {
      totalRead += bytesRead;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0x0A) totalNewlines++;
      }
      if (totalRead >= 10 * 1024 * 1024) break; // cap at 10MB scan
    }
    fs.closeSync(fd);
    // rough estimate: header + rows => rows ~ newlines - 1 (min 0)
    rowsCount = Math.max(totalNewlines - 1, 0);
  } catch {
    rowsCount = null;
  }

  const stmt = db.prepare(`
    INSERT INTO datasets (project_id, name, filename, size_bytes, rows)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(projectId, originalname, filename, size, rowsCount);
  const dataset = db.prepare('SELECT * FROM datasets WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(dataset);
});

// Routes: Models
app.get('/api/projects/:id/models', (req, res) => {
  const projectId = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM models WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  // parse config for convenience
  const parsed = rows.map(r => ({ ...r, config: fromJson(r.config_json, {}) }));
  res.json(parsed);
});

app.post('/api/projects/:id/models', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { name, config = {} } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  const stmt = db.prepare('INSERT INTO models (project_id, name, config_json) VALUES (?,?,?)');
  const info = stmt.run(projectId, name.trim(), toJson(config));
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...model, config });
});

// Routes: Jobs
app.get('/api/projects/:id/jobs', (req, res) => {
  const projectId = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  const parsed = rows.map(r => ({ ...r, metrics: fromJson(r.metrics_json, []) }));
  res.json(parsed);
});

app.post('/api/projects/:id/jobs', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { type = 'train', modelId = null, config = {} } = req.body || {};
  // create job in queued state
  const stmt = db.prepare(`
    INSERT INTO jobs (project_id, model_id, type, status, progress, metrics_json)
    VALUES (?, ?, ?, 'queued', 0, '[]')
  `);
  const info = stmt.run(projectId, modelId, type);
  const jobId = info.lastInsertRowid;

  // Kick off simulation async
  runTrainingSimulation(jobId, config).catch(err => {
    // Fallback in case simulation throws before status update
    db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('failed', String(err?.message || err), jobId);
  });

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  res.status(201).json({ ...job, metrics: [] });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const jobId = Number(req.params.jobId);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ...job, metrics: fromJson(job.metrics_json, []) });
});

app.post('/api/jobs/:jobId/cancel', (req, res) => {
  const jobId = Number(req.params.jobId);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // stop timer if running
  const timer = jobTimers.get(jobId);
  if (timer) {
    clearInterval(timer.intervalId);
    jobTimers.delete(jobId);
  }
  db.prepare('UPDATE jobs SET status = ?, progress = ? WHERE id = ?').run('canceled', job.progress, jobId);
  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  res.json({ ...updated, metrics: fromJson(updated.metrics_json, []) });
});

// Training simulation
async function runTrainingSimulation(jobId, config) {
  // Update to running
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', jobId);

  // Simulate N steps based on epochs * batches or fallback
  const epochs = Number(config?.epochs ?? 5);
  const stepsPerEpoch = Number(config?.stepsPerEpoch ?? 20);
  const totalSteps = Math.max(epochs * stepsPerEpoch, 20);

  let step = 0;
  let metrics = [];

  const intervalMs = 500; // 0.5s per step
  const startTime = Date.now();
  const intervalId = setInterval(() => {
    step++;
    // Fake metrics: loss decays, accuracy increases with noise
    const progress = Math.min(Math.round((step / totalSteps) * 100), 100);
    const t = step / totalSteps;
    const loss = Number((1.5 * Math.exp(-3 * t) + 0.05 * Math.random()).toFixed(4));
    const accuracy = Number((0.5 + 0.5 * t + 0.05 * (Math.random() - 0.5)).toFixed(4));
    metrics.push({ step, loss, accuracy, timeMs: Date.now() - startTime });

    // Persist every few steps to reduce write pressure
    if (step % 2 === 0 || progress === 100) {
      db.prepare('UPDATE jobs SET progress = ?, metrics_json = ? WHERE id = ?')
        .run(progress, toJson(metrics), jobId);
    }

    if (step >= totalSteps) {
      clearInterval(intervalId);
      jobTimers.delete(jobId);
      db.prepare('UPDATE jobs SET status = ?, progress = ?, metrics_json = ? WHERE id = ?')
        .run('completed', 100, toJson(metrics), jobId);
    }
  }, intervalMs);

  jobTimers.set(jobId, { intervalId, startTime });
}

// Minimal landing page if public files not created yet
app.get('/', (req, res, next) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>AI Model Builder</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; color: #0f172a; }
    .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.5rem; max-width: 720px; }
    .btn { display: inline-block; background: #0ea5e9; color: white; padding: 0.6rem 1rem; border-radius: 8px; text-decoration: none; }
    .btn:hover { background: #0284c7; }
    input, textarea { width: 100%; padding: 0.6rem; border: 1px solid #cbd5e1; border-radius: 8px; }
    label { font-weight: 600; margin-top: 0.5rem; display: block; }
    .row { display: flex; gap: 0.75rem; }
    .row > * { flex: 1; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AI Model Builder</h1>
    <p>Create a project to get started.</p>
    <div class="row">
      <input id="projName" placeholder="Project name"/>
      <input id="projDesc" placeholder="Description (optional)"/>
      <button class="btn" id="createBtn">Create</button>
    </div>
    <div id="projects" style="margin-top: 1rem;"></div>
  </div>
  <script>
    async function load() {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      const el = document.getElementById('projects');
      el.innerHTML = projects.map(p => '<div style="margin:.5rem 0"><a href="/project.html?id='+p.id+'">#'+p.id+' - '+p.name+'</a></div>').join('');
    }
    document.getElementById('createBtn').onclick = async () => {
      const name = document.getElementById('projName').value.trim();
      const description = document.getElementById('projDesc').value.trim();
      if (!name) return alert('Enter a project name');
      const res = await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, description })});
      if (!res.ok) return alert('Failed to create');
      await load();
    };
    load();
  </script>
</body>
</html>`);
});

// Fallback project page (will be replaced by real file)
app.get('/project.html', (req, res) => {
  const projectHtml = path.join(PUBLIC_DIR, 'project.html');
  if (fs.existsSync(projectHtml)) return res.sendFile(projectHtml);
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Project</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; color: #0f172a; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 1rem; }
    .btn { background: #22c55e; color: white; padding: 0.5rem 0.8rem; border-radius: 8px; border: none; }
    .btn:hover { background: #16a34a; }
    input, select { width: 100%; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 8px; }
  </style>
</head>
<body>
  <a href="/" style="text-decoration:none">&larr; Back</a>
  <h1 id="title">Project</h1>
  <div class="grid">
    <div class="card">
      <h2>Datasets</h2>
      <form id="uploadForm">
        <input type="file" name="file" accept=".csv,.tsv,.json"/>
        <button class="btn" type="submit">Upload</button>
      </form>
      <div id="datasets"></div>
    </div>
    <div class="card">
      <h2>Train Model</h2>
      <div>
        <label>Architecture</label>
        <select id="arch">
          <option value="linear">Linear</option>
          <option value="mlp">MLP</option>
          <option value="cnn">CNN</option>
        </select>
      </div>
      <div style="display:flex; gap:.5rem; margin-top:.5rem">
        <div><label>Epochs</label><input id="epochs" type="number" value="5" min="1"/></div>
        <div><label>LR</label><input id="lr" type="number" step="0.0001" value="0.001"/></div>
        <div><label>Batch</label><input id="batch" type="number" value="32" min="1"/></div>
      </div>
      <button class="btn" id="trainBtn" style="margin-top:.75rem">Start Training</button>
    </div>
  </div>
  <div class="card" style="margin-top:1rem">
    <h2>Jobs</h2>
    <div id="jobs"></div>
  </div>
<script>
  const params = new URLSearchParams(location.search);
  const projectId = params.get('id');

  async function loadProject() {
    const p = await fetch('/api/projects/'+projectId).then(r=>r.json());
    document.getElementById('title').textContent = 'Project #'+p.id+' - '+p.name;
  }
  async function loadDatasets() {
    const ds = await fetch('/api/projects/'+projectId+'/datasets').then(r=>r.json());
    const el = document.getElementById('datasets');
    el.innerHTML = ds.map(d => '<div style="margin:.25rem 0">#'+d.id+' '+d.name+' ('+d.size_bytes+' bytes'+(d.rows!=null? ', '+d.rows+' rows':'' )+')</div>').join('') || '<div>No datasets yet</div>';
  }
  async function loadJobs() {
    const jobs = await fetch('/api/projects/'+projectId+'/jobs').then(r=>r.json());
    const el = document.getElementById('jobs');
    el.innerHTML = jobs.map(j => {
      const status = j.status + ' ' + j.progress + '%';
      return '<div style="display:flex; align-items:center; gap:.5rem; margin:.25rem 0">'+
        '<div style="width:180px">#'+j.id+' - '+j.type+'</div>'+
        '<div style="flex:1; background:#e2e8f0; border-radius:8px; overflow:hidden; height:10px; position:relative">'+
          '<div style="position:absolute; left:0; top:0; bottom:0; width:'+j.progress+'%; background:#0ea5e9"></div>'+
        '</div>'+
        '<div style="width:120px; text-align:right">'+status+'</div>'+
        '<button data-id="'+j.id+'" class="cancelBtn" '+(j.status!=='running'?'disabled':'')+'>Cancel</button>'+
      '</div>'
    }).join('') || '<div>No jobs yet</div>';
    document.querySelectorAll('.cancelBtn').forEach(btn=>{
      btn.onclick = async () => {
        const id = btn.getAttribute('data-id');
        await fetch('/api/jobs/'+id+'/cancel', { method:'POST' });
        await loadJobs();
      };
    });
  }

  document.getElementById('uploadForm').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const res = await fetch('/api/projects/'+projectId+'/datasets', { method:'POST', body: fd });
    if(!res.ok){ alert('Upload failed'); return; }
    form.reset();
    await loadDatasets();
  };

  document.getElementById('trainBtn').onclick = async () => {
    const config = {
      architecture: document.getElementById('arch').value,
      epochs: Number(document.getElementById('epochs').value),
      learningRate: Number(document.getElementById('lr').value),
      batchSize: Number(document.getElementById('batch').value)
    };
    const res = await fetch('/api/projects/'+projectId+'/jobs', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type: 'train', config })
    });
    if(!res.ok){ alert('Failed to start job'); return; }
    await loadJobs();
  };

  // polling
  setInterval(loadJobs, 1500);

  loadProject();
  loadDatasets();
  loadJobs();
</script>
</body>
</html>`);
});

// Start server
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});