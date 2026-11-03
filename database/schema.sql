SET FOREIGN_KEY_CHECKS = 0;

-- ai_recommendations was removed from the design; drop it if an older schema created it.
DROP TABLE IF EXISTS ai_recommendations;
DROP TABLE IF EXISTS run_inputs;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS task_assignments;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- Entity: users
CREATE TABLE users (
  user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Entity: projects (owns: users 1 -- N projects)
CREATE TABLE projects (
  project_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status ENUM('PLANNING', 'ACTIVE', 'COMPLETED', 'ARCHIVED') NOT NULL DEFAULT 'PLANNING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_projects_owner
    FOREIGN KEY (owner_id) REFERENCES users(user_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Entity: agents
CREATE TABLE agents (
  agent_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  role ENUM('PLANNER', 'CODER', 'TESTER', 'REVIEWER') NOT NULL,
  provider VARCHAR(100) NOT NULL DEFAULT 'mock',
  model_name VARCHAR(100) NOT NULL DEFAULT 'mock-agent-v1',
  execution_mode ENUM('MOCK', 'LIVE') NOT NULL DEFAULT 'MOCK',
  status ENUM('AVAILABLE', 'BUSY', 'OFFLINE') NOT NULL DEFAULT 'AVAILABLE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Entity: tasks (contains: projects 1 -- N tasks; creates: users 1 -- N tasks)
CREATE TABLE tasks (
  task_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  required_role ENUM('PLANNER', 'CODER', 'TESTER', 'REVIEWER') NOT NULL,
  status ENUM('TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'TODO',
  priority ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') NOT NULL DEFAULT 'MEDIUM',
  estimated_hours DECIMAL(5,2) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tasks_project
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_tasks_creator
    FOREIGN KEY (created_by) REFERENCES users(user_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_tasks_project_status (project_id, status)
) ENGINE=InnoDB;

-- Relationship: depends_on (recursive M:N on tasks)
CREATE TABLE task_dependencies (
  task_id BIGINT UNSIGNED NOT NULL,
  depends_on_task_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT chk_no_self_dependency CHECK (task_id <> depends_on_task_id),
  CONSTRAINT fk_task_dep_task
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_task_dep_depends_on
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(task_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Relationship: assigned_to (M:N between tasks and agents, with descriptive attributes)
CREATE TABLE task_assignments (
  task_id BIGINT UNSIGNED NOT NULL,
  agent_id BIGINT UNSIGNED NOT NULL,
  assignment_role ENUM('PRIMARY', 'SUPPORT', 'REVIEWER') NOT NULL DEFAULT 'PRIMARY',
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, agent_id, assignment_role),
  -- At most one PRIMARY agent per task (NULLs are ignored by a unique index).
  UNIQUE KEY uk_one_primary_per_task ((CASE WHEN assignment_role = 'PRIMARY' THEN task_id END)),
  CONSTRAINT fk_task_assignment_task
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_task_assignment_agent
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    ON DELETE RESTRICT,
  INDEX idx_task_assignments_agent (agent_id)
) ENGINE=InnoDB;

-- Entity: agent_runs (executes: tasks 1 -- N runs; performs: agents 1 -- N runs)
CREATE TABLE agent_runs (
  agent_run_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  agent_id BIGINT UNSIGNED NOT NULL,
  status ENUM('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  latency_ms INT UNSIGNED NULL,
  input_summary TEXT,
  output_summary TEXT,
  raw_output JSON NULL,
  error_message TEXT NULL,
  model_name VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_runs_task
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_agent_runs_agent
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    ON DELETE RESTRICT,
  INDEX idx_agent_runs_task (task_id, created_at)
) ENGINE=InnoDB;

-- Entity: artifacts (produces: agent_runs 1 -- N artifacts)
-- The owning task is derived through agent_runs.task_id, so it is not stored here.
CREATE TABLE artifacts (
  artifact_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_run_id BIGINT UNSIGNED NOT NULL,
  artifact_type ENUM('CODE', 'DOCUMENT', 'TEST_REPORT', 'LOG', 'OTHER') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NULL,
  content LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_artifacts_run
    FOREIGN KEY (agent_run_id) REFERENCES agent_runs(agent_run_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Entity: reviews (receives: artifacts 1 -- N reviews; writes: users 1 -- N reviews)
CREATE TABLE reviews (
  review_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  artifact_id BIGINT UNSIGNED NOT NULL,
  reviewer_id BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'ACCEPTED', 'CHANGES_REQUESTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  CONSTRAINT fk_reviews_artifact
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_reviews_reviewer
    FOREIGN KEY (reviewer_id) REFERENCES users(user_id)
    ON DELETE RESTRICT,
  INDEX idx_reviews_artifact (artifact_id)
) ENGINE=InnoDB;

-- Relationship: uses (M:N between agent_runs and artifacts)
-- Records which approved upstream artifacts were given to a run as input.
CREATE TABLE run_inputs (
  agent_run_id BIGINT UNSIGNED NOT NULL,
  artifact_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (agent_run_id, artifact_id),
  CONSTRAINT fk_run_inputs_run
    FOREIGN KEY (agent_run_id) REFERENCES agent_runs(agent_run_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_run_inputs_artifact
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
    ON DELETE CASCADE,
  INDEX idx_run_inputs_artifact (artifact_id)
) ENGINE=InnoDB;
