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
-- Phase 13: Google sign-in users have no password; verified e-mail timestamp (set by Google verified email or future e-mail verification)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

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
-- Early access (migration v41): free with TEAM limits until early_access_until (NULL = no early access). The 30-/7-day ending
-- notices are claimed once each through the *_notice_at columns.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS early_access_until timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS early_notice_30_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS early_notice_7_at timestamptz;
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
  client_name        TEXT NOT NULL DEFAULT '',     -- 고객사명 (프로젝트 생성 화면 2026-10-05: 유형/현재 상황 대신 고객사·규모)
  project_scale      TEXT NOT NULL DEFAULT '',     -- 프로젝트 규모 / 금액 (자유 입력)
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN
                       ('DRAFT','ACTIVE','ON_HOLD','COMPLETED','ARCHIVED')),
  planned_start_date date NOT NULL,              -- YYYY-MM-DD
  planned_end_date   date NOT NULL,              -- YYYY-MM-DD
  current_phase      TEXT NOT NULL DEFAULT 'INITIATION',   -- phase_key of the current project_phases row (Lifecycle V2 keys, templates/default-phases.js)
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_date >= planned_start_date)
);
-- GAP-006: remember the status a project had before it was archived so 보관 해제 can restore it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_before_archive TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_name TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_scale TEXT NOT NULL DEFAULT '';
/* 프로젝트 기본 특성 (2026-10-05). Option set: public/app/shared/project-traits.js (also used for API validation).
 * project_type is required on create but NULL for projects created before it existed ("미설정"); the rest default to TBD ("미정"), never NO. */
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT CHECK (project_type IN ('NEW_BUILD','ENHANCEMENT','TRANSITION','OTHER'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_migration TEXT NOT NULL DEFAULT 'TBD' CHECK (data_migration IN ('YES','NO','TBD'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_environment TEXT NOT NULL DEFAULT 'TBD' CHECK (deployment_environment IN ('CLOUD','ON_PREMISE','HYBRID','TBD'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT 'TBD' CHECK (delivery_model IN ('ONSITE','REMOTE','HYBRID','TBD'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_existing_system TEXT NOT NULL DEFAULT 'TBD' CHECK (has_existing_system IN ('YES','NO','TBD'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_external_integration TEXT NOT NULL DEFAULT 'TBD' CHECK (has_external_integration IN ('YES','NO','TBD'));

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
/* Project Charter (2026-10-05): free-text fields the Charter needs that the definition did not have yet. Deliberately
 * unstructured (no tables, rows or workflow) — structure comes later in a separate design. Edited only in 프로젝트 정의. */
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS project_type      TEXT NOT NULL DEFAULT '';   -- 프로젝트 유형 (신규 구축 / 고도화 / …, free text)
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS deliverables      TEXT NOT NULL DEFAULT '';   -- 주요 산출물
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS assumptions       TEXT NOT NULL DEFAULT '';   -- 가정사항
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS constraints_text  TEXT NOT NULL DEFAULT '';   -- 제약사항 ("constraints" is reserved-ish in SQL)
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS initial_risks     TEXT NOT NULL DEFAULT '';   -- 초기 리스크
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS change_management TEXT NOT NULL DEFAULT '';   -- 변경관리 방식
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS acceptance        TEXT NOT NULL DEFAULT '';   -- 검수 / 완료 기준
/* Phase 1 v2 (migration 31): 착수 gate activities edited on the 프로젝트 정의 screen. JSON as TEXT like the other definition lists. */
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS kickoff           TEXT NOT NULL DEFAULT '{}';  -- 착수보고회 {datetime, place, attendees[], prep[], agenda, minutes, decisions[], followups[]}
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS approval          TEXT NOT NULL DEFAULT '{}';  -- 착수 결과 승인 {approver_id|approver_name/title, date, method, evidence, conditions, baseline}
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS req_approval      TEXT NOT NULL DEFAULT '{}';  -- 요구사항 기준선 승인 (02, Phase 2) — same shape as approval

/* ---------- Project Lifecycle (V2): Project → Phase → Activities ----------
 * phase_key ∈ INITIATION · REQUIREMENTS · ANALYSIS_DESIGN · DEVELOPMENT · TESTING · TRANSITION_GO_LIVE · OPERATIONS.
 * Activities (project_steps) carry an importance (REQUIRED gates the phase; RECOMMENDED/OPTIONAL may stay open) and a
 * stored status that only records a manual 완료 처리 / 제외 — the live state is derived from project data (server/activities.js). */
CREATE TABLE IF NOT EXISTS project_phases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,                     -- which template produced this phase set
  phase_key    TEXT NOT NULL,                     -- Lifecycle V2 key (see templates/default-phases.js)
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
  is_required         INTEGER NOT NULL DEFAULT 1,  -- = importance IS 'REQUIRED' (kept for aggregate queries)
  importance          TEXT NOT NULL DEFAULT 'REQUIRED' CHECK (importance IN ('REQUIRED','RECOMMENDED','OPTIONAL')),
  linked_feature_type TEXT,                       -- requirements | wbs | issues | changes | tests | acceptance | definition
  status              TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','COMPLETED','SKIPPED')),
  note                TEXT NOT NULL DEFAULT '',
  completed_at        timestamptz,
  completed_by        TEXT REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_phase_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_steps_phase ON project_steps(project_phase_id, sequence);
ALTER TABLE project_steps ADD COLUMN IF NOT EXISTS importance TEXT NOT NULL DEFAULT 'REQUIRED';
ALTER TABLE project_steps DROP CONSTRAINT IF EXISTS project_steps_status_check;
ALTER TABLE project_steps ADD CONSTRAINT project_steps_status_check CHECK (status IN ('TODO','COMPLETED','SKIPPED'));

/* Activity checklist (06 전환·오픈 · 07 운영, 2026-10-14): activities without a dedicated work screen are worked through
 * items here. The activity's live state derives from them (server/activities.js); project_steps.status stays the manual mark. */
CREATE TABLE IF NOT EXISTS activity_checklist_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL REFERENCES project_steps(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  owner       TEXT NOT NULL DEFAULT '',          -- free text: 고객사·운영 조직 담당자도 적을 수 있도록
  due_date    date,
  done        boolean NOT NULL DEFAULT false,
  done_at     timestamptz,
  done_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  sequence    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_step ON activity_checklist_items(step_id, sequence);
CREATE INDEX IF NOT EXISTS idx_checklist_project ON activity_checklist_items(project_id);

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
-- Lifecycle V2 (§17): which lifecycle phase a work item belongs to (API 설계 → ANALYSIS_DESIGN, 통합 테스트 → TESTING …). NULL = not classified.
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT CHECK (lifecycle_phase IN ('INITIATION','REQUIREMENTS','ANALYSIS_DESIGN','DEVELOPMENT','TESTING','TRANSITION_GO_LIVE','OPERATIONS'));
-- Phase 3 US-1: 담당자 = RELAI 사용자(owner_user_id) 또는 계정 없는 팀원(01 이해관계자 id, project_definitions.stakeholders JSON — FK 없음). 둘 중 하나만.
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS owner_stakeholder_id TEXT;
-- Phase 4 US-1: 최초 계획 종료일 (milestone: 최초 마일스톤 날짜). Frozen when the project enters 04 구현; NULL before that.
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS original_planned_end_date date;

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
  action_type TEXT NOT NULL,   -- CREATED | UPDATED | MOVED | ARCHIVED | CONVERTED | DEP_ADDED | DEP_REMOVED | LINKED_REQ | UNLINKED_REQ | LINK_TYPE_CHANGED
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
-- Designated approver (optional). Approve/reject: OWNER/ADMIN or this user, never the CR's author (server/changes.js reviewPermission).
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- Phase 4 US-2: 고객 승인 기록 (same JSON shape as project_definitions.approval: approver_id | approver_name/title, date, method, evidence, conditions)
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS customer_approval TEXT NOT NULL DEFAULT '{}';

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
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'ADMIN';   -- Phase 13: ADMIN (operator action) | USER (account/invitation event by a regular user)
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
-- AI-credits-only billing (migration v41): PURCHASE = a paid credit pack (reference ORDER:<billing_orders.id>); REFUND is written as a
-- negative amount when unused purchased credits are refunded. low_balance_notified_at = the one low-balance e-mail was sent (NULL = armed).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_type_check' AND conrelid = 'credit_ledger'::regclass AND pg_get_constraintdef(oid) LIKE '%PURCHASE%') THEN
    ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_type_check;
    ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_type_check CHECK (type IN ('PLAN_GRANT','ADMIN_GRANT','AI_USAGE','REFUND','ADJUSTMENT','PROMOTION','PURCHASE')); END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_credit_ledger_ref ON credit_ledger(workspace_id, reference_type, reference_id);
ALTER TABLE workspace_credit_accounts ADD COLUMN IF NOT EXISTS low_balance_notified_at timestamptz;

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
  wbs_item_id           TEXT REFERENCES wbs_items(id) ON DELETE CASCADE,   -- stable id; wbs_code is display-only. NULL for a REQUIREMENT link
  requirement_id        TEXT REFERENCES requirements(id) ON DELETE CASCADE,   -- v43: requirement ↔ Jira issue (link_role REQUIREMENT)
  external_entity_type  TEXT NOT NULL DEFAULT 'ISSUE',
  external_entity_id    TEXT NOT NULL,
  external_key          TEXT NOT NULL,
  link_role             TEXT NOT NULL CHECK (link_role IN ('EXECUTION','EPIC','REQUIREMENT')),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MISSING','ERROR','REMOVED')),
  created_by            TEXT REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_synced_at        timestamptz,
  removed_at            timestamptz
);
/* v43: requirement links live in the same table. One live WBS link per Jira issue (as before); a requirement link is unique per (requirement, issue),
 * so the same issue can be linked to a WBS leaf and to one or more requirements. */
ALTER TABLE integration_entity_links ALTER COLUMN wbs_item_id DROP NOT NULL;
ALTER TABLE integration_entity_links ADD COLUMN IF NOT EXISTS requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE;
ALTER TABLE integration_project_mappings ADD COLUMN IF NOT EXISTS auto_mark_requirements BOOLEAN NOT NULL DEFAULT false;   -- '지라 완료 시 요구사항 구현 완료로 표시' (default off)
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS jira_done_at timestamptz;   -- set by sync when auto_mark_requirements is on and every linked Jira issue is Done; requirement status is never changed
CREATE UNIQUE INDEX IF NOT EXISTS uq_iel_external_live_wbs ON integration_entity_links(connection_id, external_entity_id) WHERE status <> 'REMOVED' AND wbs_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_iel_req_live ON integration_entity_links(requirement_id, external_entity_id) WHERE status <> 'REMOVED' AND requirement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iel_req ON integration_entity_links(requirement_id, status);
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

/* ---------- Identity, invitations, e-mail (Phase 13) ----------
 * RELAI stays the source of truth for users / memberships. Google only proves identity; the e-mail provider only delivers.
 * Invitation tokens are stored hashed (sha256); the raw token exists only in the e-mail link. */
CREATE TABLE IF NOT EXISTS user_identities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('PASSWORD','GOOGLE')),
  provider_subject TEXT NOT NULL,                  -- PASSWORD: the user id; GOOGLE: the stable `sub` claim (never the e-mail)
  email            TEXT,
  email_verified   BOOLEAN NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
CREATE TABLE IF NOT EXISTS invitations (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL CHECK (type IN ('WORKSPACE_CREATE','WORKSPACE_MEMBER')),
  workspace_id           TEXT REFERENCES workspaces(id) ON DELETE CASCADE,   -- WORKSPACE_MEMBER only
  email                  TEXT NOT NULL,                                       -- lower-cased invitee e-mail (must match the accepting account exactly)
  role                   TEXT CHECK (role IN ('OWNER','ADMIN','MEMBER')),    -- WORKSPACE_MEMBER only
  workspace_name         TEXT,                                               -- WORKSPACE_CREATE only
  invitee_name           TEXT,
  note                   TEXT,
  token_hash             TEXT NOT NULL UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  invited_by             TEXT REFERENCES users(id),
  accepted_by            TEXT REFERENCES users(id),
  accepted_workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  expires_at             timestamptz NOT NULL,
  accepted_at            timestamptz,
  revoked_at             timestamptz,
  last_sent_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_platform_pending ON invitations(email) WHERE status = 'PENDING' AND type = 'WORKSPACE_CREATE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_member_pending ON invitations(workspace_id, email) WHERE status = 'PENDING' AND type = 'WORKSPACE_MEMBER';
CREATE INDEX IF NOT EXISTS idx_inv_workspace ON invitations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_inv_created ON invitations(created_at);
CREATE TABLE IF NOT EXISTS auth_oauth_states (                                 -- user sign-in OAuth only (Jira integration has its own table)
  state_hash               TEXT PRIMARY KEY,
  nonce_hash               TEXT NOT NULL,
  code_verifier_encrypted  TEXT,                                              -- PKCE verifier (AES-GCM, integrations/crypto.js)
  intent                   TEXT NOT NULL CHECK (intent IN ('LOGIN','SIGNUP','INVITE')),
  invitation_id            TEXT REFERENCES invitations(id) ON DELETE CASCADE,
  return_path_encrypted    TEXT,                                              -- where to land after sign-in (may contain an invite token → encrypted)
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_deliveries (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL,              -- PLATFORM_INVITE | WORKSPACE_MEMBER_INVITE | …
  recipient            TEXT NOT NULL,
  provider             TEXT NOT NULL,
  provider_message_id  TEXT,
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  related_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  invitation_id        TEXT REFERENCES invitations(id) ON DELETE SET NULL,
  workspace_id         TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  error_code           TEXT,
  error_message_safe   TEXT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_created ON email_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_inv ON email_deliveries(invitation_id);

-- Phase 14: onboarding state (server-side, per user × workspace) and one-time feature guides (coach marks)
CREATE TABLE IF NOT EXISTS user_onboarding (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id     TEXT REFERENCES workspaces(id) ON DELETE CASCADE,       -- NULL = account-wide (unused today; every key is per workspace)
  onboarding_key   TEXT NOT NULL,                                         -- WELCOME | PRODUCT_TOUR | CHECKLIST
  status           TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED','SKIPPED')),
  current_step     TEXT,
  completed_steps  JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,                    -- { backfilled: true, replays: n } — never sensitive data
  started_at       timestamptz,
  completed_at     timestamptz,
  skipped_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_onboarding ON user_onboarding(user_id, COALESCE(workspace_id, ''), onboarding_key);
CREATE TABLE IF NOT EXISTS user_feature_guides (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guide_key  TEXT NOT NULL,                                               -- REQ_TRACE_INTRO, TESTING_INTRO, PHASE_INTRO_TESTING, …
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, guide_key)
);

-- Phase 15: AI Project WBS Planner sessions (normalized questions / answers / draft / coverage only — never raw provider output)
CREATE TABLE IF NOT EXISTS ai_wbs_plans (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','QUESTIONS_READY','GENERATING','REVIEW','COMMITTED','CANCELLED')),
  requirement_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  areas            JSONB NOT NULL DEFAULT '[]'::jsonb,       -- area assessment [{area,status,source,reason}]
  questions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  answers          JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft            JSONB,                                    -- { items, notes, warnings }
  coverage         JSONB,
  ai_run_id        TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,   -- the charged (draft) run
  question_run_id  TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  commit_result    JSONB,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  committed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ai_wbs_plans_project ON ai_wbs_plans(project_id, created_at);

-- Phase 10 Billing: subscriptions / payments / billing_events (+ subscription_events audit trail).
-- Column contract for the Admin Console: docs/admin-console.md §8 (billing-admin.js whitelists what it shows).
-- Webhook idempotency: docs/production-readiness.md §8 (UNIQUE (provider, provider_event_id), processing in one transaction).
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,   -- one subscription row per workspace
  plan                     TEXT NOT NULL CHECK (plan IN ('FREE','PRO','TEAM','ENTERPRISE')),   -- pricing v3 (mig 57)
  status                   TEXT NOT NULL CHECK (status IN ('ACTIVE','PAST_DUE','CANCELED','EXPIRED')),
  provider                 TEXT,
  provider_customer_id     TEXT,                    -- never exposed (not in the admin whitelist / customer API)
  provider_subscription_id TEXT,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  next_billing_at          timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  grace_period_end         timestamptz,             -- PAST_DUE keeps the plan until this moment
  payment_method_summary   TEXT,                    -- display only, e.g. '신한 ****1234'
  canceled_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_provider_sub ON subscriptions(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, updated_at);
-- Seat-priced plans + NicePay (billing-nicepay, migration v29). One-time (일반결제) purchases set auto_renew = false: the plan
-- ends at current_period_end with no renewal. billing_key_enc holds the NicePay billing key (bid, 정기결제) AES-GCM encrypted
-- with INTEGRATION_ENCRYPTION_KEY; it is never returned by any API.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats INTEGER;                 -- TEAM member limit (NULL = unlimited, legacy rows)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_cycle TEXT;            -- ANNUAL | MONTHLY
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT true;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_reminded_for timestamptz;   -- current_period_end the 7-day reminder was sent for
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS founding_until timestamptz;    -- founding offer discount applies to purchases before this
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_key_enc TEXT;

-- Checkout orders: the server-side price of every payment. The provider is only ever asked to charge order.amount, and every
-- approval / notification is checked against it (amount verification). id is the provider orderId.
CREATE TABLE IF NOT EXISTS billing_orders (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('ONE_TIME','RECURRING_FIRST','RECURRING_RENEWAL')),
  plan             TEXT NOT NULL,
  cycle            TEXT NOT NULL CHECK (cycle IN ('ANNUAL','MONTHLY')),
  seats            INTEGER NOT NULL,
  months           INTEGER NOT NULL,
  unit_price       INTEGER NOT NULL,                 -- monthly price for all `seats` users, VAT excluded (pricing v2; v1 rows: per seat)
  list_amount      INTEGER NOT NULL,                 -- unit_price × months (v1 rows: unit_price × seats × months)
  discount_amount  INTEGER NOT NULL DEFAULT 0,       -- annual-cycle discount + founding offer
  supply_amount    INTEGER NOT NULL,                 -- list − discount (공급가액)
  vat_amount       INTEGER NOT NULL,
  amount           INTEGER NOT NULL,                 -- charged: supply + VAT
  founding         boolean NOT NULL DEFAULT false,
  goods_name       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  provider_tid     TEXT,
  failure_code     TEXT,
  failure_message  TEXT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_orders_ws ON billing_orders(workspace_id, created_at);
-- AI-credits-only billing (migration v41): prepaid credit packs are billing_orders of kind CREDIT_PACK (plan / cycle / seats / months
-- NULL), credited as a PURCHASE ledger row once paid. Partial refunds (NicePay cancelAmt) add up in refunded_amount / refunded_credits;
-- receipt_url is the NicePay card receipt (매출전표) from the approval response.
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS credits INTEGER;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS refunded_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS refunded_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE billing_orders ALTER COLUMN plan DROP NOT NULL, ALTER COLUMN cycle DROP NOT NULL, ALTER COLUMN seats DROP NOT NULL, ALTER COLUMN months DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_orders_kind_check' AND conrelid = 'billing_orders'::regclass AND pg_get_constraintdef(oid) LIKE '%CREDIT_PACK%') THEN
    ALTER TABLE billing_orders DROP CONSTRAINT IF EXISTS billing_orders_kind_check;
    ALTER TABLE billing_orders ADD CONSTRAINT billing_orders_kind_check CHECK (kind IN ('ONE_TIME','RECURRING_FIRST','RECURRING_RENEWAL','CREDIT_PACK')); END IF;
END $$;

-- Pricing v3 T1 (migration 57): plans FREE / PRO / TEAM / ENTERPRISE, VAT-inclusive prices, add-ons (extra users / projects) bought
-- per workspace and prorated to the current period end (billing/prorate.js). Limits = plan included + extra_* (plans.js limitsFor);
-- ENTERPRISE limits are operator-set (seats, project_limit). price_version 'v2' marks a pre-v3 paid row that keeps what it bought
-- until its period ends (migration 57 backfill); NULL = v3. renewal_amount = the last renewal amount the customer agreed to (T3 gate).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_check' AND conrelid = 'subscriptions'::regclass AND pg_get_constraintdef(oid) LIKE '%PRO%') THEN
    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('FREE','PRO','TEAM','ENTERPRISE')); END IF;
END $$;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS extra_users INTEGER NOT NULL DEFAULT 0 CHECK (extra_users >= 0);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS extra_projects INTEGER NOT NULL DEFAULT 0 CHECK (extra_projects >= 0);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS project_limit INTEGER;          -- ENTERPRISE only (NULL = unlimited)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_version TEXT;             -- 'v2' = bought before pricing v3; NULL = v3
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_amount INTEGER;        -- VAT incl.; a renewal above it needs PRICE_INCREASE consent (T3)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS over_limit_since timestamptz;   -- set while usage > limits after a plan/limit drop (D6)
-- Orders (mig 57): ADDON (users/projects for the rest of the period), UPGRADE (PRO → TEAM difference), CREDIT_TOPUP (any 10,000원 step, T2).
-- addon_* = units the order adds; period_* = the slice it covers; client_key = checkout idempotency key (double click → same order);
-- refund_tid_seq numbers partial cancels (a new orderId per NicePay partial cancel, T2).
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS addon_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS addon_projects INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS period_end timestamptz;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS client_key TEXT;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS refund_tid_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS price_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_orders_client_key ON billing_orders(workspace_id, client_key) WHERE client_key IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_orders_kind_check' AND conrelid = 'billing_orders'::regclass AND pg_get_constraintdef(oid) LIKE '%CREDIT_TOPUP%') THEN
    ALTER TABLE billing_orders DROP CONSTRAINT IF EXISTS billing_orders_kind_check;
    ALTER TABLE billing_orders ADD CONSTRAINT billing_orders_kind_check CHECK (kind IN ('ONE_TIME','RECURRING_FIRST','RECURRING_RENEWAL','CREDIT_PACK','ADDON','UPGRADE','CREDIT_TOPUP')); END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing_events (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  subscription_id   TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- provider body as normalized by the adapter (no card data / billing keys)
  result            TEXT,                                 -- APPLIED | IGNORED:<reason>
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);

CREATE TABLE IF NOT EXISTS payments (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id      TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan                 TEXT,
  amount               numeric(12,2),
  currency             TEXT NOT NULL DEFAULT 'KRW',
  status               TEXT NOT NULL CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED','CANCELED')),
  provider             TEXT NOT NULL,
  provider_result_code TEXT,
  provider_tid         TEXT,                     -- shown masked (last 4) by billing-admin.js
  moid                 TEXT,
  paid_at              timestamptz,
  failed_at            timestamptz,
  failure_code         TEXT,
  failure_message      TEXT,
  billing_event_id     TEXT REFERENCES billing_events(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_tid)
);
CREATE INDEX IF NOT EXISTS idx_payments_ws_created ON payments(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);

CREATE TABLE IF NOT EXISTS subscription_events (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,                 -- subscription.activated | payment.failed | cancel.requested | IGNORED:<type> …
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { from, to, billing_event_id }
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_sub ON subscription_events(subscription_id, created_at);
-- Auth hardening (migration 26): single-use e-mail tokens (password reset, e-mail verification) and shared rate-limit counters.
-- auth_tokens holds only sha256(secret:purpose:token); the raw token exists only in the e-mail link.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('PASSWORD_RESET','EMAIL_VERIFY')),
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,                     -- address the link was sent to; must still match users.email when used
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
-- Fixed-window counters for login/signup/reset/invite limits. key = sha256(limiter name:key); purged once reset_at has passed.
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
-- Account lifecycle (migration 30): soft-deleted accounts / workspaces and the 3-month login record (통신비밀보호법).
-- users: status DEACTIVATED + deleted_at = 회원 탈퇴 (row kept as a pseudonymous tombstone; e-mail/name replaced at once).
-- workspaces: status CLOSED + deleted_at = deleted by its OWNER; purged after 30 days (purged_at), row kept for billing references.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES users(id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS purged_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted ON workspaces(deleted_at) WHERE status = 'CLOSED' AND purged_at IS NULL;
CREATE TABLE IF NOT EXISTS login_records (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  method      TEXT NOT NULL CHECK (method IN ('PASSWORD','GOOGLE','SIGNUP')),
  ip          TEXT,                              -- client address as seen behind the proxy (trust proxy 1)
  user_agent  TEXT,                              -- first 300 characters
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_records_created ON login_records(created_at);
CREATE INDEX IF NOT EXISTS idx_login_records_user ON login_records(user_id, created_at);

/* ---------- Phase 4 (04 구현) ---------- */
ALTER TABLE wbs_history ADD COLUMN IF NOT EXISTS note TEXT;                  -- US-1: 일정 미루기 사유 (on the planned_end_date / milestone_date UPDATED row)
ALTER TABLE issues ADD COLUMN IF NOT EXISTS owner_stakeholder_id TEXT;       -- US-6: 담당자 = 01 이해관계자(당사·협력사) id, no FK (same as wbs_items)

/* ---------- Phase 5 (05 시험) ---------- */
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS test_exclusion_reason TEXT;        -- US-1: 테스트 제외 사유 (counts as covered for 05 TEST_PLAN)
ALTER TABLE test_executions ADD COLUMN IF NOT EXISTS performer_user_id TEXT;         -- US-4: 수행자 = RELAI 사용자 …
ALTER TABLE test_executions ADD COLUMN IF NOT EXISTS performer_stakeholder_id TEXT;  --       … or 01 이해관계자 id (팀원 / 고객사), no FK
ALTER TABLE test_executions ADD COLUMN IF NOT EXISTS performed_on date;              --       수행일 (NULL → executed_at 날짜로 표시)

/* ---------- Phase 6 (06 전환 및 오픈) ---------- */
ALTER TABLE acceptances ADD COLUMN IF NOT EXISTS customer_approval TEXT NOT NULL DEFAULT '{}';       -- US-1: 고객 승인 기록 (same JSON shape as project_definitions.approval + recorded_by)
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS go_live TEXT NOT NULL DEFAULT '{}';         -- US-3: 오픈 기록 {date, carryovers:[{type,id,display_id,title,note}], by, by_name, at}
ALTER TABLE activity_checklist_items ADD COLUMN IF NOT EXISTS owner_user_id TEXT;                    -- US-6: 담당 = RELAI 사용자 …
ALTER TABLE activity_checklist_items ADD COLUMN IF NOT EXISTS owner_stakeholder_id TEXT;             --       … or 01 이해관계자 id (팀원 / 고객사), no FK; else the free-text owner

/* ---------- Phase 7 (07 운영 및 유지보수) ---------- */
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'WEEKLY' CHECK (report_type IN ('WEEKLY','COMPLETION'));   -- US-1: 완료보고서 = same table, same editor/export
CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_reports_completion ON weekly_reports(project_id) WHERE report_type = 'COMPLETION';                  --       one per project
ALTER TABLE projects ADD COLUMN IF NOT EXISTS closed_on date;                -- US-2: 프로젝트 종료일 (status = 'COMPLETED')
ALTER TABLE projects ADD COLUMN IF NOT EXISTS warranty_end_on date;          --       하자보수 종료일 (optional; default 종료일 + 12개월)
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS handover TEXT NOT NULL DEFAULT '{}';   -- US-3: 운영 인수 {receiver_user_id|receiver_stakeholder_id, date, by, by_name, at}

/* ---------- Signup consent (B9, migration v40) ---------- */
-- When the user agreed to 이용약관 / 개인정보 수집·이용 and to which version (public/app/shared/legal-info.js). NULL = signed up before v40.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_agreed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version TEXT;
-- Google sign-in: consent given on the signup page before leaving for Google; a brand-new Google account needs it.
ALTER TABLE auth_oauth_states ADD COLUMN IF NOT EXISTS consent boolean NOT NULL DEFAULT false;
/* Sample projects (migration 42): example projects copied into a new workspace at signup (server/samples/). NULL = a real project;
 * 'early' · 'mid' · 'done' = which sample. Samples are never counted as usage (plan limits, admin metrics, activation). */
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sample_key TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_sample ON projects(workspace_id) WHERE sample_key IS NOT NULL;
/* v1 P2-1 (migration 44): a comment shown under a label instead of its author's name. Sample projects copy their example comments
 * with author_label '샘플' (created_by stays NOT NULL = the user who received the samples); NULL = show the author as usual. */
ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_label TEXT;
/* Product analytics (migration 46, server/analytics.js): first-party only. Ids and a short key — no names, e-mails or IPs.
 * name: landing_visit (anonymous) | signup | email_verified | sample_opened | project_created | stage_reached (key '01'…'07') | first_requirement |
 * first_wbs | first_issue | first_report | first_invite | jira_connected | project_closed (once per user) | feature (key = method + route) | screen (key = app path). */
CREATE TABLE IF NOT EXISTS analytics_events (
  id bigserial PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT,
  user_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  sample boolean NOT NULL DEFAULT false,          -- event inside a sample project → left out of metrics
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_at ON analytics_events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_once ON analytics_events(user_id, name, COALESCE(key, ''))
  WHERE user_id IS NOT NULL AND name NOT IN ('feature', 'screen', 'landing_visit');
-- One row per user per KST day with any signed-in request (D1 / D7 / D30 return visits, DAU / WAU / MAU).
CREATE TABLE IF NOT EXISTS analytics_active_days (
  user_id TEXT NOT NULL,
  day date NOT NULL,
  PRIMARY KEY (user_id, day)
);
/* Promotions (migration 47, server/promotions.js): marketing offers shown on public and in-app placements, edited in 관리자 › 프로모션.
 * Display only — credit grants stay in server/ai/credits.js (workspaces.early_access_until is history only: early access retired 2026-10-20).
 * placements: signup | login | landing | credits | home. starts_on / ends_on are inclusive KST dates (NULL = open). */
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  badge TEXT,
  link_url TEXT,
  link_label TEXT,
  placements TEXT[] NOT NULL DEFAULT '{}',
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(active, sort_order);
-- Seed (once): the launch offer (copy without ₩ since batch7 #7; migration 49 rewrites unedited older rows; Free-plan copy and no
-- early-access {until} rows since migration 53, which rewrites / deactivates unedited older rows). Runs only while migration 47 is not yet recorded, so an operator's later edits or deletions stay.
INSERT INTO promotions (id, title, body, badge, link_url, link_label, placements, sort_order)
SELECT v.id, v.title, v.body, v.badge, v.link_url, v.link_label, v.placements::text[], v.sort_order FROM (VALUES
  ('promo-early-access', '무료 플랜으로 시작', '프로젝트 2개까지 결제 정보 없이 바로 씁니다.', '무료 플랜', NULL, NULL, '{signup,landing}', 10),
  ('promo-ai-credits', '가입하면 AI 크레딧 500 무료', '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다.', 'AI 크레딧', NULL, NULL, '{signup,landing}', 20),
  ('promo-ai-payg', '이후 AI는 쓴 만큼만', '월 기본료 없이 쓴 만큼만 크레딧이 차감됩니다.', '이후 AI', NULL, NULL, '{signup,landing}', 30),
  ('promo-login', '지금 가입하면 무료 플랜으로 시작', 'AI 크레딧 500도 함께 드립니다.', '무료 플랜', '/signup', '무료로 시작하기', '{login}', 40)
) AS v(id, title, body, badge, link_url, link_label, placements, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 47)
ON CONFLICT (id) DO NOTHING;
/* In-app feedback (migration 48, server/feedback.js): '의견 남기기' in the app rail, triaged in 관리자 › 의견. Additive only.
 * category: INCONVENIENCE (불편) | SUGGESTION (개선 제안) | BUG (오류) | OTHER (기타). status: NEW | IN_REVIEW | DONE.
 * workspace_id / project_id: where the sender was (kept only when they are a member); page_path + user_agent: auto-attached. */
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  workspace_id TEXT,
  project_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('INCONVENIENCE', 'SUGGESTION', 'BUG', 'OTHER')),
  message TEXT NOT NULL,
  page_path TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_REVIEW', 'DONE')),
  admin_note TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);
/* batch7 T2 (migration 49): 01 '수행 범위 · 적용 환경' + 산출물 카탈로그. Additive only (previews share the production DB).
 * project_definitions.environments: {devices:{PC_WEB:'SUPPORTED'|'UNSUPPORTED',…}, browsers:{…}, os, min_resolution, languages} (definition.js ENV_*).
 * deliverable_catalog: the global standard list (관리자 › 산출물 목록). project_deliverables: only what a project changed; an unselected
 * catalog item reads as its default_level, so a new catalog item shows in every project at once (server/deliverables.js). */
ALTER TABLE project_definitions ADD COLUMN IF NOT EXISTS environments TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS deliverable_catalog (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phase_key TEXT NOT NULL,                       -- the 7 lifecycle phase keys
  tier TEXT NOT NULL CHECK (tier IN ('BASIC','ADVANCED')),
  default_level TEXT NOT NULL DEFAULT 'OPTIONAL' CHECK (default_level IN ('REQUIRED','OPTIONAL','EXCLUDED')),
  description TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  catalog_id TEXT REFERENCES deliverable_catalog(id),
  custom_name TEXT,
  phase_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('REQUIRED','OPTIONAL','EXCLUDED')),
  submitted_at DATE,
  note TEXT DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK (catalog_id IS NOT NULL OR custom_name IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_deliverable ON project_deliverables(project_id, catalog_id) WHERE catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_deliverables_project ON project_deliverables(project_id);
-- Seed (once): the standard list. Runs only while migration 49 is not yet recorded, so the operator's later edits stay.
INSERT INTO deliverable_catalog (id, code, name, phase_key, tier, default_level, sort)
SELECT 'dlv-' || lower(v.code), v.code, v.name, v.phase_key, v.tier, CASE WHEN v.tier = 'BASIC' THEN 'REQUIRED' ELSE 'EXCLUDED' END, v.sort FROM (VALUES
  ('PLAN', '사업수행계획서', 'INITIATION', 'BASIC', 10), ('KICKOFF_REPORT', '착수보고서', 'INITIATION', 'BASIC', 20),
  ('QUALITY_PLAN', '품질관리계획서', 'INITIATION', 'ADVANCED', 30), ('RISK_PLAN', '위험관리계획서', 'INITIATION', 'ADVANCED', 40), ('COMM_PLAN', '의사소통관리계획서', 'INITIATION', 'ADVANCED', 50),
  ('REQ_SPEC', '요구사항 정의서', 'REQUIREMENTS', 'BASIC', 110),
  ('REQ_TRACE', '요구사항 추적표', 'REQUIREMENTS', 'ADVANCED', 120), ('ASIS_ANALYSIS', '현행 업무 분석서', 'REQUIREMENTS', 'ADVANCED', 130),
  ('UI_DESIGN', '화면 설계서', 'ANALYSIS_DESIGN', 'BASIC', 210), ('WBS_PLAN', 'WBS·일정계획서', 'ANALYSIS_DESIGN', 'BASIC', 220),
  ('ARCH_DESIGN', '아키텍처 설계서', 'ANALYSIS_DESIGN', 'ADVANCED', 230), ('DB_DESIGN', 'DB 설계서(ERD)', 'ANALYSIS_DESIGN', 'ADVANCED', 240),
  ('IF_SPEC', '인터페이스 정의서', 'ANALYSIS_DESIGN', 'ADVANCED', 250), ('CODE_SPEC', '코드 정의서', 'ANALYSIS_DESIGN', 'ADVANCED', 260),
  ('SOURCE', '소스코드·배포본', 'DEVELOPMENT', 'BASIC', 310),
  ('PROGRAM_LIST', '프로그램 목록', 'DEVELOPMENT', 'ADVANCED', 320), ('UNIT_TEST', '단위 테스트 결과서', 'DEVELOPMENT', 'ADVANCED', 330),
  ('IT_RESULT', '통합 테스트 결과서', 'TESTING', 'BASIC', 410), ('UAT_RESULT', '사용자 인수 테스트 결과서', 'TESTING', 'BASIC', 420),
  ('TEST_PLAN', '테스트 계획서', 'TESTING', 'ADVANCED', 430), ('PERF_TEST', '성능 테스트 결과서', 'TESTING', 'ADVANCED', 440), ('SEC_CHECK', '보안 점검 결과서', 'TESTING', 'ADVANCED', 450),
  ('USER_MANUAL', '사용자 매뉴얼', 'TRANSITION_GO_LIVE', 'BASIC', 510), ('OPEN_PLAN', '오픈(전환) 계획서', 'TRANSITION_GO_LIVE', 'BASIC', 520),
  ('OPS_MANUAL', '운영자 매뉴얼', 'TRANSITION_GO_LIVE', 'ADVANCED', 530), ('MIGRATION_RESULT', '데이터 이관 결과서', 'TRANSITION_GO_LIVE', 'ADVANCED', 540), ('TRAINING_RESULT', '교육 결과서', 'TRANSITION_GO_LIVE', 'ADVANCED', 550),
  ('COMPLETION_REPORT', '완료보고서', 'OPERATIONS', 'BASIC', 610), ('ACCEPTANCE_CERT', '검수확인서', 'OPERATIONS', 'BASIC', 620),
  ('WARRANTY_PLAN', '하자보수 계획서', 'OPERATIONS', 'ADVANCED', 630), ('LESSONS', '교훈 정리서', 'OPERATIONS', 'ADVANCED', 640)
) AS v(code, name, phase_key, tier, sort)
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 49)
ON CONFLICT (code) DO NOTHING;

/* ---------- batch7 (migration 50): WBS 고정 최상위 뼈대 + 근무일 달력 ---------- */
-- 고정 노드: 'PHASE:INITIATION' … 'PHASE:TRANSITION_GO_LIVE', 'OPT:DATA_MIGRATION' (server/wbs-structure.js). NULL = a user item.
-- Code that predates the column ignores it: a fixed node is then just a SUMMARY group.
ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS system_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wbs_system_key ON wbs_items(project_id, system_key) WHERE system_key IS NOT NULL AND archived_at IS NULL;
-- 한국 공휴일 (server/calendar/holidays-kr.js holds the same rows; a 임시공휴일 is one more INSERT).
CREATE TABLE IF NOT EXISTS public_holidays (day DATE PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'PUBLIC', source TEXT);
INSERT INTO public_holidays (day, name, kind, source) VALUES ('2026-01-01', '신정', 'PUBLIC', 'seed-2026-10'), ('2026-02-16', '설날 연휴', 'PUBLIC', 'seed-2026-10'), ('2026-02-17', '설날', 'PUBLIC', 'seed-2026-10'), ('2026-02-18', '설날 연휴', 'PUBLIC', 'seed-2026-10'), ('2026-03-01', '삼일절', 'PUBLIC', 'seed-2026-10'), ('2026-03-02', '삼일절 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2026-05-01', '노동절', 'PUBLIC', 'seed-2026-10'), ('2026-05-05', '어린이날', 'PUBLIC', 'seed-2026-10'), ('2026-05-24', '부처님오신날', 'PUBLIC', 'seed-2026-10'), ('2026-05-25', '부처님오신날 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2026-06-03', '전국동시지방선거', 'PUBLIC', 'seed-2026-10'), ('2026-06-06', '현충일', 'PUBLIC', 'seed-2026-10'), ('2026-07-17', '제헌절', 'PUBLIC', 'seed-2026-10'), ('2026-08-15', '광복절', 'PUBLIC', 'seed-2026-10'), ('2026-08-17', '광복절 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2026-09-24', '추석 연휴', 'PUBLIC', 'seed-2026-10'), ('2026-09-25', '추석', 'PUBLIC', 'seed-2026-10'), ('2026-09-26', '추석 연휴', 'PUBLIC', 'seed-2026-10'), ('2026-10-03', '개천절', 'PUBLIC', 'seed-2026-10'), ('2026-10-05', '개천절 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2026-10-09', '한글날', 'PUBLIC', 'seed-2026-10'), ('2026-12-25', '성탄절', 'PUBLIC', 'seed-2026-10'), ('2027-01-01', '신정', 'PUBLIC', 'seed-2026-10'), ('2027-02-05', '설날 연휴', 'PUBLIC', 'seed-2026-10'), ('2027-02-06', '설날', 'PUBLIC', 'seed-2026-10'), ('2027-02-07', '설날 연휴', 'PUBLIC', 'seed-2026-10'), ('2027-02-08', '설날 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2027-03-01', '삼일절', 'PUBLIC', 'seed-2026-10'), ('2027-05-01', '노동절', 'PUBLIC', 'seed-2026-10'), ('2027-05-05', '어린이날', 'PUBLIC', 'seed-2026-10'), ('2027-05-13', '부처님오신날', 'PUBLIC', 'seed-2026-10'), ('2027-06-06', '현충일', 'PUBLIC', 'seed-2026-10'), ('2027-07-17', '제헌절', 'PUBLIC', 'seed-2026-10'), ('2027-08-15', '광복절', 'PUBLIC', 'seed-2026-10'), ('2027-08-16', '광복절 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2027-09-14', '추석 연휴', 'PUBLIC', 'seed-2026-10'), ('2027-09-15', '추석', 'PUBLIC', 'seed-2026-10'), ('2027-09-16', '추석 연휴', 'PUBLIC', 'seed-2026-10'), ('2027-10-03', '개천절', 'PUBLIC', 'seed-2026-10'), ('2027-10-04', '개천절 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2027-10-09', '한글날', 'PUBLIC', 'seed-2026-10'), ('2027-10-11', '한글날 대체공휴일', 'PUBLIC', 'seed-2026-10'), ('2027-12-25', '성탄절', 'PUBLIC', 'seed-2026-10'), ('2027-12-27', '성탄절 대체공휴일', 'PUBLIC', 'seed-2026-10') ON CONFLICT DO NOTHING;
/* Batch7 T4 (migration 51) — additive only; the 737c631 code ignores these columns.
 * requirements.owner_stakeholder_id: 요구사항 담당자 = 01 관계자 (계정 없음), same rule as wbs_items (exactly one of owner_user_id / owner_stakeholder_id).
 * test_executions.step_results: JSON [{ index, result: 'PASS'|'FAIL' }] — 단계별 결과 from the inline 실행 기록 form.
 * test_cases.test_data / environment: 테스트 계정·데이터 and 대상 환경 (AI 테스트 시나리오, B8). No secrets — the UI says so. */
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS owner_stakeholder_id TEXT;
ALTER TABLE test_executions ADD COLUMN IF NOT EXISTS step_results TEXT;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS test_data TEXT NOT NULL DEFAULT '';
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT '';

/* Migration 54 — RELAI service payments (standalone /pricing page, founder 2026-10-20). Buyers have no RELAI account or workspace,
 * so these orders live beside billing_orders (whose workspace_id is NOT NULL). The amount comes from the fixed catalogue in
 * server/billing/service-orders.js, never from the client. No card data or billing key is stored here. */
CREATE TABLE IF NOT EXISTS service_orders (
  id                      TEXT PRIMARY KEY,                -- NicePay orderId
  product                 TEXT NOT NULL,                   -- catalogue key (agent-once | agent-monthly)
  kind                    TEXT NOT NULL CHECK (kind IN ('ONE_TIME','RECURRING')),
  provider                TEXT NOT NULL,
  goods_name              TEXT NOT NULL,
  amount                  INTEGER NOT NULL,                -- charged, VAT included
  supply_amount           INTEGER NOT NULL,
  vat_amount              INTEGER NOT NULL,
  months                  INTEGER NOT NULL DEFAULT 1,
  buyer_name              TEXT NOT NULL,
  buyer_company           TEXT NOT NULL DEFAULT '',
  buyer_email             TEXT NOT NULL,
  buyer_phone             TEXT NOT NULL,
  terms_version           TEXT NOT NULL,
  privacy_version         TEXT NOT NULL,
  consented_at            timestamptz NOT NULL DEFAULT now(),
  status                  TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVING','PAID','FAILED','REFUNDED')),   -- APPROVING: claimed by one return request (mig 55)
  provider_tid            TEXT,
  payment_method_summary  TEXT,
  receipt_url             TEXT,
  failure_code            TEXT,
  failure_message         TEXT,
  receipt_email_sent_at   timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  paid_at                 timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_orders_created ON service_orders (created_at DESC);
/* Migration 56 — 회원 탈퇴 = the users row is DELETED (founder 2026-10-20), server/auth/user-delete.js. Additive only: NOT NULL
 * relaxed where a work record outlives its author, new nullable columns, one new table. Code that predates 56 still writes every
 * column it wrote before.
 *   Work records in shared workspaces: author column → NULL, shown as '탈퇴한 사용자'. History / activity rows, whose NULL actor also
 *   means "system" (Jira sync), mark the withdrawn case with withdrawn_actor.
 *   Legally retained records (login_records 3개월, feedback 3년 as 불만·분쟁 기록, billing_orders 5년, admin_audit_logs redacted) keep
 *   no users FK value: user column → NULL, withdrawn_ref = the pseudonym of that withdrawal (account_withdrawals.ref).
 *   account_withdrawals: 계약·동의 기록 (약관/개인정보 동의 시각·버전) kept 5 years after the withdrawal, no name / e-mail. */
ALTER TABLE workspaces ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE requirements ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE wbs_items ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE change_requests ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE issues ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE risks ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE test_cases ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE acceptances ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE weekly_reports ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE comments ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE admin_audit_logs ALTER COLUMN admin_user_id DROP NOT NULL;
ALTER TABLE requirement_history ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE wbs_history ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE change_request_history ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE raid_history ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE qa_history ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE phase_transitions ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE integration_activity ADD COLUMN IF NOT EXISTS withdrawn_actor boolean NOT NULL DEFAULT false;
ALTER TABLE login_records ADD COLUMN IF NOT EXISTS withdrawn_ref TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS withdrawn_ref TEXT;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS withdrawn_ref TEXT;
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS withdrawn_ref TEXT;
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS buyer_name TEXT;     -- 대금결제 기록: who paid, on the record itself (set at checkout; filled at withdrawal for older rows)
ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS buyer_email TEXT;
CREATE TABLE IF NOT EXISTS account_withdrawals (
  ref               TEXT PRIMARY KEY,              -- 'wd_' + random; the same value is written to withdrawn_ref of the retained rows
  withdrawn_at      timestamptz NOT NULL DEFAULT now(),
  signed_up_at      timestamptz,
  terms_version     TEXT,
  terms_agreed_at   timestamptz,
  privacy_version   TEXT,
  privacy_agreed_at timestamptz,
  source            TEXT NOT NULL DEFAULT 'SELF' CHECK (source IN ('SELF', 'BACKFILL', 'INACTIVE'))   -- BACKFILL: an account withdrawn before 56 (tombstone); INACTIVE: deleted after 1 year without use (mig 65)
);
CREATE INDEX IF NOT EXISTS idx_account_withdrawals_at ON account_withdrawals(withdrawn_at);
CREATE INDEX IF NOT EXISTS idx_feedback_withdrawn ON feedback(created_at) WHERE withdrawn_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_orders_withdrawn ON billing_orders(created_at) WHERE withdrawn_ref IS NOT NULL;

-- Pricing v3 T1 (migration 61): active-project count (DRAFT / ACTIVE / ON_HOLD; COMPLETED and ARCHIVED never count; samples excluded).
CREATE INDEX IF NOT EXISTS idx_projects_ws_active ON projects(workspace_id) WHERE status IN ('DRAFT','ACTIVE','ON_HOLD') AND sample_key IS NULL;

/* Pricing v3 T2 (migration 62) — AI credit buckets, EXPIRY, Free-100 claims. Additive only (the production DB is shared with previews
 * running older code): new nullable / defaulted columns, a widened CHECK, one new table. No sum CHECK on the buckets: code that predates
 * 62 still writes `balance` alone, and ai/credits.js folds any such drift back into the buckets under the account lock.
 *   plan_balance       monthly base credits of a paid plan; expire at plan_expires_at (end of the credit cycle), never carried over
 *   promo_balance      Free 100, operator / promotion grants; no expiry while the workspace exists
 *   purchased_balance  top-ups (유상); valid PURCHASED_VALID_YEARS, refundable
 *   balance            stays the total (= plan + promo + purchased); spend order PLAN → PROMO → PURCHASED
 * credit_ledger d_plan / d_promo / d_purchased: the per-bucket split of `amount` (NULL on rows written before 62).
 * free_credit_claims: one Free-100 grant per owner account and per normalized e-mail hash (D7; 부정이용 방지, kept after withdrawal).
 * workspaces.enterprise_topup: ENTERPRISE workspaces may top up only when the contract says so (operator flag). */
ALTER TABLE workspace_credit_accounts ADD COLUMN IF NOT EXISTS plan_balance BIGINT NOT NULL DEFAULT 0 CHECK (plan_balance >= 0);
ALTER TABLE workspace_credit_accounts ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;
ALTER TABLE workspace_credit_accounts ADD COLUMN IF NOT EXISTS promo_balance BIGINT NOT NULL DEFAULT 0 CHECK (promo_balance >= 0);
ALTER TABLE workspace_credit_accounts ADD COLUMN IF NOT EXISTS purchased_balance BIGINT NOT NULL DEFAULT 0 CHECK (purchased_balance >= 0);
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS d_plan BIGINT;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS d_promo BIGINT;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS d_purchased BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_type_check' AND conrelid = 'credit_ledger'::regclass AND pg_get_constraintdef(oid) LIKE '%EXPIRY%') THEN
    ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_type_check;
    ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_type_check CHECK (type IN ('PLAN_GRANT','ADMIN_GRANT','AI_USAGE','REFUND','ADJUSTMENT','PROMOTION','PURCHASE','EXPIRY')); END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_credit_accounts_plan_due ON workspace_credit_accounts(plan_expires_at) WHERE plan_balance > 0;
CREATE TABLE IF NOT EXISTS free_credit_claims (
  owner_user_id TEXT PRIMARY KEY,                -- no FK: the claim outlives a withdrawn (hard-deleted) account
  email_hash    TEXT NOT NULL UNIQUE,            -- sha256 of the normalized e-mail (ai/credits.js emailHash)
  workspace_id  TEXT,
  granted_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS enterprise_topup boolean NOT NULL DEFAULT false;

/* Pricing v3 T3 (migration 63) — subscription lifecycle. Additive only (previews share the production DB).
 *   subscription_changes   changes the OWNER scheduled for the next renewal: DOWNGRADE (TEAM → PRO), CYCLE (월간 ↔ 연간), ADDON_REDUCE
 *                          (fewer extra users / projects). to_state = the target { plan, cycle, extra_users, extra_projects }. One SCHEDULED
 *                          row per kind and subscription (partial unique index); the renewal charge applies them (APPLIED) or they lapse
 *                          with the subscription (CANCELED).
 *   subscription_refunds   해지 환불 / 청약철회: unused KST days of each paid order of the current period, prorated (billing/prorate.js, refunds
 *                          rounded up, never more than paid), no penalty (founder 2026-10-20). REQUESTED until the provider partial cancel
 *                          succeeds (REFUND_PARTIAL_ENABLED) or an operator marks it DONE.
 *   subscriptions.ended_at / data_retention_until   when the paid plan ended and the 30-day 조회·내보내기 window after it.
 *   subscriptions.last_failed_at                    the last declined renewal (retry_count, migration 57, counts them). */
CREATE TABLE IF NOT EXISTS subscription_changes (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('DOWNGRADE','CYCLE','ADDON_REDUCE')),
  from_state      TEXT NOT NULL,                  -- JSON { plan, cycle, extra_users, extra_projects }
  to_state        TEXT NOT NULL,                  -- JSON, same shape
  effective_at    timestamptz NOT NULL,           -- the renewal it applies at (current_period_end when scheduled)
  status          TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','APPLIED','CANCELED')),
  created_by      TEXT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_changes_open ON subscription_changes(subscription_id, kind) WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS idx_subscription_changes_ws ON subscription_changes(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS subscription_refunds (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  order_id        TEXT NOT NULL REFERENCES billing_orders(id),
  kind            TEXT NOT NULL CHECK (kind IN ('WITHDRAWAL','CANCEL')),   -- WITHDRAWAL = 청약철회 (within 7 days of the payment)
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  days            INTEGER NOT NULL,               -- unused KST days refunded
  period_days     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','DONE','FAILED')),
  cancel_order_id TEXT,                           -- the new NicePay orderId of the partial cancel
  cancelled_tid   TEXT,
  failure_message TEXT,
  reason          TEXT,
  created_by      TEXT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_subscription_refunds_ws ON subscription_refunds(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscription_refunds_open ON subscription_refunds(created_at) WHERE status <> 'DONE';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS data_retention_until timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;

/* Pricing v3 T3 (migration 64) — 정기결제 동의 · 가격 변경 고지 (전자상거래법 §13②·⑥, legal-review §1, §5). Append-only records,
 * kept 5 years as 계약 기록; no card data, ip as a hash.
 *   billing_consents       one row per consent the customer gave on a checkout screen: CHECKOUT (plan subscribe), RECURRING
 *                          (자동 갱신 고지), ADDON, UPGRADE, PRICE_INCREASE (증액 동의). disclosure_hash = sha256 of the exact 고지 text shown
 *                          (billing/consent.js), terms_version = the 이용약관 version it refers to.
 *   price_change_notices   a renewal above the agreed renewal_amount: notified ≥ 30 days before, consented or declined. Without
 *                          consent the renewal is not charged and auto-renewal stops (billing/cron.js). */
CREATE TABLE IF NOT EXISTS billing_consents (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         TEXT,                           -- no FK: the record outlives a withdrawn account (5 years)
  order_id        TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('CHECKOUT','RECURRING','ADDON','UPGRADE','PRICE_INCREASE')),
  terms_version   TEXT NOT NULL,
  disclosure_hash TEXT NOT NULL,
  amount          INTEGER,                        -- charged now (VAT incl.)
  renewal_amount  INTEGER,                        -- the amount each renewal will charge (VAT incl.)
  cycle           TEXT,
  next_charge_at  timestamptz,
  ip_hash         TEXT,
  user_agent      TEXT,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_consents_ws ON billing_consents(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_consents_order ON billing_consents(order_id) WHERE order_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS price_change_notices (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  old_amount      INTEGER NOT NULL,
  new_amount      INTEGER NOT NULL,
  effective_at    timestamptz NOT NULL,           -- the renewal the new amount applies to
  notified_at     timestamptz NOT NULL DEFAULT now(),
  consented_at    timestamptz,
  consent_id      TEXT,
  declined_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_change_notices ON price_change_notices(subscription_id, effective_at);

/* Personal-data retention (migration 65, hive research/relai-retention-legal.md G-1..G-6, G-8; founder 2026-10-21 "1년 후 파기").
 * Additive only (previews share the production DB). The jobs live in server/retention.js (daily cron /api/cron/purge).
 *   users.inactive_notice_at  when the 30-day "your account will be deleted" e-mail went out (1 year without use, G-8). Any later
 *                             activity (login, signed-in request) cancels it: deletion needs the last activity to be older than the notice.
 *   admin_access_logs         개인정보처리시스템 접속기록 of operators (안전성 확보조치 기준 §8: who, when, from where, what) — every
 *                             /api/admin request, reads included. Kept 2 years. No FK: a withdrawn operator's rows are detached (withdrawn_ref). */
ALTER TABLE users ADD COLUMN IF NOT EXISTS inactive_notice_at timestamptz;
CREATE TABLE IF NOT EXISTS admin_access_logs (
  id            BIGSERIAL PRIMARY KEY,
  admin_user_id TEXT,
  withdrawn_ref TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,                   -- path + query (first 500 chars): which screen / which person was looked up
  ip            TEXT,
  user_agent    TEXT,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_access_logs_created ON admin_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_access_logs_admin ON admin_access_logs(admin_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_invitations_ended ON invitations(expires_at) WHERE status <> 'ACCEPTED';
CREATE INDEX IF NOT EXISTS idx_free_credit_claims_granted ON free_credit_claims(granted_at);
CREATE INDEX IF NOT EXISTS idx_billing_consents_created ON billing_consents(created_at);
-- Migration 65 widens account_withdrawals.source with 'INACTIVE' (older code only writes SELF / BACKFILL, so it keeps working).
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'account_withdrawals'::regclass AND conname = 'account_withdrawals_source_check';
  IF def IS NULL OR def NOT LIKE '%INACTIVE%' THEN
    ALTER TABLE account_withdrawals DROP CONSTRAINT IF EXISTS account_withdrawals_source_check;
    ALTER TABLE account_withdrawals ADD CONSTRAINT account_withdrawals_source_check CHECK (source IN ('SELF', 'BACKFILL', 'INACTIVE'));
  END IF;
END $$;
