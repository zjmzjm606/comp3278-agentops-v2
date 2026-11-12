-- 1. Task board: tasks and their primary assigned agent
--    (task_assignments is the M:N "assigned to" relationship between tasks and agents)
SELECT
  t.task_id,
  t.title,
  t.status,
  t.priority,
  t.required_role,
  a.name AS primary_agent
FROM tasks t
LEFT JOIN task_assignments ta
  ON ta.task_id = t.task_id
 AND ta.assignment_role = 'PRIMARY'
LEFT JOIN agents a
  ON a.agent_id = ta.agent_id
WHERE t.project_id = 1
ORDER BY FIELD(t.priority, 'URGENT', 'HIGH', 'MEDIUM', 'LOW'), t.task_id;

-- 2. Tasks blocked by unfinished dependencies
--    (task_dependencies is the recursive M:N "depends on" relationship on tasks)
SELECT
  blocked.task_id AS task_id,
  blocked.title AS blocked_task,
  dep.task_id AS dependency_id,
  dep.title AS unfinished_dependency,
  dep.status AS dependency_status
FROM tasks blocked
JOIN task_dependencies td
  ON td.task_id = blocked.task_id
JOIN tasks dep
  ON dep.task_id = td.depends_on_task_id
WHERE blocked.project_id = 1
  AND dep.status <> 'DONE'
ORDER BY blocked.task_id, dep.task_id;

-- 3. Agent performance: aggregate over execution history
SELECT
  a.agent_id,
  a.name,
  a.role,
  COUNT(r.agent_run_id) AS total_runs,
  SUM(r.status = 'SUCCESS') AS successful_runs,
  ROUND(AVG(r.latency_ms), 0) AS avg_latency_ms
FROM agents a
LEFT JOIN agent_runs r
  ON r.agent_id = a.agent_id
GROUP BY a.agent_id, a.name, a.role
ORDER BY a.agent_id;

-- 4. Full execution trace for one task (task 2 has a run, an artifact and a review in the seed data)
SELECT
  t.task_id,
  t.title AS task_title,
  t.status AS task_status,
  arun.agent_run_id,
  a.name AS agent_name,
  arun.status AS run_status,
  arun.latency_ms,
  art.file_name,
  art.artifact_type,
  rev.status AS review_status,
  rev.comment
FROM tasks t
LEFT JOIN agent_runs arun
  ON arun.task_id = t.task_id
LEFT JOIN agents a
  ON a.agent_id = arun.agent_id
LEFT JOIN artifacts art
  ON art.agent_run_id = arun.agent_run_id
LEFT JOIN reviews rev
  ON rev.artifact_id = art.artifact_id
WHERE t.task_id = 2
ORDER BY arun.created_at, art.artifact_id;

-- 5. What the next agent receives: for each prerequisite of task 3, the latest
--    artifact that a human has ACCEPTED (window function picks one per task)
SELECT task_id, task_title, artifact_id, file_name
FROM (
  SELECT
    dep.task_id,
    dep.title AS task_title,
    ar.artifact_id,
    ar.file_name,
    ROW_NUMBER() OVER (
      PARTITION BY dep.task_id
      ORDER BY ar.created_at DESC, ar.artifact_id DESC
    ) AS rn
  FROM task_dependencies td
  JOIN tasks dep ON dep.task_id = td.depends_on_task_id
  JOIN agent_runs r ON r.task_id = dep.task_id AND r.status = 'SUCCESS'
  JOIN artifacts ar ON ar.agent_run_id = r.agent_run_id
  WHERE td.task_id = 3
    AND EXISTS (
      SELECT 1 FROM reviews rv
      WHERE rv.artifact_id = ar.artifact_id AND rv.status = 'ACCEPTED'
    )
) latest
WHERE rn = 1;

-- 6. Collaboration chain: which upstream artifacts each run actually used
--    (run_inputs is the M:N "uses" relationship between agent_runs and artifacts)
SELECT
  r.agent_run_id,
  t.title AS task_title,
  a.name AS agent_name,
  used.file_name AS input_artifact,
  src.title AS produced_by_task
FROM run_inputs ri
JOIN agent_runs r ON r.agent_run_id = ri.agent_run_id
JOIN tasks t ON t.task_id = r.task_id
JOIN agents a ON a.agent_id = r.agent_id
JOIN artifacts used ON used.artifact_id = ri.artifact_id
JOIN agent_runs src_run ON src_run.agent_run_id = used.agent_run_id
JOIN tasks src ON src.task_id = src_run.task_id
ORDER BY r.agent_run_id, used.artifact_id;
