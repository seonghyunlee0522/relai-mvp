/* Admin Console shell: "RELAI Admin" header + operator sidebar. Never shows the product's project navigation.
 * The server already refuses /admin and /api/admin/* to non-operators; this check only avoids a broken page. */
import { api } from '../core/api.js';
import { $, html, raw, root } from '../core/dom.js';
import { state } from '../core/state.js';
import { refreshFeedbackBadge } from './feedback.js';

const NAV = [['/admin', '대시보드', /^\/admin\/?$/], ['/admin/users', '회원', /^\/admin\/users/], ['/admin/workspaces', '워크스페이스', /^\/admin\/workspaces/], ['/admin/invitations', '초대', /^\/admin\/invitations/], ['/admin/email-deliveries', '메일 발송', /^\/admin\/email-deliveries/], ['/admin/subscriptions', '구독', /^\/admin\/subscriptions/],
  ['/admin/payments', '결제', /^\/admin\/payments/], ['/admin/usage', '사용량', /^\/admin\/usage/], ['/admin/deliverables', '산출물 목록', /^\/admin\/deliverables/], ['/admin/ai-prompts', 'AI 프롬프트', /^\/admin\/ai-prompts/], ['/admin/funnel', '사용 분석', /^\/admin\/funnel/], ['/admin/promotions', '프로모션', /^\/admin\/promotions/], ['/admin/feedback', '의견', /^\/admin\/feedback/], ['/admin/integrations', '연동', /^\/admin\/integrations/], ['/admin/audit', '감사 로그', /^\/admin\/audit/], ['/admin/purge', '테스트 계정 정리', /^\/admin\/purge/]];

export async function adminShell(path, view) {
  if (!state.user || state.user.system_role !== 'SYSTEM_ADMIN') {
    root.innerHTML = html`<div class="page"><div class="empty"><h2>403 — 운영자 권한이 필요합니다.</h2><a class="btn btn--primary" href="/app" data-link>앱으로 돌아가기</a></div></div>`;
    return;
  }
  if (!$('.ashell')) {
    root.innerHTML = html`<div class="ashell">
      <aside class="aside" id="aside">
        <div class="aside__brand"><a href="/admin" data-link>RELAI <em>관리자</em></a><button class="aside__menu" id="amenu" aria-label="메뉴">☰</button></div>
        <nav class="aside__nav" aria-label="운영자 메뉴">${raw(NAV.map(([href, label]) => html`<a href="${href}" data-link data-anav="${href}">${label}${raw(href === '/admin/feedback' ? '<span class="anav__badge" data-fb-badge hidden></span>' : '')}</a>`).join(''))}</nav>
        <div class="aside__foot"><a href="/app" data-link>← RELAI 앱으로</a><div class="aside__me"><b>${state.user.name}</b><small>${state.user.email}</small></div><button class="linkbtn" id="alogout">로그아웃</button></div>
      </aside>
      <main class="amain" id="main"></main></div>`;
    $('#alogout').onclick = async () => { try { await api('POST', '/api/auth/logout', {}); } finally { state.user = null; location.href = '/login'; } };
    $('#amenu').onclick = () => $('#aside').classList.toggle('is-open');
  }
  document.querySelectorAll('[data-anav]').forEach((a) => { const nav = NAV.find((x) => x[0] === a.dataset.anav); a.classList.toggle('is-active', nav[2].test(path)); });
  $('#aside').classList.remove('is-open');
  refreshFeedbackBadge();   // 새 의견 count next to 의견
  const main = $('#main');
  main.innerHTML = '<div class="loading">불러오는 중…</div>';
  window.scrollTo(0, 0);
  try { await view(main); }
  catch (e) { main.innerHTML = html`<div class="apage"><div class="empty"><h2>${e.status === 404 ? '찾을 수 없습니다' : e.status === 403 ? '권한이 없습니다' : '문제가 발생했습니다'}</h2><p>${e.message}</p><a class="btn btn--secondary" href="/admin" data-link>대시보드</a></div></div>`; }
}
