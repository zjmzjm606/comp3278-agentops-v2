const pool = require('./db');
const { runAgent } = require('./agent-runtime');

class AppError extends Error {
  constructor(status, message, code = 'APP_ERROR', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFKC');
}

function tokenize(value) {
  const chunks = normalizeText(value).match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = new Set();

  for (const chunk of chunks) {
    tokens.add(chunk);
    if (/[\u3400-\u9fff]/.test(chunk) && chunk.length > 1) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        tokens.add(chunk.slice(index, index + 2));
      }
    }
  }

  return tokens;
}

function jaccardSimilarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

async function getTaskContext(taskId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT
       t.*,
       p.name AS project_name,
       p.description AS project_description,
       p.owner_id
     FROM tasks t
     JOIN projects p ON p.project_id = t.project_id
     WHERE t.task_id = ?`,
    [taskId]
  );

  if (!rows.length) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
  return rows[0];
}

async function getBlockingDependencies(taskId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT dep.task_id, dep.title, dep.status
     FROM task_dependencies td
     JOIN tasks dep ON dep.task_id = td.depends_on_task_id
     WHERE td.task_id = ?
       AND dep.status <> 'DONE'
     ORDER BY dep.task_id`,
    [taskId]
  );
  return rows;
}

async function findDuplicateTask(taskId, projectId) {
  const [taskRows] = await pool.execute(
    'SELECT task_id, title, description FROM tasks WHERE task_id = ?',
    [taskId]
  );
  if (!taskRows.length) return null;

  const [otherTasks] = await pool.execute(
    'SELECT task_id, title, description FROM tasks WHERE project_id = ? AND task_id <> ?',
    [projectId, taskId]
  );

  const source = `${taskRows[0].title} ${taskRows[0].description || ''}`;
  let best = null;

  for (const other of otherTasks) {
    const score = jaccardSimilarity(source, `${other.title} ${other.description || ''}`);
    if (!best || score > best.score) best = { ...other, score };
  }

  if (best && best.score >= 0.42) {
    const percentage = Number((best.score * 100).toFixed(2));
    const reason = `Possible duplicate of task #${best.task_id} "${best.title}" (${percentage}% similarity).`;
    return { taskId: best.task_id, title: best.title, score: percentage, reason };
  }

  return null;
}

async function scoreAgents(task) {
  const [agents] = await pool.execute(
    `SELECT
       a.*,
       COUNT(r.agent_run_id) AS total_runs,
       SUM(CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END) AS successful_runs,
       SUM(CASE WHEN r.status = 'RUNNING' THEN 1 ELSE 0 END) AS running_runs
     FROM agents a
     LEFT JOIN agent_runs r ON r.agent_id = a.agent_id
     WHERE a.role = ?
     GROUP BY a.agent_id
     ORDER BY a.agent_id`,
    [task.required_role]
  );

  return agents
    .filter((agent) => agent.status === 'AVAILABLE')
    .map((agent) => {
      const totalRuns = Number(agent.total_runs || 0);
      const successfulRuns = Number(agent.successful_runs || 0);
      const successRate = totalRuns === 0 ? 0.65 : successfulRuns / totalRuns;
      const availabilityBonus = agent.status === 'AVAILABLE' ? 10 : 0;
      const experienceBonus = Math.min(totalRuns, 5);
      const score = Math.min(100, 60 + successRate * 25 + availabilityBonus + experienceBonus);
      const reasons = [
        `Matches required role ${task.required_role}`,
        agent.status === 'AVAILABLE' ? 'Currently available' : `Current status: ${agent.status}`,
        totalRuns === 0 ? 'No prior runs, neutral prior used' : `${successfulRuns}/${totalRuns} successful runs`
      ];

      return {
        ...agent,
        score: Number(score.toFixed(2)),
        reason: reasons.join('; ')
      };
    })
    .sort((a, b) => b.score - a.score || a.agent_id - b.agent_id);
}

// Recommendations are computed on demand from the run history and returned to the
// caller; they are not stored in the database.
async function recommendAssignee(taskId) {
  const task = await getTaskContext(taskId);
  const candidates = await scoreAgents(task);
  if (!candidates.length) {
    throw new AppError(409, `No available agent for role ${task.required_role}.`, 'NO_AGENT');
  }

  const best = candidates[0];
  const blocking = await getBlockingDependencies(taskId);
  const priorityWeight = { LOW: 0, MEDIUM: 10, HIGH: 20, URGENT: 30 }[task.priority] || 0;
  const riskScore = Math.max(0, Math.min(100, 25 + blocking.length * 18 + priorityWeight));
  const riskReason = blocking.length
    ? `${blocking.length} unfinished dependenc${blocking.length === 1 ? 'y' : 'ies'} and ${task.priority.toLowerCase()} priority.`
    : `All dependencies are clear; ${task.priority.toLowerCase()} priority.`;

  return { task, best, candidates, risk: { score: riskScore, reason: riskReason } };
}

const RUNNABLE_STATUSES = ['TODO', 'BLOCKED', 'REVIEW'];

// The latest approved artifact of each direct prerequisite task. A run receives these
// as input, and the usage is recorded in the run_inputs relationship.
async function getApprovedInputs(taskId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT task_id, task_title, artifact_id, artifact_type, file_name, content
     FROM (
       SELECT
         dep.task_id,
         dep.title AS task_title,
         ar.artifact_id,
         ar.artifact_type,
         ar.file_name,
         ar.content,
         ROW_NUMBER() OVER (
           PARTITION BY dep.task_id
           ORDER BY ar.created_at DESC, ar.artifact_id DESC
         ) AS rn
       FROM task_dependencies td
       JOIN tasks dep ON dep.task_id = td.depends_on_task_id
       JOIN agent_runs r ON r.task_id = dep.task_id AND r.status = 'SUCCESS'
       JOIN artifacts ar ON ar.agent_run_id = r.agent_run_id
       WHERE td.task_id = ?
         AND EXISTS (
           SELECT 1 FROM reviews rv
           WHERE rv.artifact_id = ar.artifact_id AND rv.status = 'ACCEPTED'
         )
     ) latest
     WHERE rn = 1
     ORDER BY task_id`,
    [taskId]
  );
  return rows;
}

// Close a run that could not finish: the run, the agent and the task are updated
// together so none of them is left RUNNING / BUSY / IN_PROGRESS.
async function finishFailedRun(runId, agentId, taskId, latencyMs, message) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE agent_runs
       SET status = 'FAILED', finished_at = NOW(), latency_ms = ?, error_message = ?
       WHERE agent_run_id = ? AND status = 'RUNNING'`,
      [latencyMs, String(message).slice(0, 2000), runId]
    );
    await connection.execute(
      `UPDATE agents SET status = 'AVAILABLE' WHERE agent_id = ? AND status = 'BUSY'`,
      [agentId]
    );
    await connection.execute(
      `UPDATE tasks SET status = 'BLOCKED' WHERE task_id = ? AND status = 'IN_PROGRESS'`,
      [taskId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function runTask(taskId, requestedAgentId = null) {
  const task = await getTaskContext(taskId);
  if (task.status === 'DONE') throw new AppError(409, 'Task is already done.', 'TASK_DONE');
  if (task.status === 'CANCELLED') throw new AppError(409, 'Task is cancelled.', 'TASK_CANCELLED');
  if (task.status === 'IN_PROGRESS') throw new AppError(409, 'Task is already running.', 'TASK_RUNNING');

  const blocking = await getBlockingDependencies(taskId);
  if (blocking.length) {
    throw new AppError(
      409,
      'Task is blocked by unfinished dependencies.',
      'DEPENDENCIES_BLOCKED',
      blocking
    );
  }

  let candidates;
  if (requestedAgentId) {
    const [rows] = await pool.execute('SELECT * FROM agents WHERE agent_id = ?', [requestedAgentId]);
    const requested = rows[0];
    if (!requested) throw new AppError(404, 'Agent not found.', 'AGENT_NOT_FOUND');
    if (requested.role !== task.required_role) {
      throw new AppError(
        400,
        `Agent role ${requested.role} does not match required role ${task.required_role}.`,
        'ROLE_MISMATCH'
      );
    }
    if (requested.status !== 'AVAILABLE') {
      throw new AppError(409, `Agent is currently ${requested.status.toLowerCase()}.`, 'AGENT_UNAVAILABLE');
    }
    candidates = [requested];
  } else {
    // May be empty; the claim below reports TASK_RUNNING or NO_AGENT accordingly.
    candidates = await scoreAgents(task);
  }

  const inputs = await getApprovedInputs(taskId);

  // 1. Claim the task and one agent in a single transaction. The conditional UPDATEs
  //    only succeed if the row is still in the expected state, so two concurrent
  //    requests cannot start the same task or book the same agent twice.
  let agent = null;
  let runId;
  const claim = await pool.getConnection();
  try {
    await claim.beginTransaction();

    const placeholders = RUNNABLE_STATUSES.map(() => '?').join(', ');
    const [claimedTask] = await claim.execute(
      `UPDATE tasks SET status = 'IN_PROGRESS'
       WHERE task_id = ? AND status IN (${placeholders})`,
      [taskId, ...RUNNABLE_STATUSES]
    );
    if (claimedTask.affectedRows !== 1) {
      throw new AppError(409, 'Task is no longer runnable; another run may have started.', 'TASK_RUNNING');
    }

    for (const candidate of candidates) {
      const [claimedAgent] = await claim.execute(
        `UPDATE agents SET status = 'BUSY' WHERE agent_id = ? AND status = 'AVAILABLE'`,
        [candidate.agent_id]
      );
      if (claimedAgent.affectedRows === 1) {
        agent = candidate;
        break;
      }
    }
    if (!agent) {
      throw requestedAgentId
        ? new AppError(409, 'Agent is no longer available.', 'AGENT_UNAVAILABLE')
        : new AppError(409, `No available agent for role ${task.required_role}.`, 'NO_AGENT');
    }

    const [runResult] = await claim.execute(
      `INSERT INTO agent_runs
         (task_id, agent_id, status, started_at, input_summary, model_name)
       VALUES (?, ?, 'RUNNING', NOW(), ?, ?)`,
      [
        taskId,
        agent.agent_id,
        `${task.title}: ${task.description || 'No description'}` +
          (inputs.length ? ` | inputs: ${inputs.map((input) => input.file_name).join(', ')}` : ''),
        agent.model_name
      ]
    );
    runId = runResult.insertId;

    for (const input of inputs) {
      await claim.execute(
        'INSERT INTO run_inputs (agent_run_id, artifact_id) VALUES (?, ?)',
        [runId, input.artifact_id]
      );
    }

    await claim.commit();
  } catch (error) {
    await claim.rollback();
    throw error;
  } finally {
    claim.release();
  }

  // 2. Run the agent outside any transaction (it may take seconds).
  const started = Date.now();
  let output;
  try {
    output = await runAgent({
      agent,
      task,
      project: { name: task.project_name, description: task.project_description },
      inputs
    });
  } catch (error) {
    await finishFailedRun(runId, agent.agent_id, taskId, Date.now() - started, error.message);
    throw new AppError(502, `Agent execution failed: ${error.message}`, 'AGENT_FAILED', { runId });
  }

  // 3. Store the result. Everything is written in one transaction; if any write fails
  //    the run is closed as FAILED so nothing is left half-finished.
  const latencyMs = Date.now() - started;
  const nextStatus = agent.role === 'REVIEWER' ? 'DONE' : 'REVIEW';
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [runUpdate] = await connection.execute(
      `UPDATE agent_runs
       SET status = 'SUCCESS', finished_at = NOW(), latency_ms = ?,
           output_summary = ?, raw_output = ?
       WHERE agent_run_id = ? AND status = 'RUNNING'`,
      [
        latencyMs,
        output.summary,
        JSON.stringify({
          provider: output.provider || 'mock',
          model: output.model || agent.model_name,
          confidence: output.confidence,
          content: output.content
        }),
        runId
      ]
    );
    if (runUpdate.affectedRows !== 1) {
      throw new AppError(409, 'The task was removed while the agent was running.', 'RUN_GONE');
    }

    const [artifactResult] = await connection.execute(
      `INSERT INTO artifacts
         (agent_run_id, artifact_type, file_name, file_path, content)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, output.artifactType, output.fileName, `outputs/${output.fileName}`, output.content]
    );

    // A task has at most one PRIMARY agent: hand the role to the agent that just ran it.
    await connection.execute(
      `DELETE FROM task_assignments
       WHERE task_id = ? AND assignment_role = 'PRIMARY' AND agent_id <> ?`,
      [taskId, agent.agent_id]
    );
    await connection.execute(
      `INSERT INTO task_assignments (task_id, agent_id, assignment_role)
       VALUES (?, ?, 'PRIMARY')
       ON DUPLICATE KEY UPDATE assigned_at = CURRENT_TIMESTAMP`,
      [taskId, agent.agent_id]
    );

    await connection.execute(
      `UPDATE tasks SET status = ? WHERE task_id = ? AND status = 'IN_PROGRESS'`,
      [nextStatus, taskId]
    );
    await connection.execute(
      `UPDATE agents SET status = 'AVAILABLE' WHERE agent_id = ?`,
      [agent.agent_id]
    );

    if (output.provider !== 'mock') {
      await connection.execute(
        'UPDATE agents SET provider = ?, model_name = ? WHERE agent_id = ?',
        [output.provider, output.model, agent.agent_id]
      );
    }

    await connection.commit();

    return {
      run: {
        agentRunId: runId,
        status: 'SUCCESS',
        latencyMs,
        agent,
        output
      },
      artifact: {
        artifactId: artifactResult.insertId,
        type: output.artifactType,
        fileName: output.fileName,
        filePath: `outputs/${output.fileName}`
      },
      inputs: inputs.map((input) => ({
        artifactId: input.artifact_id,
        fileName: input.file_name,
        taskId: input.task_id,
        taskTitle: input.task_title
      })),
      task: { ...task, status: nextStatus }
    };
  } catch (error) {
    await connection.rollback();
    await finishFailedRun(runId, agent.agent_id, taskId, latencyMs, `Could not save run result: ${error.message}`);
    throw error;
  } finally {
    connection.release();
  }
}

async function findNextEligibleTask(projectId) {
  const [rows] = await pool.execute(
    `SELECT t.*
     FROM tasks t
     WHERE t.project_id = ?
       AND t.status IN ('TODO', 'BLOCKED')
       AND NOT EXISTS (
         SELECT 1
         FROM task_dependencies td
         JOIN tasks dep ON dep.task_id = td.depends_on_task_id
         WHERE td.task_id = t.task_id
           AND dep.status <> 'DONE'
       )
     ORDER BY FIELD(t.priority, 'URGENT', 'HIGH', 'MEDIUM', 'LOW'), t.created_at, t.task_id
     LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

async function runNextTask(projectId) {
  const task = await findNextEligibleTask(projectId);
  if (!task) {
    throw new AppError(404, 'No eligible task is currently ready to run.', 'NO_ELIGIBLE_TASK');
  }
  return runTask(task.task_id);
}

async function approveTask(taskId, reviewerId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the task row so two approvals of the same task cannot interleave.
    const [taskRows] = await connection.execute(
      'SELECT * FROM tasks WHERE task_id = ? FOR UPDATE',
      [taskId]
    );
    if (!taskRows.length) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
    const task = taskRows[0];
    if (task.status !== 'REVIEW') {
      throw new AppError(409, 'Only tasks in REVIEW status can be approved.', 'TASK_NOT_IN_REVIEW');
    }

    // The artifact under review: newest artifact of the latest successful run that
    // has not been reviewed yet. Without one there is nothing to approve.
    const [artifacts] = await connection.execute(
      `SELECT ar.artifact_id, ar.file_name
       FROM agent_runs r
       JOIN artifacts ar ON ar.agent_run_id = r.agent_run_id
       WHERE r.task_id = ?
         AND r.status = 'SUCCESS'
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.artifact_id = ar.artifact_id)
       ORDER BY r.agent_run_id DESC, ar.artifact_id DESC
       LIMIT 1`,
      [taskId]
    );
    if (!artifacts.length) {
      throw new AppError(
        409,
        'There is no unreviewed artifact for this task. Run an agent before approving.',
        'NO_ARTIFACT_TO_REVIEW'
      );
    }

    const [reviewResult] = await connection.execute(
      `INSERT INTO reviews (artifact_id, reviewer_id, status, comment, reviewed_at)
       VALUES (?, ?, 'ACCEPTED', ?, NOW())`,
      [artifacts[0].artifact_id, reviewerId, 'Accepted after human review.']
    );

    await connection.execute(`UPDATE tasks SET status = 'DONE' WHERE task_id = ?`, [taskId]);
    await connection.commit();
    return {
      task: { ...task, status: 'DONE' },
      reviewId: reviewResult.insertId,
      artifact: { artifactId: artifacts[0].artifact_id, fileName: artifacts[0].file_name }
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getProjectDashboard(projectId) {
  const [projectRows] = await pool.execute('SELECT * FROM projects WHERE project_id = ?', [projectId]);
  if (!projectRows.length) throw new AppError(404, 'Project not found.', 'PROJECT_NOT_FOUND');

  const [[taskStats]] = await pool.execute(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'DONE') AS done,
       SUM(status = 'REVIEW') AS review,
       SUM(status = 'IN_PROGRESS') AS in_progress,
       SUM(status = 'BLOCKED') AS blocked
     FROM tasks WHERE project_id = ?`,
    [projectId]
  );

  const [[runStats]] = await pool.execute(
    `SELECT COUNT(*) AS total_runs,
            SUM(r.status = 'SUCCESS') AS successful_runs,
            ROUND(AVG(r.latency_ms), 0) AS avg_latency_ms
     FROM agent_runs r
     JOIN tasks t ON t.task_id = r.task_id
     WHERE t.project_id = ?`,
    [projectId]
  );

  const [recentRuns] = await pool.execute(
    `SELECT
       r.agent_run_id, r.status, r.started_at, r.finished_at, r.latency_ms,
       t.task_id, t.title AS task_title,
       a.agent_id, a.name AS agent_name, a.role AS agent_role
     FROM agent_runs r
     JOIN tasks t ON t.task_id = r.task_id
     JOIN agents a ON a.agent_id = r.agent_id
     WHERE t.project_id = ?
     ORDER BY r.created_at DESC, r.agent_run_id DESC
     LIMIT 8`,
    [projectId]
  );

  return { project: projectRows[0], taskStats, runStats, recentRuns };
}

module.exports = {
  AppError,
  approveTask,
  findDuplicateTask,
  findNextEligibleTask,
  getApprovedInputs,
  getBlockingDependencies,
  getProjectDashboard,
  getTaskContext,
  jaccardSimilarity,
  recommendAssignee,
  runNextTask,
  runTask,
  scoreAgents,
  tokenize
};
