/**
 * Content-Security-Policy for every HTML page the server renders (landing, app shell, legal pages, payment pages).
 *
 * Strict nonce policy (https://web.dev/articles/strict-csp): each HTML response gets a fresh nonce, every <script> tag in it
 * gets nonce="…", and 'strict-dynamic' lets those trusted scripts load what they need (gtag → GA4 / Google Ads, SPA module
 * imports, the NicePay SDK). Host allowlists and 'unsafe-inline' are fallbacks that CSP3 browsers ignore once a nonce is
 * present, so an injected <script> or inline handler without the nonce does not run. No inline event handlers exist in the
 * code base (2026-10-29), so none have to be allowed.
 *
 * Payment pages also allow 'unsafe-eval' because the NicePay SDK (third-party, not reviewable here) may need it.
 * Only script-src, object-src, base-uri and frame-ancestors are restricted — styles, images and connections stay open so
 * fonts, Google Ads conversion pixels and the NicePay window keep working.
 *
 * CSP_MODE=report sends the same policy as Content-Security-Policy-Report-Only (rollback switch without a deploy);
 * CSP_MODE=off disables it.
 */
import { randomBytes } from 'node:crypto';

const PAYMENT_PATH = /^\/(pay\/|api\/billing\/[^/]+\/pay\/)/;
const HTML_START = /^\s*(<!doctype html|<html)/i;
const SCRIPT_TAG = /<script\b(?![^>]*\bnonce=)/gi;

export function cspPolicy(nonce, { payment = false } = {}) {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic'${payment ? " 'unsafe-eval'" : ''} https: 'unsafe-inline'`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Adds the nonce to every <script> tag of an HTML string. */
export const addNonce = (html, nonce) => html.replace(SCRIPT_TAG, `<script nonce="${nonce}"`);

export function cspMiddleware(env = process.env) {
  const mode = String(env.CSP_MODE || 'enforce').trim().toLowerCase();
  if (mode === 'off') return (req, res, next) => next();
  const header = mode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  return (req, res, next) => {
    const send = res.send;
    res.send = function (body) {
      if (typeof body === 'string' && HTML_START.test(body) && !res.get(header)) {
        const nonce = randomBytes(16).toString('base64');
        body = addNonce(body, nonce);
        res.set(header, cspPolicy(nonce, { payment: PAYMENT_PATH.test(req.path) }));
      }
      return send.call(this, body);
    };
    next();
  };
}
