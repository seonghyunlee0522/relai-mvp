/* Admin Audit: every operator action, newest first. Separate from project-level histories by design. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { ACTIONS, TARGET, adminApi, bindFilters, bindPager, bindRows, errorBlock, fmtD, head, pager, qs, sel, table } from './ui.js';

export async function adminAuditPage(main = $('#main')) {
  document.title = '감사 로그 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('audit', { q: q.q, action: q.action, admin: q.admin, target_type: q.target_type, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">${raw(head('감사 로그', '<span class="hint">운영자 조작 기록 — 상태 변경과 같은 트랜잭션으로 저장됩니다.</span>'))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="대상 ID · 사용자 이메일 · 워크스페이스명" value="${q.q || ''}"><input class="input input--sm" data-f="admin" placeholder="운영자 이메일" value="${q.admin || ''}" style="width:180px">
        ${raw(sel('action', '작업', ACTIONS, q.action))}${raw(sel('target_type', '대상 유형', TARGET, q.target_type))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) },
        { key: 'admin', label: '운영자', w: 200, render: (r) => html`${r.admin_name || '-'} <small class="dim mono">${r.admin_email || ''}</small>` },
        { key: 'action', label: '작업', w: 170, render: (r) => ACTIONS[r.action] || r.action },
        { key: 'target', label: '대상', w: 200, render: (r) => html`<span class="achip achip--muted">${TARGET[r.target_type] || r.target_type}</span> <span class="mono dim" title="${r.target_id}">${r.metadata?.email || r.metadata?.name || r.target_id.slice(0, 8)}</span>` },
        { key: 'summary', label: '요약' },
      ], d.items, { rowHref: (r) => (r.target_type === 'USER' ? `/admin/users/${r.target_id}` : r.target_type === 'WORKSPACE' ? `/admin/workspaces/${r.target_id}` : r.target_type === 'SUBSCRIPTION' ? `/admin/subscriptions/${r.target_id}` : r.target_type === 'FEEDBACK' ? `/admin/feedback/${r.target_id}` : r.target_type === 'DELIVERABLE' ? '/admin/deliverables' : r.target_type === 'AI_PROMPT' ? `/admin/ai-prompts/${r.target_id}` : r.target_type === 'PROJECT' ? '/admin/ai-prompts' : `/admin/payments/${r.target_id}`), empty: '기록이 없습니다.' }))}
      ${raw(pager(d))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}
