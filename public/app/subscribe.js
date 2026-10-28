/* 결제하기 · 카드 등록 (/app/billing/subscribe?plan=PRO|TEAM): Pro · Team 정기결제.
 * Two columns (founder 2026-10-28): left = 1. 플랜 선택 · 2. 신용카드 정보 · 3. 정기결제 안내; right = a sticky 주문 요약 (plan, amounts,
 * next payment, the two required consents and the pay button). One column on a phone (summary after the form).
 * 월간 결제만 (flags.monthly_only, default): no 연간 radio and no 추가 사용자 · 프로젝트 steppers — the server refuses them too.
 * Every amount comes from the server quote (GET …/billing/quote; no won computed here) with the 정기결제 고지 (disclosure) items shown
 * as-is; its hash goes back with the consent so the customer agrees to exactly these numbers.
 * Card number: four boxes of 4 digits (auto-advance, paste fills all, last box 2–4 digits for 14–16-digit cards); once filled and the
 * focus leaves the boxes, the middle two are masked. Pay → a confirm dialog with plan · amount · cycle · next payment · masked card;
 * only 결제하기 there sends POST …/billing/recurring. Card values live only in the form fields and are cleared after every submit.
 * While flags.checkout_open is false the page still renders (merchant review) with 정기결제 준비 중, and submit sends nothing. */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { navigate } from './core/router.js';
import { toast, confirmDialog } from './shared/dialogs.js';
import { legalFooterHtml } from './shared/legal-info.js';

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
export const NOT_OPEN = '정기결제 준비 중이에요. 카드 자동 결제 승인이 끝나면 Pro · Team 플랜을 바로 구독할 수 있어요.';
const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

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

/** "1234 **** **** 5678" (first 4 + last 4 shown; the rest as *, grouped by 4). */
export function maskCard(num) {
  const d = digitsOf(num);
  if (d.length < 8) return '';
  const m = d.slice(0, 4) + '*'.repeat(d.length - 8) + d.slice(-4);
  return m.replace(/(.{4})(?=.)/g, '$1 ');
}

export async function subscribePage(main = $('#main')) {
  const wid = state.workspace.id;
  const qs = new URLSearchParams(location.search);
  const token = String(Math.random()); main.dataset.subRender = token;   // a second render of this route (router re-entry) wins; this one stops
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${wid}/billing`)).billing; } catch { b = null; }
  if (main.dataset.subRender !== token) return;
  const plans = (b?.catalogue?.plans || b?.plans || []).filter((p) => ['PRO', 'TEAM'].includes(p.key));
  const monthly = b?.flags?.monthly_only !== false;   // 월간 결제만 (default)
  const qn = (k) => (monthly ? 0 : Math.max(0, Math.min(200, Math.floor(Number(qs.get(k)) || 0))));
  const sel = { plan: ['PRO', 'TEAM'].includes(qs.get('plan')) ? qs.get('plan') : 'PRO', cycle: !monthly && qs.get('cycle') === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY', extra_users: qn('extra_users'), extra_projects: qn('extra_projects') };
  const open = Boolean(b?.flags?.checkout_open);
  const owner = b ? b.can_manage !== false : true;
  const subscribed = Boolean(b && ['PRO', 'TEAM'].includes(b.plan) && b.auto_renew);
  // On a renewing subscription the page changes it now instead: ?addon=1 → 사용자 · 프로젝트 추가 (ADDON), a higher plan → 업그레이드 (UPGRADE).
  const mode = !subscribed ? 'SUBSCRIBE' : qs.get('addon') ? 'ADDON' : qs.get('plan') === 'TEAM' && b.plan === 'PRO' ? 'UPGRADE' : 'NONE';
  const modeOpen = mode === 'ADDON' ? open && b?.flags?.addons : mode === 'UPGRADE' ? open && b?.flags?.plan_change : open;
  const change = mode === 'ADDON' || mode === 'UPGRADE';
  const label = (k) => plans.find((p) => p.key === k)?.label || k;
  const TITLE = { SUBSCRIBE: '결제하기', ADDON: '사용자 · 프로젝트 추가', UPGRADE: `${label('PRO')} → ${label('TEAM')} 업그레이드`, NONE: '결제하기' };
  const VERB = { SUBSCRIBE: '결제하기', ADDON: '결제하고 추가', UPGRADE: '결제하고 업그레이드', NONE: '결제하기' };
  document.title = `${TITLE[mode]} — RELAI`;
  const years = Array.from({ length: 11 }, (_, i) => String((new Date().getFullYear() + i) % 100).padStart(2, '0'));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const opt = (v, l) => html`<option value="${v}">${l}</option>`;
  const planRadio = (p) => html`<label class="sub-plan"><input type="radio" name="plan" value="${p.key}"${raw(p.key === sel.plan ? ' checked' : '')}>
    <span><b>${p.label}</b> <small class="dim">활성 프로젝트 ${p.included?.projects}개 · 사용자 ${p.included?.users}명 · AI 이용량 포함</small></span></label>`;
  const stepper = (name, text) => html`<label class="sub-step"><span>${text}</span><span class="sub-step__ctl"><button type="button" class="btn btn--secondary btn--sm" data-step="${name}" data-d="-1" data-phone-ok aria-label="${text} 줄이기">−</button>
    <input class="input input--sm" name="${name}" type="number" inputmode="numeric" min="0" max="200" step="1" value="${sel[name]}" aria-label="${text}"><button type="button" class="btn btn--secondary btn--sm" data-step="${name}" data-d="1" data-phone-ok aria-label="${text} 늘리기">+</button></span></label>`;
  const cardBox = (i) => html`<input class="input sub-cn" id="sub-cn${i}" data-cn="${i}" inputmode="numeric" autocomplete="${i === 0 ? 'cc-number' : 'off'}" maxlength="4" pattern="[0-9]*" aria-label="카드번호 ${i + 1}번째 4자리">`;
  const sec = (k) => (change ? { order: 1, card: 0, info: 2 } : { order: 1, card: 2, info: 3 })[k];

  main.innerHTML = html`<div class="page page--subscribe" id="subscribe-page">
    <div class="page__head"><div><a class="link" href="/app/settings/billing" data-link>← 플랜 · 결제</a><h1 style="margin-top:4px">${TITLE[mode]}</h1>
      <p class="dim" style="margin-top:4px">${mode === 'SUBSCRIBE' || mode === 'NONE' ? `신용카드를 등록하면 ${monthly ? '매월' : '선택한 주기마다'} 같은 날 자동으로 결제됩니다. 언제든 해지할 수 있어요.`
        : '등록한 카드로 남은 기간만큼 일할 계산해 지금 결제하고, 다음 결제일부터는 바뀐 금액으로 자동 결제됩니다.'}</p></div></div>
    ${raw(!open ? html`<p class="cr-warn" role="status" id="sub-not-open">${NOT_OPEN}</p>` : open && !modeOpen ? '<p class="cr-warn" role="status" id="sub-not-open">이 변경은 아직 열리지 않았어요.</p>' : '')}
    ${raw(mode === 'NONE' ? '<p class="cr-warn" role="status" id="sub-already">이미 구독 중입니다. 플랜 변경 · 해지는 설정 › 플랜 · 결제에서 할 수 있어요.</p>' : '')}
    ${raw(!owner ? '<p class="cr-warn" role="status" id="sub-owner">결제는 워크스페이스 소유자만 할 수 있습니다.</p>' : '')}
    <form id="sub-form" class="sub-form sub-grid" autocomplete="off" novalidate>
      <div class="sub-main">
      <section class="panel" id="sub-order"><div class="panel__h">${sec('order')}. ${mode === 'ADDON' ? '추가할 수량' : mode === 'UPGRADE' ? '변경 내용' : '플랜 선택'}</div><div class="panel__b">
        ${raw(mode === 'SUBSCRIBE' || mode === 'NONE' ? html`<div class="sub-plans" role="radiogroup" aria-label="플랜">${raw(plans.map(planRadio).join(''))}</div>
        ${raw(monthly ? '<p class="dim sub-cycle-note" id="sub-monthly">월간 정기결제 · 매월 같은 날 자동 결제</p>' : html`<div class="sub-cycle" role="radiogroup" aria-label="결제 주기">
          <label><input type="radio" name="cycle" value="MONTHLY"${raw(sel.cycle === 'MONTHLY' ? ' checked' : '')}> 월간</label>
          <label><input type="radio" name="cycle" value="ANNUAL"${raw(sel.cycle === 'ANNUAL' ? ' checked' : '')}> 연간 <small class="dim">(12개월분 한 번 결제, 20% 할인)</small></label></div>`)}` : '')}
        ${raw(mode === 'ADDON' || (mode !== 'UPGRADE' && !monthly) ? html`<div class="sub-steps">${raw(stepper('extra_users', '추가 사용자'))}${raw(stepper('extra_projects', '추가 프로젝트'))}</div>` : '')}
        ${raw(mode === 'UPGRADE' ? '<p class="dim">아래 주문 요약의 금액으로 지금 업그레이드합니다.</p>' : '')}
      </div></section>

      ${raw(change ? '' : html`<section class="panel" style="margin-top:16px" id="sub-card"><div class="panel__h">${sec('card')}. 신용카드 정보</div><div class="panel__b sub-card">
        <div class="field"><label for="sub-cn0">신용카드번호 <em class="req">*</em></label>
          <div class="sub-cn-row" id="sub-number" role="group" aria-label="신용카드번호">${raw([0, 1, 2, 3].map(cardBox).join('<span class="sub-cn-sep" aria-hidden="true">-</span>'))}</div>
          <small class="hint" id="sub-cn-masked" hidden></small>
          <small class="field__err" data-err="number"></small></div>
        <div class="sub-card-row">
          <div class="field"><label for="sub-mm">유효기간 <em class="req">*</em></label>
            <div class="sub-exp"><select class="select" id="sub-mm" name="mm" aria-label="유효기간 월" autocomplete="cc-exp-month"><option value="">월</option>${raw(months.map((m) => opt(m, `${m}월`)).join(''))}</select>
              <select class="select" id="sub-yy" name="yy" aria-label="유효기간 년" autocomplete="cc-exp-year"><option value="">년</option>${raw(years.map((y) => opt(y, `20${y}년`)).join(''))}</select></div>
            <small class="field__err" data-err="expiry"></small></div>
          <div class="field"><label for="sub-pw">비밀번호 앞 2자리 <em class="req">*</em></label>
            <input class="input sub-pw" id="sub-pw" name="password2" type="password" inputmode="numeric" autocomplete="off" maxlength="2" placeholder="••">
            <small class="field__err" data-err="password2"></small></div>
        </div>
        <div class="field"><label for="sub-id">생년월일 6자리 또는 사업자등록번호 10자리 <em class="req">*</em></label>
          <input class="input" id="sub-id" name="id_no" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="예: 생년월일 YYMMDD">
          <small class="hint">개인카드는 생년월일 6자리, 법인카드는 사업자등록번호 10자리를 입력해 주세요.</small><small class="field__err" data-err="id_no"></small></div>
        <p class="hint sub-secure">카드 정보는 결제대행사(나이스페이먼츠)로 암호화되어 전달되며 RELAI에 저장되지 않습니다.</p>
      </div></section>`)}

      <section class="panel" style="margin-top:16px" id="sub-disclosure"><div class="panel__h">${sec('info')}. 정기결제 안내</div><div class="panel__b">
        <dl class="info sub-info" id="sub-disclosure-items"></dl></div></section>
      </div>

      <aside class="sub-side" aria-label="주문 요약"><section class="panel sub-summary" id="sub-summary"><div class="panel__h">주문 요약</div><div class="panel__b">
        <div class="sub-quote" id="sub-quote" aria-live="polite"><p class="dim">금액을 불러오는 중…</p></div>
        <div class="sub-consents" id="sub-terms">
          <label class="sub-agree"><input type="checkbox" name="agree"> <span><b>[필수]</b> 결제 금액 · 결제 주기 · 자동 갱신 · 해지 방법 · 환불 기준을 확인했으며 정기결제(자동 결제)에 동의합니다.</span></label>
          ${raw(change ? '' : '<label class="sub-agree"><input type="checkbox" name="agree_pg"> <span><b>[필수]</b> 결제를 위해 카드 정보를 전자결제대행사(나이스페이먼츠㈜)에 제공하는 데 동의합니다.</span></label>')}
          <small class="field__err" data-err="agree"></small>
        </div>
        <button class="btn btn--primary btn--lg btn--block sub-pay" id="sub-pay" type="submit" data-phone-ok${raw(mode === 'NONE' || !owner ? ' disabled' : '')}><span id="sub-pay-amount">${modeOpen ? VERB[mode] : '정기결제 준비 중'}</span></button>
        <p class="hint sub-legal">전체 내용은 <a class="link" href="/terms" target="_blank" rel="noopener">이용약관</a>과 <a class="link" href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>을 따릅니다.</p>
      </div></section></aside>
    </form>
    ${raw(legalFooterHtml())}
  </div>`;

  // Everything below works on THIS render's page: a stale render (router re-entry) must never write a quote into the live page,
  // or the screen would show one amount while the live form pays another.
  const root = $('#subscribe-page', main);
  const f = $('#sub-form', root);
  const boxes = [...root.querySelectorAll('[data-cn]')];
  let current = null; let seq = 0;
  const showErr = (fields = {}) => root.querySelectorAll('[data-err]').forEach((el) => { el.textContent = fields[el.dataset.err] || ''; });
  const readSel = () => {
    sel.plan = f.querySelector('input[name=plan]:checked')?.value || sel.plan;
    sel.cycle = monthly ? 'MONTHLY' : f.querySelector('input[name=cycle]:checked')?.value || sel.cycle;
    sel.extra_users = f.extra_users ? Math.max(0, Math.min(200, Math.floor(Number(f.extra_users.value) || 0))) : 0;
    sel.extra_projects = f.extra_projects ? Math.max(0, Math.min(200, Math.floor(Number(f.extra_projects.value) || 0))) : 0;
  };
  const item = (d, lab) => d?.items?.find((i) => i.label === lab)?.value || '';
  const renderQuote = (q, d) => {
    const lines = q.lines.map((l) => html`<tr><th>${l.label}${l.qty > 1 ? ` × ${l.qty}` : ''}</th><td>${n(l.amount)}원</td></tr>`).join('');
    const nextPay = item(d, '다음 결제 예정');
    $('#sub-quote', root).innerHTML = html`<table class="sub-lines">${raw(lines)}
      <tr class="sub-total"><th>지금 결제 금액 <small class="dim">VAT 포함</small></th><td><b class="sub-amount" id="sub-amount">${n(q.total)}원</b></td></tr></table>
      <dl class="sub-facts">${raw(mode === 'SUBSCRIBE' || mode === 'NONE' ? html`<dt>결제 주기</dt><dd>${q.months === 12 ? '연간 (12개월마다 자동 결제)' : '월간 (매월 자동 결제)'}</dd>` : '')}
        ${raw(nextPay ? html`<dt>다음 결제</dt><dd id="sub-next">${nextPay}</dd>` : '')}
        <dt>이용 한도</dt><dd>활성 프로젝트 ${q.limits_after?.projects ?? '-'}개 · 사용자 ${q.limits_after?.users ?? '-'}명 · AI 이용량 포함</dd></dl>`;
    $('#sub-disclosure-items', root).innerHTML = d.items.map((i) => html`<dt>${i.label}</dt><dd>${i.value}</dd>`).join('');
    if (modeOpen) $('#sub-pay-amount', root).textContent = `${n(q.total)}원 ${VERB[mode]}`;
  };
  const refresh = async () => {
    readSel(); const my = ++seq;
    // the choice lives in the URL too: a re-render (phone rotation across 768px, router re-entry) restores it instead of resetting
    const u = new URL(location.href); u.searchParams.set('plan', sel.plan);
    for (const k of ['cycle', 'extra_users', 'extra_projects']) { if (monthly && mode !== 'ADDON') u.searchParams.delete(k); else u.searchParams.set(k, sel[k]); }
    if (u.href !== location.href && root.isConnected) history.replaceState(history.state, '', u.href);
    try {
      if (mode === 'ADDON' && !sel.extra_users && !sel.extra_projects) { $('#sub-quote', root).innerHTML = '<p class="dim">추가할 사용자 또는 프로젝트 수를 정해 주세요.</p>'; $('#sub-disclosure-items', root).innerHTML = ''; current = null; return; }
      const r = await api('GET', mode === 'ADDON' ? `/api/workspaces/${wid}/billing/quote?kind=ADDON&extra_users=${sel.extra_users}&extra_projects=${sel.extra_projects}`
        : mode === 'UPGRADE' ? `/api/workspaces/${wid}/billing/quote?kind=UPGRADE&plan=TEAM`
          : `/api/workspaces/${wid}/billing/quote?plan=${sel.plan}&cycle=${sel.cycle}&extra_users=${sel.extra_users}&extra_projects=${sel.extra_projects}`);
      if (my !== seq) return;
      current = r; renderQuote(r.quote, r.disclosure); showErr({});
    } catch (err) {
      if (my !== seq) return;
      current = null; $('#sub-quote', root).innerHTML = html`<p class="field__err">${Object.values(err.fields || {})[0] || err.message}</p>`;
    }
  };
  f.addEventListener('change', (e) => { if (['plan', 'cycle', 'extra_users', 'extra_projects'].includes(e.target.name)) refresh(); });
  root.querySelectorAll('[data-step]').forEach((btn) => { btn.onclick = () => { const i = f[btn.dataset.step]; i.value = Math.max(0, Math.min(200, (Number(i.value) || 0) + Number(btn.dataset.d))); refresh(); }; });

  // ---- card number: 4 boxes ----
  const cardNumber = () => boxes.map((x) => x.value).join('');
  const cardComplete = () => boxes.slice(0, 3).every((x) => x.value.length === 4) && /^\d{14,16}$/.test(cardNumber());
  const maskOut = $('#sub-cn-masked', root);
  const setMasked = (on) => {
    boxes.forEach((x, i) => { if (i === 1 || i === 2) x.type = on ? 'password' : 'text'; });
    if (maskOut) { maskOut.hidden = !on; maskOut.textContent = on ? `입력한 카드: ${maskCard(cardNumber())}` : ''; }
    root.querySelector('#sub-number')?.classList.toggle('is-masked', on);
  };
  const fillFrom = (start, digits) => {   // spread digits over the boxes from `start`; returns the box to focus next
    let i = start; let rest = digits;
    while (rest && i < 4) { const room = 4 - boxes[i].value.length; boxes[i].value += rest.slice(0, room); rest = rest.slice(room); if (boxes[i].value.length === 4 && i < 3) i += 1; else break; }
    return boxes[Math.min(i, 3)];
  };
  boxes.forEach((box, i) => {
    box.addEventListener('focus', () => setMasked(false));
    box.addEventListener('input', () => {
      const d = digitsOf(box.value);
      if (d.length > 4) { box.value = ''; fillFrom(i, d).focus(); return; }   // typed fast / autofill into one box
      box.value = d;
      if (d.length === 4 && i < 3) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { e.preventDefault(); const p = boxes[i - 1]; p.value = p.value.slice(0, -1); p.focus(); }
      else if (e.key === 'ArrowLeft' && box.selectionStart === 0 && i > 0) boxes[i - 1].focus();
      else if (e.key === 'ArrowRight' && box.selectionStart === box.value.length && i < 3) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => {
      const d = digitsOf(e.clipboardData?.getData('text'));
      if (!d) return;
      e.preventDefault();
      const from = d.length >= 14 ? 0 : i;   // a whole card number → from the first box
      if (from === 0) boxes.forEach((x) => { x.value = ''; });
      fillFrom(from, d.slice(0, 16)).focus();
    });
    box.addEventListener('blur', () => setTimeout(() => {   // focus left the four boxes → mask when complete
      if (!boxes.includes(document.activeElement) && cardComplete()) setMasked(true);
    }, 0));
  });
  if (f.id_no) f.id_no.oninput = () => { f.id_no.value = digitsOf(f.id_no.value).slice(0, 10); };
  if (f.password2) f.password2.oninput = () => { f.password2.value = digitsOf(f.password2.value).slice(0, 2); };
  const clearCard = () => { if (!boxes.length) return; boxes.forEach((x) => { x.value = ''; }); setMasked(false); f.mm.value = ''; f.yy.value = ''; f.id_no.value = ''; f.password2.value = ''; };
  refresh();

  // Idempotency key for this checkout attempt: a second request (another tab, a resend) gets the same order and is never charged twice.
  // A new key after an error, so a retry after a decline opens a new order instead of hitting the closed one.
  const newKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  let clientKey = newKey();
  const confirmHtml = (q, d, card) => {
    const rows = [
      ['상품', mode === 'ADDON' ? '사용자 · 프로젝트 추가' : mode === 'UPGRADE' ? `${label('TEAM')} 업그레이드` : `RELAI ${label(sel.plan)}`],
      ['결제 금액', `${n(q.total)}원 (VAT 포함)`],
      ...(mode === 'SUBSCRIBE' ? [['결제 주기', q.months === 12 ? '연간 · 12개월마다 자동 결제' : '월간 · 매월 같은 날 자동 결제']] : []),
      ['다음 결제', item(d, '다음 결제 예정') || '-'],
      ...(card ? [['결제 카드', maskCard(card.number)]] : [['결제 카드', '등록된 카드']]),
    ];
    return html`<dl class="sub-confirm">${raw(rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`).join(''))}</dl>
      <p class="hint" style="margin-top:10px">${mode === 'SUBSCRIBE' ? '결제하면 해지하기 전까지 다음 결제일마다 같은 카드로 자동 결제됩니다. 설정 › 플랜 · 결제에서 언제든 해지할 수 있어요.' : '등록한 카드로 지금 결제합니다.'}</p>`;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const withCard = boxes.length > 0;
    const c = withCard ? checkCard({ number: cardNumber(), mm: f.mm.value, yy: f.yy.value, id_no: f.id_no.value, password2: f.password2.value }) : {};
    const fields = { ...(c.fields || {}) };
    if (!f.agree.checked || (f.agree_pg && !f.agree_pg.checked)) fields.agree = '필수 항목에 모두 동의해 주세요.';
    showErr(fields);
    if (Object.keys(fields).length) return;
    if (!modeOpen) { clearCard(); return toast(open ? '이 변경은 아직 열리지 않았어요.' : NOT_OPEN); }   // not open: no request is sent
    if (!current) return toast('금액을 다시 불러온 뒤 시도해 주세요.');
    const btn = $('#sub-pay', root); btn.disabled = true;
    const snapshot = current;   // the confirm dialog shows exactly the quote whose hash is sent
    const ok = await confirmDialog({ title: '결제 정보를 확인해 주세요', bodyHtml: confirmHtml(snapshot.quote, snapshot.disclosure, c.card), confirm: `${n(snapshot.quote.total)}원 결제하기`, cancel: '취소' });
    if (!ok || !root.isConnected) { btn.disabled = false; return; }
    if (current !== snapshot) { btn.disabled = false; return toast('금액이 바뀌었어요. 확인한 뒤 다시 결제해 주세요.'); }
    const label0 = $('#sub-pay-amount', root).textContent; $('#sub-pay-amount', root).textContent = '결제하는 중…';
    try {
      const consent = { agree: true, disclosure_hash: snapshot.disclosure.hash, client_key: clientKey };
      if (mode === 'ADDON') { await api('POST', `/api/workspaces/${wid}/billing/addons`, { extra_users: sel.extra_users, extra_projects: sel.extra_projects, ...consent }); toast('추가했습니다. 한도가 바로 늘었어요.'); }
      else if (mode === 'UPGRADE') { await api('POST', `/api/workspaces/${wid}/billing/upgrade`, { plan: 'TEAM', ...consent }); toast(`${label('TEAM')} 플랜으로 바꿨습니다.`); }
      else { await api('POST', `/api/workspaces/${wid}/billing/recurring`, { ...sel, card: c.card, ...consent }); toast(`${label(sel.plan)} 플랜 결제가 완료됐습니다.`); }
      clearCard(); navigate('/app/settings/billing');
    } catch (err) {
      clearCard(); btn.disabled = false; clientKey = newKey(); $('#sub-pay-amount', root).textContent = label0;
      if (err.code === 'consent_stale') { await refresh(); f.agree.checked = false; }
      showErr(err.fields || {}); toast(Object.values(err.fields || {})[0] || err.message);
    }
  };
}
