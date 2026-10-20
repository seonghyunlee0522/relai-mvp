/**
 * AI credits — the customer page (설정 › AI 크레딧) and the operator refund (AI-credits-only billing §4–§6).
 *   GET  /api/workspaces/:wid/credits/summary           any member: balance + buckets (plan / promo / purchased), this + last month, per feature, prices, top-up rules
 *   GET  /api/workspaces/:wid/credits/ledger            any member: ?month=YYYY-MM&project=&user= → every ledger row + failed runs at 0
 *   GET  /api/workspaces/:wid/credits/ledger.csv        same rows as CSV (UTF-8 BOM, Excel opens Korean) = the monthly statement
 *   POST /api/workspaces/:wid/credits/checkout          OWNER, verified e-mail, plan PRO / TEAM (ENTERPRISE by contract): { amount } (or v2 { pack })
 *                                                       → CREDIT_TOPUP order → provider checkout; FREE → 402 AI_TOPUP_PLAN_REQUIRED, no order row
 *   POST /api/workspaces/:wid/credits/refund-request    OWNER: e-mails support (no self-serve refund in this round)
 *   GET|POST /api/billing/admin/workspaces/:wid/credit-refund   SYSTEM_ADMIN: quote | refund { credits, reason, no_fee } (+ audit)
 * Every amount is integer credits in the database; ₩ = credits × CREDIT_PRICE_KRW is computed here, never stored twice.
 */
import { requireAction, can } from '../authz.js';
import { requireVerifiedEmail } from '../auth/account-security.js';
import { writeAudit } from '../admin.js';
import { sendEmail } from '../email/service.js';
import { emailConfig } from '../email/config.js';
import { creditRefundRequestEmail } from '../email/templates.js';
import { CREDIT_PACKS, CREDIT_PRICE_KRW, LOW_BALANCE_CREDITS, PLANS, PLANS_URL, REFUND_FULL_DAYS, REFUND_FEE_PCT, PURCHASED_VALID_YEARS, TOPUP_STEP_KRW, TOPUP_MAX_KRW, splitVat } from '../plans.js';
import { FEATURE_LABEL, featureCreditCost, aiConfig } from '../ai/config.js';
import { getBalance, bucketBalances } from '../ai/credits.js';
import { effectivePlan } from './subscriptions.js';
import { OrderError, publicOrder } from './orders.js';
import { createTopupOrder, packQuote, topupEligibility, refundableCredits, refundQuoteFor, refundCredits, refundRule, TOPUP_PRESETS } from './credit-packs.js';
import { BillingError, paymentsEnabled, PAYMENTS_OFF_MESSAGE } from './provider.js';

const TZ = () => process.env.APP_TIMEZONE || 'Asia/Seoul';
const CHARGED = ['REQUIREMENT_EXTRACTION', 'WBS_GENERATION', 'CHANGE_IMPACT', 'PROJECT_QA', 'TEST_GENERATION'];
const won = (credits) => credits * CREDIT_PRICE_KRW;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
/** SQL bounds of a calendar month in the app time zone (params: month, tz, month, tz). */
const MONTH_SQL = (col) => `${col} >= ((?::text || '-01')::date)::timestamp AT TIME ZONE ? AND ${col} < (((?::text || '-01')::date) + interval '1 month')::timestamp AT TIME ZONE ?`;
const monthParams = (m) => [m, TZ(), m, TZ()];

export const KIND_LABEL = { PURCHASE: '충전', PROMOTION: '무료 크레딧', PLAN_GRANT: '플랜 월간 지급', EXPIRY: '기본 크레딧 소멸', ADMIN_GRANT: '운영자 지급', REFUND: '환불', ADJUSTMENT: '조정', AI_FAILED: '실패 (차감 없음)', AI_UNCHARGED: '차감 없음' };
const shortLabel = (f) => String(FEATURE_LABEL[f] || f || '').replace(/^AI /, '');

/** Credits used (AI_USAGE) in a month, total and per feature. */
async function monthUsage(db, wid, month) {
  const rows = await db.all(`SELECT r.feature, COUNT(*) AS runs, COALESCE(-SUM(l.amount), 0) AS credits FROM credit_ledger l LEFT JOIN ai_runs r ON r.id = l.ai_run_id
    WHERE l.workspace_id = ? AND l.type = 'AI_USAGE' AND ${MONTH_SQL('l.created_at')} GROUP BY r.feature`, [wid, ...monthParams(month)]);
  const by = CHARGED.map((f) => { const r = rows.find((x) => x.feature === f); const c = Number(r?.credits || 0); return { feature: f, label: shortLabel(f), runs: Number(r?.runs || 0), credits: c, krw: won(c) }; });
  for (const r of rows) if (!CHARGED.includes(r.feature)) by.push({ feature: r.feature, label: shortLabel(r.feature), runs: Number(r.runs), credits: Number(r.credits), krw: won(Number(r.credits)) });
  const used = by.reduce((s, x) => s + x.credits, 0);
  return { month, used, krw: won(used), by_feature: by };
}

export async function creditSummary(db, wid, { role = null, provider = null } = {}) {
  const [bal, b, plan, topup] = await Promise.all([getBalance(db, wid), bucketBalances(db, wid), effectivePlan(db, wid), topupEligibility(db, wid)]);
  const { m } = await db.get(`SELECT to_char(now() AT TIME ZONE ?, 'YYYY-MM') AS m`, [TZ()]);
  const w = await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [wid]);
  const owner = can(role, 'billing');
  return {
    credit_price_krw: CREDIT_PRICE_KRW, balance: bal.balance, balance_krw: won(bal.balance), available: bal.available, reserved: bal.reserved,
    purchased_remaining: b.purchased, free_remaining: b.total - b.purchased,
    buckets: { plan: b.plan, plan_expires_at: b.plan_expires_at, promo: b.promo, purchased: b.purchased },
    plan_monthly_credits: PLANS[plan].credits?.monthly || 0,
    topup: { allowed: topup.allowed, reason: topup.reason, step: TOPUP_STEP_KRW, min: TOPUP_STEP_KRW, max: TOPUP_MAX_KRW, presets: TOPUP_PRESETS, upgrade_url: PLANS_URL },
    low_balance_threshold: LOW_BALANCE_CREDITS, low: bal.available < LOW_BALANCE_CREDITS, empty: bal.available <= 0,
    this_month: await monthUsage(db, wid, m), last_month: await monthUsage(db, wid, prevMonth(m)),
    prices: CHARGED.map((f) => ({ feature: f, label: shortLabel(f), credits: featureCreditCost(f), krw: won(featureCreditCost(f)) })),
    packs: CREDIT_PACKS.map((p) => ({ key: p.key, credits: p.credits, amount: p.amount, ...splitVat(p.amount) })),
    starter_credits: aiConfig().trialCredits, purchased_valid_years: PURCHASED_VALID_YEARS, refund_policy: { full_days: REFUND_FULL_DAYS, fee_pct: REFUND_FEE_PCT, rule: refundRule() },
    can_buy: owner, ai_enabled: aiConfig().enabled, provider_available: Boolean(provider), payments_enabled: paymentsEnabled(), sandbox: provider?.mode === 'sandbox', refundable: owner ? await refundableCredits(db, wid) : null,
    plan, plan_label: PLANS[plan].label, early_access_until: w?.early_access_until || null,
  };
}

/** Ledger rows (+ failed / uncharged runs at 0) for the filters. Newest first. */
export async function creditLedger(db, wid, { month = null, project = null, user = null, limit = 5000 } = {}) {
  if (month && !MONTH_RE.test(month)) month = null;
  const where = []; const params = [];
  if (month) { where.push(MONTH_SQL('x.at')); params.push(...monthParams(month)); }
  if (project) { where.push('x.project_id = ?'); params.push(String(project)); }
  if (user) { where.push('x.user_id = ?'); params.push(String(user)); }
  const rows = await db.all(`SELECT x.* FROM (
      SELECT l.created_at AS at, l.seq, l.type, l.amount, l.balance_after, l.reason, l.reference_type, l.reference_id, r.feature, r.project_id, p.name AS project_name,
        COALESCE(r.user_id, l.created_by) AS user_id, u.name AS user_name, o.receipt_url, o.amount AS order_amount
      FROM credit_ledger l LEFT JOIN ai_runs r ON r.id = l.ai_run_id LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = COALESCE(r.user_id, l.created_by)
        LEFT JOIN billing_orders o ON l.type = 'PURCHASE' AND l.reference_type = 'ORDER' AND o.id = l.reference_id
      WHERE l.workspace_id = ?
      UNION ALL
      SELECT r.created_at, 0, CASE WHEN r.status = 'FAILED' THEN 'AI_FAILED' ELSE 'AI_UNCHARGED' END, 0, NULL, COALESCE(r.error_code, ''), 'AI_RUN', r.id, r.feature, r.project_id, p.name,
        r.user_id, u.name, NULL, NULL
      FROM ai_runs r LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = r.user_id
      WHERE r.workspace_id = ? AND r.credit_cost > 0 AND r.credit_status = 'RELEASED'
    ) x ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.at DESC, x.seq DESC LIMIT ${Math.min(5000, Math.max(1, Number(limit) || 5000))}`, [wid, wid, ...params]);
  const out = rows.map((r) => {
    const credits = Number(r.amount);
    const label = r.type === 'AI_USAGE' ? shortLabel(r.feature) : r.type === 'PURCHASE' ? `충전 ₩${Number(r.order_amount || won(credits)).toLocaleString('ko-KR')}`
      : r.type === 'AI_FAILED' || r.type === 'AI_UNCHARGED' ? `${shortLabel(r.feature)} · ${KIND_LABEL[r.type]}` : KIND_LABEL[r.type] || r.type;
    return { at: r.at, type: r.type, label, feature: r.feature || null, project_id: r.project_id || null, project_name: r.project_name || null, user_id: r.user_id || null,
      user_name: r.user_name || null, credits, krw: r.type === 'REFUND' ? null : won(credits), /* a refund's money (fee applied) is in its note, not credits × ₩10 */ balance_after: r.balance_after === null ? null : Number(r.balance_after), receipt_url: r.receipt_url || null,
      note: r.type === 'AI_USAGE' || r.type === 'AI_FAILED' || r.type === 'AI_UNCHARGED' ? '' : r.reason };
  });
  const used = -out.filter((r) => r.type === 'AI_USAGE').reduce((s, r) => s + r.credits, 0);
  const added = out.filter((r) => r.credits > 0).reduce((s, r) => s + r.credits, 0);
  return { rows: out, totals: { used, used_krw: won(used), added, net: out.reduce((s, r) => s + r.credits, 0), count: out.length } };
}

/** Filter choices: months with activity (app TZ), the workspace's projects and members. */
async function ledgerFilters(db, wid) {
  const months = (await db.all(`SELECT DISTINCT to_char(created_at AT TIME ZONE ?, 'YYYY-MM') AS m FROM credit_ledger WHERE workspace_id = ? ORDER BY 1 DESC LIMIT 36`, [TZ(), wid])).map((r) => r.m);
  const projects = await db.all(`SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY name`, [wid]);
  const users = await db.all(`SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name`, [wid]);
  return { months, projects, users };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const fmtAt = (d) => new Date(d).toLocaleString('sv-SE', { timeZone: TZ(), hour12: false }).slice(0, 16);
export function ledgerCsv({ rows, totals }) {
  const head = ['일시', '구분', '프로젝트', '사용자', '크레딧', '금액(원)', '잔액(크레딧)', '비고'];
  const lines = rows.map((r) => [fmtAt(r.at), r.label, r.project_name || '', r.user_name || '', r.credits, r.krw ?? '', r.balance_after ?? '', r.note || ''].map(csvCell).join(','));
  lines.push(['합계 (AI 사용)', '', '', '', -totals.used, -totals.used_krw, '', ''].map(csvCell).join(','));
  return `﻿${head.join(',')}\r\n${lines.join('\r\n')}\r\n`;
}

export function mountCreditRoutes({ app, db, guard, wrap, fail, requireAuth, provider }) {
  const c = '/api/workspaces/:wid/credits';
  const owner = [...guard, requireAction('billing')];
  const payer = [...owner, requireVerifiedEmail(fail)];
  const q = (req) => ({ month: req.query.month ? String(req.query.month) : null, project: req.query.project || null, user: req.query.user || null });

  app.get(`${c}/summary`, guard, wrap(async (req, res) => res.json({ credits: await creditSummary(db, req.params.wid, { role: req.role, provider }) })));
  app.get(`${c}/ledger`, guard, wrap(async (req, res) => res.json({ ...(await creditLedger(db, req.params.wid, q(req))), filters: await ledgerFilters(db, req.params.wid), credit_price_krw: CREDIT_PRICE_KRW })));
  app.get(`${c}/ledger.csv`, guard, wrap(async (req, res) => {
    const f = q(req);
    res.set('Content-Disposition', `attachment; filename="relai-ai-credits-${f.month && MONTH_RE.test(f.month) ? f.month : 'all'}.csv"`).type('text/csv; charset=utf-8')
      .send(ledgerCsv(await creditLedger(db, req.params.wid, f)));
  }));

  app.post(`${c}/checkout`, payer, wrap(async (req, res) => {
    if (!paymentsEnabled()) return fail(res, 409, 'payments_disabled', PAYMENTS_OFF_MESSAGE);
    if (!provider) return fail(res, 503, 'billing_unavailable', '지금은 충전할 수 없습니다.');
    // AI off server-side (no provider key / AI_ENABLED=false): credits could not be spent, so no pack is sold.
    if (!aiConfig().enabled) return fail(res, 409, 'ai_disabled', '지금은 충전할 수 없습니다.');
    // Plan gate before any order row (spec §2.2: Free cannot buy credits; ENTERPRISE only by contract).
    const elig = await topupEligibility(db, req.params.wid);
    if (!elig.allowed) {
      return fail(res, 402, 'AI_TOPUP_PLAN_REQUIRED', elig.reason === 'contract_required' ? 'Enterprise 크레딧 충전은 계약에 따라 운영자가 열어 드립니다.' : 'Pro 이상 요금제에서 AI 크레딧을 충전할 수 있습니다.',
        { plan: elig.plan, upgrade: { url: PLANS_URL } });
    }
    let order;
    try {
      const amount = req.body?.amount !== undefined ? req.body.amount : req.body?.pack !== undefined ? packQuote(req.body.pack).amount : undefined;
      order = await createTopupOrder(db, { workspaceId: req.params.wid, userId: req.user.id, provider: provider.name, amount });
    }
    catch (e) { if (e instanceof OrderError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
    const workspace = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [req.params.wid]);
    const out = await provider.createCheckout({ workspace, plan: null, order, customer: { id: req.user.id, email: req.user.email, name: req.user.name },
      successUrl: '/app/settings/credits', cancelUrl: '/app/settings/credits' });
    res.status(201).json({ checkout_url: out.checkout_url, session_id: out.session_id, provider: provider.name, order: { ...publicOrder(order), credits: order.credits } });
  }));

  app.post(`${c}/refund-request`, owner, wrap(async (req, res) => {
    const cfg = emailConfig();
    if (!cfg.supportEmail) return fail(res, 503, 'support_unconfigured', '환불 요청 메일 주소가 아직 설정되지 않았습니다. 운영자에게 직접 문의해 주세요.');
    const refundable = await refundableCredits(db, req.params.wid);
    if (refundable <= 0) return fail(res, 409, 'nothing_refundable', '환불할 수 있는 미사용 구매 크레딧이 없습니다. 무료 크레딧은 환불되지 않습니다.');
    const w = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [req.params.wid]);
    const r = await sendEmail(db, { type: 'AI_CREDIT_REFUND_REQUEST', to: cfg.supportEmail, relatedUserId: req.user.id, workspaceId: w.id,
      ...creditRefundRequestEmail({ workspaceName: w.name, workspaceId: w.id, requester: `${req.user.name} <${req.user.email}>`, refundable, note: String(req.body?.note || '').slice(0, 500) }) });
    if (r.status !== 'SENT') return fail(res, 502, 'email_failed', '환불 요청 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    res.json({ requested: true, refundable });
  }));

  const admin = (req, res) => { if (req.user.system_role !== 'SYSTEM_ADMIN') { fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.'); return false; } return true; };
  const ar = '/api/billing/admin/workspaces/:wid/credit-refund';
  app.get(ar, requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    const refundable = await refundableCredits(db, req.params.wid);
    if (!req.query.credits) return res.json({ refundable });
    try { res.json({ refundable, quote: await refundQuoteFor(db, req.params.wid, Number(req.query.credits), { noFee: req.query.no_fee === 'true' }) }); }
    catch (e) { if (e instanceof OrderError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
  }));
  app.post(ar, requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    if (!provider?.refundPartial) return fail(res, 503, 'billing_unavailable', '지금은 환불을 처리할 수 없습니다.');
    const reason = String(req.body?.reason || '').trim().slice(0, 100);
    if (!reason) return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { reason: '환불 사유를 입력해 주세요.' } });
    if (!(await db.get('SELECT id FROM workspaces WHERE id = ?', [req.params.wid]))) return fail(res, 404, 'not_found', '워크스페이스를 찾을 수 없습니다.');
    let out;
    try { out = await refundCredits(db, provider, { wid: req.params.wid, credits: Number(req.body?.credits), reason, adminUserId: req.user.id, noFee: req.body?.no_fee === true }); }
    catch (e) {
      if (e instanceof OrderError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {});
      if (e instanceof BillingError) return fail(res, e.status, e.code, e.message);
      throw e;
    }
    await writeAudit(db, { adminUserId: req.user.id, action: 'CREDIT_REFUND', targetType: 'WORKSPACE', targetId: req.params.wid,
      metadata: { reason, no_fee: req.body?.no_fee === true, credits: out.credits, amount: out.amount, orders: out.allocations.map((a) => ({ order_id: a.order_id, credits: a.credits, amount: a.amount, full: a.full, manual: a.manual })), failed: out.failed } });
    res.status(out.failed.length && !out.credits ? 502 : 200).json({ refunded: out.credits > 0, ...out, balance: (await getBalance(db, req.params.wid)).balance });
  }));
}
