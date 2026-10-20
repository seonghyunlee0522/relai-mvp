/**
 * 산출물 카탈로그 (batch7 #3, migration 49) — "what do we have to hand in?" picked from a standard list instead of typed from memory.
 *
 *   deliverable_catalog     the global list (관리자 › 산출물 목록): BASIC (기본, default 필수) / ADVANCED (심화, default 제외), per phase
 *   project_deliverables    only what a project changed: a catalog row's level (필수 · 선택 · 제외) / 제출일, or a 직접 추가 item
 *
 * An unselected catalog item has no row and reads as its default_level, so an item the operator adds shows in every project at
 * once. An item added after the project's 범위 section was completed is marked 새 항목 and reads as 선택 (OPTIONAL) there, so a
 * finished plan never gains a new 필수 deliverable silently. Choosing deliverables never gates 01 (not part of any readiness).
 *
 *   GET  /api/workspaces/:wid/projects/:pid/deliverables      resolved list + summary (+ the legacy free text, read-only)
 *   PUT  /api/workspaces/:wid/projects/:pid/deliverables      { items: [{ catalog_id | id, level?, submitted_at?, custom_name?, phase_key?, remove? }] } — changes only
 *   GET/POST/PATCH /api/admin/deliverables                    operator catalog (audit DELIVERABLE_CATALOG_*)
 */
import { randomUUID } from 'node:crypto';
import { ValidationError, isDate } from './validate.js';
import { DEFAULT_PHASES } from './templates/default-phases.js';
import { writeAudit } from './admin.js';

export const LEVELS = ['REQUIRED', 'OPTIONAL', 'EXCLUDED'];
export const LEVEL_LABEL = { REQUIRED: '필수', OPTIONAL: '선택', EXCLUDED: '제외' };
export const TIERS = ['BASIC', 'ADVANCED'];
export const TIER_LABEL = { BASIC: '베이직', ADVANCED: '심화' };
export const PHASE_KEYS = DEFAULT_PHASES.map((p) => p.key);
export const PHASE_NAME = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, p.name]));
const phaseIdx = (k) => { const i = PHASE_KEYS.indexOf(k); return i < 0 ? 99 : i; };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const ymd = (v) => (!v ? null : typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

export const listCatalog = (db, { all = false } = {}) => db.all(`SELECT id, code, name, phase_key, tier, default_level, description, sort, active, created_at, updated_at
  FROM deliverable_catalog ${all ? '' : 'WHERE active'} ORDER BY sort, created_at`);

/** When 01 범위 was completed (catalog items created later are 새 항목 → OPTIONAL for this project). */
async function scopeCompletedAt(db, projectId) {
  const r = await db.get(`SELECT s.completed_at FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? AND p.phase_key = 'INITIATION' AND s.step_key = 'SCOPE' AND s.status = 'COMPLETED'`, [projectId]);
  return r && r.completed_at ? new Date(r.completed_at) : null;
}

/**
 * Resolved list for one project: every active catalog item (row level, else default) + 직접 추가 items, in phase order.
 * summary.required / submitted = 필수 n건 중 제출 m건 (07 종료 · 완료보고서). has_selection = the project saved at least one choice.
 */
export async function loadDeliverables(db, project) {
  const [cat, rows, done, def] = await Promise.all([
    listCatalog(db),
    db.all('SELECT id, catalog_id, custom_name, phase_key, level, submitted_at, note FROM project_deliverables WHERE project_id = ? ORDER BY created_at', [project.id]),
    scopeCompletedAt(db, project.id),
    db.get('SELECT deliverables FROM project_definitions WHERE project_id = ?', [project.id]),
  ]);
  const byCat = new Map(rows.filter((r) => r.catalog_id).map((r) => [r.catalog_id, r]));
  const items = cat.map((c) => {
    const r = byCat.get(c.id); const isNew = Boolean(!r && done && c.created_at && new Date(c.created_at) > done);
    const level = r ? r.level : isNew ? 'OPTIONAL' : c.default_level;
    return { key: c.id, catalog_id: c.id, id: r ? r.id : null, code: c.code, name: c.name, description: c.description || '', phase_key: c.phase_key, phase_name: PHASE_NAME[c.phase_key] || c.phase_key,
      tier: c.tier, default_level: c.default_level, level, level_label: LEVEL_LABEL[level], chosen: Boolean(r), is_new: isNew, custom: false,
      submitted_at: r ? ymd(r.submitted_at) : null, sort: c.sort };
  });
  for (const r of rows.filter((x) => !x.catalog_id)) items.push({ key: r.id, catalog_id: null, id: r.id, code: null, name: r.custom_name, description: r.note || '', phase_key: r.phase_key,
    phase_name: PHASE_NAME[r.phase_key] || r.phase_key, tier: null, default_level: null, level: r.level, level_label: LEVEL_LABEL[r.level], chosen: true, is_new: false, custom: true, submitted_at: ymd(r.submitted_at), sort: 9999 });
  items.sort((a, b) => phaseIdx(a.phase_key) - phaseIdx(b.phase_key) || a.sort - b.sort);
  const req = items.filter((x) => x.level === 'REQUIRED');
  return { items, phases: DEFAULT_PHASES.map((p) => ({ key: p.key, name: p.name })),
    summary: { required: req.length, submitted: req.filter((x) => x.submitted_at).length, optional: items.filter((x) => x.level === 'OPTIONAL').length },
    has_selection: rows.length > 0, legacy_text: def ? def.deliverables || '' : '' };
}

/** The deliverables a document lists: 필수 and 선택 (제외 is left out), in phase order. */
export const listedDeliverables = (model) => model.items.filter((x) => x.level !== 'EXCLUDED');

/** Save only what changed. A catalog item set back to its default level keeps its row (the choice was made on purpose). */
export async function saveDeliverables(db, project, body = {}) {
  const list = body && Array.isArray(body.items) ? body.items : null;
  if (!list) throw new ValidationError({ items: '목록 형식이 올바르지 않습니다.' });
  if (list.length > 300) throw new ValidationError({ items: '한 번에 300개까지 저장할 수 있습니다.' });
  const cat = new Map((await listCatalog(db, { all: true })).map((c) => [c.id, c]));
  const ts = new Date().toISOString();
  for (const [i, x] of list.entries()) {
    const f = (msg) => new ValidationError({ [`items.${i}`]: msg });
    if (x.level !== undefined && !LEVELS.includes(x.level)) throw f('필수 · 선택 · 제외 중 하나를 고르세요.');
    if (x.submitted_at !== undefined && x.submitted_at !== null && x.submitted_at !== '' && !isDate(String(x.submitted_at))) throw f('제출일 형식(YYYY-MM-DD)을 확인해 주세요.');
    const sub = x.submitted_at === undefined ? undefined : x.submitted_at || null;
    if (x.catalog_id) {
      const c = cat.get(String(x.catalog_id)); if (!c) throw f('산출물 목록에 없는 항목입니다.');
      const ex = await db.get('SELECT id, level, submitted_at FROM project_deliverables WHERE project_id = ? AND catalog_id = ?', [project.id, c.id]);
      if (ex) await db.run('UPDATE project_deliverables SET level = ?, submitted_at = ?, updated_at = ? WHERE id = ?', [x.level || ex.level, sub === undefined ? ex.submitted_at : sub, ts, ex.id]);
      else await db.run('INSERT INTO project_deliverables (id, project_id, catalog_id, phase_key, level, submitted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [randomUUID(), project.id, c.id, c.phase_key, x.level || c.default_level, sub || null, ts, ts]);
      continue;
    }
    // 직접 추가 (custom): create without id, update / remove with id
    const ex = x.id ? await db.get('SELECT id, level, submitted_at, custom_name, phase_key FROM project_deliverables WHERE project_id = ? AND id = ? AND catalog_id IS NULL', [project.id, String(x.id)]) : null;
    if (x.id && !ex) throw f('산출물을 찾을 수 없습니다.');
    if (ex && x.remove) { await db.run('DELETE FROM project_deliverables WHERE id = ?', [ex.id]); continue; }
    const name = x.custom_name !== undefined ? str(x.custom_name, 100) : ex ? ex.custom_name : '';
    if (!name) throw f('산출물 이름을 입력하세요.');
    const phase = x.phase_key !== undefined ? String(x.phase_key) : ex ? ex.phase_key : '';
    if (!PHASE_KEYS.includes(phase)) throw f('단계를 고르세요.');
    if (ex) await db.run('UPDATE project_deliverables SET custom_name = ?, phase_key = ?, level = ?, submitted_at = ?, updated_at = ? WHERE id = ?', [name, phase, x.level || ex.level, sub === undefined ? ex.submitted_at : sub, ts, ex.id]);
    else {
      if ((await db.get('SELECT COUNT(*)::int AS n FROM project_deliverables WHERE project_id = ? AND catalog_id IS NULL', [project.id])).n >= 100) throw f('직접 추가한 산출물은 100개까지 둘 수 있습니다.');
      await db.run('INSERT INTO project_deliverables (id, project_id, catalog_id, custom_name, phase_key, level, submitted_at, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?)',
        [randomUUID(), project.id, name, phase, x.level || 'REQUIRED', sub || null, ts, ts]);
    }
  }
  return loadDeliverables(db, project);
}

/* ---------- operator catalog (관리자 › 산출물 목록) ---------- */
export class CatalogError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; } }
function cleanCatalog(b = {}, { partial = false } = {}) {
  const out = {}; const f = {}; const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) { out.name = str(b.name, 100); if (!out.name) f.name = '산출물 이름을 입력해 주세요.'; }
  if (has('phase_key')) { out.phase_key = String(b.phase_key || ''); if (!PHASE_KEYS.includes(out.phase_key)) f.phase_key = '단계를 고르세요.'; }
  if (has('tier')) { out.tier = String(b.tier || ''); if (!TIERS.includes(out.tier)) f.tier = '베이직 또는 심화를 고르세요.'; }
  if (has('default_level')) { out.default_level = String(b.default_level || ''); if (!LEVELS.includes(out.default_level)) f.default_level = '기본값은 필수 · 선택 · 제외 중 하나입니다.'; }
  if (has('description')) out.description = str(b.description, 300);
  if (has('sort')) { const n = Number(b.sort ?? 0); out.sort = Number.isFinite(n) ? Math.max(0, Math.min(99999, Math.round(n))) : 0; }
  if (has('active')) out.active = b.active === true || b.active === 'true' || b.active === 1;
  if (Object.keys(f).length) throw new CatalogError(422, 'validation_error', '입력값을 확인해 주세요.', f);
  return out;
}
export async function createCatalogItem(db, admin, body) {
  const v = cleanCatalog({ description: '', active: true, ...body, default_level: body?.default_level || (body?.tier === 'ADVANCED' ? 'EXCLUDED' : 'REQUIRED') });
  if (body?.sort === undefined) v.sort = Number((await db.get('SELECT COALESCE(MAX(sort), 0) AS n FROM deliverable_catalog WHERE phase_key = ?', [v.phase_key])).n) + 5;
  const id = randomUUID(); const code = `C_${id.slice(0, 8).toUpperCase()}`;
  await db.run('INSERT INTO deliverable_catalog (id, code, name, phase_key, tier, default_level, description, sort, active) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, code, v.name, v.phase_key, v.tier, v.default_level, v.description, v.sort, v.active]);
  await writeAudit(db, { adminUserId: admin.id, action: 'DELIVERABLE_CATALOG_CREATE', targetType: 'DELIVERABLE', targetId: id, metadata: { name: v.name, phase_key: v.phase_key, tier: v.tier } });
  return { item: await db.get('SELECT * FROM deliverable_catalog WHERE id = ?', [id]) };
}
export async function updateCatalogItem(db, admin, id, body) {
  const ex = await db.get('SELECT id, name FROM deliverable_catalog WHERE id = ?', [id]);
  if (!ex) throw new CatalogError(404, 'not_found', '산출물을 찾을 수 없습니다.');
  const v = cleanCatalog(body, { partial: true }); const keys = Object.keys(v);
  if (keys.length) await db.run(`UPDATE deliverable_catalog SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, [...keys.map((k) => v[k]), id]);
  // a phase move follows into the rows projects saved for this item (their own phase_key copy)
  if (v.phase_key) await db.run('UPDATE project_deliverables SET phase_key = ? WHERE catalog_id = ?', [v.phase_key, id]);
  await writeAudit(db, { adminUserId: admin.id, action: 'DELIVERABLE_CATALOG_UPDATE', targetType: 'DELIVERABLE', targetId: id, metadata: { name: v.name || ex.name, fields: keys } });
  return { item: await db.get('SELECT * FROM deliverable_catalog WHERE id = ?', [id]) };
}

/** Operator routes — mounted inside mountAdminRoutes (guard = requireAuth + requireSystemAdmin). */
export function mountAdminDeliverableRoutes(app, db, { guard, wrap, fail }) {
  const act = (fn) => wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { if (e instanceof CatalogError) return fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {}); throw e; }
  });
  app.get('/api/admin/deliverables', guard, wrap(async (req, res) => {
    const items = await listCatalog(db, { all: true });
    const used = new Map((await db.all(`SELECT catalog_id, COUNT(*)::int AS n FROM project_deliverables WHERE catalog_id IS NOT NULL AND level = 'REQUIRED' GROUP BY catalog_id`)).map((r) => [r.catalog_id, r.n]));
    res.json({ items: items.map((x) => ({ ...x, required_in: used.get(x.id) || 0 })), phases: DEFAULT_PHASES.map((p) => ({ key: p.key, name: p.name })), tiers: TIER_LABEL, levels: LEVEL_LABEL });
  }));
  app.post('/api/admin/deliverables', guard, act((req) => createCatalogItem(db, { id: req.user.id }, req.body || {})));
  app.patch('/api/admin/deliverables/:id', guard, act((req) => updateCatalogItem(db, { id: req.user.id }, req.params.id, req.body || {})));
}
