/* Overview › Project Chater — read-only view of the project's reference information.
 *
 *   Source of truth   착수 › 프로젝트 정의 (+ 프로젝트 정보: 이름·설명·고객사·기간). Nothing here is editable; every gap has a CTA
 *                     that deep-links to the exact input (definition?activity=KEY&field=FIELD → drawer opens and focuses it).
 *   AI                GET …/charter returns the same object server/charter.js turns into the [PROJECT CHATER] block of every
 *                     AI request, so "AI 활용" below describes what is really sent.
 *   Not here          execution status, KPI, Health (that is 프로젝트 현황). No percentage of elapsed time.
 * Document layout: section title · divider · whitespace. Only the AI Project Context strip is emphasised. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw, todayLocal, fmtDate } from '../core/dom.js';
import { projectHead } from './guide.js';

const SPARK = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg>';
const CAT_ORDER = ['CLIENT', 'OWN', 'PARTNER', 'OTHER'];
const DAY = 86400000;
const dnum = (s) => Date.parse(`${s}T00:00:00Z`);

/** Multi-line free text → list when it has several lines, paragraph otherwise. */
const body = (text) => {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return '';
  return lines.length === 1 ? html`<p class="chx__p">${lines[0]}</p>` : html`<ul class="chx__ul">${raw(lines.map((l) => html`<li>${l}</li>`).join(''))}</ul>`;
};

export async function charterPage(id) {
  const main = $('#main');
  const [g, r] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/charter`))]);
  const p = g.project; const c = r.charter; const ro = p.status === 'ARCHIVED';
  document.title = `Project Chater — ${p.name} — RELAI`;
  const u = `/app/projects/${p.id}`;
  const def = (activity, field) => `${u}/definition?activity=${activity}${field ? `&field=${field}` : ''}`;
  const info = (field) => `${u}/edit?focus=${field}`;

  /* ---------- building blocks ---------- */
  const cta = (href, label) => (ro ? '' : html`<a class="link chx__cta" href="${href}" data-link>${label}</a>`);
  /** Empty state: what is missing · why it helps · where to enter it. */
  const empty = (title, why, href, label) => html`<div class="chx__empty"><b>${title}</b><p>${why}</p>${raw(cta(href, label))}</div>`;
  const aiNote = (text) => html`<p class="chx__ai"><span class="chx__aik">✦ AI 활용</span>${text}</p>`;
  const block = (label, text, emptyArgs) => html`<div class="chx__blk"><h3 class="chx__lbl">${label}</h3>${raw(text ? body(text) : empty(...emptyArgs))}</div>`;
  const section = (no, key, title, ai, inner) => html`<section class="chx__sec" id="ch-${key}" aria-labelledby="ch-${key}-t">
    <header class="chx__sh"><span class="chx__no mono">${no}</span><h2 id="ch-${key}-t">${title}</h2></header>
    ${raw(aiNote(ai))}${raw(inner)}</section>`;

  /* ---------- AI Project Context (always on top, compact) ---------- */
  /** Every Charter item once: section · label · filled? · where to enter it. Drives the fill count, the outline and the "보완" list. */
  const ITEMS = [
    ['profile', '프로젝트 설명', c.profile.description, info('description')], ['profile', '프로젝트 유형', c.profile.project_type, def('GOALS', 'project_type')],
    ['goals', '프로젝트 목표', c.goals, def('GOALS', 'goal')], ['goals', '성공 기준', c.successCriteria, def('GOALS', 'success_criteria')],
    ['scope', '수행 범위', c.scope.inScope, def('SCOPE', 'scope_in')], ['scope', '제외 범위', c.scope.outOfScope, def('SCOPE', 'scope_out')], ['scope', '주요 산출물', c.deliverables, def('SCOPE', 'deliverables')],
    ['stakeholders', '이해관계자', c.stakeholders.length, def('STAKEHOLDERS')], ['stakeholders', '의사결정 / 승인 체계', c.governance, def('OPERATIONS', 'decisions')],
    ['timeline', '주요 마일스톤', c.timeline.milestones.length, def('MILESTONES', 'key_dates')],
    ['conditions', '가정사항', c.assumptions, def('SCOPE', 'assumptions')], ['conditions', '제약사항', c.constraints, def('SCOPE', 'constraints')], ['conditions', '초기 리스크', c.risks, def('SCOPE', 'initial_risks')],
    ['operating', '커뮤니케이션', c.operatingModel.communication, def('OPERATIONS', 'meetings')], ['operating', '변경관리 방식', c.operatingModel.changeManagement, def('OPERATIONS', 'change_management')], ['operating', '검수 / 완료 기준', c.operatingModel.acceptance, def('OPERATIONS', 'acceptance')],
  ].map(([sec, label, v, href]) => ({ sec, label, ok: Boolean(v), href }));
  const nFilled = ITEMS.filter((x) => x.ok).length;
  const hero = html`<section class="chai" aria-labelledby="chaiT">
    <span class="chai__mark">${raw(SPARK)}</span>
    <div class="chai__b">
      <div class="chai__k" id="chaiT">RELAI AI Project Context</div>
      <p class="chai__lead">RELAI AI는 Project Chater를 기준으로 이 프로젝트를 이해합니다.</p>
      <p class="chai__d">프로젝트의 목표, 범위, 성공 기준, 일정, 이해관계자와 수행 조건을 바탕으로 요구사항을 검토하고, WBS를 구성하며, 변경 영향을 분석하고 다음 작업을 제안합니다.</p>
      <p class="chai__em">정보를 구체적으로 입력할수록 AI가 프로젝트 상황을 더 정확하게 판단할 수 있습니다.</p>
    </div>
    ${raw(ro ? '' : html`<div class="chai__side"><a class="btn btn--secondary btn--sm" href="${u}/definition" data-link>프로젝트 정의에서 정보 보완 →</a></div>`)}
  </section>`;

  /* ---------- 1. Project Profile ---------- */
  const pf = c.profile;
  const kv = (k, v, fallback = null) => html`<div class="chx__kv"><dt>${k}</dt><dd>${raw(v ? html`${v}` : fallback || '<span class="chx__none">미입력</span>')}</dd></div>`;
  const profile = section('1', 'profile', 'Project Profile', '프로젝트의 배경, 유형, 수행 기간을 바탕으로 프로젝트 전체 맥락을 이해합니다.', html`
    <h3 class="chx__name">${pf.name}</h3>
    ${raw(pf.description ? html`<div class="chx__blk chx__blk--lead">${raw(body(pf.description))}</div>`
      : empty('프로젝트 설명이 아직 작성되지 않았습니다.', '프로젝트의 배경과 목적을 구체적으로 작성하면 AI가 요구사항과 WBS를 더 정확하게 해석할 수 있습니다.', info('description'), '프로젝트 설명 입력 →'))}
    <dl class="chx__kvs">
      ${raw(kv('고객사', pf.client))}
      ${raw(kv('수행사', pf.performer))}
      ${raw(kv('프로젝트 유형', pf.project_type, ro ? null : html`<span class="chx__none">미입력</span> <a class="link chx__cta chx__cta--in" href="${def('GOALS', 'project_type')}" data-link>유형 입력 →</a>`))}
      ${raw(kv('시작일', pf.start_date ? fmtDate(pf.start_date) : ''))}
      ${raw(kv('종료일', pf.end_date ? fmtDate(pf.end_date) : ''))}
    </dl>`);

  /* ---------- 2. Goals & Success Criteria ---------- */
  const goals = section('2', 'goals', 'Goals & Success Criteria', '요구사항과 WBS가 프로젝트 목표 및 성공 기준에 기여하는지 판단합니다.', html`
    ${raw(block('Project Goals', c.goals, ['프로젝트 목표가 아직 작성되지 않았습니다.', '이 프로젝트로 달성하려는 결과를 작성하면 AI가 요구사항과 WBS가 그 방향에 맞는지 검토할 수 있습니다.', def('GOALS', 'goal'), '프로젝트 목표 입력 →']))}
    ${raw(block('Success Criteria', c.successCriteria, ['성공 기준이 아직 작성되지 않았습니다.', '프로젝트가 언제 성공적으로 완료되었다고 볼 수 있는지 작성하면 AI가 WBS와 프로젝트 상태를 판단하는 데 활용할 수 있습니다.', def('GOALS', 'success_criteria'), '성공 기준 입력 →']))}`);

  /* ---------- 3. Scope & Deliverables ---------- */
  const scope = section('3', 'scope', 'Scope & Deliverables', '신규 요구사항이나 변경 요청이 프로젝트 범위에 포함되는지 판단하고, 필요한 주요 산출물이 누락되지 않았는지 검토합니다.', html`
    <div class="chx__two">
      ${raw(block('In Scope', c.scope.inScope, ['수행 범위가 정의되지 않았습니다.', '이번 프로젝트에서 하는 일을 작성하면 AI가 요구사항이 범위 안에 있는지 판단할 수 있습니다.', def('SCOPE', 'scope_in'), '수행 범위 입력 →']))}
      ${raw(block('Out of Scope', c.scope.outOfScope, ['제외 범위가 정의되지 않았습니다.', '프로젝트에서 수행하지 않는 범위를 명확하게 작성하면 Scope Creep을 줄이고 AI가 신규 요구사항의 범위 포함 여부를 판단하는 데 도움이 됩니다.', def('SCOPE', 'scope_out'), '제외 범위 입력 →']))}
    </div>
    ${raw(block('Key Deliverables', c.deliverables, ['주요 산출물이 정의되지 않았습니다.', '납품해야 할 산출물을 작성하면 AI가 WBS에 필요한 작업이 빠지지 않았는지 검토할 수 있습니다.', def('SCOPE', 'deliverables'), '주요 산출물 입력 →']))}`);

  /* ---------- 4. Stakeholders & Governance ---------- */
  const sh = [...c.stakeholders].sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
  const shTable = sh.length ? html`<div class="chx__tblw"><table class="chx__tbl"><thead><tr><th>이름</th><th>소속</th><th>구분</th><th>역할</th><th>주요 책임</th></tr></thead><tbody>
      ${raw(sh.map((s) => html`<tr><td class="chx__nm">${s.name}</td><td>${[s.org, s.department].filter(Boolean).join(' · ') || '-'}</td><td><span class="chx__cat chx__cat--${s.category.toLowerCase()}">${s.category_label}</span></td><td>${s.role || '-'}</td><td>${s.responsibility || '-'}</td></tr>`).join(''))}</tbody></table></div>`
    : empty('이해관계자가 아직 등록되지 않았습니다.', '고객사·당사·협력사의 담당자와 역할을 등록하면 AI가 업무 담당자와 의사결정 상대를 이해할 수 있습니다.', def('STAKEHOLDERS'), '이해관계자 입력 →');
  const stake = section('4', 'stakeholders', 'Stakeholders & Governance', '프로젝트 참여자, 업무 담당자 및 의사결정 구조를 이해하는 데 활용합니다.', html`
    <div class="chx__blk"><h3 class="chx__lbl">Stakeholders${raw(sh.length ? html` <small>${sh.length}명</small>` : '')}</h3>${raw(shTable)}</div>
    ${raw(block('의사결정 / 승인 체계', c.governance, ['의사결정 / 승인 체계가 정의되지 않았습니다.', '범위·일정 변경을 누가 어떤 절차로 승인하는지 작성하면 AI가 변경 요청의 다음 절차를 정확하게 안내할 수 있습니다.', def('OPERATIONS', 'decisions'), '의사결정 체계 입력 →']))}`);

  /* ---------- 5. Timeline & Milestones ---------- */
  const tl = c.timeline; const today = todayLocal();
  const timeline = () => {
    if (!tl.startDate || !tl.endDate) return '';
    const s = dnum(tl.startDate); const e = dnum(tl.endDate); const span = Math.max(e - s, DAY);
    const pos = (d) => Math.min(100, Math.max(0, ((dnum(d) - s) / span) * 100));
    const t = dnum(today);
    const phase = t < s ? 'before' : t > e ? 'after' : 'during';
    const dated = tl.milestones.filter((m) => m.date);
    const marks = dated.map((m, i) => {
      const x = pos(m.date); const past = m.date < today || m.status === 'COMPLETED';
      const out = m.date < tl.startDate || m.date > tl.endDate;
      const edge = x > 82 ? 'is-r' : x < 18 ? 'is-l' : '';
      return html`<li class="chtl__ms ${past ? 'is-past' : ''} ${i % 2 ? 'is-dn' : 'is-up'} ${edge}" style="left:${x.toFixed(2)}%" title="${m.title} · ${fmtDate(m.date)}${out ? ' (프로젝트 기간 밖)' : ''}">
        <i aria-hidden="true"></i><span><b>${m.title}</b><time>${fmtDate(m.date)}</time></span></li>`;
    }).join('');
    const now = phase === 'during' ? html`<div class="chtl__today" style="left:${pos(today).toFixed(2)}%"><span>TODAY · ${fmtDate(today)}</span></div>` : '';
    const state = phase === 'before' ? '프로젝트 시작 전' : phase === 'after' ? '프로젝트 기간 종료' : '';
    return html`<div class="chtl ${dated.length ? '' : 'chtl--bare'}" role="img" aria-label="프로젝트 기간 ${fmtDate(tl.startDate)} ~ ${fmtDate(tl.endDate)}, 오늘 ${fmtDate(today)}${state ? ` (${state})` : ''}, 마일스톤 ${dated.length}개">
      <div class="chtl__ends"><span><small>START</small>${fmtDate(tl.startDate)}</span>${raw(state ? html`<em class="chtl__state is-${phase}">${state} · 오늘 ${fmtDate(today)}</em>` : '')}<span><small>END</small>${fmtDate(tl.endDate)}</span></div>
      <div class="chtl__track"><div class="chtl__line"><i class="chtl__done" style="width:${phase === 'before' ? 0 : phase === 'after' ? 100 : pos(today).toFixed(2)}%"></i></div>
        <span class="chtl__end chtl__end--s" aria-hidden="true"></span><span class="chtl__end chtl__end--e" aria-hidden="true"></span>
        <ol class="chtl__mss">${raw(marks)}</ol>${raw(now)}</div>
    </div>`;
  };
  const msList = tl.milestones.length ? html`<ol class="chx__ml">${raw(tl.milestones.map((m) => html`<li class="${m.date && m.date < today ? 'is-past' : ''}"><time>${m.date ? fmtDate(m.date) : '날짜 미정'}</time><span>${m.title}</span>${raw(m.source === 'WBS' ? html`<small>WBS ${m.wbs_code}</small>` : '')}</li>`).join(''))}</ol>`
    : empty('주요 마일스톤이 아직 등록되지 않았습니다.', '주요 의사결정 및 완료 시점을 작성하면 AI가 현재 프로젝트의 일정 위치와 남은 주요 작업을 더 정확하게 판단할 수 있습니다.', def('MILESTONES', 'key_dates'), '마일스톤 입력 →');
  const time = section('5', 'timeline', 'Timeline & Milestones', '현재 프로젝트 진행 위치와 남은 주요 일정을 기준으로 일정 위험과 다음 작업을 판단합니다.', html`${raw(timeline())}${raw(msList)}`);

  /* ---------- 6. Assumptions, Constraints & Risks ---------- */
  const acr = section('6', 'conditions', 'Assumptions, Constraints & Risks', 'WBS 생성, 요구사항 검토 및 변경 영향 분석 시 프로젝트의 전제조건과 제약, 위험요소를 함께 고려합니다.', html`
    ${raw(block('Assumptions', c.assumptions, ['가정사항이 작성되지 않았습니다.', '계획의 전제 조건(예: 고객사가 API 권한을 일정 내 제공)을 작성하면 AI가 그 전제가 깨질 때의 영향을 함께 검토할 수 있습니다.', def('SCOPE', 'assumptions'), '가정사항 입력 →']))}
    ${raw(block('Constraints', c.constraints, ['제약사항이 작성되지 않았습니다.', '내부망 개발, 오픈 일정 고정처럼 수행을 제한하는 조건을 작성하면 AI가 제약에 어긋나는 제안을 하지 않습니다.', def('SCOPE', 'constraints'), '제약사항 입력 →']))}
    ${raw(block('Initial Risks', c.risks, ['초기 리스크가 작성되지 않았습니다.', '착수 시점에 인지한 위험을 작성하면 AI가 WBS와 변경 영향을 검토할 때 함께 고려합니다.', def('SCOPE', 'initial_risks'), '초기 리스크 입력 →']))}`);

  /* ---------- 7. Operating Model ---------- */
  const om = c.operatingModel;
  const ops = section('7', 'operating', 'Operating Model', '프로젝트의 커뮤니케이션, 변경관리 및 검수 방식을 고려하여 적절한 다음 절차를 안내합니다.', html`
    ${raw(block('Communication', om.communication, ['커뮤니케이션 방식이 작성되지 않았습니다.', '정기 회의·보고·소통 채널을 작성하면 AI가 다음 절차를 안내할 때 이 방식을 따릅니다.', def('OPERATIONS', 'meetings'), '커뮤니케이션 방식 입력 →']))}
    ${raw(block('Change Management', om.changeManagement, ['변경관리 방식이 작성되지 않았습니다.', '변경 요청을 어떻게 검토·승인하는지 작성하면 AI가 변경 영향 분석 후 필요한 승인 절차를 안내할 수 있습니다.', def('OPERATIONS', 'change_management'), '변경관리 방식 입력 →']))}
    ${raw(block('Acceptance / Completion', om.acceptance, ['검수 / 완료 기준이 작성되지 않았습니다.', '무엇이 충족되면 검수·완료로 보는지 작성하면 AI가 테스트와 검수 준비 상태를 판단하는 데 활용합니다.', def('OPERATIONS', 'acceptance'), '검수 / 완료 기준 입력 →']))}`);

  /* ---------- right rail: outline (scroll-spy) · next milestone · what to complete · fill status ---------- */
  const SECTIONS = [['profile', 'Project Profile'], ['goals', 'Goals & Success Criteria'], ['scope', 'Scope & Deliverables'], ['stakeholders', 'Stakeholders & Governance'], ['timeline', 'Timeline & Milestones'], ['conditions', 'Assumptions, Constraints & Risks'], ['operating', 'Operating Model']];
  const missing = ITEMS.filter((x) => !x.ok);
  const nextMs = tl.milestones.find((m) => m.date && m.date >= today);
  const dday = nextMs ? Math.round((dnum(nextMs.date) - dnum(today)) / DAY) : null;
  const rail = html`<aside class="chr" aria-label="Project Chater 요약">
    <nav class="chr__box chr__toc" aria-label="목차"><div class="chr__k">목차</div><ol>${raw(SECTIONS.map(([k, t], i) => {
      const its = ITEMS.filter((x) => x.sec === k); const n = its.filter((x) => x.ok).length;
      return html`<li><button type="button" class="chr__ti" data-goto="ch-${k}"><span class="chr__tn mono">${i + 1}</span><span class="chr__tt">${t}</span><span class="chr__tc ${n === its.length ? 'is-ok' : ''}">${n === its.length ? '✓' : `${n}/${its.length}`}</span></button></li>`;
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
    ${raw(projectHead(p, g, { tab: 'overview-charter', title: 'Project Chater' }))}
    <div class="chl"><div class="chx">
      <div class="chx__head"><h1>Project Chater</h1><p>프로젝트의 목표와 범위, 일정 및 수행 기준을 한 곳에서 확인합니다.</p></div>
      ${raw(ro ? '<div class="notice">보관된 프로젝트입니다. Project Chater는 조회만 할 수 있습니다.</div>' : '')}
      ${raw(hero)}
      ${raw(profile)}${raw(goals)}${raw(scope)}${raw(stake)}${raw(time)}${raw(acr)}${raw(ops)}
      <p class="chx__src">이 화면은 조회 전용입니다. 모든 내용은 <a class="link" href="${u}/definition" data-link>01 착수 › 프로젝트 정의</a>${raw(ro ? '' : html`와 <a class="link" href="${u}/edit" data-link>프로젝트 정보</a>`)}에서 관리됩니다.</p>
    </div>${raw(rail)}</div>
  </div>`;

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
