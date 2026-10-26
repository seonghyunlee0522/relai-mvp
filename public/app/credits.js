/* 설정 › AI 크레딧 (pricing v3 T2): one wallet per workspace, readable by every member, topped up by the OWNER on Pro / Team.
 * Balance by bucket (기본 월 크레딧 with its 소멸일 / 무료 / 구매), this + last month, per feature, the price list, the 충전 panel, and
 * the full usage log with month / project / user filters and a CSV (the monthly statement). 충전 (design.md §8.6): ₩10,000 steps
 * (chips + stepper) over the server-priced options — the browser computes no won amount — showing 결제 금액, 충전 크레딧, 대상
 * 워크스페이스 and 유효기간·환불 조건 before the card window. FREE (or Enterprise without a contract) → an upgrade CTA instead of the
 * button. Payments off → the panel still shows, but 결제 only says SUBSCRIBE_SOON and calls nothing; the 문의하기 link stays. */
import { api } from './core/api.js';
import { $, html, raw, fmtDT } from './core/dom.js';
import { state, oneTimeMode } from './core/state.js';
import { toast, confirmDialog } from './shared/dialogs.js';
import { isPhone, pcLine } from './core/device.js';
import { loadPromos, promoHtml } from './shared/promo.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { SUBSCRIBE_SOON } from './plans.js';

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const signed = (v) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');
/** Price-table names on this page (a NicePay review screen: no 'test' wording); the feature itself keeps its name elsewhere. */
const PRICE_LABEL = { TEST_GENERATION: 'AI 검증 시나리오 만들기' };
const CHECKOUT_MSG = { success: '결제가 완료되었습니다. 크레딧이 충전되었습니다.', canceled: '결제를 취소했습니다.', failed: '결제가 완료되지 않았습니다. 청구된 금액은 없습니다.', fake: '모의 결제로 처리했습니다. 결제사 연동 후 실제 결제가 진행됩니다.' };

/** 충전 amount picked per workspace (module scope, so a re-render keeps it). */
const chosen = new Map();

export async function creditsPage(main = $('#main')) {
  document.title = 'AI 크레딧 — RELAI';
  const wid = state.workspace.id;
  const qp = new URLSearchParams(location.search);
  if (qp.get('checkout')) { toast(CHECKOUT_MSG[qp.get('checkout')] || '결제를 처리하고 있습니다.'); history.replaceState(null, '', '/app/settings/credits'); }
  let s = (await api('GET', `/api/workspaces/${wid}/credits/summary`)).credits;
  const promos = await loadPromos('credits');   // 관리자 › 프로모션 (placement credits)
  const f = { month: s.this_month.month, project: '', user: '' };
  let led = null;
  const loadLedger = async () => { const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v)); led = await api('GET', `/api/workspaces/${wid}/credits/ledger?${p}`); };
  await loadLedger();

  const bucketLine = () => {
    const b = s.buckets || { plan: 0, promo: s.free_remaining, purchased: s.purchased_remaining };
    const parts = [];
    if (b.plan || s.plan_monthly_credits) parts.push(html`기본 ${n(b.plan)}${raw(b.plan && b.plan_expires_at ? html` <span class="dim">(${fmtDT(b.plan_expires_at).slice(0, 10)} 소멸)</span>` : '')}`);
    parts.push(html`무료 ${n(b.promo)}`); parts.push(html`구매 ${n(b.purchased)}`);
    return parts.join(' · ');
  };
  const starterUses = () => { const p = Object.fromEntries(s.prices.map((x) => [x.feature, x.credits])); return `요구사항 추출 ${Math.floor(s.starter_credits / p.REQUIREMENT_EXTRACTION)}회 또는 질문 ${Math.floor(s.starter_credits / p.PROJECT_QA)}회`; };
  const payOff = () => s.payments_enabled === false;   // v1: payments off (PAYMENTS_ENABLED) → no pack is sold, no 충전 anywhere (checkout 409 payments_disabled)
  const canTopUp = () => s.can_buy && s.ai_enabled !== false && !payOff();   // AI off server-side → no pack is sold (checkout 409 ai_disabled)
  const head = () => html`<div class="page__head"><div><a class="link" href="/app/settings" data-link>← 설정</a><h1 style="margin-top:4px">AI 크레딧</h1>${raw(s.can_buy && !payOff() ? pcLine('충전과 환불 요청은 PC에서 할 수 있습니다') : '')}</div>
    ${raw(canTopUp() && !isPhone() ? '<a class="btn btn--primary" href="#cr-buy" id="cr-buy-top">크레딧 충전</a>' : '')}</div>`;
  const summary = () => {
    const tm = s.this_month; const lm = s.last_month;
    const used = tm.by_feature.filter((x) => x.runs > 0);
    return html`<div class="panel cr-sum ${s.low ? 'is-low' : ''}" id="cr-summary"><div class="panel__b">
      <div class="cr-kpis">
        <div class="cr-kpi"><span class="cr-kpi__l">잔액</span><b class="cr-kpi__v" id="cr-balance">${n(s.balance)} 크레딧</b>
          <small class="dim" id="cr-buckets">${raw(bucketLine())}${raw(s.reserved ? html` · 처리 중 ${n(s.reserved)}` : '')}</small></div>
        <div class="cr-kpi"><span class="cr-kpi__l">이번 달 사용 <small class="dim">(${tm.month})</small></span><b class="cr-kpi__v" id="cr-month">${n(tm.used)} 크레딧</b>
          <small class="dim">지난달 ${n(lm.used)} 크레딧</small></div>
      </div>
      ${raw(s.empty ? html`<p class="cr-warn" role="status">크레딧이 없어 AI 기능을 쓸 수 없습니다. ${raw(canTopUp() ? '<a href="#cr-buy" class="link">크레딧 충전</a>' : s.can_buy ? '' : '워크스페이스 소유자에게 충전을 요청하세요.')}</p>`
        : s.low ? html`<p class="cr-warn" role="status">잔액이 ${n(s.low_balance_threshold)} 크레딧 아래입니다. ${raw(canTopUp() ? '<a href="#cr-buy" class="link">크레딧 충전</a>' : s.can_buy ? '' : '소유자에게 충전을 요청하세요.')}</p>`
          : html`<p class="hint">잔액이 ${n(s.low_balance_threshold)} 크레딧 아래로 내려가면 소유자에게 메일로 알려 드립니다.</p>`)}
      ${raw(payOff() || !s.provider_available || s.ai_enabled === false ? html`<p class="hint" data-credit-contact>크레딧이 더 필요하면 <a class="link" href="mailto:${LEGAL.contactEmail}?subject=${encodeURIComponent('RELAI AI 크레딧 문의')}">문의하기</a></p>` : '')}
      ${raw(s.plan === 'FREE' && s.purchased_remaining === 0 && s.free_remaining > 0 ? html`<p class="cr-gift">무료 시작 크레딧 <b>${n(s.starter_credits)} 크레딧</b>을 드렸습니다 — ${starterUses()}를 해 볼 수 있습니다.</p>` : '')}
      <p class="cr-feat"><span class="dim">이번 달 기능별</span> ${raw(used.length ? used.map((x) => html`<span class="cr-feat__i">${x.label} ${n(x.runs)}회 <b>${n(x.credits)}</b></span>`).join('<span class="dim">·</span>') : '<span class="dim">아직 사용한 AI 기능이 없습니다.</span>')}</p>
    </div></div>`;
  };
  const prices = () => html`<div class="panel" style="margin-top:16px"><div class="panel__h">AI 기능별 크레딧</div><div class="panel__b">
    <table class="rtable cr-price"><thead><tr><th>기능</th><th class="num">크레딧</th></tr></thead><tbody>
    ${raw(s.prices.map((p) => html`<tr><td>${PRICE_LABEL[p.feature] || p.label}</td><td class="num">${n(p.credits)}</td></tr>`).join(''))}</tbody></table>
    <p class="hint" style="margin-top:8px">한 번 실행할 때마다 정해진 크레딧만 차감합니다. 실행 전에 가격을 보여 드리고, 실패한 요청은 차감하지 않습니다.</p></div></div>`;
  // 충전 amount: an index into the server-priced options (₩10,000 steps up to the per-order maximum).
  const opts = () => s.topup?.options || [];
  // The chosen amount survives a re-render of the page (window resize, device switch) within the same workspace.
  let pick = Math.max(0, opts().findIndex((o) => o.amount === chosen.get(wid)));
  const cur = () => opts()[pick] || opts()[0];
  const refundText = () => (s.refund_policy.rule === 'v2'
    ? `충전 후 ${s.refund_policy.full_days}일 안에 쓰지 않은 충전분은 전액, 그 밖의 미사용 구매 크레딧은 수수료 ${s.refund_policy.fee_pct}%를 뺀 금액`
    : '사용하지 않은 구매 크레딧 전액(수수료 없음, 일부 사용한 경우 포함)');
  const topupForm = () => {
    const o = cur();
    return html`<div class="cr-topup" id="cr-topup">
      <div class="cr-chips" role="group" aria-label="충전 금액">${raw((s.topup.presets || []).map((a) => html`<button type="button" class="cr-amt ${o.amount === a ? 'is-on' : ''}" aria-pressed="${o.amount === a}" data-amount="${a}">${n(a)}원</button>`).join(''))}</div>
      <div class="cr-stepper"><button type="button" class="btn btn--secondary btn--sm" id="cr-minus" aria-label="10,000원 줄이기" ${pick <= 0 ? 'disabled' : ''}>−</button>
        <b id="cr-amount">${n(o.amount)}원</b>
        <button type="button" class="btn btn--secondary btn--sm" id="cr-plus" aria-label="10,000원 늘리기" ${pick >= opts().length - 1 ? 'disabled' : ''}>+</button>
        <small class="dim">${n(s.topup.step)}원 단위 · 한 번에 최대 ${n(s.topup.max)}원</small></div>
      <table class="rtable cr-quote" id="cr-quote"><tbody>
        <tr><th>결제 금액</th><td><b>${n(o.amount)}원</b> <small class="dim">(공급가액 ${n(o.supply)}원 + 부가세 ${n(o.vat)}원)</small></td></tr>
        <tr><th>충전 크레딧</th><td><b>${n(o.credits)} 크레딧</b></td></tr>
        <tr><th>대상 워크스페이스</th><td>${s.workspace_name || state.workspace?.name || ''}</td></tr>
        <tr><th>유효기간·환불</th><td>충전일부터 ${s.purchased_valid_years}년 · ${refundText()}</td></tr></tbody></table>
      <p class="cr-method" id="cr-method"><span class="dim">결제 수단</span> <label><input type="radio" name="cr-method" value="card" checked> 신용카드</label> <small class="dim">· 나이스페이먼츠 결제창이 열립니다 · 자동 결제되지 않습니다</small></p>
      <button type="button" class="btn btn--primary" id="cr-pay">${n(o.amount)}원 결제하고 충전</button>
      ${raw(state.user?.email_verified === false && !payOff() ? '<p class="hint">이메일 인증 후 충전할 수 있습니다.</p>' : '')}</div>`;
  };
  const gate = () => (s.topup?.reason === 'contract_required'
    ? html`<p class="hint" data-topup-gate>Enterprise 크레딧 충전은 계약에 따라 열립니다. <a class="link" href="mailto:${LEGAL.contactEmail}?subject=${encodeURIComponent('RELAI Enterprise 크레딧 충전')}">문의하기</a></p>`
    : html`<p class="cr-upsell" data-topup-gate>Pro로 업그레이드하면 충전할 수 있어요. <a class="btn btn--primary btn--sm" href="${s.topup?.upgrade_url || '/app/billing/plans'}" data-link>요금제 보기</a></p>`);
  const buy = () => html`<div class="panel" style="margin-top:16px" id="cr-buy"><div class="panel__h">크레딧 충전</div><div class="panel__b">
    ${raw(s.topup && !s.topup.allowed ? gate()
      : !s.can_buy ? '<p class="hint">충전과 환불 요청은 워크스페이스 소유자가 할 수 있습니다.</p>'
        : isPhone() ? '<p class="hint" data-phone-pay>결제는 PC에서 할 수 있습니다.</p>'
          : topupForm())}
    <p class="hint" style="margin-top:10px">크레딧은 기본 월 크레딧 → 무료 크레딧 → 구매 크레딧 순서로 씁니다. 기본 월 크레딧은 지급 주기가 끝나면 남은 만큼 소멸합니다.
      구매 크레딧은 ${s.purchased_valid_years}년간 유효하고, ${oneTimeMode() || s.one_time_mode ? '이용권 기간이 끝나 Free가 되어도 남은 만큼 쓸 수 있습니다. 결제는 신용카드 1회 결제이며 자동 결제는 없습니다.' : '구독이 끝나 Free가 되어도 남은 만큼 쓸 수 있습니다.'}
      환불: ${refundText()}을 돌려 드립니다. 무료·플랜 기본 제공·프로모션 크레딧은 환불되지 않습니다.${s.sandbox ? ' (샌드박스 결제 환경)' : ''}</p>
    ${raw(s.can_buy && s.refundable > 0 && !isPhone() ? html`<p style="margin-top:8px"><button type="button" class="link linkbtn" id="cr-refund">환불 요청</button> <small class="dim">환불 가능한 미사용 구매 크레딧 ${n(s.refundable)}</small></p>` : '')}</div></div>`;
  const opt = (v, label, cur) => html`<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  const log = () => {
    const fl = led.filters; const months = [...new Set([s.this_month.month, ...fl.months])].sort().reverse();
    const t = led.totals;
    const csv = `/api/workspaces/${wid}/credits/ledger.csv?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`;
    return html`<div class="panel" style="margin-top:16px" id="cr-log"><div class="panel__h">사용 내역</div>
      <div class="cr-filt" data-phone-ok><select class="select select--sm" name="month" aria-label="월">${raw(opt('', '전체 기간', f.month))}${raw(months.map((m) => opt(m, m, f.month)).join(''))}</select>
        <select class="select select--sm" name="project" aria-label="프로젝트">${raw(opt('', '모든 프로젝트', f.project))}${raw(fl.projects.map((p) => opt(p.id, p.name, f.project)).join(''))}</select>
        <select class="select select--sm" name="user" aria-label="사용자">${raw(opt('', '모든 사용자', f.user))}${raw(fl.users.map((u) => opt(u.id, u.name, f.user)).join(''))}</select>
        <span class="panel__sp"></span><a class="btn btn--secondary btn--sm" href="${csv}" download id="cr-csv">CSV 내려받기</a></div>
      <p class="cr-total" id="cr-total">AI 사용 <b>${n(t.used)} 크레딧</b>${raw(t.added ? html` · 충전·지급 +${n(t.added)} 크레딧` : '')} <small class="dim">· ${n(t.count)}건</small></p>
      <div class="rtable-wrap--in"><table class="rtable cr-log" style="margin:0"><thead><tr><th>일시</th><th>구분</th><th>프로젝트</th><th>사용자</th><th class="num">크레딧</th><th class="num">잔액</th></tr></thead><tbody>
      ${raw(led.rows.length ? led.rows.map((r) => html`<tr class="${r.credits === 0 ? 'is-zero' : ''}"><td class="dim">${fmtDT(r.at).slice(5)}</td>
        <td>${r.label}${raw(r.receipt_url ? html` <a class="link" href="${r.receipt_url}" target="_blank" rel="noopener noreferrer">영수증</a>` : '')}${raw(r.note && r.type !== 'PURCHASE' ? html` <small class="dim">${r.note}</small>` : '')}</td>
        <td>${r.project_name || '—'}</td><td>${r.user_name || '—'}</td><td class="num ${r.credits > 0 ? 'is-plus' : ''}">${signed(r.credits)}</td><td class="num dim">${r.balance_after === null ? '—' : n(r.balance_after)}</td></tr>`).join('')
        : '<tr><td colspan="6" class="dim" style="text-align:center;padding:18px">이 조건의 사용 내역이 없습니다.</td></tr>')}</tbody></table></div></div>`;
  };
  const draw = () => {
    main.innerHTML = html`<div class="page page--narrow page--credits">${raw(head())}
      ${raw(html`<div class="cr-promo">${raw(promoHtml(promos, { placement: 'credits' }))}</div>`)}
      ${raw(summary())}${raw((payOff() && isPhone()) || (s.can_buy && !isPhone() && (s.ai_enabled === false || (!payOff() && !s.provider_available))) ? '' : buy())}${raw(prices())}${raw(log())}
      ${raw(legalFooterHtml(LEGAL))}</div>`;
    const setPick = (i) => { pick = Math.max(0, Math.min(opts().length - 1, i)); chosen.set(wid, cur()?.amount); const box = $('#cr-topup'); if (box) { box.outerHTML = topupForm(); bindTopup(); } };
    const bindTopup = () => {
      main.querySelectorAll('[data-amount]').forEach((b) => b.onclick = () => setPick(opts().findIndex((o) => o.amount === Number(b.dataset.amount))));
      const minus = $('#cr-minus'); if (minus) minus.onclick = () => setPick(pick - 1);
      const plus = $('#cr-plus'); if (plus) plus.onclick = () => setPick(pick + 1);
      const pay = $('#cr-pay'); if (pay) pay.onclick = async () => {
        if (payOff()) return toast(SUBSCRIBE_SOON);   // payments off: the panel shows, no checkout call
        if (state.user?.email_verified === false) return toast('이메일 인증 후 충전할 수 있습니다.');
        pay.disabled = true;
        try { const r = await api('POST', `/api/workspaces/${wid}/credits/checkout`, { amount: cur().amount }); location.href = r.checkout_url; }
        catch (e) { pay.disabled = false; toast(e.message); }
      };
    };
    bindTopup();
    const top = $('#cr-buy-top'); if (top) top.onclick = (e) => { e.preventDefault(); $('#cr-buy')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    main.querySelectorAll('.cr-filt select').forEach((sel) => sel.onchange = async () => { f[sel.name] = sel.value; await loadLedger(); draw(); });
    const rf = $('#cr-refund'); if (rf) rf.onclick = async () => {
      if (!(await confirmDialog({ title: '미사용 크레딧 환불을 요청할까요?', body: `환불 가능한 미사용 구매 크레딧은 ${n(s.refundable)}입니다. 요청을 받으면 운영자가 확인 후 결제한 카드로 환불해 드립니다.`, confirm: '환불 요청' }))) return;
      try { await api('POST', `/api/workspaces/${wid}/credits/refund-request`, {}); toast('환불 요청을 보냈습니다. 확인 후 메일로 안내해 드립니다.'); } catch (e) { toast(e.message); }
    };
    if (location.hash === '#cr-buy') $('#cr-buy')?.scrollIntoView({ block: 'start' });
  };
  draw();
}
