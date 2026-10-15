/** Minimal Atlassian Document Format builders — paragraph / bullet list / link / text — enough for the issue description we create. */
const text = (s, marks) => ({ type: 'text', text: String(s), ...(marks ? { marks } : {}) });
export const paragraph = (...inline) => ({ type: 'paragraph', content: inline.flat().filter(Boolean) });
export const strong = (s) => text(s, [{ type: 'strong' }]);
export const link = (s, href) => text(s, [{ type: 'link', attrs: { href } }]);
export const bulletList = (items) => ({ type: 'bulletList', content: items.map((it) => ({ type: 'listItem', content: [Array.isArray(it) ? paragraph(...it) : typeof it === 'string' ? paragraph(text(it)) : it] })) });
export const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks.flat().filter(Boolean) });
export const plain = (s) => text(s);

/** Multi-line plain text → paragraphs (blank-line separated). */
export const textBlocks = (s) => String(s || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => paragraph(text(p.replace(/\s*\n\s*/g, ' '))));

/** Description for an issue created from a WBS item. `reqs` = [{ display_id, title }], `projectUrl` is the RELAI link. */
export function wbsDescription({ wbsCode, title, description, reqs = [], projectUrl, projectName }) {
  const blocks = [paragraph(strong('RELAI WBS'), text(` ${wbsCode} ${title}`))];
  if (description) blocks.push(...textBlocks(description));
  if (reqs.length) { blocks.push(paragraph(strong('관련 요구사항'))); blocks.push(bulletList(reqs.map((r) => `${r.display_id} ${r.title}`))); }
  if (projectUrl) blocks.push(paragraph(text('RELAI 프로젝트: '), link(projectName || projectUrl, projectUrl)));
  return doc(...blocks);
}

/** Description for an issue created from a requirement: 설명 + 완료 조건 + the RELAI link back. */
export function requirementDescription({ displayId, title, description, criteria = [], reqUrl, projectName }) {
  const blocks = [paragraph(strong('RELAI 요구사항'), text(` ${displayId} ${title}`))];
  if (description) blocks.push(...textBlocks(description));
  if (criteria.length) { blocks.push(paragraph(strong('완료 조건'))); blocks.push(bulletList(criteria)); }
  if (reqUrl) blocks.push(paragraph(text('RELAI에서 보기: '), link(projectName ? `${projectName} · ${displayId}` : displayId, reqUrl)));
  return doc(...blocks);
}
