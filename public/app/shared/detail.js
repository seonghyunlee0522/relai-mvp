/* Detail view building blocks (large-modal pattern): tab bar, comment composer, unified activity feed.
 * Pages own the data; these helpers only render and wire generic interactions. */
import { esc, fmtDT, html, raw } from '../core/dom.js';

/** Tab bar. tabs: [{ key, label, count? }]. batch7 #14: one line, never wrapped — when it does not fit the panel, the hidden side
 * fades and gets a ‹ / › button (state kept by syncDtabs; buttons are mouse helpers, the tabs stay reachable with Tab). */
export const dtabs = (tabs, active) => html`<div class="dtabs-w" data-dtabs-w><div class="dtabs" role="tablist">${raw(tabs.map((t) => html`<button type="button" role="tab" class="${t.key === active ? 'is-on' : ''}" data-dtab="${t.key}" aria-selected="${t.key === active}">${t.label}${raw(t.count !== undefined && t.count !== null ? html`<em>${t.count}</em>` : '')}</button>`).join(''))}</div>
  <button type="button" class="dtabs__arr dtabs__arr--l" data-dtabs-go="-1" data-phone-ok tabindex="-1" aria-label="이전 탭 보기">‹</button><button type="button" class="dtabs__arr dtabs__arr--r" data-dtabs-go="1" data-phone-ok tabindex="-1" aria-label="다음 탭 보기">›</button></div>`;

/** Marks every tab bar under `root` as overflowing / scrolled to an end (CSS shows the fades and ‹ ›). */
export function syncDtabs(root = document) {
  root.querySelectorAll('[data-dtabs-w]').forEach((w) => {
    const t = w.querySelector('.dtabs'); if (!t) return;
    const over = t.scrollWidth > t.clientWidth + 1;
    w.classList.toggle('is-over', over); w.classList.toggle('at-start', t.scrollLeft <= 1); w.classList.toggle('at-end', t.scrollLeft + t.clientWidth >= t.scrollWidth - 1);
  });
}
if (typeof document !== 'undefined' && document.body && !document.body.dataset.dtabsBound) {
  document.body.dataset.dtabsBound = '1';
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dtabs-go]'); if (!b) return;
    const t = b.closest('[data-dtabs-w]').querySelector('.dtabs'); t.scrollBy({ left: Number(b.dataset.dtabsGo) * Math.max(120, t.clientWidth * 0.6), behavior: 'smooth' });
  });
  document.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('dtabs')) syncDtabs(e.target.parentElement.parentElement || document); }, true);
  // a tab bar appears whenever a page renders a drawer: re-check after DOM changes and size changes (cheap — a handful of bars at most)
  let raf = 0; const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => later()) : null;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (ro) document.querySelectorAll('[data-dtabs-w]:not([data-ro])').forEach((w) => { w.dataset.ro = '1'; ro.observe(w); }); syncDtabs(); }); };
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', later);
}

/** Wires tab switching (pure DOM toggle — no re-render). Panes are `[data-pane="<key>"]`. */
export const bindDtabs = (root, onChange = () => {}) => {
  root.querySelectorAll('[data-dtab]').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('[data-dtab]').forEach((x) => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-selected', String(on)); });
      root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.dtab; });
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      onChange(b.dataset.dtab);
    };
  });
};

/** Activity categories shown as filter chips and row tags. */
export const ACT_KIND = { COMMENT: '댓글', STATUS: '상태', OWNER: '담당자', SCHEDULE: '일정', DATA: '수정', LINK: '연결', SYSTEM: '시스템' };

const SCHEDULE_FIELDS = new Set(['planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'milestone_date']);
/** Classify a history row (requirement_history / wbs_history) into an activity kind. */
export function classify(h) {
  const a = h.action_type;
  if (a === 'CREATED' || a === 'ARCHIVED') return 'SYSTEM';
  if (/LINK/.test(a) || a === 'DEP_ADDED' || a === 'DEP_REMOVED') return 'LINK';
  if (a === 'MOVED') return 'SCHEDULE';
  if (a === 'UPDATED' || !a) {
    const f = h.field_name;
    if (f === 'status') return 'STATUS';
    if (f === 'owner_user_id') return 'OWNER';
    if (SCHEDULE_FIELDS.has(f) || f === 'progress') return 'SCHEDULE';
  }
  return 'DATA';
}

/**
 * Merge history rows and comments into one newest-first list.
 * fmt(h) → inner HTML for a history row. Comments render escaped with line breaks.
 */
export function mergeActivity({ history = [], comments = [], fmt, meId }) {
  const ev = history.map((h) => ({ kind: classify(h), at: h.changed_at, actor: h.changed_by_name || '', html: fmt(h) }));
  for (const c of comments) ev.push({ kind: 'COMMENT', at: c.created_at, actor: c.author_name || '', html: esc(c.body).replace(/\n/g, '<br>'), commentId: c.id, mine: c.created_by === meId });
  return ev.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const FILTERS = [['ALL', '전체'], ['COMMENT', '댓글'], ['CHANGES', '변경 이력']];
export const activityFilterMatch = (f, ev) => f === 'ALL' || (f === 'COMMENT' ? ev.kind === 'COMMENT' : ev.kind !== 'COMMENT');

/** Activity pane: composer + filter chips + timeline. `ro` hides the composer (archived project). */
export const activityPane = ({ events, filter = 'ALL', ro = false }) => {
  const shown = events.filter((e) => activityFilterMatch(filter, e));
  return html`${raw(ro ? '' : html`<form class="cmt" id="cmt-form"><textarea class="textarea" id="cmt-in" maxlength="2000" rows="2" placeholder="댓글을 입력하세요. (Ctrl+Enter로 등록)"></textarea>
      <div class="cmt__a"><span class="hint" id="cmt-err" role="alert"></span><button class="btn btn--primary btn--sm" type="submit">댓글 등록</button></div></form>`)}
    <div class="act__f" role="group" aria-label="활동 필터">${raw(FILTERS.map(([k, l]) => html`<button type="button" class="fchip2 ${filter === k ? 'is-on' : ''}" data-afilter="${k}">${l}</button>`).join(''))}</div>
    ${raw(shown.length ? html`<ol class="act">${raw(shown.map((e) => html`<li class="act__i act__i--${e.kind.toLowerCase()}"><i class="act__dot"></i>
      <div class="act__b"><div class="act__h"><b>${e.actor || '시스템'}</b><span class="act__k">${ACT_KIND[e.kind]}</span><time>${fmtDT(e.at)}</time>${raw(e.commentId && e.mine ? html`<button type="button" class="act__x" data-cdel="${e.commentId}" title="댓글 삭제" aria-label="댓글 삭제">×</button>` : '')}</div>
      <div class="act__t">${raw(e.html)}</div></div></li>`).join(''))}</ol>` : '<p class="hint" style="padding:12px 2px">표시할 활동이 없습니다.</p>')}`;
};

/** Wires composer, filter chips and comment deletion. Callbacks: onFilter(f), onSubmit(text) → Promise, onDelete(id) → Promise. */
export function bindActivity(root, { onFilter, onSubmit, onDelete }) {
  root.querySelectorAll('[data-afilter]').forEach((b) => { b.onclick = () => onFilter(b.dataset.afilter); });
  const form = root.querySelector('#cmt-form');
  if (form) {
    const ta = form.querySelector('#cmt-in'); const err = form.querySelector('#cmt-err');
    const submit = async () => {
      const v = ta.value.trim(); if (!v) { err.textContent = '댓글 내용을 입력해 주세요.'; return; }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
      try { await onSubmit(v); } catch (e) { err.textContent = e.message; btn.disabled = false; }
    };
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } };
  }
  root.querySelectorAll('[data-cdel]').forEach((b) => { b.onclick = () => onDelete(b.dataset.cdel); });
}
