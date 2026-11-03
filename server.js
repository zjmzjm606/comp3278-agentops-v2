require('dotenv').config();

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pool = require('./src/db');
const {
  AppError,
  approveTask,
  findDuplicateTask,
  getProjectDashboard,
  recommendAssignee,
  runNextTask,
  runTask
} = require('./src/orchestrator');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function publicUser(user) {
  return {
    user_id: user.user_id,
    username: user.username,
    email: user.email,
    role: user.role
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return next(new AppError(401, 'Authentication required.', 'AUTH_REQUIRED'));
  }
  next();
}

function idFrom(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, `${label} must be a positive integer.`, 'INVALID_ID');
  }
  return id;
}

function requiredText(value, label, maxLength = 200) {
  const text = String(value || '').trim();
  if (!text) throw new AppError(400, `${label} is required.`, 'VALIDATION_ERROR');
  if (text.length > maxLength) {
    throw new AppError(400, `${label} must be at most ${maxLength} characters.`, 'VALIDATION_ERROR');
  }
  return text;
}

const TASK_ROLES = new Set(['PLANNER', 'CODER', 'TESTER', 'REVIEWER']);
const TASK_STATUSES = new Set(['TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED']);
const TASK_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const PROJECT_STATUSES = new Set(['PLANNING', 'ACTIVE', 'COMPLETED', 'ARCHIVED']);
const AGENT_STATUSES = new Set(['AVAILABLE', 'BUSY', 'OFFLINE']);
const AGENT_MODES = new Set(['MOCK', 'LIVE']);
const AGENT_PROVIDERS = new Set(['mock', 'openai', 'deepseek', 'glm']);

// Status changes a user may make directly. IN_PROGRESS, REVIEW and DONE are only
// reached through the workflow: running an agent and approving its artifact.
const MANUAL_STATUS_TRANSITIONS = {
  TODO: ['BLOCKED', 'CANCELLED'],
  BLOCKED: ['TODO', 'CANCELLED'],
  CANCELLED: ['TODO']
};

async function getProjectForUser(projectId, userId) {
  const [rows] = await pool.execute(
    `SELECT p.*, u.username AS owner_name
     FROM projects p
     JOIN users u ON u.user_id = p.owner_id
     WHERE p.project_id = ?`,
    [projectId]
  );
  if (!rows.length) throw new AppError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
  if (Number(rows[0].owner_id) !== Number(userId)) {
    throw new AppError(403, 'You do not have access to this project.', 'PROJECT_FORBIDDEN');
  }
  return rows[0];
}

async function getTaskForUser(taskId, userId) {
  const [rows] = await pool.execute(
    `SELECT t.*, p.owner_id
     FROM tasks t
     JOIN projects p ON p.project_id = t.project_id
     WHERE t.task_id = ?`,
    [taskId]
  );
  if (!rows.length) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
  if (Number(rows[0].owner_id) !== Number(userId)) {
    throw new AppError(403, 'You do not have access to this task.', 'TASK_FORBIDDEN');
  }
  return rows[0];
}

app.post(
  '/api/auth/register',
  asyncHandler(async (req, res) => {
    const username = requiredText(req.body.username, 'Username', 50);
    const email = requiredText(req.body.email, 'Email', 255).toLowerCase();
    const password = String(req.body.password || '');
    if (password.length < 8) {
      throw new AppError(400, 'Password must contain at least 8 characters.', 'VALIDATION_ERROR');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const [result] = await pool.execute(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES (?, ?, ?, 'MEMBER')`,
        [username, email, passwordHash]
      );
      req.session.userId = result.insertId;
      res.status(201).json({
        user: { user_id: result.insertId, username, email, role: 'MEMBER' }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new AppError(409, 'Username or email already exists.', 'USER_EXISTS');
      }
      throw error;
    }
  })
);

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const identifier = requiredText(req.body.identifier, 'Email or username', 255);
    const password = String(req.body.password || '');
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1',
      [identifier.toLowerCase(), identifier]
    );

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      throw new AppError(401, 'Invalid email/username or password.', 'INVALID_CREDENTIALS');
    }

    req.session.userId = rows[0].user_id;
    res.json({ user: publicUser(rows[0]) });
  })
);

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get(
  '/api/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [req.session.userId]);
    if (!rows.length) {
      req.session.destroy(() => {});
      throw new AppError(401, 'Session user no longer exists.', 'AUTH_REQUIRED');
    }
    res.json({ user: publicUser(rows[0]) });
  })
);

app.use('/api', requireAuth);

app.get(
  '/api/projects',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT
         p.*,
         COUNT(t.task_id) AS task_count,
         SUM(t.status = 'DONE') AS done_count,
         SUM(t.status = 'REVIEW') AS review_count
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.project_id
       WHERE p.owner_id = ?
       GROUP BY p.project_id
       ORDER BY p.created_at DESC, p.project_id DESC`,
      [req.session.userId]
    );
    res.json({ projects: rows });
  })
);

app.post(
  '/api/projects',
  asyncHandler(async (req, res) => {
    const name = requiredText(req.body.name, 'Project name', 120);
    const description = String(req.body.description || '').trim();
    const [result] = await pool.execute(
      `INSERT INTO projects (owner_id, name, description, status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [req.session.userId, name, description || null]
    );
    const [rows] = await pool.execute('SELECT * FROM projects WHERE project_id = ?', [result.insertId]);
    res.status(201).json({ project: rows[0] });
  })
);

app.patch(
  '/api/projects/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);

    const updates = [];
    const values = [];
    if (req.body.name !== undefined) {
      updates.push('name = ?');
      values.push(requiredText(req.body.name, 'Project name', 120));
    }
    if (req.body.description !== undefined) {
      updates.push('description = ?');
      values.push(String(req.body.description || '').trim() || null);
    }
    if (req.body.status !== undefined) {
      if (!PROJECT_STATUSES.has(req.body.status)) {
        throw new AppError(400, 'Invalid project status.', 'VALIDATION_ERROR');
      }
      updates.push('status = ?');
      values.push(req.body.status);
    }
    if (!updates.length) throw new AppError(400, 'No supported fields supplied.', 'VALIDATION_ERROR');

    values.push(projectId);
    await pool.execute(`UPDATE projects SET ${updates.join(', ')} WHERE project_id = ?`, values);
    const [rows] = await pool.execute('SELECT * FROM projects WHERE project_id = ?', [projectId]);
    res.json({ project: rows[0] });
  })
);

app.delete(
  '/api/projects/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);
    await pool.execute('DELETE FROM projects WHERE project_id = ?', [projectId]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/projects/:projectId/tasks',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);

    const [tasks] = await pool.execute(
      `SELECT t.*, u.username AS creator_name
       FROM tasks t
       JOIN users u ON u.user_id = t.created_by
       WHERE t.project_id = ?
       ORDER BY FIELD(t.priority, 'URGENT', 'HIGH', 'MEDIUM', 'LOW'), t.created_at, t.task_id`,
      [projectId]
    );

    const [dependencies] = await pool.execute(
      `SELECT td.task_id, td.depends_on_task_id, dep.title, dep.status
       FROM task_dependencies td
       JOIN tasks t ON t.task_id = td.task_id
       JOIN tasks dep ON dep.task_id = td.depends_on_task_id
       WHERE t.project_id = ?
       ORDER BY td.task_id, td.depends_on_task_id`,
      [projectId]
    );

    const [assignments] = await pool.execute(
      `SELECT ta.task_id, ta.agent_id, ta.assignment_role, a.name, a.role, a.status
       FROM task_assignments ta
       JOIN tasks t ON t.task_id = ta.task_id
       JOIN agents a ON a.agent_id = ta.agent_id
       WHERE t.project_id = ?
       ORDER BY ta.assignment_role, ta.agent_id`,
      [projectId]
    );

    const depsByTask = new Map();
    for (const dep of dependencies) {
      if (!depsByTask.has(dep.task_id)) depsByTask.set(dep.task_id, []);
      depsByTask.get(dep.task_id).push(dep);
    }
    const assignmentsByTask = new Map();
    for (const assignment of assignments) {
      if (!assignmentsByTask.has(assignment.task_id)) assignmentsByTask.set(assignment.task_id, []);
      assignmentsByTask.get(assignment.task_id).push(assignment);
    }

    res.json({
      tasks: tasks.map((task) => ({
        ...task,
        dependencies: depsByTask.get(task.task_id) || [],
        assignments: assignmentsByTask.get(task.task_id) || []
      }))
    });
  })
);

app.post(
  '/api/projects/:projectId/tasks',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);

    const title = requiredText(req.body.title, 'Task title', 200);
    const description = String(req.body.description || '').trim();
    const requiredRole = String(req.body.required_role || 'CODER').toUpperCase();
    const priority = String(req.body.priority || 'MEDIUM').toUpperCase();
    const estimatedHours = req.body.estimated_hours === '' || req.body.estimated_hours == null
      ? null
      : Number(req.body.estimated_hours);
    const dependencyIds = Array.isArray(req.body.depends_on_ids)
      ? [...new Set(req.body.depends_on_ids.map(Number).filter(Number.isInteger))]
      : [];

    if (!TASK_ROLES.has(requiredRole)) throw new AppError(400, 'Invalid required role.', 'VALIDATION_ERROR');
    if (!TASK_PRIORITIES.has(priority)) throw new AppError(400, 'Invalid priority.', 'VALIDATION_ERROR');
    if (estimatedHours !== null && (!Number.isFinite(estimatedHours) || estimatedHours < 0)) {
      throw new AppError(400, 'Estimated hours must be a non-negative number.', 'VALIDATION_ERROR');
    }

    const connection = await pool.getConnection();
    let taskId;
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO tasks
           (project_id, created_by, title, description, required_role, status, priority, estimated_hours)
         VALUES (?, ?, ?, ?, ?, 'TODO', ?, ?)`,
        [projectId, req.session.userId, title, description || null, requiredRole, priority, estimatedHours]
      );
      taskId = result.insertId;

      if (dependencyIds.length) {
        const placeholders = dependencyIds.map(() => '?').join(', ');
        const [validDeps] = await connection.query(
          `SELECT task_id FROM tasks WHERE project_id = ? AND task_id IN (${placeholders})`,
          [projectId, ...dependencyIds]
        );
        if (validDeps.length !== dependencyIds.length) {
          throw new AppError(400, 'One or more dependency tasks are invalid.', 'INVALID_DEPENDENCY');
        }
        for (const dependencyId of dependencyIds) {
          if (dependencyId === taskId) {
            throw new AppError(400, 'A task cannot depend on itself.', 'INVALID_DEPENDENCY');
          }
          await connection.execute(
            'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
            [taskId, dependencyId]
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const duplicate = await findDuplicateTask(taskId, projectId);
    const [rows] = await pool.execute('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
    res.status(201).json({ task: rows[0], duplicate });
  })
);

app.patch(
  '/api/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const taskId = idFrom(req.params.taskId, 'taskId');
    const current = await getTaskForUser(taskId, req.session.userId);

    const updates = [];
    const values = [];
    let statusChange = null;
    if (req.body.title !== undefined) {
      updates.push('title = ?');
      values.push(requiredText(req.body.title, 'Task title', 200));
    }
    if (req.body.description !== undefined) {
      updates.push('description = ?');
      values.push(String(req.body.description || '').trim() || null);
    }
    if (req.body.status !== undefined && req.body.status !== current.status) {
      if (!TASK_STATUSES.has(req.body.status)) throw new AppError(400, 'Invalid task status.', 'VALIDATION_ERROR');
      const allowed = MANUAL_STATUS_TRANSITIONS[current.status] || [];
      if (!allowed.includes(req.body.status)) {
        throw new AppError(
          409,
          `Cannot change status from ${current.status} to ${req.body.status} directly. ` +
            'IN_PROGRESS, REVIEW and DONE are set by running an agent and approving its artifact.',
          'INVALID_STATUS_TRANSITION',
          { from: current.status, allowed }
        );
      }
      updates.push('status = ?');
      values.push(req.body.status);
      statusChange = { from: current.status, to: req.body.status };
    }
    if (req.body.priority !== undefined) {
      if (!TASK_PRIORITIES.has(req.body.priority)) throw new AppError(400, 'Invalid priority.', 'VALIDATION_ERROR');
      updates.push('priority = ?');
      values.push(req.body.priority);
    }
    if (req.body.required_role !== undefined) {
      if (!TASK_ROLES.has(req.body.required_role)) throw new AppError(400, 'Invalid required role.', 'VALIDATION_ERROR');
      updates.push('required_role = ?');
      values.push(req.body.required_role);
    }
    if (req.body.estimated_hours !== undefined) {
      const estimatedHours = req.body.estimated_hours === '' || req.body.estimated_hours == null
        ? null
        : Number(req.body.estimated_hours);
      if (estimatedHours !== null && (!Number.isFinite(estimatedHours) || estimatedHours < 0)) {
        throw new AppError(400, 'Estimated hours must be a non-negative number.', 'VALIDATION_ERROR');
      }
      updates.push('estimated_hours = ?');
      values.push(estimatedHours);
    }
    if (!updates.length) throw new AppError(400, 'No supported fields supplied.', 'VALIDATION_ERROR');

    values.push(taskId);
    let where = 'task_id = ?';
    if (statusChange) {
      // Only apply the change if nobody moved the task in the meantime (e.g. a run started).
      where += ' AND status = ?';
      values.push(statusChange.from);
    }
    const [result] = await pool.execute(`UPDATE tasks SET ${updates.join(', ')} WHERE ${where}`, values);
    if (statusChange && result.affectedRows !== 1) {
      throw new AppError(409, 'The task changed while you were editing it. Refresh and try again.', 'TASK_CHANGED');
    }
    const [rows] = await pool.execute('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
    res.json({ task: rows[0] });
  })
);

app.delete(
  '/api/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const taskId = idFrom(req.params.taskId, 'taskId');
    await getTaskForUser(taskId, req.session.userId);
    await pool.execute('DELETE FROM tasks WHERE task_id = ?', [taskId]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/tasks/:taskId/recommend',
  asyncHandler(async (req, res) => {
    const taskId = idFrom(req.params.taskId, 'taskId');
    await getTaskForUser(taskId, req.session.userId);
    const result = await recommendAssignee(taskId);
    res.json({
      task: result.task,
      best: result.best,
      candidates: result.candidates,
      risk: result.risk
    });
  })
);

app.post(
  '/api/tasks/:taskId/run',
  asyncHandler(async (req, res) => {
    const taskId = idFrom(req.params.taskId, 'taskId');
    await getTaskForUser(taskId, req.session.userId);
    const agentId = req.body.agent_id ? idFrom(req.body.agent_id, 'agentId') : null;
    const result = await runTask(taskId, agentId);
    res.status(201).json(result);
  })
);

app.post(
  '/api/tasks/:taskId/approve',
  asyncHandler(async (req, res) => {
    const taskId = idFrom(req.params.taskId, 'taskId');
    await getTaskForUser(taskId, req.session.userId);
    const result = await approveTask(taskId, req.session.userId);
    res.json(result);
  })
);

app.post(
  '/api/projects/:projectId/run-next',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);
    const result = await runNextTask(projectId);
    res.status(201).json(result);
  })
);

app.get(
  '/api/projects/:projectId/dashboard',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);
    const data = await getProjectDashboard(projectId);
    res.json(data);
  })
);

app.get(
  '/api/projects/:projectId/runs',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);
    const [rows] = await pool.execute(
      `SELECT
         r.*,
         t.title AS task_title,
         a.name AS agent_name,
         a.role AS agent_role,
         ar.artifact_id,
         ar.file_name,
         ar.artifact_type,
         COALESCE(inp.input_count, 0) AS input_count,
         inp.input_files
       FROM agent_runs r
       JOIN tasks t ON t.task_id = r.task_id
       JOIN agents a ON a.agent_id = r.agent_id
       LEFT JOIN artifacts ar ON ar.agent_run_id = r.agent_run_id
       LEFT JOIN (
         SELECT ri.agent_run_id,
                COUNT(*) AS input_count,
                GROUP_CONCAT(ia.file_name ORDER BY ia.artifact_id SEPARATOR ', ') AS input_files
         FROM run_inputs ri
         JOIN artifacts ia ON ia.artifact_id = ri.artifact_id
         GROUP BY ri.agent_run_id
       ) inp ON inp.agent_run_id = r.agent_run_id
       WHERE t.project_id = ?
       ORDER BY r.created_at DESC, r.agent_run_id DESC
       LIMIT 100`,
      [projectId]
    );
    res.json({ runs: rows });
  })
);

app.get(
  '/api/projects/:projectId/artifacts',
  asyncHandler(async (req, res) => {
    const projectId = idFrom(req.params.projectId, 'projectId');
    await getProjectForUser(projectId, req.session.userId);
    const [rows] = await pool.execute(
      `SELECT
         ar.*,
         r.task_id,
         t.title AS task_title,
         r.agent_id,
         a.name AS agent_name,
         rev.review_id,
         rev.status AS review_status,
         rev.comment AS review_comment
       FROM artifacts ar
       JOIN agent_runs r ON r.agent_run_id = ar.agent_run_id
       JOIN tasks t ON t.task_id = r.task_id
       JOIN agents a ON a.agent_id = r.agent_id
       LEFT JOIN reviews rev ON rev.artifact_id = ar.artifact_id
       WHERE t.project_id = ?
       ORDER BY ar.created_at DESC, ar.artifact_id DESC
       LIMIT 100`,
      [projectId]
    );
    res.json({ artifacts: rows });
  })
);

app.get(
  '/api/agents',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT
         a.*,
         COUNT(r.agent_run_id) AS total_runs,
         SUM(r.status = 'SUCCESS') AS successful_runs,
         ROUND(AVG(r.latency_ms), 0) AS avg_latency_ms,
         MAX(r.created_at) AS last_run_at
       FROM agents a
       LEFT JOIN agent_runs r ON r.agent_id = a.agent_id
       GROUP BY a.agent_id
       ORDER BY FIELD(a.role, 'PLANNER', 'CODER', 'TESTER', 'REVIEWER'), a.agent_id`
    );
    res.json({ agents: rows });
  })
);

app.post(
  '/api/agents',
  asyncHandler(async (req, res) => {
    const name = requiredText(req.body.name, 'Agent name', 100);
    const role = String(req.body.role || '').toUpperCase();
    const provider = String(req.body.provider || 'mock').toLowerCase();
    const modelName = String(req.body.model_name || 'mock-agent-v1').trim();
    const executionMode = String(req.body.execution_mode || 'MOCK').toUpperCase();
    if (!TASK_ROLES.has(role)) throw new AppError(400, 'Invalid agent role.', 'VALIDATION_ERROR');
    if (!AGENT_PROVIDERS.has(provider)) throw new AppError(400, 'Unsupported provider.', 'VALIDATION_ERROR');
    if (!AGENT_MODES.has(executionMode)) throw new AppError(400, 'Invalid execution mode.', 'VALIDATION_ERROR');
    try {
      const [result] = await pool.execute(
        `INSERT INTO agents
           (name, role, provider, model_name, execution_mode, status)
         VALUES (?, ?, ?, ?, ?, 'AVAILABLE')`,
        [name, role, provider, modelName, executionMode]
      );
      const [rows] = await pool.execute('SELECT * FROM agents WHERE agent_id = ?', [result.insertId]);
      res.status(201).json({ agent: rows[0] });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new AppError(409, 'An agent with this name already exists.', 'AGENT_EXISTS');
      }
      throw error;
    }
  })
);

app.patch(
  '/api/agents/:agentId',
  asyncHandler(async (req, res) => {
    const agentId = idFrom(req.params.agentId, 'agentId');
    const updates = [];
    const values = [];
    if (req.body.name !== undefined) {
      updates.push('name = ?');
      values.push(requiredText(req.body.name, 'Agent name', 100));
    }
    if (req.body.role !== undefined) {
      if (!TASK_ROLES.has(req.body.role)) throw new AppError(400, 'Invalid agent role.', 'VALIDATION_ERROR');
      updates.push('role = ?');
      values.push(req.body.role);
    }
    if (req.body.provider !== undefined) {
      if (!AGENT_PROVIDERS.has(req.body.provider)) throw new AppError(400, 'Unsupported provider.', 'VALIDATION_ERROR');
      updates.push('provider = ?');
      values.push(req.body.provider);
    }
    if (req.body.model_name !== undefined) {
      updates.push('model_name = ?');
      values.push(requiredText(req.body.model_name, 'Model name', 100));
    }
    if (req.body.execution_mode !== undefined) {
      if (!AGENT_MODES.has(req.body.execution_mode)) throw new AppError(400, 'Invalid execution mode.', 'VALIDATION_ERROR');
      updates.push('execution_mode = ?');
      values.push(req.body.execution_mode);
    }
    if (req.body.status !== undefined) {
      if (!AGENT_STATUSES.has(req.body.status)) throw new AppError(400, 'Invalid agent status.', 'VALIDATION_ERROR');
      updates.push('status = ?');
      values.push(req.body.status);
    }
    if (!updates.length) throw new AppError(400, 'No supported fields supplied.', 'VALIDATION_ERROR');
    values.push(agentId);
    await pool.execute(`UPDATE agents SET ${updates.join(', ')} WHERE agent_id = ?`, values);
    const [rows] = await pool.execute('SELECT * FROM agents WHERE agent_id = ?', [agentId]);
    if (!rows.length) throw new AppError(404, 'Agent not found.', 'AGENT_NOT_FOUND');
    res.json({ agent: rows[0] });
  })
);

app.delete(
  '/api/agents/:agentId',
  asyncHandler(async (req, res) => {
    const agentId = idFrom(req.params.agentId, 'agentId');
    try {
      await pool.execute('DELETE FROM agents WHERE agent_id = ?', [agentId]);
      res.json({ ok: true });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2') {
        throw new AppError(
          409,
          'This agent has run history and cannot be deleted. Set its status to OFFLINE instead.',
          'AGENT_IN_USE'
        );
      }
      throw error;
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { message: 'API route not found.', code: 'NOT_FOUND' } });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: {
      message: error.message || 'Unexpected server error.',
      code: error.code || 'INTERNAL_ERROR',
      details: error.details || null
    }
  });
});

async function start() {
  await pool.query('SELECT 1');
  app.listen(PORT, () => {
    console.log(`AgentOps running at http://localhost:${PORT}`);
    console.log(`Mock mode is the default. Live mode is optional.`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exitCode = 1;
  });
}

module.exports = app;
