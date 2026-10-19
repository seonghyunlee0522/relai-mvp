/* RELAI 가이드 · 샘플로 보기 (/app/guide) — explains the product with the 3 sample projects (server/samples/fixtures.js).
 * Each worked example = what the screen looks like when it is filled in (a small static preview taken from the sample
 * content) + why it matters + a button that opens the same screen of the user's own copy of that sample.
 * The previews are static text, so the guide still reads when the samples were deleted; only the buttons need them.
 * Styles: sample-guide.css, every rule under .sg (loaded once from here; app.css is not touched). */
import { api } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';

const CSS_HREF = '/assets/project/sample-guide.css';
const loadCss = () => { if (document.querySelector(`link[href="${CSS_HREF}"]`)) return; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = CSS_HREF; document.head.append(l); };

/* ---------- content: one entry per sample, its key moments in lifecycle order ---------- */
const li = (xs) => raw(xs.map((x) => html`<li>${x}</li>`).join(''));
const SAMPLES = [
  { key: 'early', mark: 'A', label: '시작 단계', name: '다온생명 고객상담 챗봇 구축', where: '01 착수 완료 · 02 요구사항 정의 진행 중',
    lead: '처음 2~4주에 무엇을 적어 두면 되는지 보여 주는 샘플입니다. 목표와 범위, 마일스톤을 정하고 고객 승인을 받은 뒤 요구사항을 모으는 중입니다.',
    moments: [
      { id: 'charter', phase: '01 착수', title: '프로젝트 개요 — 목표·성공 기준·범위·산출물', path: '/definition',
        preview: () => html`<dl class="sg-kv">
          <dt>목표</dt><dd>단순 문의의 40%를 챗봇이 처리해 상담원 연결 대기 시간을 절반으로 줄인다</dd>
          <dt>성공 기준</dt><dd><ul>${li(['챗봇 단독 처리율 40% 이상 (오픈 3개월 후)', '상담원 연결 평균 대기 시간 3분 → 1분 30초', '챗봇 응답 만족도 4.0 / 5.0 이상'])}</ul></dd>
          <dt>범위 안</dt><dd>웹 챗봇 · FAQ·계약 조회 시나리오 · 상담원 연결 · 기간계 조회 연계 · 운영자 화면</dd>
          <dt>범위 밖</dt><dd>음성(ARS) 챗봇 · 보험금 청구 자동화 · 상담 콘솔 교체</dd>
          <dt>산출물</dt><dd>사업수행계획서, 요구사항 정의서, 시나리오 설계서, 화면 설계서, 테스트 결과서, 운영자 매뉴얼</dd></dl>`,
        why: '목표는 숫자로, 범위는 "안"과 "밖"을 함께 적습니다. 나중에 "이것도 해 주세요"라는 요청이 왔을 때 범위 밖 목록이 판단 근거가 되고, 성공 기준은 검수 때 무엇을 확인할지 정해 줍니다.' },
      { id: 'milestones', phase: '01 착수', title: '마일스톤 — 꼭 지켜야 할 날짜 5개', path: '/definition/milestones',
        preview: () => html`<ol class="sg-tl">${raw([['착수보고', '1주차'], ['요구사항 확정', '5주차'], ['분석·설계 완료', '9주차'], ['오픈', '22주차', '홈페이지·앱 동시 오픈'], ['프로젝트 종료', '26주차']]
          .map(([t, w, n]) => html`<li><b>${t}</b><span>${w}</span>${raw(n ? html`<small>${n}</small>` : '')}</li>`).join(''))}</ol>`,
        why: '마일스톤은 작업 목록이 아니라 고객과 약속한 날짜입니다. 5개 안팎이면 충분합니다. 이 날짜가 WBS 일정의 기준이 되고, 밀릴 것 같으면 RELAI가 리스크로 먼저 알려 줍니다.' },
      { id: 'approval', phase: '01 착수', title: '착수보고와 착수 결과 승인', path: '/definition/approval',
        preview: () => html`<dl class="sg-kv">
          <dt>착수보고</dt><dd>본사 대회의실 · 참석 6명 · 안건 6개</dd>
          <dt>결정</dt><dd><ul>${li(['음성(ARS) 챗봇은 이번 범위에서 제외', '주간 회의는 매주 화요일 10시'])}</ul></dd>
          <dt>승인</dt><dd><span class="chip chip--done">서명</span> 사업수행계획서 v1.0 서명본 수령 (스폰서 한도윤 본부장)</dd></dl>`,
        why: '착수보고에서 정한 내용을 고객 스폰서에게 승인받아 근거(서명본, 회신 메일)를 남깁니다. 승인 기록이 있어야 이후 범위 다툼에서 "처음에 이렇게 합의했다"를 보여 줄 수 있습니다.' },
      { id: 'requirements', phase: '02 요구사항 정의', title: '요구사항 — 범위 안·밖·미정을 나눠 확정', path: '/requirements',
        preview: () => html`<table class="sg-tb"><thead><tr><th>요구사항</th><th>범위</th><th>상태</th></tr></thead><tbody>${raw([
          ['FAQ 시나리오 자동 응답', '범위 안', '확정', 'done'], ['본인 인증 후 보험 계약 조회', '범위 안', '확정', 'done'], ['기간계(계약관리) 조회 연계', '범위 안', '검토 중', 'warn'],
          ['카카오톡 채널 챗봇', '미정', '작성 중', ''], ['음성(ARS) 챗봇', '범위 밖', '-', 'muted']]
          .map(([t, s, st, c]) => html`<tr><td>${t}</td><td>${s}</td><td><span class="sg-dot sg-dot--${c || 'none'}"></span>${st}</td></tr>`).join(''))}</tbody></table>`,
        why: '요청을 받은 그대로 모두 적고, 범위 안·밖·미정으로 나눈 뒤 하나씩 확정합니다. 확정된 요구사항 묶음이 기준선이 되고, 그 뒤의 추가 요청은 변경 요청으로 다룹니다.' },
    ] },
  { key: 'mid', mark: 'B', label: '구현 단계', name: '새솔유통 물류 WMS 고도화', where: '04 구현 진행 중 · 4개월째',
    lead: '한창 개발 중인 프로젝트에서 일정·위험·변경을 어떻게 관리하는지 보여 주는 샘플입니다. 주간보고는 이 데이터로 자동으로 만들어집니다.',
    moments: [
      { id: 'wbs', phase: '03 분석·설계', title: 'WBS — 단계별 작업과 마일스톤, 요구사항 연결', path: '/wbs',
        preview: () => html`<ul class="sg-wbs">${raw([
          [0, '분석·설계', '', ''], [1, '인터페이스 설계 (EDI·ERP·택배사)', '100%', '요구사항 3'], [1, '◆ 분석·설계 완료', '마일스톤', ''],
          [0, '구현', '', ''], [1, '웨이브 피킹 개발', '60%', '요구사항 1'], [1, 'PDA 화면 개발', '85%', '이슈 1'], [0, '데이터 이관 · 시험', '', '']]
          .map(([d, t, v, n]) => html`<li class="${d ? 'is-sub' : 'is-grp'}"><span>${t}</span>${raw(v ? html`<em>${v}</em>` : '')}${raw(n ? html`<small>${n}</small>` : '')}</li>`).join(''))}</ul>`,
        why: 'WBS는 해야 할 일을 단계별로 쪼갠 목록입니다. 작업마다 담당자·기간과 관련 요구사항을 연결해 두면 "이 요구사항은 어느 작업에서 만드나"와 "오늘 늦은 작업은 무엇인가"를 바로 볼 수 있습니다.' },
      { id: 'raid', phase: '04 구현', title: 'RAID — 리스크와 이슈를 나눠 기록', path: '/issues?tab=risks',
        preview: () => html`<div class="sg-card"><div class="sg-card__h"><b>RSK-001 기존 WMS 데이터 품질 (로케이션 중복·유령 재고)</b><span class="chip chip--fail">심각</span></div>
          <p>현행 데이터에 중복 로케이션과 실물 없는 재고가 섞여 있다. 그대로 옮기면 재고 정확도 목표를 못 맞춘다.</p>
          <p><b>대응(완화)</b> 이관 전 센터 전수 실사 1회 + 정제 규칙 확정. 리허설 2회로 건수·금액 대사.</p>
          <small>연결: 요구사항 「기존 WMS 데이터 이관」 · WBS 「이관 프로그램 개발」</small></div>`,
        why: '리스크는 아직 일어나지 않은 위험, 이슈는 이미 일어난 문제입니다. 리스크를 미리 적고 대응 방법과 검토일을 정해 두면, 터지기 전에 손을 쓸 수 있고 주간보고의 "의사결정 필요사항"에 자동으로 올라갑니다.' },
      { id: 'change', phase: '04 구현', title: '변경 요청 — 영향을 적고 승인받은 뒤 반영', path: '/changes',
        preview: () => html`<div class="sg-card"><div class="sg-card__h"><b>CR-001 당일 출고 건 우선 피킹 규칙 추가</b><span class="chip chip--done">승인</span></div>
          <p><b>이유</b> 당일 출고 약속(오후 3시 마감) 위반 건이 월 120건 발생</p>
          <div class="sg-chips"><span>일정 +3일</span><span>공수 +4 MD</span><span>요구사항 「웨이브 피킹」 수정</span><span>WBS 「웨이브 피킹 개발」 재작업</span></div>
          <small>고객 승인: 강민서 PM 회신 메일 (공수 4MD 추가 승인)</small></div>`,
        why: '기준선이 정해진 뒤의 추가·변경은 말로 받지 않고 변경 요청으로 남깁니다. 일정과 공수 영향을 먼저 적고 고객 승인을 받으면, 일정이 늘어난 이유가 기록으로 남아 완료보고서까지 이어집니다.' },
      { id: 'weekly', phase: '매주', title: '주간보고 — 쌓인 데이터로 자동 작성', path: '/reports',
        preview: () => html`<div class="sg-doc"><b>새솔유통 물류 WMS 고도화 주간보고</b>
          <ol>${li(['프로젝트 현황 — 단계 구현 · 상태 위험 (리스크 심각 1건) · WBS 진행률 46%', '금주 완료 — ISS-001 PDA 화면 깨짐 해결', '진행 중 — PDA 화면 개발 85% · 웨이브 피킹 개발 60%', '이슈·리스크 — ISS-002 택배사 API 지연 · RSK-001 데이터 품질', '확인 및 의사결정 필요사항 — RSK-001, RSK-002', '차주 계획 — 종료 예정 작업, 이슈 기한, 리스크 검토일'])}</ol></div>`,
        why: 'WBS·RAID·변경 요청을 평소에 적어 두면 주간보고는 버튼 한 번으로 초안이 나옵니다. 보고서를 따로 쓰는 시간 대신, 고객이 결정해야 할 일을 한눈에 보여 주는 데 집중할 수 있습니다.' },
    ] },
  { key: 'done', mark: 'C', label: '종료 직전', name: '한결건설 사내 그룹웨어 구축', where: '07 운영 · 종료만 남음',
    lead: '7단계를 모두 지난 프로젝트입니다. 검수·오픈·운영 인계를 거쳐 완료보고서와 교훈까지 남기는 끝맺음을 보여 줍니다.',
    moments: [
      { id: 'acceptance', phase: '05 시험', title: '검수 / 인수 승인 — 요구사항 전체를 고객이 확인', path: '/tests?tab=acceptance',
        preview: () => html`<div class="sg-card"><div class="sg-card__h"><b>최종 검수 — 범위 내 요구사항 7건</b><span class="chip chip--done">승인</span></div>
          <p>요구사항마다 만든 테스트를 통과한 뒤 검수를 요청했고, 고객 PM이 확인했습니다.</p>
          <small>고객 승인: 검수 확인서 서명본 (이서연 PM)</small></div>`,
        why: '검수는 착수 때 적은 성공 기준과 확정한 요구사항을 기준으로 받습니다. 서명이나 메일로 근거를 남겨 두면 "끝났다"를 객관적으로 보여 줄 수 있고, 잔금·종료 협의가 쉬워집니다.' },
      { id: 'closing', phase: '07 운영', title: '운영 인계와 완료보고서 — 교훈까지 남기고 종료', path: '/reports',
        preview: () => html`<dl class="sg-kv">
          <dt>운영 인계</dt><dd>운영 담당(정보시스템팀)에게 인계 완료</dd>
          <dt>잘한 점</dt><dd>요구사항 확정 승인을 일찍 받아 범위 논쟁이 적었다 · 이관 리허설 2회로 오픈 당일 문제가 없었다</dd>
          <dt>아쉬운 점</dt><dd>모바일 알림 지연을 시험 단계에서야 발견했다</dd>
          <dt>다음엔</dt><dd>푸시·알림은 설계 단계에서 부하 테스트를 먼저 한다</dd></dl>`,
        why: '오픈이 끝이 아닙니다. 운영 담당에게 인계하고, 완료보고서에 일정·범위·변경 결과와 교훈을 남겨야 다음 프로젝트가 같은 실수를 반복하지 않습니다. 이 샘플은 "프로젝트 종료" 한 번이면 끝나는 상태입니다.' },
    ] },
];

const sampleIds = async () => {
  try { const r = await api('GET', `/api/workspaces/${state.workspace.id}/projects?include_archived=1`); return Object.fromEntries(r.projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p.id])); }
  catch { return {}; }
};

const openBtn = (pid, path, label = '샘플에서 보기 →') => (pid
  ? html`<a class="btn btn--secondary btn--sm" href="/app/projects/${pid}${path}" data-link data-sg-open>${label}</a>`
  : '');

export async function sampleGuidePage(main = $('#main')) {
  document.title = 'RELAI 가이드 — RELAI';
  loadCss();
  const ids = await sampleIds();
  const missing = SAMPLES.some((s) => !ids[s.key]);
  const manage = state.workspace && state.workspace.role !== 'MEMBER';
  let n = 0;
  main.innerHTML = html`<div class="page page--guide sg" data-sample-guide>
    <div class="page__head"><div><h1>RELAI 가이드 · 샘플로 보기</h1>
      <p>프로젝트 관리 방법을 몰라도 괜찮습니다. 단계가 다른 샘플 프로젝트 3개로, 각 화면이 채워지면 어떤 모습인지와 왜 필요한지를 먼저 보세요.</p></div></div>
    ${raw(missing ? html`<p class="sg-note" data-sg-missing>샘플 프로젝트 일부가 삭제되어 있어 해당 화면 바로가기가 빠졌습니다. 예시 내용은 그대로 읽을 수 있습니다.${raw(manage ? ' <a class="link" href="/app/settings?tab=me#samples" data-link>설정에서 샘플 다시 추가</a>' : '')}</p>` : '')}
    <nav class="sg-pick" aria-label="샘플 프로젝트">${raw(SAMPLES.map((s) => html`<a class="sg-pick__i" href="#sg-${s.key}" data-sg-jump="${s.key}">
      <i>${s.mark}</i><span><b>${s.label}</b><small>${s.name}</small></span></a>`).join(''))}</nav>
    ${raw(SAMPLES.map((s) => html`<section class="sg-s" id="sg-${s.key}" data-sg-sample="${s.key}">
      <header class="sg-s__h"><i>${s.mark}</i><div><h2>${s.name} <span class="chip chip--sample">샘플 · ${s.label}</span></h2><p class="sg-s__w">${s.where}</p><p>${s.lead}</p></div>
        <span class="sg-s__open">${raw(openBtn(ids[s.key], '', '샘플 열기'))}</span></header>
      ${raw(s.moments.map((m) => html`<article class="sg-ex" data-sg-ex="${m.id}">
        <div class="sg-ex__h"><span class="sg-ex__n">${String(++n)}</span><div><small>${m.phase}</small><h3>${m.title}</h3></div></div>
        <div class="sg-ex__b"><div class="sg-pv" aria-label="채워진 예시">${raw(m.preview())}</div>
          <div class="sg-why"><b>왜 중요한가</b><p>${m.why}</p>${raw(openBtn(ids[s.key], m.path))}</div></div>
      </article>`).join(''))}
    </section>`).join(''))}
    <p class="sg-end">내 프로젝트에서는 <a class="link" href="/app" data-link>홈</a>의 지금 할 일이 이 순서대로 하나씩 안내합니다.</p>
  </div>`;
  // in-page jumps: smooth scroll without touching the router / history
  main.querySelectorAll('[data-sg-jump]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); const t = $(`#sg-${a.dataset.sgJump}`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
}
