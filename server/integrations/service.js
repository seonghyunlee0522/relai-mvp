/**
 * Integration service — the only place that holds provider credentials.
 *   connections:  one per (workspace, provider); tokens encrypted at rest (crypto.js)
 *   OAuth 3LO:    startOAuth → provider consent → finishOAuth (state is server-generated, bound to workspace+user, expires)
 *   access:       withClient(db, connection, fn) hands a short-lived client to the caller, refreshing the access token
 *                 first when needed. Refresh runs under SELECT … FOR UPDATE on the connection row so two concurrent
 *                 requests never exchange the same (single-use, rotating) refresh token; the new pair replaces the old
 *                 one in the same transaction.
 * Domain modules (wbs.js, requirements.js, trace.js) never import this; routes and jira/sync.js do.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { integrationConfig } from './config.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { getProvider } from './registry.js';
import { OAuthError } from './jira/oauth.js';
import { JiraAuthError, JiraApiError } from './jira/client.js';

export class IntegrationError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
export const PROVIDERS = ['JIRA'];
const nowIso = () => new Date().toISOString();

/* ---------- reads (never expose tokens) ---------- */
export const PUBLIC_COLS = `id, workspace_id, provider, status, external_account_id, external_account_name, cloud_id, site_url, auth_type, scopes, last_error, connected_by, connected_at, last_synced_at, disabled_at, created_at, updated_at`;
export async function getConnection(db, workspaceId, provider = 'JIRA') {
  return db.get(`SELECT ${PUBLIC_COLS} FROM integration_connections WHERE workspace_id = ? AND provider = ?`, [workspaceId, provider]);
}
export async function getConnectionById(db, id) {
  return db.get(`SELECT ${PUBLIC_COLS}, webhook_secret FROM integration_connections WHERE id = ?`, [id]);
}
/** Settings card model. `reconnect_required` is a derived flag for the UI. */
export async function listIntegrations(db, workspaceId, env = process.env) {
  const cfg = integrationConfig(env);
  const c = await getConnection(db, workspaceId, 'JIRA');
  const connectedBy = c?.connected_by ? await db.get('SELECT name FROM users WHERE id = ?', [c.connected_by]) : null;
  const mappings = c ? await db.get(`SELECT COUNT(*) n FROM integration_project_mappings WHERE connection_id = ? AND status = 'ACTIVE'`, [c.id]) : { n: 0 };
  return { providers: [{ provider: 'JIRA', configured: cfg.jira.configured, connection: c ? { ...c, connected_by_name: connectedBy?.name || null, reconnect_required: c.status === 'ERROR' && /재연결/.test(c.last_error || ''), mapped_projects: mappings.n } : null }] };
}

/* ---------- OAuth ---------- */
export async function startOAuth(db, { workspaceId, userId, provider = 'JIRA' }, env = process.env) {
  const cfg = integrationConfig(env);
  if (!cfg.jira.configured && cfg.provider !== 'fake') throw new IntegrationError(503, 'integration_not_configured', 'Jira 연동이 아직 서버에 설정되지 않았습니다. 운영자에게 문의해 주세요.');
  const p = getProvider(provider, env);
  const state = randomToken(32); const expires = new Date(Date.now() + cfg.oauthStateTtlMs).toISOString();
  await db.run('DELETE FROM integration_oauth_states WHERE expires_at < now()');
  await db.run('INSERT INTO integration_oauth_states (state, workspace_id, provider, user_id, redirect_uri, expires_at) VALUES (?,?,?,?,?,?)', [state, workspaceId, provider, userId, cfg.jira.redirectUri || '/api/integrations/jira/callback', expires]);
  return { url: p.authorizeUrl({ state, redirectUri: cfg.jira.redirectUri, scopes: cfg.jira.scopes }), state };
}

/** Callback. The workspace comes from the stored state, never from the browser. */
export async function finishOAuth(db, { state, code, userId, provider = 'JIRA' }, env = process.env) {
  const cfg = integrationConfig(env);
  const row = await db.get('SELECT * FROM integration_oauth_states WHERE state = ?', [String(state || '')]);
  if (!row) throw new IntegrationError(400, 'oauth_state_invalid', '인증 요청을 확인할 수 없습니다. 다시 시도해 주세요.');
  await db.run('DELETE FROM integration_oauth_states WHERE state = ?', [row.state]);   // single use
  if (new Date(row.expires_at) < new Date()) throw new IntegrationError(400, 'oauth_state_expired', '인증 요청이 만료되었습니다. 다시 시도해 주세요.');
  if (row.user_id !== userId) throw new IntegrationError(403, 'oauth_state_user', '인증을 시작한 사용자와 다릅니다.');
  if (row.provider !== provider) throw new IntegrationError(400, 'oauth_state_invalid', '인증 요청을 확인할 수 없습니다.');
  const p = getProvider(provider, env);
  let tokens; try { tokens = await p.exchangeCode({ code: String(code || ''), redirectUri: row.redirect_uri }); } catch (e) { throw new IntegrationError(e.status || 502, e.code || 'oauth_error', e.message); }
  const sites = await p.accessibleResources(tokens.access_token);
  if (!sites.length) throw new IntegrationError(400, 'no_site', '접근 가능한 Jira 사이트가 없습니다. Atlassian 계정에서 사이트 권한을 확인해 주세요.');
  const site = sites[0];
  let me = { accountId: null, displayName: '' }; try { me = await p.currentUser(site.id, tokens.access_token); } catch { /* optional */ }
  const ts = nowIso(); const exp = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const existing = await db.get('SELECT id, webhook_secret FROM integration_connections WHERE workspace_id = ? AND provider = ?', [row.workspace_id, provider]);
  const id = existing?.id || randomUUID();
  const vals = [ 'ACTIVE', me.accountId, me.displayName, site.id, site.url, encrypt(tokens.access_token, env), tokens.refresh_token ? encrypt(tokens.refresh_token, env) : null, exp, tokens.scope, null, userId, ts, null, ts ];
  if (existing) await db.run(`UPDATE integration_connections SET status = ?, external_account_id = ?, external_account_name = ?, cloud_id = ?, site_url = ?, access_token_encrypted = ?, refresh_token_encrypted = ?, access_token_expires_at = ?, scopes = ?, last_error = ?, connected_by = ?, connected_at = ?, disabled_at = ?, updated_at = ? WHERE id = ?`, [...vals, id]);
  else await db.run(`INSERT INTO integration_connections (status, external_account_id, external_account_name, cloud_id, site_url, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, scopes, last_error, connected_by, connected_at, disabled_at, updated_at, id, workspace_id, provider, webhook_secret, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...vals, id, row.workspace_id, provider, randomToken(24), ts]);
  return { workspace_id: row.workspace_id, connection: await getConnection(db, row.workspace_id, provider), sites: sites.length };
}

/** Disconnect: tokens are wiped, mappings/links/history stay for audit, sync stops. */
export async function disconnect(db, workspaceId, provider = 'JIRA') {
  const c = await getConnection(db, workspaceId, provider);
  if (!c) return null;
  await db.run(`UPDATE integration_connections SET status = 'DISABLED', access_token_encrypted = NULL, refresh_token_encrypted = NULL, access_token_expires_at = NULL, disabled_at = now(), updated_at = now() WHERE id = ?`, [c.id]);
  await db.run(`UPDATE integration_webhooks SET status = 'DELETED', updated_at = now() WHERE connection_id = ? AND status = 'ACTIVE'`, [c.id]);
  return getConnection(db, workspaceId, provider);
}

export async function markError(db, connectionId, message) {
  await db.run(`UPDATE integration_connections SET status = 'ERROR', last_error = ?, updated_at = now() WHERE id = ?`, [String(message || '').slice(0, 500), connectionId]);
}

/* ---------- token access ---------- */
/** Returns a usable access token, refreshing under a row lock when it is about to expire. */
export async function ensureAccessToken(db, connectionId, env = process.env, { force = false } = {}) {
  try { return await refreshUnderLock(db, connectionId, env, { force }); }
  catch (e) { if (e instanceof IntegrationError && e.extra?.reconnect && e.extra.mark) await markError(db, connectionId, e.extra.mark); throw e; }
}
async function refreshUnderLock(db, connectionId, env, { force }) {
  const cfg = integrationConfig(env);
  return tx(db, async (db) => {
    const c = await db.get('SELECT * FROM integration_connections WHERE id = ? FOR UPDATE', [connectionId]);
    if (!c) throw new IntegrationError(404, 'not_found', '연동 정보를 찾을 수 없습니다.');
    if (c.status === 'DISABLED') throw new IntegrationError(409, 'integration_disabled', 'Jira 연동이 해제되어 있습니다.');
    if (!c.access_token_encrypted) throw new IntegrationError(409, 'reconnect_required', 'Jira 재연결이 필요합니다.', { reconnect: true });
    if (c.status === 'ERROR' && /재연결/.test(c.last_error || '')) throw new IntegrationError(409, 'reconnect_required', c.last_error, { reconnect: true });
    const fresh = c.access_token_expires_at && new Date(c.access_token_expires_at).getTime() - Date.now() > cfg.refreshSkewMs;
    if (fresh && !force) return { accessToken: decrypt(c.access_token_encrypted, env), connection: c };
    if (!c.refresh_token_encrypted) throw new IntegrationError(409, 'reconnect_required', 'Jira 재연결이 필요합니다.', { reconnect: true, mark: 'Jira 재연결이 필요합니다. (갱신 토큰 없음)' });
    const p = getProvider(c.provider, env);
    let t;
    try { t = await p.refresh(decrypt(c.refresh_token_encrypted, env)); }
    catch (e) {
      if (e instanceof OAuthError && e.reconnect) throw new IntegrationError(409, 'reconnect_required', e.message, { reconnect: true, mark: 'Jira 재연결이 필요합니다. (인증이 만료되었거나 취소되었습니다)' });
      throw new IntegrationError(502, e.code || 'oauth_unavailable', e.message);
    }
    const exp = new Date(Date.now() + t.expires_in * 1000).toISOString();
    await db.run(`UPDATE integration_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, access_token_expires_at = ?, status = CASE WHEN status = 'ERROR' THEN 'ACTIVE' ELSE status END, last_error = NULL, updated_at = now() WHERE id = ?`,
      [encrypt(t.access_token, env), t.refresh_token ? encrypt(t.refresh_token, env) : c.refresh_token_encrypted, exp, c.id]);
    return { accessToken: t.access_token, connection: { ...c, access_token_expires_at: exp } };
  });
}

/* ---------- retry (transient only, idempotent methods only) ---------- */
const NON_IDEMPOTENT = new Set(['createIssue']);
const transient = (e) => e instanceof JiraApiError && !(e instanceof JiraAuthError) && (e.status === 429 || e.status >= 500 || e.code === 'jira_timeout' || e.code === 'jira_network');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wraps every client method: 429 / 5xx / timeout / network → up to `maxRetries` more attempts, Retry-After honoured (≤ 20 s), never for createIssue, never on 401/4xx. */
export function withRetry(client, { maxRetries = 2, baseDelayMs = 300 } = {}) {
  const out = {};
  for (const [name, fn] of Object.entries(client)) {
    if (typeof fn !== 'function') { out[name] = fn; continue; }
    out[name] = async (...args) => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(...args); }
        catch (e) {
          if (NON_IDEMPOTENT.has(name) || !transient(e) || attempt >= maxRetries) throw e;
          await sleep(Math.min(20000, e.retryAfterMs || baseDelayMs * (attempt + 1)));
        }
      }
    };
  }
  return out;
}

/** Run `fn(client, connection)` with a valid token. A 401 from the API forces one refresh and one retry; a second 401 flags reconnect_required. */
export async function withClient(db, connectionId, fn, env = process.env) {
  const p = getProvider('JIRA', env);
  const cfg = integrationConfig(env);
  const mk = (connection, accessToken) => withRetry(p.client({ cloudId: connection.cloud_id, accessToken }), { maxRetries: cfg.jira.maxRetries, baseDelayMs: p.kind === 'fake' ? 1 : 300 });
  let { accessToken, connection } = await ensureAccessToken(db, connectionId, env);
  try { return await fn(mk(connection, accessToken), connection); }
  catch (e) {
    if (!(e instanceof JiraAuthError)) throw e;
    ({ accessToken, connection } = await ensureAccessToken(db, connectionId, env, { force: true }));
    try { return await fn(mk(connection, accessToken), connection); }
    catch (e2) {
      if (e2 instanceof JiraAuthError) { await markError(db, connectionId, 'Jira 재연결이 필요합니다. (인증 거부)'); throw new IntegrationError(409, 'reconnect_required', 'Jira 재연결이 필요합니다.', { reconnect: true }); }
      throw e2;
    }
  }
}

/** Active connection of a workspace or a typed error the routes can map. */
export async function requireActiveConnection(db, workspaceId, provider = 'JIRA') {
  const c = await getConnection(db, workspaceId, provider);
  if (!c || c.status === 'DISABLED') throw new IntegrationError(409, 'integration_not_connected', 'Workspace에 Jira가 연결되어 있지 않습니다. Settings → Integrations에서 연결하세요.');
  return c;
}
