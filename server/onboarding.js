/**
 * Onboarding (Phase 14): first-use welcome, product tour, "RELAI 시작하기" checklist, one-time feature guides, activation.
 *
 * Design rules
 * - State is per user × workspace, stored server-side (user_onboarding). The browser keeps only ephemeral tour position.
 * - Eligibility and checklist progress are COMPUTED from real data (projects, definition, requirements, WBS) on every read,
 *   so existing customers are backfilled automatically: a workspace that already has projects never gets the
 *   "첫 프로젝트를 만드세요" tour (its tour row is created COMPLETED with meta.backfilled = true).
 * - Audiences: OWNER_NEW (OWNER/ADMIN of a workspace with 0 projects at first sight), OWNER (OWNER/ADMIN, workspace already
 *   active), MEMBER (invited member — never sees the owner setup), SYSTEM_ADMIN only counts by membership.
 * - Guided execution (project "지금 해야 할 일") lives in guidance.js and is NOT onboarding: it never goes away.
 */
import { randomUUID } from 'node:crypto';
import { writeAudit } from './admin.js';
import { activationState } from './activation.js';
export { activationState, ACTIVATION, ACTIVE_WINDOW_DAYS } from './activation.js';

export const ONBOARDING_KEYS = ['WELCOME', 'PRODUCT_TOUR', 'CHECKLIST'];
export const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'];
export const GUIDE_KEYS = ['REQ_TRACE_INTRO', 'CHANGE_REQUEST_INTRO', 'ISSUE_RISK_INTRO', 'TESTING_INTRO', 'ACCEPTANCE_INTRO', 'JIRA_EXECUTION_INTRO', 'JIRA_OPTIONAL_INTRO', 'WEEKLY_REPORT_INTRO', 'AI_INTRO',
  'PHASE_INTRO_INITIATION', 'PHASE_INTRO_REQUIREMENTS', 'PHASE_INTRO_SCHEDULE', 'PHASE_INTRO_EXECUTION', 'PHASE_INTRO_TESTING', 'PHASE_INTRO_ACCEPTANCE', 'PHASE_INTRO_LAUNCH'];
export class OnboardingError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/* ---------- tour configuration (served to the client; data-tour-id targets, route templates, fallbacks) ---------- */
/** :pid is substituted with the workspace's first active project when one exists; steps needing a project are skipped otherwise. */
export const TOUR_STEPS = {
  OWNER: [
    { key: 'HOME', route: '/app', target: 'nav-home', title: 'Home — 지금 해야 할 일', body: 'Home에서는 참여 중인 프로젝트와 각 프로젝트의 다음 할 일을 한눈에 봅니다.', placement: 'right', fallback: 'center' },
    { key: 'CREATE_PROJECT', route: '/app', target: 'create-project', title: '첫 프로젝트 만들기', body: '프로젝트를 시작하려면 먼저 새 프로젝트를 만들어 주세요. 이름, 유형, 기간만 입력하면 됩니다.', placement: 'bottom', cta: { label: '프로젝트 만들기', href: '/app/projects/new' }, pauseUntilProject: true },
    { key: 'PROJECT_HOME', route: '/app/projects/:pid', target: 'guidance', title: '프로젝트 홈 — 지금 할 일', body: 'RELAI가 프로젝트 상태를 읽고 지금 해야 할 일, 이유, 다음 단계를 안내합니다. 막히면 여기로 돌아오세요.', placement: 'bottom', needsProject: true },
    { key: 'DEFINITION', route: '/app/projects/:pid', target: 'tab-definition', title: '프로젝트 정의', body: '착수 단계에서는 목표·범위·이해관계자·일정·운영 방식 5개 항목을 정리합니다. 이것이 이후 모든 판단의 기준입니다.', placement: 'bottom', needsProject: true },
    { key: 'REQUIREMENTS', route: '/app/projects/:pid', target: 'tab-requirements', title: '요구사항', body: '요구사항은 프로젝트 범위와 검수 기준입니다. 직접 입력, Excel, AI 추출로 등록할 수 있습니다.', placement: 'bottom', needsProject: true },
    { key: 'WBS', route: '/app/projects/:pid', target: 'tab-wbs', title: 'WBS — 실행 계획', body: '요구사항을 실제 작업 단위로 나누고 담당자와 일정을 정합니다. Jira를 쓴다면 작업과 Jira Issue를 연결할 수 있습니다(선택).', placement: 'bottom', needsProject: true },
    { key: 'TESTS', route: '/app/projects/:pid', target: 'tab-tests', title: 'Tests & Acceptance', body: '구현 결과를 요구사항 기준으로 검증하고, 고객 검수 결과를 기록합니다.', placement: 'bottom', needsProject: true },
    { key: 'MEMBERS', route: '/app/settings', target: 'invite-members', title: '팀원 초대', body: '동료를 초대하면 같은 Workspace에서 프로젝트를 함께 진행할 수 있습니다. 초대는 이메일로 발송됩니다.', placement: 'left', fallback: 'center', needsPermission: 'member_manage' },
  ],
  MEMBER: [
    { key: 'HOME', route: '/app', target: 'nav-home', title: 'Home — 참여 중인 프로젝트', body: 'Home에서 참여 중인 프로젝트와 현재 단계를 확인하고, 프로젝트를 열어 담당 업무를 봅니다.', placement: 'right', fallback: 'center' },
    { key: 'PROJECT_HOME', route: '/app/projects/:pid', target: 'guidance', title: '프로젝트 홈', body: '현재 단계와 지금 할 일, 확인이 필요한 항목을 봅니다.', placement: 'bottom', needsProject: true },
    { key: 'WBS', route: '/app/projects/:pid', target: 'tab-wbs', title: 'WBS — 내 업무', body: 'WBS에서 담당자 필터로 내 작업을 보고 진행률과 상태를 갱신합니다.', placement: 'bottom', needsProject: true },
    { key: 'TESTS', route: '/app/projects/:pid', target: 'tab-tests', title: 'Tests & Acceptance', body: '테스트 실행 결과와 검수 결과를 기록합니다.', placement: 'bottom', needsProject: true },
  ],
};

/* ---------- workspace facts (one query set, no per-row work) ---------- */
export async function workspaceFacts(db, workspaceId) {
  const row = await db.get(`SELECT
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED') AS projects,
      (SELECT p.id FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED' ORDER BY p.created_at LIMIT 1) AS first_project_id,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED' AND NOT EXISTS (
          SELECT 1 FROM project_steps s JOIN project_phases ph ON ph.id = s.project_phase_id WHERE ph.project_id = p.id AND ph.phase_key = 'INITIATION' AND s.is_required = 1 AND s.status <> 'COMPLETED')) AS defined_projects,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED' AND EXISTS (SELECT 1 FROM requirements r WHERE r.project_id = p.id AND r.archived_at IS NULL)) AS projects_with_requirements,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED' AND EXISTS (SELECT 1 FROM wbs_items x WHERE x.project_id = p.id AND x.archived_at IS NULL AND x.item_type = 'TASK'
          AND NOT EXISTS (SELECT 1 FROM wbs_items c WHERE c.parent_id = x.id AND c.archived_at IS NULL))) AS projects_with_wbs,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status <> 'ARCHIVED'
          AND EXISTS (SELECT 1 FROM requirements r WHERE r.project_id = p.id AND r.archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM wbs_items x WHERE x.project_id = p.id AND x.archived_at IS NULL AND x.item_type = 'TASK' AND NOT EXISTS (SELECT 1 FROM wbs_items c WHERE c.parent_id = x.id AND c.archived_at IS NULL))) AS activated_projects,
      EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.role = 'OWNER') AS has_owner,
      GREATEST(w.created_at,
        COALESCE((SELECT MAX(u.last_login_at) FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id), w.created_at),
        COALESCE((SELECT MAX(p.updated_at) FROM projects p WHERE p.workspace_id = w.id), w.created_at),
        COALESCE((SELECT MAX(r.updated_at) FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = w.id), w.created_at),
        COALESCE((SELECT MAX(x.updated_at) FROM wbs_items x JOIN projects p ON p.id = x.project_id WHERE p.workspace_id = w.id), w.created_at)) AS last_active_at,
      w.name, w.created_at
    FROM workspaces w WHERE w.id = ?`, [workspaceId]);
  if (!row) return null;
  for (const k of ['projects', 'defined_projects', 'projects_with_requirements', 'projects_with_wbs', 'activated_projects']) row[k] = Number(row[k]) || 0;
  return row;
}

export async function workspaceActivation(db, workspaceId) {
  const f = await workspaceFacts(db, workspaceId);
  if (!f) return null;
  const login = await db.get('SELECT MAX(u.last_login_at) AS t FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [workspaceId]);
  return { ...activationState({ ...f, last_login: login?.t || null }), projects: f.projects, defined_projects: f.defined_projects, activated_projects: f.activated_projects };
}

/* ---------- checklist "RELAI 시작하기" (computed) ---------- */
export function checklistSteps(f) {
  const pid = f.first_project_id;
  const u = (p) => (pid ? `/app/projects/${pid}${p}` : '/app/projects/new');
  return [
    { key: 'WORKSPACE', label: 'Workspace 생성', done: true, href: '/app/settings' },
    { key: 'PROJECT', label: '프로젝트 생성', done: f.projects > 0, href: '/app/projects/new' },
    { key: 'DEFINITION', label: '프로젝트 정의', done: f.defined_projects > 0, href: u('/definition') },
    { key: 'REQUIREMENTS', label: '요구사항 등록', done: f.projects_with_requirements > 0, href: u('/requirements') },
    { key: 'WBS', label: 'WBS 생성', done: f.projects_with_wbs > 0, href: u('/wbs') },
  ];
}

/* ---------- state rows ---------- */
async function getRow(db, userId, workspaceId, key) {
  return db.get('SELECT * FROM user_onboarding WHERE user_id = ? AND COALESCE(workspace_id, \'\') = ? AND onboarding_key = ?', [userId, workspaceId || '', key]);
}
async function ensureRow(db, userId, workspaceId, key, init = {}) {
  const ex = await getRow(db, userId, workspaceId, key);
  if (ex) return ex;
  const id = randomUUID();
  try {
    await db.run(`INSERT INTO user_onboarding (id, user_id, workspace_id, onboarding_key, status, current_step, completed_steps, meta, started_at, completed_at, skipped_at)
      VALUES (?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?)`, [id, userId, workspaceId, key, init.status || 'NOT_STARTED', init.current_step || null, JSON.stringify(init.completed_steps || []), JSON.stringify(init.meta || {}),
      init.started_at || null, init.completed_at || null, init.skipped_at || null]);
  } catch (e) { if (!/duplicate|unique/i.test(String(e.message))) throw e; }   // concurrent first read: the other insert wins (no duplicate rows)
  return getRow(db, userId, workspaceId, key);
}
const shape = (r) => (r ? { status: r.status, current_step: r.current_step, completed_steps: r.completed_steps || [], meta: r.meta || {}, started_at: r.started_at, completed_at: r.completed_at, skipped_at: r.skipped_at } : null);

/** Everything the client needs in ONE call (also embedded in /api/me-like contexts by the route). */
export async function onboardingSummary(db, { user, workspaceId, role, permissions = {} }) {
  const f = await workspaceFacts(db, workspaceId);
  if (!f) throw new OnboardingError(404, 'not_found', 'Workspace를 찾을 수 없습니다.');
  const manager = role === 'OWNER' || role === 'ADMIN';
  // First sight of this user × workspace decides the audience: a workspace that already has projects is an existing customer (backfill).
  const tourInit = f.projects > 0 && manager ? { status: 'COMPLETED', completed_at: new Date().toISOString(), meta: { backfilled: true } } : {};
  const [welcome, tour, checklist] = await Promise.all([
    ensureRow(db, user.id, workspaceId, 'WELCOME', f.projects > 0 && manager ? { status: 'COMPLETED', completed_at: new Date().toISOString(), meta: { backfilled: true } } : {}),
    ensureRow(db, user.id, workspaceId, 'PRODUCT_TOUR', tourInit),
    manager ? ensureRow(db, user.id, workspaceId, 'CHECKLIST', f.activated_projects > 0 && f.defined_projects > 0 ? { status: 'COMPLETED', completed_at: new Date().toISOString(), meta: { backfilled: true } } : {}) : Promise.resolve(null),
  ]);
  // A manager who already created projects without ever answering the welcome/tour is past first use: never surprise them with "첫 프로젝트" later.
  if (manager && f.projects > 0) {
    for (const row of [welcome, tour]) if (row.status === 'NOT_STARTED') { await db.run(`UPDATE user_onboarding SET status = 'COMPLETED', completed_at = now(), meta = meta || '{"backfilled":true}'::jsonb, updated_at = now() WHERE id = ?`, [row.id]); row.status = 'COMPLETED'; row.meta = { ...(row.meta || {}), backfilled: true }; }
  }
  const audience = !manager ? 'MEMBER' : tour.meta?.backfilled || (f.projects > 0 && tour.status === 'COMPLETED') ? 'OWNER' : 'OWNER_NEW';
  const steps = checklistSteps(f); const done = steps.filter((s) => s.done).length;
  let cl = checklist ? shape(checklist) : null;
  if (checklist && done === steps.length && checklist.status !== 'COMPLETED') {   // auto-complete from data; never un-complete
    await db.run(`UPDATE user_onboarding SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = ?`, [checklist.id]);
    cl = { ...cl, status: 'COMPLETED' };
    await writeAudit(db, { adminUserId: user.id, action: 'ONBOARDING_COMPLETED', targetType: 'WORKSPACE', targetId: workspaceId, metadata: { key: 'CHECKLIST' }, actorKind: 'USER' });
  }
  const tourSteps = (manager ? TOUR_STEPS.OWNER : TOUR_STEPS.MEMBER).filter((s) => !s.needsPermission || permissions[s.needsPermission])
    .map((s) => ({ ...s, route: s.route.replace(':pid', f.first_project_id || ':pid'), available: !s.needsProject || Boolean(f.first_project_id) }));
  const guides = (await db.all('SELECT guide_key FROM user_feature_guides WHERE user_id = ?', [user.id])).map((r) => r.guide_key);
  return {
    audience, role,
    workspace: { id: workspaceId, name: f.name, project_count: f.projects, first_project_id: f.first_project_id || null },
    welcome: shape(welcome), tour: { ...shape(tour), steps: tourSteps },
    checklist: cl ? { ...cl, steps, done, total: steps.length, visible: cl.status !== 'COMPLETED' && cl.status !== 'SKIPPED' } : null,
    guides_seen: guides,
    activation: activationState({ ...f, last_login: true }).state,
  };
}

/* ---------- writes ---------- */
export async function updateOnboarding(db, { user, workspaceId, key, action, step = null }) {
  if (!ONBOARDING_KEYS.includes(key)) throw new OnboardingError(404, 'not_found', '알 수 없는 온보딩 항목입니다.');
  const row = await ensureRow(db, user.id, workspaceId, key);
  const now = new Date().toISOString();
  const completed = Array.isArray(row.completed_steps) ? row.completed_steps : [];
  const meta = row.meta || {};
  const audit = (a, extra = {}) => writeAudit(db, { adminUserId: user.id, action: a, targetType: 'WORKSPACE', targetId: workspaceId, metadata: { key, ...extra }, actorKind: 'USER' });
  switch (action) {
    case 'start':
      await db.run(`UPDATE user_onboarding SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), current_step = ?, updated_at = now() WHERE id = ?`, [now, step || row.current_step || null, row.id]);
      if (row.status === 'NOT_STARTED') await audit('ONBOARDING_STARTED');
      break;
    case 'step': {
      if (!step) throw new OnboardingError(400, 'validation_error', 'step이 필요합니다.');
      const prev = row.current_step; const done = prev && !completed.includes(prev) && prev !== step ? [...completed, prev] : completed;
      await db.run(`UPDATE user_onboarding SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), current_step = ?, completed_steps = ?::jsonb, updated_at = now() WHERE id = ?`, [now, step, JSON.stringify(done), row.id]);
      break;
    }
    case 'complete': {
      const done = row.current_step && !completed.includes(row.current_step) ? [...completed, row.current_step] : completed;
      await db.run(`UPDATE user_onboarding SET status = 'COMPLETED', completed_at = ?, current_step = NULL, completed_steps = ?::jsonb, updated_at = now() WHERE id = ?`, [now, JSON.stringify(done), row.id]);
      await audit('ONBOARDING_COMPLETED');
      break;
    }
    case 'skip':
      await db.run(`UPDATE user_onboarding SET status = 'SKIPPED', skipped_at = ?, current_step = NULL, updated_at = now() WHERE id = ?`, [now, row.id]);
      await audit('ONBOARDING_SKIPPED', { at_step: row.current_step });
      break;
    case 'replay':   // explicit replay: keeps completed_at (history) and counts replays; status goes back to IN_PROGRESS from the first step
      await db.run(`UPDATE user_onboarding SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), current_step = ?, meta = ?::jsonb, updated_at = now() WHERE id = ?`, [now, step || null, JSON.stringify({ ...meta, replays: (Number(meta.replays) || 0) + 1, last_replay_at: now }), row.id]);
      await audit('ONBOARDING_STARTED', { replay: true });
      break;
    default: throw new OnboardingError(400, 'validation_error', '알 수 없는 동작입니다.');
  }
  return shape(await getRow(db, user.id, workspaceId, key));
}

export async function markGuideSeen(db, userId, guideKey) {
  if (!GUIDE_KEYS.includes(guideKey)) throw new OnboardingError(404, 'not_found', '알 수 없는 가이드입니다.');
  await db.run('INSERT INTO user_feature_guides (user_id, guide_key) VALUES (?,?) ON CONFLICT (user_id, guide_key) DO NOTHING', [userId, guideKey]);
  return (await db.all('SELECT guide_key FROM user_feature_guides WHERE user_id = ?', [userId])).map((r) => r.guide_key);
}
export async function resetGuides(db, userId) {   // "가이드 다시 보기": coach marks show once more
  await db.run('DELETE FROM user_feature_guides WHERE user_id = ?', [userId]);
  return [];
}

/** Minimal activation analytics (reuses admin_audit_logs with actor_kind USER). Fire-and-forget by callers. */
export async function recordFirst(db, { userId, workspaceId, projectId = null, kind }) {
  const action = { project: 'FIRST_PROJECT_CREATED', requirement: 'FIRST_REQUIREMENT_CREATED', wbs: 'FIRST_WBS_CREATED' }[kind];
  if (!action) return;
  await writeAudit(db, { adminUserId: userId, action, targetType: projectId ? 'PROJECT' : 'WORKSPACE', targetId: projectId || workspaceId, metadata: { workspace_id: workspaceId }, actorKind: 'USER' });
}
