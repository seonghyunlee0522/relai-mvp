/**
 * 06 오픈 (Phase 6 US-3) — the 오픈 dialog's "오픈 전에 정할 항목" and the 오픈 기록.
 *
 *   openItems(db, projectId)        what RELAI knows is unfinished: 열린 이슈 · 최근 결과 실패 테스트 · 승인 후 미반영 변경 요청 · 미완료 검수(요청·보완)
 *   recordGoLive(db, project, body, userId)
 *       every open item needs a 운영 이관 memo (else 422 undecided_items — the server recomputes the list, the client's copy is not trusted);
 *       오픈일 ≤ today (Korea time). One transaction: project_definitions.go_live + GO_LIVE 완료 + the latest '오픈' milestone 완료 (실적일 = 오픈일).
 *
 * 운영 이관 is a one-line memo carried into 07 (count + list), never a ticket: no owner, no due date, no workflow.
 */
import { ValidationError } from './validate.js';
import { todayKst } from '../public/app/shared/kst-date.js';
import { updateStep } from './guide.js';
import { updateWbs } from './wbs.js';
import { ensureRow } from './definition.js';

const now = () => new Date().toISOString();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const CARRYOVER_TYPES = ['ISSUE', 'TEST', 'CR', 'ACCEPTANCE'];
export const CARRYOVER_LABEL = { ISSUE: '이슈', TEST: '테스트', CR: '변경 요청', ACCEPTANCE: '검수' };
const NOTE_MAX = 200;

const parse = (v) => { try { const x = JSON.parse(v || '{}'); return x && typeof x === 'object' ? x : {}; } catch { return {}; } };
/** The stored 오픈 기록 ({} before go-live). */
export async function goLiveOf(db, projectId) {
  const r = await db.get('SELECT go_live FROM project_definitions WHERE project_id = ?', [projectId]);
  const g = parse(r && r.go_live);
  return g.date ? { date: g.date, carryovers: Array.isArray(g.carryovers) ? g.carryovers : [], by: g.by || null, by_name: g.by_name || '', at: g.at || null } : null;
}

const LAST = `(SELECT result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;
export async function openItems(db, projectId) {
  const q = async (type, sql, detail) => (await db.all(sql, [projectId])).map((r) => ({ type, type_label: CARRYOVER_LABEL[type], id: r.id, display_id: r.display_id, title: r.title, detail: detail(r) }));
  return [
    ...(await q('ISSUE', `SELECT id, display_id, title, status FROM issues WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED') ORDER BY sequence_number`, () => '열린 이슈')),
    ...(await q('TEST', `SELECT t.id, t.display_id, t.title FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL AND ${LAST} = 'FAIL' ORDER BY t.sequence_number`, () => '최근 결과 실패')),
    ...(await q('CR', `SELECT id, display_id, title FROM change_requests WHERE project_id = ? AND archived_at IS NULL AND status = 'APPROVED' ORDER BY sequence_number`, () => '승인 후 미반영')),
    ...(await q('ACCEPTANCE', `SELECT id, display_id, title, status FROM acceptances WHERE project_id = ? AND archived_at IS NULL AND status IN ('REQUESTED','REWORK_REQUIRED') ORDER BY sequence_number`, (r) => (r.status === 'REQUESTED' ? '검수 요청 중' : '보완 필요'))),
  ];
}
/** 06 체크리스트 items not done yet (warn line only — no decision needed). */
export async function openChecklistItems(db, projectId) {
  const r = await db.get(`SELECT COUNT(*) AS n FROM activity_checklist_items i JOIN project_steps s ON s.id = i.step_id JOIN project_phases p ON p.id = s.project_phase_id
    WHERE i.project_id = ? AND p.phase_key = 'TRANSITION_GO_LIVE' AND NOT i.done`, [projectId]);
  return Number(r.n) || 0;
}
export const goLiveStep = (db, projectId) => db.get(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = 'TRANSITION_GO_LIVE' AND s.step_key = 'GO_LIVE'`, [projectId]);

/** WBS '오픈' milestone: title '오픈' (Phase 3 뼈대 · 01 주요 일정) or tagged TRANSITION_GO_LIVE — the latest one. */
export const goLiveMilestone = (db, projectId) => db.get(`SELECT * FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND item_type = 'MILESTONE'
  AND (btrim(title) = '오픈' OR lifecycle_phase = 'TRANSITION_GO_LIVE') ORDER BY milestone_date DESC NULLS LAST, created_at DESC LIMIT 1`, [projectId]);

const err422 = (code, message, fields) => { const e = new ValidationError(fields); e.status = 422; e.code = code; e.message = message; return e; };

export async function recordGoLive(db, project, body = {}, userId) {
  const today = todayKst();
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!isDate(date)) throw err422('invalid_go_live_date', '오픈일을 입력하세요.', { date: '오픈일을 입력하세요.' });
  if (date > today) throw err422('invalid_go_live_date', '오픈일은 오늘 이후 날짜로 정할 수 없습니다.', { date: '오픈일은 오늘 이후 날짜로 정할 수 없습니다.' });
  const step = await goLiveStep(db, project.id);
  if (!step) return { error: 'not_found' };
  if (step.status === 'COMPLETED') return { error: 'already_live' };
  const given = new Map((Array.isArray(body.carryovers) ? body.carryovers : []).filter((c) => c && CARRYOVER_TYPES.includes(c.type))
    .map((c) => [`${c.type}:${c.id}`, typeof c.note === 'string' ? c.note.trim() : '']));
  const items = await openItems(db, project.id);
  const undecided = items.filter((it) => !given.get(`${it.type}:${it.id}`));
  if (undecided.length) throw err422('undecided_items', `오픈 전에 정할 항목 ${undecided.length}건이 남아 있습니다. 처리하거나 운영 이관 메모를 남기세요.`, { items: undecided.map((x) => x.display_id).join(', ') });
  const long = items.find((it) => given.get(`${it.type}:${it.id}`).length > NOTE_MAX);
  if (long) throw new ValidationError({ items: `${long.display_id} 메모는 ${NOTE_MAX}자 이내로 입력해 주세요.` });
  const ts = now();
  const carryovers = items.map((it) => ({ type: it.type, id: it.id, display_id: it.display_id, title: it.title, note: given.get(`${it.type}:${it.id}`) }));
  const by_name = (await db.get('SELECT name FROM users WHERE id = ?', [userId]))?.name || '';
  const record = { date, carryovers, by: userId, by_name, at: ts };
  await ensureRow(db, project.id, userId);
  await db.run('UPDATE project_definitions SET go_live = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify(record), ts, project.id]);
  await updateStep(db, project, step.id, { status: 'COMPLETED' }, userId);
  const ms = await goLiveMilestone(db, project.id);
  if (ms) await updateWbs(db, project, ms, { status: 'COMPLETED', actual_end_date: date }, userId);
  return { ok: true, go_live: record, milestone: ms ? { id: ms.id, title: ms.title } : null };
}

/** { 'ISSUE:<id>': note, … } — the grey `운영 이관` tag on issue / test / CR / 검수 lists and drawers. */
export const carryoverIndex = (gl) => Object.fromEntries((gl ? gl.carryovers : []).map((c) => [`${c.type}:${c.id}`, c.note]));
