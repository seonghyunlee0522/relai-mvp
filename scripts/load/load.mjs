// Realistic RELAI user load: each virtual user logs in, opens home, opens a project, does requirement CRUD and a WBS save,
// with 1–3 s think time between screens. Records every API call's latency/status to OUT/req.jsonl and prints p50/p95/errors.
//   BASE=http://127.0.0.1:4100 VUS=30 DURATION=300 OUT=… node scripts/load/load.mjs
import { appendFileSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:4100';
const VUS = Number(process.env.VUS || 10), DURATION = Number(process.env.DURATION || 300) * 1000, OUT = process.env.OUT || '.';
const PW = 'LoadTest!2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(1000 + Math.random() * 2000);
const lines = [];
async function call(vu, step, method, path, body) {
  const t0 = performance.now(); let status = 0, json = null, err = null;
  try {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie: vu.cookie || '', 'x-forwarded-for': `10.0.${Math.floor(vu.n / 250)}.${vu.n % 250 + 1}` },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65_000) });
    status = r.status; const sc = r.headers.getSetCookie?.() || []; for (const c of sc) if (/sid=/.test(c)) vu.cookie = c.split(';')[0];
    const txt = await r.text(); try { json = JSON.parse(txt); } catch { json = null; }
  } catch (e) { err = e.name === 'TimeoutError' ? 'timeout' : e.code || e.message; }
  const ms = performance.now() - t0;
  lines.push(JSON.stringify({ t: Date.now(), vu: vu.n, step, method, path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status, ms: Math.round(ms), err }));
  if (lines.length > 200) appendFileSync(`${OUT}/req.jsonl`, lines.splice(0).join('\n') + '\n');
  return { status, json, err };
}
async function ensureUser(vu) {
  vu.email = `load${vu.n}@relai.test`;
  const r = await call(vu, 'seed', 'POST', '/api/auth/signup', { name: `부하${vu.n}`, email: vu.email, password: PW, terms: true, privacy: true, agree_terms: true, agree_privacy: true, consent_terms: true, consent_privacy: true });
  if (r.status !== 201 && r.status !== 409) throw new Error(`signup ${vu.n}: ${r.status} ${JSON.stringify(r.json)}`);
}
async function login(vu) {
  vu.cookie = '';
  const r = await call(vu, 'login', 'POST', '/api/auth/login', { email: vu.email, password: PW });
  if (r.status !== 200) return false;
  vu.wid = r.json.workspaces[0].workspace_id || r.json.workspaces[0].id;
  return true;
}
async function iteration(vu, i) {
  if (!vu.cookie || i % 5 === 0) { if (!(await login(vu))) return; await think(); }
  const W = `/api/workspaces/${vu.wid}`;
  // home
  await call(vu, 'home', 'GET', '/api/me');
  const home = await call(vu, 'home', 'GET', `${W}/projects/home`);
  await call(vu, 'home', 'GET', `${W}/credits/summary`);
  const projects = home.json?.projects || home.json?.items || [];
  if (!vu.pid) { const p = projects.find((x) => x.status === 'ACTIVE') || projects[0]; vu.pid = p?.id; }
  if (!vu.pid) return;
  await think();
  const P = `${W}/projects/${vu.pid}`;
  // project open
  await Promise.all([call(vu, 'project', 'GET', P), call(vu, 'project', 'GET', `${P}/snapshot`), call(vu, 'project', 'GET', `${P}/dashboard`), call(vu, 'project', 'GET', `${P}/attention`), call(vu, 'project', 'GET', `${P}/health/variance`), call(vu, 'project', 'GET', `${P}/guidance`)]);
  await think();
  // requirements: list, create, edit, read, delete(archive)
  await Promise.all([call(vu, 'req', 'GET', P), call(vu, 'req', 'GET', `${P}/requirements`), call(vu, 'req', 'GET', `${P}/requirements/baseline`), call(vu, 'req', 'GET', `${P}/wbs`)]);
  const c = await call(vu, 'req-create', 'POST', `${P}/requirements`, { title: `부하 요구사항 ${vu.n}-${i}`, description: '부하 테스트', type: 'FUNCTIONAL', priority: 'MEDIUM' });
  const rid = c.json?.requirement?.id || c.json?.id;
  if (rid) {
    await think();
    await call(vu, 'req-update', 'PATCH', `${P}/requirements/${rid}`, { title: `부하 요구사항 ${vu.n}-${i} 수정`, description: '수정됨' });
    await call(vu, 'req-read', 'GET', `${P}/requirements/${rid}`);
    await call(vu, 'req-delete', 'POST', `${P}/requirements/${rid}/archive`, {});
  }
  await think();
  // WBS: open, add a task, save dates/progress, remove it
  const wbs = await call(vu, 'wbs', 'GET', `${P}/wbs`);
  const w = await call(vu, 'wbs-create', 'POST', `${P}/wbs`, { title: `부하 작업 ${vu.n}-${i}`, item_type: 'TASK' });
  const iid = w.json?.item?.id || w.json?.created?.id || w.json?.id;
  if (iid) {
    await think();
    await call(vu, 'wbs-save', 'PATCH', `${P}/wbs/${iid}`, { planned_start_date: '2026-11-02', planned_end_date: '2026-11-06', progress: 40 });
    await call(vu, 'wbs-delete', 'POST', `${P}/wbs/${iid}/archive`, {});
  }
  await think();
}
const vus = Array.from({ length: VUS }, (_, n) => ({ n }));
if (process.env.SEED !== '0') { for (const vu of vus) await ensureUser(vu); console.log('seeded', VUS); }
const t0 = Date.now(); const end = t0 + DURATION;
writeFileSync(`${OUT}/req.jsonl`, '');
await Promise.all(vus.map(async (vu) => { await sleep(Math.random() * 5000); let i = 0; while (Date.now() < end) { try { await iteration(vu, i++); } catch (e) { lines.push(JSON.stringify({ t: Date.now(), vu: vu.n, step: 'crash', err: e.message })); } } }));
appendFileSync(`${OUT}/req.jsonl`, lines.splice(0).join('\n') + '\n');
console.log('done in', Math.round((Date.now() - t0) / 1000), 's');
