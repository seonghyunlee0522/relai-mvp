/**
 * 07 운영 및 유지보수 (Phase 7) — 운영 인수 · 운영 이관 담당 · 프로젝트 종료 / 종료 취소 · 앞 단계 미완료 필수 요약.
 *
 *   handoverOf(db, projectId)                 the stored 운영 인수 {receiver_user_id | receiver_stakeholder_id, date, by, by_name, at} or null
 *   recordHandover(db, project, body, uid)    인수자* · 인수일* (≤ today KST) · every 운영 이관 item's 운영 담당* ('u:' · 's:' · 'TBD' = 미정)
 *                                             → 422 handover_required / invalid_handover_date / owner_required; HANDOVER 완료 in the same transaction
 *   saveCarryoverOwners(db, project, owners)  운영 담당 only (go_live.carryovers[i].owner_*), no completion — the `담당 지정` path before 인수
 *   closeProject / reopenProject              projects.status COMPLETED ↔ ACTIVE + closed_on / warranty_end_on; history row in phase_transitions
 *   priorGaps(phases)                         REQUIRED activities still open in the phases before 07 — the 06→07 dialog line and 완료보고서 6절
 *
 * Nothing here is a ticket: 운영 이관 items get an owner only (no due date, no workflow). A closed project is never locked.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError, isDate } from './validate.js';
import { todayKst } from '../public/app/shared/kst-date.js';
import { updateStep } from './guide.js';
import { ensureRow } from './definition.js';
import { goLiveOf } from './golive.js';

const now = () => new Date().toISOString();
const parse = (v) => { try { const x = JSON.parse(v || '{}'); return x && typeof x === 'object' ? x : {}; } catch { return {}; } };
const err422 = (code, message, fields) => { const e = new ValidationError(fields); e.status = 422; e.code = code; e.message = message; return e; };
const ORG_LABEL = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
export const TBD = 'TBD';

/** '2026-10-30' + 12 months → '2027-10-30' (month-end clamps: 02-29 → 02-28). */
export function addMonths(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const stakeholdersOf = async (db, projectId) => { const r = await db.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [projectId]); try { const v = r ? JSON.parse(r.stakeholders) : []; return Array.isArray(v) ? v : []; } catch { return []; } };
/** 'u:<id>' · 's:<id>' · 'TBD' → { owner_user_id } | { owner_stakeholder_id } | { owner_tbd } ; anything else → null. */
const refOf = (v) => (typeof v !== 'string' ? null : v === TBD ? { kind: 'TBD' } : /^u:.+/.test(v) ? { kind: 'u', id: v.slice(2) } : /^s:.+/.test(v) ? { kind: 's', id: v.slice(2) } : null);
async function refValid(db, project, ref, sh) {
  if (ref.kind === 'TBD') return true;
  if (ref.kind === 'u') return Boolean(await db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [project.workspace_id, ref.id]));
  return sh.some((x) => x.id === ref.id && x.name);
}
/** Display name of a person reference: RELAI 사용자 name, or 이해관계자 "이름(고객사)". */
async function personName(db, userId, stakeholderId, sh) {
  if (userId) return (await db.get('SELECT name FROM users WHERE id = ?', [userId]))?.name || '(알 수 없는 사용자)';
  if (stakeholderId) { const x = sh.find((v) => v.id === stakeholderId); return x ? `${x.name}${ORG_LABEL[x.org_type] ? `(${ORG_LABEL[x.org_type]})` : ''}` : '(삭제된 담당자)'; }
  return '';
}

export async function handoverOf(db, projectId) {
  const r = await db.get('SELECT handover FROM project_definitions WHERE project_id = ?', [projectId]);
  const h = parse(r && r.handover);
  if (!h.date) return null;
  const sh = await stakeholdersOf(db, projectId);
  return { ...h, receiver_name: await personName(db, h.receiver_user_id, h.receiver_stakeholder_id, sh),
    receiver_ref: h.receiver_user_id ? `u:${h.receiver_user_id}` : h.receiver_stakeholder_id ? `s:${h.receiver_stakeholder_id}` : '' };
}

/** go_live.carryovers with each 운영 담당 resolved: owner_ref ('u:'·'s:'·'TBD'·''), owner_name ('미정' for TBD). */
export async function carryoversView(db, projectId, gl = undefined) {
  const g = gl === undefined ? await goLiveOf(db, projectId) : gl;
  if (!g) return [];
  const sh = await stakeholdersOf(db, projectId);
  const out = [];
  for (const c of g.carryovers) {
    const ref = c.owner_user_id ? `u:${c.owner_user_id}` : c.owner_stakeholder_id ? `s:${c.owner_stakeholder_id}` : c.owner_tbd ? TBD : '';
    out.push({ ...c, owner_ref: ref, owner_name: ref === TBD ? '미정' : ref ? await personName(db, c.owner_user_id, c.owner_stakeholder_id, sh) : '' });
  }
  return out;
}
/** "운영 이관 N건 · 담당 지정 M/N" numbers: assigned = a person (미정 and 미지정 are not assigned). */
export const ownerCounts = (list) => ({ total: list.length, assigned: list.filter((c) => c.owner_user_id || c.owner_stakeholder_id).length, tbd: list.filter((c) => c.owner_tbd && !c.owner_user_id && !c.owner_stakeholder_id).length });

/** Apply { 'TYPE:id': ref } to the stored go_live JSON. `requireAll` → every carryover needs a value (미정 allowed) else 422 owner_required. */
async function applyOwners(db, project, owners, { requireAll }) {
  const r = await db.get('SELECT go_live FROM project_definitions WHERE project_id = ?', [project.id]);
  const gl = parse(r && r.go_live);
  const list = Array.isArray(gl.carryovers) ? gl.carryovers : [];
  const given = new Map((Array.isArray(owners) ? owners : []).filter((o) => o && o.type && o.id).map((o) => [`${o.type}:${o.id}`, o.owner]));
  const sh = await stakeholdersOf(db, project.id);
  const missing = [];
  for (const c of list) {
    const k = `${c.type}:${c.id}`;
    if (!given.has(k)) { if (requireAll && !c.owner_user_id && !c.owner_stakeholder_id && !c.owner_tbd) missing.push(c.display_id); continue; }
    const v = given.get(k);
    if (v === '' || v === null || v === undefined) { if (requireAll) missing.push(c.display_id); else { delete c.owner_user_id; delete c.owner_stakeholder_id; delete c.owner_tbd; } continue; }
    const ref = refOf(v);
    if (!ref || !(await refValid(db, project, ref, sh))) throw new ValidationError({ owners: `${c.display_id} 운영 담당은 이 Workspace 멤버나 01 이해관계자 중에서 고르거나 미정으로 두세요.` });
    delete c.owner_user_id; delete c.owner_stakeholder_id; delete c.owner_tbd;
    if (ref.kind === 'u') c.owner_user_id = ref.id; else if (ref.kind === 's') c.owner_stakeholder_id = ref.id; else c.owner_tbd = true;
  }
  if (missing.length) throw err422('owner_required', `운영 이관 항목 ${missing.length}건의 운영 담당을 고르세요. 아직 정해지지 않았다면 미정을 고르세요.`, { owners: missing.join(', ') });
  if (list.length) await db.run('UPDATE project_definitions SET go_live = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify({ ...gl, carryovers: list }), now(), project.id]);
  return list;
}

export async function saveCarryoverOwners(db, project, owners) {
  if (!(await goLiveOf(db, project.id))) return { error: 'no_go_live' };
  const list = await applyOwners(db, project, owners, { requireAll: false });
  return { ok: true, counts: ownerCounts(list) };
}

export const handoverStep = (db, projectId) => db.get(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = 'OPERATIONS' AND s.step_key = 'HANDOVER'`, [projectId]);
export const closeStep = (db, projectId) => db.get(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = 'OPERATIONS' AND s.step_key = 'CLOSE'`, [projectId]);

export async function recordHandover(db, project, body = {}, userId) {
  const b = body && typeof body === 'object' ? body : {};
  const f = {};
  const ref = refOf(b.receiver);
  if (!ref || ref.kind === 'TBD') f.receiver = '인수자를 고르세요.';
  const date = typeof b.date === 'string' ? b.date.trim() : '';
  if (!isDate(date)) f.date = '인수일을 입력하세요.';
  if (Object.keys(f).length) throw err422('handover_required', '인수자와 인수일을 입력해야 운영 인수를 완료할 수 있습니다.', f);
  if (date > todayKst()) throw err422('invalid_handover_date', '인수일은 오늘 이후 날짜로 정할 수 없습니다.', { date: '인수일은 오늘 이후 날짜로 정할 수 없습니다.' });
  const sh = await stakeholdersOf(db, project.id);
  if (!(await refValid(db, project, ref, sh))) throw err422('handover_required', '인수자는 이 Workspace 멤버나 01 이해관계자 중에서 고르세요.', { receiver: '인수자는 이 Workspace 멤버나 01 이해관계자 중에서 고르세요.' });
  const step = await handoverStep(db, project.id);
  if (!step) return { error: 'not_found' };
  const list = await applyOwners(db, project, b.owners, { requireAll: true });
  const ts = now();
  const by_name = (await db.get('SELECT name FROM users WHERE id = ?', [userId]))?.name || '';
  const record = { ...(ref.kind === 'u' ? { receiver_user_id: ref.id } : { receiver_stakeholder_id: ref.id }), date, by: userId, by_name, at: ts };
  await ensureRow(db, project.id, userId);
  await db.run('UPDATE project_definitions SET handover = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify(record), ts, project.id]);
  await updateStep(db, project, step.id, { status: 'COMPLETED' }, userId);
  return { ok: true, handover: await handoverOf(db, project.id), counts: ownerCounts(list) };
}

/** 07 필수 업무 (HANDOVER · CLOSE …) all done — the only state in which 프로젝트 종료 is allowed. `ops` = the resolved 07 phase from loadGuide. */
export const closeGateMet = (ops) => Boolean(ops && ops.summary && ops.summary.gate_met);

export async function closeProject(db, project, body = {}, userId, ops) {
  const b = body && typeof body === 'object' ? body : {};
  if (project.status === 'COMPLETED') return { error: 'already_closed' };
  if (!closeGateMet(ops)) return { error: 'gate' };
  const today = todayKst();
  const closed = typeof b.closed_on === 'string' && b.closed_on.trim() ? b.closed_on.trim() : today;
  if (!isDate(closed)) throw err422('invalid_closed_on', '종료일을 입력하세요.', { closed_on: '종료일을 입력하세요.' });
  if (closed > today) throw err422('invalid_closed_on', '종료일은 오늘 이후 날짜로 정할 수 없습니다.', { closed_on: '종료일은 오늘 이후 날짜로 정할 수 없습니다.' });
  let warranty = typeof b.warranty_end_on === 'string' ? b.warranty_end_on.trim() : '';
  if (b.warranty_end_on === undefined) warranty = addMonths(closed, 12);   // omitted → 종료일 + 12개월; '' / null = 하자보수 없음
  if (warranty && !isDate(warranty)) throw err422('invalid_warranty_end_on', '하자보수 종료일을 확인하세요.', { warranty_end_on: '하자보수 종료일을 확인하세요.' });
  if (warranty && warranty < closed) throw err422('invalid_warranty_end_on', '하자보수 종료일은 종료일보다 앞설 수 없습니다.', { warranty_end_on: '하자보수 종료일은 종료일보다 앞설 수 없습니다.' });
  const ts = now();
  await db.run(`UPDATE projects SET status = 'COMPLETED', closed_on = ?, warranty_end_on = ?, updated_at = ? WHERE id = ?`, [closed, warranty || null, ts, project.id]);
  await logEvent(db, project, 'PROJECT_CLOSED', userId, ts);
  return { ok: true, closed_on: closed, warranty_end_on: warranty || null };
}

export async function reopenProject(db, project, userId) {
  if (project.status !== 'COMPLETED') return { error: 'not_closed' };
  const ts = now();
  await db.run(`UPDATE projects SET status = 'ACTIVE', closed_on = NULL, warranty_end_on = NULL, updated_at = ? WHERE id = ?`, [ts, project.id]);
  await logEvent(db, project, 'PROJECT_REOPENED', userId, ts);
  return { ok: true };
}
/** 이력: a phase_transitions row on the current phase (from = to) with the event as reason — the activity feed words it. */
async function logEvent(db, project, reason, userId, ts) {
  const ph = await db.get('SELECT id FROM project_phases WHERE project_id = ? AND phase_key = ?', [project.id, project.current_phase]);
  if (ph) await db.run('INSERT INTO phase_transitions (id, project_id, from_phase_id, to_phase_id, reason, changed_by, changed_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), project.id, ph.id, ph.id, reason, userId, ts]);
}
export const EVENT_REASONS = new Set(['PROJECT_CLOSED', 'PROJECT_REOPENED']);

/** US-6: REQUIRED activities still open in every phase before 07 (resolved phases from loadGuide). */
export function priorGaps(phases, beforeKey = 'OPERATIONS') {
  const stop = (phases || []).find((p) => p.phase_key === beforeKey);
  if (!stop) return [];
  const out = [];
  for (const p of phases) {
    if (p.sequence >= stop.sequence) continue;
    for (const a of p.steps || []) if (a.importance === 'REQUIRED' && a.state !== 'COMPLETED' && a.state !== 'SKIPPED') out.push({ phase_key: p.phase_key, sequence: p.sequence, phase_name: p.name, step_key: a.step_key, title: a.title, href: a.cta ? a.cta.href : null });
  }
  return out;
}
const no2 = (n) => String(n).padStart(2, '0');
/** One label per phase: its activity title when one is open, "01 착수 5건" when several. */
export function gapGroups(gaps) {
  const by = new Map();
  for (const g of gaps) { if (!by.has(g.sequence)) by.set(g.sequence, []); by.get(g.sequence).push(g); }
  return [...by.entries()].map(([seq, list]) => ({ sequence: seq, label: list.length === 1 ? `${no2(seq)} ${list[0].title}` : `${no2(seq)} ${list[0].phase_name} ${list.length}건`, href: list[0].href }));
}
/** "앞 단계 미완료 필수 업무 3건 (02 요구사항 기준선 승인(고객) · 04 구현 2건)" — '' when none. The 06→07 dialog uses the same words. */
export const priorGapsText = (gaps) => (gaps.length ? `앞 단계 미완료 필수 업무 ${gaps.length}건 (${gapGroups(gaps).map((x) => x.label).join(' · ')})` : '');
