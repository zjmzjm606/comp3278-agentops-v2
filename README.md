# AgentOps — Multi-AI Project Control

A database-driven web app for coordinating multiple AI agents on software-project tasks. The platform records projects, task dependencies, agent assignments, agent runs, artifacts and human reviews in MySQL.

This project is designed for the COMP3278 final project (Group 16): it is a real web app with a MySQL database, complete CRUD operations, an ER model, key SQL queries, seed data and a reproducible local demo.

## Quick start

With Node.js 20+ and MySQL 8+ installed and MySQL running:

```bash
npm install
cp .env.example .env          # Windows (cmd): copy .env.example .env
# edit .env: set DB_USER and DB_PASSWORD to your MySQL account
npm run db:setup              # creates database `agentops`, tables and demo data
npm start                     # then open http://localhost:3000
```

Sign in with `alice@example.com` / `password123`. No API key is needed: agents run in deterministic Mock mode by default.

Each step is explained below, including a manual alternative for the database setup and a query to check that the data loaded.

## What the app does

- Create and manage projects.
- Create, edit and delete tasks with required specialist roles and task dependencies.
- Register Mock or Live AI agents.
- Recommend the best available agent for a task.
- Detect likely duplicate tasks by text similarity (computed on demand, not stored).
- Generate a risk score for a task (computed on demand, not stored).
- Run the next eligible task through an agent. The agent receives the approved artifacts of the task's prerequisites as input, and the database records which ones it used.
- Store agent run status, latency, model name and raw output. Starting and finishing a run are transactional, so concurrent clicks cannot start the same task twice.
- Store generated artifacts and show their contents.
- Record human review/approval decisions. A task only reaches `DONE` by approving an agent's artifact; it cannot be set to `DONE` directly.
- Display an execution dashboard and run history.

## Tech stack

- Node.js + Express
- MySQL 8+
- Vanilla HTML/CSS/JavaScript
- `mysql2`
- `express-session`
- `bcryptjs`
- Deterministic Mock agents by default
- Optional OpenAI-compatible Live providers: OpenAI, DeepSeek, GLM

## Project structure

```text
.
├── database/
│   ├── schema.sql          # Tables, keys and indexes
│   └── seed.sql            # Demo users, project, tasks, agents and runs
├── docs/
│   ├── ER_DIAGRAM.md       # ER diagram (Chen notation) and relational schema
│   ├── er_diagram_chen.svg # Chen-notation ER diagram (vector)
│   ├── er_diagram_chen.png # Chen-notation ER diagram (image)
│   ├── KEY_QUERIES.sql     # Queries used in the presentation
│   └── RELATIONSHIPS_AND_TESTING.md  # Full relationship matrix and test plan
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── scripts/
│   └── setup-db.js
├── src/
│   ├── agent-runtime.js    # Mock and optional Live agent adapters
│   ├── db.js
│   └── orchestrator.js     # Recommendations, dependencies, runs, reviews
├── tests/
│   └── orchestrator.test.js
├── .env.example
├── package.json
└── server.js
```

## Prerequisites

- Node.js 20+
- npm
- MySQL 8+
- A MySQL account that can create databases

Check versions:

```bash
node --version
npm --version
mysql --version
```

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

On Windows (Command Prompt) use `copy .env.example .env`; in PowerShell use `Copy-Item .env.example .env`.

Edit `.env` for your local MySQL account. Only `DB_USER` and `DB_PASSWORD` normally need changing:

```env
PORT=3000
SESSION_SECRET=replace-with-a-long-random-string
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=agentops
AGENT_MODE=mock
```

Do not commit `.env`.

## Database setup

Start MySQL first:

```bash
brew services start mysql          # macOS (Homebrew)
sudo service mysql start           # Ubuntu / Debian
net start MySQL80                  # Windows (service name may differ)
```

Create the database, tables and demo data:

```bash
npm run db:setup
```

This command:

1. Creates the `agentops` database if it does not exist.
2. Drops and recreates the project tables.
3. Loads the demo users, project, agents, tasks, dependencies, runs, artifacts and reviews.

The main database definition is in `database/schema.sql`; the initial data is in `database/seed.sql`. Running `npm run db:setup` again resets the database to the demo data.

### Manual alternative

If you prefer the MySQL client, the same result is:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS agentops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -u root -p agentops < database/schema.sql
mysql -u root -p agentops < database/seed.sql
```

Use the same database name as `DB_NAME` in `.env`.

### Check the data

```sql
USE agentops;
SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'projects', COUNT(*) FROM projects
UNION ALL SELECT 'agents', COUNT(*) FROM agents
UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
UNION ALL SELECT 'task_dependencies', COUNT(*) FROM task_dependencies
UNION ALL SELECT 'task_assignments', COUNT(*) FROM task_assignments
UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs
UNION ALL SELECT 'artifacts', COUNT(*) FROM artifacts
UNION ALL SELECT 'reviews', COUNT(*) FROM reviews
UNION ALL SELECT 'run_inputs', COUNT(*) FROM run_inputs;
```

Expected counts after a fresh setup:

| Table | Rows |
|---|---|
| users | 2 |
| projects | 1 |
| agents | 4 |
| tasks | 6 |
| task_dependencies | 5 |
| task_assignments | 2 |
| agent_runs | 2 |
| artifacts | 2 |
| reviews | 2 |
| run_inputs | 1 |

### Common setup problems

- `ER_ACCESS_DENIED_ERROR`: `DB_USER` / `DB_PASSWORD` in `.env` do not match your MySQL account.
- `ECONNREFUSED`: MySQL is not running, or `DB_HOST` / `DB_PORT` are wrong.
- `EADDRINUSE`: port 3000 is taken; set another `PORT` in `.env`.
- Login fails: run `npm run db:setup` again to restore the demo accounts.

More cases are covered in `docs/RELATIONSHIPS_AND_TESTING.md`, section 10.

## Run the application

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Demo account:

```text
Email:    alice@example.com
Password: password123
```

A second seeded account is `bob@example.com` with the same demo password.

## Demo workflow

1. Sign in as Alice.
2. Open the seeded **AgentOps Demo Project**.
3. Open **Tasks**.
4. Create a task or run the next eligible task.
5. Click **Edit** on a task to change its title, priority or status (only `TODO`, `BLOCKED` and `CANCELLED` can be chosen directly).
6. Click **Recommend agent** to compute an assignee and risk recommendation (shown in the Recommendations card; not stored).
7. Click **Run agent** to execute the task through the selected specialist.
8. Open **Run history** and inspect the agent run, its **Inputs** (approved upstream artifacts it used) and the generated artifact.
9. Approve a task in `REVIEW` status to mark it `DONE`.
10. Confirm in MySQL that task status, runs, run inputs, artifacts and reviews changed.

The project is intentionally human-in-the-loop: after a non-reviewer task finishes, it enters `REVIEW`; a human must approve it before dependent tasks can run.

## Mock mode vs Live mode

### Mock mode — default and recommended for grading

Mock agents require no API key and return deterministic artifacts. This means a marker can reproduce the app and demo without network access or paid AI services.

### Live mode — optional

Register an agent in the UI with `execution_mode = LIVE` and provider `openai`, `deepseek` or `glm`. Then add the corresponding key to `.env`.

OpenAI:

```env
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

DeepSeek:

```env
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

Zhipu GLM:

```env
GLM_API_KEY=
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash
```

If a Live provider is selected without a key, the run fails clearly and the error is stored in `agent_runs`. The core Mock workflow remains independent of external services.

## Main database tables

| Table | Kind | Primary key | Purpose |
|---|---|---|---|
| `users` | Entity | `user_id` | Human users and reviewers |
| `projects` | Entity | `project_id` | Software project workspaces |
| `tasks` | Entity | `task_id` | Project tasks and current state |
| `agents` | Entity | `agent_id` | Planner, coder, tester and reviewer agents |
| `agent_runs` | Entity | `agent_run_id` | Execution history, latency, status and raw output |
| `artifacts` | Entity | `artifact_id` | Files or Markdown output produced by agents (the task is derived through `agent_runs`) |
| `reviews` | Entity | `review_id` | Human review decisions |
| `task_dependencies` | Relationship (recursive M:N on tasks) | `(task_id, depends_on_task_id)` | Which tasks must finish before another can run |
| `task_assignments` | Relationship (M:N tasks–agents) | `(task_id, agent_id, assignment_role)` | Agents assigned to tasks, with their role; at most one `PRIMARY` per task |
| `run_inputs` | Relationship (M:N agent_runs–artifacts) | `(agent_run_id, artifact_id)` | Approved upstream artifacts that a run used as input |

Every entity's primary key is prefixed with its table name, so foreign keys share the name of the key they reference (for example `tasks.project_id → projects.project_id`).

See `docs/ER_DIAGRAM.md` for the ER diagram, and `docs/RELATIONSHIPS_AND_TESTING.md` for the complete relationship matrix and end-to-end test procedure.

## API overview

### Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Projects and tasks

- `GET /api/projects`
- `POST /api/projects`
- `PATCH /api/projects/:projectId`
- `DELETE /api/projects/:projectId`
- `GET /api/projects/:projectId/tasks`
- `POST /api/projects/:projectId/tasks`
- `PATCH /api/tasks/:taskId`
- `DELETE /api/tasks/:taskId`
- `POST /api/projects/:projectId/run-next`

### Agents and orchestration

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:agentId`
- `DELETE /api/agents/:agentId`
- `POST /api/tasks/:taskId/recommend`
- `POST /api/tasks/:taskId/run`
- `POST /api/tasks/:taskId/approve`

### Activity

- `GET /api/projects/:projectId/dashboard`
- `GET /api/projects/:projectId/runs`
- `GET /api/projects/:projectId/artifacts`

Full request examples are not required to run the UI; the browser frontend uses these endpoints directly.

## Tests

```bash
npm test
```

The unit test checks the text similarity function used for duplicate-task detection. The main end-to-end check is the demo workflow above against the real MySQL database.

## Reproducibility checklist

- [x] Schema creation script
- [x] Seed data with a populated demo database
- [x] Mock mode without API keys
- [x] `.env.example`
- [x] Exact installation and run commands
- [x] Test account
- [x] Sample project and tasks
- [x] CRUD endpoints
- [x] Key SQL file for presentation
- [x] ER diagram source

## Limitations and next steps

- The session store is in-memory and is suitable for local demonstration only.
- Project access currently uses a single owner; production use would add project membership roles.
- Mock artifacts are deterministic examples, not full software implementations.
- Live provider responses depend on the provider, key, model and network.
- A production version should add automated integration tests, rate limiting, CSRF protection and a persistent session store.

## Course alignment

- **Submission materials / reproducibility (30%)**: source, schema, seed data, README, setup scripts and Mock mode.
- **Introduction (10%)**: multi-agent software project coordination.
- **ER diagram (10%)**: users, projects, tasks, dependencies, agents, runs, artifacts and reviews.
- **Key SQL (15%)**: joins, dependency blocking, agent performance and full execution trace.
- **Video (25%)**: live CRUD and database changes while agents run.
- **Organization / participation (10%)**: a 5-minute presentation in which every member speaks, with the 2-minute demo video inside that time; speaker notes in the slides split the talk into five parts.
