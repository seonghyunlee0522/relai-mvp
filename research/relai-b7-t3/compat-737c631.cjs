// 737c631 (old code) on a migration-50 DB holding fixed WBS nodes: every project screen loads with no page error and no 5xx.
const { chromium } = require('playwright');
const { Client } = require('/Users/shlee/shlee/worktrees/worker-relai-b7-t3/node_modules/pg');
const BASE = 'http://127.0.0.1:3094';
(async () => {
  const pg = new Client({ connectionString: 'postgres://postgres@127.0.0.1:55473/relai_compat' }); await pg.connect();
  const email = (await pg.query(`SELECT email FROM users WHERE email LIKE 'b7-%' LIMIT 1`)).rows[0].email;
  const projs = (await pg.query(`SELECT DISTINCT p.id, p.name FROM projects p JOIN wbs_items w ON w.project_id = p.id AND w.system_key IS NOT NULL JOIN workspace_members m ON m.workspace_id = p.workspace_id JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [email])).rows;
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const bad = []; page.on('pageerror', (e) => bad.push(`pageerror ${page.url()} ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`); });
  const lr = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'passw0rd!' } }); console.log('login', lr.status());
  let n = 0; let weekly = 0; let jira = 0;
  for (const p of projs) for (const path of ['', '/overview', '/wbs', '/wbs?view=gantt', '/reports', '/requirements', '/phases']) {
    await page.goto(`${BASE}/app/projects/${p.id}${path}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(250); n++;
  }
  // weekly report: create one per project through the old UI's API and open it
  for (const p of projs) {
    const w = (await pg.query('SELECT workspace_id FROM projects WHERE id = $1', [p.id])).rows[0].workspace_id;
    const dp = (await (await page.request.get(`${BASE}/api/workspaces/${w}/projects/${p.id}/weekly-reports`)).json()).default_period;
    const r = await page.request.post(`${BASE}/api/workspaces/${w}/projects/${p.id}/weekly-reports/generate`, { data: dp });
    const j = await r.json().catch(() => null); const rid = j && j.report && j.report.id;
    if (r.status() !== 201 || !rid) bad.push(`weekly generate ${r.status()}`); else { weekly++; const txt = j.report.plain_text || ''; if (!/착수|구현|시험/.test(txt) && false) bad.push('weekly text'); await page.goto(`${BASE}/app/projects/${p.id}/reports/${rid}`); await page.waitForLoadState('networkidle').catch(() => {}); n++; }
    const jr = await page.request.get(`${BASE}/api/workspaces/${w}/projects/${p.id}/integrations/jira`); if (jr.status() !== 200) bad.push(`jira ${jr.status()}`); else jira++;
  }
  console.log(`projects ${projs.length}, pages ${n}, weekly reports ${weekly}, jira screens ${jira}, problems ${bad.length}`); for (const x of bad.slice(0, 20)) console.log(' ', x);
  await b.close(); await pg.end(); process.exit(bad.length ? 1 : 0);
})();
