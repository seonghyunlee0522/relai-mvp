import { state } from './state.js';
import { isPhone, PHONE_MSG } from './device.js';

/** Writes a phone may still send (spec §2): sign-in/out and account mail, invitations, onboarding tips and guide hints. */
const PHONE_WRITE_OK = [/^\/api\/auth\//, /^\/api\/invitations\//, /\/onboarding\//, /^\/api\/guides\//];
/** Phone = view mode: one toast, however many callers catch and re-toast the same error. */
function phoneReadOnly() {
  if (!document.querySelector('.toast--ro')) { const t = document.createElement('div'); t.className = 'toast toast--ro'; t.setAttribute('role', 'status'); t.textContent = PHONE_MSG; document.body.append(t); setTimeout(() => t.remove(), 2600); }
  const e = new Error(PHONE_MSG); e.code = 'phone_read_only'; e.status = 0; e.fields = {}; e.error = null;
  return e;
}

export async function api(method, url, body) {
  if (method !== 'GET' && isPhone() && !PHONE_WRITE_OK.some((re) => re.test(url))) throw phoneReadOnly();
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.match(/^\/(login|signup|invite)/)) { location.href = '/login'; }
    if (res.status === 403 && data?.error?.code === 'account_suspended') { location.href = '/login?suspended=1'; }
    if (res.status === 402 && data?.error?.code === 'plan_limit_reached') window.dispatchEvent(new CustomEvent('relai:plan-limit', { detail: data.error }));   // shared/upgrade.js
    const e = new Error(data?.error?.message || '요청을 처리하지 못했습니다.');
    e.status = res.status; e.code = data?.error?.code; e.fields = data?.error?.fields || {}; e.error = data?.error || null;   // full error payload (AI credit balance/required etc.)
    throw e;
  }
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
