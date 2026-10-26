/* 관리자 › 프로모션 코드 (/admin/promo-codes): 코드 · 혜택 · 기간 · 사용 · 상태, [코드 만들기], [중지] / [다시 시작].
 * Separate from 관리자 › 프로모션 (display banners). API: server/billing/promo-codes.js. */
import { api } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from '../shared/dialogs.js';
import { formDialog } from '../shared/forms.js';
import { chip, errorBlock, head, n, section, table } from './ui.js';

const STATUS = { ACTIVE: ['진행', 'ok'], SCHEDULED: ['예정', 'act'], ENDED: ['종료', 'muted'], USED_UP: ['소진', 'muted'], STOPPED: ['중지', 'warn'] };
const period = (c) => (c.starts_on || c.ends_on ? `${(c.starts_on || '').slice(5).replace('-', '.') || ''} ~ ${(c.ends_on || '').slice(5).replace('-', '.') || ''}`.trim() : '상시');

export async function adminPromoCodesPage(main = $('#main')) {
  document.title = '프로모션 코드 — RELAI 관리자';
  main.innerHTML = html`<div class="apage">${raw(head('프로모션 코드', '<button type="button" class="btn btn--primary btn--sm" id="pc-new">+ 코드 만들기</button>'))}<div id="pc-body"><p class="hint">불러오는 중…</p></div></div>`;
  let d;
  try { d = await api('GET', '/api/billing/admin/promo-codes'); } catch (e) { $('#pc-body').innerHTML = errorBlock(e); return; }
  const codes = d.codes || [];
  $('#pc-body').innerHTML = html`<p class="hint" style="margin:0 0 12px">워크스페이스당 1번만 쓸 수 있어요. 할인 코드는 요금제 구매 창에서, 무료 기간·크레딧 코드는 설정 › 요금제 › 코드 등록에서 입력해요.</p>
    ${raw(section(`코드 ${n(codes.length)}개`, table([
      { key: 'code', label: '코드', w: 180, render: (c) => html`<span class="mono">${c.code}</span>` },
      { key: 'benefit', label: '혜택', w: 200 },
      { key: 'period', label: '기간', w: 160, render: period },
      { key: 'used', label: '사용', w: 110, cls: 'num', render: (c) => (c.max_uses ? `${n(c.used_count)} / ${n(c.max_uses)}` : n(c.used_count)) },
      { key: 'status', label: '상태', w: 90, render: (c) => chip(STATUS[c.status]?.[1] || 'muted', STATUS[c.status]?.[0] || c.status) },
      { key: 'id', label: '', w: 110, render: (c) => (c.active ? html`<button type="button" class="btn btn--secondary btn--sm" data-pc-stop="${c.id}">중지</button>`
        : html`<button type="button" class="btn btn--secondary btn--sm" data-pc-start="${c.id}">다시 시작</button>`) },
    ], codes, { id: 'pc-tbl', empty: '아직 만든 코드가 없어요.' })))}`;

  $('#pc-new').onclick = async () => {
    const v = await formDialog({ title: '코드 만들기', confirm: '만들기', fields: [
      { name: 'code', label: '코드', required: true, placeholder: 'LAUNCH20', hint: '영문 대문자·숫자·하이픈 3~30자 (대소문자 구분 없이 입력받아요)' },
      { name: 'kind', label: '혜택', type: 'select', value: 'PERCENT', options: [['PERCENT', '할인율 (%)'], ['AMOUNT', '정액 할인 (원)'], ['FREE_MONTHS', '무료 기간 (개월)'], ['CREDITS', '크레딧 지급']] },
      { name: 'value', label: '혜택 값', required: true, placeholder: '20', hint: '할인율이면 %, 정액이면 원, 무료 기간이면 개월, 크레딧이면 크레딧 수' },
      { name: 'plan', label: '무료 기간 요금제', type: 'select', value: 'PRO', options: [['PRO', 'Pro'], ['TEAM', 'Team']], hint: '무료 기간 코드일 때만 써요' },
      { name: 'starts_on', label: '시작일', type: 'date' },
      { name: 'ends_on', label: '종료일', type: 'date' },
      { name: 'max_uses', label: '사용 한도', placeholder: '비우면 제한 없음' },
    ], submit: async (val) => api('POST', '/api/billing/admin/promo-codes', { ...val, value: Number(val.value), max_uses: val.max_uses ? Number(val.max_uses) : null }) });
    if (!v) return;
    toast(`${v.code?.code || '코드'}를 만들었어요.`);
    adminPromoCodesPage(main);
  };
  const act = (sel, action, msg) => main.querySelectorAll(sel).forEach((b) => { b.onclick = async () => {
    try { await api('POST', `/api/billing/admin/promo-codes/${encodeURIComponent(b.dataset[action === 'stop' ? 'pcStop' : 'pcStart'])}/${action}`, {}); toast(msg); adminPromoCodesPage(main); } catch (e) { toast(e.message); }
  }; });
  act('[data-pc-stop]', 'stop', '코드를 중지했어요.');
  act('[data-pc-start]', 'start', '코드를 다시 시작했어요.');
}
