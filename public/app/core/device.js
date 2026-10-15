/* Phone = view mode (hive research/relai-mobile-spec.md): one breakpoint (< 768px), one flag on <html>.
 * On a phone you look; on a PC you do. CSS hides edit controls under html.is-phone, core/api.js blocks writes as the backstop,
 * and a rotate/resize across 768px re-renders the current page in the other mode (no reload). */
export const PHONE_MQ = typeof matchMedia === 'undefined' ? { matches: false, addEventListener() {} } : matchMedia('(max-width: 767px)');
export const isPhone = () => PHONE_MQ.matches;
export const PHONE_MSG = 'PC에서 편집할 수 있습니다.';
/** The one calm line that replaces removed actions — once per screen, under the title (phone only). */
export const pcLine = (text = 'PC에서 편집할 수 있습니다') => (isPhone() ? `<p class="pcline" data-pcline>${text}</p>` : '');

const flag = () => { if (typeof document !== 'undefined') document.documentElement.classList.toggle('is-phone', isPhone()); };
flag();
/** `render` = the router's render(); called when the width crosses the breakpoint. */
export function onDeviceChange(render) { PHONE_MQ.addEventListener('change', () => { flag(); render(); }); }

/* Backstop for A10 (no input / select / textarea in a phone detail): any form field the pages render inside #main or a sheet
 * is replaced by its value as plain text. Search and filter controls (toolbar, 필터 sheet) and [data-phone-ok] stay live. */
const KEEP = '.rtool, .ptoolbar, .gpop--filters, .gfoot, .pstepw, .dtabs, [data-phone-ok], [type=search], [type=hidden]';
const asText = (el) => {
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '✓' : '○';
  if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return o && o.value !== '' ? o.textContent.trim() : '-'; }
  return String(el.value || '').trim() || '-';
};
export function freezeFields(root) {
  if (!isPhone() || !root) return;
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.closest(KEEP) || el.matches(KEEP) || !el.closest('#main, .drawer, .scrim, .wdrawer')) return;
    if ((el.type === 'checkbox' || el.type === 'radio') && el.closest('label.toggle')) { el.closest('label.toggle').remove(); return; }
    const s = document.createElement('span');
    s.className = `rofield ${el.tagName === 'TEXTAREA' ? 'rofield--long' : ''}`; s.textContent = asText(el);
    el.replaceWith(s);
  });
}
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  let queued = false;
  new MutationObserver(() => { if (queued || !isPhone()) return; queued = true; queueMicrotask(() => { queued = false; freezeFields(document.body); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
}
