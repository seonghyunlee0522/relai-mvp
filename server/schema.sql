-- RELAI schema — PostgreSQL. Applied idempotently by server/migrations.js (CREATE … IF NOT EXISTS / CREATE OR REPLACE).
-- Legacy SQLite version kept at docs/schema.sqlite.legacy.sql for the data migration script.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,            -- lower-cased
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,                   -- scrypt$N$salt$hash
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Phase 10B: account status + service-operator role. system_role is deliberately NOT the workspace role
  -- (that lives on workspace_members.role) — the two are unrelated permission systems.
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DEACTIVATED')),
  system_role   TEXT NOT NULL DEFAULT 'NONE' CHECK (system_role IN ('NONE','SYSTEM_ADMIN')),
  last_login_at timestamptz,
  suspended_at  timestamptz
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS system_role TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE','SUSPENDED','DEACTIVATED')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_system_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_system_role_check CHECK (system_role IN ('NONE','SYSTEM_ADMIN')); END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);                    -- admin: signups by date, list ordering
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);                          -- admin: status filter, suspended attention
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);               -- admin: activation / recency

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                   -- sha256(token); raw token lives only in the cookie
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),  -- Phase 10B
  suspended_at timestamptz
);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_status_check') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')); END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_workspaces_created ON workspaces(created_at);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER')),
  created_at   timestamptz NOT NULL DEFAULT now(),
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
  planned_start_date date NOT NULL,              -- YYYY-MM-DD
  planned_end_date   date NOT NULL,              -- YYYY-MM-DD
  current_phase      TEXT NOT NULL DEFAULT 'INITIATION',   -- phase_key of the current project_phases row
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_date >= planned_start_date)
);

/* ---------- Project definition (Phase 12b: 착수 입력 → 프로젝트 정의) ----------
 * One row per project. List-type sections are JSON arrays in TEXT (same convention as other JSON columns here).
 * Section completion is NOT stored here: it is the INITIATION step status in project_steps (GOALS/SCOPE/STAKEHOLDERS/
 * MILESTONES/OPERATIONS), so the home progress keeps reading one source. `section_updated` records when each section
 * was last edited so "completed, then changed" can be shown and re-confirmed. */
CREATE TABLE IF NOT EXISTS project_definitions (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  goal              TEXT NOT NULL DEFAULT '',
  success_criteria  TEXT NOT NULL DEFAULT '[]',   -- [{id, text}]
  scope_in          TEXT NOT NULL DEFAULT '[]',   -- [{id, text}]
  scope_out         TEXT NOT NULL DEFAULT '[]',   -- [{id, text}]
  stakeholders      TEXT NOT NULL DEFAULT '[]',   -- [{id, name, org, role, area, authority}]
  key_dates         TEXT NOT NULL DEFAULT '[]',   -- [{id, title, date, note}]
  operations        TEXT NOT NULL DEFAULT '{}',   -- {meetings, reporting, communication, decisions}
  memo              TEXT NOT NULL DEFAULT '',
  section_updated   TEXT NOT NULL DEFAULT '{}',   -- {GOALS: ts, SCOPE: ts, ...}
  updated_by        TEXT REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

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
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
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
  completed_at        timestamptz,
  completed_by        TEXT REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_phase_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_steps_phase ON project_steps(project_phase_id, sequence);

-- Current-phase change log. Shape is generic enough to become the project activity log later.
CREATE TABLE IF NOT EXISTS phase_transitions (
  id            TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_phase_id TEXT REFERENCES project_phases(id),
  to_phase_id   TEXT NOT NULL REFERENCES project_phases(id),
  reason        TEXT NOT NULL DEFAULT 'MANUAL',   -- PROJECT_CREATED | NEXT | MANUAL | BACKFILL
  changed_by    TEXT REFERENCES users(id),
  changed_at    timestamptz NOT NULL DEFAULT now()
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
  archived_at            timestamptz,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, display_id),
  UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project_id, archived_at, sequence_number);

CREATE TABLE IF NOT EXISTS requirement_criteria (
  id             TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_criteria_req ON requirement_criteria(requirement_id, sequence);

-- Meaningful change log (only when a value actually changed).
CREATE TABLE IF NOT EXISTS requirement_history (
  id             TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  action_type    TEXT NOT NULL,                   -- CREATED | UPDATED | ARCHIVED | CRITERION_ADDED | CRITERION_UPDATED | CRITERION_REMOVED
  field_name     TEXT,                            -- for UPDATED: title | description | type | priority | scope | status | owner_user_id | requester
  old_value      TEXT,
  new_value      TEXT,
  changed_by     TEXT REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now(),
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
  planned_start_date date,
  planned_end_date   date,
  actual_start_date  date,
  actual_end_date    date,
  milestone_date     date,
  archived_at        timestamptz,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_date IS NULL OR planned_start_date IS NULL OR planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);
CREATE INDEX IF NOT EXISTS idx_wbs_project ON wbs_items(project_id, archived_at, parent_id, sequence);
-- Tree WBS (Phase 12): depth is maintained by renumber(); weight drives the parent progress roll-up (0 = excluded).
-- SUMMARY is legacy: new data uses TASK, and "group" simply means "has live children".
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1000);

-- Finish-to-start predecessor links. Many predecessors per item; cycle check is done in code before insert.
CREATE TABLE IF NOT EXISTS wbs_dependencies (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id  TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  successor_id    TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'FINISH_TO_START' CHECK (dependency_type IN ('FINISH_TO_START')),
  created_by      TEXT REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX IF NOT EXISTS idx_wbsdep_project ON wbs_dependencies(project_id);
CREATE INDEX IF NOT EXISTS idx_wbsdep_succ ON wbs_dependencies(successor_id);

-- WBS change log (mirrors requirement_history). Rows go away with the item (items are archived, never deleted).
CREATE TABLE IF NOT EXISTS wbs_history (
  id          TEXT PRIMARY KEY,
  seq         BIGSERIAL,
  wbs_item_id TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | MOVED | ARCHIVED | DEP_ADDED | DEP_REMOVED | LINKED_REQ | UNLINKED_REQ | LINK_TYPE_CHANGED
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wbs_history ON wbs_history(wbs_item_id, changed_at);

/* ---------- Requirement ↔ WBS traceability (Phase 5) ---------- */
-- N:M junction. Rows are kept when either side is archived (history); reads/coverage filter on archived_at.
CREATE TABLE IF NOT EXISTS requirement_wbs_links (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  wbs_item_id    TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  link_type      TEXT NOT NULL DEFAULT 'IMPLEMENTS' CHECK (link_type IN ('IMPLEMENTS','SUPPORTS','VALIDATES')),
  created_by     TEXT REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, wbs_item_id)
);
CREATE INDEX IF NOT EXISTS idx_rwl_req ON requirement_wbs_links(requirement_id);
CREATE INDEX IF NOT EXISTS idx_rwl_wbs ON requirement_wbs_links(wbs_item_id);
CREATE INDEX IF NOT EXISTS idx_rwl_project ON requirement_wbs_links(project_id);

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
  effort_impact_md       double precision    CHECK (effort_impact_md IS NULL OR effort_impact_md >= 0),
  cost_impact            INTEGER CHECK (cost_impact IS NULL OR cost_impact >= 0),   -- KRW, whole won
  cost_currency          TEXT NOT NULL DEFAULT 'KRW',
  decision_note          TEXT NOT NULL DEFAULT '',
  requested_at           date,                    -- date the request was raised
  submitted_at           timestamptz,                    -- DRAFT → UNDER_REVIEW
  reviewed_by            TEXT REFERENCES users(id),
  reviewed_at            timestamptz,
  approved_at            timestamptz,
  rejected_at            timestamptz,
  implemented_at         timestamptz,
  archived_at            timestamptz,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, display_id),
  UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_cr_project ON change_requests(project_id, archived_at, status);

CREATE TABLE IF NOT EXISTS change_request_requirements (
  id                TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  requirement_id    TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  relation_type     TEXT NOT NULL DEFAULT 'MODIFIES' CHECK (relation_type IN ('MODIFIES','ADDS','REMOVES')),
  created_by        TEXT REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_request_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_crr_req ON change_request_requirements(requirement_id);

CREATE TABLE IF NOT EXISTS change_request_wbs_impacts (
  id                TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  wbs_item_id       TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  impact_type       TEXT NOT NULL DEFAULT 'SCHEDULE' CHECK (impact_type IN ('SCHEDULE','SCOPE','REWORK','NEW_WORK','NONE')),
  impact_note       TEXT NOT NULL DEFAULT '',
  created_by        TEXT REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_request_id, wbs_item_id)
);
CREATE INDEX IF NOT EXISTS idx_crw_wbs ON change_request_wbs_impacts(wbs_item_id);

CREATE TABLE IF NOT EXISTS change_request_history (
  id                TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL,   -- CREATED | STATUS_CHANGED | UPDATED | REQUIREMENT_LINKED | REQUIREMENT_UNLINKED | WBS_IMPACT_ADDED | WBS_IMPACT_UPDATED | WBS_IMPACT_REMOVED | ARCHIVED
  field_name        TEXT,
  old_value         TEXT,
  new_value         TEXT,
  changed_by        TEXT REFERENCES users(id),
  changed_at        timestamptz NOT NULL DEFAULT now()
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
  identified_at   date,                           -- YYYY-MM-DD
  due_date        date,
  resolved_at     timestamptz,
  closed_at       timestamptz,
  resolution      TEXT NOT NULL DEFAULT '',
  source_risk_id  TEXT,                       -- FK added after risks is created (see below)
  source_test_execution_id TEXT,              -- Phase 8: issue raised from a failed test execution
  archived_at     timestamptz,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
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
  identified_at     date,
  review_date       date,
  materialized_at   timestamptz,
  closed_at         timestamptz,
  archived_at       timestamptz,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id, archived_at, status);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_source_risk_fk') THEN
    ALTER TABLE issues ADD CONSTRAINT issues_source_risk_fk FOREIGN KEY (source_risk_id) REFERENCES risks(id);
  END IF;
END $$;

-- One polymorphic junction for Issue/Risk → WBS / Requirement / Change request (IssueWBSLink, RiskRequirementLink, … in the spec).
CREATE TABLE IF NOT EXISTS raid_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('ISSUE','RISK')),
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('WBS','REQUIREMENT','CHANGE')),
  target_id   TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_raid_source ON raid_links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_raid_target ON raid_links(target_type, target_id);

CREATE TABLE IF NOT EXISTS raid_history (
  id          TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('ISSUE','RISK')),
  entity_id   TEXT NOT NULL,
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | STATUS_CHANGED | LINKED | UNLINKED | CONVERTED | ARCHIVED
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
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
  archived_at     timestamptz,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, display_id), UNIQUE (project_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_tc_project ON test_cases(project_id, archived_at, status);

-- Immutable execution log. Latest execution_number = last result.
CREATE TABLE IF NOT EXISTS test_executions (
  id               TEXT PRIMARY KEY,
  test_case_id     TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  execution_number INTEGER NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('PASS','FAIL','BLOCKED','NOT_RUN')),
  actual_result    TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  executed_by      TEXT REFERENCES users(id),
  executed_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
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
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_case_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_tl_target ON test_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tl_case ON test_links(test_case_id);

CREATE TABLE IF NOT EXISTS acceptances (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  display_id      TEXT NOT NULL,                  -- ACC-001
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REQUESTED','ACCEPTED','REJECTED','REWORK_REQUIRED')),
  requested_at    timestamptz,
  due_date        date,
  accepted_at     timestamptz,
  rejected_at     timestamptz,
  decision_note   TEXT NOT NULL DEFAULT '',
  archived_at     timestamptz,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
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
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (acceptance_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_al_target ON acceptance_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_al_acc ON acceptance_links(acceptance_id);

CREATE TABLE IF NOT EXISTS qa_history (
  id          TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('TEST','ACCEPTANCE')),
  entity_id   TEXT NOT NULL,
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | STATUS_CHANGED | LINKED | UNLINKED | EXECUTED | ISSUE_RAISED | ARCHIVED
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qa_history ON qa_history(entity_type, entity_id, changed_at);

-- ---------- Phase 9: Weekly Report ----------
-- structured_content: JSON { period, data:{...}, sections:[{key,title,body}] }; rendered_content: markdown derived from sections.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL')),
  structured_content TEXT NOT NULL DEFAULT '{}',
  rendered_content   TEXT NOT NULL DEFAULT '',
  generated_at       timestamptz NOT NULL DEFAULT now(),
  finalized_at       timestamptz,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_project ON weekly_reports(project_id, period_start DESC);

/* ---------- Comments (requirements / WBS items) ---------- */
-- Polymorphic by (entity_type, entity_id); the API verifies the entity belongs to project_id before every read/write.
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  seq         BIGSERIAL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('REQUIREMENT','WBS')),
  entity_id   TEXT NOT NULL,
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_type, entity_id, created_at);

/* ---------- Admin Console (Phase 10B): operator actions only. Never mixed with project-level history tables. ---------- */
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id            TEXT PRIMARY KEY,
  seq           BIGSERIAL,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,                   -- SUSPEND_USER | REACTIVATE_USER | SUSPEND_WORKSPACE | REACTIVATE_WORKSPACE | …
  target_type   TEXT NOT NULL,                   -- USER | WORKSPACE | SUBSCRIPTION | PAYMENT
  target_id     TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- target label at the time (email / workspace name), reason …; never secrets
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_logs(admin_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_logs(target_type, target_id, created_at);

/* ---------- AI Productivity Layer (Phase 11): run log + workspace credit metering. Pricing is NOT decided here. ---------- */
CREATE TABLE IF NOT EXISTS ai_runs (
  id             TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id),
  feature        TEXT NOT NULL,                  -- REQUIREMENT_EXTRACTION | WBS_GENERATION | CHANGE_IMPACT | PROJECT_QA
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  input_summary  TEXT NOT NULL DEFAULT '',       -- short, non-sensitive description (sizes / ids), never the raw input
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  provider_cost_amount   NUMERIC(12,6),          -- estimated from the internal price table (ops analytics only)
  provider_cost_currency TEXT NOT NULL DEFAULT 'USD',
  credit_cost    INTEGER NOT NULL DEFAULT 0,
  credit_status  TEXT NOT NULL DEFAULT 'NONE' CHECK (credit_status IN ('NONE','RESERVED','CHARGED','RELEASED')),
  latency_ms     INTEGER,
  error_code     TEXT,
  error_message  TEXT,                           -- short message only; never the provider's raw body
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_workspace ON ai_runs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_project ON ai_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_user ON ai_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_feature ON ai_runs(feature, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_status ON ai_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_runs(created_at);

CREATE TABLE IF NOT EXISTS workspace_credit_accounts (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  balance          BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- fast read; the ledger is the audit source
  lifetime_granted BIGINT NOT NULL DEFAULT 0,
  lifetime_used    BIGINT NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id             TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ai_run_id      TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  type           TEXT NOT NULL CHECK (type IN ('PLAN_GRANT','ADMIN_GRANT','AI_USAGE','REFUND','ADJUSTMENT','PROMOTION')),
  amount         BIGINT NOT NULL,                -- grant = positive, usage = negative
  balance_after  BIGINT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  reference_type TEXT,                           -- AI_RUN | ADMIN_AUDIT | PLAN | …
  reference_id   TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_workspace ON credit_ledger(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_created ON credit_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_run ON credit_ledger(ai_run_id);

/* ================= Integrity triggers (plpgsql) =================
   Defence in depth. Every rule here is also enforced by the service layer (common.js resolveLinkTarget etc.).
   Each trigger raises SQLSTATE 'RL001' (mapped to HTTP 400 by the API error handler). */
CREATE OR REPLACE FUNCTION rl_fail(msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING MESSAGE = msg, ERRCODE = 'RL001'; END $$;

CREATE OR REPLACE FUNCTION trg_projects_creator_is_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by) THEN PERFORM rl_fail('created_by must be a workspace member'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_projects_creator_is_member ON projects;
CREATE TRIGGER trg_projects_creator_is_member BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION trg_projects_creator_is_member();

CREATE OR REPLACE FUNCTION trg_workspace_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN PERFORM rl_fail('workspace_id is immutable'); END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_projects_workspace_immutable ON projects;
CREATE TRIGGER trg_projects_workspace_immutable BEFORE UPDATE OF workspace_id ON projects FOR EACH ROW EXECUTE FUNCTION trg_workspace_immutable();

-- project_id can never change on any project-scoped entity.
CREATE OR REPLACE FUNCTION trg_project_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN PERFORM rl_fail('project_id is immutable'); END IF; RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['requirements','wbs_items','change_requests','weekly_reports','issues','risks','test_cases','acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_project_immutable ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_project_immutable BEFORE UPDATE OF project_id ON %I FOR EACH ROW EXECUTE FUNCTION trg_project_immutable()', t, t);
  END LOOP;
END $$;

-- Owner must be a member of the project's workspace (requirements, wbs_items, issues, risks, test_cases).
CREATE OR REPLACE FUNCTION trg_owner_is_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = NEW.project_id AND m.user_id = NEW.owner_user_id)
  THEN PERFORM rl_fail('owner must be a workspace member'); END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['requirements','wbs_items','issues','risks','test_cases'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_owner_is_member ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_owner_is_member BEFORE INSERT OR UPDATE OF owner_user_id ON %I FOR EACH ROW EXECUTE FUNCTION trg_owner_is_member()', t, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trg_wbs_parent_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR NOT EXISTS (SELECT 1 FROM wbs_items p WHERE p.id = NEW.parent_id AND p.project_id = NEW.project_id))
  THEN PERFORM rl_fail('parent must belong to the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_wbs_parent_same_project ON wbs_items;
CREATE TRIGGER trg_wbs_parent_same_project BEFORE INSERT OR UPDATE OF parent_id ON wbs_items FOR EACH ROW EXECUTE FUNCTION trg_wbs_parent_same_project();

CREATE OR REPLACE FUNCTION trg_wbsdep_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wbs_items a JOIN wbs_items b ON a.project_id = b.project_id WHERE a.id = NEW.predecessor_id AND b.id = NEW.successor_id AND a.project_id = NEW.project_id)
  THEN PERFORM rl_fail('dependency must link items of the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_wbsdep_same_project ON wbs_dependencies;
CREATE TRIGGER trg_wbsdep_same_project BEFORE INSERT ON wbs_dependencies FOR EACH ROW EXECUTE FUNCTION trg_wbsdep_same_project();

CREATE OR REPLACE FUNCTION trg_rwl_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM requirements r JOIN wbs_items w ON w.project_id = r.project_id WHERE r.id = NEW.requirement_id AND w.id = NEW.wbs_item_id AND r.project_id = NEW.project_id)
  THEN PERFORM rl_fail('link must connect a requirement and a WBS item of the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rwl_same_project ON requirement_wbs_links;
CREATE TRIGGER trg_rwl_same_project BEFORE INSERT ON requirement_wbs_links FOR EACH ROW EXECUTE FUNCTION trg_rwl_same_project();

CREATE OR REPLACE FUNCTION trg_crr_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM change_requests c JOIN requirements r ON r.project_id = c.project_id WHERE c.id = NEW.change_request_id AND r.id = NEW.requirement_id)
  THEN PERFORM rl_fail('requirement must belong to the change request project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crr_same_project ON change_request_requirements;
CREATE TRIGGER trg_crr_same_project BEFORE INSERT ON change_request_requirements FOR EACH ROW EXECUTE FUNCTION trg_crr_same_project();

CREATE OR REPLACE FUNCTION trg_crw_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM change_requests c JOIN wbs_items w ON w.project_id = c.project_id WHERE c.id = NEW.change_request_id AND w.id = NEW.wbs_item_id)
  THEN PERFORM rl_fail('wbs item must belong to the change request project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crw_same_project ON change_request_wbs_impacts;
CREATE TRIGGER trg_crw_same_project BEFORE INSERT ON change_request_wbs_impacts FOR EACH ROW EXECUTE FUNCTION trg_crw_same_project();

CREATE OR REPLACE FUNCTION trg_issue_source_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_risk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM risks r WHERE r.id = NEW.source_risk_id AND r.project_id = NEW.project_id)
  THEN PERFORM rl_fail('source risk must belong to the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_issue_source_same_project ON issues;
CREATE TRIGGER trg_issue_source_same_project BEFORE INSERT ON issues FOR EACH ROW EXECUTE FUNCTION trg_issue_source_same_project();

-- Polymorphic junctions: no FK possible, so the trigger checks both ends live in the link's project.
CREATE OR REPLACE FUNCTION rl_entity_in_project(kind text, eid text, pid text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN CASE kind
    WHEN 'ISSUE' THEN EXISTS (SELECT 1 FROM issues x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'RISK' THEN EXISTS (SELECT 1 FROM risks x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'WBS' THEN EXISTS (SELECT 1 FROM wbs_items x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'REQUIREMENT' THEN EXISTS (SELECT 1 FROM requirements x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'CHANGE' THEN EXISTS (SELECT 1 FROM change_requests x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'TEST' THEN EXISTS (SELECT 1 FROM test_cases x WHERE x.id = eid AND x.project_id = pid)
    WHEN 'ACCEPTANCE' THEN EXISTS (SELECT 1 FROM acceptances x WHERE x.id = eid AND x.project_id = pid)
    ELSE false END;
END $$;
CREATE OR REPLACE FUNCTION trg_raid_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (rl_entity_in_project(NEW.source_type, NEW.source_id, NEW.project_id) AND rl_entity_in_project(NEW.target_type, NEW.target_id, NEW.project_id))
  THEN PERFORM rl_fail('link ends must belong to the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_raid_same_project ON raid_links;
CREATE TRIGGER trg_raid_same_project BEFORE INSERT ON raid_links FOR EACH ROW EXECUTE FUNCTION trg_raid_same_project();
CREATE OR REPLACE FUNCTION trg_tl_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (rl_entity_in_project('TEST', NEW.test_case_id, NEW.project_id) AND rl_entity_in_project(NEW.target_type, NEW.target_id, NEW.project_id))
  THEN PERFORM rl_fail('link ends must belong to the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_tl_same_project ON test_links;
CREATE TRIGGER trg_tl_same_project BEFORE INSERT ON test_links FOR EACH ROW EXECUTE FUNCTION trg_tl_same_project();
CREATE OR REPLACE FUNCTION trg_al_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (rl_entity_in_project('ACCEPTANCE', NEW.acceptance_id, NEW.project_id) AND rl_entity_in_project(NEW.target_type, NEW.target_id, NEW.project_id))
  THEN PERFORM rl_fail('link ends must belong to the same project'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_al_same_project ON acceptance_links;
CREATE TRIGGER trg_al_same_project BEFORE INSERT ON acceptance_links FOR EACH ROW EXECUTE FUNCTION trg_al_same_project();

/* ================= Indexes reviewed for Phase 10 usage counts & dashboard filters ================= */
CREATE INDEX IF NOT EXISTS idx_members_ws ON workspace_members(workspace_id);                 -- member count per workspace (usage limit)
CREATE INDEX IF NOT EXISTS idx_projects_ws_status ON projects(workspace_id, status);           -- active project count per workspace
CREATE INDEX IF NOT EXISTS idx_req_project_scope_status ON requirements(project_id, scope, status) WHERE archived_at IS NULL;  -- coverage / health
CREATE INDEX IF NOT EXISTS idx_wbs_project_status ON wbs_items(project_id, status) WHERE archived_at IS NULL;                 -- overdue / progress
CREATE INDEX IF NOT EXISTS idx_issues_project_status_sev ON issues(project_id, status, severity) WHERE archived_at IS NULL;    -- attention / health
CREATE INDEX IF NOT EXISTS idx_risks_project_status_level ON risks(project_id, status, risk_level) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cr_project_status ON change_requests(project_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_weekly_reports_project_created ON weekly_reports(project_id, created_at);                        -- reports per month (usage limit)
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);                                                           -- session cleanup

/* ================= Migration bookkeeping ================= */
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

/* ---------- Integration foundation + Jira Cloud (Phase 12) ----------
 * One connection per (workspace, provider). Tokens are AES-256-GCM encrypted (integrations/crypto.js) and never leave the
 * server. Project mapping = 1 RELAI project ↔ 1 Jira project. Entity links reference wbs_items.id (stable), never wbs_code.
 * A Jira issue can be linked to one WBS item at a time (partial unique index on live links). */
CREATE TABLE IF NOT EXISTS integration_connections (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider IN ('JIRA')),
  status                   TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','ERROR','DISABLED')),
  external_account_id      TEXT,
  external_account_name    TEXT,
  cloud_id                 TEXT,
  site_url                 TEXT,
  auth_type                TEXT NOT NULL DEFAULT 'OAUTH2',
  access_token_encrypted   TEXT,
  refresh_token_encrypted  TEXT,
  access_token_expires_at  timestamptz,
  scopes                   TEXT NOT NULL DEFAULT '',
  webhook_secret           TEXT,                            -- random path segment of this connection's webhook URL
  last_error               TEXT,
  connected_by             TEXT REFERENCES users(id),
  connected_at             timestamptz,
  last_synced_at           timestamptz,
  disabled_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);
CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state         TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri  TEXT NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_project_mappings (
  id                      TEXT PRIMARY KEY,
  connection_id           TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_project_id     TEXT NOT NULL,
  external_project_key    TEXT NOT NULL,
  external_project_name   TEXT NOT NULL DEFAULT '',
  leaf_issue_type_id      TEXT,
  leaf_issue_type_name    TEXT,
  group_issue_type_id     TEXT,
  group_issue_type_name   TEXT,
  auto_complete_leaf_wbs  BOOLEAN NOT NULL DEFAULT false,
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  removed_at              timestamptz,
  created_by              TEXT REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ipm_project_active ON integration_project_mappings(project_id) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS integration_entity_links (
  id                    TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_item_id           TEXT NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,   -- stable id; wbs_code is display-only
  external_entity_type  TEXT NOT NULL DEFAULT 'ISSUE',
  external_entity_id    TEXT NOT NULL,
  external_key          TEXT NOT NULL,
  link_role             TEXT NOT NULL CHECK (link_role IN ('EXECUTION','EPIC')),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MISSING','ERROR','REMOVED')),
  created_by            TEXT REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_synced_at        timestamptz,
  removed_at            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_iel_external_live ON integration_entity_links(connection_id, external_entity_id) WHERE status <> 'REMOVED';
CREATE INDEX IF NOT EXISTS idx_iel_wbs ON integration_entity_links(wbs_item_id, status);
CREATE INDEX IF NOT EXISTS idx_iel_project ON integration_entity_links(project_id, status);
CREATE TABLE IF NOT EXISTS integration_activity (
  id          TEXT PRIMARY KEY,
  seq         BIGSERIAL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  action      TEXT NOT NULL,          -- PROJECT_MAPPED | PROJECT_UNMAPPED | ISSUE_LINKED | ISSUE_UNLINKED | ISSUE_CREATED | AUTO_COMPLETED | SYNC_FAILED
  summary     TEXT NOT NULL,
  wbs_item_id TEXT,
  actor_id    TEXT REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_iact_project ON integration_activity(project_id, created_at);
/* v17: snapshots, idempotent event log, sync runs, webhook registrations */
CREATE TABLE IF NOT EXISTS jira_issue_snapshots (
  integration_link_id  TEXT PRIMARY KEY REFERENCES integration_entity_links(id) ON DELETE CASCADE,
  external_key         TEXT NOT NULL,
  summary              TEXT NOT NULL DEFAULT '',
  issue_type           TEXT,
  status_id            TEXT,
  status_name          TEXT,
  status_category      TEXT,           -- new | indeterminate | done (Jira statusCategory.key)
  assignee_account_id  TEXT,
  assignee_name        TEXT,
  external_updated_at  timestamptz,
  browser_url          TEXT,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_events (
  id                 TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  external_event_id  TEXT,
  event_type         TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  error              TEXT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (connection_id, payload_hash)
);
CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL CHECK (trigger IN ('MANUAL','WEBHOOK','SCHEDULED')),
  status         TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  items_total    INTEGER NOT NULL DEFAULT 0,
  items_success  INTEGER NOT NULL DEFAULT 0,
  items_failed   INTEGER NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  error_summary  TEXT
);
CREATE INDEX IF NOT EXISTS idx_isr_conn ON integration_sync_runs(connection_id, started_at);
CREATE TABLE IF NOT EXISTS integration_webhooks (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  project_mapping_id   TEXT REFERENCES integration_project_mappings(id) ON DELETE CASCADE,
  external_webhook_id  TEXT NOT NULL,
  jql                  TEXT NOT NULL DEFAULT '',
  events               TEXT NOT NULL DEFAULT '',
  expires_at           timestamptz,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','DELETED','ERROR')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
