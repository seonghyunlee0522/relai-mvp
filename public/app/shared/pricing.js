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
/** Founder 2026-10-20 (D3): paid plans open only after NicePay recurring approval; until then the buy button says this. */
export const RECURRING_SOON = '정기결제 준비 중';
/** Paid-plan button while checkout is closed: visible, not clickable. */
export const soonCta = (p, cls = 'btn--sm') => `<span class="btn btn--secondary ${cls} btn--block is-disabled" aria-disabled="true" data-plan-soon="${p.key}">${RECURRING_SOON}</span>`;
const num = (v) => Number(v || 0).toLocaleString('ko-KR');

const BLURB = {
  FREE: '작은 프로젝트 하나로 RELAI의 흐름을 끝까지 경험해 보세요.',
  PRO: '여러 프로젝트를 함께 운영하는 작은 팀을 위한 플랜.',
  TEAM: '여러 팀과 프로젝트를 한 워크스페이스에서 운영하는 조직을 위한 플랜.',
  ENTERPRISE: '조직 규모와 계약 조건에 맞춘 견적.',
};

/** Feature rows of one plan: [label, monthly value, annual value]. */
export function planRows(p, cat, { oneTime = false } = {}) {
  const inc = p.included || {};
  const lim = (v, unit) => (v === null || v === undefined ? '협의' : `${num(v)}${unit}`);
  const credits = p.contact_sales ? '협의' : p.credits?.monthly ? `매월 ${num(p.credits.monthly)} 크레딧` : p.credits?.once ? `최초 ${num(p.credits.once)} 크레딧 (1회)` : '-';
  const rows = [['활성 프로젝트', lim(inc.projects, '개')], ['기본 사용자', lim(inc.users, '명')], ['AI 크레딧', credits]];
  const a = p.addons;
  const out = rows.map(([k, v]) => [k, v, v]);
  if (a && !oneTime) {   // 단건결제 모드: no add-on is sold
    out.push(['추가 사용자 1명', `월 ${krw(a.user.MONTHLY)}`, `월 ${krw(a.user.monthly_equivalent)} 환산`]);
    out.push(['추가 프로젝트 1개', `월 ${krw(a.project.MONTHLY)}`, `월 ${krw(a.project.monthly_equivalent)} 환산`]);
  }
  const step = cat?.topup?.step || 10000;
  const topup = p.topup === 'contract' ? '계약에 따름' : p.topup === true || oneTime ? `${krw(step)} 단위` : '불가';   // 단건결제 모드: every plan tops up
  out.push(['AI 크레딧 충전', topup, topup]);
  return out;
}

/** Price block of one plan for one cycle (HTML). */
function priceHtml(p, cycle, oneTime = false) {
  if (p.contact_sales) return '<div class="pc__p pc__p--txt">별도 견적</div><p class="pc__s">조직 규모에 맞춰 협의</p>';
  if (!p.price || (p.price.MONTHLY === 0 && p.price.ANNUAL === 0)) return '<div class="pc__p">무료</div><p class="pc__s">결제 정보 없이 시작</p>';
  if (oneTime) return `<div class="pc__p" data-amount="${p.price.MONTHLY}">${krw(p.price.MONTHLY)}<small> /1개월</small></div><p class="pc__s">VAT 포함 · 1개월 이용권 · 카드 1회 결제 · 자동 갱신 없음</p>`;
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
 *   oneTime  — 단건결제 모드: paid plans are 1개월 이용권 (one-time card payment, no auto renewal): no 월간/연간 switch, no add-on rows
 */
export function pricingHtml(cat, { current = null, cta = () => '', cycle = 'MONTHLY', oneTime = false } = {}) {
  if (!cat?.plans?.length) return '';
  const pct = cat.annual_discount_pct;
  const card = (p) => {
    const rows = planRows(p, cat, { oneTime });
    const li = (i) => rows.map((r) => `<li><span class="pc__k">${esc(r[0])}</span><span class="pc__v">${esc(r[i])}</span></li>`).join('');
    return `<div class="pc pc--${p.key.toLowerCase()}${current === p.key ? ' is-current' : ''}" data-plan="${p.key}">
  <div class="pc__n">${esc(p.label)}${current === p.key ? '<span class="pc__badge">현재 플랜</span>' : ''}${p.key === 'PRO' ? '<span class="pc__tag">추천</span>' : ''}</div>
  <div class="pc-m">${priceHtml(p, 'MONTHLY', oneTime)}</div>${oneTime ? '' : `<div class="pc-a">${priceHtml(p, 'ANNUAL')}</div>`}
  <p class="pc__d">${esc(BLURB[p.key] || '')}</p>
  <ul class="pc__l pc-m">${li(1)}</ul>${oneTime ? '' : `<ul class="pc__l pc-a">${li(2)}</ul>`}
  <div class="pc__cta">${cta(p) || ''}</div>
</div>`;
  };
  const toggle = oneTime ? '' : `<div class="pc-cycle" role="radiogroup" aria-label="결제 주기">
  <button type="button" role="radio" class="pc-cycle__b" data-cycle-set="MONTHLY" aria-checked="${cycle !== 'ANNUAL'}">월간 결제</button>
  <button type="button" role="radio" class="pc-cycle__b" data-cycle-set="ANNUAL" aria-checked="${cycle === 'ANNUAL'}">연간 결제 <span class="pc-cycle__off">${pct}% 할인</span></button>
</div>
`;
  return `<div class="pcw" data-cycle="${oneTime || cycle !== 'ANNUAL' ? 'MONTHLY' : 'ANNUAL'}">
${toggle}<div class="pc-grid">${cat.plans.map(card).join('\n')}</div>
${oneTime ? oneTimeNote(cat) : `<p class="pc-note">모든 금액은 부가가치세(VAT 10%) 포함 금액이며 실제 카드 결제 금액입니다. AI 크레딧 충전은 Pro·Team에서 ${krw(cat.topup?.step || 10000)} = ${num((cat.topup?.step || 10000) / (cat.credit_price_krw || 10))} 크레딧 단위로 할 수 있습니다. 연간 결제는 12개월분을 한 번에 결제하고, AI 기본 크레딧은 연간 결제에도 매월 지급됩니다. 매월 지급되는 기본 크레딧은 그 달이 끝나면 소멸하며 다음 달로 이월되지 않습니다. 한도를 넘어도 데이터는 삭제되지 않습니다. 해지·환불 기준은 <a href="/terms#billing">이용약관</a>과 <a href="/terms#recurring">정기결제 안내</a>를 확인해 주세요.</p>`}
</div>`;
}

/** 단건결제 모드 note under the cards: no 정기결제 / 연간 / 해지 wording. */
const oneTimeNote = (cat) => `<p class="pc-note">모든 금액은 부가가치세(VAT 10%) 포함 금액이며 실제 카드 결제 금액입니다. Pro·Team은 1개월 이용권으로 신용카드 1회 결제하며 자동으로 다시 결제되지 않습니다. 이용 기간이 끝나면 Free로 바뀌고 데이터는 삭제되지 않습니다. AI 크레딧은 모든 요금제에서 ${krw(cat.topup?.step || 10000)} = ${num((cat.topup?.step || 10000) / (cat.credit_price_krw || 10))} 크레딧 단위로 충전할 수 있습니다. 매월 지급되는 기본 크레딧은 그 달이 끝나면 소멸하며 다음 달로 이월되지 않습니다. 환불 기준은 <a href="/terms#billing">이용약관</a>을 확인해 주세요.</p>`;

/** Browser: wire the 월간/연간 switch inside `root` (switches data-cycle only; nothing is computed). */
export function bindCycleToggle(root) {
  const w = root?.querySelector?.('.pcw'); if (!w) return;
  w.querySelectorAll('[data-cycle-set]').forEach((b) => { b.onclick = () => {
    w.dataset.cycle = b.dataset.cycleSet;
    w.querySelectorAll('[data-cycle-set]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }; });
}

/** Shared CSS (landing inlines it from the server; the app has the same rules in app.css). */
export const PRICING_CSS = `[data-plan-soon]{opacity:.65;cursor:default;pointer-events:none}.pcw[data-cycle=MONTHLY] .pc-a,.pcw[data-cycle=ANNUAL] .pc-m{display:none}
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

/** 단건결제 모드 FAQ (plans page): 1개월 이용권, credits for every plan; no 연간 · 해지 · 추가 구매. */
export const FAQ_ONE_TIME = [
  ['1개월 이용권은 어떻게 결제되나요?', 'Pro·Team 1개월 이용권은 신용카드로 한 번 결제해요. 자동으로 다시 결제되지 않고, 이용 기간이 끝나면 Free로 바뀌어요. 계속 쓰려면 이용권을 다시 구매하면 남은 기간에 1개월이 더해져요.'],
  ['환불받을 수 있나요?', '결제 후 7일 이내이고 결제 후 서비스를 이용하지 않았다면(AI 사용, 프로젝트 생성, 프로젝트 입력·수정·삭제 없음) 설정 › 플랜 · 결제에서 결제 금액 전액을 환불받을 수 있어요. 그 외에는 환불 없이 이용 기간이 끝날 때까지 써요.'],
  ['활성 프로젝트는 어떻게 세나요?', '준비·진행·보류 상태의 프로젝트만 한도에 들어가요. 완료하거나 보관한 프로젝트는 세지 않고, 계속 보고 내보낼 수 있어요.'],
  ['사용자는 어떻게 세나요?', '워크스페이스에 참여한 활성 사용자 기준이에요. 한 사람이 여러 프로젝트에 참여해도 1명이고, 초대를 보내면 수락 전까지 자리 하나를 잡아 둬요.'],
  ['이용 기간이 끝나면 데이터는 어떻게 되나요?', '데이터는 삭제되지 않아요. Free로 바뀌어 활성 프로젝트가 한도를 넘으면 생성일이 가장 최근인 프로젝트 1개만 편집할 수 있고 나머지는 조회 전용이 돼요. 이용권을 다시 구매하면 한도만큼 편집 권한이 돌아와요.'],
  ['AI 크레딧은 어떻게 받나요?', 'Free는 처음 한 번 200 크레딧, Pro는 매월 1,000, Team은 매월 3,000 크레딧을 받아요. 매월 받은 기본 크레딧은 그 달이 끝나면 소멸하고 이월되지 않아요.'],
  ['AI 크레딧은 어떻게 충전하나요?', '모든 요금제에서 10,000원 단위로 충전해요(10,000원 = 1,000 크레딧). 신용카드 1회 결제이고, 충전한 크레딧은 5년간 쓸 수 있으며 쓰지 않은 충전 크레딧은 환불받을 수 있어요.'],
];

/** 요금제 FAQ (plans page). '한도를 넘으면' follows the 10-21 해지 policy: newest project(s) editable, the rest 조회 전용 (P2, Jim prod 10-21 #5). */
export const FAQ = [
  ['활성 프로젝트는 어떻게 세나요?', '준비·진행·보류 상태의 프로젝트만 한도에 들어가요. 완료하거나 보관한 프로젝트는 세지 않고, 계속 보고 내보낼 수 있어요. 보관을 풀거나 다시 진행할 때 한도를 확인해요.'],
  ['사용자는 어떻게 세나요?', '워크스페이스에 참여한 활성 사용자 기준이에요. 한 사람이 여러 프로젝트에 참여해도 1명이고, 초대를 보내면 수락 전까지 자리 하나를 잡아 둬요. 내보낸 사용자는 세지 않아요.'],
  ['한도를 넘으면 데이터는 어떻게 되나요?', '데이터는 삭제되지 않아요. 요금제를 낮추거나 이용 기간이 끝나 활성 프로젝트가 한도를 넘으면, 생성일이 가장 최근인 프로젝트부터 한도만큼만 편집할 수 있고 나머지는 자동으로 조회 전용이 돼요(편집할 프로젝트는 고를 수 없어요). 모든 프로젝트는 계속 조회·내보내기·보관할 수 있고, 한도 안으로 정리될 때까지 새 프로젝트·초대만 막혀요. 다시 구독하거나 플랜을 올리면 한도만큼 최근 프로젝트부터 편집 권한이 돌아와요.'],
  ['AI 크레딧은 어떻게 받나요?', 'Free는 처음 한 번 200 크레딧, Pro는 매월 1,000, Team은 매월 3,000 크레딧을 받아요. 매월 받은 기본 크레딧은 그 달이 끝나면 소멸하고 이월되지 않아요. 크레딧은 워크스페이스 공용이고, 실패한 AI 요청은 차감하지 않아요.'],
  ['AI 크레딧은 어떻게 충전하나요?', 'Pro·Team에서 10,000원 단위로 충전해요(10,000원 = 1,000 크레딧). 충전한 크레딧은 5년간 쓸 수 있고, 쓰지 않은 충전 크레딧은 언제든 전액 환불받을 수 있어요(무료로 받은 크레딧은 환불되지 않아요). Free에서는 충전할 수 없어요.'],
  ['연간 결제는 어떻게 다른가요?', '12개월분을 한 번에 결제하고 20% 할인돼요. AI 기본 크레딧은 연간 결제에도 매월 지급돼요. 언제든 해지할 수 있고 위약금은 없어요. 결제 후 7일 이내에 서비스를 이용하지 않았다면 전액 환불해요. 중도에 해지하면 해지한 달(결제일 기준)까지 쓰고, 연간 결제 금액에서 이용한 개월 수 × 월간 요금(할인 없음)을 뺀 나머지를 환불해요. 예: Pro 연간 288,000원, 4개월째 해지 → 168,000원 환불.'],
  ['해지하면 어떻게 되나요?', '월간·연간 모두 언제든 해지할 수 있고 자동 갱신은 바로 멈춰요. 위약금은 없어요. 결제 후 7일 이내에 서비스를 이용하지 않았다면(AI 사용, 프로젝트 생성, 프로젝트 입력·수정·삭제 없음) 결제 금액 전액을 환불하고, 그 외에는 환불 없이 결제한 기간 끝까지 이용해요(연간 중도 해지는 \'연간 결제는 어떻게 다른가요?\'를 확인해 주세요). 이용 기간이 끝나면 Free로 바뀌고, 생성일이 가장 최근인 프로젝트 1개만 편집할 수 있으며 나머지는 조회 전용이 돼요. 데이터는 삭제되지 않고 계속 조회·내보내기할 수 있으며, 다시 구독하면 한도만큼 최근 프로젝트부터 편집 권한이 돌아와요.'],
  ['추가 사용자·프로젝트는 얼마인가요?', '추가 사용자는 1명당 월 1,000원, 추가 프로젝트는 Pro 월 10,000원 · Team 월 8,000원이에요. 이용 기간 중간에 사면 남은 일수만큼만 결제하고, 결제 전에 금액과 다음 갱신 금액을 보여 드려요.'],
];
