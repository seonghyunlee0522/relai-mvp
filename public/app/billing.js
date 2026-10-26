/* 설정 › 플랜 · 결제 — 워크스페이스 Billing (pricing v3, founder spec §4.2, design.md §8.5).
 * One screen over GET …/billing (v3 shape): current plan + cycle, next payment date + amount, active projects / users against limits
 * (pending invites hold a seat), AI credits (total + 기본 / 가입 / 유상 buckets, 기본 소멸일), scheduled changes, credit history,
 * payment history (OWNER), and the actions: 요금제 변경, 추가 사용자·프로젝트, AI 크레딧 충전 (Free → Pro 안내 instead), 해지.
 * No amount is computed here: every 원 figure is a server field (next_payment_amount, orders) or the catalogue.
 * Credits are a usage unit (batch7 #7): no won next to a credit number on this page.
 * T2/T3 fields not live yet render as absent, never as fake zeros: credits.plan/promo/purchased === null → total only;
 * scheduled[] empty → section hidden; a scheduled change is cancellable only when the server sends its cancel_url (T3). */
import { api } from './core/api.js';
import { $, html, raw, esc } from './core/dom.js';
import { state } from './core/state.js';
import { confirmDialog, toast } from './shared/dialogs.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { wsLabel } from './shared/workspace-name.js';

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const krw = (v) => `${n(v)}원`;
const day = (iso) => { if (!iso) return '-'; const d = new Date(iso); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
/** '요금테스트님의 워크스페이스' stays as is; '한빛' → '한빛 워크스페이스'. */
const wsName = wsLabel;
const CYCLE = { MONTHLY: '월간', ANNUAL: '연간' };
/* 구독 해지 · Free 전환 정책 (founder 2026-10-21). Text comes from the server (billing.cancel_policy = email/templates.js FREE_POLICY / FREE_KEEP). */
const POLICY_FALLBACK = { free: '구독이 끝나 Free 플랜이 되면 생성일이 가장 최근인 프로젝트 1개만 계속 편집할 수 있고, 나머지 프로젝트는 자동으로 조회 전용이 됩니다(편집할 프로젝트는 선택할 수 없습니다).',
  keep: '해지만으로 프로젝트 데이터는 삭제되지 않으며 모든 프로젝트를 계속 조회·내보내기할 수 있습니다. 다시 구독하거나 플랜을 올리면 요금제 한도만큼 최근 프로젝트부터 편집 권한이 돌아옵니다. 워크스페이스 삭제는 해지와 별도로 설정에서 따로 진행합니다.' };
const policy = (b) => ({ ...POLICY_FALLBACK, ...(b.cancel_policy || {}) });
const STATUS = { ACTIVE: '이용 중', PAST_DUE: '결제 실패 · 재시도 중', CANCELED: '해지됨', EXPIRED: '만료' };
const CHANGE = { DOWNGRADE: '요금제 변경', CYCLE: '결제 주기 변경', ADDON_REDUCE: '추가 이용 줄이기', CANCEL: '해지' };
const PLAN_LABEL = { FREE: 'Free', PRO: 'Pro', TEAM: 'Team', ENTERPRISE: 'Enterprise' };

/** One usage meter: used / limit (null = 협의/무제한). */
const meter = (id, label, used, limit, extra = '') => {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = limit && used > limit ? 'is-over' : pct >= 90 ? 'is-hot' : pct >= 80 ? 'is-warm' : '';
  return html`<div class="bl-meter ${tone}" id="${id}"><div class="bl-meter__h"><span>${label}</span><b>${n(used)} / ${limit === null || limit === undefined ? '협의' : n(limit)}</b></div>
    <div class="bl-meter__bar"><i style="width:${limit ? pct : 0}%"></i></div>${raw(extra ? `<p class="bl-meter__x">${extra}</p>` : '')}</div>`;
};

/** Plan summary panel. */
function planPanel(b) {
  const paid = b.plan === 'PRO' || b.plan === 'TEAM';
  const label = b.plan_label || PLAN_LABEL[b.plan] || b.plan;
  const cycleLabel = b.flags?.one_time && paid && !b.auto_renew ? '1개월 이용권' : CYCLE[b.cycle] || b.cycle;   // 단건결제 모드
  const rows = [['요금제', html`<b>${label}</b>${raw(b.cycle ? html` <span class="chip chip--muted">${cycleLabel}</span>` : '')}`]];
  if (paid && b.status) rows.push(['상태', html`${STATUS[b.status] || b.status}`]);
  const end = b.subscription?.current_period_end;
  if (paid && b.next_payment_at) {
    rows.push(['다음 결제일', html`${day(b.next_payment_at)}`]);
    rows.push(['다음 결제 예정 금액', b.next_payment_amount === null || b.next_payment_amount === undefined ? '-' : html`<b>${krw(b.next_payment_amount)}</b> <small class="dim">VAT 포함${raw(b.addons?.extra_users || b.addons?.extra_projects ? ' · 추가 이용 포함' : '')}</small>`]);
  } else if (paid) {
    rows.push(['이용 기간', html`${day(b.subscription?.current_period_start)} ~ ${day(end)}`]);
    rows.push(['자동 갱신', html`<span>자동 결제되지 않아요</span> <small class="dim">· ${day(end)} 이후 Free로 전환돼요. 최근 프로젝트 1개만 편집, 나머지는 조회 전용 · 데이터는 삭제되지 않아요</small>`]);
  } else if (b.plan === 'FREE') rows.push(['결제', esc('결제 정보 없이 이용 중')]);
  if (paid && (b.addons?.extra_users || b.addons?.extra_projects)) rows.push(['추가 이용', esc([b.addons.extra_users ? `사용자 ${n(b.addons.extra_users)}명` : '', b.addons.extra_projects ? `프로젝트 ${n(b.addons.extra_projects)}개` : ''].filter(Boolean).join(' · '))]);
  return html`<div class="panel bl-panel" id="bl-plan"><div class="panel__h">현재 요금제</div><div class="panel__b"><dl class="info">${raw(rows.map(([k, v]) => html`<dt>${k}</dt><dd>${raw(v)}</dd>`).join(''))}</dl></div></div>`;
}

function usagePanel(b) {
  const u = b.usage || {}; const l = b.limits || {};
  const seatsLeft = u.seats_left === null || u.seats_left === undefined ? '' : `초대 대기 ${n(u.pending_invites)}명 포함 · 남은 자리 ${n(u.seats_left)}명`;
  return html`<div class="panel bl-panel" id="bl-usage"><div class="panel__h">사용량</div><div class="panel__b">
    ${raw(meter('bl-projects', '활성 프로젝트', u.projects_active ?? 0, l.projects, '완료·보관한 프로젝트는 포함하지 않아요'))}
    ${raw(meter('bl-users', '사용자', (u.members ?? 0) + (u.pending_invites ?? 0), l.users, seatsLeft))}
  </div></div>`;
}

function creditsPanel(b) {
  const c = b.credits || {};
  const split = c.plan !== null && c.plan !== undefined;
  const row = (id, k, v, note) => html`<div class="bl-bucket" id="${id}"><span>${k}</span><b>${n(v)}</b>${raw(note ? `<small class="dim">${esc(note)}</small>` : '')}</div>`;
  const free = b.plan === 'FREE';
  return html`<div class="panel bl-panel" id="bl-credits"><div class="panel__h">AI 크레딧<a class="btn btn--ghost btn--sm" href="/app/settings/credits" data-link>사용 내역 전체</a></div><div class="panel__b">
    <p class="bl-total"><span>사용 가능</span><b id="bl-credit-total">${n(c.total)}</b><small>크레딧</small></p>
    ${raw(split ? html`<div class="bl-buckets">
      ${raw(row('bl-b-plan', '기본 크레딧', c.plan, c.plan_expires_at ? `${day(c.plan_expires_at)} 소멸 · 이월 없음` : '매월 지급 · 이월 없음'))}
      ${raw(row('bl-b-promo', '가입·프로모션', c.promo, ''))}
      ${raw(row('bl-b-purchased', '유상(충전)', c.purchased, '충전일부터 5년'))}
    </div><p class="hint">기본 → 가입·프로모션 → 유상 순서로 차감돼요.</p>` : '')}
    ${raw(free ? '<p class="hint" id="bl-free-credits">Free는 처음 한 번 200 크레딧을 드리고, 매월 지급이나 충전은 없어요. Pro로 바꾸면 매월 1,000 크레딧을 받고 필요한 만큼 충전할 수 있어요.</p>' : '')}
    <div id="bl-ledger"></div>
  </div></div>`;
}

function scheduledPanel(b) {
  const list = (b.scheduled || []).filter(Boolean);
  if (!list.length) return '';
  return html`<div class="panel bl-panel" id="bl-scheduled"><div class="panel__h">예약된 변경</div><div class="panel__b"><ul class="bl-list">
    ${raw(list.map((c, i) => html`<li><span><b>${CHANGE[c.kind] || c.kind}</b>${raw(c.to ? html` → ${PLAN_LABEL[c.to] || CYCLE[c.to] || c.to}` : '')} <small class="dim">${day(c.effective_at)} 적용</small></span>
      ${raw(b.can_manage && c.cancel_url ? html`<button class="btn btn--ghost btn--sm" data-phone-ok data-sched-cancel="${i}">예약 취소</button>` : '')}</li>`).join(''))}
  </ul><p class="hint">예약된 변경은 이용 기간이 끝나는 날 적용되고, 이미 결제한 기간에는 다시 청구하지 않아요.</p></div></div>`;
}

function overLimitBanner(b) {
  const o = b.over_limit; if (!o) return '';
  // over_limit = { projects, members }: how many are over the limit (server/billing/limits.js overLimit);
  // read_only_projects = { limit, editable[], read_only[] }: which projects stay editable (newest by 생성일) and which are 조회 전용
  const ro = b.read_only_projects;
  const parts = [o.projects ? `활성 프로젝트 ${n(o.projects)}개` : '', o.members ? `사용자 ${n(o.members)}명` : ''].filter(Boolean);
  const names = (list) => list.map((p) => html`<a class="link" href="/app/projects/${p.id}" data-link>${p.name}</a>`).join(', ');
  const roHtml = ro ? html`<p id="bl-ro">편집 가능: ${raw(names(ro.editable))} <small class="dim">(생성일이 가장 최근인 ${n(ro.limit)}개)</small><br>조회 전용 ${n(ro.read_only.length)}개: ${raw(names(ro.read_only))}</p>` : '';
  const members = o.members ? html`<p>사용자가 한도를 ${n(o.members)}명 넘어 새 초대는 할 수 없어요. 구성원을 줄이거나 요금제를 올려 주세요.</p>` : '';
  return html`<div class="bl-over" id="bl-over" role="status"><b>한도를 넘었어요 — 데이터는 그대로예요.</b>
    <p>한도 초과: ${parts.join(' · ')}. ${o.projects ? '생성일이 가장 최근인 프로젝트만 편집할 수 있고 나머지는 조회 전용이에요(조회·내보내기는 계속 가능). 다시 구독하거나 요금제를 올리면 한도만큼 최근 프로젝트부터 편집 권한이 돌아와요.' : ''}</p>${raw(roHtml)}${raw(members)}</div>`;
}

/** 해지 · 데이터 보관 정책 (founder 2026-10-21): always on the Billing page of a paid plan, and in both cancel dialogs. */
function policyPanel(b) {
  const paid = b.plan === 'PRO' || b.plan === 'TEAM';
  if (!paid) return '';
  const p = policy(b);
  if (b.flags?.one_time && !b.auto_renew) {   // 단건결제 모드: a 1개월 이용권 has nothing to cancel
    return html`<div class="panel bl-panel" id="bl-policy"><div class="panel__h">이용 기간이 끝나면 어떻게 되나요?</div><div class="panel__b">
    <ul class="bl-list"><li>1개월 이용권은 자동으로 다시 결제되지 않아요. 계속 쓰려면 요금제 화면에서 이용권을 다시 구매하면 1개월이 더해져요.</li><li>결제 후 7일 이내이고 결제 후 서비스를 이용하지 않았다면(AI 사용, 프로젝트 생성, 프로젝트 입력·수정·삭제 없음) 결제 금액 전액을 환불해요. 그 외에는 환불 없이 이용 기간이 끝날 때까지 써요.</li><li>${p.free.replace('구독이 끝나', '이용 기간이 끝나')}</li></ul></div></div>`;
  }
  return html`<div class="panel bl-panel" id="bl-policy"><div class="panel__h">해지하면 어떻게 되나요?</div><div class="panel__b">
    <ul class="bl-list"><li>해지하면 다음 자동결제가 멈추고, 이미 결제한 기간이 끝날 때까지 지금 요금제를 그대로 써요.</li><li>결제 후 7일 이내이고 결제 후 서비스를 이용하지 않았다면(AI 사용, 프로젝트 생성, 프로젝트 입력·수정·삭제 없음) 결제 금액 전액을 환불해요. 그 외에는 환불 없이 이용 기간이 끝날 때까지 쓰고, 다음 결제는 되지 않아요.</li><li>${p.free}</li><li>${p.keep}</li></ul></div></div>`;
}

function actionsPanel(b) {
  if (!b.can_manage) return html`<p class="hint" id="bl-owner-only">요금제 변경·결제·해지는 워크스페이스 소유자만 할 수 있어요.</p>`;
  const paid = b.plan === 'PRO' || b.plan === 'TEAM';
  const f = b.flags || {};
  const s = b.subscription;
  const canCancel = paid && s && ['ACTIVE', 'PAST_DUE'].includes(s.status) && s.auto_renew && !s.cancel_at_period_end;
  const canRefund = paid && s && ['ACTIVE', 'PAST_DUE'].includes(s.status) && Boolean(b.refund_quote_url) && Boolean(b.refund?.eligible);   // 7일 이내 미사용만
  const btns = [
    html`<a class="btn btn--primary btn--sm" id="bl-change" href="/app/billing/plans" data-link>${b.plan === 'FREE' ? '요금제 살펴보기' : '요금제 변경'}</a>`,
    paid && f.addons ? html`<a class="btn btn--secondary btn--sm" id="bl-addon" href="/app/billing/subscribe?addon=1" data-link>사용자 · 프로젝트 추가</a>` : '',
    paid || b.plan === 'ENTERPRISE' || f.one_time ? html`<a class="btn btn--secondary btn--sm" id="bl-topup" href="/app/settings/credits#cr-buy" data-link>AI 크레딧 충전</a>` : '',
    canCancel ? html`<button class="btn btn--ghost btn--sm is-danger" id="bl-cancel" data-phone-ok>해지</button>` : '',
    // 이용약관 제11조 2항: end now + unused days refunded (also after a period-end cancel); shown only when the server sends refund_quote_url
    canRefund ? html`<button class="btn btn--ghost btn--sm is-danger" id="bl-cancel-refund" data-phone-ok>${b.refund?.mode === 'ANNUAL' ? '해지하고 환불받기' : '전액 환불받고 해지'}</button>` : '',
  ].filter(Boolean).join('');
  const free = b.plan === 'FREE' && f.one_time ? html`<p class="bl-upsell" id="bl-free-topup">Pro·Team 1개월 이용권을 구매하거나, 지금 요금제 그대로 AI 크레딧을 충전할 수 있어요.</p>`
    : b.plan === 'FREE' ? html`<p class="bl-upsell" id="bl-free-topup">AI 크레딧 충전은 Pro부터 할 수 있어요. <a class="link" href="/app/billing/plans" data-link>Pro로 업그레이드</a>하면 매월 1,000 크레딧과 충전을 이용할 수 있어요.</p>` : '';
  // D3 (founder 2026-10-20): no one-time passes — a paid plan without auto renewal has been cancelled
  const pass = paid && s && !s.auto_renew && !s.cancel_at_period_end ? html`<p class="hint" id="bl-pass">${f.one_time ? '1개월 이용권이에요.' : '자동 갱신이 꺼져 있어요.'} ${day(s.current_period_end)}까지 이용하고 이후 Free로 바뀌어요. 이후에는 최근 프로젝트 1개만 편집하고 나머지는 조회 전용이 돼요(데이터는 삭제되지 않아요).</p>` : '';
  const pending = paid && s?.cancel_at_period_end ? html`<p class="hint" id="bl-cancel-pending">해지가 예약됐어요. ${day(s.current_period_end)}까지 ${b.plan_label || b.plan}를 그대로 쓰고 이후 Free로 바뀌어요.</p>` : '';
  const rf = b.refund;   // 환불 기준 (founder 2026-10-26): 7일 이내 미사용 → 전액, 그 외 환불 없음
  const refundHint = paid && rf ? html`<p class="hint" id="bl-refund-rule">${rf.mode === 'FULL' ? `${day(rf.refund_until)}까지 서비스를 이용하지 않으면 결제 금액 전액을 환불받을 수 있어요.` : rf.mode === 'ANNUAL' ? `연간 구독을 지금 해지하면 ${day(rf.ends_at)} 전날까지 이용하고, 이용한 개월 수를 월간 요금(할인 없음)으로 계산한 나머지 ${krw(rf.total)}을 환불받아요.` : rf.reason === 'annual_nothing' ? '이용한 개월 수를 월간 요금으로 계산하면 환불 가능한 금액이 없어요. 해지해도 결제한 기간이 끝날 때까지 쓸 수 있어요.' : rf.reason === 'used' ? '결제 후 서비스를 이용해 환불 대상이 아니에요. 이용 기간이 끝날 때까지 쓸 수 있어요.' : rf.reason === 'period_over' ? '결제 후 7일이 지나 환불 대상이 아니에요. 이용 기간이 끝날 때까지 쓸 수 있어요.' : ''}</p>` : '';
  return html`<div class="panel bl-panel" id="bl-actions"><div class="panel__h">관리</div><div class="panel__b">${raw(free)}${raw(pass)}${raw(pending)}${raw(refundHint)}<div class="actions">${raw(btns)}</div>
    <p class="hint" style="margin-top:10px">${raw(f.one_time ? '환불 기준은 <a class="link" href="/terms#refund" target="_blank" rel="noopener">이용약관</a>을 확인하세요.' : '해지·환불 기준은 <a class="link" href="/terms#refund" target="_blank" rel="noopener">이용약관</a>, 자동 결제는 <a class="link" href="/terms#recurring" target="_blank" rel="noopener">정기결제 안내</a>를 확인하세요.')}</p></div></div>`;
}

/** Ledger labels (credit-routes.js) carry the won amount of a top-up ('충전 ₩10,000'); this page shows credits only. */
const creditLabel = (l) => String(l || '').replace(/\u20a9[\d,]+/g, '').trim();
const ledgerHtml = (rows) => (!rows?.length ? '<p class="hint" style="margin-top:10px">아직 크레딧 사용 내역이 없어요.</p>'
  : html`<table class="rtable bl-tbl" id="bl-ledger-tbl"><thead><tr><th>일시</th><th>내용</th><th class="num">크레딧</th></tr></thead><tbody>
    ${raw(rows.map((r) => html`<tr><td>${day(r.at)}</td><td>${creditLabel(r.label) || r.type}${raw(r.project_name ? html` <small class="dim">· ${r.project_name}</small>` : '')}</td><td class="num">${r.credits > 0 ? `+${n(r.credits)}` : r.credits < 0 ? `−${n(-r.credits)}` : '0'}</td></tr>`).join(''))}</tbody></table>`);

export const ordersHtml = (orders) => html`<div class="panel bl-panel" id="bl-orders"><div class="panel__h">결제 내역</div><div class="panel__b">${raw(!orders?.length ? '<p class="hint">결제 내역이 없어요.</p>'
  : html`<div class="rtable-wrap--in"><table class="rtable bl-tbl" id="bl-orders-tbl"><thead><tr><th>일시</th><th>내용</th><th class="num">금액</th><th>상태</th><th></th></tr></thead><tbody>
    ${raw(orders.map((o) => html`<tr data-order="${o.id}"><td>${day(o.paid_at || o.created_at)}</td><td>${o.title}<small class="dim"> · ${o.kind_label}</small></td><td class="num">${krw(o.amount)}${raw(o.refunded_amount ? html`<small class="dim"> (환불 ${krw(o.refunded_amount)})</small>` : '')}</td>
      <td>${o.status_label}</td><td>${raw(o.receipt_url ? html`<a class="link" href="${o.receipt_url}" target="_blank" rel="noopener">영수증</a>` : '')}</td></tr>`).join(''))}</tbody></table></div><p class="hint">금액은 VAT 포함 카드 결제 금액이에요.</p>`)}</div></div>`;

/** The whole page body (pure: unit-tested against the v3 fixture). */
export function billingHtml(b, { orders = null } = {}) {
  return html`${raw(overLimitBanner(b))}<div class="bl-grid">${raw(planPanel(b))}${raw(usagePanel(b))}</div>
    ${raw(scheduledPanel(b))}${raw(creditsPanel(b))}${raw(actionsPanel(b))}${raw(policyPanel(b))}${raw(orders ? ordersHtml(orders) : '')}`;
}

/** Billing body inside another page (settings › 요금제 tab). Loads its own data. */
export async function mountBilling(el, { wid = state.workspace.id } = {}) {
  let b;
  try { b = (await api('GET', `/api/workspaces/${wid}/billing`)).billing; } catch (e) { el.innerHTML = html`<p class="hint">${e.message || '결제 정보를 불러오지 못했어요.'}</p>`; return; }
  const orders = b.can_manage ? await api('GET', `/api/workspaces/${wid}/billing/orders`).then((r) => r.orders).catch(() => []) : null;
  el.innerHTML = billingHtml(b, { orders });
  api('GET', `/api/workspaces/${wid}/credits/ledger`).then((r) => { const box = el.querySelector('#bl-ledger'); if (box) box.innerHTML = ledgerHtml((r.rows || []).slice(0, 8)); }).catch(() => {});
  const cancel = el.querySelector('#bl-cancel');
  if (cancel) cancel.onclick = async () => {
    const end = day(b.subscription?.current_period_end);
    const p = policy(b);
    const bodyHtml = html`<p>${end}까지 ${b.plan_label}를 그대로 쓰고, 이후 Free로 바뀌어요. 자동 갱신은 바로 멈추고 위약금은 없어요. ${b.refund?.mode === 'FULL' ? '결제 후 7일 이내 미사용이라 "전액 환불받고 해지"도 할 수 있어요.' : b.refund?.mode === 'ANNUAL' ? `이 방법은 환불이 없어요. 환불을 원하면 "해지하고 환불받기"로 ${day(b.refund.ends_at)} 전날까지 쓰고 ${krw(b.refund.total)}을 환불받을 수 있어요.` : b.refund?.reason === 'annual_nothing' ? '이용한 개월 수를 월간 요금으로 계산하면 환불 가능한 금액이 없어요.' : '이미 결제한 금액은 환불되지 않아요.'}</p>
      <ul class="bl-list" id="bl-cancel-policy"><li>${p.free}</li><li>${p.keep}</li></ul>`;
    if (!(await confirmDialog({ title: `${b.plan_label} 구독을 해지할까요?`, bodyHtml, confirm: '해지', danger: true }))) return;
    try { await api('POST', b.cancel_url || `/api/workspaces/${wid}/billing/cancel`, {}); toast('해지가 예약됐어요.'); await mountBilling(el, { wid }); } catch (e) { toast(e.message); }
  };
  const refund = el.querySelector('#bl-cancel-refund');
  if (refund) refund.onclick = async () => {
    let q;
    try { q = (await api('GET', b.refund_quote_url)).refund; } catch (e) { toast(e.message); return; }
    const lines = (q.lines || []).map((l) => html`<li>${l.label || '결제'} ${krw(l.paid)}${l.months_used ? ` − 월 ${krw(l.monthly_price)} × ${n(l.months_used)}개월` : ''} → <b>${krw(l.amount)}</b></li>`).join('');
    const annual = q.mode === 'ANNUAL';
    const bodyHtml = html`<p>${raw(annual ? html`연간 구독을 해지해 <b>${day(q.ends_at)} 전날까지</b> 이용하고 이후 Free로 바뀌어요. 이용한 개월 수를 월간 요금(할인 없음)으로 계산한 나머지 <b id="bl-refund-total">${krw(q.total)}</b>을 환불해요.`
      : html`${b.plan_label} 이용이 지금 끝나고 Free로 바뀌어요. 결제 후 7일 이내이고 이용 이력이 없어 결제 금액 전액 <b id="bl-refund-total">${krw(q.total)}</b>을 환불해요.`)} 해지 뒤에는 되돌릴 수 없어요.</p>
      ${raw(lines ? html`<ul class="bl-list">${raw(lines)}</ul>` : '')}${raw(annual ? '' : '<p class="hint">이번 기간의 기본 AI 크레딧은 소멸해요.</p>')}<ul class="bl-list" id="bl-refund-policy"><li>${policy(b).free}</li><li>${policy(b).keep}</li></ul>`;
    if (!(await confirmDialog({ title: annual ? '연간 구독을 해지하고 환불받을까요?' : '전액 환불받고 해지할까요?', bodyHtml, confirm: '환불받고 해지', danger: true }))) return;
    try {
      const r = await api('POST', `/api/workspaces/${wid}/billing/cancel`, { refund: true });
      toast(r.cancel?.refund_total ? `해지했어요. ${krw(r.cancel.refund_total)} 환불을 진행해요.` : '해지했어요.'); await mountBilling(el, { wid });
    } catch (e) { toast(e.message); }
  };
  el.querySelectorAll('[data-sched-cancel]').forEach((btn) => { btn.onclick = async () => {
    const c = b.scheduled[Number(btn.dataset.schedCancel)];
    if (!(await confirmDialog({ title: '예약한 변경을 취소할까요?', body: `${CHANGE[c.kind] || c.kind} 예약을 취소하고 지금 조건을 유지해요.`, confirm: '예약 취소' }))) return;
    try { await api('POST', c.cancel_url, {}); toast('예약을 취소했어요.'); await mountBilling(el, { wid }); } catch (e) { toast(e.message); }
  }; });
}

/** /app/settings/billing — standalone page (deep link from e-mails, banners and the plans page). */
export async function billingPage(main = $('#main')) {
  document.title = '플랜 · 결제 — RELAI';
  main.innerHTML = html`<div class="page page--narrow page--billing" id="billing-page"><div class="page__head"><div><a class="link" href="/app/settings?tab=plan" data-link>← 설정</a>
    <h1 style="margin-top:4px">플랜 · 결제</h1><p class="dim" style="margin-top:4px">${wsName(state.workspace.name)}의 요금제, 사용량, AI 크레딧과 결제를 관리해요.</p></div></div>
    <div id="bl-root"><p class="hint">불러오는 중…</p></div>${raw(legalFooterHtml(LEGAL))}</div>`;
  await mountBilling($('#bl-root'));
}
