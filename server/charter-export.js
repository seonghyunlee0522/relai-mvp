/**
 * 사업수행계획서 (project execution plan) — the 착수 document the PM sends to the customer for approval (spec Phase 1 US-3).
 *
 * One document type only (착수보고회 is §10 of it). Built from the same Project Charter object the screen and AI read
 * (charter.js) → markdown → report-export.js PDF / Word renderers. The structure is fixed: an empty section prints
 * "작성되지 않음" instead of disappearing, so every version of the document has the same numbered sections.
 *
 * Version rule (no document versioning yet — just these three states):
 *   승인 전                 v0.9 (초안)                     footer "승인 전 초안"
 *   승인됨                  v1.0
 *   승인 후 변경 (확인 필요)  v1.0 → 변경됨 (재승인 필요)      footer "승인 후 변경된 초안"
 */
import { ORG_TYPE_LABEL } from './definition.js';
import { NONE, table, kv, textBlock, docVersion, coverLines, revisionRows, revisionTable, approvalLines } from './doc-export.js';

export const PLAN_TITLE = '사업수행계획서';
const CAT_ORDER = ['CLIENT', 'OWN', 'PARTNER', 'OTHER'];
const fmtDT = (v) => (!v ? '' : v.length > 10 ? `${v.slice(0, 10)} ${v.slice(11, 16)}` : v);

/** Version label + footer for the approval state (TODO · COMPLETED · REAPPROVAL). */
export function planVersion(approval) {
  const st = approval ? approval.status : 'TODO';
  if (st === 'REAPPROVAL') return { version: 'v1.0 → 변경됨 (재승인 필요)', file: 'v1.0_변경됨', footer: '승인 후 변경된 초안' };
  return docVersion(st);
}

/**
 * Markdown of the plan. ctx = { workspaceName, author, today (YYYY-MM-DD) }.
 * Returns { title, markdown, version, footer, fileVersion }.
 */
export function buildPlanMarkdown(c, { workspaceName = '', author = '', today }) {
  const pf = c.profile; const v = planVersion(c.approval);
  const L = [];
  const h2 = (t) => L.push('', `## ${t}`);

  /* 1. 표지 */
  L.push(...coverLines(PLAN_TITLE, pf.name, [['프로젝트명', pf.name], ['고객사', pf.client], ['수행사', workspaceName], ['버전', v.version], ['작성일', today], ['작성자', author]], v.footer));

  /* 2. 개정 이력 */
  h2('개정 이력');
  // One auto row that matches the document's state; no blank rows (no document versioning yet).
  const st = c.approval ? c.approval.status : 'TODO'; const approvedOn = (c.approval && c.approval.date) || today;
  const revs = revisionRows(st, { today, approvedOn, author });
  if (st === 'REAPPROVAL') revs.push(['v1.0 → 변경됨', today, '승인 후 변경 (재승인 필요)', author]);
  L.push(revisionTable(revs));

  /* 3. 사업 개요 */
  h2('1. 사업 개요');
  L.push(kv([['사업 목표', c.goals], ['사업 기간', pf.start_date || pf.end_date ? `${pf.start_date || '미정'} ~ ${pf.end_date || '미정'}` : ''], ['규모/금액', pf.scale], ['프로젝트 유형', pf.project_type]]));
  L.push('', '**사업 설명**', textBlock(pf.description));

  /* 4. 성공 기준 */
  h2('2. 성공 기준');
  L.push(textBlock(c.successCriteria));

  /* 5. 범위 */
  h2('3. 사업 범위');
  L.push('**수행 범위**', textBlock(c.scope.inScope), '', '**제외 범위**', textBlock(c.scope.outOfScope), '', '**주요 산출물**', textBlock(c.deliverables));

  /* 6. 전제·제약·초기 리스크 */
  h2('4. 전제·제약·초기 리스크');
  L.push('**전제(가정사항)**', textBlock(c.assumptions), '', '**제약사항**', textBlock(c.constraints), '', '**초기 리스크**', textBlock(c.risks));

  /* 7. 추진 조직 */
  h2('5. 추진 조직');
  const sh = [...(c.stakeholders || [])].sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
  L.push(sh.length ? table(['구분', '조직', '부서', '이름', '역할', '주요 책임'], sh.map((s) => [s.category_label || ORG_TYPE_LABEL[s.category] || '기타', s.org, s.department, s.name, s.role, s.responsibility])) : NONE);
  if (c.governance) L.push('', '**의사결정 / 승인 체계**', textBlock(c.governance));

  /* 8. 일정·마일스톤 */
  h2('6. 일정 및 마일스톤');
  const ms = c.timeline.milestones || [];
  L.push(`사업 기간: ${c.timeline.startDate || '미정'} ~ ${c.timeline.endDate || '미정'}`, '');
  L.push(ms.length ? table(['일자', '마일스톤', '비고'], ms.map((m) => [m.date || '날짜 미정', m.title, m.source === 'WBS' ? `WBS ${m.wbs_code}` : c.timeline.endDate && m.date && m.date > c.timeline.endDate ? '종료 후' : ''])) : NONE);

  /* 9. 운영 방식 */
  h2('7. 운영 방식');
  const om = c.operatingModel;
  L.push(kv([['회의·보고·소통', om.communication], ['의사결정', c.governance], ['변경관리', om.changeManagement], ['검수 / 완료 기준', om.acceptance]]));

  /* 10. 착수보고회 (완료된 경우 내용, 건너뛴 경우 절 생략) */
  const k = c.kickoff;
  if (!k || !k.skipped) {
    h2('8. 착수보고회');
    if (k && k.status === 'COMPLETED') {
      L.push(kv([['일시', fmtDT(k.datetime)], ['장소/방식', k.place], ['참석자', k.attendees.map((a) => `${a.name}${a.org ? `(${a.org})` : ''}`).join(', ')]]));
      L.push('', '**결정사항**', k.decisions.length ? k.decisions.map((x) => `- ${x}`).join('\n') : NONE);
      if (k.followups.length) L.push('', '**후속 조치**', '', table(['내용', '담당자', '기한', '상태'], k.followups.map((f) => [f.text, f.owner, f.due, f.done ? '완료' : '진행 중'])));
    } else L.push(k && k.datetime ? `착수보고회 예정: ${fmtDT(k.datetime)}${k.place ? ` · ${k.place}` : ''}` : '착수보고회 일정 미정');
  }

  /* 11. 승인란 */
  h2(`${!k || !k.skipped ? '9' : '8'}. 승인`);
  L.push(...approvalLines(c.approval || {}, { stakeholders: c.stakeholders || [], author }));

  return { title: `${pf.name} ${PLAN_TITLE}`, markdown: L.join('\n'), version: v.version, footer: v.footer, fileVersion: v.file };
}
