/**
 * 공지사항 (migration 74): written in 관리자 › 공지사항. Two uses that never mix:
 *   - 내용(title + body) → the in-app list (rail 공지사항 → /app/notices), signed-in users, visible notices only
 *   - 이미지 → a modal on the landing page (/) and on app Home (/app) — image only, several at once, '오늘 하루 보지 않기' in the browser
 * Visible = active AND starts_at <= now (or open) AND now < ends_at (or open). The image is stored in the row (bytea, ≤ 2 MB) — the
 * seeded beta-open notice points at a static file (image_path) instead.
 *
 *   GET    /api/notices/popup?placement=landing|app_home   public — visible notices with an image for that placement (no body)
 *   GET    /api/notices/:id/image                          public — the uploaded image of an active notice (versioned URL, cached)
 *   GET    /api/notices                                    signed-in — visible notices (title, body, period)
 *   GET    /api/admin/notices                              operator — every notice
 *   POST   /api/admin/notices                              operator — create
 *   PATCH  /api/admin/notices/:id                          operator — update
 *   DELETE /api/admin/notices/:id                          operator — delete
 *   PUT    /api/admin/notices/:id/image                    operator — { data: base64, type } (PNG / JPEG / WebP / GIF, ≤ 2 MB)
 *   DELETE /api/admin/notices/:id/image                    operator — remove the image (the notice stays in the list)
 *   GET    /api/admin/notices/:id/image                    operator — image of any notice (preview of an inactive one)
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { writeAudit } from './admin.js';

export const NOTICE_PLACEMENTS = { landing: '홈페이지', app_home: '앱 홈' };
export const NOTICE_IMAGE_MAX = 2 * 1024 * 1024;
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 5000;
const NEW_DAYS = 7;
const TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': null };

export class NoticeError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; } }

const VISIBLE = `active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`;
const COLS = `id, title, body, image_type, image_path, image_size, image_updated_at, (image_data IS NOT NULL) AS has_upload, popup_placements, starts_at, ends_at, active, sort_order, created_at, updated_at`;

/** Uploaded bytes → versioned API URL (cache-safe); else the static path; else null. `admin` = the operator route (works while inactive). */
export const imageUrl = (n, { admin = false } = {}) => (n.has_upload ? `/api/${admin ? 'admin/' : ''}notices/${n.id}/image?v=${new Date(n.image_updated_at || n.updated_at).getTime()}` : n.image_path || null);

/* Per-instance cache for the popup query (landing / Home ask on every visit); an admin write clears it here, other instances within TTL. */
const TTL_MS = 30_000; const cache = new Map();
export const clearNoticeCache = () => cache.clear();

export async function popupNotices(db, placement) {
  if (!NOTICE_PLACEMENTS[placement]) return [];
  const hit = cache.get(placement); if (hit && hit.until > Date.now()) return hit.rows;
  const rows = (await db.all(`SELECT ${COLS} FROM notices WHERE ${VISIBLE} AND ? = ANY(popup_placements) AND (image_data IS NOT NULL OR image_path IS NOT NULL)
    ORDER BY sort_order, COALESCE(starts_at, created_at) DESC, id`, [placement])).map((n) => ({ id: n.id, title: n.title, image_url: imageUrl(n) }));
  cache.set(placement, { rows, until: Date.now() + TTL_MS });
  return rows;
}

/** In-app list: visible notices, newest first. The image is not part of the list (it is for the Home modal only). */
export async function visibleNotices(db) {
  const rows = await db.all(`SELECT id, title, body, starts_at, ends_at, created_at FROM notices WHERE ${VISIBLE} ORDER BY COALESCE(starts_at, created_at) DESC, id`);
  const cut = Date.now() - NEW_DAYS * 86400000;
  return rows.map((n) => ({ ...n, posted_at: n.starts_at || n.created_at, is_new: new Date(n.starts_at || n.created_at).getTime() >= cut }));
}

export const listNotices = async (db) => (await db.all(`SELECT ${COLS} FROM notices ORDER BY active DESC, COALESCE(starts_at, created_at) DESC, id`))
  .map((n) => ({ ...n, image_url: imageUrl(n, { admin: true }) }));

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const when = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

function validate(b = {}, { partial = false } = {}) {
  const out = {}; const f = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('title')) { out.title = str(b.title, NOTICE_TITLE_MAX + 1); if (!out.title) f.title = '제목을 입력해 주세요.'; else if (out.title.length > NOTICE_TITLE_MAX) f.title = `제목은 ${NOTICE_TITLE_MAX}자 이내로 입력해 주세요.`; }
  if (has('body')) { out.body = String(b.body ?? '').replace(/\r\n/g, '\n').trim(); if (out.body.length > NOTICE_BODY_MAX) f.body = `내용은 ${NOTICE_BODY_MAX.toLocaleString('ko-KR')}자 이내로 입력해 주세요.`; }
  for (const k of ['starts_at', 'ends_at']) if (has(k)) { const v = when(b[k]); if (v === undefined) f[k] = '날짜·시간 형식이 올바르지 않습니다.'; else out[k] = v; }
  if (out.starts_at && out.ends_at && out.starts_at >= out.ends_at) f.ends_at = '종료 시각은 시작 시각 이후여야 합니다.';
  if (has('popup_placements')) {
    const p = Array.isArray(b.popup_placements) ? [...new Set(b.popup_placements.map(String))] : [];
    if (p.some((x) => !NOTICE_PLACEMENTS[x])) f.popup_placements = '알 수 없는 팝업 위치가 있습니다.';
    out.popup_placements = p;
  }
  if (has('active')) out.active = b.active === true || b.active === 'true' || b.active === 1;
  if (has('sort_order')) { const n = Number(b.sort_order ?? 0); out.sort_order = Number.isFinite(n) ? Math.max(-9999, Math.min(9999, Math.round(n))) : 0; }
  if (Object.keys(f).length) throw new NoticeError(422, 'validation_error', '입력값을 확인해 주세요.', f);
  return out;
}

const one = async (db, id) => { const n = await db.get(`SELECT ${COLS} FROM notices WHERE id = ?`, [id]); return n ? { ...n, image_url: imageUrl(n, { admin: true }) } : null; };
const mustExist = async (db, id) => { const n = await db.get('SELECT id, title, starts_at, ends_at FROM notices WHERE id = ?', [id]); if (!n) throw new NoticeError(404, 'not_found', '공지사항을 찾을 수 없습니다.'); return n; };

export async function createNotice(db, admin, body) {
  const v = validate({ active: true, sort_order: 0, body: '', popup_placements: Object.keys(NOTICE_PLACEMENTS), starts_at: null, ends_at: null, ...body });
  const id = randomUUID();
  await db.run(`INSERT INTO notices (id, title, body, popup_placements, starts_at, ends_at, active, sort_order, created_by, updated_by) VALUES (?,?,?,?::text[],?,?,?,?,?,?)`,
    [id, v.title, v.body, v.popup_placements, v.starts_at, v.ends_at, v.active, v.sort_order, admin.id, admin.id]);
  clearNoticeCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'NOTICE_CREATE', targetType: 'NOTICE', targetId: id, metadata: { title: v.title } });
  return { notice: await one(db, id) };
}

export async function updateNotice(db, admin, id, body) {
  const ex = await mustExist(db, id);
  const v = validate(body, { partial: true });
  const s = v.starts_at !== undefined ? v.starts_at : ex.starts_at; const e = v.ends_at !== undefined ? v.ends_at : ex.ends_at;   // one-sided edit vs the stored other side
  if (s && e && new Date(s) >= new Date(e)) throw new NoticeError(422, 'validation_error', '입력값을 확인해 주세요.', { ends_at: '종료 시각은 시작 시각 이후여야 합니다.' });
  const keys = Object.keys(v);
  if (keys.length) await db.run(`UPDATE notices SET ${keys.map((k) => `${k} = ?${k === 'popup_placements' ? '::text[]' : ''}`).join(', ')}, updated_at = now(), updated_by = ? WHERE id = ?`, [...keys.map((k) => v[k]), admin.id, id]);
  clearNoticeCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'NOTICE_UPDATE', targetType: 'NOTICE', targetId: id, metadata: { fields: keys } });
  return { notice: await one(db, id) };
}

export async function deleteNotice(db, admin, id) {
  const ex = await mustExist(db, id);
  await db.run('DELETE FROM notices WHERE id = ?', [id]);
  clearNoticeCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'NOTICE_DELETE', targetType: 'NOTICE', targetId: id, metadata: { title: ex.title } });
  return { deleted: id };
}

/** The declared type must match the file's magic bytes (a renamed file or a script is refused). */
export function sniffImage(buf, type) {
  if (!Object.hasOwn(TYPES, type)) return false;
  if (type === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return TYPES[type].every((b, i) => buf[i] === b);
}

export async function setNoticeImage(db, admin, id, body = {}) {
  await mustExist(db, id);
  const type = String(body.type || '').toLowerCase();
  const b64 = String(body.data || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new NoticeError(422, 'validation_error', '이미지 파일을 골라 주세요.', { image: '이미지 파일을 골라 주세요.' });
  if (buf.length > NOTICE_IMAGE_MAX) throw new NoticeError(422, 'validation_error', '이미지는 2MB 이하만 올릴 수 있습니다.', { image: '이미지는 2MB 이하만 올릴 수 있습니다.' });
  if (!sniffImage(buf, type)) throw new NoticeError(422, 'validation_error', 'PNG · JPG · WebP · GIF 이미지만 올릴 수 있습니다.', { image: 'PNG · JPG · WebP · GIF 이미지만 올릴 수 있습니다.' });
  await db.run('UPDATE notices SET image_data = ?, image_type = ?, image_size = ?, image_path = NULL, image_updated_at = now(), updated_at = now(), updated_by = ? WHERE id = ?', [buf, type, buf.length, admin.id, id]);
  clearNoticeCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'NOTICE_IMAGE_SET', targetType: 'NOTICE', targetId: id, metadata: { type, size: buf.length } });
  return { notice: await one(db, id) };
}

export async function clearNoticeImage(db, admin, id) {
  await mustExist(db, id);
  await db.run('UPDATE notices SET image_data = NULL, image_type = NULL, image_size = NULL, image_path = NULL, image_updated_at = now(), updated_at = now(), updated_by = ? WHERE id = ?', [admin.id, id]);
  clearNoticeCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'NOTICE_IMAGE_CLEAR', targetType: 'NOTICE', targetId: id });
  return { notice: await one(db, id) };
}

const sendImage = (res, row, cacheCtl) => {
  res.set({ 'Content-Type': row.image_type, 'Cache-Control': cacheCtl, 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' });
  res.send(row.image_data);
};

/** PUT /api/admin/notices/:id/image carries up to 2 MB as base64 — app.js skips its 64 KB parser for this path. */
export const NOTICE_IMAGE_PATH = /^\/api\/admin\/notices\/[^/]+\/image\/?$/;

export function mountPublicNoticeRoutes(app, db, { requireAuth, wrap, fail }) {
  app.get('/api/notices/popup', wrap(async (req, res) => {
    const placement = String(req.query.placement || '');
    res.set('Cache-Control', 'no-store');
    res.json({ placement, notices: await popupNotices(db, placement) });
  }));
  app.get('/api/notices/:id/image', wrap(async (req, res) => {
    const row = await db.get('SELECT image_data, image_type FROM notices WHERE id = ? AND active AND image_data IS NOT NULL', [req.params.id]);
    if (!row) return fail(res, 404, 'not_found', '이미지를 찾을 수 없습니다.');
    sendImage(res, row, 'public, max-age=86400, s-maxage=86400, immutable');   // the URL carries ?v=<image_updated_at>
  }));
  app.get('/api/notices', requireAuth, wrap(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ notices: await visibleNotices(db) }); }));
}

/** Operator CRUD — mounted inside mountAdminRoutes (guard = requireAuth + requireSystemAdmin), before its /api/admin/* catch-all. */
export function mountAdminNoticeRoutes(app, db, { guard, wrap, fail }) {
  const act = (fn) => wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { if (e instanceof NoticeError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
  });
  const bigJson = express.json({ limit: '3mb' });   // 2 MB image as base64 ≈ 2.7 MB
  const tooBig = (err, req, res, next) => (err && err.type === 'entity.too.large' ? fail(res, 413, 'payload_too_large', '이미지는 2MB 이하만 올릴 수 있습니다.') : next(err));
  app.get('/api/admin/notices', guard, wrap(async (req, res) => res.json({ notices: await listNotices(db), placements: NOTICE_PLACEMENTS, image_max: NOTICE_IMAGE_MAX })));
  app.post('/api/admin/notices', guard, act((req) => createNotice(db, { id: req.user.id }, req.body || {})));
  app.patch('/api/admin/notices/:id', guard, act((req) => updateNotice(db, { id: req.user.id }, req.params.id, req.body || {})));
  app.delete('/api/admin/notices/:id', guard, act((req) => deleteNotice(db, { id: req.user.id }, req.params.id)));
  app.put('/api/admin/notices/:id/image', guard, bigJson, tooBig, act((req) => setNoticeImage(db, { id: req.user.id }, req.params.id, req.body || {})));
  app.delete('/api/admin/notices/:id/image', guard, act((req) => clearNoticeImage(db, { id: req.user.id }, req.params.id)));
  app.get('/api/admin/notices/:id/image', guard, wrap(async (req, res) => {
    const row = await db.get('SELECT image_data, image_type FROM notices WHERE id = ? AND image_data IS NOT NULL', [req.params.id]);
    if (!row) return fail(res, 404, 'not_found', '이미지를 찾을 수 없습니다.');
    sendImage(res, row, 'private, no-store');
  }));
}
