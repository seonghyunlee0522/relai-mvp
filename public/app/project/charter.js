/* Overview › Project Charter — read-only view of the project's reference information.
 *
 *   Source of truth   착수 › 프로젝트 정의 (+ 프로젝트 정보: 이름·설명·고객사·기간). Nothing here is editable; every gap has a CTA
 *                     that deep-links to the exact input (definition/<tab>?activity=KEY&field=FIELD → drawer opens and focuses it).
 *   AI                GET …/charter returns the same object server/charter.js turns into the [PROJECT CHARTER] block of every
 *                     AI request, so "AI 활용" below describes what is really sent.
 *   Not here          execution status, KPI, Health (that is 프로젝트 현황). No percentage of elapsed time.
 * Document layout: section title · divider · whitespace. Only the AI Project Context strip is emphasised. */
import { api, wsApi } from '../core/api.js';
import { isPhone, pcLine } from '../core/device.js';
import { $, html, raw, todayLocal, fmtDate } from '../core/dom.js';
import { projectHead } from './guide.js';
import { planMenu, bindPlanMenu, NO_REASON } from './initiation.js';
import { definitionHref } from '../shared/lifecycle.js';

const SPARK = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg>';
/** One name for this page everywhere (UI/UX P1-2): 프로젝트 개요. 사업수행계획서 is only the downloaded document's name. */
export const CHARTER_PURPOSE = '목표·범위·일정을 한 장에서 봅니다. 사업수행계획서로 내려받을 수 있습니다.';
const CAT_ORDER = ['CLIENT', 'OWN', 'PARTNER', 'OTHER'];
const DAY = 86400000;
const dnum = (s) => Date.parse(`${s}T00:00:00Z`);

/** Multi-line free text → list when it has several lines, paragraph otherwise. */
const body = (text) => {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return '';
  return lines.length === 1 ? html`<p class="chx__p">${lines[0]}</p>` : html`<ul class="chx__ul">${raw(lines.map((l) => html`<li>${l}</li>`).join(''))}</ul>`;
};

/** The read blocks of one Charter, shared by 프로젝트 개요 (below) and the 계획 › 프로젝트 정의 task tabs (definition.js sectionView).
 * `def(activity, field)` = where an empty block's "입력 →" link goes; `ro` hides those links (phone / archived). */
export function charterParts(c, { ro, def }) {
  /* ---------- building blocks ---------- */
  const cta = (href, label) => (ro ? '' : html`<a class="link chx__cta" href="${href}" data-link>${label}</a>`);
  /** Empty state: what is missing · why it helps · where to enter it. */
  const empty = (title, why, href, label) => html`<div class="chx__empty"><b>${title}</b><p>${why}</p>${raw(cta(href, label))}</div>`;
  const block = (label, text, emptyArgs) => html`<div class="chx__blk"><h3 class="chx__lbl">${label}</h3>${raw(text ? body(text) : empty(...emptyArgs))}</div>`;
  const kv = (k, v, fallback = null) => html`<div class="chx__kv"><dt>${k}</dt><dd>${raw(v ? html`${v}` : fallback || '<span class="chx__none">미입력</span>')}</dd></div>`;
  /** A section = numbered header + AI note + inner; 프로젝트 개요 wraps it, a 프로젝트 정의 tab shows only `inner`. */
  const section = (no, key, title, ai, inner) => ({ no, key, title, ai, inner });

  /* ---------- 2. Goals & Success Criteria ---------- */
  const goals = section('2', 'goals', '목표 · 성공 기준', '요구사항과 WBS가 프로젝트 목표 및 성공 기준에 기여하는지 판단합니다.', html`
    ${raw(block('프로젝트 목표', c.goals, ['프로젝트 목표가 아직 작성되지 않았습니다.', '이 프로젝트로 달성하려는 결과를 작성하면 AI가 요구사항과 WBS가 그 방향에 맞는지 검토할 수 있습니다.', def('GOALS', 'goal'), '프로젝트 목표 입력 →']))}
    ${raw(block('성공 기준', c.successCriteria, ['성공 기준이 아직 작성되지 않았습니다.', '프로젝트가 언제 성공적으로 완료되었다고 볼 수 있는지 작성하면 AI가 WBS와 프로젝트 상태를 판단하는 데 활용할 수 있습니다.', def('GOALS', 'success_criteria'), '성공 기준 입력 →']))}`);

  /* ---------- 3. 적용 환경 & Deliverables (batch7 #2·#3) ---------- */
  const env = c.environments || { rows: [] }; const dl = c.deliverableList || [];
  const envTable = env.rows.length ? html`<div class="chx__tblw"><table class="chx__tbl" data-env-table><thead><tr><th>구분</th><th>지원</th><th>미지원</th></tr></thead><tbody>
      ${raw(env.rows.map(([k, sup, uns]) => html`<tr><td class="chx__nm">${k}</td><td>${sup || '-'}</td><td>${uns || '-'}</td></tr>`).join(''))}</tbody></table></div>`
    : empty('적용 환경이 아직 정해지지 않았습니다.', '결과물이 동작해야 할 기기·브라우저를 고르면 테스트와 AI가 그 환경을 기준으로 확인합니다.', def('SCOPE', 'environments'), '적용 환경 선택 →');
  const memo = [c.scope.inScope, c.scope.outOfScope && String(c.scope.outOfScope).split(/\r?\n/).filter(Boolean).map((x) => `제외: ${x}`).join('\n')].filter(Boolean).join('\n');
  const dlBlock = dl.length ? html`<div class="chx__tblw"><table class="chx__tbl" data-dl-table><thead><tr><th>단계</th><th>산출물</th><th>구분</th></tr></thead><tbody>
      ${raw(dl.map((x) => html`<tr><td>${x.phase}</td><td class="chx__nm">${x.name}</td><td>${x.level_label}</td></tr>`).join(''))}</tbody></table></div>`
    : c.deliverables ? body(c.deliverables)
      : empty('주요 산출물이 아직 정해지지 않았습니다.', '표준 산출물 목록에서 필수·선택을 고르면 사업수행계획서 표와 종료 점검에 그대로 쓰입니다.', def('SCOPE', 'deliverables'), '산출물 고르기 →');
  const scope = section('3', 'scope', '적용 환경 · 산출물', '결과물이 동작해야 할 환경과 납품할 산출물을 기준으로 테스트와 WBS에 빠진 것이 없는지 검토합니다. 기능 범위는 요구사항의 범위(IN/OUT)로 판단합니다.', html`
    <div class="chx__blk"><h3 class="chx__lbl">적용 환경</h3>${raw(envTable)}</div>
    ${raw(memo ? html`<div class="chx__blk"><h3 class="chx__lbl">환경·조건</h3>${raw(body(memo))}</div>` : '')}
    <div class="chx__blk"><h3 class="chx__lbl">주요 산출물${raw(dl.length ? html` <small>필수 ${dl.filter((x) => x.level === 'REQUIRED').length}건</small>` : '')}</h3>${raw(dlBlock)}</div>`);

  /* ---------- 4. Stakeholders & Governance ---------- */
  const sh = [...c.stakeholders].sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
  const shTable = sh.length ? html`<div class="chx__tblw"><table class="chx__tbl"><thead><tr><th>이름</th><th>소속</th><th>구분</th><th>역할</th><th>주요 책임</th></tr></thead><tbody>
      ${raw(sh.map((s) => html`<tr><td class="chx__nm">${s.name}</td><td>${[s.org, s.department].filter(Boolean).join(' · ') || '-'}</td><td><span class="chx__cat chx__cat--${s.category.toLowerCase()}">${s.category_label}</span></td><td>${s.role || '-'}</td><td>${s.responsibility || '-'}</td></tr>`).join(''))}</tbody></table></div>`
    : empty('관계자가 아직 등록되지 않았습니다.', '고객사·당사·협력사의 담당자와 역할을 등록하면 AI가 업무 담당자와 의사결정 상대를 이해할 수 있습니다.', def('STAKEHOLDERS'), '관계자 입력 →');
  const governance = block('의사결정 / 승인 체계', c.governance, ['의사결정 / 승인 체계가 정의되지 않았습니다.', '범위·일정 변경을 누가 어떤 절차로 승인하는지 작성하면 AI가 변경 요청의 다음 절차를 정확하게 안내할 수 있습니다.', def('OPERATIONS', 'decisions'), '의사결정 체계 입력 →']);
  const stake = section('4', 'stakeholders', raw(html`관계자 및 의사결정 구조`), '프로젝트 참여자, 업무 담당자 및 의사결정 구조를 이해하는 데 활용합니다.', html`
    <div class="chx__blk"><h3 class="chx__lbl">관계자${raw(sh.length ? html` <small>${sh.length}명</small>` : '')}</h3>${raw(shTable)}</div>
    ${raw(governance)}`);

  /* ---------- 5. Timeline & Milestones ---------- */
  const tl = c.timeline; const today = todayLocal();
  const timeline = () => {
    if (!tl.startDate || !tl.endDate) return '';
    const s = dnum(tl.startDate); const e = dnum(tl.endDate); const span = Math.max(e - s, DAY);
    // milestones after END sit in a gray "종료 후" zone right of END (안정화·하자보수) instead of piling up on the END marker
    const late = tl.milestones.filter((m) => m.date && m.date > tl.endDate);
    const lateMax = late.length ? Math.max(...late.map((m) => dnum(m.date))) : e;
    const MAIN = late.length ? 86 : 100;
    const pos = (d) => { const t = dnum(d); if (t > e && late.length) return MAIN + 2 + ((t - e) / Math.max(lateMax - e, DAY)) * (100 - MAIN - 4); return Math.min(MAIN, Math.max(0, ((t - s) / span) * MAIN)); };
    const t = dnum(today);
    const phase = t < s ? 'before' : t > e ? 'after' : 'during';
    const dated = tl.milestones.filter((m) => m.date);
    const lastX = { up: -100, dn: -100 };
    const marks = dated.map((m, i) => {
      const x = pos(m.date); const past = m.date < today || m.status === 'COMPLETED';
      const out = m.date < tl.startDate || m.date > tl.endDate;
      const edge = x > 82 ? 'is-r' : x < 18 ? 'is-l' : '';
      const side = i % 2 ? 'dn' : 'up';
      const crowd = x - lastX[side] < 11; if (!crowd) lastX[side] = x;   // a label that would overlap the previous one on its side → tooltip only
      return html`<li class="chtl__ms ${past ? 'is-past' : ''} ${out && m.date > tl.endDate ? 'is-late' : ''} ${crowd ? 'is-crowd' : ''} is-${side} ${edge}" style="left:${x.toFixed(2)}%" tabindex="0" title="${m.title} · ${fmtDate(m.date)}${out ? (m.date > tl.endDate ? ' (종료 후)' : ' (프로젝트 기간 밖)') : ''}">
        <i aria-hidden="true"></i><span><b>${m.title}</b><time>${fmtDate(m.date)}</time></span></li>`;
    }).join('');
    const now = phase === 'during' ? html`<div class="chtl__today" style="left:${pos(today).toFixed(2)}%"><span>오늘 · ${fmtDate(today)}</span></div>` : '';
    const state = phase === 'before' ? '프로젝트 시작 전' : phase === 'after' ? '프로젝트 기간 종료' : '';
    return html`<div class="chtl ${dated.length ? '' : 'chtl--bare'}" role="img" aria-label="프로젝트 기간 ${fmtDate(tl.startDate)} ~ ${fmtDate(tl.endDate)}, 오늘 ${fmtDate(today)}${state ? ` (${state})` : ''}, 마일스톤 ${dated.length}개">
      <div class="chtl__ends"><span><small>시작</small>${fmtDate(tl.startDate)}</span>${raw(state ? html`<em class="chtl__state is-${phase}">${state} · 오늘 ${fmtDate(today)}</em>` : '')}<span><small>종료</small>${fmtDate(tl.endDate)}</span></div>
      <div class="chtl__track">${raw(late.length ? `<div class="chtl__after" style="left:${MAIN}%"><span>종료 후</span></div>` : '')}<div class="chtl__line" style="right:${100 - MAIN}%"><i class="chtl__done" style="width:${phase === 'before' ? 0 : phase === 'after' ? 100 : pos(today).toFixed(2)}%"></i></div>
        <span class="chtl__end chtl__end--s" aria-hidden="true"></span><span class="chtl__end chtl__end--e" aria-hidden="true" style="left:${MAIN}%"></span>
        <ol class="chtl__mss">${raw(marks)}</ol>${raw(now)}</div>
    </div>`;
  };
  const msList = tl.milestones.length ? html`<ol class="chx__ml">${raw(tl.milestones.map((m) => html`<li class="${m.date && m.date < today ? 'is-past' : ''}"><time>${m.date ? fmtDate(m.date) : '날짜 미정'}</time><span>${m.title}</span>${raw(m.source === 'WBS' ? html`<small>WBS ${m.wbs_code}</small>` : '')}</li>`).join(''))}</ol>`
    : empty('주요 마일스톤이 아직 등록되지 않았습니다.', '주요 의사결정 및 완료 시점을 작성하면 AI가 남은 주요 작업을 더 정확하게 판단할 수 있습니다.', def('MILESTONES', 'key_dates'), '마일스톤 입력 →');
  const time = section('5', 'timeline', raw(html`일정 및 마일스톤`), '현재 진행 상황과 남은 주요 일정을 기준으로 일정 위험과 다음 작업을 판단합니다.', html`${raw(timeline())}${raw(msList)}`);

  /* ---------- 6. Assumptions, Constraints & Risks ---------- */
  const acr = section('6', 'conditions', '전제 · 제약 · 초기 리스크', 'WBS 생성, 요구사항 검토 및 변경 영향 분석 시 프로젝트의 전제조건과 제약, 위험요소를 함께 고려합니다.', html`
    ${raw(block('전제', c.assumptions, ['가정사항이 작성되지 않았습니다.', '계획의 전제 조건(예: 고객사가 연동 권한을 일정 내 제공)을 작성하면 AI가 그 전제가 깨질 때의 영향을 함께 검토할 수 있습니다.', def('SCOPE', 'assumptions'), '가정사항 입력 →']))}
    ${raw(block('제약', c.constraints, ['제약사항이 작성되지 않았습니다.', '내부망 개발, 오픈 일정 고정처럼 수행을 제한하는 조건을 작성하면 AI가 제약에 어긋나는 제안을 하지 않습니다.', def('SCOPE', 'constraints'), '제약사항 입력 →']))}
    ${raw(block('초기 리스크', c.risks, ['초기 리스크가 작성되지 않았습니다.', '착수 시점에 인지한 위험을 작성하면 AI가 WBS와 변경 영향을 검토할 때 함께 고려합니다.', def('SCOPE', 'initial_risks'), '초기 리스크 입력 →']))}`);

  /* ---------- 7. Operating Model ---------- */
  const om = c.operatingModel;
  const ops = section('7', 'operating', '운영 방식', '프로젝트의 커뮤니케이션, 변경관리 및 검수 방식을 고려하여 적절한 다음 절차를 안내합니다.', html`
    ${raw(block('커뮤니케이션', om.communication, ['커뮤니케이션 방식이 작성되지 않았습니다.', '정기 회의·보고·소통 채널을 작성하면 AI가 다음 절차를 안내할 때 이 방식을 따릅니다.', def('OPERATIONS', 'meetings'), '커뮤니케이션 방식 입력 →']))}
    ${raw(block('변경 관리', om.changeManagement, ['변경관리 방식이 작성되지 않았습니다.', '변경 요청을 어떻게 검토·승인하는지 작성하면 AI가 변경 영향 분석 후 필요한 승인 절차를 안내할 수 있습니다.', def('OPERATIONS', 'change_management'), '변경관리 방식 입력 →']))}
    ${raw(block('검수 · 완료', om.acceptance, ['검수 / 완료 기준이 작성되지 않았습니다.', '무엇이 충족되면 검수·완료로 보는지 작성하면 AI가 테스트와 검수 준비 상태를 판단하는 데 활용합니다.', def('OPERATIONS', 'acceptance'), '검수 / 완료 기준 입력 →']))}`);

  /* ---------- 8. 착수보고회 · 착수 결과 승인 (Phase 1 v2) ---------- */
  const k = c.kickoff; const a = c.approval;
  const fmtDT = (v) => (!v ? '' : `${fmtDate(v.slice(0, 10))}${v.length > 10 ? ` ${v.slice(11, 16)}` : ''}`);
  const apvState = !a ? '' : a.status === 'COMPLETED' ? '<span class="chx__badge is-ok">승인됨</span>' : a.status === 'REAPPROVAL' ? '<span class="chx__badge is-crit">확인 필요 · 재승인 필요</span>' : '<span class="chx__badge">미승인</span>';
  const approvalInner = !a ? '' : html`<div class="chx__blk"><h3 class="chx__lbl">착수 결과 승인 ${raw(apvState)}</h3>
    ${raw(a.status === 'TODO' ? (a.bypass ? html`<p class="chx__p chx__bypass">미승인 — ${a.bypass.reason === NO_REASON ? NO_REASON : `사유: ${a.bypass.reason}`} (${[a.bypass.date, a.bypass.name].filter(Boolean).join(' · ')})</p>` : empty('착수 결과 승인 기록이 없습니다.', '사업수행계획서를 고객에게 보내고 승인 회신을 받으면 기록하세요. 승인된 목표·범위·일정이 이후 요구사항·변경·검수의 기준이 됩니다.', def('APPROVAL'), '승인 기록 →'))
      : html`<dl class="chx__kvs">${raw(kv('승인자', a.approver ? `${a.approver.name}${a.approver.title ? ` ${a.approver.title}` : ''}` : ''))}${raw(kv('승인일', a.date ? fmtDate(a.date) : ''))}${raw(kv('승인 방법', a.method_label))}${raw(kv('근거', a.evidence))}</dl>
        ${raw(a.status === 'REAPPROVAL' ? '<p class="chx__p chx__bypass">승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요.</p>' : '')}${raw(a.conditions ? html`<h3 class="chx__lbl">조건 / 보완 요청</h3>${raw(body(a.conditions))}` : '')}`)}</div>`;
  const kickInner = !k || k.skipped ? '' : html`<div class="chx__blk"><h3 class="chx__lbl">착수보고회</h3>
    ${raw(k.status === 'COMPLETED' ? html`<dl class="chx__kvs">${raw(kv('일시', fmtDT(k.datetime)))}${raw(kv('장소/방식', k.place))}${raw(kv('참석자', k.attendees.map((x) => x.name).join(', ')))}</dl>${raw(k.decisions.length ? html`<h3 class="chx__lbl">결정사항</h3><ul class="chx__ul">${raw(k.decisions.map((x) => html`<li>${x}</li>`).join(''))}</ul>` : '')}`
      : empty(k.datetime ? `착수보고회 예정 · ${fmtDT(k.datetime)}` : '착수보고회가 아직 열리지 않았습니다.', '착수보고회에서 목표·범위·일정을 고객과 함께 확인하고, 결과를 기록하면 여기에 표시됩니다.', def('KICKOFF'), '착수보고회 준비 →'))}</div>`;
  const gate = a || (k && !k.skipped) ? section('8', 'approval', raw(html`착수보고회 · 승인`), '승인된 목표·범위·일정을 기준으로 이후 변경 요청과 검수를 판단합니다.', html`${raw(kickInner)}${raw(approvalInner)}`) : '';

  return { empty, block, kv, goals, scope, stake, shTable, governance, time, acr, ops, gate, kickInner, approvalInner };
}

export async function charterPage(id) {
  const main = $('#main');
  const [g, r] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/charter`))]);
  const p = g.project; const c = r.charter; const isArch = p.status === 'ARCHIVED'; const ro = isArch || isPhone();   // phone = view mode
  document.title = `프로젝트 개요 — ${p.name} — RELAI`;
  const u = `/app/projects/${p.id}`;
  const def = (activity, field) => definitionHref(p.id, activity, field);
  const info = (field) => `${u}/edit?focus=${field}`;

  const parts = charterParts(c, { ro, def });
  const { empty, kv } = parts;
  const aiNote = (text) => html`<p class="chx__ai"><span class="chx__aik">✦ AI 활용</span>${text}</p>`;
  const section = (no, key, title, ai, inner) => html`<section class="chx__sec" id="ch-${key}" aria-labelledby="ch-${key}-t">
    <header class="chx__sh"><span class="chx__no mono">${no}</span><h2 id="ch-${key}-t">${title}</h2></header>
    ${raw(aiNote(ai))}${raw(inner)}</section>`;
  const S = (x) => (x ? section(x.no, x.key, x.title, x.ai, x.inner) : '');
  const tl = c.timeline; const today = todayLocal(); const a = c.approval;

  /* ---------- AI Project Context (always on top, compact) ---------- */
  /** Every Charter item once: section · label · filled? · where to enter it. Drives the fill count, the outline and the "보완" list. */
  const ITEMS = [
    ['profile', '프로젝트 설명', c.profile.description, info('description')], ['profile', '프로젝트 유형', c.profile.project_type, def('PROFILE', 'project_type')],
    ['goals', '프로젝트 목표', c.goals, def('GOALS', 'goal')], ['goals', '성공 기준', c.successCriteria, def('GOALS', 'success_criteria')],
    ['scope', '적용 환경', (c.environments || {}).summary, def('SCOPE', 'environments')], ['scope', '주요 산출물', (c.deliverableList || []).length || c.deliverables, def('SCOPE', 'deliverables')],
    ['stakeholders', '관계자', c.stakeholders.length, def('STAKEHOLDERS')], ['stakeholders', '의사결정 / 승인 체계', c.governance, def('OPERATIONS', 'decisions')],
    ['timeline', '주요 마일스톤', c.timeline.milestones.length, def('MILESTONES', 'key_dates')],
    ['conditions', '가정사항', c.assumptions, def('SCOPE', 'assumptions')], ['conditions', '제약사항', c.constraints, def('SCOPE', 'constraints')], ['conditions', '초기 리스크', c.risks, def('SCOPE', 'initial_risks')],
    ['operating', '커뮤니케이션', c.operatingModel.communication, def('OPERATIONS', 'meetings')], ['operating', '변경관리 방식', c.operatingModel.changeManagement, def('OPERATIONS', 'change_management')], ['operating', '검수 / 완료 기준', c.operatingModel.acceptance, def('OPERATIONS', 'acceptance')],
  ].map(([sec, label, v, href]) => ({ sec, label, ok: Boolean(v), href }));
  const nFilled = ITEMS.filter((x) => x.ok).length;
  const hero = html`<section class="chai" aria-labelledby="chaiT">
    <span class="chai__mark">${raw(SPARK)}</span>
    <div class="chai__b">
      <div class="chai__k" id="chaiT">RELAI AI 프로젝트 맥락</div>
      <p class="chai__lead">RELAI AI는 프로젝트 개요를 기준으로 이 프로젝트를 이해합니다.</p>
      <p class="chai__d">프로젝트의 목표, 범위, 성공 기준, 일정, 관계자와 수행 조건을 바탕으로 요구사항을 검토하고, WBS를 구성하며, 변경 영향을 분석하고 다음 작업을 제안합니다.</p>
      <p class="chai__em">정보를 구체적으로 입력할수록 AI가 프로젝트 상황을 더 정확하게 판단할 수 있습니다.</p>
    </div>
    ${raw(ro ? '' : html`<div class="chai__side"><a class="btn btn--secondary btn--sm" href="${u}/definition" data-link>프로젝트 정의에서 정보 보완 →</a></div>`)}
  </section>`;

  /* ---------- 1. Project Profile ---------- */
  const pf = c.profile;
  const profile = section('1', 'profile', '기본 정보', '프로젝트의 배경, 유형, 수행 기간을 바탕으로 프로젝트 전체 맥락을 이해합니다.', html`
    <h3 class="chx__name">${pf.name}</h3>
    ${raw(pf.description ? html`<div class="chx__blk chx__blk--lead">${raw(body(pf.description))}</div>`
      : empty('프로젝트 설명이 아직 작성되지 않았습니다.', '프로젝트의 배경과 목적을 구체적으로 작성하면 AI가 요구사항과 WBS를 더 정확하게 해석할 수 있습니다.', info('description'), '프로젝트 설명 입력 →'))}
    <dl class="chx__kvs">
      ${raw(kv('고객사', pf.client))}
      ${raw(kv('수행사', pf.performer))}
      ${raw(kv('시작일', pf.start_date ? fmtDate(pf.start_date) : ''))}
      ${raw(kv('종료일', pf.end_date ? fmtDate(pf.end_date) : ''))}
    </dl>
    <div class="chx__blk"><h3 class="chx__lbl">프로젝트 기본 특성${raw(ro ? '' : html` <a class="link chx__cta chx__cta--in" href="${def('PROFILE')}" data-link>수정 →</a>`)}</h3>
      <dl class="chx__kvs chx__kvs--traits">${raw((pf.traits || []).map((t) => html`<div class="chx__kv"><dt>${t.label}</dt><dd>${raw(t.value && t.value !== 'TBD' ? html`${t.value_label}`
        : t.field === 'project_type' && pf.project_type ? html`${pf.project_type}` : html`<span class="chx__none">${t.value_label}</span>`)}</dd></div>`).join(''))}</dl></div>`);

  /* ---------- right rail: outline (scroll-spy) · next milestone · what to complete · fill status ---------- */
  const SECTIONS = [['profile', '기본 정보'], ['goals', '목표 · 성공 기준'], ['scope', '적용 환경 · 산출물'], ['stakeholders', '관계자 · 의사결정'], ['timeline', '일정 · 마일스톤'], ['conditions', '전제 · 제약 · 초기 리스크'], ['operating', '운영 방식'], ...(parts.gate ? [['approval', '착수보고회 · 승인']] : [])];
  const missing = ITEMS.filter((x) => !x.ok);
  const nextMs = tl.milestones.find((m) => m.date && m.date >= today);
  const dday = nextMs ? Math.round((dnum(nextMs.date) - dnum(today)) / DAY) : null;
  const rail = html`<aside class="chr" aria-label="프로젝트 개요 요약">
    <nav class="chr__box chr__toc" aria-label="목차"><div class="chr__k">목차</div><ol>${raw(SECTIONS.map(([k, t], i) => {
      const its = ITEMS.filter((x) => x.sec === k); const n = its.filter((x) => x.ok).length;
      const tc = k === 'approval' ? (a && a.status === 'COMPLETED' ? '✓' : a && a.status === 'REAPPROVAL' ? '!' : '-') : n === its.length ? '✓' : `${n}/${its.length}`;
      return html`<li><button type="button" class="chr__ti" data-goto="ch-${k}"><span class="chr__tn mono">${i + 1}</span><span class="chr__tt">${t}</span><span class="chr__tc ${tc === '✓' ? 'is-ok' : ''}">${tc}</span></button></li>`;
    }).join(''))}</ol></nav>
    ${raw(nextMs ? html`<div class="chr__box"><div class="chr__k">다음 마일스톤</div><div class="chr__ms"><b>${nextMs.title}</b><span>${fmtDate(nextMs.date)} · ${dday === 0 ? 'D-Day' : `D-${dday}`}</span></div></div>` : '')}
    ${raw(missing.length && !ro ? html`<div class="chr__box"><div class="chr__k">보완하면 AI 판단이 정확해지는 항목 <em>${missing.length}</em></div>
      <ul class="chr__miss">${raw(missing.slice(0, 6).map((x) => html`<li><a href="${x.href}" data-link><span>${x.label}</span><i aria-hidden="true">입력 →</i></a></li>`).join(''))}</ul>
      ${raw(missing.length > 6 ? html`<a class="link chr__more" href="${u}/definition" data-link>외 ${missing.length - 6}개 · 프로젝트 정의에서 보기 →</a>` : '')}</div>` : '')}
    <div class="chr__box">
      <div class="chr__k">기준정보 작성 현황</div>
      <div class="chr__fill"><b>${nFilled}</b><span>/ ${ITEMS.length} 항목</span></div>
      <div class="chr__seg" role="img" aria-label="${ITEMS.length}개 중 ${nFilled}개 작성">${raw(ITEMS.map((x) => `<i class="${x.ok ? 'is-ok' : ''}"></i>`).join(''))}</div>
      <p class="chr__hint">${nFilled === ITEMS.length ? 'RELAI AI가 모든 기준정보를 참고하고 있습니다.' : '비어 있는 항목은 AI가 추정하지 않고 판단에서 제외합니다.'}</p>
    </div>
  </aside>`;

  main.innerHTML = html`<div class="page page--wide page--flow chp">
    ${raw(projectHead(p, g, { tab: 'overview-charter', title: '프로젝트 개요' }))}
    <div class="chl"><div class="chx">
      <div class="chx__head"><div class="chx__ht"><h1>프로젝트 개요</h1><p>${CHARTER_PURPOSE}</p></div>${raw(planMenu())}</div>
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. 프로젝트 개요는 조회만 할 수 있습니다.</div>' : pcLine())}
      ${raw(hero)}
      ${raw(profile)}${raw(S(parts.goals))}${raw(S(parts.scope))}${raw(S(parts.stake))}${raw(S(parts.time))}${raw(S(parts.acr))}${raw(S(parts.ops))}${raw(S(parts.gate))}
      <p class="chx__src">이 화면은 조회 전용입니다. 모든 내용은 <a class="link" href="${u}/definition" data-link>01 착수 › 프로젝트 정의</a>${raw(ro ? '' : html`와 <a class="link" href="${u}/edit" data-link>프로젝트 정보</a>`)}에서 관리됩니다.</p>
    </div>${raw(rail)}</div>
  </div>`;

  // layout-fit: on PC the document action sits with the page's other header actions (title row, right), like every work screen;
  // the phone keeps it on the document head (the phone header has no action slot).
  const hr = main.querySelector('.phead__r'); const pm = main.querySelector('.chx__head .pmenu');
  if (!isPhone() && hr && pm) { hr.prepend(pm); main.querySelector('.chx__head').remove(); }
  bindPlanMenu(main, p.id);
  // outline: smooth-scroll without touching the URL (a hash change would re-render the SPA), highlight the section in view
  main.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => { const el = document.getElementById(b.dataset.goto); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
  if ('IntersectionObserver' in window) {
    const btn = (id) => main.querySelector(`[data-goto="${id}"]`);
    const seen = new Map();
    const io = new IntersectionObserver((es) => {
      for (const e of es) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : null);
      const cur = [...seen.entries()].filter(([, t]) => t !== null).sort((a, b) => a[1] - b[1])[0];
      if (!cur) return;
      main.querySelectorAll('.chr__ti.is-cur').forEach((x) => x.classList.remove('is-cur'));
      const b = btn(cur[0]); if (b) b.classList.add('is-cur');
    }, { rootMargin: '-80px 0px -55% 0px' });
    main.querySelectorAll('.chx__sec').forEach((sec) => io.observe(sec));
  }
}
