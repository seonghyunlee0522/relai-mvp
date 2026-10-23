/**
 * 샘플 프로젝트 — three filled example projects (시작 단계 · 구현 단계 · 종료 직전) so a new user sees how RELAI is used.
 *
 *   samplesEnabled()                                  SAMPLE_PROJECTS env ('false' turns signup samples off; default on)
 *   addSampleProjects(db, { workspaceId, userId, userName, keys?, today? })
 *                                                     copies snapshot.json into the workspace (one transaction); returns the new
 *                                                     projects [{ id, name, sample_key }]. Missing keys only: a sample already in
 *                                                     the workspace is not copied twice.
 *   addSamplesAfterSignup(db, …)                      the signup hook: never throws (a failed copy must not fail the signup)
 *   deleteSampleProjects(db, workspaceId, projectId?) all samples of the workspace (or one) — hard delete, cascade
 *
 * The snapshot is the app's own output (scripts/build-sample-snapshot.mjs replays server/samples/fixtures.js through the API
 * under a simulated clock), so every module is consistent by construction. Here we only re-key it: fresh ids, the user as
 * owner, and every date moved by whole weeks (weekdays and Mon–Sun report weeks stay intact) so the build day lands on the
 * latest same weekday on or before today. Samples carry projects.sample_key and are excluded from usage and plan limits.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx } from '../db.js';
import { todayKst, addDays, diffDays } from '../../public/app/shared/kst-date.js';

const here = dirname(fileURLToPath(import.meta.url));
let cached = null;
export const snapshot = () => (cached ||= JSON.parse(readFileSync(resolve(here, 'snapshot.json'), 'utf8')));
export const samplesEnabled = () => process.env.SAMPLE_PROJECTS !== 'false';
export const SAMPLE_KEYS = () => snapshot().cases.map((c) => c.key);
export const SAMPLE_BADGE = '샘플';
/** v1 P2-1: who-did-it columns of the replayed history. The build owner is not the new user, so these are copied as NULL and
 *  the feeds show SAMPLE_ACTOR for them (dashboard.js); comments get author_label = SAMPLE_ACTOR. Assignment columns
 *  (owner_user_id, performer_user_id) and the NOT NULL created_by keep the user so the samples stay workable. */
const ACTOR_COLS = new Set(['changed_by', 'completed_by', 'done_by', 'executed_by', 'reviewed_by', 'updated_by']);
export const SAMPLE_ACTOR = '샘플';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MD = /(^|[^\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g;   // '06/27' · '6/27' in report text

/** Whole weeks between the snapshot day and today (never forward: a sample never claims a date after today). */
export const weekShift = (t0, today = todayKst()) => Math.floor(diffDays(t0, today) / 7) * 7;

function rekey({ t0, owner, workspace_id: snapWs }, { workspaceId, userId, userName, delta }) {
  const ids = new Map([[owner.id, userId], [snapWs, workspaceId]]);
  const id = (v) => { if (!ids.has(v)) ids.set(v, randomUUID()); return ids.get(v); };
  const y0 = Number(t0.slice(0, 4));
  const shiftMd = (m, d, pad) => {   // year-less 'M/D': the year that puts it closest to the snapshot day
    let best = null;
    for (const y of [y0 - 1, y0, y0 + 1]) { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; const gap = Math.abs(diffDays(t0, s)); if (!best || gap < best.gap) best = { s, gap }; }
    const [, mm, dd] = addDays(best.s, delta).split('-');
    return pad ? `${mm}/${dd}` : `${Number(mm)}/${Number(dd)}`;
  };
  const text = (s) => s.replace(UUID, (u) => id(u))
    .split(owner.name).join(userName).split(owner.email).join('')
    .replace(ISO_DAY, (x) => addDays(x, delta))
    .replace(MD, (x, pre, m, d) => (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? pre + shiftMd(m, d, m.length === 2) : x));
  const value = (v, type) => {
    if (v === null || v === undefined) return null;
    if (type === 'timestamp with time zone') return new Date(Date.parse(v) + delta * 86400e3).toISOString();
    if (type === 'date') return addDays(String(v).slice(0, 10), delta);
    if (type === 'jsonb' || type === 'json') return JSON.parse(text(JSON.stringify(v)));
    if (typeof v === 'string') return text(v);
    return v;
  };
  return { value };
}

/** Copies the snapshot's projects (all, or `keys`) into `workspaceId`. Caller passes a db or a tx. */
export async function addSampleProjects(db, { workspaceId, userId, userName, keys = null, today = todayKst() }) {
  const snap = snapshot();
  const have = new Set((await db.all('SELECT sample_key FROM projects WHERE workspace_id = ? AND sample_key IS NOT NULL', [workspaceId])).map((r) => r.sample_key));
  const cases = snap.cases.filter((c) => (!keys || keys.includes(c.key)) && !have.has(c.key));
  if (!cases.length) return [];
  const keep = new Set(cases.map((c) => c.project_id));
  const keyOf = new Map(cases.map((c) => [c.project_id, c.key]));
  const delta = weekShift(snap.t0, today);
  const { value } = rekey(snap, { workspaceId, userId, userName, delta });
  // rows of the chosen projects only: tables with project_id filter directly; children follow their parent's kept ids
  const keptIds = new Set(keep);
  const created = [];
  await tx(db, async (d) => {
    for (const t of snap.tables) {
      const pc = t.columns.indexOf(t.name === 'projects' ? 'id' : 'project_id');
      const rows = t.rows.filter((r) => {
        if (pc >= 0) return keep.has(r[pc]);
        return r.some((v, i) => typeof v === 'string' && t.types[i] === 'text' && keptIds.has(v));   // e.g. project_steps → kept project_phases
      });
      if (!rows.length) continue;
      const idc = t.columns.indexOf('id'); if (idc >= 0) for (const r of rows) keptIds.add(r[idc]);
      const cols = [...t.columns]; const sk = t.name === 'projects' ? cols.indexOf('sample_key') : -1;
      let out = rows.map((r) => r.map((v, i) => (i === sk ? keyOf.get(r[t.columns.indexOf('id')]) : v === snap.owner.id && ACTOR_COLS.has(cols[i]) ? null : value(v, t.types[i]))));
      if (t.name === 'comments') {   // created_by is NOT NULL: the comment keeps the user as owner but shows SAMPLE_ACTOR (migration 44)
        const al = cols.indexOf('author_label');
        out = al >= 0 ? out.map((r) => r.map((v, i) => (i === al ? SAMPLE_ACTOR : v))) : out.map((r) => [...r, SAMPLE_ACTOR]);
        if (al < 0) cols.push('author_label');
      }
      if (t.name === 'projects') for (const r of out) created.push({ id: r[cols.indexOf('id')], name: r[cols.indexOf('name')], sample_key: r[sk] });
      const per = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < out.length; i += per) {
        const chunk = out.slice(i, i + per);
        await d.run(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(', ')}`, chunk.flat());
      }
    }
    // 요구사항 담당자 = 01 관계자 only (founder 2026-10-23): the snapshot's requirement owner (the build user → this user) becomes the
    // sample's 당사 관계자 — the person the sample's own 01 lists for our side — so samples follow the same rule as real projects.
    for (const c of created) {
      const def = await d.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [c.id]);
      let list = []; try { list = JSON.parse(def ? def.stakeholders : '[]') || []; } catch { list = []; }
      const own = list.find((x) => x && x.name && x.org_type === 'OWN') || list.find((x) => x && x.name);
      await d.run('UPDATE requirements SET owner_stakeholder_id = ?, owner_user_id = NULL WHERE project_id = ? AND owner_user_id IS NOT NULL', [own ? own.id : null, c.id]);
    }
  });
  return created;
}

/** Signup hook: the user's first workspace gets the three samples. Logged, never thrown. */
export async function addSamplesAfterSignup(db, { workspaceId, userId, userName }) {
  if (!samplesEnabled() || !workspaceId) return [];
  try { return await addSampleProjects(db, { workspaceId, userId, userName }); } catch (e) { console.error('[samples] copy failed', e.message); return []; }
}

/** Hard delete (cascade) of the workspace's samples, or one sample. Returns the number of projects removed. */
export async function deleteSampleProjects(db, workspaceId, projectId = null) {
  return tx(db, async (d) => {
    const rows = await d.all(`SELECT id FROM projects WHERE workspace_id = ? AND sample_key IS NOT NULL ${projectId ? 'AND id = ?' : ''}`, projectId ? [workspaceId, projectId] : [workspaceId]);
    if (!rows.length) return 0;
    const pids = rows.map((r) => r.id);
    // history tables keyed by entity id (no foreign key) go first
    await d.run(`DELETE FROM raid_history WHERE entity_id IN (SELECT id FROM issues WHERE project_id = ANY(?) UNION SELECT id FROM risks WHERE project_id = ANY(?))`, [pids, pids]);
    await d.run(`DELETE FROM qa_history WHERE entity_id IN (SELECT id FROM test_cases WHERE project_id = ANY(?) UNION SELECT id FROM acceptances WHERE project_id = ANY(?))`, [pids, pids]);
    await d.run('UPDATE issues SET source_risk_id = NULL WHERE project_id = ANY(?)', [pids]);
    await d.run('UPDATE wbs_items SET parent_id = NULL WHERE project_id = ANY(?)', [pids]);
    await d.run('DELETE FROM phase_transitions WHERE project_id = ANY(?)', [pids]);
    await d.run('DELETE FROM projects WHERE id = ANY(?)', [pids]);
    return pids.length;
  });
}
