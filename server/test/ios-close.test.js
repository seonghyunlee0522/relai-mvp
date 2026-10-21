/* Outside-tap close on a real iPhone (founder 2026-10-21, Slack 1792535407.621089: "6번 안되는데" — pointerdown alone did not do it).
 * Phone menus get a transparent full-viewport backdrop just below them (public/app/core/outside.js); a tap on it closes the menu
 * via touchend (no click needed) or click. The browser run is scripts/e2e-ios-close.cjs (iPhone/iPad WebKit, Android, PC). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../../public/app/${p}`, import.meta.url), 'utf8');
const fakeEl = () => { const ls = {}; return { ls, addEventListener: (t, fn) => { ls[t] = fn; }, fire(t, e = {}) { ls[t]({ cancelable: true, preventDefault() { this.prevented = true; }, ...e, type: t }); } }; };

test('onTap: touchstart → touchend closes without any click, and blocks the synthetic click (no ghost tap underneath)', async () => {
  const { onTap } = await import('../../public/app/core/outside.js');
  const el = fakeEl(); const got = []; onTap(el, (e) => got.push(e.type));
  el.fire('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  const end = { cancelable: true, prevented: false, preventDefault() { end.prevented = true; } };
  el.ls.touchend({ ...end, type: 'touchend', preventDefault: end.preventDefault });
  assert.deepEqual(got, ['touchend']); assert.equal(end.prevented, true, 'synthetic click suppressed');
  el.fire('click'); assert.deepEqual(got, ['touchend', 'click'], 'a plain click (mouse / keyboard) also closes');
});

test('onTap: a drag (scroll) on the backdrop does not close', async () => {
  const { onTap } = await import('../../public/app/core/outside.js');
  const el = fakeEl(); let n = 0; onTap(el, () => { n++; });
  el.fire('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  el.fire('touchmove', { touches: [{ clientX: 10, clientY: 60 }] });
  el.fire('touchend'); assert.equal(n, 0);
});

test('fallback pointerdown closers ignore taps on the backdrop (the backdrop closes it on touchend instead)', async () => {
  const ls = []; globalThis.document = { addEventListener: (type, fn) => ls.push({ type, fn }) };
  try {
    const { closeOnOutsideTap, isBackdrop } = await import('../../public/app/core/outside.js?bd');
    let closed = 0; closeOnOutsideTap(() => false, () => { closed++; });
    ls.find((l) => l.type === 'pointerdown').fn({ target: { id: 'menubackdrop' } }); assert.equal(closed, 0);
    ls.find((l) => l.type === 'pointerdown').fn({ target: { id: 'x' } }); assert.equal(closed, 1);
    assert.equal(isBackdrop({ id: 'menubackdrop' }), true);
  } finally { delete globalThis.document; }
});

test('every menu registers its open state with the shared backdrop', () => {
  const reg = [['frame.js', ".dmenu'"], ['shared/toolmenu.js', ".tmenu:not([hidden])'"], ['core/outside.js', ".gpop:not([hidden])'"], ['project/actions.js', ".amenu'"], ['project/next.js', ".np__menu:not([hidden])'"]];
  for (const [f, sel] of reg) assert.match(src(f), new RegExp(`closeOnOutsideTap\\([^\\n]*, '${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), f);
  assert.match(src('onboarding/ui.js'), /trackMenu\('#helpmenu'/);
  assert.match(src('onboarding/ui.js'), /!isBackdrop\(e\.target\) && !e\.target\.closest\('#helpmenu, \.helpbtn'\)/);
  assert.match(src('core/outside.js'), /trackMenu\(OPEN_DETAILS/, 'details.pmenu / details.rmenu');
  assert.match(src('core/outside.js'), /addEventListener\('toggle', later, true\)/, '<details> toggle event');
  assert.match(src('shell.js'), /onTap\(\$\('#sidescrim'\), closeNav\)/, '더보기 sheet scrim');
});

test('backdrop CSS: fixed full viewport, clickable for iOS, transparent', () => {
  const css = src('app.css');
  const rule = css.match(/\.menubackdrop\{[^}]+\}/)[0];
  for (const d of ['position:fixed', 'inset:0', 'cursor:pointer', 'touch-action:manipulation', 'background:transparent']) assert.ok(rule.includes(d), d);
});
