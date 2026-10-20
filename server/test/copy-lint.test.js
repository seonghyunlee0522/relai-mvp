/* batch7 #6 · #7 copy lint: a shipped SaaS never announces what it does not do yet, and credits are a usage unit on user screens.
 *  - "아직 지원 / 준비 중입니다 / 곧 제공 / coming soon" never appear in user-facing strings of public/app or server
 *    (exception: 착수보고회 summary '준비 중 · n/m', a state name, server/definition.js).
 *  - '₩' never appears in the app outside the admin console, the credit-pack purchase buttons (credits.js `krw`, only rendered while
 *    payments are on), the Team purchase form (settings.js / upgrade.js `won`, payments on only) and comments. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === 'test' || f === 'node_modules' ? [] : walk(p)) : p.endsWith('.js') ? [p] : []; });
const files = [...walk(join(root, 'public/app')), ...walk(join(root, 'server'))];
/** Code lines only: block / line comments are dropped (they may describe the rule itself). */
const codeLines = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'));

test('#6 no "not yet" copy in user-facing strings', () => {
  const bad = [];
  for (const f of files) codeLines(readFileSync(f, 'utf8')).forEach((l, i) => {
    if (!/아직 지원|준비 중입니다|곧 제공|coming soon/i.test(l)) return;
    bad.push(`${relative(root, f)}:${i + 1} ${l.trim().slice(0, 120)}`);
  });
  assert.deepEqual(bad, []);
  assert.match(readFileSync(join(root, 'server/definition.js'), 'utf8'), /준비 중 · /);   // the 착수보고회 state name stays
});

test('#7 no ₩ on user screens of the app (admin console, purchase-only helpers and comments excepted)', () => {
  const ALLOW = [/^public\/app\/admin\//, /^public\/app\/shared\/admin-labels\.js$/];
  const ALLOW_LINE = [/const krw = /, /const won = /, /data-pack=/, /<b>\$\{won\(/, /won\(co\./, /won\(PLAN_TEAM_MONTHLY\)/, /Team: \$\{won/];
  const bad = [];
  for (const f of walk(join(root, 'public/app'))) {
    const rel = relative(root, f); if (ALLOW.some((r) => r.test(rel))) continue;
    codeLines(readFileSync(f, 'utf8')).forEach((l, i) => { if (l.includes('₩') && !ALLOW_LINE.some((r) => r.test(l))) bad.push(`${rel}:${i + 1} ${l.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(bad, []);
  const landing = readFileSync(join(root, 'public/index.html'), 'utf8');
  const at = landing.indexOf('id="ai-credits"'); const ai = landing.slice(at, landing.indexOf('</div>', at));
  assert.ok(ai.length > 50 && !ai.includes('₩'), 'landing AI credit card has no won amounts');
  assert.match(ai, /AI 크레딧 500/);
});
