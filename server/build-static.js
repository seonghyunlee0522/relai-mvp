/* Vercel build step (vercel.json buildCommand): copy the static files of public/ into .vercel-static so the CDN serves them
 * and they never invoke the serverless function (2026-10-21: ~100 ES modules per page load each ran api/index.js, every
 * cold instance opened its own pg pool, and Neon ran out of connections and memory).
 * public/app → /assets (the path the SPA loads it from); brand, img, service keep their paths. HTML stays with the function:
 * pages are rendered there (share meta, GA4, landing count, auth redirects), and a static .html would win over the rewrite. */
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.vercel-static');
const copies = [['public/app', 'assets'], ['public/brand', 'brand'], ['public/img', 'img'], ['public/service', 'service']];
const notHtml = (src) => !src.endsWith('.html');
for (const [from, to] of copies) {
  rmSync(resolve(out, to), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(resolve(root, from), resolve(out, to), { recursive: true, filter: notHtml });
}
console.log(`[build-static] copied ${copies.map(([f, t]) => `${f} → /${t}`).join(', ')}`);
