/* UI utilities: persisted view preferences, state-preserving redraw, authenticated file downloads. */

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem('relai.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('relai.' + key, JSON.stringify(value)); } catch { /* storage unavailable — preferences just won't persist */ } },
};

export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Scrollable regions whose offsets must survive a re-render. */
const SCROLLERS = ['.drawer__b', '.gridwrap', '.ganttwrap', '.imp__body'];

/**
 * Run a render function while keeping page scroll, the scroll offsets of data regions and the focused field.
 * Pages re-render large parts of the DOM after every save; without this the user loses their place on each edit.
 */
export function keepUi(fn) {
  const y = window.scrollY;
  const saved = SCROLLERS.map((s) => { const el = document.querySelector(s); return el ? [s, el.scrollTop, el.scrollLeft] : null; }).filter(Boolean);
  const a = document.activeElement;
  let focus = null;
  if (a && a !== document.body) {
    const sel = a.id ? '#' + CSS.escape(a.id) : a.dataset && a.dataset.field ? `[data-field="${a.dataset.field}"]` : null;
    if (sel) focus = { sel, start: a.selectionStart, end: a.selectionEnd };
  }
  fn();
  window.scrollTo(0, y);
  for (const [s, t, l] of saved) { const el = document.querySelector(s); if (el) { el.scrollTop = t; el.scrollLeft = l; } }
  if (focus) {
    const el = document.querySelector(focus.sel);
    if (el && el.focus) { el.focus({ preventScroll: true }); try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch { /* not a text control */ } }
  }
}

const dispositionName = (h) => {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h); if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(h); return plain ? plain[1] : null;
};

/** Fetch a binary response with the session cookie and hand it to the browser as a file download. */
export async function download(url, { method = 'GET', body, filename } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = '파일을 내려받지 못했습니다.';
    try { msg = (await res.json()).error.message || msg; } catch { /* non-JSON error */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || dispositionName(res.headers.get('Content-Disposition')) || 'download.xlsx';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** File → base64 (no data: prefix). */
export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
  r.readAsDataURL(file);
});
