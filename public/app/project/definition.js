/* 01 착수 — Main Process View + Work Screen (Lifecycle V2 UX).
 *
 *   Main Process View (this page)      Process guidance + read view: phase purpose, the one thing to do now, every
 *                                       activity with its state and a one-line summary of what has been entered.
 *   Work Screen (right drawer)         The actual input form for one activity. Opens from a row, can expand to full
 *                                       screen and back without losing typed values (same DOM, same working copy).
 *   Footer actions                     [임시저장] saves only · [완료 처리] saves + validates + COMPLETED in one click ·
 *                                       ↷ 이 업무 건너뛰기 (non-REQUIRED only, with confirmation) · 업무 다시 시작 → on a skipped one.
 *
 * No nested drawers: Excel upload for 이해관계자 is a modal on top of the drawer. Completion is the INITIATION step status
 * (server/definition.js), so What's Next, the LNB badge and the phase gate all read the same source. */
import { api, wsApi } from '../core/api.js';
import { isPhone, pcLine } from '../core/device.js';
import { $, no2, fmtShort, html, raw } from '../core/dom.js';
import { download, fileToBase64 } from '../core/ui.js';
import { projectHead, moveToPhase } from './guide.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { ACTIVITY_STATE } from '../shared/constants.js';
import { TRAIT_FIELDS } from '../shared/project-traits.js';
import { traitFields, traitGrid, wireTraitFields } from '../shared/trait-fields.js';
import { josa } from '../shared/josa.js';
import { planMenu, bindPlanMenu, term, isMeasurable, noApprovalLine } from './initiation.js';
import { approvalFields, collectApproval, approvalBody, approvalErrors, approvalStatusText, showApprovalErrors } from '../shared/approval.js';

const ORG_TYPE = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
const OPS = [['meetings', '회의', '예: 주간 정례회의 매주 월 10시(고객·PM·개발 리드), 착수보고/중간보고/최종보고'], ['reporting', '보고', '예: 주간보고 매주 금 메일 발송, 월간 운영위원회 보고'], ['communication', '소통 채널', '예: Slack #pjt-채널, 공식 요청은 메일, 긴급은 전화'], ['decisions', '의사결정 / 승인 체계', '예: 주요 범위 변경은 고객사 PM과 수행사 PM 합의 후 운영위원회 승인']];
/** Project Charter free-text fields (Label · 짧은 설명 · Textarea). Free text on purpose — structure comes later in a separate design.
 * [field, label, hint, placeholder, rows] grouped by the activity whose work screen edits them. */
const CHARTER_TEXT = {
  SCOPE: [
    ['deliverables', '주요 산출물', '납품·제출해야 하는 결과물', '예: 요구사항 정의서, 화면 설계서, 테스트 결과서, 운영 매뉴얼 (한 줄에 하나씩)', 3],
    ['assumptions', '가정사항', '계획이 성립하기 위한 전제 조건', '예: 고객사가 필요한 API 접근 권한을 일정 내 제공한다.', 3],
    ['constraints', '제약사항', '수행을 제한하는 조건', '예: 고객사 내부망에서만 개발 가능 / 외부 SaaS 사용 불가 / 오픈 일정 변경 불가', 3],
    ['initial_risks', '초기 리스크', '착수 시점에 인지한 주요 위험', '예: 기존 시스템 문서 부족 / 고객사 의사결정 지연 가능성', 3],
  ],
  OPERATIONS: [
    ['change_management', '변경관리 방식', '범위·일정 변경 요청의 검토·승인 절차', '예: 일정 또는 범위 영향이 있는 변경은 PM 검토 후 고객 승인', 2],
    ['acceptance', '검수 / 완료 기준', '검수와 프로젝트 완료로 보는 조건', '예: 인수 테스트 완료 및 심각 이슈 0건 / 운영 이관 완료 후 최종 검수', 2],
  ],
};
const textField = ([f, label, hint, ph, rows]) => ({ f, label, hint, ph, rows });
/** One-line purpose per activity (Main view). Validation wording stays inside the work screen. */
const PURPOSE = {
  GOALS: '프로젝트 목표와 성공 기준을 정해 프로젝트가 무엇을 위해 진행되는지 명확히 합니다.',
  SCOPE: '이번 프로젝트에서 하는 것과 하지 않는 것, 주요 산출물과 전제·제약·리스크를 정리해 범위 논쟁의 기준을 만듭니다.',
  STAKEHOLDERS: '고객사·당사·협력사의 담당자와 역할을 정리해 누구와 무엇을 결정할지 분명히 합니다.',
  MILESTONES: '시작·종료 예정일과 반드시 지켜야 할 시점을 정리합니다. WBS의 세부 일정과는 다른 상위 일정입니다.',
  OPERATIONS: '회의·보고·소통·의사결정·변경관리·검수 방식을 정해 프로젝트 운영 규칙을 공유합니다.',
  KICKOFF: '고객과 수행팀이 목표·범위·일정을 처음 공식적으로 확인하는 착수보고회를 준비하고, 결과를 기록합니다.',
  APPROVAL: '정리한 착수 결과를 고객·스폰서에게 승인받고 근거를 남깁니다. 승인된 내용이 이후 요구사항·변경·검수의 기준입니다.',
};
const CTA_LABEL = { GOALS: '프로젝트 목표 입력 →', SCOPE: '범위 입력 →', STAKEHOLDERS: '관계자 입력 →', MILESTONES: '상위 일정 입력 →', OPERATIONS: '운영 방식 입력 →', KICKOFF: '착수보고회 준비 →', APPROVAL: '승인 기록 →' };
const WIDE = new Set(['STAKEHOLDERS', 'MILESTONES', 'KICKOFF', 'APPROVAL']);
const SECTION_FIELDS = { PROFILE: TRAIT_FIELDS, GOALS: ['goal', 'success_criteria'], SCOPE: ['scope_in', 'scope_out', 'deliverables', 'assumptions', 'constraints', 'initial_risks'], STAKEHOLDERS: ['stakeholders'], MILESTONES: ['key_dates'], OPERATIONS: ['operations', 'change_management', 'acceptance'], KICKOFF: ['kickoff'], APPROVAL: ['approval'] };
const METHODS = [['SIGNED', '서명본 수령'], ['EMAIL', '이메일 회신'], ['KICKOFF', '착수보고회에서 승인'], ['OTHER', '기타']];
const KICKOFF_WORDS = /킥오프|착수\s*보고/;
const mmdd = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : '');
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Row state for the process view: done · skip · review (completed, then edited) · prog · todo */
const rowState = (s) => (s.status === 'COMPLETED' ? (s.changed_after_completion ? 'review' : 'done') : s.status === 'SKIPPED' ? 'skip' : s.has_data ? 'prog' : 'todo');
const STATE_LABEL = { done: '완료', skip: '건너뜀', review: '확인 필요', prog: '진행 중', todo: '미시작' };
const STATE_ICON = { done: '✓', skip: '—', review: '!', prog: '●', todo: '○' };

export async function definitionPage(id) {
  const main = $('#main');
  let [g, m] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/definition`))]);
  const p = g.project; const isArch = p.status === 'ARCHIVED'; const ro = isArch || isPhone();   // phone = view mode
  document.title = `01 착수 · 프로젝트 정의 — ${p.name} — RELAI`;
  const u = `/app/projects/${p.id}`;
  const fresh = () => {   // definition + 프로젝트 기본 특성 (stored on the project)
    const x = { ...clone(m.definition), ...clone(m.project_traits) };
    x.approval = { add_to_stakeholders: true, ...x.approval };
    // 착수보고회 일시: prefilled from a 킥오프 / 착수보고 milestone (never a new milestone — spec US-1)
    if (!x.kickoff.datetime) { const kd = (x.key_dates || []).find((k) => k.date && KICKOFF_WORDS.test(k.title || '')); if (kd) { x.kickoff.datetime = `${kd.date}T10:00`; x.kickoff._prefilled = kd.title; } }
    // KICKOFF 완료 → '착수보고회에서 승인' 기본 선택
    if (!x.approval.method && sec('KICKOFF') && sec('KICKOFF').status === 'COMPLETED') x.approval.method = 'KICKOFF';
    return x;
  };
  const sec = (k) => m.sections.find((s) => s.key === k);
  let d = fresh();            // working copy of the open activity's values (kept across drawer ⇄ full screen)
  let dirty = false;
  let open = null;                         // { key, full }
  const qp = new URLSearchParams(location.search); if (qp.get('activity') && SECTION_FIELDS[qp.get('activity')]) open = { key: qp.get('activity'), full: false };

  const phase = () => (g.phases || []).find((x) => x.phase_key === 'INITIATION');
  const currentKey = () => { const c = m.sections.find((s) => s.status !== 'COMPLETED' && s.status !== 'SKIPPED'); return c ? c.key : null; };
  const setUrl = () => { const q = new URLSearchParams(location.search); if (open) q.set('activity', open.key); else q.delete('activity'); if (!open || open.key !== qp.get('activity')) q.delete('field'); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };

  /* ---------- Main Process View ---------- */
  const processView = () => {
    const ph = phase(); const cur = currentKey(); const curSec = cur ? sec(cur) : null;
    const gate = m.sections.filter((s) => s.importance === 'REQUIRED').every((s) => s.status === 'COMPLETED');
    const allDone = m.sections.every((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED');
    const isCurrentPhase = ph && ph.is_current; const nx = g.next_phase;
    const review = m.sections.find((s) => s.status === 'COMPLETED' && s.changed_after_completion);
    const nowRow = ro ? '' : review && !cur
      ? html`<div class="pv__now"><div><span class="pv__k">현재 해야 할 일</span><b>${josa(review.title, '을')} 다시 확인하세요.</b><p>${review.reapproval ? '승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요.' : '완료 처리 후 내용이 수정되었습니다. 확인 후 다시 완료 처리합니다.'}</p></div><button type="button" class="btn btn--primary" data-open="${review.key}">다시 확인 →</button></div>`
      : curSec ? html`<div class="pv__now"><div><span class="pv__k">현재 해야 할 일</span><b>${curSec.title}</b><p>${PURPOSE[cur] || curSec.description}</p></div><button type="button" class="btn btn--primary" data-open="${cur}">${curSec.has_data ? '계속 작성 →' : CTA_LABEL[cur]}</button></div>`
      : html`<div class="pv__now pv__now--done"><div><span class="pv__k">착수 단계</span><b>착수 단계의 필요한 업무가 정리되었습니다.</b><p>${isCurrentPhase && nx ? `아래에서 다음 단계 ${no2(nx.sequence)} ${josa(nx.name, '으로')} 진행할 수 있습니다.` : '내용은 각 업무를 선택해 다시 볼 수 있습니다.'}</p></div></div>`;
    const rows = m.sections.map((s) => {
      const st = rowState(s); const isCur = s.key === cur;
      const cta = ro ? '' : isCur ? html`<button type="button" class="link linkbtn pv__go" data-open="${s.key}">${s.has_data ? '계속 작성 →' : '입력하기 →'}</button>` : st === 'review' ? html`<button type="button" class="link linkbtn pv__go" data-open="${s.key}">다시 확인 →</button>` : st === 'prog' ? html`<button type="button" class="link linkbtn pv__go" data-open="${s.key}">계속 작성 →</button>` : '';
      return html`<li class="pv__row is-${st} ${isCur ? 'is-cur' : ''}" data-row="${s.key}" tabindex="0" role="button" aria-label="${s.title} 열기">
        <i class="st st--${st === 'review' ? 'warn' : st}" aria-hidden="true">${STATE_ICON[st]}</i>
        <div class="pv__m"><span class="pv__t">${s.title}<small class="pv__imp">${s.importance === 'REQUIRED' ? '필수' : s.importance === 'RECOMMENDED' ? '권장' : '선택'}</small></span>
          <span class="pv__purpose">${PURPOSE[s.key] || s.description}</span>
          <span class="pv__sum">${st === 'skip' ? '이번 프로젝트에서는 수행하지 않음' : s.summary || '아직 작성되지 않았습니다.'}</span></div>
        <span class="pv__lab">${STATE_LABEL[st]}</span>
        <span class="pv__cta">${raw(cta)}</span></li>`;
    }).join('');
    const foot = ro ? '' : allDone && isCurrentPhase && nx ? html`<div class="pv__f pv__f--ready"><div><b>착수 단계의 필요한 업무가 정리되었습니다.</b><span>다음 단계 · ${no2(nx.sequence)} ${nx.name}</span></div><button type="button" class="btn btn--primary" id="next-phase2">${josa(nx.name, '으로')} 진행 →</button></div>`
      : gate && isCurrentPhase && nx ? html`<div class="pv__f"><span>필수 업무는 마쳤습니다. 남은 권장·선택 업무를 정리하거나 건너뛰면 다음 단계로 진행할 수 있습니다.</span><button type="button" class="link linkbtn pv__move" id="next-phase2">${no2(nx.sequence)} ${josa(nx.name, '으로')} 진행 →</button></div>`
      : isCurrentPhase && nx ? html`<div class="pv__f"><span>다음 단계 · <b>${no2(nx.sequence)} ${nx.name}</b> — 필수 업무를 마치면 진행할 수 있습니다.</span></div>` : '';
    return html`<section class="pv" aria-labelledby="pvT">
      <div class="pv__h"><span class="pv__no mono">01</span><h2 id="pvT">착수</h2>${raw(isCurrentPhase ? '<span class="np__cur">현재 단계</span>' : '')}<span class="pv__sp"></span>${raw(planMenu())}</div>
      <p class="pv__d">${ph ? ph.description : '프로젝트의 목표, 범위, 조직과 기본 계획을 정합니다.'}</p>
      <p class="pv__terms">용어: <span>프로젝트 개요 ${raw(term('charter'))}</span><span>관계자 ${raw(term('stakeholder'))}</span><span>마일스톤 ${raw(term('milestone'))}</span><span>착수보고회 ${raw(term('kickoff'))}</span><span>사업수행계획서 ${raw(term('plan'))}</span><span>스폰서 ${raw(term('sponsor'))}</span><span>승인/확정 ${raw(term('baseline'))}</span></p>
      ${raw(noApprovalLine(g))}
      <div class="pvp" data-row-profile>
        <div class="pvp__h"><div><b>프로젝트 기본 특성</b><small>프로젝트 유형과 수행 환경 · 생성 시 입력한 값이며 여기서 수정합니다.</small></div>${raw(ro ? '' : '<button type="button" class="link linkbtn pv__go" data-open="PROFILE">수정 →</button>')}</div>
        ${raw(traitGrid(m.project_traits))}
      </div>
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. 프로젝트 정의는 조회만 할 수 있습니다.</div>' : ro ? pcLine() : nowRow)}
      <ol class="pv__list">${raw(rows)}</ol>
      ${raw(foot)}
    </section>`;
  };

  /* ---------- Work Screen (drawer / full screen) ---------- */
  /** 성공 기준 품질 힌트 (rule-based): no number / % / date / 이내·이상·이하 → gray hint under the item. Never blocks completion. */
  const scHint = (text) => (text && !isMeasurable(text) ? '측정할 수 있게 써 보세요. 예: \'검토 리드타임 평균 2영업일 이내\', \'인수 테스트 심각 결함 0건\'' : '');
  const listRows = (key, items, ph) => html`<ul class="def__list" data-list="${key}">${raw(items.map((it) => html`<li><input class="input input--sm" data-item="${key}" data-id="${it.id}" value="${it.text}" maxlength="500" placeholder="${ph}" ${ro ? 'disabled' : ''}>${raw(ro ? '' : html`<button type="button" class="def__x" data-del="${key}" data-id="${it.id}" aria-label="삭제">×</button>`)}${raw(key === 'success_criteria' ? html`<small class="def__schint" data-schint="${it.id}">${scHint(it.text)}</small>` : '')}</li>`).join(''))}</ul>
    ${raw(ro ? '' : html`<button type="button" class="link linkbtn def__add" data-add="${key}">+ 추가</button>`)}`;
  const hierarchy = (list) => {
    if (!list.length) return '';
    const groups = {}; for (const x of list) { const t = x.org_type || 'OTHER'; const dep = x.department || x.org || '(부서 미입력)'; (groups[t] ||= {})[dep] ||= []; groups[t][dep].push(x); }
    return html`<details class="def__hier"><summary>목록 요약 (조직 구분 → 부서 → 사람) <em>${list.length}명</em></summary>
      ${raw(Object.keys(ORG_TYPE).filter((t) => groups[t]).map((t) => html`<div class="def__hg"><b>${ORG_TYPE[t]}</b>${raw(Object.entries(groups[t]).map(([dep, ppl]) => html`<div class="def__hd"><span>${dep}</span><span class="def__hp">${ppl.map((x) => x.name + (x.role ? ` (${x.role})` : '')).join(' · ')}</span></div>`).join(''))}</div>`).join(''))}</details>`;
  };
  /** Milestone after the project end date: warn under the row, still saveable (안정화·하자보수 일정일 수 있음). */
  const afterEnd = (date) => { const end = m.project_dates.planned_end_date && String(m.project_dates.planned_end_date).slice(0, 10); return date && end && date > end ? html`<p class="def__warn" data-kdwarn>프로젝트 종료일(${mmdd(end)}) 이후입니다. 안정화·하자보수 기간이라면 괜찮지만, 계약 종료일을 다시 확인하세요.</p>` : ''; };
  const textAreas = (list) => list.map(textField).map((x) => html`<div class="field" data-field="${x.f}"><label>${x.label} <small class="dim">${x.hint}</small></label><textarea class="textarea" data-f="${x.f}" rows="${x.rows}" maxlength="4000" placeholder="${x.ph}" ${ro ? 'disabled' : ''}>${d[x.f] || ''}</textarea></div>`).join('');
  const form = (key) => {
    switch (key) {
      case 'GOALS': return html`<div class="field" data-field="goal"><label>프로젝트 목표</label><textarea class="textarea" data-f="goal" rows="3" maxlength="2000" placeholder="이 프로젝트로 달성하려는 결과를 1~3문장으로 적습니다. 예: 법무팀 계약 검토 리드타임을 50% 단축하는 AI 검토 시스템 구축" ${ro ? 'disabled' : ''}>${d.goal}</textarea></div>
        <div class="field" data-field="success_criteria"><label>성공 기준 <small class="dim">측정 가능한 완료·성공 조건</small></label>${raw(listRows('success_criteria', d.success_criteria, '예: 검토 요청 접수부터 결과 회신까지 평균 2영업일 이내'))}</div>
        <p class="hint">완료 처리하려면 목표 또는 성공 기준을 1개 이상 입력합니다.</p>`;
      case 'SCOPE': return html`<div class="field" data-field="scope_in"><label>수행 범위 <small class="dim">이번 프로젝트에서 하는 것</small></label>${raw(listRows('scope_in', d.scope_in, '예: 계약서 자동 검토 기능(국문 표준계약 5종)'))}</div>
        <div class="field" data-field="scope_out"><label>제외 범위 <small class="dim">하지 않기로 한 것</small></label>${raw(listRows('scope_out', d.scope_out, '예: 영문 계약서, 기존 ERP 연동'))}</div>
        ${raw(textAreas(CHARTER_TEXT.SCOPE.slice(0, 1)))}
        <div class="def__sub"><b>전제 · 제약 · 초기 리스크</b><small>프로젝트 개요와 RELAI AI가 WBS·요구사항·변경 영향을 판단할 때 함께 고려합니다.</small></div>
        ${raw(textAreas(CHARTER_TEXT.SCOPE.slice(1)))}
        <p class="hint">완료 처리하려면 수행 범위를 1개 이상 입력합니다. 산출물·전제·제약·리스크는 선택 항목입니다.</p>`;
      case 'STAKEHOLDERS': return html`${raw(hierarchy(d.stakeholders))}
        <div class="def__tools">${raw(ro ? '' : html`<button type="button" class="btn btn--secondary btn--sm" id="sh-add">+ 직접 추가</button><button type="button" class="btn btn--secondary btn--sm" id="sh-xl">Excel 업로드</button><button type="button" class="link linkbtn def__tpl" id="sh-tpl">등록 템플릿 내려받기</button>`)}</div>
        <div class="def__tblwrap"><p class="hint def__shhelp">고객 측 의사결정자(스폰서 ${raw(term('sponsor'))})와 실무 책임자(고객 PM)를 꼭 넣으세요. 승인자로 선택됩니다.</p>
        <table class="def__tbl def__tbl--sh"><thead><tr><th>조직 구분</th><th>조직(회사)</th><th>부서</th><th>이름</th><th>역할</th><th>주요 책임</th><th></th></tr></thead>
          <tbody>${raw(d.stakeholders.map((x) => html`<tr data-sh="${x.id}">
            <td><select class="select select--sm" data-shf="org_type" ${ro ? 'disabled' : ''}><option value="" ${x.org_type ? '' : 'selected'}>선택</option>${raw(Object.entries(ORG_TYPE).map(([v, l]) => html`<option value="${v}" ${x.org_type === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></td>
            <td><input class="input input--sm" data-shf="org" value="${x.org || ''}" maxlength="100" placeholder="회사명" ${ro ? 'disabled' : ''}></td>
            <td><input class="input input--sm" data-shf="department" value="${x.department || ''}" maxlength="100" placeholder="부서" ${ro ? 'disabled' : ''}></td>
            <td><input class="input input--sm" data-shf="name" value="${x.name || ''}" maxlength="100" placeholder="이름" ${ro ? 'disabled' : ''}></td>
            <td><input class="input input--sm" data-shf="role" value="${x.role || ''}" maxlength="100" placeholder="예: 고객 PM" ${ro ? 'disabled' : ''}></td>
            <td><input class="input input--sm" data-shf="area" value="${x.area || ''}" maxlength="200" placeholder="예: 요구사항 최종 승인" ${ro ? 'disabled' : ''}></td>
            <td>${raw(ro ? '' : html`<button type="button" class="def__x" data-shdel="${x.id}" aria-label="삭제">×</button>`)}</td></tr>`).join(''))}
          ${raw(d.stakeholders.length ? '' : '<tr class="def__empty"><td colspan="7">아직 등록된 관계자가 없습니다. 직접 추가하거나 Excel 템플릿으로 한 번에 등록하세요.</td></tr>')}</tbody></table></div>
        <p class="hint">완료 처리하려면 조직 구분과 이름이 있는 관계자를 1명 이상 등록합니다.</p>`;
      case 'MILESTONES': return html`<div class="def__dates" data-field="project_dates"><span>프로젝트 기간</span><b>${fmtShort(m.project_dates.planned_start_date)} ~ ${fmtShort(m.project_dates.planned_end_date)}</b>${raw(ro ? '' : html`<a class="link" href="${u}/edit" data-link>정보 수정</a>`)}</div>
        <div class="field" data-field="key_dates"><label>주요 일정 · 마일스톤 <small class="dim">계약·보고·검수 등 반드시 지켜야 할 시점 — 프로젝트 개요 타임라인에 표시됩니다</small></label>
          <ul class="def__list def__list--dates">${raw(d.key_dates.map((x) => html`<li data-kd="${x.id}"><input class="input input--sm" type="date" data-kdf="date" value="${x.date}" ${ro ? 'disabled' : ''}><input class="input input--sm" data-kdf="title" value="${x.title}" maxlength="200" placeholder="예: 착수보고회, 중간보고, 최종 검수" ${ro ? 'disabled' : ''}>${raw(ro ? '' : html`<button type="button" class="def__x" data-kddel="${x.id}" aria-label="삭제">×</button>`)}${raw(afterEnd(x.date))}</li>`).join(''))}</ul>
          ${raw(ro ? '' : '<button type="button" class="link linkbtn def__add" id="kd-add">+ 일정 추가</button>')}</div>
        <div class="field"><label>WBS 마일스톤 <small class="dim">분석·설계 단계에서 WBS에 등록한 마일스톤 (조회만)</small></label>
          ${raw(m.wbs_milestones.length ? html`<ul class="def__ms">${raw(m.wbs_milestones.map((x) => html`<li><a href="${u}/wbs?sel=${x.id}" data-link><i class="wms">◆</i><span class="mono">${x.wbs_code}</span>${x.title}<time>${x.milestone_date ? fmtShort(x.milestone_date) : '날짜 미정'}</time></a></li>`).join(''))}</ul>` : '<p class="hint">아직 WBS에 마일스톤이 없습니다.</p>')}</div>
        <p class="hint">완료 처리하려면 주요 일정을 1개 이상 입력하거나 WBS에 마일스톤이 있어야 합니다.</p>`;
      case 'OPERATIONS': return html`${raw(OPS.map(([k, label, ph]) => html`<div class="field" data-field="${k}"><label>${label}</label><textarea class="textarea" data-op="${k}" rows="2" maxlength="2000" placeholder="${ph}" ${ro ? 'disabled' : ''}>${d.operations[k] || ''}</textarea></div>`).join(''))}
        ${raw(textAreas(CHARTER_TEXT.OPERATIONS))}
        <p class="hint">완료 처리하려면 회의·보고·소통·의사결정 중 1개 이상을 입력합니다. 변경관리·검수 기준은 선택 항목입니다.</p>`;
      case 'KICKOFF': return kickoffForm();
      case 'APPROVAL': return approvalForm();
      default: return '';
    }
  };
  /* ---------- 착수보고회 (US-1) ---------- */
  const klist = (kind, items, row, addLabel) => html`<ul class="def__list kl" data-kl="${kind}">${raw(items.map((it) => html`<li data-klid="${it.id}">${raw(row(it))}${raw(ro ? '' : html`<button type="button" class="def__x" data-kldel="${kind}" data-id="${it.id}" aria-label="삭제">×</button>`)}</li>`).join(''))}</ul>
    ${raw(ro ? '' : html`<button type="button" class="link linkbtn def__add" data-kladd="${kind}">${addLabel}</button>`)}`;
  const dis = ro ? 'disabled' : '';
  const kickoffForm = () => {
    const k = d.kickoff; const people = d.stakeholders || [];
    const prepDone = k.prep.filter((x) => x.done).length;
    return html`<div class="wd__tools">${raw(planMenu('사업수행계획서 초안 내려받기'))}<small class="dim">착수보고회 전에 사업수행계획서 초안을 고객에게 보내세요. ${raw(term('plan'))}</small></div>
      <div class="def__grid2">
        <div class="field" data-field="kickoff.datetime"><label>일시 <span class="req">*</span></label><input class="input input--sm" type="datetime-local" data-kf="datetime" value="${k.datetime}" ${dis}>${raw(k._prefilled ? html`<small class="dim">마일스톤 '${k._prefilled}'에서 가져왔습니다. 시간을 확인하세요.</small>` : '')}</div>
        <div class="field" data-field="kickoff.place"><label>장소 / 방식</label><input class="input input--sm" data-kf="place" value="${k.place}" maxlength="200" placeholder="예: 고객사 대회의실 / Teams" ${dis}></div>
      </div>
      <div class="field" data-field="kickoff.attendees"><label>참석자 <small class="dim">관계자 목록에서 선택</small></label>
        ${raw(people.length ? html`<div class="kchk">${raw(people.map((x) => html`<label class="kchk__i"><input type="checkbox" data-katt="${x.id}" ${k.attendees.includes(x.id) ? 'checked' : ''} ${dis}> ${x.name}<small>${[x.org, x.role].filter(Boolean).join(' · ')}</small></label>`).join(''))}</div>` : '<p class="hint">관계자를 먼저 등록하면 여기에서 참석자를 선택할 수 있습니다.</p>')}</div>
      <div class="field" data-field="kickoff.prep"><label>준비 체크 <small class="dim">${prepDone}/${k.prep.length} 완료</small></label>
        ${raw(klist('prep', k.prep, (it) => html`<input type="checkbox" data-klf="done" ${it.done ? 'checked' : ''} ${dis} aria-label="완료"><input class="input input--sm" data-klf="text" value="${it.text}" maxlength="200" ${dis}>`, '+ 항목 추가'))}</div>
      <div class="field" data-field="kickoff.agenda"><label>안건</label><textarea class="textarea" data-kf="agenda" rows="5" maxlength="2000" ${dis}>${k.agenda}</textarea></div>
      <div class="def__sub"><b>개최 후 기록</b><small>착수보고회가 끝나면 회의록 요약 또는 결정사항을 남기고 완료 처리합니다.</small></div>
      <div class="field" data-field="kickoff.minutes"><label>회의록 요약</label><textarea class="textarea" data-kf="minutes" rows="3" maxlength="4000" placeholder="예: 목표·범위·일정 설명, 고객 질의 3건 답변, 범위 중 '영문 계약서'는 제외로 합의" ${dis}>${k.minutes}</textarea></div>
      <div class="field" data-field="kickoff.decisions"><label>결정사항</label>${raw(klist('decisions', k.decisions, (it) => html`<input class="input input--sm" data-klf="text" value="${it.text}" maxlength="500" placeholder="예: 주간 정례회의 매주 월 10시로 확정" ${dis}>`, '+ 결정사항 추가'))}</div>
      <div class="field" data-field="kickoff.followups"><label>후속 조치 <small class="dim">내용 · 담당자 · 기한</small></label>${raw(klist('followups', k.followups, (it) => html`<input type="checkbox" data-klf="done" ${it.done ? 'checked' : ''} ${dis} aria-label="완료"><input class="input input--sm kl__text" data-klf="text" value="${it.text}" maxlength="300" placeholder="예: 회의록 송부" ${dis}><input class="input input--sm kl__owner" data-klf="owner" value="${it.owner || ''}" maxlength="100" placeholder="담당자" ${dis}><input class="input input--sm kl__due" type="date" data-klf="due" value="${it.due || ''}" ${dis}>`, '+ 후속 조치 추가'))}</div>
      <p class="hint">완료 처리하려면 일시가 지났고(개최됨), 회의록 요약 또는 결정사항이 1개 이상 있어야 합니다. 사내 소규모 과제처럼 착수보고회가 없으면 건너뛸 수 있습니다.</p>`;
  };
  /* ---------- 착수 결과 승인 (US-2) ---------- */
  const approvalForm = () => {
    const a = d.approval; const s = sec('APPROVAL'); const kick = sec('KICKOFF');
    const methods = METHODS.filter(([k]) => k !== 'KICKOFF' || !kick || kick.status !== 'SKIPPED');
    const pd = m.project_dates;
    const nOrg = (t) => (d.stakeholders || []).filter((x) => x.org_type === t).length;
    return html`${raw(s && s.reapproval ? '<div class="notice notice--crit">승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요. 다시 승인받은 뒤 <b>다시 확인 완료</b>를 누릅니다.</div>' : '')}
      ${raw(s && s.bypass ? html`<div class="notice notice--soft">승인 전 진행 — 사유: ${s.bypass.reason} (${[s.bypass.date, s.bypass.name].filter(Boolean).join(' · ')}). 승인을 받으면 아래에 기록하세요.</div>` : '')}
      <div class="apv__what"><div class="apv__wh"><b>승인받을 내용</b>${raw(planMenu())}</div>
        <dl><div><dt>목표</dt><dd>${d.goal || (d.success_criteria[0] && d.success_criteria[0].text) || '작성되지 않음'}</dd></div>
        <div><dt>범위</dt><dd>${d.scope_in.length ? `수행 ${d.scope_in.length}건 (${d.scope_in.slice(0, 2).map((x) => x.text).join(', ')}${d.scope_in.length > 2 ? ' …' : ''})${d.scope_out.length ? ` · 제외 ${d.scope_out.length}건` : ''}` : '작성되지 않음'}</dd></div>
        <div><dt>일정</dt><dd>${pd.planned_start_date ? `${fmtShort(pd.planned_start_date)} ~ ${fmtShort(pd.planned_end_date)}` : '기간 미정'}${d.key_dates.length ? ` · 마일스톤 ${d.key_dates.length}건` : ''}</dd></div>
        <div><dt>추진 조직</dt><dd>${(d.stakeholders || []).length ? ['CLIENT', 'OWN', 'PARTNER', 'OTHER'].filter((t) => nOrg(t)).map((t) => `${ORG_TYPE[t]} ${nOrg(t)}명`).join(' · ') : '작성되지 않음'}</dd></div></dl></div>
      ${raw(approvalFields(a, { people: d.stakeholders || [], methods, disabled: ro, approverHint: html`<small class="dim">스폰서 ${raw(term('sponsor'))} 또는 고객 PM</small>`, evidencePh: "예: 2026-11-03 이수진 차장 회신 메일 '사업수행계획서 v1.0 승인'" }))}
      <p class="hint">승인자·승인일·승인 방법·근거가 있어야 완료 처리할 수 있습니다. 승인 후 목표·범위·일정이나 승인자 정보가 바뀌면 '확인 필요'로 표시됩니다. ${raw(term('baseline'))}</p>`;
  };
  /** 프로젝트 기본 특성: same drawer and save flow, but not an activity — no 완료 처리 / 건너뛰기, saving never completes anything. */
  const profileDrawer = () => html`<aside class="wdrawer ${open.full ? 'wdrawer--full' : ''}" id="wdrawer" role="dialog" aria-labelledby="wdT">
      <div class="wd__h"><div class="wd__ht"><b id="wdT">프로젝트 기본 특성</b><small>프로젝트 유형과 수행 환경을 정합니다. 모르는 항목은 '미정'으로 둡니다.</small></div>
        <button type="button" class="wd__ib" id="wd-full" title="${open.full ? '축소' : '확대'}" aria-label="${open.full ? '축소' : '확대'}">${open.full ? '⤡' : '⤢'}</button><button type="button" class="wd__ib" id="wd-close" aria-label="닫기">×</button></div>
      <div class="wd__b"><div class="wd__form trf2" data-sec="PROFILE">${raw(traitFields(d, { bind: 'data-f', disabled: ro, idPrefix: 'df' }))}</div></div>
      ${raw(ro ? '' : html`<div class="wd__f"><span></span><span class="wd__btns"><span class="wd__stat" id="wd-stat">${dirty ? '저장되지 않은 변경' : ''}</span><button type="button" class="btn btn--primary btn--sm" data-wact="save">저장</button></span></div>`)}
    </aside>`;
  const drawer = () => {
    if (!open) return '';
    if (open.key === 'PROFILE') return profileDrawer();
    const s = sec(open.key); const st = rowState(s);
    const skipped = s.status === 'SKIPPED'; const completed = s.status === 'COMPLETED';
    const body = skipped
      ? html`<div class="wd__skipped"><i class="st st--skip" aria-hidden="true">—</i><div><b>이 업무는 건너뛴 상태입니다.</b><p>이번 프로젝트에서는 수행하지 않는 것으로 기록되어 있습니다. 필요해지면 다시 시작할 수 있습니다.</p>${raw(ro ? '' : '<button type="button" class="btn btn--primary btn--sm" data-wact="resume">업무 다시 시작 →</button>')}</div></div>`
      : html`${raw(st === 'review' ? '<div class="notice notice--soft">완료 처리 후 내용이 수정되었습니다. 확인한 뒤 다시 완료 처리하세요.</div>' : '')}<div class="wd__form" data-sec="${s.key}">${raw(form(s.key))}</div>`;
    const foot = ro || skipped ? '' : html`<div class="wd__f">
      ${raw(s.skippable && !completed ? '<button type="button" class="link linkbtn wd__skip" data-wact="skip">↷ 이 업무 건너뛰기</button>' : s.key === 'APPROVAL' && !completed ? html`<span class="wd__stat hint" id="apv-stat">${approvalStatusText(d.approval || {})}</span>` : '<span></span>')}
      <span class="wd__btns"><span class="wd__stat" id="wd-stat">${dirty ? '저장되지 않은 변경' : ''}</span>
        <button type="button" class="btn btn--secondary btn--sm" data-wact="save">임시저장</button>
        ${raw(completed ? (st === 'review' ? '<button type="button" class="btn btn--primary btn--sm" data-wact="confirm">다시 확인 완료</button>' : '') + '<button type="button" class="btn btn--ghost btn--sm" data-wact="reopen">완료 취소</button>' : '<button type="button" class="btn btn--primary btn--sm" data-wact="complete">완료 처리</button>')}</span></div>`;
    return html`<aside class="wdrawer ${open.full ? 'wdrawer--full' : ''} ${WIDE.has(open.key) ? 'wdrawer--wide' : ''}" id="wdrawer" role="dialog" aria-labelledby="wdT">
      <div class="wd__h"><div class="wd__ht"><b id="wdT">${s.title}</b><small>${PURPOSE[s.key] || s.description}</small></div>
        <button type="button" class="wd__ib" id="wd-full" title="${open.full ? '축소' : '확대'}" aria-label="${open.full ? '축소' : '확대'}">${open.full ? '⤡' : '⤢'}</button><button type="button" class="wd__ib" id="wd-close" aria-label="닫기">×</button></div>
      <div class="wd__b">${raw(body)}</div>
      ${raw(foot)}
    </aside>`;
  };

  const draw = () => {
    main.innerHTML = html`<div class="page page--wide page--flow page--guide defp ${open ? 'has-wd' : ''}">
      ${raw(projectHead(p, g, { tab: open && ['STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL'].includes(open.key) ? open.key.toLowerCase() : 'definition', title: '프로젝트 정의' }))}
      ${raw(processView())}
      ${raw(drawer())}
    </div>`;
    bind();
  };
  const drawDrawer = () => { const el = $('#wdrawer'); if (!el) return draw(); const y = el.querySelector('.wd__b')?.scrollTop || 0; el.outerHTML = drawer(); const nb = $('#wdrawer .wd__b'); if (nb) nb.scrollTop = y; bindDrawer(); };
  const refreshView = () => { const pv = main.querySelector('.pv'); if (pv) pv.outerHTML = processView(); bindView(); };

  /* ---------- working copy ---------- */
  const collect = () => {
    const el = $('#wdrawer'); if (!el || !open) return;
    const v = (sel) => { const x = el.querySelector(sel); return x ? x.value : undefined; };
    el.querySelectorAll('[data-f]').forEach((x) => { d[x.dataset.f] = x.value; });   // single-value fields (goal, project_type, Project Charter free text)
    if (open.key === 'GOALS') { d.success_criteria = [...el.querySelectorAll('[data-item="success_criteria"]')].map((x) => ({ id: x.dataset.id, text: x.value })); }
    if (open.key === 'SCOPE') for (const key of ['scope_in', 'scope_out']) d[key] = [...el.querySelectorAll(`[data-item="${key}"]`)].map((x) => ({ id: x.dataset.id, text: x.value }));
    if (open.key === 'STAKEHOLDERS') d.stakeholders = [...el.querySelectorAll('tr[data-sh]')].map((tr) => { const o = { id: tr.dataset.sh }; tr.querySelectorAll('[data-shf]').forEach((x) => { o[x.dataset.shf] = x.value; }); return o; });
    if (open.key === 'MILESTONES') d.key_dates = [...el.querySelectorAll('li[data-kd]')].map((li) => { const o = { id: li.dataset.kd }; li.querySelectorAll('[data-kdf]').forEach((x) => { o[x.dataset.kdf] = x.value; }); return o; });
    if (open.key === 'OPERATIONS') { d.operations = { ...d.operations }; el.querySelectorAll('[data-op]').forEach((x) => { d.operations[x.dataset.op] = x.value; }); }
    if (open.key === 'KICKOFF') {
      const k = { ...d.kickoff }; el.querySelectorAll('[data-kf]').forEach((x) => { k[x.dataset.kf] = x.value; });
      if (el.querySelector('[data-katt]')) k.attendees = [...el.querySelectorAll('[data-katt]')].filter((x) => x.checked).map((x) => x.dataset.katt);
      for (const kind of ['prep', 'decisions', 'followups']) k[kind] = [...el.querySelectorAll(`[data-kl="${kind}"] li[data-klid]`)].map((li) => { const o = { id: li.dataset.klid }; li.querySelectorAll('[data-klf]').forEach((x) => { o[x.dataset.klf] = x.type === 'checkbox' ? x.checked : x.value; }); return o; });
      d.kickoff = k;
    }
    if (open.key === 'APPROVAL') {
      d.approval = collectApproval(el, d.approval);
    }
  };
  const sectionBody = (key) => {
    const body = {}; for (const f of SECTION_FIELDS[key]) body[f] = d[f];
    if (key === 'APPROVAL') body.approval = approvalBody(body.approval);
    if (key === 'KICKOFF') { const k = { ...body.kickoff }; delete k._prefilled; body.kickoff = k; }
    return body;
  };
  const markDirty = () => { dirty = true; const st = $('#wd-stat'); if (st) st.textContent = '저장되지 않은 변경'; const as = $('#apv-stat'); if (as && open && open.key === 'APPROVAL') { collect(); as.textContent = approvalStatusText(d.approval || {}); } };
  const reload = async () => { [g, m] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/definition`))]); };
  const err = (e) => { const msg = e.fields ? Object.values(e.fields)[0] : e.message; toast(msg); const st = $('#wd-stat'); if (st) st.textContent = msg; };

  const discardOk = async () => !dirty || confirmDialog({ title: '저장되지 않은 변경이 있습니다.', body: '임시저장하지 않은 내용은 사라집니다. 그대로 닫을까요?', confirm: '닫기' });
  const openActivity = async (key, { full = false } = {}) => { if (open && open.key === key) return; if (!(await discardOk())) return; d = fresh(); dirty = false; open = { key, full }; setUrl(); draw(); const first = $('#wdrawer .wd__form input, #wdrawer .wd__form textarea, #wdrawer .wd__form select'); if (first) first.focus({ preventScroll: true }); };
  const closeDrawer = async () => { if (!(await discardOk())) return; open = null; dirty = false; setUrl(); draw(); };

  /* ---------- actions ---------- */
  const save = async () => {
    collect(); const st = $('#wd-stat'); if (st) st.textContent = '저장 중…';
    try { m = await api('PUT', wsApi(`/${id}/definition`), sectionBody(open.key)); d = { ...d, ...fresh() }; dirty = false; await reload(); refreshView(); const prof = open.key === 'PROFILE'; const s2 = $('#wd-stat'); if (s2) s2.textContent = prof ? '저장됨' : '임시저장됨'; toast(prof ? '프로젝트 기본 특성을 저장했습니다.' : '임시저장했습니다.'); }
    catch (e) { err(e); }
  };
  const act = async (action) => {
    const key = open.key;
    if (action === 'skip') {
      if (!(await confirmDialog({ title: '이 업무를 건너뛸까요?', body: '이번 프로젝트에서는 이 업무를 수행하지 않는 것으로 기록됩니다. 나중에 다시 시작할 수 있습니다.', confirm: '건너뛰기' }))) return;
    }
    if (action === 'reopen' && !(await confirmDialog({ title: '완료를 취소할까요?', body: '작성한 내용은 그대로 남고, 이 업무만 다시 "진행 중"으로 바뀝니다.', confirm: '완료 취소' }))) return;
    collect();
    const wd = $('#wdrawer');
    if (key === 'APPROVAL' && action === 'complete' && wd && showApprovalErrors(wd, approvalErrors(d.approval || {}))) return;   // L-D2: inline, under each field
    const body = ['complete', 'confirm'].includes(action) ? sectionBody(key) : {};   // 완료 처리 = 저장 + 검증 + COMPLETED, one click
    try {
      const r = await api('POST', wsApi(`/${id}/definition/sections/${key}/${action}`), body);
      g = r.guide; delete r.guide; m = r; dirty = false;
      if (action === 'complete' || action === 'confirm' || action === 'skip') { open = null; setUrl(); draw(); toast(action === 'skip' ? '이 업무를 건너뛰었습니다.' : '완료 처리했습니다.'); }
      else { d = fresh(); draw(); toast(action === 'resume' ? '업무를 다시 시작합니다.' : '완료를 취소했습니다.'); }
    } catch (e) { err(e); }
  };

  /* ---------- Excel upload (modal on top of the drawer — never a nested drawer) ---------- */
  const excelModal = () => {
    const el = document.createElement('div'); el.className = 'scrim';
    let rows = null; let columns = []; let summary = null; let busy = false; let fileName = '';
    const render = () => {
      el.innerHTML = html`<div class="dialog dialog--wide xlm" role="dialog" aria-modal="true" aria-labelledby="xlT"><h3 id="xlT">관계자 Excel 업로드</h3>
        ${raw(!rows ? html`<p>등록 템플릿(.xlsx)에 작성한 파일을 올리면 내용을 확인한 뒤 한 번에 등록합니다. 기존 목록에 추가됩니다.</p>
          <div class="drop ${busy ? 'is-busy' : ''}" id="xl-drop" tabindex="0" role="button"><b>${busy ? `${fileName} 읽는 중…` : 'Excel 파일(.xlsx)을 여기에 끌어다 놓거나 클릭해 선택하세요'}</b><input type="file" id="xl-file" accept=".xlsx" hidden></div>
          <div class="actions"><button type="button" class="link linkbtn" id="xl-tpl" style="width:auto">등록 템플릿 내려받기</button><span style="flex:1"></span><button type="button" class="btn btn--secondary" data-v="0">취소</button></div>`
        : html`<p>${summary.ok}명 등록 가능${summary.error ? ` · 오류 ${summary.error}행 (제외됩니다)` : ''}</p>
          <div class="imp__tbl xlm__tbl"><table><thead><tr><th>행</th>${raw(columns.map((c) => html`<th>${c.label}</th>`).join(''))}<th>확인</th></tr></thead><tbody>${raw(rows.map((r) => html`<tr class="${r.ok ? '' : 'is-err'}"><td class="rn">${r.row}</td><td>${r.values.org_type_label}</td><td>${r.values.org}</td><td>${r.values.department}</td><td>${r.values.name}</td><td>${r.values.role}</td><td>${r.values.area}</td><td>${r.values.note}</td><td class="xlm__err">${Object.values(r.errors).join(' ')}</td></tr>`).join(''))}</tbody></table></div>
          <div class="actions"><button type="button" class="btn btn--secondary" id="xl-back">다른 파일 선택</button><span style="flex:1"></span><button type="button" class="btn btn--secondary" data-v="0">취소</button><button type="button" class="btn btn--primary" id="xl-commit" ${summary.ok ? '' : 'disabled'}>${summary.ok}명 등록</button></div>`)}</div>`;
      const done = () => el.remove();
      el.querySelectorAll('[data-v="0"]').forEach((b) => b.onclick = done);
      el.onclick = (e) => { if (e.target === el) done(); };
      const tpl = $('#xl-tpl', el); if (tpl) tpl.onclick = () => download(wsApi(`/${id}/definition/stakeholders/template.xlsx`), { filename: '관계자 등록 템플릿.xlsx' }).catch((e) => toast(e.message));
      const drop = $('#xl-drop', el); const input = $('#xl-file', el);
      if (drop) {
        drop.onclick = () => input.click(); drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('is-over'); }; drop.ondragleave = () => drop.classList.remove('is-over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('is-over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
        input.onchange = () => { if (input.files[0]) upload(input.files[0]); };
      }
      const back = $('#xl-back', el); if (back) back.onclick = () => { rows = null; render(); };
      const commit = $('#xl-commit', el); if (commit) commit.onclick = () => {
        collect(); const add = rows.filter((r) => r.ok).map((r) => ({ id: uid(), org_type: r.values.org_type, org: r.values.org, department: r.values.department, name: r.values.name, role: r.values.role, area: r.values.area, note: r.values.note }));
        d.stakeholders = [...d.stakeholders.filter((x) => x.name || x.org || x.department), ...add]; markDirty(); done(); drawDrawer(); toast(`${add.length}명을 목록에 추가했습니다. 임시저장 또는 완료 처리로 저장하세요.`);
      };
    };
    const upload = async (file) => {
      if (!/\.xlsx$/i.test(file.name)) { toast('.xlsx 파일만 업로드할 수 있습니다.'); return; }
      if (file.size > 5 * 1024 * 1024) { toast('파일은 5MB 이하여야 합니다.'); return; }
      busy = true; fileName = file.name; render();
      try { const r = await api('POST', wsApi(`/${id}/definition/stakeholders/import/preview`), { data: await fileToBase64(file) }); rows = r.rows; columns = r.columns; summary = r.summary; busy = false; render(); }
      catch (e) { busy = false; render(); toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    const onKey = (e) => { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    const obs = new MutationObserver(() => { if (!document.body.contains(el)) { document.removeEventListener('keydown', onKey); obs.disconnect(); } }); obs.observe(document.body, { childList: true });
    render(); document.body.append(el);
  };

  /* ---------- bindings ---------- */
  const bindView = () => {
    main.querySelectorAll('[data-open]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openActivity(b.dataset.open); });
    main.querySelectorAll('.pv__row').forEach((row) => { row.onclick = () => openActivity(row.dataset.row); row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openActivity(row.dataset.row); } }; });
    bindPlanMenu(main.querySelector('.pv') || main, p.id);
    const move = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) { await reload(); draw(); } };
    for (const sel of ['#next-phase', '#next-phase2']) { const b = $(sel); if (b) b.onclick = move; }
  };
  const bindDrawer = () => {
    const el = $('#wdrawer'); if (!el) return;
    $('#wd-close').onclick = closeDrawer;
    $('#wd-full').onclick = () => { open.full = !open.full; el.classList.toggle('wdrawer--full', open.full); $('#wd-full').textContent = open.full ? '⤡' : '⤢'; $('#wd-full').title = open.full ? '축소' : '확대'; };   // same DOM → typed values survive
    el.querySelectorAll('[data-wact]').forEach((b) => b.onclick = () => (b.dataset.wact === 'save' ? save() : act(b.dataset.wact)));
    el.oninput = () => markDirty(); el.onchange = () => markDirty();
    wireTraitFields(el);
    el.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { collect(); d[b.dataset.add].push({ id: uid(), text: '' }); markDirty(); drawDrawer(); const last = [...$('#wdrawer').querySelectorAll(`[data-item="${b.dataset.add}"]`)].pop(); if (last) last.focus(); });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { collect(); d[b.dataset.del] = d[b.dataset.del].filter((x) => x.id !== b.dataset.id); markDirty(); drawDrawer(); });
    const sa = $('#sh-add'); if (sa) sa.onclick = () => { collect(); d.stakeholders.push({ id: uid(), org_type: '', org: '', department: '', name: '', role: '' }); markDirty(); drawDrawer(); const last = [...$('#wdrawer').querySelectorAll('tr[data-sh] [data-shf="name"]')].pop(); if (last) last.focus(); };
    const sx = $('#sh-xl'); if (sx) sx.onclick = () => { collect(); excelModal(); };
    const stp = $('#sh-tpl'); if (stp) stp.onclick = () => download(wsApi(`/${id}/definition/stakeholders/template.xlsx`), { filename: '관계자 등록 템플릿.xlsx' }).catch((e) => toast(e.message));
    el.querySelectorAll('[data-shdel]').forEach((b) => b.onclick = () => { collect(); d.stakeholders = d.stakeholders.filter((x) => x.id !== b.dataset.shdel); markDirty(); drawDrawer(); });
    el.querySelectorAll('[data-kladd]').forEach((b) => b.onclick = () => { collect(); const kind = b.dataset.kladd; d.kickoff[kind] = [...d.kickoff[kind], kind === 'followups' ? { id: uid(), text: '', owner: '', due: '', done: false } : kind === 'prep' ? { id: uid(), text: '', done: false } : { id: uid(), text: '' }]; markDirty(); drawDrawer(); const last = [...$('#wdrawer').querySelectorAll(`[data-kl="${kind}"] [data-klf="text"]`)].pop(); if (last) last.focus(); });
    el.querySelectorAll('[data-kldel]').forEach((b) => b.onclick = () => { collect(); d.kickoff[b.dataset.kldel] = d.kickoff[b.dataset.kldel].filter((x) => x.id !== b.dataset.id); markDirty(); drawDrawer(); });
    el.querySelectorAll('[data-kl="prep"] [data-klf="done"]').forEach((x) => x.addEventListener('change', () => { collect(); drawDrawer(); }));
    const asel = el.querySelector('[data-af="approver_id"]'); if (asel) asel.addEventListener('change', () => { collect(); drawDrawer(); });
    el.querySelectorAll('[data-item="success_criteria"]').forEach((x) => x.addEventListener('input', () => { const h = el.querySelector(`[data-schint="${x.dataset.id}"]`); if (h) h.textContent = scHint(x.value.trim()); }));
    el.querySelectorAll('[data-kdf="date"]').forEach((x) => x.addEventListener('change', () => { collect(); drawDrawer(); }));
    bindPlanMenu(el, p.id);
    const ka = $('#kd-add'); if (ka) ka.onclick = () => { collect(); d.key_dates.push({ id: uid(), title: '', date: '' }); markDirty(); drawDrawer(); const last = [...$('#wdrawer').querySelectorAll('li[data-kd] [data-kdf="date"]')].pop(); if (last) last.focus(); };
    el.querySelectorAll('[data-kddel]').forEach((b) => b.onclick = () => { collect(); d.key_dates = d.key_dates.filter((x) => x.id !== b.dataset.kddel); markDirty(); drawDrawer(); });
    el.querySelectorAll('[data-item]').forEach((x) => {
      x.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); const b = el.querySelector(`[data-add="${x.dataset.item}"]`); if (b) b.click(); } };
      x.onpaste = (e) => {
        const text = (e.clipboardData || window.clipboardData)?.getData('text') || ''; const lines = text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
        if (lines.length < 2) return; e.preventDefault(); collect();
        const key = x.dataset.item; const list = d[key]; const i = list.findIndex((y) => y.id === x.dataset.id);
        if (i >= 0 && !list[i].text) list.splice(i, 1, ...lines.map((t) => ({ id: uid(), text: t }))); else list.splice((i < 0 ? list.length : i) + 1, 0, ...lines.map((t) => ({ id: uid(), text: t })));
        markDirty(); drawDrawer();
      };
    });
    document.onkeydown = (e) => { if (e.key === 'Escape' && open && !document.querySelector('.scrim')) closeDrawer(); };
  };
  const bind = () => { bindView(); bindDrawer(); };
  /** Deep link from Project Charter (…?activity=KEY&field=FIELD): scroll the input into view, focus it and flash it once. */
  const focusField = (name) => {
    const box = name && $(`#wdrawer [data-field="${CSS.escape(name)}"]`); if (!box) return;
    box.scrollIntoView({ block: 'center' });
    const input = box.querySelector('textarea:not([disabled]), input:not([disabled]), select:not([disabled])') || box.parentElement.querySelector(`[data-add="${CSS.escape(name)}"], #kd-add`);
    if (input) input.focus({ preventScroll: true });
    box.classList.add('is-target'); setTimeout(() => box.classList.remove('is-target'), 2200);
  };
  draw();
  if (open && qp.get('field')) focusField(qp.get('field'));
}
