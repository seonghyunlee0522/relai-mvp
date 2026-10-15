/* Phone = view mode (hive research/relai-mobile-spec.md): one breakpoint (< 768px), one flag on <html>.
 * On a phone you look; on a PC you do. CSS hides edit controls under html.is-phone, core/api.js blocks writes as the backstop,
 * and a rotate/resize across 768px re-renders the current app page in the other mode (no reload). Open dialogs are not re-rendered:
 * their frozen fields are only hidden (see freezeFields), so widening back to a PC shows them again with what was typed. */
export const PHONE_MQ = typeof matchMedia === 'undefined' ? { matches: false, addEventListener() {} } : matchMedia('(max-width: 767px)');
export const isPhone = () => PHONE_MQ.matches;
export const PHONE_MSG = 'PC에서 편집할 수 있습니다.';
/** The one calm line that replaces removed actions — once per screen, under the title (phone only). */
export const pcLine = (text = 'PC에서 편집할 수 있습니다') => (isPhone() ? `<p class="pcline" data-pcline>${text}</p>` : '');

const flag = () => { if (typeof document !== 'undefined') document.documentElement.classList.toggle('is-phone', isPhone()); };
flag();
/** `render` = the router's render(); called when the width crosses the breakpoint. Auth / account / invite pages look the same
 * in both modes, so they are left alone (a re-render would wipe what was typed into /signup, e.g. on rotating a phone). */
export function onDeviceChange(render) {
  PHONE_MQ.addEventListener('change', async () => {
    flag();
    if (isPhone()) saveDrafts(); else thawFields();
    if (!/^\/(app|admin)(\/|$)/.test(location.pathname)) return;
    await render();
    if (!isPhone()) restoreDrafts();
  });
}

/* Drafts across the crossing (Q21-1): a page re-render rebuilds a drawer it reopens from the URL (요구사항 ?new=1) with empty
 * fields. Going to a phone saves what is typed in every open dialog / drawer form; back on a PC, after the re-render, the same
 * fields (same container, same id / name / data-field) get it back. Kept only for the same URL; a field the user already changed is left alone. */
const OPEN = '.drawer:not([hidden]), .wdrawer:not([hidden]), .scrim, [role=dialog]';
let drafts = null;
const fieldKey = (el) => el.id ? '#' + el.id : el.name ? `[name="${el.name}"]` : el.dataset.field ? `[data-field="${el.dataset.field}"]` : null;
const boxKey = (box) => box.id ? '#' + box.id : box.className.split(/\s+/).filter((c) => /^(drawer|wdrawer|scrim|dialog)(--|$)/.test(c)).join('.');
const fieldsOf = (box) => [...box.querySelectorAll('input, select, textarea')].filter((el) => !['hidden', 'file', 'search', 'password', 'button', 'submit'].includes(el.type) && fieldKey(el));
const valueOf = (el) => (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
const isDefault = (el) => (el.type === 'checkbox' || el.type === 'radio' ? el.checked === el.defaultChecked
  : el.tagName === 'SELECT' ? [...el.options].every((o) => o.selected === o.defaultSelected) : el.value === el.defaultValue);
export function saveDrafts() {
  const out = [];
  for (const box of document.querySelectorAll(OPEN)) {
    if (box.parentElement?.closest(OPEN)) continue;   // nested [role=dialog] inside a scrim: the outer box covers it
    const vals = fieldsOf(box).filter((el) => !isDefault(el)).map((el) => [fieldKey(el), valueOf(el)]);
    if (vals.length) out.push({ box: boxKey(box), vals });
  }
  drafts = out.length ? { url: location.pathname + location.search, out } : null;
}
export function restoreDrafts(tries = 8) {
  if (!drafts) return;
  if (drafts.url !== location.pathname + location.search) { drafts = null; return; }
  let left = 0;
  for (const d of drafts.out) {
    const box = [...document.querySelectorAll(OPEN)].find((b) => boxKey(b) === d.box);
    d.vals = d.vals.filter(([k, v]) => {
      const el = box && box.querySelector(k);
      if (!el) { left++; return true; }   // the page may still be loading the form
      if (isDefault(el)) {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return false;
    });
  }
  if (left && tries > 0) setTimeout(() => restoreDrafts(tries - 1), 150); else drafts = null;
}

/* Backstop for A10 (no input / select / textarea in a phone detail): any form field the pages render inside #main or a sheet
 * is hidden and shown as its value in plain text; thawFields() undoes it when the width goes back to a PC. Search and filter controls (toolbar, 필터 sheet) and [data-phone-ok] stay live. */
const KEEP = '.rtool, .ptoolbar, .gpop--filters, .gfoot, .pstepw, .dtabs, [data-phone-ok], [type=search], [type=hidden]';
const asText = (el) => {
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '✓' : '○';
  if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return o && o.value !== '' ? o.textContent.trim() : '-'; }
  return String(el.value || '').trim() || '-';
};
export function freezeFields(root) {
  if (!isPhone() || !root) return;
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.classList.contains('rofrozen') || el.closest('.rofrozen') || el.closest(KEEP) || el.matches(KEEP) || !el.closest('#main, .drawer, .scrim, .wdrawer')) return;
    if ((el.type === 'checkbox' || el.type === 'radio') && el.closest('label.toggle')) { el.closest('label.toggle').classList.add('rofrozen'); return; }
    const s = document.createElement('span');
    s.className = `rofield ${el.tagName === 'TEXTAREA' ? 'rofield--long' : ''}`; s.dataset.rofield = ''; s.textContent = asText(el);
    el.classList.add('rofrozen'); el.after(s);
  });
}
export function thawFields(root = document) {
  root.querySelectorAll('[data-rofield]').forEach((s) => s.remove());
  root.querySelectorAll('.rofrozen').forEach((el) => el.classList.remove('rofrozen'));
}
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  let queued = false;
  new MutationObserver(() => { if (queued || !isPhone()) return; queued = true; queueMicrotask(() => { queued = false; freezeFields(document.body); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
}
