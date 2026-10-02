/**
 * Project dashboard (GET …/:pid/dashboard): everything is computed on read from the source tables, nothing is stored.
 * "Today" is CURRENT_DATE of the DB session, whose time zone is APP_TIMEZONE (see db.js) — the same clock metrics.js / health.js use.
 * "Delayed" follows health.js: a live TASK that is not COMPLETED and whose planned_end_date is before today.
 */
import * as R from './requirements.js';
import * as W from './wbs.js';

const RECENT_LIMIT = 15; const OVERDUE_LIMIT = 20; const TIMELINE_LIMIT = 40; const MILESTONE_LIMIT = 100;
const TODAY = 'CURRENT_DATE';
const OVERDUE = `(w.status <> 'COMPLETED' AND w.planned_end_date IS NOT NULL AND w.planned_end_date < ${TODAY})`;

/* ---------- Korean summaries for the activity feed ---------- */
const hasBatchim = (word) => { const c = String(word).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
const josa = (word, withB, without) => `${word}${hasBatchim(word) ? withB : without}`;

const STATUS_LABELS = {
  REQUIREMENT: { DRAFT: '작성 중', REVIEWING: '검토 중', CONFIRMED: '확정', ON_HOLD: '보류', REJECTED: '반려' },
  WBS: { NOT_STARTED: '시작 전', IN_PROGRESS: '진행 중', COMPLETED: '완료', ON_HOLD: '보류' },
  CHANGE: { DRAFT: '초안', UNDER_REVIEW: '검토 중', APPROVED: '승인', REJECTED: '반려', IMPLEMENTED: '반영 완료' },
  ISSUE: { OPEN: '열림', IN_PROGRESS: '진행 중', BLOCKED: '차단됨', RESOLVED: '해결', CLOSED: '종료' },
  RISK: { OPEN: '열림', MONITORING: '모니터링', MATERIALIZED: '발생', CLOSED: '종료' },
  TEST: { DRAFT: '초안', READY: '준비됨', BLOCKED: '차단됨', COMPLETED: '완료' },
  ACCEPTANCE: { DRAFT: '초안', REQUESTED: '검수 요청', ACCEPTED: '승인', REJECTED: '반려', REWORK_REQUIRED: '보완 필요' },
};
const FIELD_LABELS = { title: '제목', description: '설명', type: '분류', priority: '우선순위', scope: '범위', status: '상태', owner_user_id: '담당자', requester: '요청자', progress: '진행률',
  item_type: '유형', planned_start_date: '시작일', planned_end_date: '종료일', actual_start_date: '실제 시작일', actual_end_date: '실제 종료일', milestone_date: '마일스톤 날짜',
  severity: '심각도', due_date: '기한', risk_level: '위험 수준', probability: '발생 가능성', impact: '영향도', result: '결과' };
const VALUE_FIELDS = new Set(['status', 'priority', 'scope', 'type', 'progress', 'item_type', 'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'milestone_date', 'severity', 'due_date']);
const VALUE_MAP = { type: { UNSPECIFIED: '미지정', FUNCTIONAL: '기능', NON_FUNCTIONAL: '비기능', INTERFACE: '인터페이스', DATA: '데이터', SECURITY: '보안', OPERATION: '운영', OTHER: '기타' },
  priority: { UNSPECIFIED: '미지정', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }, scope: { UNDECIDED: '미결정', IN_SCOPE: '범위 내', OUT_OF_SCOPE: '범위 외' },
  item_type: { SUMMARY: '상위 항목', TASK: '작업', MILESTONE: '마일스톤' } };
const SIMPLE = {
  CREATED: '새로 등록했습니다.', ARCHIVED: '보관했습니다.', CONVERTED: '다른 항목으로 전환했습니다.', EXECUTED: '테스트를 실행했습니다.', ISSUE_RAISED: 'Issue를 등록했습니다.',
  CRITERION_ADDED: '완료 조건을 추가했습니다.', CRITERION_UPDATED: '완료 조건을 수정했습니다.', CRITERION_REMOVED: '완료 조건을 삭제했습니다.',
  LINKED_WBS: 'WBS 항목을 연결했습니다.', UNLINKED_WBS: 'WBS 연결을 해제했습니다.', LINKED_REQ: '요구사항을 연결했습니다.', UNLINKED_REQ: '요구사항 연결을 해제했습니다.',
  LINK_TYPE_CHANGED: '연결 유형을 변경했습니다.', MOVED: '위치를 이동했습니다.', DEP_ADDED: '선행 작업을 추가했습니다.', DEP_REMOVED: '선행 작업을 삭제했습니다.',
  REQUIREMENT_LINKED: '요구사항을 연결했습니다.', REQUIREMENT_UNLINKED: '요구사항 연결을 해제했습니다.', WBS_IMPACT_ADDED: '영향 WBS를 추가했습니다.', WBS_IMPACT_UPDATED: '영향 WBS를 수정했습니다.',
  WBS_IMPACT_REMOVED: '영향 WBS를 삭제했습니다.', LINKED: '연결 항목을 추가했습니다.', UNLINKED: '연결 항목을 삭제했습니다.',
};

export function summarize(type, ev) {
  const val = (x) => (x === null || x === undefined || x === '' ? '없음' : (type && STATUS_LABELS[type] && ev.field_name === 'status' ? STATUS_LABELS[type][x] : VALUE_MAP[ev.field_name]?.[x]) || x);
  const a = ev.action_type; const f = ev.field_name;
  if (a === 'STATUS_CHANGED' || (a === 'UPDATED' && f === 'status')) return `상태를 '${val(ev.new_value)}'(으)로 변경했습니다.`;
  if (a === 'UPDATED' || a === 'STATUS_CHANGED') {
    const label = FIELD_LABELS[f] || f || '내용';
    return VALUE_FIELDS.has(f) ? `${josa(label, '을', '를')} '${val(ev.new_value)}'(으)로 변경했습니다.` : `${josa(label, '을', '를')} 수정했습니다.`;
  }
  return SIMPLE[a] || '변경했습니다.';
}

async function recentChanges(db, pid) {
  const lim = RECENT_LIMIT;
  const cols = `h.changed_at AS at, h.seq, u.name AS actor_name, h.action_type, h.field_name, h.old_value, h.new_value, e.id AS entity_id, e.title`;
  const order = `ORDER BY h.changed_at DESC, h.seq DESC LIMIT ${lim}`;
  // One history table per entity (FK column) …
  const direct = (table, fk, ent, code = 'e.display_id') => db.all(`SELECT ${cols}, ${code} AS display_id FROM ${table} h JOIN ${ent} e ON e.id = h.${fk} LEFT JOIN users u ON u.id = h.changed_by WHERE e.project_id = ? ${order}`, [pid]);
  // … or polymorphic on (entity_type, entity_id): one query per concrete entity table.
  const poly = (table, type, ent) => db.all(`SELECT ${cols}, e.display_id FROM ${table} h JOIN ${ent} e ON e.id = h.entity_id AND h.entity_type = '${type}' LEFT JOIN users u ON u.id = h.changed_by WHERE e.project_id = ? ${order}`, [pid]);
  const [reqs, wbs, chg, issues, risks, tests, accs, phases] = await Promise.all([
    direct('requirement_history', 'requirement_id', 'requirements'),
    direct('wbs_history', 'wbs_item_id', 'wbs_items', 'e.wbs_code'),
    direct('change_request_history', 'change_request_id', 'change_requests'),
    poly('raid_history', 'ISSUE', 'issues'), poly('raid_history', 'RISK', 'risks'),
    poly('qa_history', 'TEST', 'test_cases'), poly('qa_history', 'ACCEPTANCE', 'acceptances'),
    db.all(`SELECT t.changed_at AS at, t.seq, u.name AS actor_name, p.id AS entity_id, p.phase_key, p.name AS title
      FROM phase_transitions t JOIN project_phases p ON p.id = t.to_phase_id LEFT JOIN users u ON u.id = t.changed_by
      WHERE t.project_id = ? ORDER BY t.changed_at DESC, t.seq DESC LIMIT ${lim}`, [pid]),
  ]);
  const tag = (rows, type, href) => rows.map((r) => ({ ...r, entity_type: type, href: href(r.entity_id), summary: summarize(type, r) }));
  const events = [
    ...tag(reqs, 'REQUIREMENT', (id) => `requirements?sel=${id}`), ...tag(wbs, 'WBS', (id) => `wbs?sel=${id}`), ...tag(chg, 'CHANGE', (id) => `changes?sel=${id}`),
    ...tag(issues, 'ISSUE', (id) => `issues?sel=${id}`), ...tag(risks, 'RISK', (id) => `issues?tab=risks&sel=${id}`),
    ...tag(tests, 'TEST', (id) => `tests?sel=${id}`), ...tag(accs, 'ACCEPTANCE', (id) => `tests?tab=acceptance&sel=${id}`),
    ...phases.map((r) => ({ ...r, entity_type: 'PHASE', display_id: null, href: `phases/${r.phase_key}`, summary: `'${r.title}' 단계로 전환했습니다.` })),
  ];
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq));
  return events.slice(0, lim).map((e) => ({ at: e.at, actor_name: e.actor_name, entity_type: e.entity_type, entity_id: e.entity_id, display_id: e.display_id, title: e.title, summary: e.summary, href: e.href }));
}

/** Timeline rows: SUMMARY items and top-level items, in tree order; SUMMARY dates are the span of everything below them. */
function timeline(items) {
  const span = new Map();                                    // id → { s, e } of the subtree below
  for (let i = items.length - 1; i >= 0; i--) {              // pre-order reversed: children are folded in before their parent
    const it = items[i]; const own = it.item_type === 'MILESTONE' ? [it.milestone_date, it.milestone_date] : [it.planned_start_date, it.planned_end_date];
    const sub = span.get(it.id) || { s: null, e: null };
    const s = [own[0], sub.s].filter(Boolean).sort()[0] || null; const e = [own[1], sub.e].filter(Boolean).sort().pop() || null;
    if (it.parent_id) {
      const p = span.get(it.parent_id) || { s: null, e: null };
      span.set(it.parent_id, { s: [p.s, s].filter(Boolean).sort()[0] || null, e: [p.e, e].filter(Boolean).sort().pop() || null });
    }
  }
  return items.filter((it) => it.item_type === 'SUMMARY' || it.depth === 0).slice(0, TIMELINE_LIMIT).map((it) => {
    let start; let end;
    if (it.item_type === 'SUMMARY') { const d = span.get(it.id) || {}; start = d.s || it.planned_start_date || null; end = d.e || it.planned_end_date || null; }
    else if (it.item_type === 'MILESTONE') { start = it.milestone_date; end = it.milestone_date; }
    else { start = it.planned_start_date; end = it.planned_end_date; }
    return { id: it.id, wbs_code: it.wbs_code, title: it.title, item_type: it.item_type, depth: it.depth, start: start || null, end: end || null, progress: it.computed_progress, status: it.status };
  });
}

export async function projectDashboard(db, project) {
  const pid = project.id;
  const [taskRow, reqStats, overdue, workload, milestones, issues, tree, recent] = await Promise.all([
    db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((w.status = 'IN_PROGRESS')::int), 0) AS in_progress, COALESCE(SUM((w.status = 'COMPLETED')::int), 0) AS completed,
        COALESCE(SUM(${OVERDUE}::int), 0) AS delayed FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK'`, [pid]),
    R.requirementStats(db, pid),
    db.all(`SELECT w.id, w.wbs_code, w.title, w.owner_user_id AS owner_id, u.name AS owner_name, w.planned_end_date, (${TODAY} - w.planned_end_date) AS days_overdue, w.status, w.progress
      FROM wbs_items w LEFT JOIN users u ON u.id = w.owner_user_id
      WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${OVERDUE} ORDER BY w.planned_end_date, w.sequence LIMIT ${OVERDUE_LIMIT}`, [pid]),
    db.all(`SELECT w.owner_user_id AS owner_id, u.name AS owner_name, COUNT(*) AS tasks, COALESCE(SUM((w.status = 'IN_PROGRESS')::int), 0) AS in_progress,
        COALESCE(SUM((w.status = 'COMPLETED')::int), 0) AS completed, COALESCE(SUM(${OVERDUE}::int), 0) AS overdue, COALESCE(ROUND(AVG(w.progress)), 0) AS avg_progress
      FROM wbs_items w LEFT JOIN users u ON u.id = w.owner_user_id WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK'
      GROUP BY w.owner_user_id, u.name`, [pid]),
    db.all(`SELECT w.id, w.wbs_code, w.title, w.milestone_date, w.status, (w.milestone_date - ${TODAY}) AS days_left FROM wbs_items w
      WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'MILESTONE' ORDER BY w.milestone_date NULLS LAST, w.sequence LIMIT ${MILESTONE_LIMIT}`, [pid]),
    db.get(`SELECT COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED'))::int), 0) AS open, COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED') AND severity IN ('CRITICAL','HIGH'))::int), 0) AS critical_or_high
      FROM issues WHERE project_id = ? AND archived_at IS NULL`, [pid]),
    W.loadTree(db, project),
    recentChanges(db, pid),
  ]);
  return {
    tasks: { total: taskRow.total, in_progress: taskRow.in_progress, completed: taskRow.completed, delayed: taskRow.delayed },
    requirements: { total: reqStats.total, unconfirmed: reqStats.draft + reqStats.reviewing, unlinked_in_scope: reqStats.in_scope_unlinked },
    recent_changes: recent,
    overdue_tasks: overdue,
    workload: workload.map((r) => ({ ...r, owner_name: r.owner_name || '미지정' })).sort((a, b) => (b.tasks - b.completed) - (a.tasks - a.completed) || b.tasks - a.tasks || a.owner_name.localeCompare(b.owner_name, 'ko')),
    milestones,
    timeline: timeline(tree.items),
    issues,
  };
}
