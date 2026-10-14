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
import { addLink } from './trace.js';

export const SKELETON_SOURCE = '뼈대로 생성';
export class WbsNotEmpty extends Error { constructor() { super('WBS에 이미 항목이 있어 뼈대를 만들 수 없습니다. 뼈대는 WBS가 비어 있을 때만 만들 수 있습니다.'); this.code = 'wbs_not_empty'; } }

const liveCount = async (db, projectId) => Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ? AND archived_at IS NULL', [projectId])).n);
const keyDatesOf = async (db, projectId) => {
  const r = await db.get('SELECT key_dates FROM project_definitions WHERE project_id = ?', [projectId]);
  try { const v = r ? JSON.parse(r.key_dates) : []; return (Array.isArray(v) ? v : []).filter((k) => k && k.title); } catch { return []; }
};

/** The skeleton for this project right now (pure data; nothing is written). */
export async function skeletonPlan(db, project) {
  const reqs = await db.all(`SELECT id, display_id, title FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status = 'CONFIRMED'
    ORDER BY sequence_number`, [project.id]);
  const yes = (k) => project[k] === 'YES';
  const groups = [
    { key: 'ANALYSIS_DESIGN', title: '분석·설계', phase: 'ANALYSIS_DESIGN', tasks: ['상세 요구사항 분석', '화면 설계', 'DB 설계', ...(yes('has_external_integration') ? ['인터페이스 설계'] : [])].map((title) => ({ title })) },
    { key: 'DEVELOPMENT', title: '구현', phase: 'DEVELOPMENT', tasks: reqs.length ? reqs.map((r) => ({ title: `${r.display_id} ${r.title}`.slice(0, 200), requirement_id: r.id })) : [{ title: '기능 구현' }] },
    { key: 'TESTING', title: '시험', phase: 'TESTING', tasks: ['통합 테스트', '사용자 인수 테스트(UAT)', '결함 조치'].map((title) => ({ title })) },
    { key: 'TRANSITION', title: '전환·오픈', phase: 'TRANSITION_GO_LIVE', tasks: [...(yes('data_migration') ? ['데이터 이관'] : []), '사용자 교육', '운영 환경 배포·오픈'].map((title) => ({ title })) },
    { key: 'STABILIZE', title: '안정화', phase: 'TRANSITION_GO_LIVE', tasks: [{ title: '오픈 후 안정화 지원' }] },
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
  const toLink = []; let tasks = 0;
  for (const g of plan.groups) {
    const gid = await createWbs(db, project, { item_type: 'SUMMARY', title: g.title, lifecycle_phase: g.phase, history_source: SKELETON_SOURCE }, userId, { skipRenumber: true, skipGuard: true });
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

/** One MILESTONE per pending 01 key_date at the WBS root, after everything else (duplicates skipped). Returns the new ids.
 *  A key date already behind us (before today, APP_TIMEZONE) happened — it lands COMPLETED, so day one of 03 shows no '지연'. */
export async function milestonesFromKeyDates(db, project, userId, { source = '착수 주요 일정에서 가져옴', skipRenumber = false } = {}) {
  const ids = []; const seen = new Set(); const today = todayStr();
  for (const k of await pendingKeyDates(db, project)) {
    const key = `${k.title}\u0000${k.date || ''}`; if (seen.has(key)) continue; seen.add(key);   // the same key date twice in 01 → one milestone
    ids.push(await createWbs(db, project, { item_type: 'MILESTONE', title: String(k.title).slice(0, 200), milestone_date: k.date || null, ...(k.date && k.date < today ? { status: 'COMPLETED', actual_end_date: k.date } : {}), history_source: source }, userId, { skipRenumber: true, skipGuard: true }));
  }
  if (ids.length && !skipRenumber) await renumber(db, project.id);
  return ids;
}

/** Team (계정 없는 팀원) for the WBS owner picker + the "only the PM is registered" hint (US-1). */
export async function ownerOptions(db, project) {
  const all = await projectStakeholders(db, project.id);
  // A stakeholder who IS a workspace member (01 tells the PM to list themself) is offered once, as the RELAI 사용자 (J-A2).
  const norm = (v) => String(v || '').trim().toLowerCase();
  const members = await db.all('SELECT u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [project.workspace_id]);
  const names = new Set(members.map((m) => norm(m.name)).filter(Boolean)); const emails = new Set(members.map((m) => norm(m.email)).filter(Boolean));
  // A task that already names such a stakeholder keeps showing (and keeping) them.
  const used = new Set((await db.all('SELECT DISTINCT owner_stakeholder_id AS id FROM wbs_items WHERE project_id = ? AND owner_stakeholder_id IS NOT NULL', [project.id])).map((r) => r.id));
  const team = teamOf(all).filter((x) => used.has(x.id) || (!names.has(norm(x.name)) && !emails.has(norm(all.find((s) => s.id === x.id)?.email))));
  return { team, stakeholders_total: all.length };
}
