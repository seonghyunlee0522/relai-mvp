/* Jim 10-21 (founder: "wbs에 가운데 있는 버튼 눌러도 아무 반응 없던데"): the phone WBS count chips 진행 중 · 완료 · 마일스톤 were <span>s.
 * They are filters now, with the same rule for the number and the rows. Plus: .gpop popovers (테스트 › Excel ▾) close on an outside
 * click on every page — the closer used to be bound only after a grid with column tools rendered. Browser run: scripts/e2e-wbs-chips.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../../public/app/${p}`, import.meta.url), 'utf8');

test('WBS count chips: all five are buttons with a filter key, none is a dead <span>', () => {
  const s = src('wbs/page.js');
  assert.doesNotMatch(s, /<span class="kchip"/);
  for (const k of ["chip('', summary.total, '전체 항목')", "chip('in_progress', n('in_progress'), '진행 중')", "chip('completed', n('completed'), '완료')", "chip('milestone', n('milestone'), '마일스톤')", "chip('overdue', late, '지연 작업'"]) assert.ok(s.includes(k), k);
  assert.match(s, /data-kf="\$\{k\}" aria-pressed="\$\{f === k\}"/, 'active state');
  assert.match(s, /setParam\('f', k && k === quick\(\) \? '' : k\)/, 'tapping the active chip clears it');
  assert.match(s, /KF_HIT\[f\] \? !isSys\(it\) && KF_HIT\[f\]\(it\)/, 'the filter uses the same rule as the count');
});

test('WBS count chips: count = rows the filter keeps (same KF_HIT rule)', () => {
  const s = src('wbs/page.js');
  const KF_HIT = eval(`(${s.match(/const KF_HIT = (\{[^\n]+\});/)[1]})`);
  const rows = [{ status: 'IN_PROGRESS', item_type: 'TASK' }, { status: 'COMPLETED', item_type: 'TASK' }, { status: 'COMPLETED', item_type: 'MILESTONE' }, { status: 'NOT_STARTED', item_type: 'MILESTONE' }, { status: 'NOT_STARTED', item_type: 'TASK' }];
  assert.equal(rows.filter(KF_HIT.in_progress).length, 1);
  assert.equal(rows.filter(KF_HIT.completed).length, 2, '완료 = status COMPLETED (tasks and milestones, like summary.completed)');
  assert.equal(rows.filter(KF_HIT.milestone).length, 2, '마일스톤 = milestone rows');
});

test('WBS count chips: 44px tap height on phones, visible active state', () => {
  const css = src('app.css');
  assert.ok(css.includes('html.is-phone button.kchip{min-height:44px'));
  assert.match(css, /\.kchip\.is-on\{[^}]*border-color:var\(--blue\)/);
  assert.doesNotMatch(css, /^(=======|<<<<<<<|>>>>>>>)/m, 'no merge-conflict markers');
});

test('.gpop outside close is global (app start), not bound by the grid', () => {
  assert.match(src('app.js'), /^wireGpops\(\);/m);
  assert.doesNotMatch(src('shared/grid.js'), /gpopBound|closeOnOutsideTap/);
});

test('wireGpops: an outside pointerdown closes an open popover on a page without a grid; its toggle and itself do not', async () => {
  const ls = []; const pop = { hidden: false };
  globalThis.document = { addEventListener: (type, fn) => ls.push({ type, fn }), querySelectorAll: (sel) => (sel.includes(':not([hidden])') ? (pop.hidden ? [] : [pop]) : [pop]) };
  try {
    const { wireGpops } = await import('../../public/app/core/outside.js?gpop');
    wireGpops(); wireGpops();
    const down = ls.filter((l) => l.type === 'pointerdown'); assert.equal(down.length, 1, 'wired once');
    const el = (inside) => ({ id: 'x', closest: (sel) => (inside && sel.split(', ').includes(inside) ? {} : null) });
    down[0].fn({ target: el('#xl-btn') }); assert.equal(pop.hidden, false, 'Excel ▾ toggle');
    down[0].fn({ target: el('.gpop') }); assert.equal(pop.hidden, false, 'inside the popover');
    down[0].fn({ target: { id: 'menubackdrop' } }); assert.equal(pop.hidden, false, 'backdrop closes on its own tap');
    down[0].fn({ target: el(null) }); assert.equal(pop.hidden, true, 'outside');
    pop.hidden = false; ls.find((l) => l.type === 'keydown').fn({ key: 'Escape' }); assert.equal(pop.hidden, true, 'Esc');
  } finally { delete globalThis.document; }
});
