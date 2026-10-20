/**
 * 정기결제 고지 · 동의 (pricing v3 T3; 전자상거래법 §13②·⑥, legal-review §1, design.md §8.4).
 *
 * The server writes the 고지 (disclosure) for every quote a customer can pay: what is charged now, what each renewal charges and
 * when, that it renews automatically, how to cancel and what is refunded. The checkout screen shows exactly these items; the
 * customer ticks the consent box and the request carries back `disclosure_hash`. Checkout recomputes the disclosure from a fresh
 * quote and refuses (400 consent_required) when the box is not ticked or the hash differs — a customer only ever consents to the
 * numbers on their screen. Every accepted consent is one append-only billing_consents row (5 years, 계약 기록).
 *
 *   disclosure(kind, q, { now, renewsAt })  → { kind, items [{ key, label, value }], text, hash, terms_version }
 *   checkConsent(body, d)                   → null | OrderError-like { status 400, code 'consent_required' }
 *   recordConsent(db, { … })                → id
 */
import { createHash, randomUUID } from 'node:crypto';
import { PLANS, CYCLES } from '../plans.js';
import { LEGAL } from '../../public/app/shared/legal-info.js';

export const CONSENT_KINDS = ['CHECKOUT', 'RECURRING', 'ADDON', 'UPGRADE', 'PRICE_INCREASE'];
export const WITHDRAWAL_DAYS = 7;
export const RETENTION_DAYS = 30;

const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const kday = (d) => new Date(d).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

export const CANCEL_TEXT = '설정 › 플랜 · 결제에서 언제든 해지할 수 있습니다(월간 · 연간 모두). 해지하면 자동 갱신이 즉시 중단되고, 이미 결제한 기간이 끝날 때까지 이용합니다.';
export const REFUND_TEXT = `결제일부터 ${WITHDRAWAL_DAYS}일 이내에는 청약철회할 수 있습니다. 해지와 함께 환불을 요청하면 남은 기간을 일할 계산해 환불하며 위약금은 없습니다(연간도 월 정상가로 다시 계산하지 않습니다). 해지 후 ${RETENTION_DAYS}일 동안 프로젝트 데이터를 조회하고 내보낼 수 있습니다.`;

/**
 * Disclosure for a quote. `kind`: CHECKOUT (new subscription: plan + add-ons), ADDON, UPGRADE, PRICE_INCREASE.
 * `q` is an orders.js quote (total, lines, plan, cycle, next_renewal_amount, next_renewal_at); for PRICE_INCREASE pass
 * { plan, cycle, old_amount, new_amount, effective_at }.
 */
export function disclosure(kind, q, { now = new Date() } = {}) {
  const plan = PLANS[q.plan]?.label || q.plan;
  const cycle = CYCLES[q.cycle]?.label || q.cycle;
  const every = q.cycle === 'ANNUAL' ? '12개월마다' : '매월';
  const items = [];
  const put = (key, label, value) => items.push({ key, label, value });
  if (kind === 'PRICE_INCREASE') {
    put('plan', '요금제', `${plan} ${cycle}`);
    put('change', '변경 금액', `${won(q.old_amount)} → ${won(q.new_amount)} (VAT 포함)`);
    put('effective_at', '적용 일시', kday(q.effective_at));
    put('method', '결제 방법', '등록한 신용카드 자동 결제');
    put('decline', '동의하지 않으면', '자동 갱신이 중단되고, 이미 결제한 기간이 끝날 때까지 이용합니다. 추가 결제는 없습니다.');
    put('cancel', '해지 방법', CANCEL_TEXT);
  } else {
    put('plan', '요금제', kind === 'UPGRADE' ? `${PLANS[q.from_plan]?.label || q.from_plan} → ${plan} (${cycle})` : `${plan} ${cycle}`);
    if (q.lines?.length) put('lines', '결제 내역', q.lines.map((l) => `${l.label}${l.qty > 1 ? ` × ${l.qty}` : ''} ${won(l.amount)}${l.days !== undefined ? ` (${l.days}/${l.period_days}일)` : ''}`).join(' · '));
    put('amount', '지금 결제 금액', `${won(q.total)} (VAT 포함)${q.waived ? ' — 최소 결제 금액 미만이라 이번에는 청구하지 않습니다' : ''}`);
    put('first_charge_at', kind === 'CHECKOUT' ? '최초 결제일' : '결제일', kday(now));
    put('cycle', '결제 주기', `${cycle} (${every} 자동 결제)`);
    put('renewal', '다음 결제 예정', `${kday(q.next_renewal_at)} · ${won(q.next_renewal_amount)} (VAT 포함)`);
    put('auto_renew', '자동 갱신', `해지하기 전까지 ${every} 같은 날 자동으로 결제됩니다. 결제 금액이 늘어나면 30일 전에 알리고 따로 동의를 받습니다.`);
    put('cancel', '해지 방법', CANCEL_TEXT);
    put('refund', '환불 기준', REFUND_TEXT);
  }
  const text = items.map((i) => `${i.label}: ${i.value}`).join('\n');
  const terms_version = LEGAL.termsVersion || 'unknown';
  return { kind, items, text, terms_version, hash: sha(`${terms_version}\n${kind}\n${text}`) };
}

const yes = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
/** null when the request carries the consent for exactly this disclosure, else the error to answer with. */
export function checkConsent(body, d) {
  if (!yes(body?.agree)) return { status: 400, code: 'consent_required', message: '결제 금액 · 자동 갱신 · 해지 · 환불 안내를 확인하고 동의해 주세요.', fields: { agree: '필수 동의 항목입니다.' } };
  if (String(body?.disclosure_hash || '') !== d.hash) return { status: 400, code: 'consent_stale', message: '결제 조건이 바뀌었습니다. 화면을 새로 고쳐 바뀐 내용을 확인한 뒤 다시 동의해 주세요.', fields: { agree: '결제 조건을 다시 확인해 주세요.' } };
  return null;
}

/** Append one consent record. `req` (optional) supplies the ip (hashed) and user agent. */
export async function recordConsent(db, { workspaceId, userId = null, orderId = null, kind, d, amount = null, renewalAmount = null, cycle = null, nextChargeAt = null, req = null }) {
  if (!CONSENT_KINDS.includes(kind)) throw new Error(`unknown consent kind ${kind}`);
  const id = randomUUID();
  await db.run(`INSERT INTO billing_consents (id, workspace_id, user_id, order_id, kind, terms_version, disclosure_hash, amount, renewal_amount, cycle, next_charge_at, ip_hash, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, workspaceId, userId, orderId, kind, d.terms_version, d.hash, amount, renewalAmount, cycle, nextChargeAt,
    req?.ip ? sha(`relai-consent:${req.ip}`) : null, req?.get ? String(req.get('user-agent') || '').slice(0, 300) || null : null]);
  return id;
}
