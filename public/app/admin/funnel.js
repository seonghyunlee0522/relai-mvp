/* 사용 분석: first-party funnel (where people drop off), key-feature first use, top features, weekly signup cohort retention.
 * Data comes from analytics_events (server/analytics.js) and starts on the day the events table was deployed. */
import { $, html, raw } from '../core/dom.js';
import { todayKst } from '../shared/kst-date.js';
import { adminApi, errorBlock, head, kpis, n, qs, section, setQs, table } from './ui.js';

const addDays = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const p = (v) => (v === null || v === undefined ? '-' : `${v}%`);
const PRESETS = [[7, '7일'], [30, '30일'], [90, '90일']];

const funnelRows = (d) => {
  const top = Math.max(1, ...d.steps.map((s) => s.count));
  return html`<div class="afunnel afunnel--wide" data-funnel><div class="afunnel__r afunnel__h"><span>단계</span><span></span><small>사용자</small><small>전 단계</small><small>가입 대비</small></div>${raw(d.steps.map((s, i) => {
    const drop = d.biggest_drop && d.biggest_drop.key === s.key;
    return html`<div class="afunnel__r ${drop ? 'is-drop' : ''}" data-step="${s.key}"><span>${s.label}${raw(drop ? ' <em class="achip achip--bad" data-biggest-drop>가장 큰 이탈</em>' : '')}</span>
      <div class="afunnel__b"><i style="width:${Math.round((s.count / top) * 100)}%"></i></div><b data-count>${n(s.count)}</b>
      <small title="전 단계 대비">${i ? p(s.pct_prev) : ''}</small><small title="가입 대비">${i > 1 ? p(s.pct_signup) : ''}</small></div>`;
  }).join(''))}
    <p class="hint">기간 안에 가입한 사용자가 이후 각 단계에 도달했는지 셉니다. 랜딩 방문은 기간 안의 익명 방문 수입니다(로그인 사용자·봇 제외). 샘플 프로젝트와 운영자 계정은 빠집니다.</p></div>`;
};

const cohortCell = (c) => (!c ? html`<span class="dim">아직</span>` : html`<b>${p(c.pct)}</b> <small class="dim">${n(c.returned)}/${n(c.eligible)}</small>`);

export async function adminFunnelPage(main = $('#main')) {
  document.title = '사용 분석 — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('funnel', { from: q.from, to: q.to }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    const { from, to } = d.range;
    const csv = `/api/admin/funnel.csv?${new URLSearchParams({ from, to })}`;
    const right = html`<div class="atool atool--range" data-range>
      <input class="input input--sm" type="date" data-from value="${from}" aria-label="시작일"><span>~</span><input class="input input--sm" type="date" data-to value="${to}" aria-label="종료일">
      ${raw(PRESETS.map(([k, l]) => html`<button type="button" class="btn btn--secondary btn--xs" data-preset="${k}">${l}</button>`).join(''))}
      <a class="btn btn--secondary btn--sm" href="${csv}" download data-csv>CSV 내보내기</a></div>`;
    const empty = !d.landing_visits && !d.signups && !d.features.length;
    main.innerHTML = html`<div class="apage" data-funnel-page>${raw(head('사용 분석', right))}
      ${raw(empty ? '<div class="aempty">이 기간에는 기록이 없습니다. 사용 기록은 이 기능을 배포한 날부터 쌓입니다.</div>' : '')}
      ${raw(kpis([
        { label: '랜딩 방문', value: n(d.landing_visits) }, { label: '가입', value: n(d.signups), sub: d.landing_visits ? `방문 대비 ${p(d.steps[1].pct_prev)}` : '' },
        { label: '가장 큰 이탈', value: d.biggest_drop ? `-${d.biggest_drop.pct_lost}%` : '-', sub: d.biggest_drop ? d.biggest_drop.label : '', tone: d.biggest_drop ? 'bad' : '' },
        { label: 'DAU', value: n(d.active.dau), sub: `${to} 기준` }, { label: 'WAU', value: n(d.active.wau), sub: '최근 7일' }, { label: 'MAU', value: n(d.active.mau), sub: '최근 30일' },
      ]))}
      <div class="agrid2">
        ${raw(section('가입 → 프로젝트 종료 퍼널', funnelRows(d)))}
        ${raw(section('핵심 기능 첫 사용 (가입자 대비)', html`${raw(table([
          { key: 'label', label: '기능', cls: 'ttl' }, { key: 'count', label: '사용자', w: 80, render: (f) => n(f.count) },
          { key: 'pct', label: '가입 대비', w: 160, render: (f) => html`<span class="auv"><b>${p(f.pct_signup)}</b>${raw(f.pct_signup === null ? '' : html`<i style="width:${Math.min(100, f.pct_signup)}%"></i>`)}</span>` },
        ], d.first_use, { id: 'firstuse' }))}<p class="hint">순서와 상관없이, 기간 안에 가입한 사용자 중 그 기능을 한 번이라도 쓴 비율입니다.</p>`))}
      </div>
      ${raw(section('많이 쓰는 기능', table([
        { key: 'label', label: '기능', cls: 'ttl' }, { key: 'kind', label: '구분', w: 70, render: (f) => (f.kind === 'screen' ? '화면' : '작업') },
        { key: 'users', label: '사용자', w: 90, render: (f) => n(f.users) }, { key: 'uses', label: '사용 횟수', w: 100, render: (f) => n(f.uses) },
      ], d.features, { empty: '이 기간에 기록된 기능 사용이 없습니다.', id: 'features' })))}
      ${raw(section('주간 가입 코호트 재방문', html`${raw(table([
        { key: 'week', label: '가입 주 (월요일)', w: 150 }, { key: 'users', label: '가입자', w: 80, render: (c) => n(c.users) },
        { key: 'd1', label: 'D1', render: (c) => cohortCell(c.d1) }, { key: 'd7', label: 'D7', render: (c) => cohortCell(c.d7) }, { key: 'd30', label: 'D30', render: (c) => cohortCell(c.d30) },
      ], d.cohorts, { empty: '이 기간에 가입한 사용자가 없습니다.', id: 'cohorts' }))}<p class="hint">D1·D7·D30 = 가입 후 1·7·30일째 이후 다시 접속한 비율. 그날이 아직 오지 않은 가입자는 분모에서 빠지고, 아무도 해당하지 않으면 '아직'으로 표시합니다.</p>`))}
    </div>`;
    const go = (patch) => { setQs(patch); draw(); };
    main.querySelector('[data-from]').onchange = (e) => go({ from: e.target.value, to });
    main.querySelector('[data-to]').onchange = (e) => go({ from, to: e.target.value });
    main.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { const t = todayKst(); go({ from: addDays(t, -(Number(b.dataset.preset) - 1)), to: t }); }; });
  };
  await draw();
}
