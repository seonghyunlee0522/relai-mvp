import { state } from './state.js';
import { isPhone, PHONE_MSG } from './device.js';

/** Writes a phone may still send (spec §2): sign-in/out and account mail, invitations, onboarding tips and guide hints. */
const PHONE_WRITE_OK = [/^\/api\/auth\//, /^\/api\/invitations\//, /\/onboarding\//, /^\/api\/guides\//, /^\/api\/feedback$/,
  /\/billing\/cancel$/, /\/billing\/changes\/[^/]+\/cancel$/];   // 의견 남기기 works in view mode too; 해지 / 예약 취소 too (해지는 어디서나 — 전자상거래법 §21의2, pricing v3 T3)
/** Phone = view mode: one toast, however many callers catch and re-toast the same error. */
function phoneReadOnly() {
  if (!document.querySelector('.toast--ro')) { const t = document.createElement('div'); t.className = 'toast toast--ro'; t.setAttribute('role', 'status'); t.textContent = PHONE_MSG; document.body.append(t); setTimeout(() => t.remove(), 2600); }
  const e = new Error(PHONE_MSG); e.code = 'phone_read_only'; e.status = 0; e.fields = {}; e.error = null;
  return e;
}

export async function api(method, url, body) {
  if (method !== 'GET' && isPhone() && !PHONE_WRITE_OK.some((re) => re.test(url))) throw phoneReadOnly();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {   // offline / connection cut: the browser's own text ('Failed to fetch', 'Load failed') must not reach the toast
    const e = new Error(method === 'GET' ? '네트워크 연결이 불안정합니다. 연결을 확인한 뒤 다시 시도해 주세요.'
      : '네트워크 연결이 끊겨 저장 여부를 확인하지 못했습니다. 새로고침해서 반영됐는지 확인한 뒤 다시 시도해 주세요.');
    e.status = 0; e.code = 'network'; e.fields = {}; e.error = null;
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.match(/^\/(login|signup|invite)/)) { location.href = '/login'; }
    if (res.status === 403 && data?.error?.code === 'account_suspended') { location.href = '/login?suspended=1'; }
    if (res.status === 402 && ['plan_limit_reached', 'AI_USAGE_LIMIT_REACHED'].includes(data?.error?.code)) window.dispatchEvent(new CustomEvent('relai:plan-limit', { detail: data.error }));   // shared/upgrade.js → plans page
    const e = new Error(data?.error?.message || (res.status >= 500 ? '서버가 잠시 응답하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했습니다.'));   // 5xx without JSON = boot 503 / platform error page
    e.status = res.status; e.code = data?.error?.code; e.fields = data?.error?.fields || {}; e.error = data?.error || null;   // full error payload (AI credit balance/required etc.)
    throw e;
  }
  // batch7 B5: a successful write tells listeners (the top-bar 다음 할 일 strip) that project data changed
  if (method !== 'GET') { try { window.dispatchEvent(new CustomEvent('relai:data-changed', { detail: { method, url } })); } catch { /* no window (tests) */ } }
  return data;
}
export const wsApi = (p = '') => `/api/workspaces/${state.workspace.id}/projects${p}`;

/** Workspace members, fetched once per workspace (every list screen needs them for owner pickers). */
let memberCache = { id: null, promise: null };
export const getMembers = () => {
  const id = state.workspace.id;
  if (memberCache.id !== id || !memberCache.promise) {
    const promise = api('GET', `/api/workspaces/${id}/members`).then((d) => d.members);
    promise.catch(() => { memberCache = { id: null, promise: null }; });
    memberCache = { id, promise };
  }
  return memberCache.promise;
};
export const resetMembers = () => { memberCache = { id: null, promise: null }; };
