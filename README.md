# AI Model Builder (MVP)

A lightweight web app inspired by theclueless.ai to create projects, upload datasets, configure models, and launch simulated training runs with live metrics and persistence.

- Backend: Express + SQLite (via better-sqlite3)
- Frontend: Vanilla HTML/CSS/JS (served by Express)
- Training: Simulated job runner emitting loss/accuracy over time


## Repository Layout

- [`package.json`](package.json) — scripts and dependencies
- [`server.js`](server.js) — Express server, SQLite schema, REST API, training simulator
- Public frontend (served by Express):
  - [`public/index.html`](public/index.html)
  - [`public/project.html`](public/project.html)
  - [`public/css/styles.css`](public/css/styles.css)
  - [`public/js/app.js`](public/js/app.js)
  - [`public/js/project.js`](public/js/project.js)
- Data & uploads (auto-created at runtime):
  - `./data/app.db` — SQLite database
  - `./uploads/` — dataset files
- Scripts:
  - [`scripts/seed.js`](scripts/seed.js) — optional local seed data generator (creates a sample project and CSV)


## Quick Start

1) Install dependencies
- Node 18+ recommended
- From the repo root:
  - `npm install`

2) Run the server
- `npm start`
- Server listens on http://localhost:3000

3) Open the app
- Visit http://localhost:3000
- Create a project, upload a dataset, configure a model, and start a training job

## Smoke Test (Verification Checklist)

- Start the server
  - npm start
  - Server listens at http://localhost:3000 (implemented in [server.listen()](server.js:503))
- Visit the app
  - Open http://localhost:3000 to see the project grid rendered by [index.html](public/index.html:1) with data fetched by [loadProjects()](public/js/app.js:101)
- Create a project
  - Click “New Project”, enter a name/description, and create. It should appear with Models/Datasets counts (wired in [GET /api/projects](server.js:127) and displayed in [projectCardHtml()](public/js/app.js:75))
- Upload a dataset
  - Open a project and upload a CSV/TSV/JSON via the Datasets card (handled by [uploadForm submit](public/js/project.js:534); persisted by [POST /api/projects/:id/datasets](server.js:157))
  - A preview of the first rows should render before upload, then the dataset appears in “Existing datasets”
- Configure and start training
  - Set hyperparameters (arch, epochs, lr, batch, split, seed) and click “Start Training”
  - A new job appears with a progress bar; status and progress update periodically (simulated in [runTrainingSimulation()](server.js:284))
- View live metrics
  - Loss and Accuracy charts update for the active job (canvas rendering in [drawLoss()](public/js/project.js:485) and [drawAcc()](public/js/project.js:506))
- Save and reuse model configs
  - Check “Save as model” and provide a name. The saved model appears under “Saved Models”
  - Click “Apply to form” to load that config back into the training form ([renderModels()](public/js/project.js:240) and [applyModelToForm()](public/js/project.js:270))
- Cancel a running job
  - Click “Cancel” on a running job; it should move to canceled state ([POST /api/jobs/:jobId/cancel](server.js:267))

API spot-check (optional)
- Health: curl http://localhost:3000/api/health (route defined in [app.get('/api/health')](server.js:121))
- Projects: curl http://localhost:3000/api/projects
- Models: curl http://localhost:3000/api/projects/1/models
- Jobs: curl http://localhost:3000/api/projects/1/jobs

Troubleshooting
- Port conflicts: if 3000 is in use, set PORT=3001 (or another port) when starting, e.g. PORT=3001 npm start
- Seed data: npm run seed (creates a sample project, dataset, and model; see [scripts/seed.js](scripts/seed.js:1))
- DB/files: SQLite at ./data/app.db; uploads in ./uploads/ (created by [server.js](server.js:12) on boot)

## Development

- `npm run dev` — start server with nodemon for auto-reload
- `npm start` — start server normally

Key files to explore:
- Backend API and job runner: [`server.js`](server.js)
- Landing page + project list UI: [`public/index.html`](public/index.html), [`public/js/app.js`](public/js/app.js)
- Project workspace (datasets, training, charts): [`public/project.html`](public/project.html), [`public/js/project.js`](public/js/project.js)
- Styling: [`public/css/styles.css`](public/css/styles.css)


## Features

- Projects
  - Create and list projects
  - Home shows aggregate counts (datasets, models)
- Datasets
  - Upload CSV/TSV/JSON files
  - Client-side preview (first chunk)
  - Persisted file with size and rough row estimate
- Models
  - Save model configs (architecture, epochs, lr, batch, split, seed)
  - Project page lists "Saved Models" with "Apply to form"
- Jobs
  - Launch simulated training run
  - Live polling for status and metrics (loss/accuracy)
  - Canvas-based charts (no external chart lib)
  - Cancel running jobs


## API Overview

Base: `http://localhost:3000/api`

Projects
- GET `/projects` — list projects (includes dataset_count, model_count)
- POST `/projects` — create project
  - body: `{ "name": "My Project", "description": "optional" }`
- GET `/projects/:id` — get project

Datasets
- GET `/projects/:id/datasets` — list datasets for a project
- POST `/projects/:id/datasets` — upload dataset (multipart/form-data)
  - field: `file` (accepts `.csv`, `.tsv`, `.json`)

Models
- GET `/projects/:id/models` — list models for a project
- POST `/projects/:id/models` — create/save a model config
  - body: `{ "name": "Model A", "config": { ... } }`

Jobs
- GET `/projects/:id/jobs` — list jobs for a project (metrics embedded)
- POST `/projects/:id/jobs` — create new job (e.g., train)
  - body: `{ "type": "train", "modelId": 1|null, "config": { ... } }`
- GET `/jobs/:jobId` — get job status + metrics
- POST `/jobs/:jobId/cancel` — cancel a job

Health
- GET `/api/health` — `{ ok: true, timestamp }`


## Data & Persistence

- SQLite DB at `./data/app.db` (auto-created)
- File uploads stored under `./uploads`
- Tables: `projects`, `datasets`, `models`, `jobs` with triggers for `updated_at`


## Seeding (optional)

Use the seed script to quickly create a sample project and a demo CSV.

- Run:
  - `npm run seed`

The script will:
- Create `./data/app.db` if not present
- Ensure tables exist (server will create them on first run)
- Create a sample project like "Sample Churn Project"
- Generate a small CSV under `./uploads/` and register it as a dataset


## How The Training Simulation Works

Inside [`server.js`](server.js), when you create a train job:
- A job row is inserted with `status = "queued"`
- The simulation starts and moves to `status = "running"`
- Every ~500ms a new step is computed with:
  - Decaying loss
  - Increasing accuracy with noise
- Metrics persisted into `jobs.metrics_json`
- When steps are done, job is marked `completed` with `progress = 100`
- Cancel endpoint stops the interval and marks `canceled`


## Frontend Walkthrough

- Home page [`public/index.html`](public/index.html)
  - Create projects
  - Filter/search locally
  - Navigate to project detail
- Project page [`public/project.html`](public/project.html)
  - Upload dataset and preview the head (client-side)
  - Configure model hyperparameters and save model optionally
  - Start a training job and watch live progress and charts
  - Toggle active job to view its metrics


## Notes & Limitations

- Training is simulated; swap with your actual training backend later
- CSV preview is best-effort and reads only the first chunk of the file in the browser
- No authentication/session in this MVP
- Single-process job runner; suitable for a demo or local use


## License

MIT-like for demo purposes. Replace as needed.


## Credits

- Inspired by the product experience of theclueless.ai (referenced for UI/UX inspiration only)