// TEAM monthly AI credit grant (billing/ai-grants.js): once per monthly cycle while ACTIVE, none on FREE / PAST_DUE / lapsed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { grantMonthlyCredits, grantDueMonthlyCredits } from '../billing/ai-grants.js';
import { PLANS } from '../plans.js';

const ws = async (db, id) => {
  await db.run(`INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, ['u_g', 'g@x.com', 'G']);
  await db.run(`INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, 'u_g')`, [id, id]);
};
const sub = (db, wid, { status = 'ACTIVE', startDaysAgo = 0, endDays = 330, plan = 'TEAM' } = {}) => db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, auto_renew,
  current_period_start, current_period_end, grace_period_end) VALUES (?, ?, ?, ?, 'fake', false, now() - make_interval(days => ?), now() + make_interval(days => ?), NULL)`,
  [`s_${wid}`, wid, plan, status, startDaysAgo, endDays]);
const grants = async (db, wid) => (await db.all(`SELECT amount, reference_id FROM credit_ledger WHERE workspace_id = ? AND reference_type = 'PLAN_MONTHLY' ORDER BY seq`, [wid]));

test('TEAM: one grant per monthly cycle (anchored on the period start), idempotent; FREE, PAST_DUE and lapsed get none', async () => {
  const db = await testDb();
  assert.equal(PLANS.TEAM.ai_credits_monthly, 3000); assert.equal(PLANS.FREE.ai_credits_monthly, 0);
  await ws(db, 'w_team'); await sub(db, 'w_team', { startDaysAgo: 40 });
  const g = await grantMonthlyCredits(db, 'w_team');
  assert.equal(g.amount, 3000);
  assert.equal(await grantMonthlyCredits(db, 'w_team'), null);   // same cycle → no second grant
  const cycle = new Date(Date.now() - 40 * 86400e3); cycle.setUTCMonth(cycle.getUTCMonth() + 1);
  assert.ok(Math.abs(new Date(g.cycle_start) - cycle) < 2 * 86400e3, `cycle ${g.cycle_start}`);   // 2nd month of the period

  await ws(db, 'w_free');
  await ws(db, 'w_due'); await sub(db, 'w_due', { status: 'PAST_DUE' });
  await ws(db, 'w_over'); await sub(db, 'w_over', { startDaysAgo: 400, endDays: -5 });
  for (const w of ['w_free', 'w_due', 'w_over']) assert.equal(await grantMonthlyCredits(db, w), null, w);

  // concurrent cron + payment for a new cycle → exactly one grant
  await ws(db, 'w_race'); await sub(db, 'w_race');
  await Promise.all([grantMonthlyCredits(db, 'w_race'), grantMonthlyCredits(db, 'w_race'), grantDueMonthlyCredits(db)]);
  assert.equal((await grants(db, 'w_race')).length, 1);

  // a different cycle (anchor moved 20 days, so the current cycle starts on another date): the cron grants again
  await db.run(`UPDATE subscriptions SET current_period_start = current_period_start - interval '20 days' WHERE workspace_id = 'w_team'`);
  const out = await grantDueMonthlyCredits(db);
  assert.equal(out.granted, 1);
  const tg = await grants(db, 'w_team');
  assert.equal(tg.length, 2); assert.notEqual(tg[0].reference_id, tg[1].reference_id);
  const acc = await db.get(`SELECT balance FROM workspace_credit_accounts WHERE workspace_id = 'w_team'`);
  const last = await db.get(`SELECT balance_after FROM credit_ledger WHERE workspace_id = 'w_team' ORDER BY seq DESC LIMIT 1`);
  assert.equal(Number(acc.balance), Number(last.balance_after));
});
