/**
 * Phase 3 (03 분석·설계) — rule-based `WBS 뼈대 만들기` (US-2, not AI) and 01 주요 일정 → WBS 마일스톤 (US-4).
 *
 *   skeletonPlan(db, project)               → the groups/tasks/milestones the skeleton would create (preview = counts only)
 *   createSkeleton(db, project, userId)     → creates them in the caller's transaction; 409 (WbsNotEmpty) unless the WBS is empty
 *   milestonesFromKeyDates(db, project, …)  → one MILESTONE per 01 key_date, skipping a live milestone with the same title + date
 *
 * Groups are SUMMARY, tasks TASK, every one tagged with its lifecycle_phase; dates and owners stay empty (the PM fills them —
 * the next guide rows say so). Each 구현 task is linked (유형 구현) to its in-scope confirmed requirement.
 */
import { createWbs, renumber, projectStakeholders, teamOf, todayStr } from './wbs.js';
import { ensureStructure, nodeIdFor, wantsDm, SKELETON_SOURCE } from './wbs-structure.js';
import { addLink } from './trace.js';
import { syncMilestones } from './milestone-sync.js';
import { assertWithinLimit } from './billing/limits.js';

/** A key date that names the 오픈 ('서비스 오픈', 'Go-Live') becomes the go-live milestone (tagged 06 전환 및 오픈) — 완료보고서 §1 and 오픈 완료 use it. */
export const GO_LIVE_TITLE = /오픈|go[- ]?live/i;
export { SKELETON_SOURCE };
export class WbsNotEmpty extends Error { constructor() { super('WBS에 이미 작성한 항목이 있어 뼈대를 만들 수 없습니다. 뼈대는 단계 아래가 비어 있을 때만 만들 수 있습니다.'); this.code = 'wbs_not_empty'; } }

/** batch7: the fixed phase nodes are structure, so 'empty' = no user item (system_key IS NULL). */
const liveCount = async (db, projectId) => Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND system_key IS NULL', [projectId])).n);
const keyDatesOf = async (db, projectId) => {
  const r = await db.get('SELECT key_dates FROM project_definitions WHERE project_id = ?', [projectId]);
  try { const v = r ? JSON.parse(r.key_dates) : []; return (Array.isArray(v) ? v : []).filter((k) => k && k.title); } catch { return []; }
};

/** The skeleton for this project right now (pure data; nothing is written). */
export async function skeletonPlan(db, project) {
  const reqs = await db.all(`SELECT id, display_id, title FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status = 'CONFIRMED'
    ORDER BY sequence_number`, [project.id]);
  const yes = (k) => project[k] === 'YES';
  // batch7 B3: one group per fixed phase node (the tasks go under the node; nothing new at the root). 안정화 is a 전환·오픈 task now.
  const groups = [
    { key: 'INITIATION', title: '착수', phase: 'INITIATION', plan: 'INITIATION', tasks: ['착수보고회', '사업수행계획서 작성'].map((title) => ({ title })) },
    { key: 'REQUIREMENTS', title: '요구사항 정의', phase: 'REQUIREMENTS', plan: 'REQUIREMENTS', tasks: ['요구사항 수집·정의', '요구사항 기준선 승인'].map((title) => ({ title })) },
    { key: 'ANALYSIS_DESIGN', title: '분석·설계', phase: 'ANALYSIS_DESIGN', plan: 'ANALYSIS_DESIGN', tasks: ['상세 요구사항 분석', '화면 설계', 'DB 설계', ...(yes('has_external_integration') ? ['인터페이스 설계'] : [])].map((title) => ({ title })) },
    ...(wantsDm(project) ? [{ key: 'DATA_MIGRATION', title: '데이터 이관', phase: 'TRANSITION_GO_LIVE', plan: 'DATA_MIGRATION', tasks: ['이관 대상 분석·매핑', '데이터 이관·검증'].map((title) => ({ title })) }] : []),
    { key: 'DEVELOPMENT', title: '구현', phase: 'DEVELOPMENT', plan: 'DEVELOPMENT', tasks: reqs.length ? reqs.map((r) => ({ title: `${r.display_id} ${r.title}`.slice(0, 200), requirement_id: r.id })) : [{ title: '기능 구현' }] },
    { key: 'TESTING', title: '시험', phase: 'TESTING', plan: 'TESTING', tasks: ['통합 테스트', '고객 인수 테스트(UAT)', '결함 조치'].map((title) => ({ title })) },
    { key: 'TRANSITION', title: '전환·오픈', phase: 'TRANSITION_GO_LIVE', plan: 'TRANSITION_GO_LIVE', tasks: ['사용자 교육', '운영 환경 배포·오픈', '오픈 후 안정화 지원'].map((title) => ({ title })) },
  ];
  const milestones = await keyDatesOf(db, project.id);
  const tasks = groups.reduce((a, g) => a + g.tasks.length, 0);
  return { groups, milestones, linked: reqs.length, confirmed: reqs.length, tasks, total: tasks + milestones.length };
}

/** Preview for the confirm dialog: counts only (그룹명 + 건수). `available` = the WBS is empty, so the skeleton can be made. */
export async function skeletonPreview(db, project) {
  const plan = await skeletonPlan(db, project);
  return { available: (await liveCount(db, project.id)) === 0, groups: plan.groups.map((g) => ({ key: g.key, title: g.title, count: g.tasks.length })),
    milestones: plan.milestones.length, linked: plan.linked, confirmed: plan.confirmed, tasks: plan.tasks, total: plan.total };
}

/** Create the skeleton (caller wraps in a transaction). Returns { created, tasks, milestones, linked }. */
export async function createSkeleton(db, project, userId) {
  if ((await liveCount(db, project.id)) > 0) throw new WbsNotEmpty();
  const plan = await skeletonPlan(db, project);
  await assertWithinLimit(db, project.workspace_id, 'wbs', plan.groups.reduce((a, g) => a + 1 + g.tasks.length, 0));   // batch7 #24: all or nothing
  const toLink = []; let tasks = 0;
  await ensureStructure(db, project, userId);
  for (const g of plan.groups) {
    const gid = await nodeIdFor(db, project, g.plan, userId);
    for (const t of g.tasks) {
      const id = await createWbs(db, project, { item_type: 'TASK', title: t.title, lifecycle_phase: g.phase, parent_id: gid, history_source: SKELETON_SOURCE }, userId, { skipRenumber: true, skipGuard: true });
      tasks++;
      if (t.requirement_id) toLink.push([t.requirement_id, id]);
    }
  }
  const ms = await milestonesFromKeyDates(db, project, userId, { source: SKELETON_SOURCE, skipRenumber: true });
  await renumber(db, project.id);
  // 구현 tasks → their requirement (유형 구현). The WBS was empty, so no link can exist yet; the check keeps it idempotent anyway.
  let linked = 0;
  for (const [rid, wid] of toLink) {
    if (await db.get('SELECT 1 FROM requirement_wbs_links WHERE requirement_id = ? AND wbs_item_id = ?', [rid, wid])) continue;
    const requirement = await db.get('SELECT * FROM requirements WHERE id = ?', [rid]); const wbs = await db.get('SELECT * FROM wbs_items WHERE id = ?', [wid]);
    await addLink(db, project, { requirement, wbs }, 'IMPLEMENTS', userId); linked++;
  }
  return { created: tasks + ms.length, tasks, milestones: ms.length, linked };
}

/** 01 key_dates not yet in the WBS as a live milestone with the same title + date (US-4 suggestion count). */
export async function pendingKeyDates(db, project) {
  const kd = await keyDatesOf(db, project.id); if (!kd.length) return [];
  const have = await db.all(`SELECT title, milestone_date FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND item_type = 'MILESTONE'`, [project.id]);
  const seen = new Set(have.map((m) => `${m.title}\u0000${m.milestone_date || ''}`));
  return kd.filter((k) => !seen.has(`${k.title}\u0000${k.date || ''}`));
}

/** The fixed node a key-date milestone belongs under by its name ('킥오프' → 착수, '요구사항 확정' → 요구사항 정의, '오픈' → 전환·오픈); null = the root. */
export const MILESTONE_PLAN = [['TRANSITION_GO_LIVE', GO_LIVE_TITLE], ['INITIATION', /착수|킥오프|kick-?off/i], ['REQUIREMENTS', /요구사항/], ['ANALYSIS_DESIGN', /설계|분석/], ['DATA_MIGRATION', /이관/], ['DEVELOPMENT', /개발|구현/], ['TESTING', /테스트|시험|검수|UAT/i], ['TRANSITION_GO_LIVE', /전환|배포|안정화/]];
export const milestonePlan = (title) => (MILESTONE_PLAN.find(([, re]) => re.test(String(title || ''))) || [null])[0];
async function milestoneParent(db, project, title, userId) {
  let plan = milestonePlan(title); if (!plan) return null;
  if (plan === 'DATA_MIGRATION' && !wantsDm(project) && !(await db.get(`SELECT 1 FROM wbs_items WHERE project_id = ? AND system_key = 'OPT:DATA_MIGRATION' AND archived_at IS NULL`, [project.id]))) plan = 'TRANSITION_GO_LIVE';
  return nodeIdFor(db, project, plan, userId);
}

/** One MILESTONE per pending 01 key_date at the WBS root, after everything else (duplicates skipped). Returns the new ids.
 *  A key date already behind us (before today, APP_TIMEZONE) happened — it lands COMPLETED, so day one of 03 shows no '지연'. */
export async function milestonesFromKeyDates(db, project, userId, { source = '착수 주요 일정에서 가져옴', skipRenumber = false } = {}) {
  const ids = []; const seen = new Set(); const today = todayStr();
  for (const k of await pendingKeyDates(db, project)) {
    const key = `${k.title}\u0000${k.date || ''}`; if (seen.has(key)) continue; seen.add(key);   // the same key date twice in 01 → one milestone
    const parentId = await milestoneParent(db, project, k.title, userId);   // batch7: 01 주요 일정 → the matching phase node (오픈 → 전환·오픈); no match → root end
    ids.push(await createWbs(db, project, { item_type: 'MILESTONE', title: String(k.title).slice(0, 200), parent_id: parentId, ...(GO_LIVE_TITLE.test(k.title) ? { lifecycle_phase: 'TRANSITION_GO_LIVE' } : {}), milestone_date: k.date || null, ...(k.date && k.date < today ? { status: 'COMPLETED', actual_end_date: k.date } : {}), history_source: source }, userId, { skipRenumber: true, skipGuard: true }));
  }
  if (ids.length && !skipRenumber) await renumber(db, project.id);
  if (ids.length) await syncMilestones(db, project, userId);   // F3: a 착수보고회 already held lands 완료
  return ids;
}

const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
const TITLE_WORD = /^(pm|pl|pmo|po|팀장|대표|이사|상무|전무|부장|차장|과장|대리|주임|사원|매니저|책임|선임|수석|님)$/i;
/** Same person as a workspace member? Email, or the name with spaces ignored — a member signed up as '김하늘 PM' (a trailing title word) is the
 *  stakeholder '김하늘' (role '수행 PM'); '김하늘 수행 PM' (name + role) matches too. Pure — unit-tested (demo finding: PM listed twice). */
export function isMemberStakeholder(sh, members) {
  const em = norm(sh.email); const nm = norm(sh.name); if (!nm && !em) return false;
  const shKeys = new Set([nm, norm(`${sh.name || ''}${sh.role || ''}`)].filter(Boolean));
  return (members || []).some((m) => {
    if (em && norm(m.email) === em) return true;
    const words = String(m.name || '').trim().split(/\s+/).filter(Boolean); if (!words.length) return false;
    while (words.length > 1 && TITLE_WORD.test(words[words.length - 1])) words.pop();
    return shKeys.has(norm(m.name)) || shKeys.has(norm(words.join('')));
  });
}

/** Team (계정 없는 팀원) for the WBS owner picker + the "only the PM is registered" hint (US-1). */
export async function ownerOptions(db, project) {
  const all = await projectStakeholders(db, project.id);
  // A stakeholder who IS a workspace member (01 tells the PM to list themself) is offered once, as the RELAI 사용자 (J-A2).
  const members = await db.all('SELECT u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [project.workspace_id]);
  // K13: such a stakeholder is flagged `member` and every picker hides them unless THIS item already names them (shared/owner-picker.js teamFor).
  const team = teamOf(all).map((x) => { const sh = all.find((s) => s.id === x.id) || x; const y = { ...x, org: sh.org || '', department: sh.department || '' }; return isMemberStakeholder(sh, members) ? { ...y, member: true } : y; });   // org/department: the shared picker's 조직·부서 step (batch7 #11)
  // batch7 #11: every named 01 관계자 with 조직·부서 — the 요구사항 담당자 may be anyone in 01 (고객사 현업 included); WBS / 이슈 keep `team`
  const directory = all.filter((x) => x.name).map((x) => ({ id: x.id, name: x.name, role: x.role || '', org_type: x.org_type || 'OTHER', org: x.org || '', department: x.department || '', ...(isMemberStakeholder(x, members) ? { member: true } : {}) }));
  return { team, directory, stakeholders_total: all.length };
}
