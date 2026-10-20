/* 관리자 › 결제 › 서비스 결제 (/pricing orders from buyers without a RELAI account). Read-only; TIDs come masked from the API. */
import { html, raw } from '../core/dom.js';
import { adminApi, chip, errorBlock, fmtD, n, section, table } from './ui.js';

const KO = { PAID: '결제 완료', PENDING: '대기', FAILED: '실패', REFUNDED: '환불' };
export async function serviceOrdersSection(el) {
  if (!el) return;
  let d; try { d = await adminApi('service-orders', { size: 50 }); } catch (e) { el.innerHTML = errorBlock(e); return; }
  el.innerHTML = section(raw(html`서비스 결제 <span class="hint">/pricing · 로그인 없이 결제한 주문 ${n(d.total)}건</span>`), table([
    { key: 'created_at', label: '일시', w: 150, render: (o) => fmtD(o.created_at) }, { key: 'goods_name', label: '상품', w: 220, cls: 'ttl' },
    { key: 'buyer_name', label: '구매자', w: 140, render: (o) => html`${o.buyer_name}${raw(o.buyer_company ? html`<br><small>${o.buyer_company}</small>` : '')}` },
    { key: 'buyer_email', label: '이메일', w: 200 }, { key: 'buyer_phone', label: '연락처', w: 130 },
    { key: 'amount', label: '금액', w: 110, cls: 'num', render: (o) => `₩${n(o.amount)}` }, { key: 'status', label: '상태', w: 100, render: (o) => chip(o.status, KO[o.status] || o.status) },
    { key: 'id', label: '주문번호', w: 230, render: (o) => html`<span class="mono">${o.id}</span>` }, { key: 'provider_tid_masked', label: 'TID (일부 가림)', w: 170, render: (o) => html`<span class="mono">${o.provider_tid_masked || '-'}</span>` },
  ], d.items, { id: 'svc-orders-tbl', empty: '서비스 결제 주문이 없습니다.' }));
}
