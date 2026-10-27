/**
 * Promotions — the ONE component every placement renders (founder 2026-10-15: offers change often, so they live in their own
 * admin-editable area, never in page copy). Rows come from the promotions table (server/promotions.js, 관리자 › 프로모션).
 * Plain data + string builders only: no DOM, no imports, so the server renders the landing block with the same markup.
 *
 * Variants: 'cards' (a small pricing-style grid; signup, landing, credits, login) · 'line' (one inline sentence; Home).
 * Token {until} (legacy, early access retired 2026-10-20): a promo still using it is skipped, since no viewer has an end date any more.
 */
export const PROMO_PLACEMENTS = { signup: '회원가입', login: '로그인', landing: '랜딩 · 요금', credits: '설정 › AI 이용 현황', home: '홈' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (s, until) => String(s || '').replaceAll('{until}', until || '');
const usable = (p, until) => !(/\{until\}/.test(`${p.title}${p.body}${p.badge || ''}`) && !until);
const safeHref = (u) => (/^(\/(?!\/)|https:\/\/)/.test(String(u || '')) ? String(u) : '');

/** promos: [{ id, title, body, badge, link_url, link_label }] → HTML ('' when nothing to show). */
export function promoHtml(promos, { placement = '', variant = 'cards', until = null } = {}) {
  const list = (promos || []).filter((p) => usable(p, until));
  if (!list.length) return '';
  if (variant === 'line') {
    return list.map((p) => {
      const href = safeHref(p.link_url); const t = esc(fill(p.title, until)); const b = p.body ? ` ${esc(fill(p.body, until))}` : '';
      return `<span class="promo-line" data-promo="${esc(p.id)}">${href ? `<a class="link" href="${esc(href)}"${href.startsWith('/') ? ' data-link' : ''}>${t}</a>` : t}${b}</span>`;
    }).join('<span class="promo-line__sep"> · </span>');
  }
  const card = (p) => {
    const href = safeHref(p.link_url);
    return `<div class="promo-card" data-promo="${esc(p.id)}">
      ${p.badge ? `<span class="promo-card__badge">${esc(fill(p.badge, until))}</span>` : ''}
      <b class="promo-card__t">${esc(fill(p.title, until))}</b>
      ${p.body ? `<p class="promo-card__d">${esc(fill(p.body, until))}</p>` : ''}
      ${href ? `<div class="promo-card__a"><a class="promo-card__btn" href="${esc(href)}">${esc(p.link_label || '자세히 보기')} →</a></div>` : ''}
    </div>`;
  };
  return `<div class="promo promo--${esc(placement)} promo--n${Math.min(list.length, 4)}" data-promos="${esc(placement)}">${list.map(card).join('')}</div>`;
}

/** Browser: active promotions for one placement (public endpoint, no auth). Never throws — a missing promo is not an error. */
export async function loadPromos(placement) {
  try {
    const r = await fetch(`/api/promotions?placement=${encodeURIComponent(placement)}`, { credentials: 'same-origin' });
    return r.ok ? (await r.json()).promotions || [] : [];
  } catch { return []; }
}
