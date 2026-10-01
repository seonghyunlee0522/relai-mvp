PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,            -- lower-cased
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,                   -- scrypt$N$salt$hash
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                   -- sha256(token); raw token lives only in the cookie
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  project_type       TEXT NOT NULL CHECK (project_type IN
                       ('SI','AI_POC','SAAS_IMPLEMENTATION','MIGRATION','INTERNAL','OTHER')),
  current_situation  TEXT NOT NULL CHECK (current_situation IN
                       ('NOT_STARTED','JUST_STARTED','IN_PROGRESS','TROUBLED')),
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN
                       ('DRAFT','ACTIVE','ON_HOLD','COMPLETED','ARCHIVED')),
  planned_start_date TEXT NOT NULL,              -- YYYY-MM-DD
  planned_end_date   TEXT NOT NULL,              -- YYYY-MM-DD
  current_phase      TEXT NOT NULL DEFAULT 'INITIATION',   -- phase_key of the current project_phases row
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (planned_end_date >= planned_start_date)
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id, status);

-- Defence in depth: a project can only be created by a member of its workspace.
CREATE TRIGGER IF NOT EXISTS trg_projects_creator_is_member
BEFORE INSERT ON projects
WHEN NOT EXISTS (SELECT 1 FROM workspace_members
                 WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by)
BEGIN
  SELECT RAISE(ABORT, 'created_by must be a workspace member');
END;

-- A project can never move to another workspace.
CREATE TRIGGER IF NOT EXISTS trg_projects_workspace_immutable
BEFORE UPDATE OF workspace_id ON projects
BEGIN
  SELECT RAISE(ABORT, 'workspace_id is immutable');
END;

/* ---------- Guided execution (Phase 2) ---------- */
CREATE TABLE IF NOT EXISTS project_phases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,                     -- which template produced this phase set
  phase_key    TEXT NOT NULL,                     -- INITIATION, REQUIREMENTS, …
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  sequence     INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  started_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, phase_key),
  UNIQUE (project_id, sequence)
);

CREATE TABLE IF NOT EXISTS project_steps (
  id                  TEXT PRIMARY KEY,
  project_phase_id    TEXT NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
  step_key            TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  completion_criteria TEXT NOT NULL DEFAULT '',
  sequence            INTEGER NOT NULL,
  is_required         INTEGER NOT NULL DEFAULT 1,
  linked_feature_type TEXT,                       -- future: requirements | wbs | issues | changes | tests | acceptance
  status              TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','COMPLETED')),
  note                TEXT NOT NULL DEFAULT '',
  completed_at        TEXT,
  completed_by        TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_phase_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_steps_phase ON project_steps(project_phase_id, sequence);

-- Current-phase change log. Shape is generic enough to become the project activity log later.
CREATE TABLE IF NOT EXISTS phase_transitions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_phase_id TEXT REFERENCES project_phases(id),
  to_phase_id   TEXT NOT NULL REFERENCES project_phases(id),
  reason        TEXT NOT NULL DEFAULT 'MANUAL',   -- PROJECT_CREATED | NEXT | MANUAL | BACKFILL
  changed_by    TEXT REFERENCES users(id),
  changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_transitions_project ON phase_transitions(project_id, changed_at);

/* ---------- Requirement management (Phase 3) ---------- */
-- Per-project counters (display_id numbering). Incremented atomically inside the create transaction.
CREATE TABLE IF NOT EXISTS project_counters (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,                       -- 'REQ' (later: 'WBS', 'CR', 'ISS', …)
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS requirements (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number        INTEGER NOT NULL,
  display_id             TEXT NOT NULL,           -- REQ-001 … never reused, even after archive
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  type                   TEXT NOT NULL DEFAULT 'UNSPECIFIED' CHECK (type IN
                           ('UNSPECIFIED','FUNCTIONAL','NON_FUNCTIONAL','INTERFACE','DATA','SECURITY','OPERATION','OTHER')),
  priority               TEXT NOT NULL DEFAULT 'UNSPECIFIED' CHECK (priority IN ('UNSPECIFIED','HIGH','MEDIUM','LOW')),
  scope                  TEXT NOT NULL DEFAULT 'UNDECIDED' CHECK (scope IN ('UNDECIDED','IN_SCOPE','OUT_OF_SCOPE')),
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEWING','CONFIRMED','ON_HOLD','REJECTED')),
  requester_name         TEXT NOT NULL DEFAULT '',
  requester_organization TEXT NOT NULL DEFAULT '',
  owner_user_id          TEXT REFERENCES users(id),
  archived_at            TEXT,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id),
  UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project_id, archived_at, sequence_number);

-- Owner must belong to the project's workspace (defence in depth; the API checks too).
CREATE TRIGGER IF NOT EXISTS trg_req_owner_is_member_ins
BEFORE INSERT ON requirements
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id
  WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_req_owner_is_member_upd
BEFORE UPDATE OF owner_user_id ON requirements
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id
  WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_req_project_immutable
BEFORE UPDATE OF project_id ON requirements
BEGIN SELECT RAISE(ABORT, 'project_id is immutable'); END;

CREATE TABLE IF NOT EXISTS requirement_criteria (
  id             TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_criteria_req ON requirement_criteria(requirement_id, sequence);

-- Meaningful change log (only when a value actually changed).
CREATE TABLE IF NOT EXISTS requirement_history (
  id             TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  action_type    TEXT NOT NULL,                   -- CREATED | UPDATED | ARCHIVED | CRITERION_ADDED | CRITERION_UPDATED | CRITERION_REMOVED
  field_name     TEXT,                            -- for UPDATED: title | description | type | priority | scope | status | owner_user_id | requester
  old_value      TEXT,
  new_value      TEXT,
  changed_by     TEXT REFERENCES users(id),
  changed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_change_request_id TEXT                 -- optional: the CR that motivated this change (Phase 6)
);
CREATE INDEX IF NOT EXISTS idx_req_history ON requirement_history(requirement_id, changed_at);

/* ---------- WBS management (Phase 4) ---------- */
CREATE TABLE IF NOT EXISTS wbs_items (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id          TEXT REFERENCES wbs_items(id),
  sequence           INTEGER NOT NULL DEFAULT 0,  -- order among siblings (1-based after renumber)
  wbs_code           TEXT NOT NULL DEFAULT '',    -- display only: 1, 1.1, 2.1.3 … recomputed on structure change
  item_type          TEXT NOT NULL CHECK (item_type IN ('SUMMARY','TASK','MILESTONE')),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  owner_user_id      TEXT REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED','ON_HOLD')),
  progress           INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  planned_start_date TEXT,
  planned_end_date   TEXT,
  actual_start_date  TEXT,
  actual_end_date    TEXT,
  milestone_date     TEXT,
  archived_at        TEXT,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (planned_end_date IS NULL OR planned_start_date IS NULL OR planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);
CREATE INDEX IF NOT EXISTS idx_wbs_project ON wbs_items(project_id, archived_at, parent_id, sequence);

CREATE TRIGGER IF NOT EXISTS trg_wbs_owner_is_member_ins
BEFORE INSERT ON wbs_items
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id
  WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_wbs_owner_is_member_upd
BEFORE UPDATE OF owner_user_id ON wbs_items
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id
  WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
-- Parent must be in the same project.
CREATE TRIGGER IF NOT EXISTS trg_wbs_parent_same_project
BEFORE INSERT ON wbs_items
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wbs_items p WHERE p.id = NEW.parent_id AND p.project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'parent must belong to the same project'); END;
CREATE TRIGGER IF NOT EXISTS trg_wbs_parent_same_project_upd
BEFORE UPDATE OF parent_id ON wbs_items
WHEN NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR NOT EXISTS (SELECT 1 FROM wbs_items p WHERE p.id = NEW.parent_id AND p.project_id = NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid parent'); END;
CREATE TRIGGER IF NOT EXISTS trg_wbs_project_immutable
BEFORE UPDATE OF project_id ON wbs_items
BEGIN SELECT RAISE(ABORT, 'project_id is immutable'); END;

-- Finish-to-start predecessor links. Many predecessors per item; cycle check is done in code before insert.
CREATE TABLE IF NOT EXISTS wbs_dependencies (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id  TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  successor_id    TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'FINISH_TO_START' CHECK (dependency_type IN ('FINISH_TO_START')),
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX IF NOT EXISTS idx_wbsdep_project ON wbs_dependencies(project_id);
CREATE INDEX IF NOT EXISTS idx_wbsdep_succ ON wbs_dependencies(successor_id);
CREATE TRIGGER IF NOT EXISTS trg_wbsdep_same_project
BEFORE INSERT ON wbs_dependencies
WHEN NOT EXISTS (SELECT 1 FROM wbs_items a JOIN wbs_items b ON a.project_id = b.project_id
  WHERE a.id = NEW.predecessor_id AND b.id = NEW.successor_id AND a.project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'dependency must link items of the same project'); END;

/* ---------- Requirement ↔ WBS traceability (Phase 5) ---------- */
-- N:M junction. Rows are kept when either side is archived (history); reads/coverage filter on archived_at.
CREATE TABLE IF NOT EXISTS requirement_wbs_links (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  wbs_item_id    TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  link_type      TEXT NOT NULL DEFAULT 'IMPLEMENTS' CHECK (link_type IN ('IMPLEMENTS','SUPPORTS','VALIDATES')),
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (requirement_id, wbs_item_id)
);
CREATE INDEX IF NOT EXISTS idx_rwl_req ON requirement_wbs_links(requirement_id);
CREATE INDEX IF NOT EXISTS idx_rwl_wbs ON requirement_wbs_links(wbs_item_id);
CREATE INDEX IF NOT EXISTS idx_rwl_project ON requirement_wbs_links(project_id);
-- Both ends must belong to the link's project.
CREATE TRIGGER IF NOT EXISTS trg_rwl_same_project
BEFORE INSERT ON requirement_wbs_links
WHEN NOT EXISTS (SELECT 1 FROM requirements r JOIN wbs_items w ON w.project_id = r.project_id
  WHERE r.id = NEW.requirement_id AND w.id = NEW.wbs_item_id AND r.project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'link must connect a requirement and a WBS item of the same project'); END;

/* ---------- Change requests & impact (Phase 6) ---------- */
CREATE TABLE IF NOT EXISTS change_requests (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number        INTEGER NOT NULL,
  display_id             TEXT NOT NULL,           -- CR-001 … never reused
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  reason                 TEXT NOT NULL DEFAULT '',
  requester_name         TEXT NOT NULL DEFAULT '',
  requester_organization TEXT NOT NULL DEFAULT '',
  priority               TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('HIGH','MEDIUM','LOW')),
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','UNDER_REVIEW','APPROVED','REJECTED','IMPLEMENTED')),
  schedule_impact_days   INTEGER CHECK (schedule_impact_days IS NULL OR schedule_impact_days >= 0),
  effort_impact_md       REAL    CHECK (effort_impact_md IS NULL OR effort_impact_md >= 0),
  cost_impact            INTEGER CHECK (cost_impact IS NULL OR cost_impact >= 0),   -- KRW, whole won
  cost_currency          TEXT NOT NULL DEFAULT 'KRW',
  decision_note          TEXT NOT NULL DEFAULT '',
  requested_at           TEXT,                    -- YYYY-MM-DD (date the request was raised)
  submitted_at           TEXT,                    -- DRAFT → UNDER_REVIEW
  reviewed_by            TEXT REFERENCES users(id),
  reviewed_at            TEXT,
  approved_at            TEXT,
  rejected_at            TEXT,
  implemented_at         TEXT,
  archived_at            TEXT,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id),
  UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_cr_project ON change_requests(project_id, archived_at, status);
CREATE TRIGGER IF NOT EXISTS trg_cr_project_immutable
BEFORE UPDATE OF project_id ON change_requests
BEGIN SELECT RAISE(ABORT, 'project_id is immutable'); END;

CREATE TABLE IF NOT EXISTS change_request_requirements (
  id                TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  requirement_id    TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  relation_type     TEXT NOT NULL DEFAULT 'MODIFIES' CHECK (relation_type IN ('MODIFIES','ADDS','REMOVES')),
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (change_request_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_crr_req ON change_request_requirements(requirement_id);
CREATE TRIGGER IF NOT EXISTS trg_crr_same_project
BEFORE INSERT ON change_request_requirements
WHEN NOT EXISTS (SELECT 1 FROM change_requests c JOIN requirements r ON r.project_id = c.project_id
  WHERE c.id = NEW.change_request_id AND r.id = NEW.requirement_id)
BEGIN SELECT RAISE(ABORT, 'requirement must belong to the change request project'); END;

CREATE TABLE IF NOT EXISTS change_request_wbs_impacts (
  id                TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  wbs_item_id       TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  impact_type       TEXT NOT NULL DEFAULT 'SCHEDULE' CHECK (impact_type IN ('SCHEDULE','SCOPE','REWORK','NEW_WORK','NONE')),
  impact_note       TEXT NOT NULL DEFAULT '',
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (change_request_id, wbs_item_id)
);
CREATE INDEX IF NOT EXISTS idx_crw_wbs ON change_request_wbs_impacts(wbs_item_id);
CREATE TRIGGER IF NOT EXISTS trg_crw_same_project
BEFORE INSERT ON change_request_wbs_impacts
WHEN NOT EXISTS (SELECT 1 FROM change_requests c JOIN wbs_items w ON w.project_id = c.project_id
  WHERE c.id = NEW.change_request_id AND w.id = NEW.wbs_item_id)
BEGIN SELECT RAISE(ABORT, 'wbs item must belong to the change request project'); END;

CREATE TABLE IF NOT EXISTS change_request_history (
  id                TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL,   -- CREATED | STATUS_CHANGED | UPDATED | REQUIREMENT_LINKED | REQUIREMENT_UNLINKED | WBS_IMPACT_ADDED | WBS_IMPACT_UPDATED | WBS_IMPACT_REMOVED | ARCHIVED
  field_name        TEXT,
  old_value         TEXT,
  new_value         TEXT,
  changed_by        TEXT REFERENCES users(id),
  changed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cr_history ON change_request_history(change_request_id, changed_at);

/* ---------- Issues & Risks (Phase 7) ---------- */
CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  display_id      TEXT NOT NULL,                  -- ISS-001
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','BLOCKED','RESOLVED','CLOSED')),
  severity        TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  owner_user_id   TEXT REFERENCES users(id),
  identified_at   TEXT,                           -- YYYY-MM-DD
  due_date        TEXT,
  resolved_at     TEXT,
  closed_at       TEXT,
  resolution      TEXT NOT NULL DEFAULT '',
  source_risk_id  TEXT REFERENCES risks(id),
  source_test_execution_id TEXT,              -- Phase 8: issue raised from a failed test execution
  archived_at     TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, archived_at, status);
CREATE INDEX IF NOT EXISTS idx_issues_source ON issues(source_risk_id);

CREATE TABLE IF NOT EXISTS risks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number   INTEGER NOT NULL,
  display_id        TEXT NOT NULL,                -- RSK-001
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  probability       TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (probability IN ('LOW','MEDIUM','HIGH')),
  impact            TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  risk_level        TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),  -- derived (probability × impact), stored for filtering
  response_strategy TEXT CHECK (response_strategy IS NULL OR response_strategy IN ('AVOID','MITIGATE','TRANSFER','ACCEPT')),
  mitigation_plan   TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MONITORING','MATERIALIZED','CLOSED')),
  owner_user_id     TEXT REFERENCES users(id),
  identified_at     TEXT,
  review_date       TEXT,
  materialized_at   TEXT,
  closed_at         TEXT,
  archived_at       TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id, archived_at, status);

-- Owner must be a workspace member (same rule as requirements / wbs).
CREATE TRIGGER IF NOT EXISTS trg_issue_owner_ins BEFORE INSERT ON issues
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_issue_owner_upd BEFORE UPDATE OF owner_user_id ON issues
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_risk_owner_ins BEFORE INSERT ON risks
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_risk_owner_upd BEFORE UPDATE OF owner_user_id ON risks
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_issue_source_same_project BEFORE INSERT ON issues
WHEN NEW.source_risk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM risks r WHERE r.id = NEW.source_risk_id AND r.project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'source risk must belong to the same project'); END;

-- One polymorphic junction for Issue/Risk → WBS / Requirement / Change request (IssueWBSLink, RiskRequirementLink, … in the spec).
CREATE TABLE IF NOT EXISTS raid_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('ISSUE','RISK')),
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('WBS','REQUIREMENT','CHANGE')),
  target_id   TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_type, source_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_raid_source ON raid_links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_raid_target ON raid_links(target_type, target_id);
-- Both ends must exist in the link's project (no FK across polymorphic targets, so a trigger enforces it).
CREATE TRIGGER IF NOT EXISTS trg_raid_same_project BEFORE INSERT ON raid_links
WHEN NOT (
  (CASE NEW.source_type WHEN 'ISSUE' THEN EXISTS (SELECT 1 FROM issues x WHERE x.id = NEW.source_id AND x.project_id = NEW.project_id)
                        ELSE EXISTS (SELECT 1 FROM risks x WHERE x.id = NEW.source_id AND x.project_id = NEW.project_id) END)
  AND (CASE NEW.target_type WHEN 'WBS' THEN EXISTS (SELECT 1 FROM wbs_items x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id)
                            WHEN 'REQUIREMENT' THEN EXISTS (SELECT 1 FROM requirements x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id)
                            ELSE EXISTS (SELECT 1 FROM change_requests x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id) END))
BEGIN SELECT RAISE(ABORT, 'link ends must belong to the same project'); END;

CREATE TABLE IF NOT EXISTS raid_history (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('ISSUE','RISK')),
  entity_id   TEXT NOT NULL,
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | STATUS_CHANGED | LINKED | UNLINKED | CONVERTED | ARCHIVED
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT REFERENCES users(id),
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raid_history ON raid_history(entity_type, entity_id, changed_at);

/* ---------- Test & Acceptance (Phase 8) ---------- */
CREATE TABLE IF NOT EXISTS test_cases (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  display_id      TEXT NOT NULL,                  -- TC-001
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  precondition    TEXT NOT NULL DEFAULT '',
  steps           TEXT NOT NULL DEFAULT '[]',     -- ordered JSON array of {instruction, expected}
  expected_result TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','BLOCKED','COMPLETED')),
  priority        TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('HIGH','MEDIUM','LOW')),
  owner_user_id   TEXT REFERENCES users(id),
  archived_at     TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_tc_project ON test_cases(project_id, archived_at, status);
CREATE TRIGGER IF NOT EXISTS trg_tc_owner_ins BEFORE INSERT ON test_cases
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;
CREATE TRIGGER IF NOT EXISTS trg_tc_owner_upd BEFORE UPDATE OF owner_user_id ON test_cases
WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'owner must be a workspace member'); END;

-- Immutable execution log. Latest execution_number = last result.
CREATE TABLE IF NOT EXISTS test_executions (
  id               TEXT PRIMARY KEY,
  test_case_id     TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  execution_number INTEGER NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('PASS','FAIL','BLOCKED','NOT_RUN')),
  actual_result    TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  executed_by      TEXT REFERENCES users(id),
  executed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (test_case_id, execution_number)
);
CREATE INDEX IF NOT EXISTS idx_te_case ON test_executions(test_case_id, execution_number);

-- RequirementTestLink + WBSTestLink in one junction.
CREATE TABLE IF NOT EXISTS test_links (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('REQUIREMENT','WBS')),
  target_id    TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (test_case_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_tl_target ON test_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tl_case ON test_links(test_case_id);
CREATE TRIGGER IF NOT EXISTS trg_tl_same_project BEFORE INSERT ON test_links
WHEN NOT (EXISTS (SELECT 1 FROM test_cases t WHERE t.id = NEW.test_case_id AND t.project_id = NEW.project_id)
  AND (CASE NEW.target_type WHEN 'REQUIREMENT' THEN EXISTS (SELECT 1 FROM requirements x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id)
       ELSE EXISTS (SELECT 1 FROM wbs_items x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id) END))
BEGIN SELECT RAISE(ABORT, 'link ends must belong to the same project'); END;

CREATE TABLE IF NOT EXISTS acceptances (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  display_id      TEXT NOT NULL,                  -- ACC-001
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REQUESTED','ACCEPTED','REJECTED','REWORK_REQUIRED')),
  requested_at    TEXT,
  due_date        TEXT,
  accepted_at     TEXT,
  rejected_at     TEXT,
  decision_note   TEXT NOT NULL DEFAULT '',
  archived_at     TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_project ON acceptances(project_id, archived_at, status);

-- AcceptanceRequirementLink + AcceptanceTestLink.
CREATE TABLE IF NOT EXISTS acceptance_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  acceptance_id TEXT NOT NULL REFERENCES acceptances(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('REQUIREMENT','TEST')),
  target_id     TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (acceptance_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_al_target ON acceptance_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_al_acc ON acceptance_links(acceptance_id);
CREATE TRIGGER IF NOT EXISTS trg_al_same_project BEFORE INSERT ON acceptance_links
WHEN NOT (EXISTS (SELECT 1 FROM acceptances a WHERE a.id = NEW.acceptance_id AND a.project_id = NEW.project_id)
  AND (CASE NEW.target_type WHEN 'REQUIREMENT' THEN EXISTS (SELECT 1 FROM requirements x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id)
       ELSE EXISTS (SELECT 1 FROM test_cases x WHERE x.id = NEW.target_id AND x.project_id = NEW.project_id) END))
BEGIN SELECT RAISE(ABORT, 'link ends must belong to the same project'); END;

CREATE TABLE IF NOT EXISTS qa_history (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('TEST','ACCEPTANCE')),
  entity_id   TEXT NOT NULL,
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | STATUS_CHANGED | LINKED | UNLINKED | EXECUTED | ISSUE_RAISED | ARCHIVED
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT REFERENCES users(id),
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_qa_history ON qa_history(entity_type, entity_id, changed_at);

-- ---------- Phase 9: Weekly Report ----------
-- structured_content: JSON { period, data:{...}, sections:[{key,title,body}] }; rendered_content: markdown derived from sections.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL')),
  structured_content TEXT NOT NULL DEFAULT '{}',
  rendered_content   TEXT NOT NULL DEFAULT '',
  generated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finalized_at       TEXT,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_project ON weekly_reports(project_id, period_start DESC);
CREATE TRIGGER IF NOT EXISTS trg_weekly_reports_project_immutable
BEFORE UPDATE OF project_id ON weekly_reports
BEGIN SELECT RAISE(ABORT, 'project_id is immutable'); END;
