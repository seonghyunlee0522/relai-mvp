/**
 * Routes added after the core CRUD: Excel template/export/import, bulk actions, comments, dashboard.
 * Mounted from app.js next to the requirement / WBS route blocks (template.xlsx & export.xlsx must be registered
 * BEFORE the `/:rid` and `/:iid` param routes, which is why the mount calls sit where they do).
 * Every route uses the same guard → loadProject → mutable (writes) chain as the core routes.
 */
import express from 'express';
import { APP_TIMEZONE } from './db.js';
import { ValidationError } from './validate.js';
import * as R from './requirements.js';
import * as W from './wbs.js';
import { KINDS } from './importspec.js';
import { XLSX_MIME, MAX_IMPORT_ROWS, ImportFileError, buildTemplate, buildExport, buildErrorReport } from './xlsx.js';
import { previewImport, runImport, inspectWbsWorkbook } from './importer.js';
import { decodeBase64Xlsx } from './xlsx.js';
import { bulkRequirements, bulkWbs } from './bulk.js';
import { parseComment, listComments, addComment, getComment, deleteComment } from './comments.js';
import { can } from './authz.js';
import { projectDashboard, projectActivity } from './dashboard.js';

/** JSON bodies of the import endpoints may carry a base64 xlsx (≤5 MB file → ≈6.7 MB); everything else keeps the 64 KB limit. */
export const BIG_BODY_LIMIT = '8mb';
export const BIG_JSON_PATH = /^\/api\/workspaces\/[^/]+\/projects\/[^/]+\/(requirements|wbs)\/import(\/preview|\/inspect|\/errors\.xlsx)?\/?$/;
const bigJson = express.json({ limit: BIG_BODY_LIMIT });

/* ---------- download helpers ---------- */
const pct = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const safeName = (s, fallback) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 60) || fallback;
const ymd = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');

function sendXlsx(res, buffer, asciiName, koreanName) {
  res.set({
    'Content-Type': XLSX_MIME,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${pct(koreanName)}`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}

/* ---------- export data ---------- */
async function memberLabels(db, wid) {
  const ms = await db.all('SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [wid]);
  const count = new Map(); for (const m of ms) count.set(m.name, (count.get(m.name) || 0) + 1);
  return (id) => { const m = ms.find((x) => x.id === id); return m ? (count.get(m.name) > 1 ? m.email : m.name) : ''; };  // ambiguous names are exported as e-mail so the file re-imports cleanly
}

async function requirementRows(db, project, wid) {
  const label = await memberLabels(db, wid);
  const reqs = await R.listRequirements(db, project, {});
  const crit = await db.all(`SELECT c.requirement_id, c.content FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id WHERE r.project_id = ? ORDER BY c.requirement_id, c.sequence`, [project.id]);
  const by = new Map(); for (const c of crit) { if (!by.has(c.requirement_id)) by.set(c.requirement_id, []); by.get(c.requirement_id).push(c.content); }
  const L = KINDS.requirements.columns; const lab = (key, v) => L.find((c) => c.key === key).options.find((o) => o.value === v)?.label ?? v;
  return reqs.map((r) => ({ display_id: r.display_id, title: r.title, description: r.description, type: lab('type', r.type), priority: lab('priority', r.priority), scope: lab('scope', r.scope),
    status: lab('status', r.status), owner: r.owner_user_id ? label(r.owner_user_id) : '', requester_name: r.requester_name, requester_organization: r.requester_organization, criteria: (by.get(r.id) || []).join('\n') }));
}

async function wbsRows(db, project, wid) {
  const label = await memberLabels(db, wid);
  const { items } = await W.loadTree(db, project);
  const byId = new Map(items.map((i) => [i.id, i]));
  const L = KINDS.wbs.columns; const lab = (key, v) => L.find((c) => c.key === key).options.find((o) => o.value === v)?.label ?? v;
  return items.map((i) => ({ code: i.wbs_code, parent_code: i.parent_id ? byId.get(i.parent_id)?.wbs_code || '' : '', item_type: lab('item_type', i.item_type), title: i.title, description: i.description,
    owner: i.owner_user_id ? label(i.owner_user_id) : '', start: i.item_type === 'MILESTONE' ? '' : i.planned_start_date || '', end: i.item_type === 'MILESTONE' ? i.milestone_date || '' : i.planned_end_date || '',
    status: lab('status', i.status), progress: i.item_type === 'TASK' && !i.is_group ? i.progress : '', predecessors: i.predecessors.map((p) => byId.get(p.predecessor_id)?.wbs_code).filter(Boolean).join(', ') }));
}

/* ---------- shared route set for both kinds ---------- */
function mountExcelRoutes({ app, db, guard, wrap, fail, loadProject, mutable }, kind, segBase) {
  const spec = KINDS[kind];
  const loadOnly = async (req, res) => loadProject(req, res);

  app.get(`${segBase}/template.xlsx`, guard, wrap(async (req, res) => {
    if (!(await loadOnly(req, res))) return;
    sendXlsx(res, await buildTemplate(kind), `${spec.names.ascii}-template.xlsx`, `${spec.names.template}.xlsx`);
  }));
  app.get(`${segBase}/export.xlsx`, guard, wrap(async (req, res) => {
    const project = await loadOnly(req, res); if (!project) return;
    const rows = kind === 'requirements' ? await requirementRows(db, project, req.params.wid) : await wbsRows(db, project, req.params.wid);
    sendXlsx(res, await buildExport(kind, rows), `${spec.names.ascii}-export.xlsx`, `${spec.names.export}_${safeName(project.name, 'project')}_${ymd()}.xlsx`);
  }));
  if (kind === 'wbs') app.post(`${segBase}/import/inspect`, guard, bigJson, wrap(async (req, res) => {   // headers + sample + suggested column mapping
    const project = await loadOnly(req, res); if (!project) return;
    res.json(await inspectWbsWorkbook(decodeBase64Xlsx(req.body?.data)));
  }));
  app.post(`${segBase}/import/preview`, guard, bigJson, wrap(async (req, res) => {
    const project = await loadOnly(req, res); if (!project) return;
    res.json(await previewImport(db, project, req.params.wid, kind, req.body || {}));
  }));
  app.post(`${segBase}/import/errors.xlsx`, guard, bigJson, wrap(async (req, res) => {
    const project = await loadOnly(req, res); if (!project) return;
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) throw new ValidationError({ rows: '오류 행 목록이 올바르지 않습니다.' });
    if (rows.length > MAX_IMPORT_ROWS) throw new ImportFileError(400, `한 번에 최대 ${MAX_IMPORT_ROWS.toLocaleString('en-US')}행까지 처리할 수 있습니다.`, 'too_many_rows');
    const failed = rows.filter((r) => r && typeof r === 'object').map((r) => ({
      row: r.row, values: r.values && typeof r.values === 'object' ? r.values : {}, errors: r.errors && typeof r.errors === 'object' ? r.errors : {},
      row_errors: Array.isArray(r.row_errors) ? r.row_errors.map(String) : [],
    }));
    sendXlsx(res, await buildErrorReport(kind, failed), `${spec.names.ascii}-import-errors.xlsx`, `${spec.names.export}_가져오기_오류.xlsx`);
  }));
  app.post(`${segBase}/import`, guard, bigJson, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    res.json(await runImport(db, project, req.params.wid, kind, req.body || {}, req.user.id));
  }));
}

/** Comments: any workspace member may add; only the author or a workspace OWNER/ADMIN may delete. Archived project → 409; archived entity → allowed. */
function mountComments({ app, db, guard, wrap, fail, loadProject, mutable }, type, segBase, param, table, notFound) {
  const load = async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return null;
    const entity = await db.get(`SELECT id FROM ${table} WHERE project_id = ? AND id = ?`, [project.id, req.params[param]]);
    if (!entity) { fail(res, 404, 'not_found', notFound); return null; }
    return { project, entity };
  };
  app.post(`${segBase}/:${param}/comments`, guard, wrap(async (req, res) => {
    const ctx = await load(req, res); if (!ctx) return;
    const { body } = parseComment(req.body);
    const comment = await addComment(db, ctx.project, type, ctx.entity.id, req.user.id, body);
    res.status(201).json({ comment, comments: await listComments(db, type, ctx.entity.id) });
  }));
  app.delete(`${segBase}/:${param}/comments/:cid`, guard, wrap(async (req, res) => {
    const ctx = await load(req, res); if (!ctx) return;
    const c = await getComment(db, ctx.project, type, ctx.entity.id, req.params.cid);
    if (!c) return fail(res, 404, 'not_found', '댓글을 찾을 수 없습니다.');
    if (c.created_by !== req.user.id && !can(req.role, 'project_manage')) return fail(res, 403, 'forbidden', '이 작업을 할 권한이 없습니다.', { required: ['AUTHOR', 'OWNER', 'ADMIN'] });
    await deleteComment(db, c.id);
    res.json({ comments: await listComments(db, type, ctx.entity.id) });
  }));
}

export function mountRequirementRoutes(ctx) {
  const { app, db, guard, wrap, loadProject, mutable, rbase } = ctx;
  mountExcelRoutes(ctx, 'requirements', rbase);
  app.post(`${rbase}/bulk`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    res.json(await bulkRequirements(db, project, req.params.wid, req.body || {}, req.user.id));
  }));
  mountComments(ctx, 'REQUIREMENT', rbase, 'rid', 'requirements', '요구사항을 찾을 수 없습니다.');
}

export function mountWbsRoutes(ctx) {
  const { app, db, guard, wrap, loadProject, mutable, wbase, wbsResponse } = ctx;
  mountExcelRoutes(ctx, 'wbs', wbase);
  app.post(`${wbase}/bulk`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    const result = await bulkWbs(db, project, req.params.wid, req.body || {}, req.user.id);
    res.json({ ...result, ...(await wbsResponse(project)) });
  }));
  mountComments(ctx, 'WBS', wbase, 'iid', 'wbs_items', 'WBS 항목을 찾을 수 없습니다.');
}

export function mountDashboardRoute({ app, db, guard, wrap, loadProject, base }) {
  app.get(`${base}/:pid/dashboard`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await projectDashboard(db, project));
  }));
  /** Project activity (history + comments), opened on demand from the workspace header. */
  app.get(`${base}/:pid/activity`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await projectActivity(db, project.id, { limit: req.query.limit }));
  }));
}
