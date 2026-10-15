#!/usr/bin/env node
/**
 * Builds server/samples/snapshot.json from server/samples/fixtures.js.
 *
 *   DATABASE_URL=postgres://… node scripts/build-sample-snapshot.mjs      (npm run samples:build)
 *
 * Replays every fixture event through the real HTTP API (in-process server on a throwaway PostgreSQL schema) with a
 * simulated clock: JS Date and the SQL `now()` / `CURRENT_DATE` both read the event's day, so actual dates, history rows,
 * weekly report contents, activity states and milestones come out exactly as the app would have produced them over months.
 * The project-owned rows are then dumped as-is (dates relative to the build day = snapshot.t0). server/samples/index.js
 * copies them into a workspace with fresh ids, the new owner, and every date shifted by whole weeks to the signup day.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../server/samples/snapshot.json');
process.env.PLAN_LIMITS = 'off'; process.env.EMAIL_PROVIDER ||= 'fake'; process.env.SAMPLE_PROJECTS = 'false';
process.env.AI_ENABLED = 'false';

/* ---------- simulated clock ---------- */
const RealDate = Date; const realNow = () => RealDate.now();
let offset = 0;   // virtual − real, ms
class SimDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(realNow() + offset); }
  static now() { return realNow() + offset; }
}
globalThis.Date = SimDate;
const KST = 9 * 3600e3;
const T0 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(realNow()));
const t0Ms = RealDate.parse(`${T0}T00:00:00Z`) - KST;   // T0 00:00 in Korea
const ymd = (d) => new RealDate(t0Ms + KST + d * 86400e3).toISOString().slice(0, 10);
const virtualAt = (d, t = '09:00') => { const [h, m] = t.split(':').map(Number); return t0Ms + d * 86400e3 + (h * 60 + m) * 60e3; };
const windows = [];   // [{ real, virt }] — maps any real-time stamp (column DEFAULT now()) back to the event that wrote it
const setClock = (ms) => { offset = ms - realNow(); windows.push({ real: realNow(), virt: ms }); };
const vNow = () => new RealDate(realNow() + offset);
const sqlTs = () => `'${vNow().toISOString()}'::timestamptz`;
const sqlDate = () => `'${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(vNow())}'::date`;
let simSql = false;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (q, ...rest) {
  if (simSql) {
    const swap = (s) => s.replace(/\bCURRENT_DATE\b/g, sqlDate()).replace(/\bnow\(\)/gi, sqlTs());
    if (typeof q === 'string') q = swap(q); else if (q && typeof q.text === 'string') q = { ...q, text: swap(q.text) };
  }
  return origQuery.call(this, q, ...rest);
};

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { SAMPLE_CASES } = await import('../server/samples/fixtures.js');

const OWNER_NAME = 'SAMPLEOWNERNAME'; const OWNER_EMAIL = 'sample-owner@relai.invalid'; const OWNER_PW = 'sample-build-1';
const schema = 'sample_build_' + randomUUID().replace(/-/g, '').slice(0, 10);
const db = await openDb({ schema, createSchema: true, max: 4 });
simSql = true;
const server = createApp(db).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const jar = new Map();
async function call(method, path, body, retry = true) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && retry) { await call('POST', '/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PW }, false); return call(method, path, body, false); }   // 30-day sessions vs months of simulated time
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}\nbody: ${JSON.stringify(body)}`);
  return json;
}

const firstDay = Math.min(...SAMPLE_CASES.map((c) => c.created.d));
setClock(virtualAt(firstDay - 1, '08:00'));
const signup = await call('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: OWNER_NAME, email: OWNER_EMAIL, password: OWNER_PW });
const uid = signup.user.id; const wid = signup.workspaces[0].id;
const ME = `u:${uid}`;

/** '@-18' → date, '@-18T14:00' → datetime, '#KEY' → entity id, 'me' → 'u:<owner>'; recursive. */
const resolveVal = (v, ids) => {
  if (typeof v === 'string') {
    let m = /^@([+-]?\d+)(T\d{2}:\d{2})?$/.exec(v); if (m) return ymd(Number(m[1])) + (m[2] || '');
    m = /^#(.+)$/.exec(v); if (m) { if (!ids[m[1]]) throw new Error(`unknown ref ${v}`); return ids[m[1]]; }
    return v === 'me' ? ME : v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveVal(x, ids));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveVal(x, ids)]));
  return v;
};

for (const C of SAMPLE_CASES) {
  const ids = {};
  setClock(virtualAt(C.created.d, C.created.t));
  const P = (await call('POST', `/api/workspaces/${wid}/projects`, resolveVal(C.project, ids))).project;
  const purl = `/api/workspaces/${wid}/projects/${P.id}`;
  const guide = async () => (await call('GET', purl));
  const stepId = async (path) => { const [ph, st] = path.split('.'); const G = await guide(); const s = G.phases.find((x) => x.phase_key === ph).steps.find((x) => x.step_key === st); if (!s) throw new Error(`no step ${path}`); return s.id; };
  const testOfReq = async (rid) => (await db.get(`SELECT test_case_id FROM test_links WHERE target_type = 'REQUIREMENT' AND target_id = ? ORDER BY created_at LIMIT 1`, [rid])).test_case_id;
  // checklist 'done' days become their own events so the clock stays ordered
  const events = [];
  for (const e of C.events) {
    events.push(e);
    if (e.op === 'checklist' && e.done !== undefined) events.push({ d: e.done, t: '17:30', op: 'checklistDone', step: e.step });
  }
  events.forEach((e, i) => { e._i = i; });
  events.sort((a, b) => a.d - b.d || (a.t || '09:00').localeCompare(b.t || '09:00') || a._i - b._i);
  for (const ev of events) {
    setClock(virtualAt(ev.d, ev.t));
    const e = resolveVal(ev, ids);
    switch (e.op) {
      case 'def': await call('PUT', `${purl}/definition`, e.body); break;
      case 'section': await call('POST', `${purl}/definition/sections/${e.key}/complete`, e.body || {}); break;
      case 'phase': { const G = await guide(); await call('POST', `${purl}/phases/${G.phases.find((x) => x.phase_key === e.key).id}/activate`, { reason: 'NEXT' }); break; }
      case 'req': {
        const { title, description, type, priority, scope, requester_name, requester_organization } = e;
        const r = (await call('POST', `${purl}/requirements`, { title, description, type, priority, scope, requester_name, requester_organization, owner_user_id: uid })).requirement;
        ids[e.key] = r.id;
        for (const content of e.criteria || []) await call('POST', `${purl}/requirements/${r.id}/criteria`, { content });
        break;
      }
      case 'reqPatch': { const { status } = e; await call('PATCH', `${purl}/requirements/${ids[ev.key]}`, { status }); break; }
      case 'baseline': await call('POST', `${purl}/requirements/baseline/complete`, { approval: e.approval, confirm_unconfirmed: true }); break;
      case 'wbs': {
        const body = { item_type: e.item_type || 'TASK', title: e.title, owner_user_id: uid };
        for (const k of ['planned_start_date', 'planned_end_date', 'milestone_date', 'lifecycle_phase', 'description']) if (e[k] !== undefined) body[k] = e[k];
        if (e.parent) body.parent_id = ids[e.parent];
        const out = await call('POST', `${purl}/wbs`, body); ids[e.key] = (out.item || out).id;
        for (const rk of e.reqs || []) await call('POST', `${purl}/requirements/${ids[rk]}/links`, { wbs_item_id: ids[e.key], link_type: e.link_type || 'IMPLEMENTS' });
        break;
      }
      case 'dep': await call('POST', `${purl}/wbs/${ids[ev.to]}/dependencies`, { predecessor_id: ids[ev.from] }); break;
      case 'wbsPatch': { const { op, d, t, key, _i, ...body } = e; await call('PATCH', `${purl}/wbs/${ids[key]}`, body); break; }
      case 'issue': case 'risk': {
        const seg = e.op === 'issue' ? 'issues' : 'risks';
        const { op, d, t, key, _i, links, ...body } = e;
        const out = await call('POST', `${purl}/${seg}`, { ...body, owner_user_id: uid });
        const x = out.issue || out.risk || out.item || out; ids[key] = x.id;
        for (const l of links || []) await call('POST', `${purl}/${seg}/${x.id}/links`, { target_type: l.type, target_id: ids[l.key] });
        break;
      }
      case 'issuePatch': case 'riskPatch': { const { op, d, t, key, _i, ...body } = e; await call('PATCH', `${purl}/${e.op === 'issuePatch' ? 'issues' : 'risks'}/${ids[key]}`, body); break; }
      case 'cr': {
        const { op, d, t, key, _i, reqs, wbs, ...body } = e;
        const cr = (await call('POST', `${purl}/changes`, { ...body, approver_user_id: uid })).change; ids[key] = cr.id;
        for (const r of reqs || []) await call('POST', `${purl}/changes/${cr.id}/requirements`, { requirement_id: ids[r.key], relation_type: r.relation_type });
        for (const w of wbs || []) await call('POST', `${purl}/changes/${cr.id}/impacts`, { wbs_item_id: ids[w.key], impact_type: w.impact_type, impact_note: w.impact_note });
        break;
      }
      case 'crAct': await call('POST', `${purl}/changes/${ids[ev.key]}/transition`, { action: e.action, ...(e.customer_approval ? { customer_approval: e.customer_approval } : {}) }); break;
      case 'testsFromReqs': await call('POST', `${purl}/tests/from-requirements`, {}); break;
      case 'run': {
        const tid = await testOfReq(ids[ev.req]);
        const x = (await call('POST', `${purl}/tests/${tid}/executions`, { result: e.result, actual_result: e.actual_result, performer_user_id: uid, performed_on: ymd(ev.d), resolve_issue_ids: (ev.resolve || []).map((k) => ids[k]) })).execution;
        if (ev.raise) { const out = await call('POST', `${purl}/tests/${tid}/executions/${x.id}/issue`, {}); ids[ev.raise] = (out.issue || out).id; }
        break;
      }
      case 'acc': {
        const reqIds = e.reqs === 'IN_SCOPE' ? (await db.all(`SELECT id FROM requirements WHERE project_id = ? AND scope = 'IN_SCOPE' AND archived_at IS NULL ORDER BY sequence_number`, [P.id])).map((r) => r.id) : e.reqs.map((k) => ids[k]);
        ids[e.key] = (await call('POST', `${purl}/acceptances`, { title: e.title, description: e.description, due_date: e.due_date, requirements: reqIds })).acceptance.id;
        break;
      }
      case 'accAct': await call('POST', `${purl}/acceptances/${ids[ev.key]}/transition`, { action: e.action, ...(e.customer_approval ? { customer_approval: e.customer_approval } : {}) }); break;
      case 'checklist': await call('POST', `${purl}/steps/${await stepId(e.step)}/checklist/defaults`, {}); break;
      case 'checklistDone': {
        const sid = await stepId(e.step);
        for (const it of await db.all('SELECT id FROM activity_checklist_items WHERE step_id = ? AND done = false ORDER BY sequence', [sid])) await call('PATCH', `${purl}/checklist/${it.id}`, { done: true });
        break;
      }
      case 'decision': await call('POST', `${purl}/steps/${await stepId('DEVELOPMENT.DECISIONS')}/checklist`, { title: e.title, due_date: e.due_date, owner: e.owner, done: true }); break;
      case 'step': await call('PATCH', `${purl}/steps/${await stepId(e.step)}`, { status: e.status, note: e.note }); break;
      case 'comment': await call('POST', `${purl}/${e.on === 'WBS' ? 'wbs' : 'requirements'}/${ids[ev.key]}/comments`, { body: e.body }); break;
      case 'weekly': { const day = ymd(ev.d); const dow = new RealDate(`${day}T00:00:00Z`).getUTCDay(); const start = ymd(ev.d - (dow === 0 ? 6 : dow - 1));
        const r = (await call('POST', `${purl}/weekly-reports/generate`, { period_start: start, period_end: ymd(ev.d - (dow === 0 ? 6 : dow - 1) + 6) })).report; await call('POST', `${purl}/weekly-reports/${r.id}/finalize`, {}); break; }
      case 'golive': {
        const open = (await call('GET', `${purl}/go-live`)).open_items || [];
        await call('POST', `${purl}/go-live`, { date: e.date, carryovers: open.map((x) => ({ type: x.type, id: x.id, note: e.note })) });
        break;
      }
      case 'handover': {
        const G = await guide();
        await call('POST', `${purl}/handover`, { receiver: e.receiver, date: e.date, owners: ((G.go_live && G.go_live.carryovers) || []).map((c) => ({ type: c.type, id: c.id, owner: e.owners })) });
        break;
      }
      case 'completion': {
        const r = (await call('POST', `${purl}/weekly-reports/completion`, {})).report; ids.__completion = r.id;
        await call('PATCH', `${purl}/weekly-reports/${r.id}`, { sections: [{ key: 'lessons', fields: e.lessons }] });
        break;
      }
      case 'finalizeCompletion': await call('POST', `${purl}/weekly-reports/${ids.__completion}/finalize`, {}); break;
      default: throw new Error(`unknown op ${e.op}`);
    }
  }
  C._projectId = P.id;
  console.log(`built ${C.key}: ${P.name} (${events.length} events)`);
}
simSql = false;
const buildEnd = realNow();
server.close();

/* ---------- dump the project-owned rows ---------- */
const cols = await db.all(`SELECT table_name, column_name, data_type, column_default FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, [schema]);
const fks = await db.all(`SELECT tc.table_name AS child, ccu.table_name AS parent, kcu.column_name AS col FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ?`, [schema]);
const tables = [...new Set(cols.map((c) => c.table_name))];
const owned = new Set(['projects']);
const EXTRA = ['raid_history', 'qa_history'];   // entity_id rows without a foreign key
for (let changed = true; changed;) { changed = false; for (const f of fks) if (owned.has(f.parent) && f.parent !== 'users' && !owned.has(f.child)) { owned.add(f.child); changed = true; } }
for (const t of EXTRA) owned.add(t);
// insert order: parents first (self references are ordered by row below)
const order = []; const seen = new Set();
const visit = (t) => { if (seen.has(t)) return; seen.add(t); for (const f of fks) if (f.child === t && f.parent !== t && owned.has(f.parent)) visit(f.parent); order.push(t); };
[...owned].sort().forEach(visit);
// soft links (target checked by a same-project trigger, no foreign key) and entity-keyed history go after every table they point at
const LAST = ['raid_links', 'test_links', 'acceptance_links', 'comments', 'raid_history', 'qa_history'];
order.sort((a, b) => LAST.includes(a) - LAST.includes(b));

const shiftTs = (v) => {   // a stamp written by a column DEFAULT now() during the build → the event's virtual time
  const ms = v.getTime(); if (ms < windows[0].real) return v.toISOString();
  let w = windows[0]; for (const x of windows) if (x.real <= ms) w = x;
  return new RealDate(w.virt + (ms - w.real)).toISOString();
};
const out = { t0: T0, owner: { id: uid, name: OWNER_NAME, email: OWNER_EMAIL }, workspace_id: wid, cases: SAMPLE_CASES.map((c) => ({ key: c.key, label: c.label, project_id: c._projectId })), tables: [] };
let total = 0; const leftovers = [];
for (const t of order) {
  const tc = cols.filter((c) => c.table_name === t && !(c.column_default || '').startsWith('nextval('));
  const orderBy = cols.some((c) => c.table_name === t && c.column_name === 'seq') ? 'seq' : t === 'wbs_items' ? 'depth, created_at' : cols.some((c) => c.table_name === t && c.column_name === 'created_at') ? 'created_at' : '1';
  const own = t === 'projects' ? 'id' : cols.some((c) => c.table_name === t && c.column_name === 'project_id') ? 'project_id' : null;   // e.g. credit_ledger rows of the workspace stay behind
  const rows = await db.all(`SELECT ${tc.map((c) => `"${c.column_name}"`).join(', ')} FROM "${t}" ${own ? `WHERE ${own} = ANY(?)` : ''} ORDER BY ${orderBy}`, own ? [SAMPLE_CASES.map((c) => c._projectId)] : []);
  if (!rows.length) continue;
  const types = Object.fromEntries(tc.map((c) => [c.column_name, c.data_type]));
  out.tables.push({ name: t, columns: tc.map((c) => c.column_name), types: tc.map((c) => c.data_type),
    rows: rows.map((r) => tc.map((c) => { const v = r[c.column_name]; if (v === null || v === undefined) return null; if (types[c.column_name] === 'timestamp with time zone') return shiftTs(v instanceof RealDate ? v : new RealDate(v)); if (types[c.column_name] === 'date') return typeof v === 'string' ? v.slice(0, 10) : v; return v; })) });
  total += rows.length;
}
for (const t of tables) if (!owned.has(t)) { const n = Number((await db.get(`SELECT COUNT(*) AS n FROM "${t}"`)).n); if (n) leftovers.push(`${t}:${n}`); }
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`snapshot t0=${T0} · ${out.tables.length} tables · ${total} rows → ${OUT}`);
console.log(`not copied (global/user rows): ${leftovers.join(' ')}`);
console.log(`build took ${Math.round((buildEnd - windows[0].real) / 1000)}s`);
await db.close(); await db.dropSchema();
process.exit(0);
