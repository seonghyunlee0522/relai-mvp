/**
 * Google Analytics 4 on the PUBLIC pages only (acquisition): landing /, /login, /signup, /terms, /privacy.
 * In-app use stays first-party (server/analytics.js, /admin/funnel); /app/*, /admin/*, token pages (/invite, /reset-password,
 * /verify-email) and anything carrying customer data never get this tag.
 * Off unless GA4_MEASUREMENT_ID is a G-… id: no script, no network call. The id is read per request (no restart in tests).
 * Privacy: IP anonymised, Google signals / ad personalisation off, no user id or e-mail is ever sent. page_location keeps only
 * utm_* / gclid query params (channel attribution) so tokens never reach Google; a same-origin referrer is reduced to the origin.
 * The server sets no Content-Security-Policy header today; if one is added, allow (only when enabled) script-src
 * https://www.googletagmanager.com and connect-src https://*.google-analytics.com https://*.analytics.google.com.
 */
export const GA4_PATHS = ['/', '/login', '/signup', '/terms', '/privacy'];

export function ga4Id() {
  const id = String(process.env.GA4_MEASUREMENT_ID || '').trim().toUpperCase();
  return /^G-[A-Z0-9]{4,20}$/.test(id) ? id : '';
}

/** The <head> snippet, or '' when GA4 is off. `id` is validated above, so it is safe to inline. */
export function ga4Tag() {
  const id = ga4Id();
  if (!id) return '';
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>(function(){var id='${id}';window.RELAI_GA4=id;window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};
var q=new URLSearchParams(location.search),k=new URLSearchParams();q.forEach(function(v,n){if(/^utm_|^gclid$/.test(n))k.append(n,v);});var s=k.toString();
var r=document.referrer;try{if(r&&new URL(r).origin===location.origin)r=location.origin+'/';}catch(e){r='';}
gtag('js',new Date());gtag('config',id,{anonymize_ip:true,send_page_view:true,allow_google_signals:false,allow_ad_personalization_signals:false,page_location:location.origin+location.pathname+(s?'?'+s:''),page_referrer:r});})();</script>`;
}

/** GA4 for this request: only the public paths, only logged-out, never a request carrying a token-ish query (invite / next / token). */
export function ga4For(req) {
  if (!GA4_PATHS.includes(req.path) || req.user) return '';
  if (req.query && (req.query.invite || req.query.next || req.query.token)) return '';
  return ga4Tag();
}
