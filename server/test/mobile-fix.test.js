/* Mobile tap fixes (Jim live test 2026-10-21, hive research/relai-mobile-buttons-2026-10-21.md):
 * #1 도움말 › 가이드 다시 보기 on a phone opens /app/guide · #2 .pmenu closes on an outside tap · #3 더보기 sheet current phase closes the sheet
 * · #4 44px tap areas on phones · #5 /app/guide A/B/C cards open the sample · #6 menus also close on pointerdown (real iOS Safari). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../../public/app/${p}`, import.meta.url), 'utf8');

/** A minimal document: records listeners and serves querySelectorAll from a fixed list. */
function fakeDoc(nodes = []) {
  const ls = [];
  return { ls, addEventListener: (type, fn, capture) => ls.push({ type, fn, capture: Boolean(capture) }), removeEventListener() {},
    querySelectorAll: (sel) => nodes.filter((n) => sel.split(',').some((s) => n.matches(s.trim()))), querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    fire(type, target, extra = {}) { ls.filter((l) => l.type === type).forEach((l) => l.fn({ target, ...extra })); } };
}
const el = (inside) => ({ closest: (sel) => (inside && sel.split(',').some((s) => inside.includes(s.trim())) ? { sel } : null) });

test('#6 closeOnOutsideTap: closes on a pointerdown outside (capture phase), leaves the menu and its toggle to their click handlers', async () => {
  const doc = fakeDoc(); globalThis.document = doc;
  try {
    const { closeOnOutsideTap } = await import('../../public/app/core/outside.js');
    let closed = 0;
    closeOnOutsideTap((t) => t.closest('.dmenu, [data-dmenu]'), () => { closed++; });
    const l = doc.ls.find((x) => x.type === 'pointerdown'); assert.ok(l && l.capture, 'pointerdown listener in the capture phase');
    doc.fire('pointerdown', el(['.dmenu'])); assert.equal(closed, 0, 'tap inside the menu');
    doc.fire('pointerdown', el(['[data-dmenu]'])); assert.equal(closed, 0, 'tap on its own toggle');
    doc.fire('pointerdown', el(null)); assert.equal(closed, 1, 'tap on a blank area closes');
  } finally { delete globalThis.document; }
});

test('#2 wireDetailsMenus: an open .pmenu / .rmenu closes on an outside pointerdown or click and on Esc; its own tap keeps it', async () => {
  const mk = (cls) => { const d = { cls, open: true, matches: (s) => s === `details.${cls}[open]` && d.open, querySelector: () => ({ focus() { d.focused = true; } }) }; return d; };
  const pm = mk('pmenu'); const rm = mk('rmenu');
  const doc = fakeDoc([pm, rm]); globalThis.document = doc;
  try {
    const { wireDetailsMenus } = await import('../../public/app/core/outside.js?details');
    wireDetailsMenus(); wireDetailsMenus();
    assert.equal(doc.ls.filter((x) => x.type === 'pointerdown').length, 1, 'wired once');
    doc.fire('pointerdown', { closest: () => pm }); assert.equal(pm.open, true, 'own tap keeps it open'); assert.equal(rm.open, false, 'the other one closes');
    rm.open = true; doc.fire('click', { closest: () => null }); assert.deepEqual([pm.open, rm.open], [false, false], 'outside click closes both');
    pm.open = true; doc.fire('keydown', null, { key: 'Escape' }); assert.equal(pm.open, false); assert.ok(pm.focused, 'Esc returns focus to the summary');
  } finally { delete globalThis.document; }
});

test('#6 every outside-click menu also listens to pointerdown', () => {
  for (const f of ['frame.js', 'project/actions.js', 'project/next.js', 'shared/grid.js', 'shared/toolmenu.js']) assert.match(src(f), /closeOnOutsideTap\(/, f);
  assert.match(src('onboarding/ui.js'), /addEventListener\('pointerdown', down, true\)/);
  assert.match(src('onboarding/ui.js'), /removeEventListener\('pointerdown', down, true\)/, 'help menu removes its listener on close');
  assert.match(src('project/report.js'), /wireDetailsMenus\(\)/);
  assert.match(src('project/initiation.js'), /export function bindPlanMenu\(root, pid\) \{\n  wireDetailsMenus\(\)/);
  assert.match(src('project/initiation.js'), /export function bindReqDocMenu\(root, pid\) \{\n  wireDetailsMenus\(\)/);
});

test('#1 phone: 가이드 다시 보기 goes to the sample guide instead of a dead tour start', () => {
  assert.match(src('onboarding/tour.js'), /if \(isPhone\(\)\) \{ navigate\('\/app\/guide'\); return; \}/);
  assert.match(src('onboarding/ui.js'), /b\.dataset\.h === 'tour'\) \{ if \(isPhone\(\)\) \{ navigate\('\/app\/guide'\); return; \}/);
});

test('#3 더보기 sheet: tapping the phase already shown closes the sheet', () => {
  const s = src('project/lnb.js');
  assert.match(s, /import \{ closeNav \} from '\.\.\/shell\.js'/);
  assert.match(s, /else if \(isPhone\(\)\) \{[^}]*closeNav\(\)/);
  assert.match(src('shell.js'), /export const closeNav/);
});

test('#5 /app/guide A/B/C cards link to the sample project (anchor only when the sample is missing)', () => {
  const s = src('project/sample-guide.js');
  assert.match(s, /class="sg-pick__i" href="\/app\/projects\/\$\{ids\[s\.key\]\}" data-link data-sg-card/);
  assert.match(s, /: html`<a class="sg-pick__i" href="#sg-\$\{s\.key\}" data-sg-jump/);
});

test('#4 phone-only 44px tap areas for the controls Jim measured', () => {
  const css = src('app.css'); const blk = css.slice(css.indexOf('\n', css.indexOf('Jim mobile 10-21 #4')) + 1);
  for (const sel of ['.sg-end a', '.ovsec__ctx a', '.actrow__h a', '.appfoot a', '.hc__attmore a', '.sbanner p a', '.defsec__pg a', '.coach__x', '.coach__more', '.gfoot .btn--xs', '.pl-faq summary']) assert.ok(blk.includes(sel), sel);
  blk.split('\n').filter((l) => l.trim() && !l.startsWith('/*') && !l.startsWith('@media')).forEach((l) => assert.match(l, /^html\.is-phone /, `phone only: ${l.slice(0, 60)}`));
});
