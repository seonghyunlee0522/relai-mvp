import { state } from './state.js';

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.match(/^\/(login|signup)/)) { location.href = '/login'; }
    const e = new Error(data?.error?.message || '요청을 처리하지 못했습니다.');
    e.status = res.status; e.code = data?.error?.code; e.fields = data?.error?.fields || {};
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
