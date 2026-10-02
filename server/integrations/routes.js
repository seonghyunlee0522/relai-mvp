/**
 * Integration routes.
 *   Workspace (guard chain + integration_manage for connect/disconnect):
 *     GET  /api/workspaces/:wid/integrations                       card models (never tokens)
 *     POST /api/workspaces/:wid/integrations/jira/connect          → { url } (OAuth 3LO start)
 *     POST /api/workspaces/:wid/integrations/jira/disconnect
 *   OAuth callback (session cookie, state binds workspace+user):
 *     GET  /api/integrations/jira/callback?code&state              → redirect /app/settings?jira=ok|error
 *   Project (members; mapping changes need project_manage):
 *     GET  …/:pid/integrations/jira                                mapping screen model
 *     GET  …/:pid/integrations/jira/projects?q=                    Jira projects (live)
 *     GET  …/:pid/integrations/jira/issue-types?project_key=       creatable issue types (live)
 *     PUT  …/:pid/integrations/jira/mapping | DELETE               (OWNER/ADMIN)
 *     POST …/:pid/integrations/jira/sync                           manual sync
 *     GET  …/:pid/integrations/jira/issues/search?q=               search in the mapped Jira project (live)
 *     GET  …/:pid/wbs/:iid/jira | POST …/jira/issues | POST …/jira/links | DELETE …/jira/links/:lid | POST …/jira/refresh
 *   Webhook (no session):  POST /api/integrations/jira/webhook/:cid/:secret
 *   Admin (operator):      GET /api/admin/integrations
 */
import express from 'express';
import { requireAction } from '../authz.js';
import * as S from './service.js';
import * as J from './jira/sync.js';
import { handleJiraWebhook } from './jira/webhook.js';
import { listActivity } from './events.js';
import { JiraApiError } from './jira/client.js';

export function mountIntegrationRoutes({ app, db, guard, wrap, fail, requireAuth, loadProject, mutable, base }) {
  const manage = [...guard, requireAction('integration_manage')];
  const pmanage = [...guard, requireAction('project_manage')];
  const send = (res, fn) => fn().catch((e) => {
    if (e instanceof S.IntegrationError) { const { mark, ...extra } = e.extra || {}; void mark; return fail(res, e.status, e.code, e.message, extra); }
    if (e instanceof JiraApiError) return fail(res, e.status >= 400 && e.status < 600 ? (e.status === 401 ? 409 : e.status === 429 ? 429 : 502) : 502, e.code, e.message);
    throw e;
  });

  app.get(`/api/workspaces/:wid/integrations`, guard, wrap(async (req, res) => send(res, async () => res.json(await S.listIntegrations(db, req.params.wid)))));
  app.post(`/api/workspaces/:wid/integrations/jira/connect`, manage, wrap(async (req, res) => send(res, async () => res.json(await S.startOAuth(db, { workspaceId: req.params.wid, userId: req.user.id })))));
  app.post(`/api/workspaces/:wid/integrations/jira/disconnect`, manage, wrap(async (req, res) => send(res, async () => { const c = await S.disconnect(db, req.params.wid); if (!c) return fail(res, 404, 'not_found', '연결된 Jira가 없습니다.'); res.json(await S.listIntegrations(db, req.params.wid)); })));

  app.get(`/api/integrations/jira/callback`, wrap(async (req, res) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent('/app/settings'));
    const { code, state, error } = req.query || {};
    const back = (q) => res.redirect(`/app/settings?${new URLSearchParams(q).toString()}`);
    if (error) return back({ jira: 'error', reason: String(error).slice(0, 80) });   // never echo codes/tokens
    try { const r = await S.finishOAuth(db, { state: String(state || ''), code: String(code || ''), userId: req.user.id }); return back({ jira: 'ok', ws: r.workspace_id }); }
    catch (e) { console.warn('[jira] oauth callback failed:', e.code || e.message); return back({ jira: 'error', reason: e.code || 'oauth_error' }); }
  }));

  const P = `${base}/:pid/integrations/jira`;
  app.get(P, guard, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project) return; res.json({ ...(await J.projectIntegration(db, project)), activity: await listActivity(db, project.id, 20) }); })));
  app.get(`${P}/projects`, pmanage, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project) return; res.json({ projects: await J.listJiraProjects(db, project, String(req.query.q || '')) }); })));
  app.get(`${P}/issue-types`, pmanage, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project) return; res.json({ issue_types: await J.listIssueTypes(db, project, String(req.query.project_key || '').toUpperCase()) }); })));
  app.put(`${P}/mapping`, pmanage, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project || !mutable(res, project)) return; res.json(await J.saveMapping(db, project, req.body, req.user.id)); })));
  app.delete(`${P}/mapping`, pmanage, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project || !mutable(res, project)) return; res.json(await J.removeMapping(db, project, req.user.id)); })));
  app.post(`${P}/sync`, guard, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project || !mutable(res, project)) return; const run = await J.syncProject(db, project, { trigger: 'MANUAL', userId: req.user.id }); res.json({ run, ...(await J.projectIntegration(db, project)) }); })));
  app.get(`${P}/issues/search`, guard, wrap(async (req, res) => send(res, async () => { const project = await loadProject(req, res); if (!project) return; res.json(await J.searchIssues(db, project, String(req.query.q || ''))); })));

  const W = `${base}/:pid/wbs/:iid/jira`;
  const wbsCtx = async (req, res, { write = false } = {}) => {
    const project = await loadProject(req, res); if (!project) return null;
    if (write && !mutable(res, project)) return null;
    const w = await db.get('SELECT id, archived_at FROM wbs_items WHERE id = ? AND project_id = ?', [req.params.iid, project.id]);
    if (!w) { fail(res, 404, 'not_found', 'WBS 항목을 찾을 수 없습니다.'); return null; }
    return { project, w };
  };
  app.get(W, guard, wrap(async (req, res) => send(res, async () => { const c = await wbsCtx(req, res); if (!c) return; const m = await J.getMapping(db, c.project.id); res.json({ mapped: Boolean(m), mapping: m ? { external_project_key: m.external_project_key, external_project_name: m.external_project_name, leaf_issue_type_name: m.leaf_issue_type_name, group_issue_type_name: m.group_issue_type_name, site_url: m.site_url, connection_status: m.connection_status, auto_complete_leaf_wbs: m.auto_complete_leaf_wbs } : null, links: await J.linksForWbs(db, c.w.id), summary: await J.executionForWbs(db, c.project.id, c.w.id), paused: Boolean(c.w.archived_at) }); })));
  app.post(`${W}/issues`, guard, wrap(async (req, res) => send(res, async () => { const c = await wbsCtx(req, res, { write: true }); if (!c) return; res.status(201).json(await J.createIssueForWbs(db, c.project, c.w.id, req.body, req.user.id)); })));
  app.post(`${W}/links`, guard, wrap(async (req, res) => send(res, async () => { const c = await wbsCtx(req, res, { write: true }); if (!c) return; res.status(201).json(await J.linkIssues(db, c.project, c.w.id, req.body, req.user.id)); })));
  app.delete(`${W}/links/:lid`, guard, wrap(async (req, res) => send(res, async () => { const c = await wbsCtx(req, res, { write: true }); if (!c) return; res.json(await J.unlinkIssue(db, c.project, c.w.id, req.params.lid, req.user.id)); })));
  app.post(`${W}/refresh`, guard, wrap(async (req, res) => send(res, async () => { const c = await wbsCtx(req, res, { write: true }); if (!c) return; const run = await J.syncProject(db, c.project, { trigger: 'MANUAL', wbsId: c.w.id, userId: req.user.id }); res.json({ run, links: await J.linksForWbs(db, c.w.id), summary: await J.executionForWbs(db, c.project.id, c.w.id) }); })));

  // Provider webhook — no session, JSON body up to 256 KB, always answers quickly.
  app.post('/api/integrations/jira/webhook/:cid/:secret', express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const r = await handleJiraWebhook(db, { connectionId: req.params.cid, secret: req.params.secret, authorization: req.headers.authorization, body: req.body, headers: req.headers });
    res.status(r.status).json(r.body);
  }));

  void requireAuth;
}

/** Operator view: statuses and recent failures only — no tokens, no issue content. */
export async function adminIntegrations(db) {
  const connections = await db.all(`SELECT c.id, c.workspace_id, w.name AS workspace_name, c.provider, c.status, c.site_url, c.external_account_name, c.last_error, c.connected_at, c.last_synced_at, c.disabled_at,
      (SELECT COUNT(*) FROM integration_project_mappings m WHERE m.connection_id = c.id AND m.status = 'ACTIVE') AS mapped_projects,
      (SELECT COUNT(*) FROM integration_entity_links l WHERE l.connection_id = c.id AND l.status <> 'REMOVED') AS links,
      (SELECT COUNT(*) FROM integration_webhooks h WHERE h.connection_id = c.id AND h.status = 'ACTIVE') AS webhooks
    FROM integration_connections c JOIN workspaces w ON w.id = c.workspace_id ORDER BY c.updated_at DESC LIMIT 200`);
  const mappings = await db.all(`SELECT m.id, m.project_id, p.name AS project_name, w.name AS workspace_name, c.site_url, m.external_project_key, m.external_project_name, m.auto_complete_leaf_wbs, c.last_synced_at, c.status AS connection_status
    FROM integration_project_mappings m JOIN projects p ON p.id = m.project_id JOIN integration_connections c ON c.id = m.connection_id JOIN workspaces w ON w.id = c.workspace_id WHERE m.status = 'ACTIVE' ORDER BY m.updated_at DESC LIMIT 200`);
  const failures = await db.all(`SELECT r.id, r.trigger, r.status, r.items_total, r.items_failed, r.started_at, r.finished_at, r.error_summary, w.name AS workspace_name, p.name AS project_name, c.site_url
    FROM integration_sync_runs r JOIN integration_connections c ON c.id = r.connection_id JOIN workspaces w ON w.id = c.workspace_id LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.status IN ('FAILED','PARTIAL') ORDER BY r.started_at DESC LIMIT 50`);
  const counts = { active: connections.filter((c) => c.status === 'ACTIVE').length, error: connections.filter((c) => c.status === 'ERROR' && !/재연결/.test(c.last_error || '')).length, reconnect_required: connections.filter((c) => c.status === 'ERROR' && /재연결/.test(c.last_error || '')).length, disabled: connections.filter((c) => c.status === 'DISABLED').length };
  return { counts, connections: connections.map((c) => ({ ...c, reconnect_required: c.status === 'ERROR' && /재연결/.test(c.last_error || '') })), mappings, failures };
}
