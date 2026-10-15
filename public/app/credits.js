/* 설정 › AI 크레딧 (AI-credits-only billing §4): one wallet per workspace, readable by every member, bought by the OWNER.
 * Balance (purchased / free), this + last month, per feature, the price list, packs, and the full usage log with month / project /
 * user filters and a CSV (the monthly statement). Every ₩ shown is credits × credit_price_krw from the server. */
import { api } from './core/api.js';
import { $, html, raw, fmtDT } from './core/dom.js';
import { state } from './core/state.js';
import { toast, confirmDialog } from './shared/dialogs.js';

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const krw = (v) => `₩${n(v)}`;
const signed = (v) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');
const signedKrw = (v) => (v > 0 ? `+₩${n(v)}` : v < 0 ? `−₩${n(-v)}` : '₩0');
const day = (iso) => (iso ? fmtDT(iso).slice(0, 10) : '');
const CHECKOUT_MSG = { success: '결제가 완료되었습니다. 크레딧이 충전되었습니다.', canceled: '결제를 취소했습니다.', failed: '결제가 완료되지 않았습니다. 청구된 금액은 없습니다.', fake: '테스트 결제 화면입니다. 결제사 연동 후 실제 결제가 진행됩니다.' };

export async function creditsPage(main = $('#main')) {
  document.title = 'AI 크레딧 — RELAI';
  const wid = state.workspace.id;
  const qp = new URLSearchParams(location.search);
  if (qp.get('checkout')) { toast(CHECKOUT_MSG[qp.get('checkout')] || '결제를 처리하고 있습니다.'); history.replaceState(null, '', '/app/settings/credits'); }
  let s = (await api('GET', `/api/workspaces/${wid}/credits/summary`)).credits;
  const f = { month: s.this_month.month, project: '', user: '' };
  let led = null;
  const loadLedger = async () => { const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v)); led = await api('GET', `/api/workspaces/${wid}/credits/ledger?${p}`); };
  await loadLedger();

  const starterUses = () => { const p = Object.fromEntries(s.prices.map((x) => [x.feature, x.credits])); return `요구사항 추출 ${Math.floor(s.starter_credits / p.REQUIREMENT_EXTRACTION)}회 또는 질문 ${Math.floor(s.starter_credits / p.PROJECT_QA)}회`; };
  const head = () => html`<div class="page__head"><div><a class="link" href="/app/settings" data-link>← 설정</a><h1 style="margin-top:4px">AI 크레딧</h1></div>
    ${raw(s.can_buy ? '<a class="btn btn--primary" href="#cr-buy" id="cr-buy-top">크레딧 충전</a>' : '')}</div>`;
  const summary = () => {
    const tm = s.this_month; const lm = s.last_month;
    const used = tm.by_feature.filter((x) => x.runs > 0);
    return html`<div class="panel cr-sum ${s.low ? 'is-low' : ''}" id="cr-summary"><div class="panel__b">
      <div class="cr-kpis">
        <div class="cr-kpi"><span class="cr-kpi__l">잔액</span><b class="cr-kpi__v" id="cr-balance">${n(s.balance)} 크레딧</b><span class="cr-kpi__w">${krw(s.balance_krw)}</span>
          <small class="dim">구매 ${n(s.purchased_remaining)} · 무료 ${n(s.free_remaining)}${raw(s.reserved ? html` · 처리 중 ${n(s.reserved)}` : '')}</small></div>
        <div class="cr-kpi"><span class="cr-kpi__l">이번 달 사용 <small class="dim">(${tm.month})</small></span><b class="cr-kpi__v" id="cr-month">${n(tm.used)} 크레딧</b><span class="cr-kpi__w">${krw(tm.krw)}</span>
          <small class="dim">지난달 ${n(lm.used)} 크레딧 (${krw(lm.krw)})</small></div>
      </div>
      ${raw(s.empty ? html`<p class="cr-warn" role="status">크레딧이 없어 AI 기능을 쓸 수 없습니다. ${raw(s.can_buy ? '<a href="#cr-buy" class="link">크레딧 충전</a>' : 'Workspace 소유자에게 충전을 요청하세요.')}</p>`
        : s.low ? html`<p class="cr-warn" role="status">잔액이 ${n(s.low_balance_threshold)} 크레딧(${krw(s.low_balance_threshold * s.credit_price_krw)}) 아래입니다. ${raw(s.can_buy ? '<a href="#cr-buy" class="link">크레딧 충전</a>' : '소유자에게 충전을 요청하세요.')}</p>`
          : html`<p class="hint">잔액이 ${n(s.low_balance_threshold)} 크레딧(${krw(s.low_balance_threshold * s.credit_price_krw)}) 아래로 내려가면 소유자에게 메일로 알려 드립니다.</p>`)}
      ${raw(s.purchased_remaining === 0 && s.free_remaining > 0 ? html`<p class="cr-gift">무료 시작 크레딧 <b>${n(s.starter_credits)} 크레딧 (${krw(s.starter_credits * s.credit_price_krw)})</b>을 드렸습니다 — ${starterUses()}를 해 볼 수 있습니다.</p>` : '')}
      <p class="cr-feat"><span class="dim">이번 달 기능별</span> ${raw(used.length ? used.map((x) => html`<span class="cr-feat__i">${x.label} ${n(x.runs)}회 <b>${n(x.credits)}</b></span>`).join('<span class="dim">·</span>') : '<span class="dim">아직 사용한 AI 기능이 없습니다.</span>')}</p>
    </div></div>`;
  };
  const prices = () => html`<div class="panel" style="margin-top:16px"><div class="panel__h">AI 기능별 가격 <small class="dim" style="font-weight:400">1 크레딧 = ${krw(s.credit_price_krw)} (부가세 포함)</small></div><div class="panel__b">
    <table class="rtable cr-price"><thead><tr><th>기능</th><th class="num">크레딧</th><th class="num">금액</th></tr></thead><tbody>
    ${raw(s.prices.map((p) => html`<tr><td>${p.label}</td><td class="num">${n(p.credits)}</td><td class="num">${krw(p.krw)}</td></tr>`).join(''))}</tbody></table>
    <p class="hint" style="margin-top:8px">한 번 실행할 때마다 정해진 크레딧만 차감합니다. 실행 전에 가격을 보여 드리고, 실패한 요청은 차감하지 않습니다.</p></div></div>`;
  const buy = () => html`<div class="panel" style="margin-top:16px" id="cr-buy"><div class="panel__h">크레딧 충전</div><div class="panel__b">
    ${raw(!s.can_buy ? '<p class="hint">충전과 환불 요청은 Workspace 소유자가 할 수 있습니다.</p>'
      : !s.provider_available ? '<p class="hint">결제 기능 준비 중입니다. 운영자에게 문의해 주세요.</p>'
        : html`<div class="cr-packs">${raw(s.packs.map((p) => html`<button type="button" class="cr-pack" data-pack="${p.key}"><b>${krw(p.amount)}</b><span>${n(p.credits)} 크레딧</span><small>공급가액 ${krw(p.supply)} + 부가세 ${krw(p.vat)}</small></button>`).join(''))}</div>
          ${raw(state.user?.email_verified === false ? '<p class="hint">이메일 인증 후 충전할 수 있습니다.</p>' : '')}`)}
    <p class="hint" style="margin-top:10px">무료 크레딧을 먼저 쓰고 구매한 크레딧은 그다음에 씁니다. 구매한 크레딧은 ${s.purchased_valid_years}년간 유효하며 자동 결제되지 않습니다.
      환불: 구매 후 ${s.refund_policy.full_days}일 안에 쓰지 않은 상품은 전액, 그 밖의 미사용 구매 크레딧은 수수료 ${s.refund_policy.fee_pct}%를 뺀 금액을 돌려 드립니다. 무료 크레딧은 환불되지 않습니다.${s.sandbox ? ' (테스트 결제 환경)' : ''}</p>
    ${raw(s.can_buy && s.refundable > 0 ? html`<p style="margin-top:8px"><button type="button" class="link linkbtn" id="cr-refund">환불 요청</button> <small class="dim">환불 가능한 미사용 구매 크레딧 ${n(s.refundable)}</small></p>` : '')}</div></div>`;
  const opt = (v, label, cur) => html`<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  const log = () => {
    const fl = led.filters; const months = [...new Set([s.this_month.month, ...fl.months])].sort().reverse();
    const t = led.totals;
    const csv = `/api/workspaces/${wid}/credits/ledger.csv?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`;
    return html`<div class="panel" style="margin-top:16px" id="cr-log"><div class="panel__h">사용 내역</div>
      <div class="cr-filt"><select class="select select--sm" name="month" aria-label="월">${raw(opt('', '전체 기간', f.month))}${raw(months.map((m) => opt(m, m, f.month)).join(''))}</select>
        <select class="select select--sm" name="project" aria-label="프로젝트">${raw(opt('', '모든 프로젝트', f.project))}${raw(fl.projects.map((p) => opt(p.id, p.name, f.project)).join(''))}</select>
        <select class="select select--sm" name="user" aria-label="사용자">${raw(opt('', '모든 사용자', f.user))}${raw(fl.users.map((u) => opt(u.id, u.name, f.user)).join(''))}</select>
        <span class="panel__sp"></span><a class="btn btn--secondary btn--sm" href="${csv}" download id="cr-csv">CSV 내려받기</a></div>
      <p class="cr-total" id="cr-total">AI 사용 <b>${n(t.used)} 크레딧</b> (${krw(t.used_krw)})${raw(t.added ? html` · 충전·지급 +${n(t.added)} 크레딧` : '')} <small class="dim">· ${n(t.count)}건</small></p>
      <div class="rtable-wrap--in"><table class="rtable cr-log" style="margin:0"><thead><tr><th>일시</th><th>구분</th><th>프로젝트</th><th>사용자</th><th class="num">크레딧</th><th class="num">금액</th><th class="num">잔액</th></tr></thead><tbody>
      ${raw(led.rows.length ? led.rows.map((r) => html`<tr class="${r.credits === 0 ? 'is-zero' : ''}"><td class="dim">${fmtDT(r.at).slice(5)}</td>
        <td>${r.label}${raw(r.receipt_url ? html` <a class="link" href="${r.receipt_url}" target="_blank" rel="noopener noreferrer">영수증</a>` : '')}${raw(r.note && r.type !== 'PURCHASE' ? html` <small class="dim">${r.note}</small>` : '')}</td>
        <td>${r.project_name || '—'}</td><td>${r.user_name || '—'}</td><td class="num ${r.credits > 0 ? 'is-plus' : ''}">${signed(r.credits)}${raw(r.krw === null ? '' : html`<small class="cr-krw-m">${signedKrw(r.krw)}</small>`)}</td><td class="num">${r.krw === null ? '—' : signedKrw(r.krw)}</td><td class="num dim">${r.balance_after === null ? '—' : n(r.balance_after)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="dim" style="text-align:center;padding:18px">이 조건의 사용 내역이 없습니다.</td></tr>')}</tbody></table></div></div>`;
  };
  const draw = () => {
    main.innerHTML = html`<div class="page page--narrow page--credits">${raw(head())}
      ${raw(s.plan === 'EARLY' ? html`<p class="cr-early"><b>얼리 액세스</b> · ${day(s.early_access_until)}까지 RELAI 전체 기능 무료 — AI는 쓴 만큼만 크레딧으로 냅니다.</p>` : '')}
      ${raw(summary())}${raw(buy())}${raw(prices())}${raw(log())}</div>`;
    main.querySelectorAll('[data-pack]').forEach((b) => b.onclick = async () => {
      if (state.user?.email_verified === false) return toast('이메일 인증 후 충전할 수 있습니다.');
      b.disabled = true;
      try { const r = await api('POST', `/api/workspaces/${wid}/credits/checkout`, { pack: b.dataset.pack }); location.href = r.checkout_url; }
      catch (e) { b.disabled = false; toast(e.message); }
    });
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
