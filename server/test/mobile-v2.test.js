/* mobile-v2 — link previews: Open Graph / Twitter tags on every HTML page, absolute image URL, no token in og:url, brand icons served. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';

const get = async (base, path) => { const r = await fetch(base + path, { redirect: 'manual' }); return { status: r.status, type: r.headers.get('content-type') || '', text: r.headers.get('content-type')?.includes('html') ? await r.text() : null, buf: r.headers.get('content-type')?.includes('image') ? Buffer.from(await r.arrayBuffer()) : null }; };
const meta = (html, key) => { const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html); return m ? m[1] : null; };

test('share meta: landing, auth, legal and app shell carry og:* + twitter:*; image absolute; invite token never in og:url', async () => {
  const saved = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://relai.example';
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/login', '/signup', '/terms', '/privacy', '/invite/tok_SECRET123']) {
      const r = await get(base, path);
      assert.equal(r.status, 200, path);
      assert.equal(meta(r.text, 'og:image'), 'https://relai.example/brand/og-image.png', `${path} og:image`);
      assert.equal(meta(r.text, 'og:image:width'), '1200'); assert.equal(meta(r.text, 'og:image:height'), '630');
      assert.equal(meta(r.text, 'twitter:card'), 'summary_large_image', `${path} twitter:card`);
      assert.ok(meta(r.text, 'og:title') && meta(r.text, 'og:description'), `${path} title/description`);
      assert.match(r.text, /rel="apple-touch-icon" href="\/brand\/apple-touch-icon.png"/);
      assert.doesNotMatch(r.text, /SHARE_META|SECRET123/, `${path} placeholder or token leaked`);
    }
    assert.equal(meta((await get(base, '/')).text, 'og:url'), 'https://relai.example/');
    assert.equal(meta((await get(base, '/login')).text, 'og:url'), 'https://relai.example/login');
    assert.equal(meta((await get(base, '/terms')).text, 'og:title'), '이용약관 — RELAI');
    // without APP_BASE_URL the request origin is used
    delete process.env.APP_BASE_URL;
    assert.equal(meta((await get(base, '/')).text, 'og:image'), `${base}/brand/og-image.png`);
  } finally { if (saved === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = saved; server.close(); }
});

test('brand images: og-image.png is a 1200×630 PNG; icons and /favicon.ico are served', async () => {
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const png = (b) => ({ sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
    const og = await get(base, '/brand/og-image.png');
    assert.equal(og.status, 200); assert.deepEqual(png(og.buf), { sig: 'PNG', w: 1200, h: 630 });
    assert.deepEqual(png((await get(base, '/brand/apple-touch-icon.png')).buf), { sig: 'PNG', w: 180, h: 180 });
    const fav = await get(base, '/favicon.ico'); assert.equal(fav.status, 200); assert.match(fav.type, /image\/png/);
    const svg = await fetch(`${base}/brand/icon.svg`); assert.equal(svg.status, 200); assert.match(svg.headers.get('content-type'), /svg/);
  } finally { server.close(); }
});

test('landing (phone blocks): one hero CTA, phone product shot, proof cards and the sticky CTA exist; desktop blocks are untouched', async () => {
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = (await get(base, '/')).text;
    for (const s of ['class="hero__msub"', 'class="mshot" id="mpreview"', 'class="mproof"', 'id="mcta"', 'data-loc="mobile_sticky"']) assert.ok(h.includes(s), s);
    for (const s of ['class="shot" id="preview"', 'class="hero__sub"', 'class="flowline"', 'data-loc="hero_how"']) assert.ok(h.includes(s), `desktop ${s}`);
    // phone-only CSS is scoped to the ≤640px block and hidden by default
    assert.match(h, /\.hero__msub,\.hero__mnote,\.mshot,\.mproof,\.mcta\{display:none\}/);
  } finally { server.close(); }
});
