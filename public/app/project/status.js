/* Project status helpers shared by What’s Next? (next.js) and Overview (overview.js).
 * Everything here is derived from the project GET payload (`g`) — no extra requests, no stored state —
 * so both screens always agree on the same numbers (phase progression, schedule state, exception counts). */
import { html, no2, raw, todayLocal } from '../core/dom.js';
import { firstScreen } from '../shared/lifecycle.js';

const n = (v) => Number(v) || 0;

/** Compact lifecycle stepper (no percentages): ✓ 착수 ─ ● 요구사항 정의 ─ ○ 분석·설계 … Green done · Blue current · Gray not started.
 * A step links to the phase's first work screen (What’s Next for the current phase). */
export const phaseStepper = (g, pid) => html`<ol class="pstep" aria-label="Project Lifecycle">${raw((g.phases || []).map((ph) => {
  const state = ph.is_current ? 'cur' : ph.status === 'COMPLETED' ? 'done' : 'todo';
  const first = firstScreen(pid, ph.phase_key);
  const href = ph.is_current || !first ? `/app/projects/${pid}` : first.href;
  const req = ph.summary ? ph.summary.required_open : null;
  const tip = state === 'cur' ? '현재 단계' : state === 'done' ? '완료' : req ? `필수 업무 ${req}건` : '미시작';
  return html`<li class="is-${state}"><a href="${href}" data-link title="${no2(ph.sequence)} ${ph.name} · ${tip}"><i class="st st--${state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'cur' ? '●' : '○'}</i><span><small>${no2(ph.sequence)}</small>${ph.name}</span></a></li>`;
}).join(''))}</ol>`;

/** Days from today to `date` (negative when past). null when no date. */
export const daysUntil = (date) => (date ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayLocal()}T00:00:00Z`)) / 86400000) : null);

/** Signed %p text for the plan-vs-actual variance. */
export const varianceText = (v) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v}%p`);
/** Variance tone (§16): ≥ 0 정상 · 0 ~ −5 약간 지연 · < −5 지연. */
export const varianceTone = (v) => (v === null || v === undefined ? 'muted' : v >= 0 ? 'good' : v >= -5 ? 'warn' : 'crit');

/**
 * Schedule state from the WBS stats (server/wbs.js scheduleFigures). Real data only:
 *   overdue tasks/milestones → "N일 지연" (longest overdue, Red) · variance < 0 → 지연/약간 지연 · dates missing → 확인 필요 · else 정상.
 */
export function scheduleState(w) {
  if (!w || !n(w.tasks)) return { tone: 'muted', label: '-', detail: 'WBS가 등록되면 계산됩니다' };
  const od = n(w.overdue_tasks), om = n(w.overdue_milestones); const v = w.variance;
  if (od || om) return { tone: 'crit', label: `${n(w.max_overdue_days)}일 지연`, detail: [od ? `지연 Task ${od}건` : '', om ? `지난 마일스톤 ${om}건` : ''].filter(Boolean).join(' · ') };
  if (v !== null && v !== undefined && v < -5) return { tone: 'crit', label: '진척 지연', detail: `계획 대비 ${varianceText(v)}` };
  if (v !== null && v !== undefined && v < 0) return { tone: 'warn', label: '약간 지연', detail: `계획 대비 ${varianceText(v)}` };
  if (n(w.tasks_without_dates)) return { tone: 'warn', label: '확인 필요', detail: `일정 미입력 ${w.tasks_without_dates}건` };
  if (v === null || v === undefined) return { tone: 'muted', label: '-', detail: '계획 일정이 없습니다' };
  return { tone: 'good', label: '정상', detail: `계획 대비 ${varianceText(v)}` };
}

/**
 * "확인 필요" as exceptions (§20): one row per exception type with a count and the screen that fixes it. Never per-record lists.
 * Red = issue / risk / delay / fail; Amber = needs a decision or data is missing.
 */
export function exceptions(g, pid) {
  const u = (p) => `/app/projects/${pid}${p}`;
  const is = g.issues || {}, rs = g.risks || {}, w = g.wbs || {}, t = g.tests || {}, a = g.acceptances || {}, c = g.changes || {}, r = g.requirements || {};
  const rows = [
    ['ISSUE', '미해결 Issue', n(is.active), u(is.critical ? '/issues?severity=CRITICAL' : '/issues'), 'crit', is.critical ? `Critical ${is.critical}건` : ''],
    ['RISK', 'High 이상 Risk', n(rs.high_or_critical), u('/issues?tab=risks&risk_level=HIGH,CRITICAL'), 'crit', rs.critical ? `Critical ${rs.critical}건` : ''],
    ['OVERDUE', '지연 Task', n(w.overdue_tasks), u('/wbs?f=overdue'), 'crit', ''],
    ['MILESTONE', '지난 마일스톤', n(w.overdue_milestones), u('/wbs?view=gantt'), 'crit', ''],
    ['FAIL', 'Fail 테스트', n(t.last_fail), u('/tests?last_result=FAIL'), 'crit', ''],
    ['REWORK', '보완 필요 검수', n(a.rework), u('/tests?tab=acceptance&status=REWORK_REQUIRED'), 'warn', ''],
    ['CHANGE_APPROVED', '승인 후 미반영 변경', n(c.approved_unimplemented), u('/changes?status=APPROVED'), 'warn', ''],
    ['CHANGE_REVIEW', '검토 중 변경', n(c.under_review), u('/changes?status=UNDER_REVIEW'), 'warn', ''],
    ['UNLINKED_REQ', 'WBS 미연결 Requirement', n(r.in_scope_unlinked), u('/requirements?scope=IN_SCOPE&link=unlinked'), 'warn', '범위 내 요구사항 기준'],
    ['NO_OWNER', '담당자 미지정', n(w.tasks_without_owner), u('/wbs?f=no_owner'), 'warn', ''],
    ['NO_DATES', '일정 미입력', n(w.tasks_without_dates), u('/wbs?f=no_dates'), 'warn', ''],
  ].filter((x) => x[2] > 0).map(([key, label, count, href, tone, sub]) => ({ key, label, count, href, tone, sub }));
  return { rows, total: rows.reduce((s, x) => s + x.count, 0) };
}
