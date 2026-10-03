/**
 * E-mail service: picks the provider, sends, records an email_deliveries row (status PENDING → SENT | FAILED).
 * Never stores the HTML, tokens or secrets — only type, recipient, provider message id and a safe error message.
 * Sending is never inside the caller's DB transaction: the invitation row is committed first, then the mail goes out.
 */
import { randomUUID } from 'node:crypto';
import { emailConfig } from './config.js';
import { resendProvider, fakeEmailProvider } from './provider.js';

let override = null;
export function getEmailProvider(env = process.env) {
  if (override) return override;
  const cfg = emailConfig(env);
  if (cfg.provider === 'fake') { override = fakeEmailProvider(); return override; }
  return resendProvider(cfg);
}
/** Tests / dev: install a fake (or null to reset to env-based selection). */
export function setEmailProvider(p) { override = p; }

export async function sendEmail(db, { type, to, subject, html, text, tags = [], relatedUserId = null, invitationId = null, workspaceId = null }, env = process.env) {
  const provider = getEmailProvider(env);
  const id = randomUUID();
  await db.run('INSERT INTO email_deliveries (id, type, recipient, provider, related_user_id, invitation_id, workspace_id) VALUES (?,?,?,?,?,?,?)', [id, type, to, provider.name, relatedUserId, invitationId, workspaceId]);
  try {
    const r = await provider.send({ to, subject, html, text, tags: [type, ...tags] });
    await db.run(`UPDATE email_deliveries SET status = 'SENT', provider_message_id = ?, sent_at = now() WHERE id = ?`, [r?.id || null, id]);
    return { id, status: 'SENT', provider_message_id: r?.id || null };
  } catch (e) {
    const code = String(e.code || 'send_failed').slice(0, 60); const msg = String(e.message || '메일 발송에 실패했습니다.').replace(/Bearer\s+\S+/gi, '[redacted]').slice(0, 300);
    await db.run(`UPDATE email_deliveries SET status = 'FAILED', error_code = ?, error_message_safe = ? WHERE id = ?`, [code, msg, id]);
    return { id, status: 'FAILED', error_code: code, error_message_safe: msg };
  }
}
export async function listDeliveries(db, { page = 1, size = 50, status = '', type = '', q = '' } = {}) {
  const where = []; const params = [];
  if (status) { where.push('d.status = ?'); params.push(status); }
  if (type) { where.push('d.type = ?'); params.push(type); }
  if (q) { where.push('d.recipient ILIKE ?'); params.push(`%${String(q).replace(/[%_\\]/g, (c) => '\\' + c)}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) n FROM email_deliveries d ${w}`, params)).n;
  const items = await db.all(`SELECT d.id, d.type, d.recipient, d.provider, d.provider_message_id, d.status, d.error_code, d.error_message_safe, d.created_at, d.sent_at, d.invitation_id, d.workspace_id, w.name AS workspace_name
    FROM email_deliveries d LEFT JOIN workspaces w ON w.id = d.workspace_id ${w} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  return { items, total, page, size };
}
