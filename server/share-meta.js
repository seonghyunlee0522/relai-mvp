/**
 * Link previews (mobile-v2): Open Graph + Twitter card + icons for every HTML page RELAI serves, so a link pasted into
 * Slack / KakaoTalk / iMessage shows the brand card (public/brand/og-image.png, 1200×630) instead of a bare URL.
 * Scrapers need absolute URLs: APP_BASE_URL when set (the e-mail link base), else the request's own origin.
 */
import { emailConfig } from './email/config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SHARE = {
  title: 'RELAI — 지금 해야 할 일을 안내하는 프로젝트 가이드',
  description: '착수부터 운영까지 7단계를 따라 현재 단계와 다음 할 일을 알려주고, 요구사항 · 일정 · 테스트 · 주간보고를 한 흐름으로 잇습니다. 얼리 액세스 12개월 무료.',
};

export function originOf(req) {
  let base = '';
  try { base = emailConfig().appBaseUrl; } catch { base = ''; }
  if (base) return base;
  const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

/** The <head> tags. `path` is the canonical path of the page (no query: tokens never leak into a preview). */
export function shareMeta(req, { title = SHARE.title, description = SHARE.description, path = '/' } = {}) {
  const o = originOf(req);
  return [
    '<meta name="theme-color" content="#101828">',
    '<link rel="icon" type="image/svg+xml" href="/brand/icon.svg">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">',
    '<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="RELAI">',
    '<meta property="og:locale" content="ko_KR">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(o + path)}">`,
    `<meta property="og:image" content="${esc(o)}/brand/og-image.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="RELAI — 프로젝트 생애주기를 따라 지금 해야 할 일을 안내합니다.">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(o)}/brand/og-image.png">`,
  ].join('\n');
}
