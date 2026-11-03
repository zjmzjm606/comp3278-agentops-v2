# AgentOps ER Diagram

## 1. Conceptual ER diagram (Chen notation)

![AgentOps ER diagram in Chen notation](er_diagram_chen.png)

Source: [`er_diagram_chen.svg`](er_diagram_chen.svg) (vector) · [`er_diagram_chen.png`](er_diagram_chen.png) (for slides).

Notation:

- Rectangle = entity set; the underlined attribute is the primary key.
- Diamond = relationship set; a dashed box attached to a diamond holds the relationship's descriptive attributes.
- `1` / `N` / `M` = mapping cardinality.
- Double line = total participation (every entity must take part); single line = partial participation.

Foreign keys are **not** listed inside the entities: in the conceptual model a link between entities is expressed by a relationship. Foreign keys only appear when the model is mapped to tables (section 2).

### Entity sets

| Entity | Primary key |
|---|---|
| 用户 `users` | `user_id` |
| 项目 `projects` | `project_id` |
| 任务 `tasks` | `task_id` |
| 智能体 `agents` | `agent_id` |
| 运行记录 `agent_runs` | `agent_run_id` |
| 产出物 `artifacts` | `artifact_id` |
| 审核 `reviews` | `review_id` |

### Relationship sets

| Relationship | Between | Cardinality | Participation |
|---|---|---|---|
| 拥有 owns | users — projects | 1 : N | every project has an owner (total) |
| 创建 creates | users — tasks | 1 : N | every task has a creator (total) |
| 包含 contains | projects — tasks | 1 : N | every task belongs to a project (total) |
| 依赖 depends on | tasks — tasks (recursive) | M : N | partial on both sides |
| 分配 assigned to | tasks — agents | M : N, attributes `assignment_role`, `assigned_at` | partial on both sides |
| 运行 is run in | tasks — agent_runs | 1 : N | every run belongs to a task (total) |
| 执行 performs | agents — agent_runs | 1 : N | every run is performed by an agent (total) |
| 产出 produces | agent_runs — artifacts | 1 : N | every artifact comes from a run (total) |
| 评审 reviewed in | artifacts — reviews | 1 : N | every review is about an artifact (total) |
| 撰写 writes | users — reviews | 1 : N | every review has a reviewer (total) |

## 2. Mapping to the relational schema

- Each entity set becomes a table whose primary key is `<entity>_id`.
- Each **1 : N** relationship becomes a foreign key on the N side, named after the key it references where possible (`tasks.project_id → projects.project_id`, `agent_runs.task_id → tasks.task_id`). Role names are used where the same entity appears with a specific role: `projects.owner_id`, `tasks.created_by` and `reviews.reviewer_id` all reference `users.user_id`.
- Each **M : N** relationship becomes its own table whose primary key is the combination of the participating keys:
  - 依赖 → `task_dependencies(task_id, depends_on_task_id)`, both referencing `tasks.task_id`; a `CHECK` forbids a task depending on itself.
  - 分配 → `task_assignments(task_id, agent_id, assignment_role, assigned_at)`, primary key `(task_id, agent_id, assignment_role)`; the descriptive attributes of the relationship become ordinary columns.
- `artifacts.task_id` is also stored on `artifacts` for convenient filtering. It is derivable through `agent_runs` (`artifacts.agent_run_id → agent_runs.task_id`), so the conceptual diagram does not draw a separate tasks — artifacts relationship.

```mermaid
erDiagram
    USERS ||--o{ PROJECTS : owns
    USERS ||--o{ TASKS : creates
    USERS ||--o{ REVIEWS : writes
    PROJECTS ||--o{ TASKS : contains
    TASKS ||--o{ TASK_DEPENDENCIES : "is blocked by"
    TASKS ||--o{ TASK_DEPENDENCIES : blocks
    TASKS ||--o{ TASK_ASSIGNMENTS : "assigned to"
    AGENTS ||--o{ TASK_ASSIGNMENTS : "assigned to"
    TASKS ||--o{ AGENT_RUNS : "is run in"
    AGENTS ||--o{ AGENT_RUNS : performs
    AGENT_RUNS ||--o{ ARTIFACTS : produces
    ARTIFACTS ||--o{ REVIEWS : "reviewed in"

    USERS {
        bigint user_id PK
        varchar username UK
        varchar email UK
        varchar password_hash
        enum role
        timestamp created_at
    }
    PROJECTS {
        bigint project_id PK
        bigint owner_id FK
        varchar name
        text description
        enum status
        timestamp created_at
    }
    TASKS {
        bigint task_id PK
        bigint project_id FK
        bigint created_by FK
        varchar title
        text description
        enum required_role
        enum status
        enum priority
        decimal estimated_hours
        timestamp created_at
        timestamp updated_at
    }
    TASK_DEPENDENCIES {
        bigint task_id PK,FK
        bigint depends_on_task_id PK,FK
    }
    AGENTS {
        bigint agent_id PK
        varchar name UK
        enum role
        varchar provider
        varchar model_name
        enum execution_mode
        enum status
        timestamp created_at
    }
    TASK_ASSIGNMENTS {
        bigint task_id PK,FK
        bigint agent_id PK,FK
        enum assignment_role PK
        timestamp assigned_at
    }
    AGENT_RUNS {
        bigint agent_run_id PK
        bigint task_id FK
        bigint agent_id FK
        enum status
        datetime started_at
        datetime finished_at
        int latency_ms
        text input_summary
        text output_summary
        json raw_output
        text error_message
        varchar model_name
        timestamp created_at
    }
    ARTIFACTS {
        bigint artifact_id PK
        bigint task_id FK
        bigint agent_run_id FK
        enum artifact_type
        varchar file_name
        varchar file_path
        longtext content
        timestamp created_at
    }
    REVIEWS {
        bigint review_id PK
        bigint artifact_id FK
        bigint reviewer_id FK
        enum status
        text comment
        timestamp created_at
        datetime reviewed_at
    }
```

## 3. Notes

- `agent_runs` is an entity rather than a relationship between tasks and agents: the same task and agent can be paired in many runs, each run has its own lifecycle (`QUEUED → RUNNING → SUCCESS/FAILED`), and artifacts reference a specific run.
- `tasks.status` is the current state of a task; `agent_runs` is its execution history.
- `artifacts.content` stores the generated Markdown/code text so the UI can display it without an external file service.
- Agent recommendations, risk scores and duplicate-task warnings are computed on demand from the data above and returned to the UI; they are not stored.
