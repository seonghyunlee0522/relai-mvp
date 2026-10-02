/** Integration layer configuration (env). Nothing here is ever sent to the browser except `enabled`/`configured`. */
const str = (v) => String(v ?? '').trim();
export function integrationConfig(env = process.env) {
  const clientId = str(env.ATLASSIAN_CLIENT_ID); const clientSecret = str(env.ATLASSIAN_CLIENT_SECRET); const redirectUri = str(env.ATLASSIAN_REDIRECT_URI);
  const appBaseUrl = str(env.APP_BASE_URL) || (redirectUri ? redirectUri.replace(/\/api\/integrations\/jira\/callback\/?$/, '') : '');
  return {
    jira: {
      configured: Boolean(clientId && clientSecret && redirectUri),
      clientId, clientSecret, redirectUri, appBaseUrl,
      scopes: (str(env.ATLASSIAN_SCOPES) || 'read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access').split(/\s+/).filter(Boolean),
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      resourcesUrl: 'https://api.atlassian.com/oauth/token/accessible-resources',
      apiBase: 'https://api.atlassian.com/ex/jira',
      timeoutMs: Number(env.INTEGRATION_HTTP_TIMEOUT_MS) > 0 ? Number(env.INTEGRATION_HTTP_TIMEOUT_MS) : 15000,
      maxRetries: 2,
      webhookEvents: ['jira:issue_updated', 'jira:issue_deleted'],
      webhookRenewBeforeDays: 7,
    },
    oauthStateTtlMs: 10 * 60 * 1000,
    refreshSkewMs: 2 * 60 * 1000,
    provider: str(env.INTEGRATION_PROVIDER) || 'live',   // live | fake (tests)
  };
}
