/**
 * Promotions (migration 47): marketing offers in their own admin-editable area (관리자 › 프로모션), rendered by ONE shared
 * component (public/app/shared/promo.js) on signup, login, landing pricing, 설정 › AI 이용 현황 and Home.
 * Display only: nothing that meters AI (ai/usage-limit.js) reads this table.
 *
 *   GET    /api/promotions?placement=signup     public — active rows for one placement (no auth; landing/signup are logged out)
 *   GET    /api/admin/promotions                operator — every row
 *   POST   /api/admin/promotions                operator — create
 *   PATCH  /api/admin/promotions/:id            operator — update
 *   DELETE /api/admin/promotions/:id            operator — delete
 */
import { randomUUID } from 'node:crypto';
import { writeAudit } from './admin.js';
import { todayKst } from '../public/app/shared/kst-date.js';
import { PROMO_PLACEMENTS, promoHtml } from '../public/app/shared/promo.js';

export const PLACEMENTS = Object.keys(PROMO_PLACEMENTS);
export class PromoError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; } }

const COLS = 'id, title, body, badge, link_url, link_label, placements, starts_on, ends_on, active, sort_order, created_at, updated_at';
const PUBLIC_COLS = 'id, title, body, badge, link_url, link_label';

/* Small per-instance cache: the landing and auth pages ask on every visit; an admin write clears it on this instance,
 * other serverless instances pick the change up within TTL. */
const TTL_MS = 30_000; const cache = new Map();
export const clearPromoCache = () => cache.clear();

export async function activePromotions(db, placement) {
  if (!PLACEMENTS.includes(placement)) return [];
  const hit = cache.get(placement); if (hit && hit.until > Date.now()) return hit.rows;
  const today = todayKst();
  const rows = await db.all(`SELECT ${PUBLIC_COLS} FROM promotions WHERE active AND ? = ANY(placements)
    AND (starts_on IS NULL OR starts_on <= ?::date) AND (ends_on IS NULL OR ends_on >= ?::date) ORDER BY sort_order, created_at`, [placement, today, today]);
  cache.set(placement, { rows, until: Date.now() + TTL_MS });
  return rows;
}

/** Server-rendered block (landing). Same markup as the app. Never throws: no promo is better than a broken landing page. */
export async function promoBlockHtml(db, placement, opts = {}) {
  try { return promoHtml(await activePromotions(db, placement), { placement, ...opts }); } catch { return ''; }
}

export const listPromotions = (db) => db.all(`SELECT ${COLS} FROM promotions ORDER BY active DESC, sort_order, created_at`);

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validate(b = {}, { partial = false } = {}) {
  const out = {}; const f = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('title')) { out.title = str(b.title, 120); if (!out.title) f.title = '제목을 입력해 주세요.'; }
  if (has('body')) out.body = str(b.body, 400);
  if (has('badge')) out.badge = str(b.badge, 20) || null;
  if (has('link_url')) { out.link_url = str(b.link_url, 300) || null; if (out.link_url && !/^(\/(?!\/)|https:\/\/)/.test(out.link_url)) f.link_url = '링크는 /로 시작하는 내부 주소나 https:// 주소만 쓸 수 있습니다.'; }
  if (has('link_label')) out.link_label = str(b.link_label, 30) || null;
  if (has('placements')) {
    const p = Array.isArray(b.placements) ? [...new Set(b.placements.map(String))] : [];
    if (p.some((x) => !PLACEMENTS.includes(x))) f.placements = '알 수 없는 노출 위치가 있습니다.';
    else if (!p.length) f.placements = '노출 위치를 하나 이상 고르세요.';
    out.placements = p;
  }
  for (const k of ['starts_on', 'ends_on']) if (has(k)) { const v = str(b[k], 10); out[k] = v || null; if (v && !DATE.test(v)) f[k] = '날짜 형식이 올바르지 않습니다.'; }
  if (out.starts_on && out.ends_on && out.starts_on > out.ends_on) f.ends_on = '종료일은 시작일 이후여야 합니다.';
  if (has('active')) out.active = b.active === true || b.active === 'true' || b.active === 1;
  if (has('sort_order')) { const n = Number(b.sort_order ?? 0); out.sort_order = Number.isFinite(n) ? Math.max(-9999, Math.min(9999, Math.round(n))) : 0; }
  if (Object.keys(f).length) throw new PromoError(422, 'validation_error', '입력값을 확인해 주세요.', f);
  return out;
}

export async function createPromotion(db, admin, body) {
  const v = validate({ active: true, sort_order: 0, body: '', ...body });
  const id = randomUUID();
  await db.run(`INSERT INTO promotions (id, title, body, badge, link_url, link_label, placements, starts_on, ends_on, active, sort_order, updated_by)
    VALUES (?,?,?,?,?,?,?::text[],?,?,?,?,?)`, [id, v.title, v.body, v.badge, v.link_url, v.link_label, v.placements, v.starts_on, v.ends_on, v.active, v.sort_order, admin.id]);
  clearPromoCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'PROMOTION_CREATE', targetType: 'PROMOTION', targetId: id, metadata: { title: v.title } });
  return { promotion: await db.get(`SELECT ${COLS} FROM promotions WHERE id = ?`, [id]) };
}

export async function updatePromotion(db, admin, id, body) {
  const ex = await db.get('SELECT id, starts_on, ends_on FROM promotions WHERE id = ?', [id]);
  if (!ex) throw new PromoError(404, 'not_found', '프로모션을 찾을 수 없습니다.');
  const v = validate(body, { partial: true });
  const s = v.starts_on !== undefined ? v.starts_on : ex.starts_on; const e = v.ends_on !== undefined ? v.ends_on : ex.ends_on;   // a one-sided date edit is checked against the stored other side
  if (s && e && s > e) throw new PromoError(422, 'validation_error', '입력값을 확인해 주세요.', { ends_on: '종료일은 시작일 이후여야 합니다.' });
  const keys = Object.keys(v);
  if (keys.length) await db.run(`UPDATE promotions SET ${keys.map((k) => `${k} = ?${k === 'placements' ? '::text[]' : ''}`).join(', ')}, updated_at = now(), updated_by = ? WHERE id = ?`, [...keys.map((k) => v[k]), admin.id, id]);
  clearPromoCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'PROMOTION_UPDATE', targetType: 'PROMOTION', targetId: id, metadata: { fields: keys } });
  return { promotion: await db.get(`SELECT ${COLS} FROM promotions WHERE id = ?`, [id]) };
}

export async function deletePromotion(db, admin, id) {
  const ex = await db.get('SELECT id, title FROM promotions WHERE id = ?', [id]);
  if (!ex) throw new PromoError(404, 'not_found', '프로모션을 찾을 수 없습니다.');
  await db.run('DELETE FROM promotions WHERE id = ?', [id]);
  clearPromoCache();
  await writeAudit(db, { adminUserId: admin.id, action: 'PROMOTION_DELETE', targetType: 'PROMOTION', targetId: id, metadata: { title: ex.title } });
  return { deleted: id };
}

/** Public read (no auth). */
export function mountPublicPromotionRoutes(app, db, { wrap }) {
  app.get('/api/promotions', wrap(async (req, res) => {
    const placement = String(req.query.placement || '');
    res.set('Cache-Control', 'no-store');
    res.json({ placement, promotions: await activePromotions(db, placement) });
  }));
}

/** Operator CRUD — mounted inside mountAdminRoutes (guard = requireAuth + requireSystemAdmin). */
export function mountAdminPromotionRoutes(app, db, { guard, wrap, fail }) {
  const act = (fn) => wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { if (e instanceof PromoError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
  });
  app.get('/api/admin/promotions', guard, wrap(async (req, res) => res.json({ promotions: await listPromotions(db), placements: PROMO_PLACEMENTS, today: todayKst() })));
  app.post('/api/admin/promotions', guard, act((req) => createPromotion(db, { id: req.user.id }, req.body || {})));
  app.patch('/api/admin/promotions/:id', guard, act((req) => updatePromotion(db, { id: req.user.id }, req.params.id, req.body || {})));
  app.delete('/api/admin/promotions/:id', guard, act((req) => deletePromotion(db, { id: req.user.id }, req.params.id)));
}
