/* WBS 고정 최상위 뼈대 (batch7 B3) + 근무일 날짜 배분 (B4 · #15). Pure — shared by the server (server/wbs-structure.js, AI planner
 * commit) and the client (WBS page, AI WBS planner review), so the preview and the committed dates are the same numbers.
 *
 * Fixed nodes: one per RELAI lifecycle phase that WBS covers (D-1: RELAI phase names), plus the optional 데이터 이관 after 분석·설계.
 * `plan` = the phase value the AI planner returns per top-level draft item (PLAN_PHASES, 8 values). */
import { workdayList, addWorkdays, snapToWorkday } from './kst-date.js';

export const FIXED_NODES = [
  { key: 'PHASE:INITIATION', title: '착수', phase: 'INITIATION', plan: 'INITIATION', ratio: 5 },
  { key: 'PHASE:REQUIREMENTS', title: '요구사항 정의', phase: 'REQUIREMENTS', plan: 'REQUIREMENTS', ratio: 15 },
  { key: 'PHASE:ANALYSIS_DESIGN', title: '분석·설계', phase: 'ANALYSIS_DESIGN', plan: 'ANALYSIS_DESIGN', ratio: 20 },
  { key: 'OPT:DATA_MIGRATION', title: '데이터 이관', phase: 'TRANSITION_GO_LIVE', plan: 'DATA_MIGRATION', ratio: 5, optional: true },
  { key: 'PHASE:DEVELOPMENT', title: '구현', phase: 'DEVELOPMENT', plan: 'DEVELOPMENT', ratio: 35 },
  { key: 'PHASE:TESTING', title: '시험', phase: 'TESTING', plan: 'TESTING', ratio: 15 },
  { key: 'PHASE:TRANSITION_GO_LIVE', title: '전환·오픈', phase: 'TRANSITION_GO_LIVE', plan: 'TRANSITION_GO_LIVE', ratio: 10 },
  // P2 (Jim prod 10-21 #6): 07 운영 및 유지보수 has its node too, so 운영 인수·유지보수 work is never left "단계 밖". Date allocation only
  // gives it workdays when some item belongs to it (allocOnly), taking its 5 from 전환·오픈 — a plan without 운영 work is laid out as before.
  { key: 'PHASE:OPERATIONS', title: '운영', phase: 'OPERATIONS', plan: 'OPERATIONS', ratio: 5, allocOnly: true },
];
export const DM_KEY = 'OPT:DATA_MIGRATION';
export const PLAN_PHASES = FIXED_NODES.map((n) => n.plan);
export const nodeByKey = new Map(FIXED_NODES.map((n) => [n.key, n]));
export const nodeByPlan = new Map(FIXED_NODES.map((n) => [n.plan, n]));
/** Sort index of a system_key (fixed nodes first, in FIXED_NODES order). */
export const systemOrder = (key) => { const i = FIXED_NODES.findIndex((n) => n.key === key); return i < 0 ? 99 : i; };
/** The nodes a project shows: the 7 phases, plus 데이터 이관 when `withDm`. */
export const nodesFor = (withDm) => FIXED_NODES.filter((n) => !n.optional || withDm);
/** The nodes date allocation lays out: 운영 only when `withOps` (some item is 운영 work). */
export const allocNodesFor = (withDm, withOps) => nodesFor(withDm).filter((n) => !n.allocOnly || withOps);
/** Base ratios (%): 데이터 이관 takes its 5 from 구현 (35 → 30); 운영 takes its 5 from 전환·오픈 (10 → 5). */
export const ratioOf = (n, withDm, withOps = false) => (n.plan === 'DEVELOPMENT' && withDm ? 30 : n.plan === 'TRANSITION_GO_LIVE' && withOps ? 5 : n.ratio);

/* ---------- which fixed node an item belongs to ---------- */
const AREA_PHASE = {
  PROJECT_MANAGEMENT: 'INITIATION', ANALYSIS_DESIGN: 'ANALYSIS_DESIGN', FUNCTIONAL_DEVELOPMENT: 'DEVELOPMENT', NON_FUNCTIONAL: 'DEVELOPMENT', INTERFACE: 'DEVELOPMENT',
  INFRASTRUCTURE: 'DEVELOPMENT', SECURITY: 'DEVELOPMENT', ENVIRONMENT: 'DEVELOPMENT', DATA_MIGRATION: 'DATA_MIGRATION', TESTING: 'TESTING', UAT: 'TESTING',
  DEPLOYMENT: 'TRANSITION_GO_LIVE', CUTOVER: 'TRANSITION_GO_LIVE', TRAINING: 'TRANSITION_GO_LIVE', OPERATION_HANDOVER: 'TRANSITION_GO_LIVE', STABILIZATION: 'TRANSITION_GO_LIVE', DOCUMENTATION: 'TRANSITION_GO_LIVE',
};
const LIFECYCLE_PLAN = { INITIATION: 'INITIATION', REQUIREMENTS: 'REQUIREMENTS', ANALYSIS_DESIGN: 'ANALYSIS_DESIGN', DEVELOPMENT: 'DEVELOPMENT', TESTING: 'TESTING', TRANSITION_GO_LIVE: 'TRANSITION_GO_LIVE', OPERATIONS: 'OPERATIONS' };
/** Title keywords, most specific first. '요구사항 … 구현' is development, so 요구사항 only counts with 정의/수집/분석/확정/기준선/승인. */
const WORDS = [
  ['OPERATIONS', /유지보수|하자\s*보수|운영\s*(인수|이관|지원|안정화|전환|모니터링)|운영\s*단계|hypercare/i],
  ['DATA_MIGRATION', /이관|마이그레이션|migration/i],
  ['TESTING', /테스트|시험|검수|UAT|test/i],
  ['TRANSITION_GO_LIVE', /오픈|전환|배포|교육|안정화|인수인계|cutover|go[- ]?live/i],
  ['INITIATION', /착수|킥오프|kick-?off|사업수행계획/i],
  ['REQUIREMENTS', /요구사항\s*(정의|수집|분석|확정|기준선|승인|명세)|기준선 승인/],
  ['ANALYSIS_DESIGN', /설계|분석|design/i],
  ['DEVELOPMENT', /구현|개발|코딩|develop/i],
];
export const phaseFromTitle = (title) => (WORDS.find(([, re]) => re.test(String(title || ''))) || [null])[0];
/** Plan phase of a top-level item: its explicit `phase` → `lifecycle_phase` → `project_area` → title keywords → 구현. */
export function inferPlanPhase(it = {}) {
  if (PLAN_PHASES.includes(it.phase)) return it.phase;
  if (LIFECYCLE_PLAN[it.lifecycle_phase]) return phaseFromTitle(it.title) === 'DATA_MIGRATION' ? 'DATA_MIGRATION' : LIFECYCLE_PLAN[it.lifecycle_phase];
  if (AREA_PHASE[it.project_area]) return AREA_PHASE[it.project_area];
  return phaseFromTitle(it.title) || 'DEVELOPMENT';
}
const norm = (s) => String(s || '').replace(/[\s·/・.,()]/g, '').toLowerCase();
const NODE_ALIASES = { INITIATION: ['착수', '프로젝트착수'], REQUIREMENTS: ['요구사항정의', '요구사항'], ANALYSIS_DESIGN: ['분석설계', '설계'], DATA_MIGRATION: ['데이터이관', '이관'], DEVELOPMENT: ['구현', '개발', '기능개발'], TESTING: ['시험', '테스트'], TRANSITION_GO_LIVE: ['전환오픈', '전환', '오픈'], OPERATIONS: ['운영', '운영및유지보수', '운영유지보수', '유지보수', '운영안정화'] };
/** A group title that only repeats a fixed node's name ('테스트', '분석/설계') → that plan phase; the node itself replaces the group. */
export const sameAsNode = (title, { strict = false } = {}) => { const t = norm(title); return Object.entries(NODE_ALIASES).find(([, a]) => (strict ? a.slice(0, 1) : a).includes(t))?.[0] || null; };   // strict: the node's own name only (엑셀 가져오기)

/* ---------- 날짜 자동 배분 (rule, not AI) ---------- */
/**
 * items: [{ temp_id, parent_temp_id, item_type, plan_phase?, planned_duration_days }] — the chosen draft items. `plan_phase` is read from the
 * top-level ancestor (inferPlanPhase when absent). Phases run one after the other over the project's workdays in the base ratios; a phase whose
 * length is in `phaseWorkdays` keeps it and the rest share what is left. Inside a phase the leaf tasks are laid out in order, sized by
 * planned_duration_days (relative weights; unknown → the phase's mean). A milestone lands on its phase's last workday. Every date is a workday.
 * Returns { ok, workdays, phases: [{ plan, key, title, start, end, workdays, holidays }], dates: { temp_id: {planned_start_date, planned_end_date} | {milestone_date} }, end, overrun }.
 */
export function allocateSchedule({ items = [], start, end, hol = null, withDm = false, phaseWorkdays = {} }) {
  if (!start || !end || end < start) return { ok: false, reason: '프로젝트 시작일과 종료일이 있어야 날짜를 배분할 수 있습니다.', phases: [], dates: {} };
  const byTemp = new Map(items.map((i) => [i.temp_id, i]));
  const top = (it) => { let x = it; let g = 0; while (x.parent_temp_id && byTemp.has(x.parent_temp_id) && g++ < 60) x = byTemp.get(x.parent_temp_id); return x; };
  const phaseOf = (it) => { const t = top(it); return t.plan_phase || inferPlanPhase(t); };
  const dm = withDm || items.some((i) => phaseOf(i) === 'DATA_MIGRATION');
  const ops = items.some((i) => phaseOf(i) === 'OPERATIONS');
  const nodes = allocNodesFor(dm, ops);
  const days = workdayList(snapToWorkday(start, 1, hol), end, hol); const W = days.length;
  if (!W) return { ok: false, reason: '프로젝트 기간에 근무일이 없습니다.', phases: [], dates: {} };
  const dayAt = (i) => (i < W ? days[i] : addWorkdays(days[W - 1], i - W + 1, hol));
  // phase lengths: overrides first, the rest by ratio (largest remainder, at least 1 workday each)
  const fixed = Object.fromEntries(nodes.filter((n) => Number.isInteger(phaseWorkdays[n.plan]) && phaseWorkdays[n.plan] > 0).map((n) => [n.plan, phaseWorkdays[n.plan]]));
  const free = nodes.filter((n) => !(n.plan in fixed));
  const left = Math.max(free.length, W - Object.values(fixed).reduce((a, b) => a + b, 0));
  const rs = free.reduce((a, n) => a + ratioOf(n, dm, ops), 0) || 1;
  const raw = free.map((n) => (left * ratioOf(n, dm, ops)) / rs);
  const len = raw.map((x) => Math.max(1, Math.floor(x)));
  let spare = left - len.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; spare > 0 && order.length; k = (k + 1) % order.length) { len[order[k][1]]++; spare--; }
  const lengthOf = (n) => (n.plan in fixed ? fixed[n.plan] : len[free.indexOf(n)]);
  const hasKids = new Set(items.filter((i) => i.parent_temp_id && byTemp.has(i.parent_temp_id)).map((i) => i.parent_temp_id));
  const phases = []; const dates = {}; let at = 0;
  for (const n of nodes) {
    const nd = lengthOf(n); const i0 = at; at += nd;
    const ph = { plan: n.plan, key: n.key, title: n.title, start: dayAt(i0), end: dayAt(i0 + nd - 1), workdays: nd };
    ph.holidays = hol && typeof hol.get === 'function' ? [...hol.entries()].filter(([d]) => d >= ph.start && d <= ph.end).map(([day, name]) => ({ day, name })) : [];
    phases.push(ph);
    const mine = items.filter((i) => phaseOf(i) === n.plan);
    const leaves = mine.filter((i) => i.item_type !== 'MILESTONE' && !hasKids.has(i.temp_id));
    const known = leaves.map((i) => Number(i.planned_duration_days)).filter((x) => x > 0);
    const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const w = leaves.map((i) => (Number(i.planned_duration_days) > 0 ? Number(i.planned_duration_days) : mean));
    const T = w.reduce((a, b) => a + b, 0) || 1; let cum = 0;
    leaves.forEach((it, k) => {
      const a = Math.min(nd - 1, Math.floor((cum / T) * nd)); cum += w[k];
      const b = Math.max(a, Math.min(nd - 1, Math.ceil((cum / T) * nd) - 1));
      dates[it.temp_id] = { planned_start_date: dayAt(i0 + a), planned_end_date: dayAt(i0 + b) };
    });
    for (const m of mine.filter((i) => i.item_type === 'MILESTONE')) dates[m.temp_id] = { milestone_date: ph.end };
  }
  const last = phases.length ? phases[phases.length - 1].end : end;
  return { ok: true, workdays: W, phases, dates, end: last, overrun: last > end };
}
