// Section-4 fault scenarios against a local 2-instance cluster whose DB traffic goes through faultproxy.mjs.
// Prereqs (started by faults.sh): faultproxy :55491→:55490 (ctl :55492), mock OpenAI :4199, cluster LB :4100, DB role app.
// Prints one JSON line per probe; OUT/faults.json gets everything.  OUT=… node scripts/load/faults.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import pg from 'pg';
const OUT = process.env.OUT || '.'; const LB = `http://127.0.0.1:${process.env.LB_PORT || 4100}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (q) => fetch(`http://127.0.0.1:55492${q}`).then((r) => r.json());
const ai = (m) => fetch(`http://127.0.0.1:4199/__mode?m=${m}`).then((r) => r.text());
const psql = (sql) => execFileSync('docker', ['exec', 'relai-neonsim', 'psql', '-U', 'postgres', '-d', 'relai_fault', '-Atc', sql]).toString().trim();
const rows = []; let cookie = ''; let scenario = '';
async function probe(label, method, path, body, timeout = 70_000) {
  const t0 = performance.now(); let status = 0, j = null, err = null, rid = null;
  try {
    const r = await fetch(LB + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    status = r.status; rid = r.headers.get('x-request-id'); for (const c of r.headers.getSetCookie()) if (/sid=/.test(c)) cookie = c.split(';')[0];
    const t = await r.text(); try { j = JSON.parse(t); } catch { j = t.slice(0, 120); }
  } catch (e) { err = e.name === 'TimeoutError' ? 'client-timeout' : e.message; }
  const row = { scenario, label, method, path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status, ms: Math.round(performance.now() - t0), code: j?.error?.code, message: j?.error?.message || (typeof j === 'string' ? j : undefined), request_id: rid || j?.error?.request_id || null, err };
  rows.push(row); console.log(JSON.stringify(row)); return { status, j, row };
}
const recover = async (label, path) => { const t0 = Date.now(); for (let i = 0; i < 60; i++) { const r = await probe(`${label} (recovery try ${i + 1})`, 'GET', path, null, 20_000); if (r.status === 200) return Date.now() - t0; await sleep(1000); } return null; };

const email = `fault${Date.now()}@relai.test`; const PW = 'FaultTest!2026';
scenario = 'setup';
let r = await probe('signup', 'POST', '/api/auth/signup', { name: '장애', email, password: PW, agree_terms: true, agree_privacy: true });
const wid = r.j.workspaces[0].workspace_id || r.j.workspaces[0].id; const W = `/api/workspaces/${wid}`;
r = await probe('home', 'GET', `${W}/projects/home`); const pid = (r.j.projects || r.j.items).find((p) => p.status === 'ACTIVE').id; const P = `${W}/projects/${pid}`;
const HOME = `${W}/projects/home`;
const recov = {};

scenario = 'S1 DB connection refused (runtime)';
await ctl('/mode?m=refuse'); await ctl('/kill'); await sleep(300);
await probe('home', 'GET', HOME); await probe('req create', 'POST', `${P}/requirements`, { title: 'DB 장애 중 저장', type: 'FUNCTIONAL', priority: 'MEDIUM' }); await probe('health', 'GET', '/health');
await ctl('/mode?m=normal'); recov.S1 = await recover('home', HOME);
const lost = psql(`select count(*) from requirements where title = 'DB 장애 중 저장'`); rows.push({ scenario, label: 'rows saved during outage (expect 0, user saw an error)', value: lost }); console.log('saved during outage', lost);

scenario = 'S2 DB not answering (blackhole)';
await ctl('/mode?m=blackhole'); await ctl('/kill'); await sleep(300);
await probe('home', 'GET', HOME); await probe('health', 'GET', '/health');
await ctl('/mode?m=normal'); await ctl('/kill'); recov.S2 = await recover('home', HOME);

scenario = 'S3 slow DB (+1.5 s per round trip)';
await ctl('/mode?m=delay&ms=1500'); await ctl('/kill'); await sleep(300);
await probe('home', 'GET', HOME);
await Promise.all([1, 2, 3, 4, 5, 6].map((i) => probe(`project open parallel ${i}`, 'GET', `${P}/${['snapshot', 'dashboard', 'attention', 'guidance', 'health/variance', 'wbs'][i - 1]}`)));
await ctl('/mode?m=normal'); await ctl('/kill'); recov.S3 = await recover('home', HOME);

scenario = 'S4 server-side connection kill (Neon restart/suspend)';
await probe('home warm', 'GET', HOME);
psql(`select count(pg_terminate_backend(pid)) from pg_stat_activity where usename='app'`);
await probe('home right after kill', 'GET', HOME); await probe('home again', 'GET', HOME);

scenario = 'S5 connection slots exhausted (53300)';
await ctl('/kill'); await sleep(300); psql(`select count(pg_terminate_backend(pid)) from pg_stat_activity where usename='app'`); await sleep(300);   // free the app's own slots first, then take every slot
const hogs = []; for (let i = 0; i < 120; i++) { const c = new pg.Client({ connectionString: 'postgres://hog:sim@127.0.0.1:55490/relai_fault' }); try { await c.connect(); hogs.push(c); } catch { break; } }
rows.push({ scenario, label: 'hog connections held', value: hogs.length, dbMem: execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', 'relai-neonsim']).toString().trim() }); console.log('hogs', hogs.length);
await ctl('/kill'); await sleep(300);
await probe('home', 'GET', HOME); await probe('req create', 'POST', `${P}/requirements`, { title: '슬롯 부족 중 저장', type: 'FUNCTIONAL', priority: 'MEDIUM' }); await probe('health', 'GET', '/health');
for (const c of hogs) await c.end().catch(() => {});
recov.S5 = await recover('home', HOME);

scenario = 'S6 AI provider failures';
const credits = async () => (await probe('credits', 'GET', `${W}/credits/summary`)).j;
const before = await credits();
for (const m of ['500', '429', '401', 'garbage', 'hang']) { await ai(m); await probe(`ai ask (provider ${m})`, 'POST', `${P}/ai/ask`, { question: '현재 프로젝트 위험은?' }); }
await ai('ok'); await probe('ai ask (provider ok)', 'POST', `${P}/ai/ask`, { question: '현재 프로젝트 위험은?' });
const after = await credits();
rows.push({ scenario, label: 'credits before/after (5 failures + 1 success)', value: { before, after } }); console.log('credits', JSON.stringify(before).slice(0, 200), JSON.stringify(after).slice(0, 200));
rows.push({ scenario, label: 'ai_runs rows', value: psql(`select status||' '||coalesce(error_code,'')||' '||left(coalesce(error_message,''),60) from ai_runs order by created_at`) });
await probe('home during/after AI failures', 'GET', HOME);

scenario = 'S7 cold boot while DB is down';
rows.push({ scenario, label: 'see faults.sh (restart cluster with proxy refusing)' });
writeFileSync(`${OUT}/faults.json`, JSON.stringify({ rows, recov }, null, 1));
console.log('recovery ms', JSON.stringify(recov));
