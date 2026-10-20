/* 적용 환경 (batch7 #2) — shared by the server (definition.js, charter.js, exports, AI) and the 01 범위 work screen.
 * 01 records where the product must run (기기 · 브라우저 · OS · 해상도 · 언어), not features: feature scope is each requirement's
 * 범위 (IN/OUT). Stored as project_definitions.environments = { devices: {KEY: 'SUPPORTED'|'UNSUPPORTED'}, browsers: {…}, os, min_resolution, languages }.
 * Pure data + text helpers (no DOM), so the server can import it. */
export const ENV_STATUS = { SUPPORTED: '지원', UNSUPPORTED: '미지원' };
export const ENV_DEVICES = [['PC_WEB', 'PC 웹'], ['MOBILE_WEB', '모바일 웹'], ['TABLET', '태블릿'], ['IOS_APP', '모바일 앱(iOS)'], ['ANDROID_APP', '모바일 앱(Android)']];
export const ENV_BROWSERS = [['CHROME', 'Chrome'], ['EDGE', 'Edge'], ['SAFARI', 'Safari'], ['WHALE', 'Whale'], ['FIREFOX', 'Firefox']];
/** [key, label, max length, placeholder] */
export const ENV_TEXT = [['os', 'OS', 200, '예: Windows 10 이상, macOS 13 이상, iOS 16 이상, Android 12 이상'], ['min_resolution', '최소 해상도', 100, '예: 1280×720 (PC), 360×640 (모바일)'], ['languages', '언어', 200, '예: 한국어 (영문 미지원)']];
export const ENV_GROUPS = [['devices', '기기', ENV_DEVICES], ['browsers', '브라우저', ENV_BROWSERS]];

const labels = (opts, chosen = {}, st) => opts.filter(([k]) => chosen[k] === st).map(([, l]) => l);
/** Any choice made (st = 'SUPPORTED' → at least one 지원 기기·브라우저). */
export function hasEnvironment(e, st = null) {
  if (!e) return false;
  const any = ENV_GROUPS.some(([g]) => Object.values(e[g] || {}).some((v) => (st ? v === st : Boolean(v))));
  return st ? any : any || ENV_TEXT.some(([k]) => Boolean(e[k]));
}
/** '지원 PC 웹·Chrome·Edge · 미지원 모바일 앱(iOS)' — one line for summaries. */
export function envSummary(e) {
  if (!e) return '';
  const sup = ENV_GROUPS.flatMap(([g, , o]) => labels(o, e[g], 'SUPPORTED')); const uns = ENV_GROUPS.flatMap(([g, , o]) => labels(o, e[g], 'UNSUPPORTED'));
  return [sup.length ? `지원 ${sup.join('·')}` : '', uns.length ? `미지원 ${uns.join('·')}` : ''].filter(Boolean).join(' · ');
}
/** Rows for documents and the read view: [[구분, 지원, 미지원]] for 기기 · 브라우저, then [label, text, ''] for OS · 해상도 · 언어 that are filled. */
export function envLines(e) {
  if (!e) return [];
  const rows = ENV_GROUPS.map(([g, label, o]) => [label, labels(o, e[g], 'SUPPORTED').join(', '), labels(o, e[g], 'UNSUPPORTED').join(', ')]).filter((r) => r[1] || r[2]);
  for (const [k, label] of ENV_TEXT) if (e[k]) rows.push([label, e[k], '']);
  return rows;
}
