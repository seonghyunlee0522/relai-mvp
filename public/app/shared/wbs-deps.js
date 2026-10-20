/* 선행 작업 (FS = finish-to-start) 일정 점검 — P2 (Jim prod 10-21 #11). Pure; shared by the WBS page (row chip, 선행 tab, Gantt links)
 * and the server (POST …/dependencies answers with `warning`). An FS link says the successor starts after the predecessor finishes,
 * so a successor that starts on or before the predecessor's end date is a conflict. Dates are 'YYYY-MM-DD' strings; an item without
 * dates is never a conflict (nothing to compare). A group uses its roll-up span (planned_start / planned_end) when it has no own dates. */
const startOf = (it) => (it ? it.planned_start_date || it.milestone_date || it.planned_start || null : null);
const endOf = (it) => (it ? it.planned_end_date || it.milestone_date || it.planned_end || null : null);
export const depDates = { startOf, endOf };

/** One link → null when fine, else { pred_end, succ_start }. */
export function fsConflict(pred, succ) {
  const pe = endOf(pred); const ss = startOf(succ);
  return pe && ss && ss <= pe ? { pred_end: pe, succ_start: ss } : null;
}
/** items: [{ id, wbs_code, title, predecessors: [{ predecessor_id }] , dates… }] → Map successorId → [{ pred, pred_end, succ_start }]. */
export function fsConflicts(items = []) {
  const byId = new Map(items.map((it) => [it.id, it])); const out = new Map();
  for (const it of items) for (const d of it.predecessors || []) {
    const pred = byId.get(d.predecessor_id); const c = pred && fsConflict(pred, it);
    if (c) { if (!out.has(it.id)) out.set(it.id, []); out.get(it.id).push({ pred, ...c }); }
  }
  return out;
}
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
/** "선행 2.1 종료(11/20) 전에 시작(11/16)합니다" — one line per conflict. */
export const fsWarning = (pred, c) => `선행 ${pred.wbs_code || ''} ${pred.title || ''} 종료(${md(c.pred_end)}) 전에 시작(${md(c.succ_start)})합니다. 선행 작업이 끝난 뒤로 시작일을 옮기거나 선행 관계를 확인하세요.`.replace(/\s+/g, ' ');
