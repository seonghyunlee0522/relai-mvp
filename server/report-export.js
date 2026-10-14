/**
 * Document download: PDF (pdfkit + embedded Nanum Gothic, so Hangul renders on any viewer) and Word (.docx, docx).
 * Both are pure JS and run inside the Vercel function. Used by the weekly report (reports.renderMarkdown) and the
 * 사업수행계획서 (charter-export.js). The source is markdown in a small subset: `#`/`##` headings, `- ` bullets (two-space
 * indent = nested), `**bold**` runs, plain lines, pipe tables (`| a | b |`, optional `|---|` row after the header) and a
 * `<!-- pagebreak -->` line. Tables render as a plain grid (header bold, equal column widths); a row never splits across pages.
 * `report.footer` (optional) is printed on every page next to the page number.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, PageBreak, Footer, AlignmentType, ShadingType } from 'docx';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const fontDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fonts');
let fonts;   // read once per warm instance
const loadFonts = () => (fonts ||= { regular: readFileSync(resolve(fontDir, 'NanumGothic-Regular.ttf')), bold: readFileSync(resolve(fontDir, 'NanumGothic-Bold.ttf')) });

const PAGEBREAK = /^<!--\s*pagebreak\s*-->$/i;
const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSepRow = (cells) => cells.length && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
/** "| a | b\|c |" → ['a', 'b|c'] ; `<br>` inside a cell is a line break. */
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n').trim());

/** Markdown subset → blocks: { type: 'h1'|'h2'|'bullet'|'para'|'blank'|'pagebreak'|'table', level, runs: [{ text, bold }], header?, rows? }. */
export function parseReportMarkdown(markdown) {
  const runs = (s) => {
    const out = []; const re = /\*\*(.+?)\*\*/g; let last = 0; let m;
    while ((m = re.exec(s))) { if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false }); out.push({ text: m[1], bold: true }); last = re.lastIndex; }
    if (last < s.length) out.push({ text: s.slice(last), bold: false });
    return out.length ? out : [{ text: '', bold: false }];
  };
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i])) {   // consecutive pipe lines = one table; a |---| row right after the first row makes it the header
      const rows = []; while (i < lines.length && isTableLine(lines[i])) rows.push(splitRow(lines[i++])); i--;
      const hasHeader = rows.length > 1 && isSepRow(rows[1]);
      const body = rows.filter((r, j) => !(hasHeader && j === 1));
      const cols = Math.max(...body.map((r) => r.length));
      const pad = (r) => [...r, ...Array(cols - r.length).fill('')];
      out.push({ type: 'table', level: 0, runs: [], header: hasHeader ? pad(body[0]) : null, rows: (hasHeader ? body.slice(1) : body).map(pad) });
      continue;
    }
    out.push(lineBlock(lines[i]));
  }
  return out;
  function lineBlock(line) {
    if (!line.trim()) return { type: 'blank', level: 0, runs: [] };
    if (PAGEBREAK.test(line.trim())) return { type: 'pagebreak', level: 0, runs: [] };
    let m;
    if ((m = /^#\s+(.*)$/.exec(line))) return { type: 'h1', level: 0, runs: runs(m[1]) };
    if ((m = /^#{2,6}\s+(.*)$/.exec(line))) return { type: 'h2', level: 0, runs: runs(m[1]) };
    if ((m = /^(\s*)[-*•]\s+(.*)$/.exec(line))) return { type: 'bullet', level: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), runs: runs(m[2]) };
    return { type: 'para', level: 0, runs: runs(line.trim()) };
  }
}

/** A4 PDF. Returns a Buffer. */
export function renderReportPdf(report) {
  const f = loadFonts();
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: report.title, Creator: 'RELAI' }, bufferPages: true });
  doc.registerFont('KR', f.regular); doc.registerFont('KR-Bold', f.bold);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const write = (runs, { size, x = doc.page.margins.left, w = width, gap = 2, forceBold = false }) => {
    runs.forEach((r, i) => doc.font(forceBold || r.bold ? 'KR-Bold' : 'KR').fontSize(size).fillColor('#111827')
      .text(r.text, i === 0 ? x : undefined, undefined, { width: w, continued: i < runs.length - 1, lineGap: gap }));
  };
  const bottomY = () => doc.page.height - doc.page.margins.bottom;
  /** Plain grid: equal columns, bold shaded header; a row that does not fit moves whole to the next page (never split). */
  const table = (b) => {
    const rows = [...(b.header ? [{ cells: b.header, head: true }] : []), ...b.rows.map((cells) => ({ cells, head: false }))];
    if (!rows.length) return;
    const cols = rows[0].cells.length; const cw = width / cols; const pad = 4; const size = 9; const x0 = doc.page.margins.left;
    doc.moveDown(0.2);
    for (const r of rows) {
      const hOf = (t) => doc.font(r.head ? 'KR-Bold' : 'KR').fontSize(size).heightOfString(t || ' ', { width: cw - pad * 2, lineGap: 1 });
      const h = Math.max(...r.cells.map(hOf)) + pad * 2;
      if (doc.y + h > bottomY()) doc.addPage();
      const y = doc.y;
      r.cells.forEach((t, j) => {
        const x = x0 + j * cw;
        if (r.head) doc.rect(x, y, cw, h).fillColor('#F2F4F7').fill();
        doc.rect(x, y, cw, h).lineWidth(0.6).strokeColor('#98A2B3').stroke();
        doc.font(r.head ? 'KR-Bold' : 'KR').fontSize(size).fillColor('#111827').text(t || '', x + pad, y + pad, { width: cw - pad * 2, lineGap: 1 });
      });
      doc.x = x0; doc.y = y + h;
    }
    doc.moveDown(0.5);
  };
  for (const b of parseReportMarkdown(report.rendered_content)) {
    if (b.type === 'blank') { doc.moveDown(0.35); continue; }
    if (b.type === 'pagebreak') { doc.addPage(); continue; }
    if (b.type === 'table') { table(b); continue; }
    if (b.type === 'h1') { write(b.runs, { size: 17, forceBold: true }); doc.moveDown(0.3); continue; }
    if (b.type === 'h2') {
      doc.moveDown(0.4); write(b.runs, { size: 12.5, forceBold: true });
      const y = doc.y + 2; doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + width, y).lineWidth(0.6).strokeColor('#D0D5DD').stroke(); doc.y = y + 4;
      continue;
    }
    if (b.type === 'bullet') {
      const indent = 12 + b.level * 14; const x = doc.page.margins.left + indent;
      if (doc.y + 16 > doc.page.height - doc.page.margins.bottom) doc.addPage();   // keep the marker on the same page as its text
      const y = doc.y;
      doc.font('KR').fontSize(10).fillColor('#374151').text(b.level ? '–' : '•', x - 10, y, { lineBreak: false });
      doc.y = y; write(b.runs, { size: 10, x, w: width - indent });
      continue;
    }
    write(b.runs, { size: 10 });
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('KR').fontSize(8).fillColor('#6B7280').text(`${i + 1} / ${range.count}`, doc.page.margins.left, doc.page.height - 36, { width, align: 'center', lineBreak: false });
    if (report.footer) doc.font('KR').fontSize(8).fillColor('#B42318').text(report.footer, doc.page.margins.left, doc.page.height - 36, { width, align: 'left', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

/** Word document (fonts: Malgun Gothic for East Asian text, which Word on Windows/Mac substitutes cleanly). Returns a Buffer. */
export async function renderReportDocx(report) {
  const FONT = { ascii: 'Malgun Gothic', eastAsia: 'Malgun Gothic', hAnsi: 'Malgun Gothic', cs: 'Malgun Gothic' };
  const runsOf = (runs, { size = 20, bold = false } = {}) => runs.map((r) => new TextRun({ text: r.text, bold: bold || r.bold, size, font: FONT }));
  const children = [];
  const cell = (t, head, pct) => new TableCell({ width: { size: pct, type: WidthType.PERCENTAGE }, shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F4F7' } : undefined,
    children: String(t || '').split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: head, size: 18, font: FONT })] })) });
  for (const b of parseReportMarkdown(report.rendered_content)) {
    if (b.type === 'blank') continue;
    if (b.type === 'pagebreak') { children.push(new Paragraph({ children: [new PageBreak()] })); continue; }
    if (b.type === 'table') {
      const cols = (b.header || b.rows[0] || []).length; if (!cols) continue; const pct = Math.floor(100 / cols);
      const rows = [...(b.header ? [new TableRow({ tableHeader: true, cantSplit: true, children: b.header.map((t) => cell(t, true, pct)) })] : []),
        ...b.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((t) => cell(t, false, pct)) }))];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }), new Paragraph({ spacing: { after: 80 }, children: [] }));
      continue;
    }
    if (b.type === 'h1') children.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 160 }, children: runsOf(b.runs, { size: 32, bold: true }) }));
    else if (b.type === 'h2') children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 }, border: { bottom: { style: 'single', size: 4, color: 'D0D5DD', space: 2 } }, children: runsOf(b.runs, { size: 24, bold: true }) }));
    else if (b.type === 'bullet') children.push(new Paragraph({ bullet: { level: b.level }, spacing: { after: 40 }, children: runsOf(b.runs) }));
    else children.push(new Paragraph({ spacing: { after: 80 }, children: runsOf(b.runs) }));
  }
  const doc = new Document({ creator: 'RELAI', title: report.title, styles: { default: { document: { run: { font: FONT, size: 20 } } } }, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    ...(report.footer ? { footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: report.footer, size: 16, color: 'B42318', font: FONT })] })] }) } } : {}), children }] });
  return Packer.toBuffer(doc);
}
