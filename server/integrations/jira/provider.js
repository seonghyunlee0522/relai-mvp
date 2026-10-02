/**
 * Jira provider = everything that talks to Atlassian. Two implementations behind one interface:
 *   live  — OAuth 3LO + REST v3 over api.atlassian.com (oauth.js + client.js)
 *   fake  — in-memory Jira used by tests and INTEGRATION_PROVIDER=fake dev servers; same shapes, no network.
 * The service layer only ever uses this interface, so domain code never sees HTTP.
 */
import { authorizeUrl, exchangeCode, refreshToken, accessibleResources, currentUser, OAuthError } from './oauth.js';
import { createJiraClient, JiraApiError, JiraAuthError } from './client.js';

export function liveJiraProvider(cfg, fetchImpl = globalThis.fetch) {
  return {
    name: 'JIRA', kind: 'live',
    authorizeUrl: (o) => authorizeUrl(cfg, o),
    exchangeCode: (o) => exchangeCode(cfg, o, fetchImpl),
    refresh: (rt) => refreshToken(cfg, rt, fetchImpl),
    accessibleResources: (at) => accessibleResources(cfg, at, fetchImpl),
    currentUser: (cloudId, at) => currentUser(cfg, cloudId, at, fetchImpl),
    client: ({ cloudId, accessToken }) => createJiraClient({ cloudId, accessToken, apiBase: cfg.apiBase, timeoutMs: cfg.timeoutMs, maxRetries: 0, fetchImpl }),
  };
}

/* ---------- fake ---------- */
const CAT = { new: { id: 2, key: 'new', name: 'To Do' }, indeterminate: { id: 4, key: 'indeterminate', name: 'In Progress' }, done: { id: 3, key: 'done', name: 'Done' } };
const STATUS = { todo: { id: '10000', name: 'To Do', cat: 'new' }, inprogress: { id: '10001', name: 'In Progress', cat: 'indeterminate' }, done: { id: '10002', name: 'Done', cat: 'done' }, qa: { id: '10003', name: 'QA 검증', cat: 'indeterminate' } };
const nowIso = () => new Date().toISOString();

export function fakeJiraProvider({ siteUrl = 'https://example.atlassian.net', cloudId = 'cloud-1' } = {}) {
  const f = {
    name: 'JIRA', kind: 'fake',
    calls: [], failNext: [],             // failNext: [{ status | kind:'timeout', times }]
    sites: [{ id: cloudId, name: 'example', url: siteUrl, scopes: ['read:jira-work', 'write:jira-work', 'manage:jira-webhook', 'offline_access'] }],
    user: { accountId: 'acc-owner', displayName: '홍길동(Jira)' },
    tokens: { accessSeq: 0, refreshSeq: 0, validRefresh: new Set(), validAccess: new Set() },
    projects: { ABC: { id: '10000', key: 'ABC', name: '신규 시스템 구축', issueTypes: [{ id: '1', name: 'Task', subtask: false }, { id: '2', name: 'Story', subtask: false }, { id: '3', name: 'Epic', subtask: false }, { id: '4', name: 'Bug', subtask: false }], requiredFields: {} },
      STRICT: { id: '10100', key: 'STRICT', name: '필수 필드 프로젝트', issueTypes: [{ id: '1', name: 'Task', subtask: false }], requiredFields: { 1: [{ fieldId: 'customfield_99', name: '고객 코드', required: true, schema: { type: 'string' } }] } } },
    issues: new Map(), seq: { ABC: 100, STRICT: 1 }, webhooks: [], webhookSeq: 1000, accessTokenTtl: 3600,
    deleted: new Set(),
    _tokenPair() { const a = `acc-${++f.tokens.accessSeq}`; const r = `ref-${++f.tokens.refreshSeq}`; f.tokens.validAccess.add(a); f.tokens.validRefresh.add(r); return { access_token: a, refresh_token: r, expires_in: f.accessTokenTtl, scope: f.sites[0].scopes.join(' ') }; },
    addIssue(key, { summary, type = 'Task', status = 'todo', assignee = null, project } = {}) {
      const pk = project || key.split('-')[0]; const st = STATUS[status] || STATUS.todo; const id = String(20000 + f.issues.size + 1);
      const it = { id, key, project: pk, summary: summary || key, type, status: st, assignee, updated: nowIso() };
      f.issues.set(id, it); return it;
    },
    setStatus(key, status) { const it = [...f.issues.values()].find((x) => x.key === key); if (!it) throw new Error('no issue ' + key); it.status = STATUS[status]; it.updated = nowIso(); return it; },
    deleteIssue(key) { const it = [...f.issues.values()].find((x) => x.key === key); if (it) { f.issues.delete(it.id); f.deleted.add(it.id); } },
    issueJson(it) { return { id: it.id, key: it.key, fields: { summary: it.summary, issuetype: { id: f.projects[it.project].issueTypes.find((t) => t.name === it.type)?.id || '1', name: it.type }, status: { id: it.status.id, name: it.status.name, statusCategory: CAT[it.status.cat] }, assignee: it.assignee ? { accountId: it.assignee.accountId, displayName: it.assignee.displayName } : null, updated: it.updated, project: { id: f.projects[it.project].id, key: it.project, name: f.projects[it.project].name } } }; },
    authorizeUrl: ({ state }) => `https://auth.atlassian.com/authorize?fake=1&state=${encodeURIComponent(state)}`,
    async exchangeCode({ code }) { f.calls.push(['exchange', code]); if (code !== 'good-code') throw new OAuthError('잘못된 인증 코드입니다.', { code: 'oauth_error', status: 400 }); return f._tokenPair(); },
    async refresh(rt) {
      f.calls.push(['refresh', rt]);
      if (!f.tokens.validRefresh.has(rt)) throw new OAuthError('Jira 재연결이 필요합니다. (인증이 만료되었거나 취소되었습니다)', { code: 'reconnect_required', status: 409, reconnect: true });
      f.tokens.validRefresh.delete(rt);   // rotating: single use
      return f._tokenPair();
    },
    async accessibleResources(at) { f.calls.push(['resources']); if (!f.tokens.validAccess.has(at)) throw new JiraAuthError(); return f.sites; },
    async currentUser() { return f.user; },
    client({ accessToken }) {
      const guard = (name) => {
        f.calls.push([name]);
        if (!f.tokens.validAccess.has(accessToken)) throw new JiraAuthError();
        const nf = f.failNext[0];
        if (nf && nf.times > 0) { nf.times--; if (nf.times === 0) f.failNext.shift(); if (nf.kind === 'timeout') throw new JiraApiError(0, 'Jira 응답이 지연되어 요청을 중단했습니다.', { code: 'jira_timeout' }); throw new JiraApiError(nf.status, `fake ${nf.status}`, { code: nf.status === 429 ? 'jira_rate_limited' : 'jira_api', retryAfterMs: 1 }); }
      };
      const proj = (k) => { const p = f.projects[k] || Object.values(f.projects).find((x) => x.id === String(k)); if (!p) throw new JiraApiError(404, 'No project could be found with key \'' + k + '\'.', { code: 'jira_not_found' }); return p; };
      return {
        myself: async () => { guard('myself'); return f.user; },
        searchProjects: async ({ query = '' } = {}) => { guard('searchProjects'); const vs = Object.values(f.projects).filter((p) => !query || p.key.toLowerCase().includes(query.toLowerCase()) || p.name.includes(query)).map((p) => ({ id: p.id, key: p.key, name: p.name })); return { values: vs, total: vs.length, isLast: true }; },
        getProject: async (k) => { guard('getProject'); const p = proj(k); return { id: p.id, key: p.key, name: p.name }; },
        issueTypesForProject: async (k) => { guard('issueTypes'); const p = proj(k); return { issueTypes: p.issueTypes, total: p.issueTypes.length }; },
        createFieldsFor: async (k, tid) => { guard('createFields'); const p = proj(k); const base = [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }, { fieldId: 'issuetype', name: 'Issue Type', required: true, schema: { type: 'issuetype' } }, { fieldId: 'project', name: 'Project', required: true, schema: { type: 'project' } }, { fieldId: 'description', name: 'Description', required: false, schema: { type: 'string' } }]; return { fields: [...base, ...(p.requiredFields[tid] || [])], total: 4 }; },
        createIssue: async (fields) => {
          guard('createIssue'); const p = proj(fields.project?.key || fields.project?.id);
          for (const rf of p.requiredFields[fields.issuetype?.id] || []) if (fields[rf.fieldId] === undefined) throw new JiraApiError(400, `Field '${rf.name}' is required`, { body: { errors: { [rf.fieldId]: `${rf.name} is required.` } } });
          const type = p.issueTypes.find((t) => t.id === fields.issuetype?.id)?.name || 'Task';
          const key = `${p.key}-${++f.seq[p.key]}`; const it = f.addIssue(key, { summary: fields.summary, type, project: p.key }); it.description = fields.description || null;
          return { id: it.id, key: it.key, self: `${siteUrl}/rest/api/3/issue/${it.id}` };
        },
        getIssue: async (k) => { guard('getIssue'); const it = [...f.issues.values()].find((x) => x.key === k || x.id === String(k)); if (!it) throw new JiraApiError(404, 'Issue does not exist or you do not have permission to see it.', { code: 'jira_not_found' }); return f.issueJson(it); },
        searchIssues: async ({ jql = '' } = {}) => {
          guard('searchIssues');
          let list = [...f.issues.values()];
          const pm = /project\s*=\s*"?([A-Z0-9]+)"?/i.exec(jql); if (pm) list = list.filter((x) => x.project === pm[1].toUpperCase());
          const im = /(?:id|key)\s+in\s*\(([^)]*)\)/i.exec(jql); if (im) { const ids = new Set(im[1].split(',').map((s) => s.trim().replace(/"/g, ''))); list = list.filter((x) => ids.has(x.id) || ids.has(x.key)); }
          const tm = /text\s*~\s*"([^"]*)"/i.exec(jql); if (tm) { const t = tm[1].toLowerCase().replace(/\*+$/, ''); list = list.filter((x) => x.summary.toLowerCase().includes(t) || x.key.toLowerCase().includes(t)); }
          return { issues: list.slice(0, 50).map(f.issueJson), isLast: true };
        },
        registerWebhooks: async (url, webhooks) => { guard('registerWebhooks'); return { webhookRegistrationResult: webhooks.map((w) => { const id = f.webhookSeq++; f.webhooks.push({ id, url, ...w, expirationDate: new Date(Date.now() + 30 * 864e5).toISOString() }); return { createdWebhookId: id }; }) }; },
        refreshWebhooks: async (ids) => { guard('refreshWebhooks'); const exp = new Date(Date.now() + 30 * 864e5).toISOString(); for (const w of f.webhooks) if (ids.includes(w.id)) w.expirationDate = exp; return { expirationDate: exp }; },
        deleteWebhooks: async (ids) => { guard('deleteWebhooks'); f.webhooks = f.webhooks.filter((w) => !ids.includes(w.id)); return true; },
      };
    },
  };
  return f;
}
