/* 공지사항 (migration 74): rail entry above 의견 남기기 → /app/notices, the visible notices (관리자 › 공지사항) newest first.
 * Title + date in the list, the body opens in place. The image is not shown here — it is only for the landing / Home modal.
 * A dot on the rail entry while there is a NEW notice posted after the user last opened this page (localStorage). */
import { api } from './core/api.js';
import { $, html, no2, raw } from './core/dom.js';

const SEEN_KEY = 'relai.notices.seenAt';
const ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2v3.6a1 1 0 0 0 1 1H6l6 3.2V4L6 7.2H4.5a1 1 0 0 0-1 1z"/><path d="M15 7.5a3.5 3.5 0 0 1 0 5"/><path d="M6.5 12.8 7.6 17"/></svg>';
const kdate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}.${no2(d.getMonth() + 1)}.${no2(d.getDate())}`; };
const seenAt = () => { try { return Number(localStorage.getItem(SEEN_KEY) || 0); } catch { return 0; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* blocked */ } };

/** One request per page load for the rail dot; the list page refreshes it. */
let feed = null;
const load = (fresh = false) => { if (fresh || !feed) feed = api('GET', '/api/notices').then((r) => r.notices || []).catch(() => (feed = null, [])); return feed; };
const unseen = (list) => list.some((n) => n.is_new && new Date(n.posted_at).getTime() > seenAt());

/** Desktop rail item (frame.js puts it right above 의견 남기기). */
export const railNotices = (active = false) => html`<a class="rail__i rail__nt ${active ? 'is-active' : ''}" href="/app/notices" data-link ${raw(active ? 'aria-current="page"' : '')} title="공지사항">${raw(ICON)}<span>공지사항</span><i class="rail__dot" data-notice-dot hidden aria-label="새 공지"></i></a>`;
/** Phone (no rail): a button on 설정, next to 의견 남기기. */
export const phoneNotices = () => html`<a class="btn btn--secondary phone-notices" href="/app/notices" data-link data-phone-ok>공지사항</a>`;

export function refreshNoticeDot() {
  load().then((list) => { const on = unseen(list); document.querySelectorAll('[data-notice-dot]').forEach((d) => { d.hidden = !on; }); });
}

export async function noticesPage(main = $('#main')) {
  document.title = '공지사항 — RELAI';
  main.innerHTML = '<div class="page ntl"><p class="dim">불러오는 중…</p></div>';
  let list;
  try { list = await load(true); } catch { list = []; }
  const openId = new URLSearchParams(location.search).get('id');
  const item = (n) => html`<li class="ntl__i" id="notice-${n.id}">
    <details ${raw(n.id === openId ? 'open' : '')}><summary><span class="ntl__t">${raw(n.is_new ? '<span class="ntl__new">NEW</span>' : '')}<b>${n.title}</b></span><time class="ntl__d" datetime="${n.posted_at}">${kdate(n.posted_at)}</time></summary>
      <div class="ntl__b">${n.body || '내용이 없습니다.'}</div></details></li>`;
  main.innerHTML = html`<div class="page ntl">
    <div class="page__head"><div><h1>공지사항</h1><p>RELAI 팀이 알려 드리는 소식입니다.</p></div></div>
    ${raw(list.length ? html`<ul class="ntl__l">${raw(list.map(item).join(''))}</ul>` : '<div class="empty empty--sm" data-notices-empty><h2>공지사항이 없습니다.</h2><p>새 소식이 생기면 여기에서 알려 드릴게요.</p></div>')}
  </div>`;
  markSeen(); refreshNoticeDot();
  if (openId) { const el = document.getElementById(`notice-${openId}`); if (el) el.scrollIntoView({ block: 'start' }); }
}
