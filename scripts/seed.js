import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const DB_PATH = path.join(DATA_DIR, 'app.db');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function createTables(db) {
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
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT DEFAULT '[]',
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
}

function makeSampleCSV(n = 100) {
  const lines = ['customer_id,tenure,monthly_charges,total_charges,churn'];
  let totalCharges = 0;
  for (let i = 0; i < n; i++) {
    const tenure = Math.floor(Math.random() * 72); // months
    const monthly = Number((20 + Math.random() * 100).toFixed(2));
    totalCharges = Number((tenure * monthly).toFixed(2));
    const churn = Math.random() < 0.25 ? 1 : 0;
    lines.push(`${i + 1},${tenure},${monthly},${totalCharges},${churn}`);
  }
  return lines.join('\n') + '\n';
}

function countRowsInCSV(csvText) {
  const nl = (csvText.match(/\n/g) || []).length;
  return Math.max(nl - 1, 0);
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(UPLOADS_DIR);

  const db = openDb();
  createTables(db);

  const projectName = 'Sample Churn Project';
  const projectDesc = 'Demo project created by seed script';
  let project = db.prepare('SELECT * FROM projects WHERE name = ?').get(projectName);
  if (!project) {
    const info = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(projectName, projectDesc);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  }

  const csv = makeSampleCSV(200);
  const filename = `${Date.now()}_sample_churn.csv`;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, csv);
  const sizeBytes = fs.statSync(filePath).size;
  const rows = countRowsInCSV(csv);

  const datasetName = 'sample_churn.csv';
  const infoDs = db.prepare('INSERT INTO datasets (project_id, name, filename, size_bytes, rows) VALUES (?,?,?,?,?)')
    .run(project.id, datasetName, filename, sizeBytes, rows);
  const dataset = db.prepare('SELECT * FROM datasets WHERE id = ?').get(infoDs.lastInsertRowid);

  const modelConfig = {
    architecture: 'mlp',
    epochs: 5,
    learningRate: 0.001,
    batchSize: 32,
    split: 0.8,
    seed: 42
  };
  const modelName = 'Baseline MLP';
  const infoModel = db.prepare('INSERT INTO models (project_id, name, config_json) VALUES (?,?,?)')
    .run(project.id, modelName, JSON.stringify(modelConfig));
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(infoModel.lastInsertRowid);

  console.log('Seed complete.');
  console.log(`Project: #${project.id} ${project.name}`);
  console.log(`Dataset: #${dataset.id} ${dataset.name} (${dataset.rows} rows, ${dataset.size_bytes} bytes)`);
  console.log(`Model:   #${model.id} ${model.name}`);
  console.log('');
  console.log(`Open: http://localhost:3000/project.html?id=${project.id}`);

  db.close();
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});