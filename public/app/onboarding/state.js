/* Onboarding client state (Phase 14). ONE request per workspace (GET /api/workspaces/:wid/onboarding), cached on `state`;
 * writes update the cache in place. Everything degrades: if the request fails, `ob.get()` resolves null and the app keeps working. */
import { api } from '../core/api.js';
import { state } from '../core/state.js';

let loading = null;
export const ob = {
  /** Cached summary for the current workspace (null when unavailable). */
  async get({ force = false } = {}) {
    const wid = state.workspace?.id; if (!wid || state.workspace.status === 'SUSPENDED') return null;
    if (!force && state.onboarding && state.onboarding.workspace?.id === wid) return state.onboarding;
    if (!loading) loading = api('GET', `/api/workspaces/${wid}/onboarding`).then((o) => { state.onboarding = o; return o; }).catch(() => null).finally(() => { loading = null; });
    return loading;
  },
  peek() { return state.onboarding && state.onboarding.workspace?.id === state.workspace?.id ? state.onboarding : null; },
  async update(key, action, step = null) {
    const wid = state.workspace?.id; if (!wid) return null;
    try {
      const r = await api('POST', `/api/workspaces/${wid}/onboarding/${key.toLowerCase()}/${action}`, step ? { step } : {});
      const o = this.peek(); const v = r[key.toLowerCase()];
      if (o && v) { if (key === 'PRODUCT_TOUR') o.tour = { ...o.tour, ...v }; else if (key === 'WELCOME') o.welcome = v; else if (key === 'CHECKLIST') o.checklist = { ...o.checklist, ...v, visible: v.status !== 'COMPLETED' && v.status !== 'SKIPPED' }; }
      return v;
    } catch { return null; }   // guide unavailable ≠ app unavailable
  },
  async refresh() { return this.get({ force: true }); },
  guideSeen(key) { const o = this.peek(); return Boolean(o && o.guides_seen && o.guides_seen.includes(key)); },
  async markGuide(key) {
    const o = this.peek(); if (o && o.guides_seen && !o.guides_seen.includes(key)) o.guides_seen.push(key);
    try { await api('POST', `/api/guides/${key}/seen`, {}); } catch { /* best effort */ }
  },
  async resetGuides() { const o = this.peek(); if (o) o.guides_seen = []; try { await api('POST', '/api/guides/reset', {}); } catch { /* best effort */ } },
  invalidate() { state.onboarding = null; },
};
