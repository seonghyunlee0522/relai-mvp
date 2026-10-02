/**
 * Excel I/O for the requirement / WBS import flow (exceljs): template, export, error report and file parsing.
 * Pure file work — validation lives in importer.js.
 */
import ExcelJS from 'exceljs';
import { KINDS, normHeader } from './importspec.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
const VALIDATION_LAST_ROW = 1001;

export class ImportFileError extends Error {
  constructor(status, message, code = 'invalid_file') { super(message); this.status = status; this.code = code; }
}

/* ---------- styling ---------- */
const FONT = { name: 'Malgun Gothic', size: 10 };
const THIN = { style: 'thin', color: { argb: 'FFD0D5DD' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_REQUIRED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
const HEADER_OPTIONAL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };

function styleHeader(cell, required) {
  cell.font = { ...FONT, bold: true, color: { argb: required ? 'FFFFFFFF' : 'FF111827' } };
  cell.fill = required ? HEADER_REQUIRED : HEADER_OPTIONAL;
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = BORDER;
}

const TEXT_FMT = '@';
const DATE_FMT = 'yyyy-mm-dd';
const utcDate = (s) => new Date(`${s}T00:00:00Z`);
const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Data sheet: header row 1 (required headers blue), frozen, dropdowns on enum columns for rows 2..1001. */
function buildDataSheet(wb, spec, rows, lastRow = VALIDATION_LAST_ROW) {
  const ws = wb.addWorksheet(spec.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = spec.columns.map((c) => ({ key: c.key, width: c.width }));
  ws.getRow(1).height = 24;
  spec.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.font = FONT;
    col.alignment = { vertical: 'top', wrapText: c.type === 'multiline' };
    if (['text', 'owner'].includes(c.type)) col.numFmt = TEXT_FMT;
    if (c.type === 'date') col.numFmt = DATE_FMT;
    styleHeader(ws.getCell(1, i + 1), c.required);
    ws.getCell(1, i + 1).value = c.label;
    const letter = ws.getColumn(i + 1).letter;
    if (c.type === 'enum') ws.dataValidations.add(`${letter}2:${letter}${lastRow}`, { type: 'list', allowBlank: true, showErrorMessage: true, errorStyle: 'warning', errorTitle: '목록 값 확인', error: `목록에서 값을 선택해 주세요. (${c.label})`, formulae: [`"${c.options.map((o) => o.label).join(',')}"`] });
    if (c.type === 'number') ws.dataValidations.add(`${letter}2:${letter}${lastRow}`, { type: 'whole', operator: 'between', allowBlank: true, showErrorMessage: true, errorStyle: 'warning', errorTitle: '숫자 확인', error: '0~100 사이의 정수를 입력해 주세요.', formulae: [0, 100] });
  });
  rows.forEach((r, ri) => {
    const row = ws.getRow(ri + 2);
    spec.columns.forEach((c, ci) => {
      let v = r[c.key];
      if (v === undefined || v === null || v === '') return;
      if (c.type === 'date' && isIsoDate(v)) v = utcDate(v);
      row.getCell(ci + 1).value = v;
    });
  });
  return ws;
}

/** Second sheet: how to fill in the first one. */
function buildGuideSheet(wb, spec) {
  const ws = wb.addWorksheet('작성 안내');
  ws.columns = [{ width: 18 }, { width: 10 }, { width: 70 }, { width: 38 }];
  const intro = [
    `${spec.sheet} 등록 템플릿 작성 안내`,
    `1. 첫 번째 시트(${spec.sheet})의 1행은 헤더입니다. 헤더 이름과 순서를 바꾸지 마세요. 파란색 헤더는 필수 항목입니다.`,
    '2. 2행부터 데이터를 입력합니다. 예시 행은 넣지 말고, 빈 행은 자동으로 건너뜁니다.',
    '3. 한 번에 최대 2,000행, 5MB 이하 파일만 가져올 수 있습니다.',
    '4. 가져오기 전에 미리보기 화면에서 오류를 확인하고 수정할 수 있습니다. 오류가 있는 행은 건너뛰고 나머지만 등록할 수 있습니다.',
  ];
  intro.forEach((t, i) => { const c = ws.getCell(i + 1, 1); c.value = t; c.font = { ...FONT, bold: i === 0, size: i === 0 ? 13 : 10 }; });
  const head = 7;
  ['열 이름', '필수 여부', '입력 방법 / 허용 값', '예시'].forEach((t, i) => { const c = ws.getCell(head, i + 1); c.value = t; styleHeader(c, true); });
  spec.columns.forEach((c, i) => {
    const r = head + 1 + i;
    const allowed = c.options ? `${c.hint}\n허용 값: ${c.options.map((o) => o.label).join(' / ')}` : c.hint;
    [c.label, c.required ? '필수' : '선택', allowed, c.examples.join('\n')].forEach((t, j) => {
      const cell = ws.getCell(r, j + 1);
      cell.value = t; cell.font = { ...FONT, bold: j === 0 }; cell.border = BORDER; cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
  return ws;
}

const toBuffer = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());
const newBook = () => { const wb = new ExcelJS.Workbook(); wb.creator = 'RELAI'; wb.created = new Date(); return wb; };

export async function buildTemplate(kind) {
  const spec = KINDS[kind]; const wb = newBook();
  buildDataSheet(wb, spec, []); buildGuideSheet(wb, spec);
  return toBuffer(wb);
}

/** rows: array of { <columnKey>: value } (dates as YYYY-MM-DD strings, progress as number). */
export async function buildExport(kind, rows) {
  const spec = KINDS[kind]; const wb = newBook();
  buildDataSheet(wb, spec, rows, Math.max(VALIDATION_LAST_ROW, rows.length + 1)); buildGuideSheet(wb, spec);
  return toBuffer(wb);
}

/** Failed rows in template column order, with a leading `원본 행` and a trailing `오류 사유` column. */
export async function buildErrorReport(kind, failed) {
  const spec = KINDS[kind]; const wb = newBook();
  const ws = wb.addWorksheet('가져오기 오류', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [{ label: '원본 행', width: 10 }, ...spec.columns.map((c) => ({ label: c.label, width: c.width, multiline: c.type === 'multiline', key: c.key })), { label: '오류 사유', width: 60 }];
  ws.columns = cols.map((c) => ({ width: c.width }));
  cols.forEach((c, i) => { const cell = ws.getCell(1, i + 1); cell.value = c.label; styleHeader(cell, false); });
  ws.getCell(1, cols.length).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
  const labelOf = Object.fromEntries(spec.columns.map((c) => [c.key, c.label]));
  failed.forEach((f, ri) => {
    const row = ws.getRow(ri + 2);
    const reasons = [...Object.entries(f.errors || {}).map(([k, m]) => `${labelOf[k] || k}: ${m}`), ...(f.row_errors || [])];
    const cells = [f.row ?? '', ...spec.columns.map((c) => f.values?.[c.key] ?? ''), reasons.join('\n')];
    cells.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v === '' ? null : v;
      cell.font = FONT; cell.alignment = { vertical: 'top', wrapText: true }; cell.border = BORDER;
      if (ci === cells.length - 1) cell.font = { ...FONT, color: { argb: 'FFB91C1C' } };
    });
  });
  return toBuffer(wb);
}

/* ---------- parsing ---------- */
export const isoDateUtc = (d) => `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

function cellText(v, type) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoDateUtc(v);
  if (typeof v === 'number') {
    // A bare Excel serial in a date column (cell not formatted as a date).
    if (type === 'date' && Number.isFinite(v) && v >= 20000 && v <= 80000) return isoDateUtc(new Date(Math.round((v - 25569) * 86400e3)));
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result, type);
    if (v.text !== undefined) return cellText(v.text, type);
    if (v.error) return String(v.error);
    return '';
  }
  return String(v);
}
const clean = (s) => s.replace(/\r\n?/g, '\n').trim();

/**
 * Parses the data sheet. Returns { rows: [{ row, values }], warnings }.
 * Throws ImportFileError: unreadable file / missing required header / too many rows.
 */
export async function parseWorkbook(kind, buffer) {
  const spec = KINDS[kind];
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new ImportFileError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.'); }
  const ws = wb.getWorksheet(spec.sheet) || wb.worksheets[0];
  if (!ws) throw new ImportFileError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');

  const byNorm = new Map(spec.columns.map((c) => [normHeader(c.label), c]));
  const colOf = new Map(); const warnings = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, n) => {
    const text = clean(cellText(cell.value));
    if (!text) return;
    const c = byNorm.get(normHeader(text));
    if (!c) { warnings.push(`알 수 없는 열 '${text}'은(는) 무시했습니다.`); return; }
    if (colOf.has(c.key)) { warnings.push(`열 '${text}'이(가) 중복되어 첫 번째 열만 사용했습니다.`); return; }
    colOf.set(c.key, n);
  });
  const missing = spec.columns.filter((c) => c.required && !colOf.has(c.key)).map((c) => c.label);
  if (missing.length) throw new ImportFileError(400, `필수 열이 없습니다: ${missing.join(', ')}. 템플릿의 1행 헤더를 확인해 주세요.`, 'missing_columns');

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {}; let any = false;
    for (const c of spec.columns) {
      const n = colOf.get(c.key);
      const t = n ? clean(cellText(row.getCell(n).value, c.type)) : '';
      values[c.key] = t; if (t) any = true;
    }
    if (!any) return;
    if (rows.length >= MAX_IMPORT_ROWS) throw new ImportFileError(400, `한 번에 최대 ${MAX_IMPORT_ROWS.toLocaleString('en-US')}행까지 가져올 수 있습니다.`, 'too_many_rows');
    rows.push({ row: rowNumber, values });
  });
  return { rows, warnings };
}

/** base64 (optionally a data: URL) → Buffer. Size and shape are checked before any decoding work. */
export function decodeBase64Xlsx(data) {
  if (typeof data !== 'string' || !data) throw new ImportFileError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  const b64 = data.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (b64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new ImportFileError(413, '파일 크기는 5MB 이하여야 합니다.', 'file_too_large');
  if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new ImportFileError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw new ImportFileError(413, '파일 크기는 5MB 이하여야 합니다.', 'file_too_large');
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new ImportFileError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');  // xlsx is a zip ("PK")
  return buf;
}
