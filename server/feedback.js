/**
 * In-app feedback (migration 48): '의견 남기기' in the app rail → one row in `feedback`; 관리자 › 의견 reads and triages them.
 * Stored only in our own database — feedback content is never sent to an external service (no e-mail, no Slack, no analytics).
 *
 *   POST  /api/feedback                 signed-in user — { category, message, page_path?, workspace_id?, project_id? }; 10 per hour per user
 *   GET   /api/admin/feedback           operator — list (status, category, from, to, q, page, size) + new_count
 *   GET   /api/admin/feedback/summary   operator — { new_count } for the sidebar badge
 *   GET   /api/admin/feedback/:id       operator — one row with the sender's name / e-mail and workspace / project names
 *   PATCH /api/admin/feedback/:id       operator — { status?, admin_note? } + one admin_audit_logs row (same transaction)
 */
import { randomUUID } from 'node:crypto';
import { tx } from './db.js';
import { rateLimiter } from './security.js';
import { paging, writeAudit } from './admin.js';

export const FEEDBACK_CATEGORIES = { INCONVENIENCE: '불편', SUGGESTION: '개선 제안', BUG: '오류', OTHER: '기타' };
export const FEEDBACK_STATUSES = { NEW: '새 의견', IN_REVIEW: '검토 중', DONE: '처리 완료' };
export const FEEDBACK_MAX = 2000;
export const FEEDBACK_RATE = { max: 10, windowMs: 60 * 60 * 1000 };
const NOTE_MAX = 2000;

export class FeedbackError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; } }

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const like = (s) => `%${String(s).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Context ids are kept only when they are the sender's own: a workspace they belong to, a project inside it. */
async function context(db, userId, b) {
  const wid = str(b.workspace_id, 64); const pid = str(b.project_id, 64);
  if (!wid) return { workspace_id: null, project_id: null };
  const m = await db.get('SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [wid, userId]);
  if (!m) return { workspace_id: null, project_id: null };
  const p = pid ? await db.get('SELECT id FROM projects WHERE id = ? AND workspace_id = ?', [pid, wid]) : null;
  return { workspace_id: wid, project_id: p ? p.id : null };
}

export async function createFeedback(db, user, body = {}, { userAgent = '' } = {}) {
  const f = {};
  const category = String(body.category || '');
  if (!FEEDBACK_CATEGORIES[category]) f.category = '의견 종류를 고르세요.';
  const message = String(body.message ?? '').trim();
  if (!message) f.message = '내용을 입력해 주세요.';
  else if (message.length > FEEDBACK_MAX) f.message = `내용은 ${FEEDBACK_MAX.toLocaleString('ko-KR')}자 이내로 입력해 주세요.`;
  if (Object.keys(f).length) throw new FeedbackError(422, 'validation_error', '입력값을 확인해 주세요.', f);
  let page = str(body.page_path, 500); if (!page.startsWith('/') || page.startsWith('//')) page = null;
  const ctx = await context(db, user.id, body);
  const id = randomUUID();
  await db.run(`INSERT INTO feedback (id, user_id, workspace_id, project_id, category, message, page_path, user_agent) VALUES (?,?,?,?,?,?,?,?)`,
    [id, user.id, ctx.workspace_id, ctx.project_id, category, message, page, str(userAgent, 500) || null]);
  return { feedback: { id, category, status: 'NEW' } };
}

const COLS = `f.id, f.user_id, f.workspace_id, f.project_id, f.category, f.message, f.page_path, f.user_agent, f.status, f.admin_note, f.created_at, f.updated_at,
  u.name AS user_name, u.email AS user_email, w.name AS workspace_name, p.name AS project_name`;
const FROM = 'FROM feedback f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN workspaces w ON w.id = f.workspace_id LEFT JOIN projects p ON p.id = f.project_id';

export const newFeedbackCount = async (db) => Number((await db.get(`SELECT COUNT(*) AS n FROM feedback WHERE status = 'NEW'`)).n);

/** from / to = inclusive KST dates (YYYY-MM-DD). */
export async function listFeedback(db, q = {}) {
  const { page, size, offset } = paging(q);
  const where = []; const params = [];
  if (FEEDBACK_STATUSES[q.status]) { where.push('f.status = ?'); params.push(q.status); }
  if (FEEDBACK_CATEGORIES[q.category]) { where.push('f.category = ?'); params.push(q.category); }
  if (DATE.test(q.from || '')) { where.push(`f.created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Seoul'`); params.push(q.from); }
  if (DATE.test(q.to || '')) { where.push(`f.created_at < (?::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'`); params.push(q.to); }
  const s = str(q.q, 100);
  if (s) { where.push('(f.message ILIKE ? OR u.email ILIKE ? OR u.name ILIKE ? OR f.page_path ILIKE ? OR f.admin_note ILIKE ?)'); params.push(like(s), like(s), like(s), like(s), like(s)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.get(`SELECT COUNT(*) AS n ${FROM} ${w}`, params)).n);
  const items = await db.all(`SELECT ${COLS} ${FROM} ${w} ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`, [...params, size, offset]);
  return { items, page, size, total, new_count: await newFeedbackCount(db) };
}

export const getFeedback = (db, id) => db.get(`SELECT ${COLS} ${FROM} WHERE f.id = ?`, [id]);

export async function updateFeedback(db, admin, id, body = {}) {
  const set = {}; const f = {};
  if (body.status !== undefined) { if (FEEDBACK_STATUSES[body.status]) set.status = body.status; else f.status = '알 수 없는 상태입니다.'; }
  if (body.admin_note !== undefined) {
    const note = String(body.admin_note ?? '').trim();
    if (note.length > NOTE_MAX) f.admin_note = `메모는 ${NOTE_MAX.toLocaleString('ko-KR')}자 이내로 입력해 주세요.`; else set.admin_note = note || null;
  }
  if (Object.keys(f).length) throw new FeedbackError(422, 'validation_error', '입력값을 확인해 주세요.', f);
  return tx(db, async (t) => {
    const ex = await t.get('SELECT id, status, admin_note, category FROM feedback WHERE id = ? FOR UPDATE', [id]);
    if (!ex) throw new FeedbackError(404, 'not_found', '의견을 찾을 수 없습니다.');
    const keys = Object.keys(set).filter((k) => set[k] !== ex[k]);
    if (keys.length) {
      await t.run(`UPDATE feedback SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, [...keys.map((k) => set[k]), id]);
      await writeAudit(t, { adminUserId: admin.id, action: 'FEEDBACK_UPDATE', targetType: 'FEEDBACK', targetId: id,
        metadata: { from_status: ex.status, status: set.status ?? ex.status, note_changed: keys.includes('admin_note'), category: ex.category } });
    }
    return { feedback: await getFeedback(t, id) };
  });
}

const act = (wrap, fail) => (fn) => wrap(async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }); }
  catch (e) { if (e instanceof FeedbackError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
});

/** Signed-in users. 429 once a user has sent FEEDBACK_RATE.max in the current hour; a rejected (422) send does not count. */
export function mountFeedbackRoutes(app, db, { requireAuth, wrap, fail }) {
  const limit = rateLimiter(db, { name: 'feedback', ...FEEDBACK_RATE });
  app.post('/api/feedback', requireAuth, act(wrap, fail)(async (req) => {
    if (await limit.blocked(req.user.id)) throw new FeedbackError(429, 'rate_limited', '의견을 짧은 시간에 너무 많이 보냈습니다. 잠시 후 다시 보내 주세요.');
    const r = await createFeedback(db, req.user, req.body || {}, { userAgent: req.get('user-agent') || '' });
    await limit.hit(req.user.id);
    return r;
  }));
}

/** Operator routes — mounted inside mountAdminRoutes (guard = requireAuth + requireSystemAdmin). */
export function mountAdminFeedbackRoutes(app, db, { guard, wrap, fail }) {
  const a = act(wrap, fail);
  app.get('/api/admin/feedback', guard, wrap(async (req, res) => res.json({ ...(await listFeedback(db, req.query)), categories: FEEDBACK_CATEGORIES, statuses: FEEDBACK_STATUSES })));
  app.get('/api/admin/feedback/summary', guard, wrap(async (req, res) => res.json({ new_count: await newFeedbackCount(db) })));
  app.get('/api/admin/feedback/:id', guard, wrap(async (req, res) => {
    const f = await getFeedback(db, req.params.id);
    return f ? res.json({ feedback: f, categories: FEEDBACK_CATEGORIES, statuses: FEEDBACK_STATUSES }) : fail(res, 404, 'not_found', '의견을 찾을 수 없습니다.');
  }));
  app.patch('/api/admin/feedback/:id', guard, a((req) => updateFeedback(db, { id: req.user.id }, req.params.id, req.body || {})));
}
