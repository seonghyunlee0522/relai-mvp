/**
 * 사업수행계획서 (project execution plan) — the 착수 document the PM sends to the customer for approval (spec Phase 1 US-3).
 *
 * One document type only (착수보고회 is §8 of it). Built from the same Project Charter object the screen and AI read
 * (charter.js) → markdown → report-export.js PDF / Word renderers. The structure is fixed: an empty part prints a grey italic
 * 작성 가이드 sentence (what belongs there, batch7 #4) instead of disappearing, so every version has the same numbered sections
 * and a first-time PM sees what to write rather than a bare "작성되지 않음".
 * 작성 예시 보기: the same builder fed with the 다온생명 sample (samples/fixtures.js) — see examplePlan().
 *
 * Version rule (no document versioning yet — just these three states):
 *   승인 전                 v0.9 (초안)                     footer "승인 전 초안"
 *   승인됨                  v1.0
 *   승인 후 변경 (확인 필요)  v1.0 → 변경됨 (재승인 필요)      footer "승인 후 변경된 초안"
 */
import { ORG_TYPE_LABEL } from './definition.js';
import { table, textBlock, docVersion, coverLines, revisionRows, revisionTable, approvalLines } from './doc-export.js';

export const PLAN_TITLE = '사업수행계획서';
const CAT_ORDER = ['CLIENT', 'OWN', 'PARTNER', 'OTHER'];
const fmtDT = (v) => (!v ? '' : v.length > 10 ? `${v.slice(0, 10)} ${v.slice(11, 16)}` : v);

/** 작성 가이드 per part — what to write, one or two lines, in the reader's words (grey italic in the PDF / Word). */
export const PLAN_GUIDE = {
  goals: '이 사업으로 달성할 결과를 1~3문장으로 적습니다. 예: 상담 문의의 40%를 챗봇이 처리해 상담원 대기시간을 줄인다.',
  period: '계약상 착수일과 종료일을 적습니다.', scale: '계약 금액이나 투입 규모(예: 6개월, 5명)를 적습니다.', type: '신규 구축 · 고도화 · 유지보수 등 사업의 성격을 적습니다.',
  description: '사업을 하게 된 배경과 현재 문제를 2~3문장으로 적습니다.',
  success: '사업이 성공했다고 판단할 측정 가능한 기준을 적습니다. 예: 오픈 후 3개월 챗봇 자체 해결률 40% 이상.',
  environments: '결과물이 동작해야 할 기기·브라우저·OS를 적습니다. 예: PC 웹(Chrome·Edge), 모바일 웹(iOS Safari).',
  envMemo: '사내망 전용, 외부 접속 제외처럼 환경에 붙는 조건을 적습니다.',
  deliverables: '납품·제출할 산출물과 필수 여부를 적습니다. 01 착수의 산출물 목록에서 고르면 표로 채워집니다.',
  assumptions: '계획이 성립하려면 지켜져야 할 전제를 적습니다. 예: 고객사가 기간계 조회 API를 착수 후 4주 안에 제공한다.',
  constraints: '수행을 제한하는 조건을 적습니다. 예: 개인정보는 사내망 밖으로 나갈 수 없다.',
  risks: '착수 시점에 보이는 위험과 대응을 적습니다. 예: 상담 이력 데이터 품질이 낮을 수 있음 → 착수 2주 차 샘플 점검.',
  stakeholders: '고객사·수행사의 추진 조직(스폰서, PM, 실무 담당)과 역할을 적습니다.',
  milestones: '착수보고, 중간보고, 오픈, 최종 검수처럼 반드시 지킬 시점을 적습니다.',
  meetings: '정례회의 주기·참석자와 보고 방식을 적습니다. 예: 주간 정례회의 매주 월 10시, 주간보고 매주 금 메일.',
  decisions: '범위·일정 변경을 누가 어떤 절차로 결정하는지 적습니다.',
  change: '변경 요청을 접수·검토·승인하는 절차를 적습니다.',
  acceptance: '검수와 사업 완료로 보는 조건을 적습니다. 예: 인수 테스트 완료, 심각 결함 0건.',
};
const G = (k) => `⟦작성 가이드: ${PLAN_GUIDE[k]}⟧`;
/** 항목 | 내용 rows; an empty value prints its 작성 가이드. */
const kvG = (pairs) => table(['항목', '내용'], pairs.map(([k, val, g]) => [k, val || G(g)]));
const blockG = (text, g) => textBlock(text, G(g));

/** WBS 최상위 단계별 기간 (6절, only when the project has a WBS). [{ code, title, start, end, items }] in WBS order. */
export async function wbsTopLevel(db, projectId) {
  return (await db.all(`WITH RECURSIVE t AS (
      SELECT id AS root, id FROM wbs_items WHERE project_id = ? AND parent_id IS NULL AND archived_at IS NULL
      UNION ALL SELECT t.root, w.id FROM wbs_items w JOIN t ON w.parent_id = t.id WHERE w.archived_at IS NULL)
    SELECT r.wbs_code AS code, r.title, MIN(COALESCE(w.planned_start_date, w.milestone_date))::text AS start, MAX(COALESCE(w.planned_end_date, w.milestone_date))::text AS "end", (COUNT(*) - 1)::int AS items
    FROM t JOIN wbs_items w ON w.id = t.id JOIN wbs_items r ON r.id = t.root GROUP BY r.id, r.wbs_code, r.title, r.sequence ORDER BY r.sequence`, [projectId]));
}

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
export function buildPlanMarkdown(c, { workspaceName = '', author = '', today, wbsPhases = [] }) {
  const pf = c.profile; const v = planVersion(c.approval);
  const L = [];
  const h2 = (t) => L.push('', `## ${t}`);

  /* 1. 표지 */
  L.push(...coverLines(PLAN_TITLE, pf.name, [['프로젝트명', pf.name], ['고객사', pf.client], ['수행사', workspaceName], ['버전', v.version], ['작성일', today], ['작성자', author]].map(([k, x]) => [k, x || '-']), v.footer));

  /* 2. 개정 이력 */
  h2('개정 이력');
  // One auto row that matches the document's state; no blank rows (no document versioning yet).
  const st = c.approval ? c.approval.status : 'TODO'; const approvedOn = (c.approval && c.approval.date) || today;
  const revs = revisionRows(st, { today, approvedOn, author });
  if (st === 'REAPPROVAL') revs.push(['v1.0 → 변경됨', today, '승인 후 변경 (재승인 필요)', author]);
  L.push(revisionTable(revs));

  /* 3. 사업 개요 */
  h2('1. 사업 개요');
  L.push(kvG([['사업 목표', c.goals, 'goals'], ['사업 기간', pf.start_date || pf.end_date ? `${pf.start_date || '미정'} ~ ${pf.end_date || '미정'}` : '', 'period'], ['규모/금액', pf.scale, 'scale'], ['프로젝트 유형', pf.project_type, 'type']]));
  L.push('', '**사업 설명**', blockG(pf.description, 'description'));

  /* 4. 성공 기준 */
  h2('2. 성공 기준');
  L.push(blockG(c.successCriteria, 'success'));

  /* 5. 범위 */
  h2('3. 사업 범위');
  // batch7 #2: 01 records 적용 환경 (기능 범위는 요구사항 정의서의 범위 내/외 요구사항)
  const env = c.environments || {}; const envRows = env.rows || [];
  L.push('**적용 환경**', envRows.length ? table(['구분', '지원', '미지원'], envRows) : G('environments'));
  const memo = [c.scope.inScope, c.scope.outOfScope && textBlock(c.scope.outOfScope).split('\n').map((x) => `제외: ${x.replace(/^- /, '')}`).join('\n')].filter(Boolean).join('\n');
  L.push('', '**환경·조건**', blockG(memo, 'envMemo'));
  L.push('', '기능 범위는 요구사항 정의서의 범위 내 요구사항으로 정합니다.');
  // batch7 #3: 산출물 목록 표 (단계 · 산출물 · 구분); before any choice, the free text written earlier
  const dl = c.deliverableList || [];
  L.push('', '**산출물 목록**', dl.length ? table(['단계', '산출물', '구분'], dl.map((x) => [x.phase, x.name, x.level_label])) : blockG(c.deliverables, 'deliverables'));

  /* 6. 전제·제약·초기 리스크 */
  h2('4. 전제·제약·초기 리스크');
  L.push('**전제(가정사항)**', blockG(c.assumptions, 'assumptions'), '', '**제약사항**', blockG(c.constraints, 'constraints'), '', '**초기 리스크**', blockG(c.risks, 'risks'));

  /* 7. 추진 조직 */
  h2('5. 추진 조직');
  const sh = [...(c.stakeholders || [])].sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
  L.push(sh.length ? table(['구분', '조직', '부서', '이름', '역할', '주요 책임'], sh.map((s) => [s.category_label || ORG_TYPE_LABEL[s.category] || '기타', s.org, s.department, s.name, s.role, s.responsibility])) : G('stakeholders'));
  if (c.governance) L.push('', '**의사결정 / 승인 체계**', textBlock(c.governance));

  /* 8. 일정·마일스톤 */
  h2('6. 사업 기간 및 마일스톤');
  const ms = c.timeline.milestones || [];
  L.push(`사업 기간: ${c.timeline.startDate || '미정'} ~ ${c.timeline.endDate || '미정'}`, '');
  L.push(ms.length ? table(['일자', '마일스톤', '비고'], ms.map((m) => [m.date || '날짜 미정', m.title, m.source === 'WBS' ? `WBS ${m.wbs_code}` : c.timeline.endDate && m.date && m.date > c.timeline.endDate ? '종료 후' : ''])) : G('milestones'));
  // batch7 #4: WBS 최상위 단계별 기간 — only once the project has a WBS (근무일 column: T3 workdays.js)
  if (wbsPhases.length) L.push('', '**단계별 일정 (WBS)**', '', table(['WBS', '단계', '기간', '작업 수'], wbsPhases.map((w) => [w.code, w.title, w.start || w.end ? `${w.start || '미정'} ~ ${w.end || '미정'}` : '일정 미정', `${w.items}건`])));

  /* 9. 운영 방식 */
  h2('7. 운영 방식');
  const om = c.operatingModel;
  // batch7 #4: 보고·회의 체계 표
  L.push('**보고·회의 체계**', '', table(['구분', '방식'], [['회의·보고·소통', om.communication || G('meetings')], ['의사결정', c.governance || G('decisions')], ['변경관리', om.changeManagement || G('change')], ['검수 / 완료 기준', om.acceptance || G('acceptance')]]));

  /* 10. 착수보고회 (완료된 경우 내용, 건너뛴 경우 절 생략) */
  const k = c.kickoff;
  if (!k || !k.skipped) {
    h2('8. 착수보고회');
    if (k && k.status === 'COMPLETED') {
      L.push(table(['항목', '내용'], [['일시', fmtDT(k.datetime) || '-'], ['장소/방식', k.place || '-'], ['참석자', k.attendees.map((a) => `${a.name}${a.org ? `(${a.org})` : ''}`).join(', ') || '-']]));
      L.push('', '**결정사항**', k.decisions.length ? k.decisions.map((x) => `- ${x}`).join('\n') : '⟦작성 가이드: 착수보고회에서 합의한 사항을 적습니다.⟧');
      if (k.followups.length) L.push('', '**후속 조치**', '', table(['내용', '담당자', '기한', '상태'], k.followups.map((f) => [f.text, f.owner, f.due, f.done ? '완료' : '진행 중'])));
    } else L.push(k && k.datetime ? `착수보고회 예정: ${fmtDT(k.datetime)}${k.place ? ` · ${k.place}` : ''}` : '착수보고회 일정 미정');
  }

  /* 11. 승인란 */
  h2(`${!k || !k.skipped ? '9' : '8'}. 승인`);
  L.push(...approvalLines(c.approval || {}, { stakeholders: c.stakeholders || [], author }));

  return { title: `${pf.name} ${PLAN_TITLE}`, markdown: L.join('\n'), version: v.version, footer: v.footer, fileVersion: v.file };
}

/* ---------- 작성 예시 보기 (batch7 #4) ---------- */
/**
 * A finished 사업수행계획서 built from the 다온생명 sample (samples/fixtures.js case A) — every section filled, so a first-time PM
 * sees what each part should read like. Nothing is stored: the fixture's 01 events are folded into the same charter shape
 * buildProjectCharter returns, with '@±n' dates resolved against today, then fed to buildPlanMarkdown. `catalog` = the active
 * 산출물 목록 rows (deliverables.listCatalog) so the 산출물 표 matches what the operator maintains.
 */
export async function examplePlan({ today, catalog = [] }) {
  const { SAMPLE_CASES } = await import('./samples/fixtures.js');
  const { envSummary, envLines } = await import('./definition.js');
  const { PHASE_NAME, LEVEL_LABEL } = await import('./deliverables.js');
  const A = SAMPLE_CASES[0];
  const day = (v) => { const m = /^@([+-]\d+)(T.*)?$/.exec(String(v || '')); if (!m) return v; const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(m[1])); return d.toISOString().slice(0, 10) + (m[2] || ''); };
  const deep = (x) => (Array.isArray(x) ? x.map(deep) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)])) : day(x));
  const d = {}; let picks = [];
  for (const e of A.events) {
    if (e.op === 'def' || (e.op === 'section' && e.body)) Object.assign(d, deep(e.body));
    if (e.op === 'deliverables') picks = e.items;
  }
  const t = (l) => (l || []).map((x) => x.text).filter(Boolean).join('\n');
  const sh = (d.stakeholders || []).map((s) => ({ name: s.name, org: s.org || '', department: s.department || '', category: s.org_type, category_label: ORG_TYPE_LABEL[s.org_type], role: s.role || '', responsibility: s.area || '' }));
  const byId = new Map((d.stakeholders || []).map((s) => [s.id, s]));
  const pick = new Map(picks.map((x) => [x.code, x.level]));
  const deliverableList = catalog.map((c) => ({ ...c, level: pick.get(c.code) || c.default_level })).filter((c) => c.level !== 'EXCLUDED')
    .map((c) => ({ phase: PHASE_NAME[c.phase_key] || c.phase_key, phase_key: c.phase_key, name: c.name, level: c.level, level_label: LEVEL_LABEL[c.level] }));
  const env = d.environments || {}; const k = d.kickoff || {}; const a = d.approval || {}; const sp = byId.get(a.approver_id);
  const pr = deep(A.project);
  const c = {
    profile: { name: pr.name, description: pr.description, client: pr.client_name, scale: pr.project_scale, start_date: pr.planned_start_date, end_date: pr.planned_end_date, project_type: '신규 구축' },
    goals: d.goal || '', successCriteria: t(d.success_criteria), scope: { inScope: t(d.scope_in), outOfScope: t(d.scope_out) },
    environments: { summary: envSummary(env), rows: envLines(env), supported: [], unsupported: [] },
    deliverables: '', deliverableList, stakeholders: sh, governance: (d.operations || {}).decisions || '',
    timeline: { startDate: pr.planned_start_date, endDate: pr.planned_end_date, milestones: (d.key_dates || []).map((x) => ({ title: x.title, date: x.date, source: 'KEY_DATE' })) },
    assumptions: d.assumptions || '', constraints: d.constraints || '', risks: d.initial_risks || '',
    operatingModel: { communication: ['meetings', 'reporting', 'communication'].map((x) => (d.operations || {})[x]).filter(Boolean).join('\n'), changeManagement: d.change_management || '', acceptance: d.acceptance || '' },
    kickoff: { status: 'COMPLETED', skipped: false, datetime: k.datetime || '', place: k.place || '', attendees: (k.attendees || []).map((id) => byId.get(id)).filter(Boolean).map((x) => ({ name: x.name, org: x.org || '', role: x.role || '' })),
      minutes: k.minutes || '', decisions: (k.decisions || []).map((x) => x.text), followups: (k.followups || []).map((x) => ({ text: x.text, owner: x.owner || '', due: x.due || '', done: Boolean(x.done) })) },
    approval: { status: 'COMPLETED', approver: sp ? { name: sp.name, title: sp.role || '' } : null, date: a.date || '', method_label: '서명본 수령', evidence: a.evidence || '', conditions: '', bypass: null },
  };
  const doc = buildPlanMarkdown(c, { workspaceName: '(예시) 수행사', author: '홍길동 PM', today });
  return { ...doc, title: `[작성 예시] ${doc.title}` };
}
