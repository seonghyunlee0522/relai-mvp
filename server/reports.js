/**
 * Weekly Report (Phase 9 §14–30).
 *
 * Generation builds STRUCTURED data first (one aggregate query per block, period-bounded by history/executions,
 * never by updated_at alone), derives editable markdown sections from it, then renders the whole report.
 * Users edit section bodies; rendered_content is always re-derived from sections on save.
 * No LLM is involved — the project has no LLM integration, so the structured report is the product.
 */
import { randomUUID } from 'node:crypto';
import { now, str } from './common.js';
import { ValidationError, isDate } from './validate.js';
import { assertWithinLimit } from './billing/limits.js';
import { loadGuide } from './guide.js';
import * as M from './metrics.js';
import { projectHealth, STATUS_LABEL } from './health.js';
import { LEAF_SQL, OWNER_NAME_SQL } from './wbs.js';
import { accApprovalView } from './testing.js';
import { priorGapsText } from './closing.js';
import { goLiveMilestone } from './golive.js';
import { diffDays, weekKst, todayKst } from '../public/app/shared/kst-date.js';

const TODAY = 'CURRENT_DATE';
const LAST = `(SELECT result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;
/** History timestamps are UTC ISO; period bounds are local dates. */
const IN_PERIOD = (col) => `(${col})::date BETWEEN ? AND ?`;
const ISSUE_STATUS = { OPEN: '열림', IN_PROGRESS: '진행 중', BLOCKED: '차단됨', RESOLVED: '해결', CLOSED: '종료' };
const SEVERITY = { CRITICAL: '심각', HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };   // US-7: no English enum values in the report body
const RISK_STATUS = { OPEN: '열림', MONITORING: '모니터링', MATERIALIZED: '발생', CLOSED: '종료' };
const CR_STATUS = { DRAFT: '초안', UNDER_REVIEW: '검토 중', APPROVED: '승인', REJECTED: '반려', IMPLEMENTED: '반영 완료' };
const ACC_STATUS = { DRAFT: '초안', REQUESTED: '검수 요청', ACCEPTED: '승인', REJECTED: '반려', REWORK_REQUIRED: '보완 필요' };
const REQ_STATUS = { DRAFT: '초안', REVIEWING: '검토 중', CONFIRMED: '확정', ON_HOLD: '보류', REJECTED: '반려' };

export const SECTIONS = [
  ['status', '프로젝트 현황'], ['completed', '금주 주요 완료사항'], ['in_progress', '진행 중 주요 업무'], ['issues_risks', '주요 이슈 및 리스크'],
  ['changes', '변경사항'], ['test_acceptance', '테스트 / 검수 현황'], ['decisions', '확인 및 의사결정 필요사항'], ['next_week', '차주 계획'],
];

/* ---------- period ---------- */
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** Q13-2: the default period is this whole week, Monday–Sunday in Korea time — the same week as the 04 WEEKLY_REPORT task and the dialog copy. */
export function defaultPeriod(at = new Date()) {
  const wk = weekKst(at);
  return { period_start: wk.start, period_end: wk.end };
}
/** Phase 4 US-3 — 04 WEEKLY_REPORT state for this week (Mon–Sun, Korea time), computed on every read (never stored):
 *  FINAL report whose period overlaps the week → { state: 'FINAL' }, else a DRAFT → 'DRAFT', else 'NONE'. */
export async function weeklyReportState(db, projectId, at = new Date()) {
  const wk = weekKst(at);
  const rows = await db.all(`SELECT id, status, finalized_at, updated_at FROM weekly_reports WHERE project_id = ? AND report_type = 'WEEKLY' AND period_start <= ? AND period_end >= ?
    ORDER BY (status = 'FINAL') DESC, COALESCE(finalized_at, updated_at) DESC`, [projectId, wk.end, wk.start]);
  const fin = rows.find((r) => r.status === 'FINAL'); const draft = rows.find((r) => r.status === 'DRAFT');
  return { week: wk, state: fin ? 'FINAL' : draft ? 'DRAFT' : 'NONE', report_id: (fin || draft || {}).id || null, finalized_at: fin ? fin.finalized_at : null };
}

export function parsePeriod(body = {}) {
  const f = {}; const s = str(body.period_start); const e = str(body.period_end);
  if (!isDate(s)) f.period_start = '시작일을 입력하세요 (YYYY-MM-DD).';
  if (!isDate(e)) f.period_end = '종료일을 입력하세요 (YYYY-MM-DD).';
  if (!f.period_start && !f.period_end && e < s) f.period_end = '종료일은 시작일보다 이전일 수 없습니다.';
  if (!f.period_start && !f.period_end && (new Date(e) - new Date(s)) / 86400000 > 92) f.period_end = '보고 기간은 최대 3개월입니다.';
  if (Object.keys(f).length) throw new ValidationError(f);
  return { period_start: s, period_end: e };
}

/* ---------- structured data (one aggregate query per block) ---------- */
export async function buildReportData(db, project, { period_start: s, period_end: e }) {
  const pid = project.id; const guide = (await loadGuide(db, project)); const health = (await projectHealth(db, project)); const stats = (await M.projectStats(db, project));
  const kpis = (await M.headlineKpis(db, project, stats));

  const completed = [
    ...(await db.all(`SELECT 'WBS' AS type, w.wbs_code AS display_id, w.title, 'COMPLETED' AS event, COALESCE(w.actual_end_date, (w.updated_at)::date) AS at FROM wbs_items w
      WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type != 'SUMMARY' AND (w.item_type = 'MILESTONE' OR ${LEAF_SQL('w')}) AND w.status = 'COMPLETED' AND COALESCE(w.actual_end_date, (w.updated_at)::date) BETWEEN ? AND ?`, [pid, s, e])),
    ...(await db.all(`SELECT 'REQUIREMENT' AS type, r.display_id, r.title, 'CONFIRMED' AS event, MAX((h.changed_at)::date) AS at FROM requirement_history h JOIN requirements r ON r.id = h.requirement_id
      WHERE r.project_id = ? AND r.archived_at IS NULL AND ((h.action_type = 'UPDATED' AND h.field_name = 'status' AND h.new_value = 'CONFIRMED')
        OR (h.action_type = 'CREATED' AND r.status = 'CONFIRMED' AND NOT EXISTS (SELECT 1 FROM requirement_history x WHERE x.requirement_id = r.id AND x.field_name = 'status')))
        AND ${IN_PERIOD('h.changed_at')} GROUP BY r.id`, [pid, s, e])),
    ...(await db.all(`SELECT 'ISSUE' AS type, i.display_id, i.title, MAX(h.new_value) AS event, MAX((h.changed_at)::date) AS at FROM raid_history h JOIN issues i ON i.id = h.entity_id
      WHERE h.entity_type = 'ISSUE' AND i.project_id = ? AND i.archived_at IS NULL AND h.action_type = 'STATUS_CHANGED' AND h.new_value IN ('RESOLVED','CLOSED') AND ${IN_PERIOD('h.changed_at')} GROUP BY i.id`, [pid, s, e])),
    ...(await db.all(`SELECT 'CHANGE' AS type, c.display_id, c.title, h.new_value AS event, MAX((h.changed_at)::date) AS at FROM change_request_history h JOIN change_requests c ON c.id = h.change_request_id
      WHERE c.project_id = ? AND c.archived_at IS NULL AND h.action_type = 'STATUS_CHANGED' AND h.new_value IN ('APPROVED','IMPLEMENTED') AND ${IN_PERIOD('h.changed_at')} GROUP BY c.id, h.new_value`, [pid, s, e])),
    ...(await db.all(`SELECT 'TEST' AS type, t.display_id, t.title, 'PASS' AS event, MAX((x.executed_at)::date) AS at FROM test_executions x JOIN test_cases t ON t.id = x.test_case_id
      WHERE t.project_id = ? AND t.archived_at IS NULL AND x.result = 'PASS' AND ${IN_PERIOD('x.executed_at')} GROUP BY t.id`, [pid, s, e])),
    ...(await db.all(`SELECT 'ACCEPTANCE' AS type, a.display_id, a.title, 'ACCEPTED' AS event, MAX((h.changed_at)::date) AS at FROM qa_history h JOIN acceptances a ON a.id = h.entity_id
      WHERE h.entity_type = 'ACCEPTANCE' AND a.project_id = ? AND a.archived_at IS NULL AND h.action_type = 'STATUS_CHANGED' AND h.new_value = 'ACCEPTED' AND ${IN_PERIOD('h.changed_at')} GROUP BY a.id`, [pid, s, e])),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const inProgress = (await db.all(`SELECT * FROM (SELECT w.id, w.wbs_code AS display_id, w.title, w.status, w.progress, w.planned_end_date, w.sequence, ${OWNER_NAME_SQL('w', 'u')} AS owner, (w.owner_user_id IS NULL AND w.owner_stakeholder_id IS NOT NULL) AS owner_no_account,
      (w.planned_end_date IS NOT NULL AND w.planned_end_date < ${TODAY})::int AS overdue,
      (SELECT COUNT(*) FROM raid_links l WHERE l.target_type = 'WBS' AND l.target_id = w.id) AS raid_links,
      (SELECT COUNT(*) FROM change_request_wbs_impacts x JOIN change_requests c ON c.id = x.change_request_id WHERE x.wbs_item_id = w.id AND c.archived_at IS NULL AND c.status IN ('UNDER_REVIEW','APPROVED')) AS change_impacts
    FROM wbs_items w LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.status = 'IN_PROGRESS') s
    ORDER BY overdue DESC, (planned_end_date IS NULL), planned_end_date, (raid_links + change_impacts) DESC, sequence LIMIT 10`, [pid]));

  const issues = (await db.all(`SELECT i.id, i.display_id, i.title, i.status, i.severity, i.due_date, ${OWNER_NAME_SQL('i', 'u')} AS owner, (i.owner_user_id IS NULL AND i.owner_stakeholder_id IS NOT NULL) AS owner_no_account, (i.due_date IS NOT NULL AND i.due_date < ${TODAY})::int AS overdue
    FROM issues i LEFT JOIN users u ON u.id = i.owner_user_id WHERE i.project_id = ? AND i.archived_at IS NULL AND i.status NOT IN ('RESOLVED','CLOSED')
      AND (i.severity IN ('CRITICAL','HIGH') OR (i.due_date IS NOT NULL AND i.due_date < ${TODAY})) ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, i.due_date`, [pid]));
  const risks = (await db.all(`SELECT r.id, r.display_id, r.title, r.status, r.risk_level, r.review_date, u.name AS owner, (r.review_date IS NOT NULL AND r.review_date < ${TODAY})::int AS review_overdue
    FROM risks r LEFT JOIN users u ON u.id = r.owner_user_id WHERE r.project_id = ? AND r.archived_at IS NULL AND r.status IN ('OPEN','MONITORING')
      AND (r.risk_level IN ('CRITICAL','HIGH') OR (r.review_date IS NOT NULL AND r.review_date < ${TODAY})) ORDER BY CASE r.risk_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, r.review_date`, [pid]));

  const chRows = (await db.all(`SELECT c.id, c.display_id, c.title, c.status, c.schedule_impact_days, c.effort_impact_md, c.cost_impact, (${IN_PERIOD('c.created_at')})::int AS created_in_period,
      EXISTS (SELECT 1 FROM change_request_history h WHERE h.change_request_id = c.id AND h.action_type = 'STATUS_CHANGED' AND h.new_value = 'IMPLEMENTED' AND ${IN_PERIOD('h.changed_at')})::int AS implemented_in_period
    FROM change_requests c WHERE c.project_id = ? AND c.archived_at IS NULL AND (c.status IN ('UNDER_REVIEW','APPROVED') OR ${IN_PERIOD('c.created_at')}
      OR EXISTS (SELECT 1 FROM change_request_history h WHERE h.change_request_id = c.id AND h.action_type = 'STATUS_CHANGED' AND h.new_value = 'IMPLEMENTED' AND ${IN_PERIOD('h.changed_at')}))
    ORDER BY c.sequence_number`, [s, e, s, e, pid, s, e, s, e]));
  const changes = {
    created: chRows.filter((c) => c.created_in_period), under_review: chRows.filter((c) => c.status === 'UNDER_REVIEW'),
    approved_unimplemented: chRows.filter((c) => c.status === 'APPROVED'), implemented: chRows.filter((c) => c.implemented_in_period),
    impact: { schedule_days: stats.changes.approved_schedule_days, effort_md: stats.changes.approved_effort_md, cost: stats.changes.approved_cost },
  };

  const exec = (await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((x.result = 'PASS')::int), 0) AS pass, COALESCE(SUM((x.result = 'FAIL')::int), 0) AS fail, COALESCE(SUM((x.result = 'BLOCKED')::int), 0) AS blocked
    FROM test_executions x JOIN test_cases t ON t.id = x.test_case_id WHERE t.project_id = ? AND t.archived_at IS NULL AND ${IN_PERIOD('x.executed_at')}`, [pid, s, e]));
  const latestFail = (await db.all(`SELECT t.id, t.display_id, t.title FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL AND ${LAST} = 'FAIL' ORDER BY t.sequence_number`, [pid]));
  const accPeriod = (await db.all(`SELECT h.new_value AS status, COUNT(DISTINCT h.entity_id) AS n FROM qa_history h JOIN acceptances a ON a.id = h.entity_id
    WHERE h.entity_type = 'ACCEPTANCE' AND a.project_id = ? AND h.action_type = 'STATUS_CHANGED' AND ${IN_PERIOD('h.changed_at')} GROUP BY h.new_value`, [pid, s, e]));
  const accNow = stats.acceptances;
  const testAcceptance = { executions: exec, latest_fail: latestFail, acceptance_now: { requested: accNow.requested, accepted: accNow.accepted, rework: accNow.rework, rejected: accNow.rejected },
    acceptance_period: Object.fromEntries(accPeriod.map((r) => [r.status, r.n])) };

  const attention = (await M.attentionAll(db, pid)).filter((a) => a.decision);
  for (const r of (await db.all(`SELECT id, display_id, title FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status = 'REVIEWING' ORDER BY sequence_number`, [pid])))
    attention.push({ kind: 'REVIEWING_REQUIREMENT', type: 'REQUIREMENT', priority: 10, severity: 'warn', decision: true, id: r.id, display_id: r.display_id, title: r.title, meta: '검토 중 요구사항 (범위 내)', href: `requirements?sel=${r.id}` });

  // Phase 4 US-1: end dates pushed later in the period through the delay-reason dialog (or Excel) — one line per push, reason included
  const scheduleChanges = (await db.all(`SELECT w.id AS wbs_id, w.wbs_code AS display_id, w.title, h.old_value AS before, h.new_value AS after, h.note, (h.changed_at)::date AS at,
      (w.original_planned_end_date)::text AS orig, (CASE WHEN w.item_type = 'MILESTONE' THEN w.milestone_date ELSE w.planned_end_date END)::text AS cur
    FROM wbs_history h JOIN wbs_items w ON w.id = h.wbs_item_id
    WHERE w.project_id = ? AND w.archived_at IS NULL AND h.action_type = 'UPDATED' AND h.field_name IN ('planned_end_date','milestone_date') AND h.note IS NOT NULL
      AND h.old_value IS NOT NULL AND h.new_value > h.old_value AND ${IN_PERIOD('h.changed_at')} ORDER BY h.changed_at, h.seq`, [pid, s, e]))
    .map((r) => ({ ...r, days: diffDays(r.before, r.after) }));

  const nextWeek = (await M.upcomingDates(db, pid, { from: addDays(e, 1), to: addDays(e, 7), limit: 30 }));

  return {
    period: { start: s, end: e },
    summary: { phase_key: project.current_phase, phase_name: guide.current_phase?.name || project.current_phase, health: { status: health.status, label: health.status_label, partial_unknown: health.partial_unknown },
      dimensions: Object.values(health.dimensions).map((d) => ({ key: d.key, label: d.label, status: d.status, status_label: d.status_label, reasons: d.reasons })), kpis },
    completed_items: completed, in_progress_items: inProgress, issues_and_risks: { issues, risks }, changes, test_and_acceptance: testAcceptance,
    attention_items: attention, next_week_plan: nextWeek, schedule_changes: scheduleChanges,
  };
}

/* ---------- sections (markdown bodies derived from data; the user edits these) ---------- */
const pct = (v) => (v === null || v === undefined ? '-' : `${v}%`);
const md = (d) => (d ? d.slice(5).replace('-', '/') : '-');
const EVENT = { COMPLETED: '완료', CONFIRMED: '확정', RESOLVED: '해결', CLOSED: '종료', APPROVED: '승인', IMPLEMENTED: '반영 완료', PASS: '통과', ACCEPTED: '검수 승인' };
const TYPE_KO = { WBS: 'WBS', REQUIREMENT: '요구사항', ISSUE: '이슈', CHANGE: '변경', TEST: '테스트', ACCEPTANCE: '검수', RISK: '리스크' };

/** US-1 '일정' lines: "이번 주 일정 변경 N건 (최초 계획 대비 총 +M일)" + one line per push (작업명 · +일 · 최초 계획 대비 +N일 · 사유). Nothing when there was none.
 * K12: the total is the net change of each task against its first plan (a pull-back in the same week counts), not the sum of every push. */
const signed = (n) => `${n >= 0 ? '+' : ''}${n}일`;
export function scheduleLines(list) {
  if (!list || !list.length) return [];
  const first = new Map();   // per task: first plan = original_planned_end_date, else the end before its first push in the list
  for (const x of list) { const k = x.wbs_id || x.display_id; if (!first.has(k)) first.set(k, { from: x.orig || x.before, to: x.cur || null }); }
  const net = (k) => { const f = first.get(k); return f && f.from && f.to ? diffDays(f.from, f.to) : null; };
  const nets = [...first.keys()].map(net);
  const total = nets.every((v) => v !== null) ? nets.reduce((a, v) => a + v, 0) : list.reduce((a, x) => a + (Number(x.days) || 0), 0);
  return [`- 일정: 이번 주 일정 변경 ${list.length}건 (최초 계획 대비 총 ${signed(total)})`,
    ...list.map((x) => { const d = net(x.wbs_id || x.display_id); return `  - ${x.display_id} ${x.title} · +${x.days}일${d === null ? '' : ` · 최초 계획 대비 ${signed(d)}`} · ${x.note}`; })];
}

export function sectionsFromData(d) {
  const S = d.summary; const out = {};
  out.status = [
    `- 현재 단계: ${S.phase_name}`,
    `- 프로젝트 상태: ${S.health.label}${S.health.partial_unknown ? ' (일부 정보 부족)' : ''}`,
    ...S.dimensions.map((x) => `  - ${x.label}: ${x.status_label}${x.status === 'GOOD' || x.status === 'UNKNOWN' ? '' : ` — ${x.reasons.join(', ')}`}`),
    ...scheduleLines(d.schedule_changes),
    `- WBS 진행률: ${pct(S.kpis.wbs_progress)}`,
    `- 요구사항 반영률: ${pct(S.kpis.requirement_coverage)}`, `- 테스트 커버리지: ${pct(S.kpis.test_coverage)}`,
  ].join('\n');
  out.completed = d.completed_items.length ? d.completed_items.map((c) => `- [${TYPE_KO[c.type]}] ${c.display_id} ${c.title} — ${EVENT[c.event] || c.event} (${md(c.at)})`).join('\n') : '- 기간 내 완료 처리된 항목이 없습니다.';
  out.in_progress = d.in_progress_items.length ? d.in_progress_items.map((w) => {
    const flags = []; if (w.overdue) flags.push('종료 예정일 경과'); if (w.raid_links) flags.push(`이슈/리스크 ${w.raid_links}건 연결`); if (w.change_impacts) flags.push(`변경 영향 ${w.change_impacts}건`);
    return `- ${w.display_id} ${w.title} — ${w.progress}%${w.owner ? ` · ${w.owner}${w.owner_no_account ? ' (계정 없음)' : ''}` : ''}${w.planned_end_date ? ` · 종료 예정 ${md(w.planned_end_date)}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`;
  }).join('\n') : '- 진행 중인 WBS 작업이 없습니다.';
  const ir = d.issues_and_risks; const irLines = [];
  if (ir.issues.length) { irLines.push('**이슈**'); for (const i of ir.issues) irLines.push(`- ${i.display_id} ${i.title} — ${SEVERITY[i.severity] || i.severity} · ${ISSUE_STATUS[i.status] || i.status}${i.owner ? ` · ${i.owner}${i.owner_no_account ? ' (계정 없음)' : ''}` : ''}${i.due_date ? ` · 기한 ${md(i.due_date)}${i.overdue ? ' (초과)' : ''}` : ''}`); }
  if (ir.risks.length) { irLines.push('**리스크**'); for (const r of ir.risks) irLines.push(`- ${r.display_id} ${r.title} — ${SEVERITY[r.risk_level] || r.risk_level} · ${RISK_STATUS[r.status] || r.status}${r.owner ? ` · ${r.owner}` : ''}${r.review_date ? ` · 검토일 ${md(r.review_date)}${r.review_overdue ? ' (초과)' : ''}` : ''}`); }
  out.issues_risks = irLines.length ? irLines.join('\n') : '- 심각·높음 이슈·리스크, 기한 초과 항목이 없습니다.';
  const c = d.changes; const cl = []; const crLine = (x, suffix = '') => `- ${x.display_id} ${x.title} — ${CR_STATUS[x.status] || x.status}${suffix}`;
  const imp = (x) => { const p = []; if (x.schedule_impact_days != null) p.push(`일정 ${x.schedule_impact_days}일`); if (x.effort_impact_md != null) p.push(`공수 ${x.effort_impact_md}MD`); if (x.cost_impact != null) p.push(`비용 ${x.cost_impact}`); return p.length ? ` (입력 영향: ${p.join(', ')})` : ''; };
  if (c.created.length) { cl.push(`**기간 내 신규 ${c.created.length}건**`); c.created.forEach((x) => cl.push(crLine(x, imp(x)))); }
  if (c.under_review.length) { cl.push(`**검토 중 ${c.under_review.length}건**`); c.under_review.forEach((x) => cl.push(crLine(x, imp(x)))); }
  if (c.approved_unimplemented.length) { cl.push(`**승인 후 미반영 ${c.approved_unimplemented.length}건**`); c.approved_unimplemented.forEach((x) => cl.push(crLine(x, imp(x)))); }
  if (c.implemented.length) { cl.push(`**기간 내 반영 완료 ${c.implemented.length}건**`); c.implemented.forEach((x) => cl.push(crLine(x))); }
  if (cl.length && (c.impact.schedule_days || c.impact.effort_md || c.impact.cost)) cl.push(`- 승인·반영 변경의 입력된 영향 합계: 일정 ${c.impact.schedule_days}일, 공수 ${c.impact.effort_md}MD, 비용 ${c.impact.cost} (입력값 합계이며 실제 지연 예측치가 아님)`);
  out.changes = cl.length ? cl.join('\n') : '- 기간 내 변경 요청 활동이 없습니다.';
  const t = d.test_and_acceptance; const tl = [];
  tl.push(`- 테스트 실행: ${t.executions.total}회 (통과 ${t.executions.pass} · 실패 ${t.executions.fail} · 차단됨 ${t.executions.blocked})`);
  if (t.latest_fail.length) { tl.push(`- 현재 Fail 상태 테스트 ${t.latest_fail.length}건`); t.latest_fail.forEach((x) => tl.push(`  - ${x.display_id} ${x.title}`)); }
  const an = t.acceptance_now; const ap = t.acceptance_period;
  tl.push(`- 검수 현황: 요청 ${an.requested} · 승인 ${an.accepted} · 보완 필요 ${an.rework} · 반려 ${an.rejected}`);
  const apl = Object.entries(ap).map(([k, v]) => `${ACC_STATUS[k] || k} ${v}`); if (apl.length) tl.push(`- 기간 내 검수 상태 변경: ${apl.join(', ')}`);
  out.test_acceptance = tl.join('\n');
  out.decisions = d.attention_items.length ? d.attention_items.map((a) => `- [${TYPE_KO[a.type] || a.type}] ${a.display_id} ${a.title} — ${a.meta}`).join('\n') : '- 확인 및 의사결정이 필요한 항목이 없습니다.';
  out.next_week = d.next_week_plan.length ? d.next_week_plan.map((u) => `- ${md(u.date)} ${u.label}: ${[u.display_id, u.title].filter(Boolean).join(' ')}`).join('\n') : '- 차주 예정된 일정(WBS 시작/종료, 마일스톤, 리스크 검토, 검수 기한)이 없습니다.';
  return SECTIONS.map(([key, title]) => ({ key, title, body: out[key] }));
}

export function renderMarkdown(report) {
  const d = report.structured_content;
  for (const s of d.sections) if (Array.isArray(s.fields)) s.body = lessonsBody(s.fields);   // 7절 교훈: three PM-written fields → one body
  const head = `# ${report.title}\n\n${d.kind === 'COMPLETION' ? '프로젝트 기간' : '보고 기간'}: ${d.period.start} ~ ${d.period.end}\n`;
  return head + d.sections.map((s, i) => `\n## ${i + 1}. ${s.title}\n\n${s.body.trim() || '-'}\n`).join('');
}

/* ---------- persistence ---------- */
const COLS = 'id, project_id, report_type, period_start, period_end, title, status, generated_at, finalized_at, created_by, created_at, updated_at';
const parse = (row) => (row ? { ...row, structured_content: JSON.parse(row.structured_content) } : null);

export const listReports = async (db, projectId) => (await db.all(`SELECT ${COLS} FROM weekly_reports WHERE project_id = ? ORDER BY period_start DESC, created_at DESC`, [projectId]));
export const getReport = async (db, projectId, id) => parse((await db.get(`SELECT ${COLS}, structured_content, rendered_content FROM weekly_reports WHERE project_id = ? AND id = ?`, [projectId, id])));

export async function generateReport(db, project, period, userId) {
  await assertWithinLimit(db, project.workspace_id, 'weekly_reports');   // plan limit (402), per calendar month
  const data = (await buildReportData(db, project, period));
  const id = randomUUID(); const ts = now();
  const title = `${project.name} 주간보고 (${period.period_start} ~ ${period.period_end})`;
  const structured = { period: data.period, data, sections: sectionsFromData(data) };
  const rendered = renderMarkdown({ title, structured_content: structured });
  (await db.run(`INSERT INTO weekly_reports (id, project_id, period_start, period_end, title, status, structured_content, rendered_content, generated_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`, [id, project.id, period.period_start, period.period_end, title, JSON.stringify(structured), rendered, ts, userId, ts, ts]));
  return id;
}

/** Edit: title and/or section bodies (by key). Only DRAFT. Re-renders markdown. */
export async function updateReport(db, report, input) {
  if (report.status !== 'DRAFT') return { error: 'final' };
  const f = {}; const sc = report.structured_content; let title = report.title;
  if (input.title !== undefined) { title = str(input.title); if (!title) f.title = '제목을 입력하세요.'; if (title.length > 200) f.title = '제목은 200자 이내로 입력하세요.'; }
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections)) f.sections = '섹션 형식이 올바르지 않습니다.';
    else for (const s of input.sections) {
      const target = sc.sections.find((x) => x.key === s?.key);
      if (!target) { f.sections = `알 수 없는 섹션: ${s?.key}`; break; }
      if (Array.isArray(target.fields) && s.fields && typeof s.fields === 'object') {   // 완료보고서 7절 교훈 (잘된 점 · 아쉬운 점 · 다음에 할 일)
        for (const [k, v] of Object.entries(s.fields)) {
          const fld = target.fields.find((x) => x.key === k);
          if (!fld) { f.sections = `알 수 없는 항목: ${k}`; break; }
          if (typeof v !== 'string' || v.length > 5000) { f.sections = '교훈 항목은 5,000자 이내의 문자열이어야 합니다.'; break; }
          fld.body = v;
        }
        if (f.sections) break;
        continue;
      }
      if (typeof s.body !== 'string' || s.body.length > 20000) { f.sections = '섹션 본문은 20,000자 이내의 문자열이어야 합니다.'; break; }
      target.body = s.body;
    }
  }
  if (Object.keys(f).length) throw new ValidationError(f);
  const rendered = renderMarkdown({ title, structured_content: sc });
  (await db.run('UPDATE weekly_reports SET title = ?, structured_content = ?, rendered_content = ?, updated_at = ? WHERE id = ?', [title, JSON.stringify(sc), rendered, now(), report.id]));
  return { ok: true };
}

export async function finalizeReport(db, report) {
  if (report.status === 'FINAL') return { error: 'already_final' };
  const ts = now(); (await db.run(`UPDATE weekly_reports SET status = 'FINAL', finalized_at = ?, updated_at = ? WHERE id = ?`, [ts, ts, report.id])); return { ok: true };
}
/** FINAL → DRAFT ("다시 편집"). finalized_at is kept as the last finalization timestamp; updated_at moves. */
export async function reopenReport(db, report) {
  if (report.status !== 'FINAL') return { error: 'not_final' };
  (await db.run(`UPDATE weekly_reports SET status = 'DRAFT', updated_at = ? WHERE id = ?`, [now(), report.id])); return { ok: true };
}

/* ---------- 완료보고서 (Phase 7 US-1) ---------- */
/* Same table, editor, DRAFT→FINAL and PDF/Word export as the weekly report; report_type = 'COMPLETION', one per project.
 * Seven rule-based sections filled from the project's own data (no AI); 7절 교훈 is three empty PM fields. */
export const COMPLETION_SECTIONS = [['overview', '개요'], ['scope', '범위'], ['schedule', '일정'], ['quality', '품질'], ['acceptance', '검수'], ['carryover', '남은 일 (운영 이관)'], ['lessons', '교훈']];
export const LESSON_FIELDS = [['good', '잘된 점'], ['bad', '아쉬운 점'], ['next', '다음에 할 일']];
export const lessonsBody = (fields) => fields.map((x) => `**${x.label}**\n${String(x.body || '').trim() || '없음'}`).join('\n\n');   // K30: an empty field prints 없음, not a bare '-'
const CARRY_KO = { ISSUE: '이슈', TEST: '테스트', CR: '변경 요청', ACCEPTANCE: '검수' };
const no2 = (x) => String(x).padStart(2, '0');

export const completionOf = (db, projectId) => db.get(`SELECT id, status, finalized_at, updated_at FROM weekly_reports WHERE project_id = ? AND report_type = 'COMPLETION'`, [projectId]);
/** 07 CLOSE state (computed on every read): FINAL 완료보고서 → 'FINAL', a DRAFT → 'DRAFT', else 'NONE'. */
export async function completionState(db, projectId) {
  const r = await completionOf(db, projectId);
  return r ? { state: r.status, report_id: r.id, finalized_at: r.finalized_at } : { state: 'NONE', report_id: null, finalized_at: null };
}

/** Structured data for the seven sections. `gaps` = closing.priorGaps() (computed by the caller from the resolved guide). */
export async function buildCompletionData(db, project, { gaps = [], goLive = null, carryovers = [], handover = null, acceptances = [] } = {}) {
  const pid = project.id;
  const def = (await db.get('SELECT goal FROM project_definitions WHERE project_id = ?', [pid])) || {};
  const goal = String(def.goal || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  const ms = await goLiveMilestone(db, pid);   // 01 주요 일정 / 뼈대 '…오픈' milestone (a FINAL report keeps the text it was frozen with)
  const req = await db.get(`SELECT COALESCE(SUM((scope = 'IN_SCOPE' AND status = 'CONFIRMED')::int), 0) AS in_scope, COALESCE(SUM((scope = 'OUT_OF_SCOPE')::int), 0) AS out_of_scope
    FROM requirements WHERE project_id = ? AND archived_at IS NULL`, [pid]);
  const cr = await db.get(`SELECT COALESCE(SUM((status IN ('APPROVED','IMPLEMENTED'))::int), 0) AS approved, COALESCE(SUM((status = 'IMPLEMENTED')::int), 0) AS implemented
    FROM change_requests WHERE project_id = ? AND archived_at IS NULL`, [pid]);
  // 일정: items whose end date now sits after the 최초 계획 종료일 frozen at 04 entry (Phase 4)
  const pushed = (await db.all(`SELECT w.id, w.wbs_code, w.title, (w.original_planned_end_date)::text AS orig, (CASE WHEN w.item_type = 'MILESTONE' THEN w.milestone_date ELSE w.planned_end_date END)::text AS cur
    FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type <> 'SUMMARY' AND w.original_planned_end_date IS NOT NULL
      AND (CASE WHEN w.item_type = 'MILESTONE' THEN w.milestone_date ELSE w.planned_end_date END) > w.original_planned_end_date ORDER BY w.sequence`, [pid]))
    .map((r) => ({ ...r, days: diffDays(r.orig, r.cur) }));
  const reasons = (await db.all(`SELECT w.wbs_code AS display_id, w.title, h.old_value AS before, h.new_value AS after, h.note FROM wbs_history h JOIN wbs_items w ON w.id = h.wbs_item_id
    WHERE w.project_id = ? AND w.archived_at IS NULL AND h.action_type = 'UPDATED' AND h.field_name IN ('planned_end_date','milestone_date') AND h.note IS NOT NULL AND btrim(h.note) <> ''
      AND h.old_value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.new_value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.new_value > h.old_value`, [pid]))
    .map((r) => ({ ...r, days: diffDays(r.before, r.after) })).sort((a, b) => b.days - a.days).slice(0, 3);
  const tst = await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((${LAST} = 'PASS')::int), 0) AS pass FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL`, [pid]);
  const excluded = await db.all(`SELECT display_id, title, test_exclusion_reason AS reason FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status = 'CONFIRMED'
    AND COALESCE(btrim(test_exclusion_reason), '') <> '' AND NOT EXISTS (SELECT 1 FROM test_links l JOIN test_cases tc ON tc.id = l.test_case_id WHERE l.target_type = 'REQUIREMENT' AND l.target_id = requirements.id AND tc.archived_at IS NULL)
    ORDER BY sequence_number`, [pid]);
  const defects = await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((status IN ('RESOLVED','CLOSED'))::int), 0) AS resolved FROM issues WHERE project_id = ? AND archived_at IS NULL AND source_test_execution_id IS NOT NULL`, [pid]);
  const n = (v) => Number(v) || 0;
  return {
    overview: { goal, start: project.planned_start_date, end: project.planned_end_date, open_planned: ms ? (ms.original_planned_end_date || ms.milestone_date) : null, open_actual: goLive ? goLive.date : null },
    scope: { in_scope: n(req.in_scope), out_of_scope: n(req.out_of_scope), cr_approved: n(cr.approved), cr_implemented: n(cr.implemented) },
    schedule: { pushed: pushed.length, total_days: pushed.reduce((a, x) => a + (Number(x.days) || 0), 0), reasons },
    quality: { tests: n(tst.total), pass: n(tst.pass), excluded: excluded.length, excluded_list: excluded, defects: n(defects.total), defects_resolved: n(defects.resolved) },
    acceptance: acceptances,
    carryover: { items: carryovers, handover, gaps },
  };
}
const ymdText = (d) => (d ? String(d).slice(0, 10) : '-');
export function completionSections(d) {
  const o = d.overview; const out = {};
  const openLine = () => {
    if (!o.open_planned && !o.open_actual) return '- 오픈일: 기록 없음';
    if (!o.open_actual) return `- 오픈일: 최초 계획 ${ymdText(o.open_planned)} → 실제 오픈 기록 없음`;
    if (!o.open_planned) return `- 오픈일: 실제 ${ymdText(o.open_actual)} (최초 계획 오픈일 기록 없음)`;
    const dd = diffDays(ymdText(o.open_planned), ymdText(o.open_actual));
    return `- 오픈일: 최초 계획 ${ymdText(o.open_planned)} → 실제 ${ymdText(o.open_actual)} (${dd > 0 ? `+${dd}일` : dd < 0 ? `${dd}일` : '계획대로'})`;
  };
  out.overview = [`- 목표: ${o.goal || '01 착수에서 목표가 기록되지 않았습니다.'}`, `- 계약 기간: ${ymdText(o.start)} ~ ${ymdText(o.end)}`, openLine()].join('\n');
  const sc = d.scope;
  out.scope = [`- 범위 내 확정 요구사항 ${sc.in_scope}건 · 범위 밖 ${sc.out_of_scope}건`, `- 변경 요청 승인 ${sc.cr_approved}건 / 반영 ${sc.cr_implemented}건`].join('\n');
  const s = d.schedule;
  out.schedule = [`- 미룬 작업 ${s.pushed}건 · 최초 계획 대비 총 +${s.total_days}일`,
    ...(s.reasons.length ? ['- 주요 사유', ...s.reasons.map((r) => `  - ${r.display_id} ${r.title} · +${r.days}일 · ${r.note}`)] : ['- 기록된 미룸 사유가 없습니다.'])].join('\n');
  const q = d.quality;
  out.quality = [`- 테스트 ${q.tests}건 · 최근 통과 ${q.pass}건 · 제외 ${q.excluded}건`, ...q.excluded_list.map((x) => `  - ${x.display_id} ${x.title} — 제외 사유: ${x.reason}`),
    `- 테스트에서 나온 이슈 ${q.defects}건 (해결 ${q.defects_resolved}건)`].join('\n');
  out.acceptance = d.acceptance.length ? d.acceptance.map((a) => `- ${a.display_id} ${a.title} — ${a.recorded ? [a.approver, a.date, a.method].filter(Boolean).join(' · ') : '고객 승인 기록 없음'}`).join('\n') : '- 승인된 검수가 없습니다.';
  const c = d.carryover; const cl = [];
  if (c.handover) cl.push(`- 운영 인수: ${c.handover.receiver_name} · ${ymdText(c.handover.date)}`);
  if (c.items.length) { cl.push(`- 운영 이관 ${c.items.length}건`); c.items.forEach((x) => cl.push(`  - [${CARRY_KO[x.type] || x.type}] ${x.display_id} ${x.title}${x.note ? ` — ${x.note}` : ''} · 운영 담당 ${x.owner_name || '미지정'}`)); }
  else cl.push('- 운영 이관 항목이 없습니다.');
  cl.push(c.gaps.length ? `- ${priorGapsText(c.gaps)}` : '- 앞 단계 필수 업무를 모두 마쳤습니다.');
  out.carryover = cl.join('\n');
  return COMPLETION_SECTIONS.map(([key, title]) => (key === 'lessons'
    ? { key, title, body: '', fields: LESSON_FIELDS.map(([k, label]) => ({ key: k, label, body: '' })) }
    : { key, title, body: out[key] }));
}
/** Accepted 검수 rows → { display_id, title, recorded, approver, date, method } (Phase 6 고객 승인 기록). */
export async function acceptedApprovals(db, projectId) {
  const rows = await db.all(`SELECT id, display_id, title, customer_approval FROM acceptances WHERE project_id = ? AND archived_at IS NULL AND status = 'ACCEPTED' ORDER BY sequence_number`, [projectId]);
  const r = await db.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [projectId]);
  let sh = []; try { sh = JSON.parse((r && r.stakeholders) || '[]'); } catch { sh = []; }
  return rows.map((a) => {
    const v = accApprovalView(a.customer_approval, Array.isArray(sh) ? sh : []);
    return { display_id: a.display_id, title: a.title, recorded: v.recorded, approver: v.approver ? `${v.approver.name}${v.approver.title ? ` ${v.approver.title}` : ''}` : '', date: v.date || '', method: v.method_label || '' };
  });
}

/** One 완료보고서 per project: the existing one is returned as is ({ id, existing: true }). */
export async function generateCompletion(db, project, userId, extra = {}) {
  const cur = await completionOf(db, project.id);
  if (cur) return { id: cur.id, existing: true };
  const today = todayKst();
  const end = project.closed_on ? String(project.closed_on).slice(0, 10) : today;
  const start = String(project.planned_start_date).slice(0, 10);
  const period = { start: start <= end ? start : end, end };
  const data = await buildCompletionData(db, project, extra);
  const id = randomUUID(); const ts = now();
  const title = `${project.name} 완료보고서`;
  const structured = { kind: 'COMPLETION', period, data, sections: completionSections(data) };
  const rendered = renderMarkdown({ title, structured_content: structured });
  await db.run(`INSERT INTO weekly_reports (id, project_id, report_type, period_start, period_end, title, status, structured_content, rendered_content, generated_at, created_by, created_at, updated_at)
    VALUES (?, ?, 'COMPLETION', ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`, [id, project.id, period.start, period.end, title, JSON.stringify(structured), rendered, ts, userId, ts, ts]);
  return { id, existing: false };
}

/** Plain-text variant for copy (markdown markers stripped; bullets kept as "•"). */
export function toPlainText(markdown) {
  return markdown.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^(\s*)- /gm, '$1• ').replace(/\n{3,}/g, '\n\n').trim();
}
export { STATUS_LABEL };
