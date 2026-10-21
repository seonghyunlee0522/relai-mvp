/**
 * 요구사항 정의서 (requirements specification) — the 02 document the PM sends to the customer for review and baseline approval
 * (spec Phase 2 US-2). Built with the same document pieces as the 사업수행계획서 (doc-export.js → report-export.js PDF / Word).
 *
 * Fixed structure (an empty part prints a fixed sentence instead of disappearing):
 *   표지 → 개정 이력 → 1. 개요 (목표 1줄 · 적용 환경 · 환경·조건, batch7 #2) → 2. 범위 내 요구사항 (ID · 제목 · 유형 · 우선순위 · 담당자 · 완료 조건, 유형별)
 *   → 3. 범위 외 요구사항 (ID · 제목) → 4. 확인 (고객사 / 수행사 PM, 서명 칸 비움 + 진행 여부 체크 줄)
 * Version: 체크 전 v0.9 (초안) + footer "초안" · 체크 후 v1.0. Archived requirements are left out.
 */
import { REQ_TYPE, REQ_PRIORITY } from '../public/app/shared/constants.js';
import { REQ_TYPES } from './requirements.js';
import { table, kv, docVersion, coverLines, revisionRows, revisionTable, approvalLines } from './doc-export.js';

export const REQ_DOC_TITLE = '요구사항 정의서';
export const NO_IN_SCOPE = '등록된 범위 내 요구사항이 없습니다.';
export const NO_OUT_OF_SCOPE = '범위 외로 분류된 요구사항이 없습니다.';
const firstLine = (t) => String(t || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
const list = (t) => String(t || '').split(/\r?\n/).map((x) => x.replace(/^\s*[-•*·]\s*/, '').trim()).filter(Boolean).join(', ');

/**
 * c = Project Charter (charter.js), reqs = non-archived requirements with `criteria` [{content}], baseline = loadBaseline() model.
 * Returns { title, markdown, version, footer, fileVersion }.
 */
export function buildReqDocMarkdown(c, reqs, baseline, { workspaceName = '', author = '', today }) {
  const pf = c.profile; const v = docVersion(baseline.status);
  const live = reqs.filter((r) => !r.archived_at);
  const inScope = live.filter((r) => r.scope === 'IN_SCOPE').sort((a, b) => (REQ_TYPES.indexOf(a.type === 'UNSPECIFIED' ? 'zz' : a.type) - REQ_TYPES.indexOf(b.type === 'UNSPECIFIED' ? 'zz' : b.type)) || a.sequence_number - b.sequence_number);
  const outScope = live.filter((r) => r.scope === 'OUT_OF_SCOPE').sort((a, b) => a.sequence_number - b.sequence_number);
  const undecided = live.filter((r) => r.scope === 'UNDECIDED').length;
  const L = []; const h2 = (t) => L.push('', `## ${t}`);

  L.push(...coverLines(REQ_DOC_TITLE, pf.name, [['문서명', REQ_DOC_TITLE], ['프로젝트명', pf.name], ['고객사', pf.client], ['수행사', workspaceName], ['버전', v.version], ['작성일', today], ['작성자', author]], v.footer));

  h2('개정 이력');
  L.push(revisionTable(revisionRows(baseline.status, { today, approvedOn: baseline.approval && baseline.approval.date, author })));

  h2('1. 개요');
  // batch7 #2: 01 records 적용 환경, not features — the feature scope is §2 / §3 of this document
  const memo = [list(c.scope.inScope), list(c.scope.outOfScope) && `제외: ${list(c.scope.outOfScope)}`].filter(Boolean).join(' · ');
  L.push(kv([['프로젝트 목표', firstLine(c.goals) || firstLine(c.successCriteria)], ['적용 환경', (c.environments && c.environments.summary) || ''], ['환경·조건', memo],
    ['요구사항', `범위 내 ${inScope.length}건 · 범위 외 ${outScope.length}건`]]));
  if (undecided) L.push('', `범위가 결정되지 않은 요구사항 ${undecided}건은 이 문서에 포함되지 않습니다.`);

  h2('2. 범위 내 요구사항');
  L.push(inScope.length ? table(['ID', '제목', '유형', '우선순위', '담당자', '완료 조건'], inScope.map((r) => [r.display_id, r.title, REQ_TYPE[r.type] || r.type, REQ_PRIORITY[r.priority] || r.priority, r.owner_label || '',
    (r.criteria || []).length ? r.criteria.map((x, i) => `${i + 1}. ${x.content}`).join('\n') : ''])) : NO_IN_SCOPE);

  h2('3. 범위 외 요구사항');
  L.push(outScope.length ? table(['ID', '제목'], outScope.map((r) => [r.display_id, r.title])) : NO_OUT_OF_SCOPE);

  h2('4. 확인');
  const day = baseline.completed_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(baseline.completed_at)) : '';
  L.push(...approvalLines({ status: baseline.status, date: baseline.approval.date || day, approver: baseline.approver, checked_by_name: baseline.completed_by_name || '', checked_on: day,
    note: baseline.approval.note, conditions: baseline.approval.conditions }, { stakeholders: c.stakeholders || [], author }));

  return { title: `${pf.name} ${REQ_DOC_TITLE}`, markdown: L.join('\n'), version: v.version, footer: v.footer, fileVersion: v.file };
}
