/* 구독 · 카드 등록 (NicePay 정기결제, /app/billing/subscribe): the page 플랜 › 구독하기 opens.
 * Order (Team 플랜 · 사용자 수 · 월 결제 금액 VAT 포함 · 첫 결제일과 매월 결제일, from the server quote) → 신용카드 정보
 * (카드번호 · 유효기간 · 생년월일 6자리 또는 사업자등록번호 10자리 · 비밀번호 앞 2자리) → 정기결제 약관 동의 → POST …/billing/recurring
 * (billing key registration + first charge, server/billing/routes.js). The page always renders in full (NicePay merchant review);
 * while payments (PAYMENTS_ENABLED) or 정기결제 (NICEPAY_RECURRING_ENABLED) are off, submit only says SUBSCRIBE_SOON and calls nothing.
 * Card values live only in the form fields: never stored, logged or kept in state, and the fields are cleared after every submit. */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { navigate } from './core/router.js';
import { toast } from './shared/dialogs.js';
import { SUBSCRIBE_SOON } from './plans.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const day = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
/** Same day next month, clamped to the month's last day (1/31 → 2/28). */
const nextMonth = (d) => { const x = new Date(d.getFullYear(), d.getMonth() + 1, 1); x.setDate(Math.min(d.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); return x; };

/** Client-side check with the server's rules (server/billing/nicepay.js parseCard). Returns { fields } or the card. */
export function checkCard(v) {
  const digits = (s) => String(s ?? '').replace(/[\s-]/g, '');
  const f = {};
  if (!/^\d{14,16}$/.test(digits(v.number))) f.number = '카드번호를 확인해 주세요.';
  if (!/^(0[1-9]|1[0-2])$/.test(v.mm || '') || !/^\d{2}$/.test(v.yy || '')) f.expiry = '유효기간을 선택해 주세요.';
  if (!/^(\d{6}|\d{10})$/.test(digits(v.id_no))) f.id_no = '생년월일 6자리 또는 사업자등록번호 10자리를 입력해 주세요.';
  if (!/^\d{2}$/.test(String(v.password2 ?? ''))) f.password2 = '카드 비밀번호 앞 2자리를 입력해 주세요.';
  return Object.keys(f).length ? { fields: f } : { card: { number: digits(v.number), expiry: `${v.mm}/${v.yy}`, id_no: digits(v.id_no), password2: String(v.password2) } };
}

/** Summary of 이용약관 제9조 · 제11조 · 제12조 · 제13조 (server/legal.js) shown before the 정기결제 consent. */
const TERMS = [
  '구독 상품: RELAI Team 플랜(월 정기결제). 등록한 신용카드로 첫 달 이용료를 바로 결제하고, 이후 최초 결제일과 같은 날짜에 매월 자동 결제합니다. 해당 날짜가 없는 달에는 그 달의 말일에 결제합니다.',
  '결제 금액은 부가세 10%를 포함합니다. 정기결제 금액이 늘어나는 경우 30일 전에 변경 내용과 해지 방법을 이메일로 알려 드립니다.',
  '설정 › 플랜 · 결제에서 언제든 해지할 수 있습니다. 해지해도 이미 결제한 이용기간이 끝날 때까지 이용할 수 있고, 이후 무료 플랜으로 전환되며 더 이상 결제되지 않습니다.',
  '결제일로부터 7일 이내에 청약을 철회할 수 있으며 결제 금액 전액을 환불합니다(이 기간에 유료 기능을 사용한 경우 사용분을 공제할 수 있습니다). 1개월 요금제는 해지 시 남은 기간을 일할 환불하지 않습니다.',
  '자동 결제에 실패하면 알려 드리고 7일 동안 매일 다시 결제를 시도합니다. 이 기간에도 결제되지 않으면 무료 플랜 한도가 적용되며 데이터는 삭제되지 않습니다.',
  `카드 정보는 전자결제대행사 나이스페이먼츠㈜에 암호화되어 전달되며, ${LEGAL.company}는 카드번호·비밀번호 등 카드 정보를 저장하지 않습니다.`,
];

export async function subscribePage(main = $('#main')) {
  document.title = 'Team 플랜 구독 — RELAI';
  const wid = state.workspace.id;
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${wid}/billing`)).billing; } catch { b = null; }
  const co = b?.checkout || {};
  const team = (b?.plans || []).find((p) => p.key === 'TEAM') || {};
  const base = co.base_monthly ?? team.base_monthly ?? 20000;
  const extra = co.extra_user_monthly ?? team.extra_user_monthly ?? 5000;
  const minUsers = Math.max(1, co.min_users || 1);
  const live = Boolean(b?.payments_enabled && co.recurring_available);   // both flags on → submit registers the card
  const owner = b ? b.can_manage !== false : true;
  const subscribed = b?.plan === 'TEAM' && b?.subscription?.auto_renew;
  const today = new Date(); const next = nextMonth(today);
  const vat = (v) => Math.round(v * 1.1);
  const years = Array.from({ length: 11 }, (_, i) => String((today.getFullYear() + i) % 100).padStart(2, '0'));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const opt = (v, l) => html`<option value="${v}">${l}</option>`;

  main.innerHTML = html`<div class="page page--narrow page--subscribe" id="subscribe-page">
    <div class="page__head"><div><a class="link" href="/app/billing/plans" data-link>← 플랜</a><h1 style="margin-top:4px">Team 플랜 구독</h1>
      <p class="dim" style="margin-top:4px">신용카드를 등록하면 매달 같은 날 자동으로 결제됩니다. 언제든 해지할 수 있어요.</p></div></div>
    ${raw(subscribed ? '<p class="cr-warn" role="status" id="sub-already">이미 Team 플랜을 구독하고 있습니다. 결제 정보는 설정 › 플랜 · 결제에서 확인할 수 있어요.</p>' : '')}
    ${raw(!owner ? '<p class="cr-warn" role="status" id="sub-owner">구독은 워크스페이스 소유자만 할 수 있습니다.</p>' : '')}
    <form id="sub-form" class="sub-form" autocomplete="off" novalidate>
      <section class="panel" id="sub-order"><div class="panel__h">1. 주문 정보</div><div class="panel__b">
        <dl class="info sub-info">
          <dt>상품</dt><dd><b>RELAI Team 플랜</b> <span class="chip chip--active">월 정기결제</span></dd>
          <dt>포함 내용</dt><dd>프로젝트 · 요구사항 · WBS · 주간보고 한도 없음 · 매달 AI 크레딧 ${n(team.ai_credits_monthly || 1000)} 제공 · 7단계 가이드와 문서 · 보고서 전체</dd>
          <dt>요금</dt><dd>월 ${n(vat(base))}원 (소유자 1명 포함) + 사용자 추가 1명당 월 ${n(vat(extra))}원 <small class="dim">· 부가세 포함</small></dd>
          <dt>사용자 수</dt><dd><label class="sub-users"><input class="input input--sm" name="users" type="number" min="${minUsers}" max="${co.max_users || 1000}" step="1" value="${minUsers}" style="width:84px"> 명 <small class="dim">(소유자 포함, 현재 멤버 ${minUsers}명 이상)</small></label></dd>
          <dt>월 결제 금액</dt><dd><b class="sub-amount" id="sub-amount">${n(vat(base + Math.max(0, minUsers - 1) * extra))}원</b> <small class="dim" id="sub-amount-note">부가세 포함</small></dd>
          <dt>결제일</dt><dd id="sub-dates">첫 결제 ${day(today)} (오늘) · 이후 매월 ${today.getDate()}일 자동 결제 <small class="dim">· 다음 결제 예정일 ${day(next)}</small></dd>
          <dt>결제 수단</dt><dd><label class="sub-method"><input type="radio" name="method" value="card" checked> 신용카드 (정기결제)</label></dd>
        </dl></div></section>

      <section class="panel" style="margin-top:16px" id="sub-card"><div class="panel__h">2. 신용카드 정보 입력</div><div class="panel__b sub-card">
        <div class="field"><label for="sub-number">신용카드번호 <em class="req">*</em></label>
          <input class="input" id="sub-number" name="number" inputmode="numeric" autocomplete="cc-number" maxlength="19" placeholder="숫자만 입력">
          <small class="hint">신용카드번호 숫자만 입력해 주세요.</small><small class="field__err" data-err="number"></small></div>
        <div class="field"><label for="sub-mm">유효기간 <em class="req">*</em></label>
          <div class="sub-exp"><select class="select" id="sub-mm" name="mm" aria-label="유효기간 월" autocomplete="cc-exp-month"><option value="">월</option>${raw(months.map((m) => opt(m, `${m}월`)).join(''))}</select>
            <select class="select" id="sub-yy" name="yy" aria-label="유효기간 년" autocomplete="cc-exp-year"><option value="">년</option>${raw(years.map((y) => opt(y, `20${y}년`)).join(''))}</select></div>
          <small class="field__err" data-err="expiry"></small></div>
        <div class="field"><label for="sub-id">생년월일 6자리 또는 사업자등록번호 10자리 <em class="req">*</em></label>
          <input class="input" id="sub-id" name="id_no" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="예: 생년월일 YYMMDD">
          <small class="hint">개인카드는 생년월일 6자리, 법인카드는 사업자등록번호 10자리를 입력해 주세요.</small><small class="field__err" data-err="id_no"></small></div>
        <div class="field"><label for="sub-pw">비밀번호 앞 2자리 <em class="req">*</em></label>
          <input class="input sub-pw" id="sub-pw" name="password2" type="password" inputmode="numeric" autocomplete="off" maxlength="2" placeholder="••">
          <small class="hint">신용카드 비밀번호의 앞 2자리를 입력해 주세요.</small><small class="field__err" data-err="password2"></small></div>
        <p class="hint">카드 정보는 결제대행사(나이스페이먼츠)로 암호화되어 전달되며 RELAI에 저장되지 않습니다.</p>
      </div></section>

      <section class="panel" style="margin-top:16px" id="sub-terms"><div class="panel__h">3. 약관 동의</div><div class="panel__b">
        <details class="sub-terms"><summary>정기결제(자동 결제) 이용 약관 보기</summary><ol>${raw(TERMS.map((t) => html`<li>${t}</li>`).join(''))}</ol>
          <p class="hint">전체 내용은 <a class="link" href="/terms" target="_blank" rel="noopener">이용약관</a>과 <a class="link" href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>을 따릅니다.</p></details>
        <label class="sub-agree"><input type="checkbox" name="agree_recurring"> <span><b>[필수]</b> 결제 금액과 결제일을 확인했으며, 정기결제(매월 자동 결제) 이용 약관에 동의합니다.</span></label>
        <label class="sub-agree"><input type="checkbox" name="agree_pg"> <span><b>[필수]</b> 결제를 위해 카드 정보를 전자결제대행사(나이스페이먼츠㈜)에 제공하는 데 동의합니다.</span></label>
        <small class="field__err" data-err="agree"></small>
        <div class="actions" style="margin-top:14px"><button class="btn btn--primary sub-pay" id="sub-pay" type="submit"${raw(subscribed || !owner ? ' disabled' : '')}><span id="sub-pay-amount">${n(vat(base + Math.max(0, minUsers - 1) * extra))}원</span> 결제하고 구독 시작</button></div>
      </div></section>
    </form>
    ${raw(legalFooterHtml())}
  </div>`;

  const f = $('#sub-form', main);
  const users = () => Math.max(minUsers, Math.floor(Number(f.users.value) || minUsers));
  let seq = 0;
  const refresh = async () => {
    const my = ++seq; const u = users();
    let amount = vat(base + Math.max(0, u - 1) * extra); let note = '부가세 포함';
    try {
      const { quote: q } = await api('GET', `/api/workspaces/${wid}/billing/quote?cycle=MONTHLY&users=${u}`); if (my !== seq) return;
      amount = q.amount; if (q.discount_amount) note = `부가세 포함 · 파운딩 고객 할인 적용 (정가 월 ${n(vat(q.list_amount))}원)`;
    } catch { if (my !== seq) return; }
    $('#sub-amount', main).textContent = `${n(amount)}원`; $('#sub-pay-amount', main).textContent = `${n(amount)}원`; $('#sub-amount-note', main).textContent = note;
  };
  f.users.oninput = refresh; refresh();
  f.number.oninput = () => { f.number.value = f.number.value.replace(/[^\d]/g, '').replace(/(\d{4})(?=\d)/g, '$1-').slice(0, 19); };
  const showErr = (fields = {}) => main.querySelectorAll('[data-err]').forEach((el) => { el.textContent = fields[el.dataset.err] || ''; });
  const clearCard = () => { f.number.value = ''; f.mm.value = ''; f.yy.value = ''; f.id_no.value = ''; f.password2.value = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const c = checkCard({ number: f.number.value, mm: f.mm.value, yy: f.yy.value, id_no: f.id_no.value, password2: f.password2.value });
    const fields = { ...(c.fields || {}) };
    if (!f.agree_recurring.checked || !f.agree_pg.checked) fields.agree = '필수 약관에 모두 동의해 주세요.';
    showErr(fields);
    if (Object.keys(fields).length) return;
    if (!live) { clearCard(); return toast(SUBSCRIBE_SOON); }   // payments / 정기결제 off: no request is sent
    const btn = $('#sub-pay', main); btn.disabled = true;
    try {
      await api('POST', `/api/workspaces/${wid}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: users(), card: c.card });
      clearCard(); toast('구독을 시작했습니다. 다음 결제일에 자동으로 결제됩니다.'); navigate('/app/settings#billing');
    } catch (err) { clearCard(); btn.disabled = false; showErr(err.fields || {}); toast(Object.values(err.fields || {})[0] || err.message); }
  };
}
