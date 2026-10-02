/**
 * Jira Cloud REST v3 client over the OAuth gateway (https://api.atlassian.com/ex/jira/{cloudId}). One instance per call
 * site; the access token is supplied by the integration service (which handles refresh + locking) and never logged.
 *
 * Errors: 401 → JiraAuthError (the service decides whether to refresh or flag reconnect_required); other statuses, timeouts and
 * network failures → JiraApiError with a code. Retrying (429 / 5xx / timeout, Retry-After aware) is done per method by the
 * service's withRetry wrapper so the fake provider exercises the same policy.
 */
export class JiraApiError extends Error {
  constructor(status, message, { code = 'jira_api', body = null, retryAfterMs = 0 } = {}) { super(message); this.status = status; this.code = code; this.body = body; this.retryAfterMs = retryAfterMs; }
}
export class JiraAuthError extends JiraApiError { constructor(message = 'Jira 인증이 만료되었습니다.') { super(401, message, { code: 'jira_auth' }); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (body) => { if (!body) return ''; if (Array.isArray(body.errorMessages) && body.errorMessages.length) return body.errorMessages.join(' '); if (body.errors && typeof body.errors === 'object') return Object.values(body.errors).join(' '); return body.message || body.error_description || body.error || ''; };

/** fetch with timeout + retries. `fetchImpl` is injectable (tests use the fake provider instead, but unit tests can stub this). */
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, maxRetries = 2, fetchImpl = globalThis.fetch } = {}) {
  let attempt = 0;
  for (;;) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res; let json = null; let text = '';
    try {
      res = await fetchImpl(url, { method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ac.signal });
      text = await res.text(); try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    } catch (e) {
      clearTimeout(timer);
      if (attempt < maxRetries) { attempt++; await sleep(300 * attempt); continue; }
      throw new JiraApiError(0, e.name === 'AbortError' ? 'Jira 응답이 지연되어 요청을 중단했습니다.' : `Jira에 연결할 수 없습니다. (${e.message})`, { code: e.name === 'AbortError' ? 'jira_timeout' : 'jira_network' });
    }
    clearTimeout(timer);
    if (res.ok) return { status: res.status, json, text };
    if (res.status === 401) throw new JiraAuthError();
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const ra = Number(res.headers.get('retry-after')); const wait = Math.min(20000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * (attempt + 1));
      attempt++; await sleep(wait); continue;
    }
    const msg = errText(json) || `Jira 요청이 실패했습니다. (HTTP ${res.status})`;
    const ra = Number(res.headers.get('retry-after'));
    throw new JiraApiError(res.status, msg, { body: json, code: res.status === 429 ? 'jira_rate_limited' : res.status === 403 ? 'jira_forbidden' : res.status === 404 ? 'jira_not_found' : 'jira_api', retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0 });
  }
}

/** Fields we read for every issue — the snapshot never stores more than this. */
export const ISSUE_FIELDS = ['summary', 'issuetype', 'status', 'assignee', 'updated', 'project'];

export function createJiraClient({ cloudId, accessToken, apiBase, timeoutMs, maxRetries = 0, fetchImpl }) {
  const base = `${apiBase}/${cloudId}/rest/api/3`;
  const call = (path, opts = {}) => httpJson(`${base}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) }, timeoutMs, maxRetries, fetchImpl });
  const q = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
  return {
    myself: async () => (await call('/myself')).json,
    searchProjects: async ({ query = '', maxResults = 50 } = {}) => (await call(`/project/search${q({ query, maxResults, orderBy: 'name' })}`)).json,
    getProject: async (keyOrId) => (await call(`/project/${encodeURIComponent(keyOrId)}`)).json,
    issueTypesForProject: async (keyOrId) => (await call(`/issue/createmeta/${encodeURIComponent(keyOrId)}/issuetypes${q({ maxResults: 200 })}`)).json,
    createFieldsFor: async (keyOrId, issueTypeId) => (await call(`/issue/createmeta/${encodeURIComponent(keyOrId)}/issuetypes/${encodeURIComponent(issueTypeId)}${q({ maxResults: 200 })}`)).json,
    createIssue: async (fields) => (await call('/issue', { method: 'POST', body: { fields } })).json,
    getIssue: async (keyOrId) => (await call(`/issue/${encodeURIComponent(keyOrId)}${q({ fields: ISSUE_FIELDS.join(',') })}`)).json,
    /** Enhanced search (the classic /search endpoint is being removed). */
    searchIssues: async ({ jql, maxResults = 50, nextPageToken } = {}) => (await call('/search/jql', { method: 'POST', body: { jql, maxResults, fields: ISSUE_FIELDS, ...(nextPageToken ? { nextPageToken } : {}) } })).json,
    registerWebhooks: async (url, webhooks) => (await call('/webhook', { method: 'POST', body: { url, webhooks } })).json,
    refreshWebhooks: async (webhookIds) => (await call('/webhook/refresh', { method: 'PUT', body: { webhookIds } })).json,
    deleteWebhooks: async (webhookIds) => { await call('/webhook', { method: 'DELETE', body: { webhookIds } }); return true; },
  };
}
