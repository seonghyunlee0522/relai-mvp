/* 보고서 › 활동 기록 (batch7 #22): the project's change history and comments as a full page — it replaced the right-hand slide-over.
 * Filters (기간 · 종류 · 사람) live in the URL, so Back and a shared link keep them. Days are grouped newest first; 더 보기 asks the
 * server for the next 120 older events (GET …/activity?limit=120&before=<the oldest one shown>). */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { emptyState } from '../shared/empty-state.js';
import { projectHead } from './guide.js';

const PAGE = 120;
const ENT = { REQUIREMENT: '요구사항', WBS: 'WBS', CHANGE: '변경 요청', ISSUE: '이슈', RISK: '리스크', TEST: '테스트', ACCEPTANCE: '검수', PHASE: '단계', JIRA: '지라' };
/** 종류 filter → the entity types it covers. */
const KINDS = [['', '전체'], ['req', '요구사항', ['REQUIREMENT']], ['wbs', 'WBS', ['WBS', 'JIRA']], ['test', '테스트', ['TEST', 'ACCEPTANCE']], ['change', '변경', ['CHANGE']], ['issue', '이슈', ['ISSUE', 'RISK']]];
const PERIODS = [['', '전체 기간'], ['7', '최근 7일'], ['30', '최근 30일']];
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${no2(d.getMonth() + 1)}-${no2(d.getDate())}`; };
const dayLabel = (iso) => { const d = new Date(iso); const t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; return dayKey(iso) === dayKey(t) ? `오늘 · ${base}` : dayKey(iso) === dayKey(y) ? `어제 · ${base}` : d.getFullYear() !== t.getFullYear() ? `${d.getFullYear()}년 ${base}` : base; };
const hm = (iso) => { const d = new Date(iso); return `${no2(d.getHours())}:${no2(d.getMinutes())}`; };

export async function activityPage(pid, main = $('#main')) {
  const [g, first] = await Promise.all([api('GET', wsApi(`/${pid}`)), api('GET', wsApi(`/${pid}/activity?limit=${PAGE}`))]);
  const p = g.project;
  document.title = `활동 기록 — ${p.name} — RELAI`;
  let items = first.items || []; let more = Boolean(first.more); let loading = false;
  const qs = () => new URLSearchParams(location.search);
  const setQ = (k, v) => { const q = qs(); if (v) q.set(k, v); else q.delete(k); history.replaceState(history.state, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`); };

  const shown = () => {
    const q = qs(); const kind = KINDS.find((k) => k[0] === (q.get('kind') || '')); const who = q.get('who') || ''; const days = Number(q.get('days')) || 0;
    const since = days ? Date.now() - days * 864e5 : 0;
    return items.filter((r) => (!kind || !kind[2] || kind[2].includes(r.entity_type)) && (!who || (r.actor_name || '시스템') === who) && (!since || Date.parse(r.at) >= since));
  };
  const people = () => [...new Set(items.map((r) => r.actor_name || '시스템'))].sort((a, b) => a.localeCompare(b, 'ko'));

  const row = (r) => html`<li class="actrow ${r.kind === 'COMMENT' ? 'is-comment' : ''}" data-act-row>
    <time class="actrow__t">${hm(r.at)}</time>
    <span class="chip chip--muted actrow__k">${r.kind === 'COMMENT' ? '댓글' : ENT[r.entity_type] || r.entity_type}</span>
    <div class="actrow__b"><div class="actrow__h"><b>${r.actor_name || '시스템'}</b>${raw(r.href ? html`<a class="link" href="/app/projects/${pid}/${r.href}" data-link>${raw(r.display_id ? html`<span class="mono">${r.display_id}</span> ` : '')}${r.title || ''}</a>` : html`<span>${r.title || ''}</span>`)}</div>
      <p class="actrow__s">${r.summary || ''}</p></div></li>`;
  const listHtml = () => {
    const rows = shown();
    if (!rows.length) return emptyState({ title: items.length ? '조건에 맞는 활동이 없습니다.' : '아직 기록된 활동이 없습니다.', body: items.length ? '기간·종류·사람 조건을 바꿔 보세요.' : '요구사항·WBS·테스트·변경·이슈를 등록하거나 바꾸면 여기에 날짜별로 쌓입니다.', small: true });
    const days = []; for (const r of rows) { const k = dayKey(r.at); const d = days[days.length - 1]; if (d && d.k === k) d.rows.push(r); else days.push({ k, at: r.at, rows: [r] }); }
    return days.map((d) => html`<section class="actday" data-act-day="${d.k}"><h2 class="actday__h">${dayLabel(d.at)} <em>${d.rows.length}</em></h2><ol class="actday__l">${raw(d.rows.map(row).join(''))}</ol></section>`).join('');
  };
  const footHtml = () => (more ? html`<div class="actfoot"><button type="button" class="btn btn--secondary btn--sm" id="act-more" ${loading ? 'disabled' : ''}>${loading ? '불러오는 중…' : '이전 활동 더 보기'}</button></div>`
    : items.length ? '<p class="actfoot hint">처음 기록까지 모두 표시했습니다.</p>' : '');
  const tools = () => {
    const q = qs();
    return html`<div class="rtool actbar" role="group" aria-label="활동 필터">
      <div class="sseg" role="group" aria-label="종류">${raw(KINDS.map(([k, l]) => html`<button type="button" class="${(q.get('kind') || '') === k ? 'is-on' : ''}" data-act-kind="${k}" aria-pressed="${(q.get('kind') || '') === k}">${l}</button>`).join(''))}</div>
      <select class="select select--sm" id="act-days" aria-label="기간">${raw(PERIODS.map(([v, l]) => html`<option value="${v}" ${(q.get('days') || '') === v ? 'selected' : ''}>${l}</option>`).join(''))}</select>
      <select class="select select--sm" id="act-who" aria-label="사람"><option value="">모든 사람</option>${raw(people().map((n) => html`<option value="${n}" ${q.get('who') === n ? 'selected' : ''}>${n}</option>`).join(''))}</select>
      <span class="rtool__sp"></span><span class="hint" data-act-count>${shown().length.toLocaleString('ko-KR')}건${more ? ' (더 있음)' : ''}</span></div>`;
  };
  const draw = () => {
    main.innerHTML = html`<div class="page page--wide page--flow page--activity">
      ${raw(projectHead(p, g, { tab: 'activity', title: '활동 기록' }))}
      ${raw(tools())}<div class="actpage" id="act-list">${raw(listHtml())}</div>${raw(footHtml())}</div>`;
    bind();
  };
  const bind = () => {
    main.querySelectorAll('[data-act-kind]').forEach((b) => { b.onclick = () => { setQ('kind', b.dataset.actKind); draw(); }; });
    const ds = $('#act-days', main); if (ds) ds.onchange = () => { setQ('days', ds.value); draw(); };
    const w = $('#act-who', main); if (w) w.onchange = () => { setQ('who', w.value); draw(); };
    const m = $('#act-more', main);
    if (m) m.onclick = async () => {
      if (loading || !items.length) return; loading = true; draw();
      try { const r = await api('GET', wsApi(`/${pid}/activity?limit=${PAGE}&before=${encodeURIComponent(items[items.length - 1].at)}`)); items = items.concat(r.items || []); more = Boolean(r.more) && (r.items || []).length > 0; }
      catch { more = true; }
      loading = false; const y = window.scrollY; const inner = $('.page--activity', main); const st = inner ? inner.scrollTop : 0; draw(); window.scrollTo(0, y); const in2 = $('.page--activity', main); if (in2) in2.scrollTop = st;
    };
  };
  draw();
}
