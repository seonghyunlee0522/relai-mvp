/**
 * Weekly report download: PDF (pdfkit + embedded Nanum Gothic, so Hangul renders on any viewer) and Word (.docx, docx).
 * Both are pure JS and run inside the Vercel function. The source is the report's rendered markdown (reports.renderMarkdown),
 * which only uses a small subset: `#`/`##` headings, `- ` bullets (two-space indent = nested), whole-line `**bold**`, plain lines.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const fontDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fonts');
let fonts;   // read once per warm instance
const loadFonts = () => (fonts ||= { regular: readFileSync(resolve(fontDir, 'NanumGothic-Regular.ttf')), bold: readFileSync(resolve(fontDir, 'NanumGothic-Bold.ttf')) });

/** Markdown subset → blocks: { type: 'h1'|'h2'|'bullet'|'para'|'blank', level, runs: [{ text, bold }] }. */
export function parseReportMarkdown(markdown) {
  const runs = (s) => {
    const out = []; const re = /\*\*(.+?)\*\*/g; let last = 0; let m;
    while ((m = re.exec(s))) { if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false }); out.push({ text: m[1], bold: true }); last = re.lastIndex; }
    if (last < s.length) out.push({ text: s.slice(last), bold: false });
    return out.length ? out : [{ text: '', bold: false }];
  };
  return String(markdown || '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    if (!line.trim()) return { type: 'blank', level: 0, runs: [] };
    let m;
    if ((m = /^#\s+(.*)$/.exec(line))) return { type: 'h1', level: 0, runs: runs(m[1]) };
    if ((m = /^#{2,6}\s+(.*)$/.exec(line))) return { type: 'h2', level: 0, runs: runs(m[1]) };
    if ((m = /^(\s*)[-*•]\s+(.*)$/.exec(line))) return { type: 'bullet', level: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), runs: runs(m[2]) };
    return { type: 'para', level: 0, runs: runs(line.trim()) };
  });
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
  for (const b of parseReportMarkdown(report.rendered_content)) {
    if (b.type === 'blank') { doc.moveDown(0.35); continue; }
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
  for (const b of parseReportMarkdown(report.rendered_content)) {
    if (b.type === 'blank') continue;
    if (b.type === 'h1') children.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 160 }, children: runsOf(b.runs, { size: 32, bold: true }) }));
    else if (b.type === 'h2') children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 }, border: { bottom: { style: 'single', size: 4, color: 'D0D5DD', space: 2 } }, children: runsOf(b.runs, { size: 24, bold: true }) }));
    else if (b.type === 'bullet') children.push(new Paragraph({ bullet: { level: b.level }, spacing: { after: 40 }, children: runsOf(b.runs) }));
    else children.push(new Paragraph({ spacing: { after: 80 }, children: runsOf(b.runs) }));
  }
  const doc = new Document({ creator: 'RELAI', title: report.title, styles: { default: { document: { run: { font: FONT, size: 20 } } } }, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }] });
  return Packer.toBuffer(doc);
}
