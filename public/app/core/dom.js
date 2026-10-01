
export const fmtKRW = (n) => (n === null || n === undefined ? '-' : '₩' + Number(n).toLocaleString('ko-KR'));
export const fmtDays = (n) => (n === null || n === undefined ? '-' : n === 0 ? '0일' : `+${n}일`);
export const fmtMD = (n) => (n === null || n === undefined ? '-' : `${n} MD`);
export const no2 = (n) => String(n).padStart(2, '0');
export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${no2(d.getMonth() + 1)}-${no2(d.getDate())}`; };
export const fmtDT = (iso) => { if (!iso) return '-'; const d = new Date(iso); return `${d.getFullYear()}.${no2(d.getMonth() + 1)}.${no2(d.getDate())} ${no2(d.getHours())}:${no2(d.getMinutes())}`; };
export const fmtShort = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${no2(d.getDate())}`; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
export const raw = (s) => ({ __raw: s });
export const fmtDate = (d) => (d ? d.replaceAll('-', '.') : '-');
export const $ = (sel, el = document) => el.querySelector(sel);
export const root = $('#root');
