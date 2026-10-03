/**
 * Excel import for requirements and WBS: validation (shared by preview and import), partial-success creation.
 *
 * Contract (frontend): rows are { row, values: { <columnKey>: <string> } }; validation never trusts the client —
 * `import` re-validates everything server-side inside the same transaction that creates the rows.
 */
import { ValidationError } from './validate.js';
import { tx } from './db.js';
import * as R from './requirements.js';
import * as W from './wbs.js';
import { formatDisplayId } from './common.js';
import { KINDS, normHeader, publicColumns } from './importspec.js';
import { MAX_IMPORT_ROWS, ImportFileError, parseWorkbook, decodeBase64Xlsx, parseWorkbookRaw } from './xlsx.js';

const REQUIRED = '필수 항목입니다.';
const CODE_RE = /^\d+(\.\d+)*$/;

/* ---------- cell-level parsers ---------- */
const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

export function resolveEnum(column, raw) {
  const t = raw.trim();
  if (!t) return { value: null };
  const n = norm(t); const nc = n.replace(/[_-]/g, '');
  for (const o of column.options) {
    if (norm(o.label) === n || o.value.toLowerCase() === n || o.value.toLowerCase().replace(/_/g, '') === nc) return { value: o.value };
    if ((o.aliases || []).some((a) => norm(a) === n)) return { value: o.value };
  }
  return { error: `${column.label} 값이 올바르지 않습니다. (${column.options.map((o) => o.label).join(', ')})` };
}

function resolveOwner(members, raw) {
  const t = raw.trim();
  if (!t) return { value: null };
  const byEmail = members.filter((m) => m.email.toLowerCase() === t.toLowerCase());
  if (byEmail.length === 1) return { value: byEmail[0].id };
  const byName = members.filter((m) => m.name === t);
  if (byName.length === 1) return { value: byName[0].id };
  if (byName.length > 1) return { error: '같은 이름의 멤버가 여러 명입니다. 이메일로 입력해 주세요.' };
  return { error: '담당자를 찾을 수 없습니다.' };
}

/** YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD (1–2 digit month/day tolerated) → { value:'YYYY-MM-DD' }. */
function parseDate(raw) {
  const t = raw.trim();
  if (!t) return { value: null };
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return { value: `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }
  return { error: '날짜 형식이 올바르지 않습니다. (예: 2026-10-01)' };
}

function parseProgress(raw) {
  const t = raw.trim();
  if (!t) return { value: null };
  const m = /^(\d{1,3})(?:\.0+)?\s*%?$/.exec(t);
  if (!m || Number(m[1]) > 100) return { error: '진행률은 0~100 사이의 정수여야 합니다.' };
  return { value: Number(m[1]) };
}

/** Maps ValidationError fields from the existing parsers onto column keys, never overriding a more specific error. */
function mergeFieldErrors(errors, e, map) {
  if (!(e instanceof ValidationError)) throw e;
  for (const [field, msg] of Object.entries(e.fields)) { const key = map[field] || field; if (!errors[key]) errors[key] = msg; }
}

/* ---------- requirements ---------- */
async function reqContext(db, project, wid) {
  const members = await db.all('SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [wid]);
  const existing = new Set((await db.all('SELECT display_id FROM requirements WHERE project_id = ?', [project.id])).map((r) => r.display_id));
  return { members, existing };
}

function validateRequirements(rows, ctx) {
  const spec = KINDS.requirements; const col = (k) => spec.columns.find((c) => c.key === k);
  const seen = new Set();
  return rows.map((r) => {
    const v = r.values; const errors = {}; const o = { row: r.row, values: v, errors, row_errors: [], model: null };
    if (!v.title) errors.title = REQUIRED;
    const enums = {};
    for (const k of ['type', 'priority', 'scope', 'status']) { const x = resolveEnum(col(k), v[k]); if (x.error) errors[k] = x.error; else enums[k] = x.value; }
    const ow = resolveOwner(ctx.members, v.owner); if (ow.error) errors.owner = ow.error;
    let displayId;
    if (v.display_id) {
      const m = /^REQ-(\d{1,6})$/i.exec(v.display_id.replace(/\s+/g, ''));
      if (!m || Number(m[1]) < 1) errors.display_id = '요구사항 ID 형식이 올바르지 않습니다. (예: REQ-001)';
      else {
        displayId = formatDisplayId('REQUIREMENT', Number(m[1]));
        if (ctx.existing.has(displayId)) errors.display_id = '중복된 요구사항 ID입니다.';
        else if (seen.has(displayId)) errors.display_id = '파일 내에 중복된 요구사항 ID입니다.';
        seen.add(displayId);
      }
    }
    const criteria = [];
    if (v.criteria) {
      for (const line of v.criteria.split('\n').map((x) => x.trim()).filter(Boolean)) {
        try { criteria.push(R.parseCriterion({ content: line })); } catch (e) { if (!(e instanceof ValidationError)) throw e; errors.criteria = '완료 조건은 줄마다 1,000자 이내로 입력해 주세요.'; }
      }
    }
    try { R.parseRequirement({ title: v.title || 'x', description: v.description, requester_name: v.requester_name, requester_organization: v.requester_organization }); } catch (e) { mergeFieldErrors(errors, e, {}); }
    if (!Object.keys(errors).length) {
      o.model = { title: v.title, description: v.description, ...Object.fromEntries(Object.entries(enums).filter(([, x]) => x)), requester_name: v.requester_name, requester_organization: v.requester_organization, owner_user_id: ow.value, display_id: displayId, criteria };
    }
    return o;
  });
}

/* ---------- WBS ---------- */
async function wbsContext(db, project, wid, parentId) {
  const members = await db.all('SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [wid]);
  if (parentId !== undefined && parentId !== null && parentId !== '') {
    if (typeof parentId !== 'string') throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    const p = await db.get('SELECT * FROM wbs_items WHERE project_id = ? AND id = ?', [project.id, parentId]);
    if (!p || p.archived_at) throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    if (p.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래에는 항목을 만들 수 없습니다.' });
  }
  return { members, parentId: parentId || null };
}

const parentCodeOf = (code) => (code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null);

function validateWbs(rows, ctx) {
  const spec = KINDS.wbs; const col = (k) => spec.columns.find((c) => c.key === k);
  const out = rows.map((r) => ({ row: r.row, values: r.values, errors: {}, row_errors: [], model: null }));
  const byCode = new Map(); const hasChildren = new Set(); const typeOf = []; const preds = [];
  out.forEach((o, i) => { const c = o.values.code; if (CODE_RE.test(c)) { const p = parentCodeOf(c); if (p) hasChildren.add(p); } });

  /* pass 1: everything that can be decided from the row itself */
  out.forEach((o, i) => {
    const v = o.values; const e = o.errors;
    if (!v.code) e.code = REQUIRED;
    else if (!CODE_RE.test(v.code)) e.code = 'WBS Code 형식이 올바르지 않습니다. (예: 1, 1.1, 1.2.1)';
    else if (byCode.has(v.code)) e.code = '중복된 WBS Code입니다.';
    else byCode.set(v.code, i);
    if (v.parent_code && CODE_RE.test(v.code)) {
      const expected = parentCodeOf(v.code);
      if (v.parent_code !== (expected || '')) e.parent_code = expected ? `상위 WBS는 WBS Code에서 마지막 단계를 뺀 값(${expected})이어야 합니다.` : '최상위 항목은 상위 WBS를 비워 두세요.';
    }
    if (!v.title) e.title = REQUIRED;

    const t = resolveEnum(col('item_type'), v.item_type); if (t.error) e.item_type = t.error;
    const type = t.value || 'TASK';   // a row with children is a TASK group (SUMMARY only when the file says so — legacy)
    typeOf[i] = type;
    const st = resolveEnum(col('status'), v.status); if (st.error) e.status = st.error;
    const ow = resolveOwner(ctx.members, v.owner); if (ow.error) e.owner = ow.error;
    const sd = parseDate(v.start); const ed = parseDate(v.end);
    if (sd.error) e.start = sd.error; else if (sd.value) v.start = sd.value;
    if (ed.error) e.end = ed.error; else if (ed.value) v.end = ed.value;
    if (type === 'MILESTONE' && v.start && !e.start) e.start = '마일스톤은 시작일을 입력하지 않습니다. 종료일 칸에 마일스톤 날짜를 입력하세요.';
    if (type !== 'MILESTONE' && sd.value && ed.value && ed.value < sd.value) e.end = '종료일은 시작일보다 빠를 수 없습니다.';
    const pg = parseProgress(v.progress);
    if (pg.error) e.progress = pg.error;
    else if (pg.value !== null && (type !== 'TASK' || (hasChildren.has(v.code) && pg.value !== 0))) e.progress = type === 'MILESTONE' ? '마일스톤은 진행률을 관리하지 않습니다.' : '상위 항목의 진행률은 하위 작업에서 계산됩니다.';

    const list = [];
    for (const tok of v.predecessors.split(/[,，;\n]+/).map((x) => x.trim()).filter(Boolean)) {
      if (tok === v.code) { e.predecessors = '자기 자신을 선행 작업으로 지정할 수 없습니다.'; continue; }
      if (!list.includes(tok)) list.push(tok);
    }
    preds[i] = list;

    if (!e.title) {
      try {
        W.parseWbs({ item_type: type, title: v.title, description: v.description, status: st.value || undefined, progress: pg.value ?? undefined,
          planned_start_date: type === 'MILESTONE' ? undefined : sd.value || undefined, planned_end_date: type === 'MILESTONE' ? undefined : ed.value || undefined });
      } catch (err) { mergeFieldErrors(e, err, { planned_start_date: 'start', planned_end_date: 'end' }); }
    }
    o.draft = { type, status: st.value, owner: ow.value, start: sd.value, end: ed.value, progress: pg.value };
  });

  /* pass 2: references to other rows (parent, predecessors) */
  out.forEach((o, i) => {
    const e = o.errors; const v = o.values;
    if (CODE_RE.test(v.code)) {
      const p = parentCodeOf(v.code);
      if (p) {
        const pi = byCode.get(p); const key = e.parent_code ? null : (v.parent_code ? 'parent_code' : 'code');
        if (pi === undefined) { if (key && !e[key]) e[key] = `상위 항목(${p})이 파일에 없습니다.`; }
        else if (typeOf[pi] === 'MILESTONE' && key && !e[key]) e[key] = '마일스톤 아래에는 항목을 만들 수 없습니다.';
      }
    }
    for (const tok of preds[i]) if (!byCode.has(tok) && !e.predecessors) e.predecessors = `선행 작업 '${tok}'을(를) 파일에서 찾을 수 없습니다.`;
  });

  /* cycle check: same rule as addDependency, applied in file order */
  const next = new Map();
  const reaches = (from, to) => { const seenN = new Set([from]); const st = [from]; while (st.length) { const n = st.pop(); if (n === to) return true; for (const m of next.get(n) || []) if (!seenN.has(m)) { seenN.add(m); st.push(m); } } return false; };
  out.forEach((o, i) => {
    for (const tok of preds[i]) {
      const j = byCode.get(tok); if (j === undefined || j === i) continue;
      if (reaches(i, j)) { if (!o.errors.predecessors) o.errors.predecessors = '순환 관계가 생겨 지정할 수 없습니다.'; continue; }
      if (!next.has(j)) next.set(j, []); next.get(j).push(i);
    }
  });

  /* pass 3: a row cannot be created when its parent or a predecessor cannot (iterate to a fixed point) */
  const failed = (o) => Object.keys(o.errors).length > 0 || o.row_errors.length > 0;
  for (let changed = true; changed;) {
    changed = false;
    out.forEach((o, i) => {
      if (failed(o) || !CODE_RE.test(o.values.code)) return;
      const p = parentCodeOf(o.values.code);
      if (p && byCode.has(p) && failed(out[byCode.get(p)])) { o.row_errors.push('상위 항목 오류로 가져오지 못했습니다.'); changed = true; return; }
      const bad = preds[i].find((tok) => byCode.has(tok) && failed(out[byCode.get(tok)]));
      if (bad !== undefined) { o.errors.predecessors = `선행 작업 '${bad}'에 오류가 있어 연결할 수 없습니다.`; changed = true; }
    });
  }

  out.forEach((o, i) => {
    if (!failed(o)) {
      const d = o.draft; const milestone = d.type === 'MILESTONE';
      o.model = { item_type: d.type, title: o.values.title, description: o.values.description, owner_user_id: d.owner, status: d.status || undefined,
        progress: d.type === 'TASK' ? d.progress ?? undefined : undefined,
        planned_start_date: milestone ? undefined : d.start, planned_end_date: milestone ? undefined : d.end, milestone_date: milestone ? d.end : undefined,
        code: o.values.code, parent_code: parentCodeOf(o.values.code), preds: preds[i] };
    }
    delete o.draft;
  });
  return out;
}

/* ---------- shared plumbing ---------- */
function sanitizeRows(rows, kind) {
  if (!Array.isArray(rows)) throw new ValidationError({ rows: '가져올 행 목록이 올바르지 않습니다.' });
  if (rows.length > MAX_IMPORT_ROWS) throw new ImportFileError(400, `한 번에 최대 ${MAX_IMPORT_ROWS.toLocaleString('en-US')}행까지 가져올 수 있습니다.`, 'too_many_rows');
  const keys = KINDS[kind].columns.map((c) => c.key);
  const out = [];
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.values !== 'object' || r.values === null) throw new ValidationError({ rows: `${i + 1}번째 행의 형식이 올바르지 않습니다.` });
    const values = {}; let any = false;
    for (const k of keys) {
      const raw = r.values[k];
      const t = (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '').replace(/\r\n?/g, '\n').trim().slice(0, 20000);
      values[k] = t; if (t) any = true;
    }
    if (any) out.push({ row: Number.isInteger(r.row) ? r.row : i + 2, values });
  });
  return out;
}

const loadContext = (db, project, wid, kind, parentId) => (kind === 'requirements' ? reqContext(db, project, wid) : wbsContext(db, project, wid, parentId));
const validate = (kind, rows, ctx) => (kind === 'requirements' ? validateRequirements(rows, ctx) : validateWbs(rows, ctx));
const view = (o) => ({ row: o.row, values: o.values, errors: o.errors, row_errors: o.row_errors, ok: !Object.keys(o.errors).length && !o.row_errors.length });
const summaryOf = (rows) => ({ total: rows.length, ok: rows.filter((r) => r.ok).length, error: rows.filter((r) => !r.ok).length });

/* ---------- WBS column mapping (enterprise files that are not the template) ---------- */
export const MAP_FIELDS = ['title', 'code', 'lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'owner', 'start', 'end', 'progress', 'status', 'description', 'item_type'];
const MAP_HINTS = {
  title: /^(wbs명|wbs\s*명|업무명|작업명|task(명|\s*name)?|activity|항목명|작업|업무|name|title|내용)$/i,
  code: /^(wbs\s*(code|코드|번호|no\.?)|code|코드|번호|no\.?|id)$/i,
  lv1: /^(lv\.?\s*1|level\s*1|레벨\s*1|1\s*단계|대분류|phase|단계)$/i, lv2: /^(lv\.?\s*2|level\s*2|레벨\s*2|2\s*단계|중분류)$/i, lv3: /^(lv\.?\s*3|level\s*3|레벨\s*3|3\s*단계|소분류)$/i,
  lv4: /^(lv\.?\s*4|level\s*4|레벨\s*4|4\s*단계)$/i, lv5: /^(lv\.?\s*5|level\s*5|레벨\s*5|5\s*단계)$/i,
  owner: /^(담당자|담당|owner|assignee|책임자|pic)$/i, start: /^(시작일?|계획\s*시작일?|start(\s*date)?|착수일?)$/i, end: /^(종료일?|계획\s*종료일?|end(\s*date)?|완료\s*예정일?|마감일?|finish)$/i,
  progress: /^(진행률|진척률|progress|%|달성률)$/i, status: /^(상태|status)$/i, description: /^(설명|비고|description|note|내용\s*설명)$/i, item_type: /^(유형|type|구분)$/i,
};
/** Reads headers + first rows and proposes a mapping. The template's own headers map 1:1 through the standard spec. */
export async function inspectWbsWorkbook(buffer) {
  const raw = await parseWorkbookRaw(buffer, { maxRows: 50 });
  const spec = KINDS.wbs; const byLabel = new Map(spec.columns.map((c) => [normHeader(c.label), c.key]));
  const suggested = {}; const used = new Set();
  for (const h of raw.headers) {
    const std = byLabel.get(normHeader(h.text));
    const key = std === 'parent_code' ? null : std === 'predecessors' ? null : std || MAP_FIELDS.find((f) => MAP_HINTS[f].test(h.text.trim()));
    if (key && !suggested[key] && !used.has(h.n)) { suggested[key] = h.n; used.add(h.n); }
  }
  const layout = suggested.lv1 && !suggested.code ? 'levels' : suggested.code ? 'code' : 'flat';
  return { headers: raw.headers, sample: raw.rows.slice(0, 8), suggested, layout, fields: MAP_FIELDS };
}

const CODE_NORM = (v) => String(v || '').trim().replace(/[\s]/g, '').replace(/\.$/, '').replace(/[-_/]/g, '.');
/**
 * Mapping → template rows. Hierarchy comes from (a) WBS Code dot notation, (b) Lv1..Lv5 columns (deepest non-empty = this row;
 * missing intermediate levels are created on the fly), or (c) nothing (every row is top level, file order).
 */
export function rowsFromMapping(raw, mapping = {}) {
  const m = {}; for (const f of MAP_FIELDS) { const n = Number(mapping[f]); if (Number.isInteger(n) && n > 0) m[f] = n; }
  if (!m.title && !m.lv1) throw new ValidationError({ mapping: 'WBS명 열(또는 Lv1 열)을 지정해 주세요.' });
  const cell = (r, f) => (m[f] ? String(r.cells[m[f]] ?? '').trim() : '');
  const out = []; const counters = []; const levelsOf = (r) => ['lv1', 'lv2', 'lv3', 'lv4', 'lv5'].map((k) => cell(r, k));
  const common = (r) => ({ owner: cell(r, 'owner'), start: cell(r, 'start'), end: cell(r, 'end'), progress: cell(r, 'progress'), status: cell(r, 'status'), description: cell(r, 'description'), item_type: cell(r, 'item_type'), predecessors: '', parent_code: '' });
  const useLevels = Boolean(m.lv1) && !m.code;
  const current = []; const lastLabel = [];   // open node per depth while walking Lv columns in file order
  const blank = () => ({ owner: '', start: '', end: '', progress: '', status: '', description: '', item_type: '', predecessors: '', parent_code: '' });
  for (const r of raw.rows) {
    if (m.code && !useLevels) {
      const code = CODE_NORM(cell(r, 'code')); const title = cell(r, 'title') || levelsOf(r).filter(Boolean).pop() || '';
      if (!code && !title) continue;
      out.push({ row: r.row, values: { code, title, ...common(r) } });
      continue;
    }
    if (useLevels) {
      const lv = levelsOf(r); let depth = -1; for (let i = lv.length - 1; i >= 0; i--) if (lv[i]) { depth = i; break; }
      if (depth < 0) { const t = cell(r, 'title'); if (!t) continue; lv[0] = t; depth = 0; }
      for (let d = 0; d <= depth; d++) {
        const label = lv[d];
        if (!label) {   // intermediate level left blank → stay under the current node at that depth
          if (!current[d]) { current[d] = null; out.push({ row: r.row, values: { code: '', title: '', ...common(r) } }); break; }   // no parent → validation error (code required)
          continue;
        }
        const leaf = d === depth;
        if (!leaf && current[d] && lastLabel[d] === label) continue;   // same group label repeated on this row → reuse
        counters.length = d + 1; counters[d] = (counters[d] || 0) + 1;
        const code = counters.slice(0, d + 1).join('.');
        current.length = d + 1; current[d] = code; lastLabel.length = d + 1; lastLabel[d] = label;
        out.push({ row: r.row, values: { code, title: leaf && cell(r, 'title') ? cell(r, 'title') : label, ...(leaf ? common(r) : blank()) } });
      }
      continue;
    }
    const title = cell(r, 'title'); if (!title) continue;
    counters[0] = (counters[0] || 0) + 1;
    out.push({ row: r.row, values: { code: String(counters[0]), title, ...common(r) } });
  }
  return out;
}

/** Never writes. Body: { data: base64 } to parse a file, or { rows } to re-validate edited rows. */
export async function previewImport(db, project, wid, kind, body = {}) {
  let rows; let warnings = [];
  const ctx = await loadContext(db, project, wid, kind, body.parent_id);
  if (body.data !== undefined && kind === 'wbs' && body.mapping && typeof body.mapping === 'object') {
    rows = sanitizeRows(rowsFromMapping(await parseWorkbookRaw(decodeBase64Xlsx(body.data)), body.mapping), kind);
  } else if (body.data !== undefined) {
    const parsed = await parseWorkbook(kind, decodeBase64Xlsx(body.data));
    rows = parsed.rows; warnings = parsed.warnings;
  } else rows = sanitizeRows(body.rows, kind);
  const result = validate(kind, rows, ctx).map(view);
  return { columns: publicColumns(kind), rows: result, summary: summaryOf(result), warnings };
}

/** Re-validates and creates every valid row in ONE transaction. Invalid rows are skipped (partial success). */
export async function runImport(db, project, wid, kind, body, userId) {
  const rows = sanitizeRows(body.rows, kind);
  return tx(db, async (t) => {
    const ctx = await loadContext(t, project, wid, kind, body.parent_id);
    const validated = validate(kind, rows, ctx);
    const created = new Map();   // index → { id, display_id | wbs_code }
    if (kind === 'requirements') {
      const reserved = new Set(validated.filter((o) => o.model?.display_id).map((o) => Number(/\d+$/.exec(o.model.display_id)[0])));
      for (const [i, o] of validated.entries()) {
        if (!o.model) continue;
        const id = await R.createRequirement(t, project, o.model, userId, { reservedSequences: reserved });
        created.set(i, { id, display_id: (await t.get('SELECT display_id FROM requirements WHERE id = ?', [id])).display_id });
      }
    } else {
      const idx = new Map(validated.map((o, i) => [o.model?.code, i]).filter(([c]) => c !== undefined));
      const kids = new Map();   // parent index (or -1 for top level) → child indexes in file order
      validated.forEach((o, i) => {
        if (!o.model) return;
        const pi = o.model.parent_code ? idx.get(o.model.parent_code) : -1;
        if (!kids.has(pi)) kids.set(pi, []); kids.get(pi).push(i);
      });
      const ids = new Map();
      const walk = async (pi, parentId) => {
        for (const i of kids.get(pi) || []) {
          const m = validated[i].model;
          const id = await W.createWbs(t, project, { ...m, parent_id: parentId }, userId, { skipRenumber: true, skipGuard: true });   // the import validator already decided group/leaf rows
          ids.set(i, id); await walk(i, id);
        }
      };
      await walk(-1, ctx.parentId);
      await W.renumber(t, project.id);
      for (const [i, id] of ids) {
        for (const tok of validated[i].model.preds) await W.addDependency(t, project, { id }, ids.get(idx.get(tok)), userId);
        created.set(i, { id, wbs_code: (await t.get('SELECT wbs_code FROM wbs_items WHERE id = ?', [id])).wbs_code });
      }
    }
    const results = validated.map((o, i) => { const v = view(o); const c = created.get(i); return { row: o.row, ok: Boolean(c), ...(c || {}), errors: v.errors, row_errors: v.row_errors }; });
    const summary = kind === 'requirements' ? await R.requirementStats(t, project.id) : await W.wbsStats(t, project.id);
    return { total: results.length, created: created.size, failed: results.length - created.size, results, summary };
  });
}
