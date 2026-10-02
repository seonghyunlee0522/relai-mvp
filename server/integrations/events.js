/** Integration activity (feed-worthy events only) + idempotent inbound event log + sync run bookkeeping. */
import { randomUUID } from 'node:crypto';
import { sha256hex } from './crypto.js';

export const ACTIVITY_LABEL = { PROJECT_MAPPED: 'Jira 프로젝트 연결', PROJECT_UNMAPPED: 'Jira 프로젝트 연결 해제', ISSUE_LINKED: 'Jira Issue 연결', ISSUE_UNLINKED: 'Jira Issue 연결 해제', ISSUE_CREATED: 'Jira Issue 생성', AUTO_COMPLETED: 'Jira 동기화로 완료', SYNC_FAILED: 'Jira 동기화 실패', CONNECTED: 'Jira 연결', DISCONNECTED: 'Jira 연결 해제' };

export async function logActivity(db, { projectId, provider = 'JIRA', action, summary, wbsItemId = null, actorId = null }) {
  await db.run('INSERT INTO integration_activity (id, project_id, provider, action, summary, wbs_item_id, actor_id) VALUES (?,?,?,?,?,?,?)', [randomUUID(), projectId, provider, action, String(summary).slice(0, 500), wbsItemId, actorId]);
}
export async function listActivity(db, projectId, limit = 50) {
  return db.all(`SELECT a.id, a.action, a.summary, a.wbs_item_id, a.created_at AS at, u.name AS actor_name, w.wbs_code, w.title FROM integration_activity a
    LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN wbs_items w ON w.id = a.wbs_item_id WHERE a.project_id = ? ORDER BY a.created_at DESC, a.seq DESC LIMIT ?`, [projectId, limit]);
}

/** Records an inbound event once. Returns { id, duplicate }. Hash = provider event id when present, else a stable digest of the meaningful payload parts. */
export async function recordEvent(db, { connectionId, provider = 'JIRA', externalEventId = null, eventType, payloadKey }) {
  const hash = sha256hex(externalEventId ? `${provider}:${externalEventId}` : `${provider}:${eventType}:${payloadKey}`);
  const dup = await db.get('SELECT id, status FROM integration_events WHERE connection_id = ? AND payload_hash = ?', [connectionId, hash]);
  if (dup) return { id: dup.id, duplicate: true, status: dup.status };
  const id = randomUUID();
  await db.run('INSERT INTO integration_events (id, connection_id, provider, external_event_id, event_type, payload_hash) VALUES (?,?,?,?,?,?)', [id, connectionId, provider, externalEventId, eventType, hash]);
  return { id, duplicate: false };
}
export const finishEvent = (db, id, status, error = null) => db.run('UPDATE integration_events SET status = ?, error = ?, processed_at = now() WHERE id = ?', [status, error ? String(error).slice(0, 500) : null, id]);

export async function startRun(db, { connectionId, projectId = null, trigger }) {
  const id = randomUUID();
  await db.run('INSERT INTO integration_sync_runs (id, connection_id, project_id, trigger) VALUES (?,?,?,?)', [id, connectionId, projectId, trigger]);
  return id;
}
export async function finishRun(db, id, { total = 0, success = 0, failed = 0, error = null }) {
  const status = error && !success ? 'FAILED' : failed ? 'PARTIAL' : 'SUCCESS';
  await db.run('UPDATE integration_sync_runs SET status = ?, items_total = ?, items_success = ?, items_failed = ?, finished_at = now(), error_summary = ? WHERE id = ?', [status, total, success, failed, error ? String(error).slice(0, 500) : null, id]);
  return status;
}
