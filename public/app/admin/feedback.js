/* 관리자 › 의견 (migration 48): what users sent with 의견 남기기. List (status · category · date filters, search) and a detail view
 * with the sender, the page they were on, status change and an operator note (each save = one FEEDBACK_UPDATE audit row). */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { api } from '../core/api.js';
import { toast } from '../shared/dialogs.js';
import { adminApi, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, head, pager, qs, section, sel, table } from './ui.js';

const STATUS = { NEW: '새 의견', IN_REVIEW: '검토 중', DONE: '처리 완료' };
const STATUS_TONE = { NEW: 'warn', IN_REVIEW: 'act', DONE: 'ok' };
const CATEGORY = { INCONVENIENCE: '불편', SUGGESTION: '개선 제안', BUG: '오류', OTHER: '기타' };
const statusChip = (s) => chip(STATUS_TONE[s] || 'muted', STATUS[s] || s);

/** Sidebar badge = number of 새 의견. Called by the admin shell on every page and after a status change here. */
export async function refreshFeedbackBadge() {
  const b = document.querySelector('[data-fb-badge]'); if (!b) return;
  try { const { new_count: c } = await api('GET', '/api/admin/feedback/summary'); b.textContent = c > 99 ? '99+' : String(c); b.hidden = !c; b.title = `새 의견 ${c}건`; } catch { b.hidden = true; }
}

export async function adminFeedbackPage(main = $('#main')) {
  document.title = '의견 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('feedback', { q: q.q, status: q.status, category: q.category, from: q.from, to: q.to, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('의견', html`<span class="hint">사용자가 앱의 '의견 남기기'로 보낸 내용입니다. 새 의견 <b>${d.new_count}</b>건</span>`))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="내용 · 이름 · 이메일 · 페이지 검색" value="${q.q || ''}">
        ${raw(sel('status', '상태', STATUS, q.status))}${raw(sel('category', '종류', CATEGORY, q.category))}
        <label class="hint">기간 <input class="input input--sm" type="date" data-f="from" value="${q.from || ''}" aria-label="시작일"></label><label class="hint">~ <input class="input input--sm" type="date" data-f="to" value="${q.to || ''}" aria-label="종료일"></label>
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'created_at', label: '접수', w: 140, render: (r) => fmtD(r.created_at) },
        { key: 'status', label: '상태', w: 90, render: (r) => statusChip(r.status) },
        { key: 'category', label: '종류', w: 90, render: (r) => html`${CATEGORY[r.category] || r.category}` },
        { key: 'message', label: '내용', cls: 'ttl', render: (r) => html`<span class="afb__ex" title="${r.message}">${r.message}</span>` },
        { key: 'user', label: '보낸 사람', w: 200, render: (r) => html`${r.user_name || '-'} <small class="dim mono">${r.user_email || ''}</small>` },
        { key: 'page_path', label: '페이지', w: 180, render: (r) => html`<span class="mono dim afb__ex" title="${r.page_path || ''}">${r.page_path || '-'}</span>` },
      ], d.items, { rowHref: (r) => `/admin/feedback/${r.id}`, empty: '조건에 맞는 의견이 없습니다.', id: 'fb-tbl' }))}
      ${raw(pager(d))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminFeedbackDetailPage(id, main = $('#main')) {
  document.title = '의견 — RELAI 관리자';
  const load = () => api('GET', `/api/admin/feedback/${id}`);
  let d; try { d = await load(); } catch (e) { main.innerHTML = errorBlock(e); return; }
  const draw = async () => {
    const f = d.feedback;
    const audit = await adminApi('audit', { target_id: f.id, size: 20 }).catch(() => ({ items: [] }));
    main.innerHTML = html`<div class="apage">
      ${raw(head(`${CATEGORY[f.category] || f.category} 의견`, statusChip(f.status), { href: '/admin/feedback', label: '의견 목록' }))}
      <div class="afb__grid">
        <div>
          ${raw(section('내용', html`<p class="afb__msg" id="fb-message">${f.message}</p>`))}
          ${raw(section('보낸 곳', dl([
            ['보낸 사람', f.user_id ? html`<a href="/admin/users/${f.user_id}" data-link>${f.user_name || '-'}</a> <span class="mono dim">${f.user_email || ''}</span>` : '<span class="dim">탈퇴한 사용자</span>'],
            ['워크스페이스', f.workspace_id ? html`<a href="/admin/workspaces/${f.workspace_id}" data-link>${f.workspace_name || f.workspace_id}</a>` : '-'],
            ['프로젝트', f.project_id ? html`${f.project_name || f.project_id} <small class="dim mono">${f.project_id}</small>` : '-'],
            ['페이지', f.page_path ? html`<span class="mono">${f.page_path}</span>` : '-'],
            ['브라우저', f.user_agent ? html`<span class="afb__ua">${f.user_agent}</span>` : '-'],
            ['접수', fmtD(f.created_at)], ['마지막 수정', fmtD(f.updated_at)],
          ])))}
          ${raw(section('처리 기록', audit.items.length ? html`<ul class="afb__log">${raw(audit.items.map((a) => html`<li>${fmtD(a.created_at)} · ${a.admin_name || a.admin_email || '-'} · ${a.summary}</li>`).join(''))}</ul>` : '<p class="dim">아직 처리 기록이 없습니다.</p>'))}
        </div>
        <section class="asec"><div class="asec__h">처리</div>
          <form class="afb__f" id="fb-form" novalidate>
            <div class="field"><label for="fb-status">상태</label><select class="select" id="fb-status" name="status">${raw(Object.entries(STATUS).map(([v, l]) => html`<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></div>
            <div class="field"><label for="fb-note">운영자 메모</label><textarea class="textarea" id="fb-note" name="admin_note" maxlength="2000" placeholder="사용자에게는 보이지 않습니다.">${f.admin_note || ''}</textarea><div class="err" data-for="admin_note"></div></div>
            <div class="actions"><button type="submit" class="btn btn--primary btn--sm" id="fb-save">저장</button></div>
          </form></section>
      </div></div>`;
    const form = $('#fb-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#fb-save'); btn.disabled = true; form.querySelector('[data-for=admin_note]').textContent = '';
      try {
        const r = await api('PATCH', `/api/admin/feedback/${f.id}`, { status: form.status.value, admin_note: form.admin_note.value });
        d = { ...d, feedback: r.feedback }; toast('저장했습니다.'); await draw(); refreshFeedbackBadge();
      } catch (err) { btn.disabled = false; if (err.fields?.admin_note) form.querySelector('[data-for=admin_note]').textContent = err.fields.admin_note; else toast(err.message); }
    });
  };
  await draw();
}
