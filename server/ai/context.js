/**
 * Context retrieval for AI features: compact, structured text built from SQL. Only project work data is ever included —
 * no user e-mails, sessions, billing or admin data. Every list is capped (Top N) so a 1,000-task project still fits.
 * Free-text fields read from the DB (titles, descriptions, comments) are neutralized: they are data, not instructions.
 */
import { neutralize } from './prompts.js';
import { attentionAll, upcomingDates } from '../metrics.js';
import { projectHealth } from '../health.js';
import { REQ_TYPES } from '../requirements.js';
import { jiraContextLines } from '../integrations/jira/sync.js';

const clip = (s, n) => { const t = neutralize(String(s ?? '').replace(/\s+/g, ' ').trim()); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const lines = (title, rows, fn, empty = '(없음)') => `## ${title}\n${rows.length ? rows.map(fn).join('\n') : empty}`;
const LAST_RESULT = `(SELECT e.result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;

/* ---------- shared pieces ---------- */
export async function projectBlock(db, project) {
  const ph = await db.get('SELECT name, sequence FROM project_phases WHERE project_id = ? AND phase_key = ?', [project.id, project.current_phase]);
  return `## 프로젝트\n이름: ${clip(project.name, 100)}\n유형: ${project.project_type}\n설명: ${clip(project.description, 600) || '(없음)'}\n현재 단계: ${ph ? `${ph.sequence}. ${ph.name}` : project.current_phase}\n계획 기간: ${project.planned_start_date || '?'} ~ ${project.planned_end_date || '?'}`;
}
export const requirementRows = (db, projectId, { limit = 200, ids = null } = {}) => db.all(`SELECT id, display_id, title, description, type, priority, scope, status FROM requirements
  WHERE project_id = ? AND archived_at IS NULL ${ids ? 'AND id = ANY(?::text[])' : ''} ORDER BY sequence_number LIMIT ?`, ids ? [projectId, ids, limit] : [projectId, limit]);
export const wbsRows = (db, projectId, { limit = 200 } = {}) => db.all(`SELECT w.id, w.wbs_code, w.item_type, w.title, w.status, w.progress, w.planned_start_date, w.planned_end_date, w.milestone_date, w.parent_id,
    (w.item_type = 'TASK' AND w.status != 'COMPLETED' AND w.planned_end_date IS NOT NULL AND w.planned_end_date < CURRENT_DATE)::int AS overdue
  FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL ORDER BY w.wbs_code LIMIT ?`, [projectId, limit]);
const reqLine = (r) => `- ${r.display_id} [${r.status}/${r.scope}/${r.priority}] ${clip(r.title, 120)}`;
const wbsLine = (w) => `- ${w.wbs_code} [${w.item_type}/${w.status}${w.overdue ? '/지연' : ''}] ${clip(w.title, 100)}${w.planned_end_date ? ` (~${w.planned_end_date})` : w.milestone_date ? ` (${w.milestone_date})` : ''}`;

/* ---------- feature 1: requirement extraction ---------- */
export async function extractionContext(db, project) {
  const existing = await requirementRows(db, project.id, { limit: 150 });
  return { existing, text: `${await projectBlock(db, project)}\n\n## 허용 enum\ntype: ${REQ_TYPES.join(' | ')}\n\n${lines(`기존 요구사항 (${existing.length}건, 중복 판단용)`, existing, reqLine)}` };
}

/* ---------- feature 2: WBS generation ---------- */
export async function wbsGenerationContext(db, project, requirementIds) {
  const reqs = await requirementRows(db, project.id, { ids: requirementIds, limit: 60 });
  const crit = reqs.length ? await db.all('SELECT requirement_id, content FROM requirement_criteria WHERE requirement_id = ANY(?::text[]) ORDER BY sequence', [reqs.map((r) => r.id)]) : [];
  const critBy = new Map(); for (const c of crit) critBy.set(c.requirement_id, [...(critBy.get(c.requirement_id) || []), c.content]);
  const wbs = await wbsRows(db, project.id, { limit: 150 });
  const text = `${await projectBlock(db, project)}\n\n${lines(`선택 요구사항 (${reqs.length}건)`, reqs, (r) => `- ${r.display_id} [${r.type}/${r.priority}] ${clip(r.title, 150)}\n  설명: ${clip(r.description, 400) || '(없음)'}${critBy.get(r.id) ? `\n  완료 조건: ${critBy.get(r.id).map((c) => clip(c, 120)).join(' / ')}` : ''}`)}\n\n${lines(`기존 WBS (${wbs.length}건, 중복 방지용)`, wbs, wbsLine)}`;
  return { reqs, wbs, text };
}

/* ---------- feature 3: change impact ---------- */
export async function changeImpactContext(db, project, change) {
  const reqs = await requirementRows(db, project.id, { limit: 150 });
  const wbs = await wbsRows(db, project.id, { limit: 150 });
  const links = await db.all(`SELECT l.requirement_id, r.display_id, w.wbs_code FROM requirement_wbs_links l JOIN requirements r ON r.id = l.requirement_id JOIN wbs_items w ON w.id = l.wbs_item_id
    WHERE l.project_id = ? AND r.archived_at IS NULL AND w.archived_at IS NULL ORDER BY r.sequence_number, w.wbs_code LIMIT 400`, [project.id]);
  const tests = await db.all(`SELECT t.id, t.display_id, t.title, t.status, ${LAST_RESULT} AS last_result,
      (SELECT STRING_AGG(COALESCE(r.display_id, w.wbs_code), ',') FROM test_links tl LEFT JOIN requirements r ON r.id = tl.target_id AND tl.target_type = 'REQUIREMENT' LEFT JOIN wbs_items w ON w.id = tl.target_id AND tl.target_type = 'WBS' WHERE tl.test_case_id = t.id) AS targets
    FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY t.sequence_number LIMIT 100`, [project.id]);
  const risks = await db.all(`SELECT id, display_id, title, risk_level, status FROM risks WHERE project_id = ? AND archived_at IS NULL AND status IN ('OPEN','MONITORING') ORDER BY sequence_number LIMIT 50`, [project.id]);
  const issues = await db.all(`SELECT id, display_id, title, severity, status FROM issues WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED') ORDER BY sequence_number LIMIT 50`, [project.id]);
  const linked = change.requirements.filter((r) => !r.archived_at).map((r) => `${r.display_id} (${r.relation_type})`).join(', ') || '(없음)';
  const impacts = change.impacts.filter((i) => !i.archived_at).map((i) => `${i.wbs_code} (${i.impact_type})`).join(', ') || '(없음)';
  const text = `${await projectBlock(db, project)}\n\n## 변경 요청\n${change.display_id} ${clip(change.title, 150)}\n상태: ${change.status} / 우선순위: ${change.priority}\n설명: ${clip(change.description, 1200) || '(없음)'}\n사유: ${clip(change.reason, 600) || '(없음)'}\n이미 연결된 요구사항: ${linked}\n이미 기록된 영향 WBS: ${impacts}\n\n${lines(`요구사항 (${reqs.length}건)`, reqs, reqLine)}\n\n${lines(`요구사항 ↔ WBS 연결 (${links.length}건)`, links, (l) => `- ${l.display_id} → ${l.wbs_code}`)}\n\n${lines(`WBS (${wbs.length}건)`, wbs, wbsLine)}\n\n${lines(`테스트 (${tests.length}건)`, tests, (t) => `- ${t.display_id} [${t.status}/${t.last_result || 'NOT_RUN'}] ${clip(t.title, 100)}${t.targets ? ` ← ${t.targets}` : ''}`)}\n\n${lines(`Open Risk (${risks.length}건)`, risks, (r) => `- ${r.display_id} [${r.risk_level}/${r.status}] ${clip(r.title, 100)}`)}\n\n${lines(`Open Issue (${issues.length}건)`, issues, (i) => `- ${i.display_id} [${i.severity}/${i.status}] ${clip(i.title, 100)}`)}`;
  return { reqs, wbs, tests, risks, issues, text };
}

/* ---------- feature 4: project Q&A (intent → context) ---------- */
export const INTENTS = ['schedule', 'scope', 'quality', 'risk', 'change', 'general'];
const INTENT_WORDS = {
  schedule: /일정|지연|마일스톤|milestone|오픈|open|기한|deadline|언제|delay|wbs|작업|task|진행률|schedule/i,
  scope: /요구사항|requirement|req-|범위|scope|미확정|확정|연결되지|미연결|coverage|추가 요청/i,
  quality: /테스트|test|tc-|검수|acceptance|acc-|품질|quality|fail|pass|실패|통과|결함/i,
  risk: /리스크|risk|rsk-|위험|이슈|issue|iss-|문제|블로커|block|critical/i,
  change: /변경|change|cr-|승인|approve|반영|impact|영향/i,
};
/** Keyword routing (no LLM call): several intents may match — each adds its own context block; nothing → general. */
export function classifyQuestion(q) {
  const hits = INTENTS.filter((k) => k !== 'general' && INTENT_WORDS[k].test(q));
  const ids = [...String(q).matchAll(/\b(REQ|CR|ISS|RSK|TC|ACC)-\d{1,6}\b/gi)].map((m) => m[0].toUpperCase());
  if (ids.some((i) => i.startsWith('CR-')) && !hits.includes('change')) hits.push('change');
  return { intents: hits.length ? hits : ['general'], ids };
}

export async function assistantContext(db, project, question) {
  const { intents, ids } = classifyQuestion(question);
  const parts = [await projectBlock(db, project)];
  const refs = new Map();   // display_id → { type, id, title, href }
  const keep = (type, rows, href) => { for (const r of rows) refs.set(r.display_id, { type, id: r.id, display_id: r.display_id, title: r.title, href: href(r) }); };
  const always = intents.includes('general') || intents.length >= 3;
  {   // health + attention are cheap and anchor every answer
    const h = await projectHealth(db, project);
    parts.push(`## 프로젝트 상태 (Health)\n전체: ${h.status_label}\n${Object.values(h.dimensions).map((d) => `- ${d.label}: ${d.status_label}${d.reasons.length ? ` — ${d.reasons.map((x) => clip(x, 120)).join('; ')}` : ''}`).join('\n')}`);
    const att = (await attentionAll(db, project.id)).slice(0, 25);
    parts.push(lines(`확인 필요 항목 (우선순위 순, ${att.length}건)`, att, (a) => `- ${a.display_id} [${a.type}] ${clip(a.title, 100)} — ${clip(a.meta, 80)}`));
    for (const a of att) refs.set(a.display_id, { type: a.type, id: a.id, display_id: a.display_id, title: a.title, href: a.href });
  }
  if (always || intents.includes('schedule')) {
    const up = await upcomingDates(db, project.id, { days: 14, limit: 25 });
    parts.push(lines('14일 내 일정', up, (u) => `- ${u.date} ${u.label}: ${u.display_id} ${clip(u.title, 80)}`));
    const wbs = await wbsRows(db, project.id, { limit: 120 });
    parts.push(lines(`WBS (${wbs.length}건)`, wbs, wbsLine));
    keep('WBS', wbs.map((w) => ({ ...w, display_id: w.wbs_code })), (w) => `wbs?sel=${w.id}`);
    // Jira execution (Phase 12): DB snapshots only — never a live Jira call for an AI request. WBS progress and Jira execution stay separate figures.
    const jira = await jiraContextLines(db, project.id, 40);
    if (jira && jira.summary.total) parts.push(`## Jira 실행 (${jira.project_key}, 스냅샷 기준)\n연결 Issue ${jira.summary.total}개 · Done ${jira.summary.done} · In Progress ${jira.summary.in_progress} · To Do ${jira.summary.todo} (Jira 실행률 ${jira.summary.rate}% — WBS 진행률과 별개 지표)\n${jira.lines.join('\n')}`);
  }
  if (always || intents.includes('scope') || intents.includes('change')) {
    const reqs = await requirementRows(db, project.id, { limit: 120 });
    const unlinked = new Set((await db.all(`SELECT r.id FROM requirements r WHERE r.project_id = ? AND r.archived_at IS NULL AND r.scope = 'IN_SCOPE'
      AND NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = r.id AND w.archived_at IS NULL)`, [project.id])).map((r) => r.id));
    parts.push(lines(`요구사항 (${reqs.length}건)`, reqs, (r) => `${reqLine(r)}${unlinked.has(r.id) ? ' (WBS 미연결)' : ''}`));
    keep('REQUIREMENT', reqs, (r) => `requirements?sel=${r.id}`);
    const chg = await db.all(`SELECT id, display_id, title, status, priority, schedule_impact_days FROM change_requests WHERE project_id = ? AND archived_at IS NULL ORDER BY sequence_number DESC LIMIT 40`, [project.id]);
    parts.push(lines(`변경 요청 (${chg.length}건)`, chg, (c) => `- ${c.display_id} [${c.status}/${c.priority}] ${clip(c.title, 100)}${c.schedule_impact_days ? ` (일정 영향 ${c.schedule_impact_days}일)` : ''}`));
    keep('CHANGE', chg, (c) => `changes?sel=${c.id}`);
  }
  if (always || intents.includes('quality')) {
    const tests = await db.all(`SELECT t.id, t.display_id, t.title, t.status, ${LAST_RESULT} AS last_result FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY t.sequence_number LIMIT 100`, [project.id]);
    parts.push(lines(`테스트 (${tests.length}건)`, tests, (t) => `- ${t.display_id} [${t.status}/${t.last_result || 'NOT_RUN'}] ${clip(t.title, 100)}`));
    keep('TEST', tests, (t) => `tests?sel=${t.id}`);
    const accs = await db.all(`SELECT id, display_id, title, status, due_date FROM acceptances WHERE project_id = ? AND archived_at IS NULL ORDER BY sequence_number LIMIT 40`, [project.id]);
    parts.push(lines(`검수 (${accs.length}건)`, accs, (a) => `- ${a.display_id} [${a.status}] ${clip(a.title, 100)}${a.due_date ? ` (기한 ${a.due_date})` : ''}`));
    keep('ACCEPTANCE', accs, (a) => `tests?tab=acceptance&sel=${a.id}`);
  }
  if (always || intents.includes('risk') || intents.includes('quality')) {
    const issues = await db.all(`SELECT id, display_id, title, severity, status, due_date FROM issues WHERE project_id = ? AND archived_at IS NULL ORDER BY (status IN ('RESOLVED','CLOSED')), sequence_number DESC LIMIT 60`, [project.id]);
    parts.push(lines(`Issue (${issues.length}건)`, issues, (i) => `- ${i.display_id} [${i.severity}/${i.status}] ${clip(i.title, 100)}${i.due_date ? ` (기한 ${i.due_date})` : ''}`));
    keep('ISSUE', issues, (i) => `issues?sel=${i.id}`);
    const risks = await db.all(`SELECT id, display_id, title, risk_level, status, review_date FROM risks WHERE project_id = ? AND archived_at IS NULL ORDER BY (status = 'CLOSED'), sequence_number DESC LIMIT 60`, [project.id]);
    parts.push(lines(`Risk (${risks.length}건)`, risks, (r) => `- ${r.display_id} [${r.risk_level}/${r.status}] ${clip(r.title, 100)}${r.review_date ? ` (검토일 ${r.review_date})` : ''}`));
    keep('RISK', risks, (r) => `issues?tab=risks&sel=${r.id}`);
  }
  // Entities named in the question get a detail block even when their list was not loaded (e.g. "CR-003 영향은?").
  for (const id of ids.slice(0, 3)) {
    const extra = await entityDetail(db, project, id);
    if (extra) { parts.push(extra.text); refs.set(extra.ref.display_id, extra.ref); }
  }
  return { intents, text: parts.join('\n\n'), refs };
}

const DETAIL = {
  CR: { table: 'change_requests', type: 'CHANGE', href: (r) => `changes?sel=${r.id}` },
  REQ: { table: 'requirements', type: 'REQUIREMENT', href: (r) => `requirements?sel=${r.id}` },
  ISS: { table: 'issues', type: 'ISSUE', href: (r) => `issues?sel=${r.id}` },
  RSK: { table: 'risks', type: 'RISK', href: (r) => `issues?tab=risks&sel=${r.id}` },
  TC: { table: 'test_cases', type: 'TEST', href: (r) => `tests?sel=${r.id}` },
  ACC: { table: 'acceptances', type: 'ACCEPTANCE', href: (r) => `tests?tab=acceptance&sel=${r.id}` },
};
async function entityDetail(db, project, displayId) {
  const def = DETAIL[displayId.split('-')[0]]; if (!def) return null;
  const r = await db.get(`SELECT * FROM ${def.table} WHERE project_id = ? AND display_id = ?`, [project.id, displayId]);
  if (!r) return null;
  const fields = ['status', 'priority', 'severity', 'risk_level', 'scope', 'due_date', 'review_date', 'schedule_impact_days'].filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== '').map((k) => `${k}: ${r[k]}`).join(', ');
  let extra = '';
  if (def.type === 'CHANGE') {
    const rq = await db.all('SELECT r.display_id, x.relation_type FROM change_request_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.change_request_id = ?', [r.id]);
    const im = await db.all('SELECT w.wbs_code, x.impact_type FROM change_request_wbs_impacts x JOIN wbs_items w ON w.id = x.wbs_item_id WHERE x.change_request_id = ?', [r.id]);
    extra = `\n연결 요구사항: ${rq.map((x) => `${x.display_id}(${x.relation_type})`).join(', ') || '(없음)'}\n영향 WBS: ${im.map((x) => `${x.wbs_code}(${x.impact_type})`).join(', ') || '(없음)'}`;
  }
  return { text: `## ${displayId} 상세\n제목: ${clip(r.title, 150)}\n${fields}\n설명: ${clip(r.description, 800) || '(없음)'}${r.reason ? `\n사유: ${clip(r.reason, 400)}` : ''}${extra}`,
    ref: { type: def.type, id: r.id, display_id: displayId, title: r.title, href: def.href(r) } };
}
