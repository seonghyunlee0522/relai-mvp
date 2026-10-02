/**
 * Inbound Jira webhook (OAuth 2.0 dynamic webhooks). Separate from user-auth routes.
 *   URL  POST /api/integrations/jira/webhook/:connectionId/:secret
 *   Auth  Authorization: Bearer <JWT signed HS256 with the app's client secret> (Atlassian) + the per-connection URL secret.
 * The payload is never trusted for data: we only read webhookEvent + issue id/key, verify a link exists, then fetch the
 * issue ourselves. Duplicate deliveries are detected via integration_events (hash of event id or of event+issue+timestamp).
 */
import { timingSafeEqual } from 'node:crypto';
import { integrationConfig } from '../config.js';
import { verifyJwt } from '../crypto.js';
import { getConnectionById } from '../service.js';
import { recordEvent, finishEvent } from '../events.js';
import { applyIssueEvent } from './sync.js';

const safeEq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };

/** Returns { status, body } for the HTTP layer. */
export async function handleJiraWebhook(db, { connectionId, secret, authorization, body, headers = {} }, env = process.env) {
  const cfg = integrationConfig(env);
  const conn = await getConnectionById(db, connectionId);
  if (!conn || conn.provider !== 'JIRA' || !safeEq(conn.webhook_secret, secret)) return { status: 404, body: { error: 'not_found' } };
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  const claims = cfg.jira.clientSecret ? verifyJwt(token, cfg.jira.clientSecret) : null;
  if (!claims) return { status: 401, body: { error: 'unauthorized' } };
  if (conn.status === 'DISABLED') return { status: 202, body: { result: 'ignored', reason: 'disabled' } };
  const ev = body && typeof body === 'object' ? body : {};
  const eventType = String(ev.webhookEvent || '');
  if (!/^jira:issue_(updated|deleted|created)$/.test(eventType)) return { status: 202, body: { result: 'ignored', reason: 'event_type' } };
  const issueId = ev.issue?.id ? String(ev.issue.id) : null; const issueKey = ev.issue?.key ? String(ev.issue.key) : null;
  if (!issueId && !issueKey) return { status: 400, body: { error: 'bad_payload' } };
  const externalEventId = headers['x-atlassian-webhook-identifier'] || null;
  const rec = await recordEvent(db, { connectionId: conn.id, externalEventId, eventType, payloadKey: `${issueId || issueKey}:${ev.timestamp || ''}` });
  if (rec.duplicate) return { status: 200, body: { result: 'duplicate' } };
  if (eventType === 'jira:issue_created') { await finishEvent(db, rec.id, 'IGNORED'); return { status: 202, body: { result: 'ignored', reason: 'not_linked' } }; }
  try {
    const r = await applyIssueEvent(db, conn, { eventType, issueId, issueKey }, env);
    await finishEvent(db, rec.id, r === 'ignored' ? 'IGNORED' : 'PROCESSED');
    return { status: 200, body: { result: r } };
  } catch (e) {
    await finishEvent(db, rec.id, 'FAILED', e.message);
    return { status: 200, body: { result: 'failed' } };   // 200 so Atlassian does not hammer retries; reconciliation covers it
  }
}
