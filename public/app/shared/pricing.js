/**
 * Plan cards (pricing v3, design.md §8.1) — ONE renderer for the landing #pricing (server, server/legal.js), the plans page
 * (/app/billing/plans) and the workspace Billing page. Input is `catalogue()` from server/plans.js (GET …/billing → catalogue),
 * so no price is typed or computed here: every number below is a catalogue field (annual monthly-equivalent and discount are
 * derived on the server). Plain strings only — no DOM, no imports — so `server/` can import this file as is (like legal-info.js).
 *
 * Both cycles are rendered; the wrapper's data-cycle (MONTHLY default, legal-review §8.9: no pre-selected paid option) shows one.
 * In 연간 the card amount actually charged (연 288,000원) is shown at least as large as the monthly equivalent (§21의2①1).
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const krw = (v) => `${Number(v || 0).toLocaleString('ko-KR')}원`;
const num = (v) => Number(v || 0).toLocaleString('ko-KR');

const BLURB = {
  FREE: '작은 프로젝트 하나로 RELAI의 흐름을 끝까지 경험해 보세요.',
  PRO: '여러 프로젝트를 함께 운영하는 작은 팀을 위한 플랜.',
  TEAM: '여러 팀과 프로젝트를 한 워크스페이스에서 운영하는 조직을 위한 플랜.',
  ENTERPRISE: '조직 규모와 계약 조건에 맞춘 견적.',
};

/** Feature rows of one plan: [label, monthly value, annual value]. */
export function planRows(p, cat) {
  const inc = p.included || {};
  const lim = (v, unit) => (v === null || v === undefined ? '협의' : `${num(v)}${unit}`);
  const credits = p.contact_sales ? '협의' : p.credits?.monthly ? `매월 ${num(p.credits.monthly)} 크레딧` : p.credits?.once ? `최초 ${num(p.credits.once)} 크레딧 (1회)` : '-';
  const rows = [['활성 프로젝트', lim(inc.projects, '개')], ['기본 사용자', lim(inc.users, '명')], ['AI 크레딧', credits]];
  const a = p.addons;
  const out = rows.map(([k, v]) => [k, v, v]);
  if (a) {
    out.push(['추가 사용자 1명', `월 ${krw(a.user.MONTHLY)}`, `월 ${krw(a.user.monthly_equivalent)} 환산`]);
    out.push(['추가 프로젝트 1개', `월 ${krw(a.project.MONTHLY)}`, `월 ${krw(a.project.monthly_equivalent)} 환산`]);
  }
  const step = cat?.topup?.step || 10000;
  const topup = p.topup === true ? `${krw(step)} 단위` : p.topup === 'contract' ? '계약에 따름' : '불가';
  out.push(['AI 크레딧 충전', topup, topup]);
  return out;
}

/** Price block of one plan for one cycle (HTML). */
function priceHtml(p, cycle) {
  if (p.contact_sales) return '<div class="pc__p pc__p--txt">별도 견적</div><p class="pc__s">조직 규모에 맞춰 협의</p>';
  if (!p.price || (p.price.MONTHLY === 0 && p.price.ANNUAL === 0)) return '<div class="pc__p">무료</div><p class="pc__s">결제 정보 없이 시작</p>';
  if (cycle === 'MONTHLY') return `<div class="pc__p" data-amount="${p.price.MONTHLY}">${krw(p.price.MONTHLY)}<small> /월</small></div><p class="pc__s">VAT 포함 · 매월 결제</p>`;
  return `<div class="pc__p" data-amount="${p.price.ANNUAL}">연 ${krw(p.price.ANNUAL)}<small> 결제</small></div>`
    + `<p class="pc__s pc__s--eq">월 ${krw(p.price.monthly_equivalent)} 환산 · <b class="pc__save">${krw(p.price.discount)} 할인(${p.price.discount_pct}%)</b></p>`
    + `<p class="pc__s">VAT 포함 · 12개월분을 한 번에 결제</p>`;
}

/**
 * The cycle switch + 4 cards. opts:
 *   current  — plan key of this workspace (badge "현재 플랜"), optional
 *   cta(p)   — HTML of the card's button for plan p (default: none)
 *   cycle    — initial cycle (default MONTHLY)
 */
export function pricingHtml(cat, { current = null, cta = () => '', cycle = 'MONTHLY' } = {}) {
  if (!cat?.plans?.length) return '';
  const pct = cat.annual_discount_pct;
  const card = (p) => {
    const rows = planRows(p, cat);
    const li = (i) => rows.map((r) => `<li><span class="pc__k">${esc(r[0])}</span><span class="pc__v">${esc(r[i])}</span></li>`).join('');
    return `<div class="pc pc--${p.key.toLowerCase()}${current === p.key ? ' is-current' : ''}" data-plan="${p.key}">
  <div class="pc__n">${esc(p.label)}${current === p.key ? '<span class="pc__badge">현재 플랜</span>' : ''}${p.key === 'PRO' ? '<span class="pc__tag">추천</span>' : ''}</div>
  <div class="pc-m">${priceHtml(p, 'MONTHLY')}</div><div class="pc-a">${priceHtml(p, 'ANNUAL')}</div>
  <p class="pc__d">${esc(BLURB[p.key] || '')}</p>
  <ul class="pc__l pc-m">${li(1)}</ul><ul class="pc__l pc-a">${li(2)}</ul>
  <div class="pc__cta">${cta(p) || ''}</div>
</div>`;
  };
  return `<div class="pcw" data-cycle="${cycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY'}">
<div class="pc-cycle" role="radiogroup" aria-label="결제 주기">
  <button type="button" role="radio" class="pc-cycle__b" data-cycle-set="MONTHLY" aria-checked="${cycle !== 'ANNUAL'}">월간 결제</button>
  <button type="button" role="radio" class="pc-cycle__b" data-cycle-set="ANNUAL" aria-checked="${cycle === 'ANNUAL'}">연간 결제 <span class="pc-cycle__off">${pct}% 할인</span></button>
</div>
<div class="pc-grid">${cat.plans.map(card).join('\n')}</div>
<p class="pc-note">모든 금액은 부가가치세(VAT 10%) 포함 금액이며 실제 카드 결제 금액입니다. AI 크레딧 충전은 Pro·Team에서 ${krw(cat.topup?.step || 10000)} = ${num((cat.topup?.step || 10000) / (cat.credit_price_krw || 10))} 크레딧 단위로 할 수 있습니다. 연간 결제는 12개월분을 한 번에 결제하고, AI 기본 크레딧은 연간 결제에도 매월 지급됩니다. 매월 지급되는 기본 크레딧은 그 달이 끝나면 소멸하며 다음 달로 이월되지 않습니다. 한도를 넘어도 데이터는 삭제되지 않습니다. 해지·환불 기준은 <a href="/terms#billing">이용약관</a>과 <a href="/terms#recurring">정기결제 안내</a>를 확인해 주세요.</p>
</div>`;
}

/** Browser: wire the 월간/연간 switch inside `root` (switches data-cycle only; nothing is computed). */
export function bindCycleToggle(root) {
  const w = root?.querySelector?.('.pcw'); if (!w) return;
  w.querySelectorAll('[data-cycle-set]').forEach((b) => { b.onclick = () => {
    w.dataset.cycle = b.dataset.cycleSet;
    w.querySelectorAll('[data-cycle-set]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }; });
}

/** Shared CSS (landing inlines it from the server; the app has the same rules in app.css). */
export const PRICING_CSS = `.pcw[data-cycle=MONTHLY] .pc-a,.pcw[data-cycle=ANNUAL] .pc-m{display:none}
.pc-cycle{display:flex;gap:4px;width:max-content;max-width:100%;margin:0 auto 22px;padding:4px;border:1px solid var(--border,#e2e8f0);border-radius:999px;background:#fff}
.pc-cycle__b{border:0;background:transparent;border-radius:999px;padding:8px 18px;font:inherit;font-size:14.5px;font-weight:600;color:var(--text-2,#475569);cursor:pointer;min-height:40px}
.pc-cycle__b[aria-checked=true]{background:var(--navy,#0f172a);color:#fff}
.pc-cycle__off{font-size:12px;font-weight:700;color:var(--ok,#16a34a);margin-left:4px}
.pc-cycle__b[aria-checked=true] .pc-cycle__off{color:#86efac}
.pc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
@media (max-width:1100px){.pc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.pc-grid{grid-template-columns:minmax(0,1fr)}}
.pc{background:#fff;border:1px solid var(--border,#e2e8f0);border-radius:14px;padding:24px 22px;display:flex;flex-direction:column;gap:12px;min-width:0}
.pc--pro{border-color:var(--border-blue,#93c5fd);box-shadow:0 8px 24px rgba(37,99,235,.10)}
.pc.is-current{outline:2px solid var(--blue,#2563eb);outline-offset:-1px}
.pc__n{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800;color:var(--navy,#0f172a)}
.pc__badge,.pc__tag{font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 8px;background:#eff6ff;color:var(--blue-deep,#1d4ed8)}
.pc__tag{background:#ecfdf5;color:#047857}
.pc__p{font-size:28px;font-weight:800;color:var(--navy,#0f172a);letter-spacing:-0.02em;line-height:1.15}
.pc__p small{font-size:14px;font-weight:600;color:var(--muted,#64748b);letter-spacing:0}
.pc__p--txt{font-size:24px}
.pc__s{margin:2px 0 0;font-size:13px;color:var(--muted,#64748b)}
.pc__s--eq{font-size:14px;color:var(--text-2,#475569)}
.pc__save{color:var(--ok,#16a34a)}
.pc__d{margin:0;font-size:14px;color:var(--text-2,#475569)}
.pc__l{list-style:none;margin:0;padding:12px 0 0;border-top:1px solid var(--border,#e2e8f0);display:grid;gap:8px;font-size:13.5px}
.pc__l li{display:flex;justify-content:space-between;gap:10px}
.pc__k{color:var(--muted,#64748b);flex:none}
.pc__v{color:var(--navy,#0f172a);font-weight:600;text-align:right}
.pc__cta{margin-top:auto;padding-top:6px}
.pc__cta:empty{display:none}
.pc-note{margin:18px auto 0;max-width:860px;text-align:center;font-size:13px;color:var(--muted,#64748b);line-height:1.6}`;
