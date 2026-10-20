/**
 * Project Health (Phase 9) — five dimensions + overall, computed from current data, never stored.
 *
 * Structure:
 *   healthFacts(db, project)  → a handful of aggregate rows (no per-row queries)
 *   <dimension>Health(facts) → { status, reasons[], hint? }   (pure, testable)
 *   overallHealth(dimensions) → { status, partial_unknown }
 *   projectHealth(db, project) → everything above in one object
 *
 * Thresholds live in HEALTH_RULES so they can be tuned (or made per-workspace later) without touching the rules.
 */
import { LEAF_SQL, scheduleFigures, plannedPercent, todayStr, projectStakeholders, DELETED_OWNER } from './wbs.js';
const TODAY = 'CURRENT_DATE';
const LAST = `(SELECT result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;

export const STATUS = { GOOD: 'GOOD', WARNING: 'WARNING', CRITICAL: 'CRITICAL', UNKNOWN: 'UNKNOWN' };
export const STATUS_LABEL = { GOOD: '정상', WARNING: '주의', CRITICAL: '위험', UNKNOWN: '정보 부족' };
export const DIMENSIONS = ['schedule', 'scope', 'quality', 'change', 'risk'];
export const DIMENSION_LABEL = { schedule: '일정', scope: '범위', quality: '품질', change: '변경', risk: '리스크' };   // Phase 4 US-7: Korean labels

export const HEALTH_RULES = {
  schedule: { warn_tasks_min: 1, crit_tasks_min: 4, warn_milestones_min: 1, crit_milestones_min: 2 },
  scope: { crit_unlinked_ratio: 0.3, crit_approved_unimplemented_min: 3 },
  quality: { crit_fail_tests_min_in_verify: 3, verify_phases: ['TESTING', 'TRANSITION_GO_LIVE'] },
  change: { crit_approved_unimplemented_min: 3, crit_schedule_impact_days_min: 15 },
  risk: {},
};

/* ---------- facts: one aggregate query per domain ---------- */
export async function healthFacts(db, project) {
  const pid = project.id;
  const wbs = (await db.get(`SELECT
      COALESCE(SUM((item_type = 'TASK' AND ${LEAF_SQL('w')})::int), 0) AS tasks,
      COALESCE(SUM((item_type = 'TASK' AND ${LEAF_SQL('w')} AND planned_start_date IS NOT NULL AND planned_end_date IS NOT NULL)::int), 0) AS tasks_dated,
      COALESCE(SUM((item_type = 'MILESTONE')::int), 0) AS milestones,
      COALESCE(SUM((item_type = 'MILESTONE' AND milestone_date IS NOT NULL)::int), 0) AS milestones_dated,
      COALESCE(SUM((item_type = 'TASK' AND ${LEAF_SQL('w')} AND status != 'COMPLETED' AND planned_end_date IS NOT NULL AND planned_end_date < ${TODAY})::int), 0) AS overdue_tasks,
      COALESCE(SUM((item_type = 'MILESTONE' AND status != 'COMPLETED' AND milestone_date IS NOT NULL AND milestone_date < ${TODAY})::int), 0) AS overdue_milestones,
      COALESCE(SUM((${project.planned_end_date ? '(planned_end_date > ?::date OR milestone_date > ?::date)' : 'false'})::int), 0) AS beyond_project_end
    FROM wbs_items w WHERE project_id = ? AND archived_at IS NULL`, project.planned_end_date ? [project.planned_end_date, project.planned_end_date, pid] : [pid]));
  const req = (await db.get(`SELECT COUNT(*) AS in_scope,
      COALESCE(SUM((status = 'CONFIRMED')::int), 0) AS confirmed,
      COALESCE(SUM((status != 'CONFIRMED')::int), 0) AS unconfirmed,
      COALESCE(SUM((status = 'REVIEWING')::int), 0) AS reviewing,
      COALESCE(SUM((status = 'CONFIRMED' AND NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = r.id AND w.archived_at IS NULL))::int), 0) AS confirmed_unlinked
    FROM requirements r WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status <> 'REJECTED'`, [pid]));   // N1
  const chg = (await db.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM((status = 'UNDER_REVIEW')::int), 0) AS under_review,
      COALESCE(SUM((status = 'APPROVED')::int), 0) AS approved_unimplemented,
      COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN schedule_impact_days ELSE 0 END), 0) AS approved_schedule_days
    FROM change_requests WHERE project_id = ? AND archived_at IS NULL`, [pid]));
  const iss = (await db.get(`SELECT
      COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED'))::int), 0) AS open,
      COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED') AND severity = 'CRITICAL')::int), 0) AS critical_open,
      COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED') AND severity = 'HIGH')::int), 0) AS high_open,
      COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED') AND due_date IS NOT NULL AND due_date < ${TODAY})::int), 0) AS overdue
    FROM issues WHERE project_id = ? AND archived_at IS NULL`, [pid]));
  const tst = (await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((${LAST} = 'FAIL')::int), 0) AS last_fail
    FROM test_cases t WHERE project_id = ? AND archived_at IS NULL`, [pid]));
  const acc = (await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((status = 'REWORK_REQUIRED')::int), 0) AS rework,
      COALESCE(SUM((status IN ('REQUESTED','REWORK_REQUIRED') AND due_date IS NOT NULL AND due_date < ${TODAY})::int), 0) AS overdue
    FROM acceptances WHERE project_id = ? AND archived_at IS NULL`, [pid]));
  const rsk = (await db.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM((status IN ('OPEN','MONITORING'))::int), 0) AS active,
      COALESCE(SUM((status IN ('OPEN','MONITORING') AND risk_level = 'CRITICAL')::int), 0) AS critical,
      COALESCE(SUM((status IN ('OPEN','MONITORING') AND risk_level = 'HIGH')::int), 0) AS high,
      COALESCE(SUM((status IN ('OPEN','MONITORING') AND review_date IS NOT NULL AND review_date < ${TODAY})::int), 0) AS review_overdue
    FROM risks WHERE project_id = ? AND archived_at IS NULL`, [pid]));
  return { phase: project.current_phase, wbs, req, chg, iss, tst, acc, rsk };
}

/* ---------- dimension rules (pure) ---------- */
const n = (v) => Number(v) || 0;

export function scheduleHealth(f, R = HEALTH_RULES.schedule) {
  const w = f.wbs; const reasons = [];
  if (n(w.tasks_dated) === 0 && n(w.milestones_dated) === 0) return { status: STATUS.UNKNOWN, reasons: ['일정이 입력된 WBS 작업/마일스톤이 없습니다.'], hint: '일정 상태를 확인하려면 WBS 일정을 입력하세요.' };
  if (n(w.overdue_tasks)) reasons.push(`종료 예정일이 지난 WBS ${w.overdue_tasks}건`);
  if (n(w.overdue_milestones)) reasons.push(`날짜가 지난 마일스톤 ${w.overdue_milestones}건`);
  if (n(w.beyond_project_end)) reasons.push(`프로젝트 종료일을 넘는 WBS ${w.beyond_project_end}건`);   // UX-008
  if (n(w.overdue_tasks) >= R.crit_tasks_min || n(w.overdue_milestones) >= R.crit_milestones_min) return { status: STATUS.CRITICAL, reasons };
  if (n(w.overdue_tasks) >= R.warn_tasks_min || n(w.overdue_milestones) >= R.warn_milestones_min) return { status: STATUS.WARNING, reasons };
  if (n(w.beyond_project_end)) return { status: STATUS.WARNING, reasons };
  return { status: STATUS.GOOD, reasons: [`일정이 지난 작업/마일스톤이 없습니다 (일정 입력 작업 ${w.tasks_dated}건)`] };
}

export function scopeHealth(f, R = HEALTH_RULES.scope) {
  const r = f.req; const c = f.chg; const reasons = [];
  if (n(r.in_scope) === 0) return { status: STATUS.UNKNOWN, reasons: ['범위 내 요구사항이 없습니다.'], hint: '범위 상태를 확인하려면 요구사항의 범위를 범위 내로 정하세요.' };
  if (n(r.unconfirmed)) reasons.push(`미확정 요구사항 ${r.unconfirmed}건`);
  if (n(r.confirmed_unlinked)) reasons.push(`확정된 범위 내 요구사항 ${r.confirmed_unlinked}건이 WBS와 미연결`);
  if (n(c.approved_unimplemented)) reasons.push(`승인 후 미반영 변경 ${c.approved_unimplemented}건`);
  const ratio = n(r.confirmed) ? n(r.confirmed_unlinked) / n(r.confirmed) : 0;
  if (ratio >= R.crit_unlinked_ratio && n(r.confirmed_unlinked) > 0) return { status: STATUS.CRITICAL, reasons: [...reasons, `확정 요구사항 중 WBS 미연결 비율 ${Math.round(ratio * 100)}%`] };
  if (n(c.approved_unimplemented) >= R.crit_approved_unimplemented_min) return { status: STATUS.CRITICAL, reasons };
  if (reasons.length) return { status: STATUS.WARNING, reasons };
  return { status: STATUS.GOOD, reasons: [`범위 내 요구사항 ${r.in_scope}건 모두 확정·WBS 연결됨`] };
}

export function qualityHealth(f, R = HEALTH_RULES.quality) {
  const i = f.iss; const t = f.tst; const a = f.acc; const reasons = [];
  if (n(i.critical_open)) reasons.push(`심각한 이슈 ${i.critical_open}건`);
  if (n(i.high_open)) reasons.push(`높음 이슈 ${i.high_open}건`);
  if (n(t.last_fail)) reasons.push(`최근 실패한 테스트 ${t.last_fail}건`);
  if (n(a.rework)) reasons.push(`보완 필요 검수 ${a.rework}건`);
  if (n(i.critical_open)) return { status: STATUS.CRITICAL, reasons };
  if (R.verify_phases.includes(f.phase) && n(t.last_fail) >= R.crit_fail_tests_min_in_verify) return { status: STATUS.CRITICAL, reasons: [...reasons, `시험/전환 단계에서 실패 테스트 다수`] };
  if (reasons.length) return { status: STATUS.WARNING, reasons };
  if (n(i.open) === 0 && n(t.total) === 0 && n(a.total) === 0) return { status: STATUS.UNKNOWN, reasons: ['이슈·테스트·검수 데이터가 아직 없습니다.'], hint: '품질 상태는 이슈, 테스트, 검수가 등록되면 계산됩니다.' };
  return { status: STATUS.GOOD, reasons: ['심각·높음 이슈, 실패 테스트, 보완 필요 검수가 없습니다.'] };
}

export function changeHealth(f, R = HEALTH_RULES.change) {
  const c = f.chg; const reasons = [];
  if (n(c.under_review)) reasons.push(`검토 중 변경 ${c.under_review}건`);
  if (n(c.approved_unimplemented)) reasons.push(`승인 후 미반영 변경 ${c.approved_unimplemented}건`);
  if (n(c.approved_unimplemented) >= R.crit_approved_unimplemented_min) return { status: STATUS.CRITICAL, reasons };
  if (n(c.approved_schedule_days) >= R.crit_schedule_impact_days_min) return { status: STATUS.CRITICAL, reasons: [...reasons, `미반영 변경의 입력된 일정 영향 합계 ${c.approved_schedule_days}일 (예측치 아님)`] };
  if (reasons.length) return { status: STATUS.WARNING, reasons };
  return { status: STATUS.GOOD, reasons: [n(c.total) ? '검토 중이거나 미반영된 변경이 없습니다.' : '등록된 변경 요청이 없습니다.'] };
}

export function riskHealth(f) {
  const r = f.rsk; const reasons = [];
  if (n(r.total) === 0) return { status: STATUS.UNKNOWN, reasons: ['등록된 리스크가 없습니다.'], hint: '리스크가 0건이라고 프로젝트가 안전한 것은 아닙니다. 식별된 리스크를 등록하세요.' };
  if (n(r.critical)) reasons.push(`심각한 리스크 ${r.critical}건`);
  if (n(r.high)) reasons.push(`높음 리스크 ${r.high}건`);
  if (n(r.review_overdue)) reasons.push(`검토일이 지난 리스크 ${r.review_overdue}건`);
  if (n(r.critical)) return { status: STATUS.CRITICAL, reasons };
  if (reasons.length) return { status: STATUS.WARNING, reasons };
  if (n(r.active) === 0) return { status: STATUS.GOOD, reasons: ['활성 리스크가 없습니다 (종료/발생 처리됨).'] };
  return { status: STATUS.GOOD, reasons: [`활성 리스크 ${r.active}건 모두 낮음/보통`] };
}

export function overallHealth(dims) {
  const st = Object.values(dims).map((d) => d.status);
  const partial = st.includes(STATUS.UNKNOWN) && st.some((s) => s !== STATUS.UNKNOWN);
  if (st.includes(STATUS.CRITICAL)) return { status: STATUS.CRITICAL, partial_unknown: partial };
  if (st.includes(STATUS.WARNING)) return { status: STATUS.WARNING, partial_unknown: partial };
  if (st.every((s) => s === STATUS.UNKNOWN)) return { status: STATUS.UNKNOWN, partial_unknown: false };
  return { status: STATUS.GOOD, partial_unknown: partial };
}

/** Rule evaluation only (facts supplied) — used by tests and by projectHealth. */
export function evaluateHealth(facts) {
  const dimensions = {
    schedule: scheduleHealth(facts), scope: scopeHealth(facts), quality: qualityHealth(facts), change: changeHealth(facts), risk: riskHealth(facts),
  };
  for (const k of DIMENSIONS) dimensions[k] = { key: k, label: DIMENSION_LABEL[k], ...dimensions[k], status_label: STATUS_LABEL[dimensions[k].status] };
  const overall = overallHealth(dimensions);
  return { ...overall, status_label: STATUS_LABEL[overall.status], dimensions };
}

export async function projectHealth(db, project) {
  return evaluateHealth((await healthFacts(db, project)));
}

/* ---------- 진척 편차 근거 (batch7 B9 · #21): same numbers for the AI 질의응답 context and the Overview '이유 보기' (no AI) ---------- */
/**
 * Why planned ≠ actual. Figures = scheduleFigures() (the Overview KPI), plus the leaf tasks that pull the actual progress below the plan
 * the most: contribution = weight share × (plannedPercent − progress), in %p, largest first (positive only). `undated` = tasks without both dates.
 * Pure over rows → varianceFromTasks(tasks, milestones, today); varianceDrivers(db, project, limit) loads them.
 */
export function varianceFromTasks(tasks, milestones = [], today = todayStr(), limit = 10) {
  const f = scheduleFigures(tasks, milestones, today);
  const w = (t) => (t.weight === null || t.weight === undefined ? 1 : Number(t.weight));
  const dated = tasks.filter((t) => t.planned_start_date && t.planned_end_date);
  const totalW = dated.reduce((a, t) => a + w(t), 0); const share = (t) => (totalW > 0 ? w(t) / totalW : 1 / (dated.length || 1));
  const drivers = dated.map((t) => { const pp = plannedPercent(t, today); const gap = pp - (Number(t.progress) || 0);
    return { id: t.id, wbs_code: t.wbs_code, title: t.title, planned: pp, progress: Number(t.progress) || 0, end: t.planned_end_date, owner: t.owner_name || null, contribution: Math.round(share(t) * gap * 10) / 10 }; })
    .filter((d) => d.contribution > 0).sort((a, b) => b.contribution - a.contribution || String(a.wbs_code).localeCompare(String(b.wbs_code))).slice(0, limit);
  return { planned: f.planned_progress, actual: f.progress, variance: f.variance, basis: f.planned_basis, undated: tasks.length - dated.length,
    overdue_tasks: f.overdue_tasks, overdue_milestones: f.overdue_milestones, max_overdue_days: f.max_overdue_days, drivers };
}
export async function varianceDrivers(db, project, limit = 10) {
  const rows = await db.all(`SELECT w.id, w.wbs_code, w.title, w.item_type, w.status, w.progress, w.weight, w.planned_start_date, w.planned_end_date, w.milestone_date, w.owner_stakeholder_id, u.name AS owner_name
    FROM wbs_items w LEFT JOIN users u ON u.id = w.owner_user_id WHERE w.project_id = ? AND w.archived_at IS NULL AND w.system_key IS NULL
      AND (w.item_type = 'MILESTONE' OR (w.item_type = 'TASK' AND ${LEAF_SQL('w')})) ORDER BY w.wbs_code`, [project.id]);
  const sh = new Map((await projectStakeholders(db, project.id)).map((x) => [x.id, x.name]));
  for (const r of rows) if (!r.owner_name && r.owner_stakeholder_id) r.owner_name = sh.get(r.owner_stakeholder_id) || DELETED_OWNER;
  return varianceFromTasks(rows.filter((r) => r.item_type === 'TASK'), rows.filter((r) => r.item_type === 'MILESTONE'), todayStr(), limit);
}
const pct = (v) => (v === null || v === undefined ? '-' : `${v}%`);
/** The '진척 요약' block of the AI context. */
export function varianceText(v) {
  const head = `계획 진척률 ${pct(v.planned)} · 실제 ${pct(v.actual)} · 편차 ${v.variance === null || v.variance === undefined ? '-' : `${v.variance > 0 ? '+' : ''}${v.variance}%p`}`;
  const basis = `기준: 계획일이 있는 작업 ${v.basis.dated}/${v.basis.tasks}건 · 계획일 없는 작업 ${v.undated}건 · 지연 작업 ${v.overdue_tasks}건 · 지연 마일스톤 ${v.overdue_milestones}건 · 최대 지연 ${v.max_overdue_days}일`;
  const list = v.drivers.length ? v.drivers.map((d) => `- ${d.wbs_code} ${d.title} · 계획 ${d.planned}% · 실제 ${d.progress}% · 종료 예정 ${d.end || '-'} · 담당 ${d.owner || '미지정'} (편차 기여 ${d.contribution}%p)`).join('\n') : '- (계획보다 늦은 작업 없음)';
  return `## 진척 요약\n${head}\n${basis}\n편차 기여 상위 작업 (가중치 × (계획 진척 − 실제 진척) 큰 순):\n${list}`;
}
