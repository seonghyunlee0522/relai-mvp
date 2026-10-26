/* 관리자 › 환불 관리 (/admin/refunds): 구독 해지·청약철회로 생긴 환불 건 (subscription_refunds).
 * The card is NOT cancelled automatically (REFUND_PARTIAL_ENABLED off): the operator cancels it in the NicePay console, then marks the
 * row 환불 완료 here (memo optional). A row marked by mistake can be put back to 대기 (only manual ones; NicePay-executed ones stay).
 * API: GET /api/billing/admin/subscription-refunds?status=…, POST …/:id/done { note } · …/:id/reopen (both audited). */
import { api } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast, confirmDialog } from '../shared/dialogs.js';
import { formDialog } from '../shared/forms.js';
import { chip, errorBlock, fmtD, head, n, qs, section, setQs, table } from './ui.js';

const STATUS = { REQUESTED: ['환불 대기', 'warn'], FAILED: ['자동 취소 실패', 'bad'], DONE: ['환불 완료', 'ok'] };
const KIND = { WITHDRAWAL: '청약철회', CANCEL: '해지 환불' };
const FILTERS = [['', '처리 필요'], ['DONE', '환불 완료'], ['ALL', '전체']];

export async function adminRefundsPage(main = $('#main')) {
  document.title = '환불 관리 — RELAI 관리자';
  const f = qs().status || '';
  main.innerHTML = html`<div class="apage">${raw(head('환불 관리'))}<div id="rf-body"><p class="hint">불러오는 중…</p></div></div>`;
  let d;
  try { d = await api('GET', `/api/billing/admin/subscription-refunds${f ? `?status=${encodeURIComponent(f)}` : ''}`); }
  catch (e) { $('#rf-body').innerHTML = errorBlock(e); return; }
  const rows = d.refunds || [];
  const tabs = html`<div class="afilters" id="rf-filters">${raw(FILTERS.map(([k, l]) => html`<button type="button" class="btn btn--sm ${k === f ? 'btn--primary' : 'btn--secondary'}" data-rf-filter="${k}">${l}</button>`).join(' '))}</div>`;
  const guide = html`<p class="hint" style="margin:8px 0 14px">구독 해지·청약철회가 일어나면 여기에 쌓입니다. 카드 취소는 자동으로 되지 않으니 <b>나이스페이 관리자에서 해당 거래(TID)를 취소</b>한 뒤 [환불 완료]로 표시하세요.
    처리 필요 <b id="rf-open-n">${n(d.open?.n || 0)}</b>건 · <b id="rf-open-amount">${n(d.open?.amount || 0)}원</b></p>`;
  const action = (r) => (r.status === 'DONE'
    ? html`<button type="button" class="link linkbtn" data-rf-reopen="${r.id}" style="width:auto">대기로 되돌리기</button>`
    : html`<button type="button" class="btn btn--primary btn--sm" data-rf-done="${r.id}">환불 완료</button>`);
  $('#rf-body').innerHTML = html`${raw(tabs)}${raw(guide)}${raw(section(`환불 대상 ${n(rows.length)}건`, table([
    { key: 'created_at', label: '해지 일시', w: 140, render: (r) => fmtD(r.created_at) },
    { key: 'workspace_name', label: '워크스페이스 · 소유자', w: 220, render: (r) => html`<a class="link" href="/admin/workspaces/${r.workspace_id}" data-link>${r.workspace_name}</a><br><small>${r.owner_name || '-'} · ${r.owner_email || '-'}</small>` },
    { key: 'goods_name', label: '결제 상품', w: 190, render: (r) => html`${r.goods_name || '-'}<br><small>${fmtD(r.paid_at)} 결제 · ${n(r.paid_amount)}원</small>` },
    { key: 'amount', label: '환불할 금액', w: 120, cls: 'num', render: (r) => html`<b>${n(r.amount)}원</b><br><small>${KIND[r.kind] || r.kind}</small>` },
    { key: 'provider_tid', label: '거래번호 (TID)', w: 200, render: (r) => html`<span class="mono" style="font-size:12px">${r.provider_tid || '-'}</span>` },
    { key: 'status', label: '상태', w: 150, render: (r) => html`${raw(chip(STATUS[r.status]?.[1] || 'muted', STATUS[r.status]?.[0] || r.status))}${raw(r.done_at ? html`<br><small>${fmtD(r.done_at)}</small>` : '')}${raw(r.failure_message ? html`<br><small class="dim">${r.failure_message}</small>` : '')}` },
    { key: 'id', label: '', w: 130, render: action },
  ], rows, { id: 'rf-tbl', empty: f === 'DONE' ? '완료된 환불이 없습니다.' : '처리할 환불이 없습니다.' })))}`;

  main.querySelectorAll('[data-rf-filter]').forEach((b) => { b.onclick = () => { setQs({ status: b.dataset.rfFilter }); adminRefundsPage(main); }; });
  main.querySelectorAll('[data-rf-done]').forEach((b) => { b.onclick = async () => {
    const r = rows.find((x) => x.id === b.dataset.rfDone);
    const v = await formDialog({ title: '환불 완료로 표시', body: html`<b>${r.workspace_name}</b> · ${n(r.amount)}원<br>나이스페이에서 카드 취소를 마쳤는지 확인하세요.`,
      fields: [{ name: 'note', label: '메모 (선택)', placeholder: '예: 10/26 나이스페이 관리자 전체취소' }], submit: (val) => val, confirm: '환불 완료' });
    if (!v) return;
    try { await api('POST', `/api/billing/admin/subscription-refunds/${encodeURIComponent(r.id)}/done`, { note: v.note || '' }); toast('환불 완료로 표시했습니다.'); adminRefundsPage(main); }
    catch (e) { toast(e.message); }
  }; });
  main.querySelectorAll('[data-rf-reopen]').forEach((b) => { b.onclick = async () => {
    if (!(await confirmDialog({ title: '환불 대기로 되돌릴까요?', body: '환불 완료 표시를 취소하고 처리 필요 목록으로 돌립니다.', confirm: '되돌리기' }))) return;
    try { await api('POST', `/api/billing/admin/subscription-refunds/${encodeURIComponent(b.dataset.rfReopen)}/reopen`, {}); toast('대기로 되돌렸습니다.'); adminRefundsPage(main); }
    catch (e) { toast(e.message); }
  }; });
}
