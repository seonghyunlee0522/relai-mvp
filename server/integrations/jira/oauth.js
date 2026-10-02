/**
 * Atlassian OAuth 2.0 (3LO) — authorization URL, code exchange, rotating refresh, accessible resources.
 * Pure HTTP; persistence/locking lives in integrations/service.js. Never logs codes or tokens.
 */
import { httpJson, JiraApiError } from './client.js';

export class OAuthError extends Error { constructor(message, { code = 'oauth_error', status = 400, reconnect = false } = {}) { super(message); this.code = code; this.status = status; this.reconnect = reconnect; } }

export function authorizeUrl(cfg, { state, scopes = cfg.scopes, redirectUri = cfg.redirectUri }) {
  const p = new URLSearchParams({ audience: 'api.atlassian.com', client_id: cfg.clientId, scope: scopes.join(' '), redirect_uri: redirectUri, state, response_type: 'code', prompt: 'consent' });
  return `${cfg.authorizeUrl}?${p.toString()}`;
}

const tokenCall = async (cfg, body, fetchImpl) => {
  try {
    const r = await httpJson(cfg.tokenUrl, { method: 'POST', body, timeoutMs: cfg.timeoutMs, maxRetries: 1, fetchImpl });
    const j = r.json || {};
    if (!j.access_token) throw new OAuthError('Atlassian 토큰 응답이 올바르지 않습니다.', { code: 'oauth_bad_response', status: 502 });
    return { access_token: j.access_token, refresh_token: j.refresh_token || null, expires_in: Number(j.expires_in) || 3600, scope: j.scope || '' };
  } catch (e) {
    if (e instanceof OAuthError) throw e;
    const err = e instanceof JiraApiError ? e : null;
    const code = err?.body?.error;
    // invalid_grant: expired/rotated refresh token, revoked consent, password change → full re-authorization, never a retry loop
    if (err && (code === 'invalid_grant' || err.status === 401 || err.status === 403)) throw new OAuthError('Jira 재연결이 필요합니다. (인증이 만료되었거나 취소되었습니다)', { code: 'reconnect_required', status: 409, reconnect: true });
    throw new OAuthError(err?.message || 'Atlassian 인증 서버에 연결할 수 없습니다.', { code: 'oauth_unavailable', status: 502 });
  }
};
export const exchangeCode = (cfg, { code, redirectUri = cfg.redirectUri }, fetchImpl) =>
  tokenCall(cfg, { grant_type: 'authorization_code', client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }, fetchImpl);
export const refreshToken = (cfg, refresh, fetchImpl) =>
  tokenCall(cfg, { grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refresh }, fetchImpl);

/** Sites the token can reach: [{ id (cloudId), name, url, scopes }]. */
export async function accessibleResources(cfg, accessToken, fetchImpl) {
  const r = await httpJson(cfg.resourcesUrl, { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: cfg.timeoutMs, maxRetries: 1, fetchImpl });
  return Array.isArray(r.json) ? r.json.map((s) => ({ id: String(s.id), name: s.name || '', url: s.url || '', scopes: s.scopes || [] })) : [];
}
export async function currentUser(cfg, cloudId, accessToken, fetchImpl) {
  const r = await httpJson(`${cfg.apiBase}/${cloudId}/rest/api/3/myself`, { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: cfg.timeoutMs, maxRetries: 1, fetchImpl });
  return { accountId: r.json?.accountId || null, displayName: r.json?.displayName || '' };
}
