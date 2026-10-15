/* 06 오픈 (Phase 6 US-3) — "서비스를 오픈합니다" dialog + the 07 "오픈 때 운영으로 넘긴 항목" list.
 *
 *   goLiveDialog(pid)       오픈일* (default today KST, never later) → "오픈 전에 정할 항목 N건": each row is 처리하러 가기 (link, closes the
 *                           dialog) or 운영 이관 (+ one-line memo*). `오픈 완료` (the one primary) turns on only when every row is 운영 이관 with a memo.
 *                           Unfinished 06 checklist items are one warn line (no decision). Resolves the fresh project payload, or null.
 *   carryoverDialog(g)      07 What's Next first line → the list (종류 · ID · 제목 · 메모, each a link). Display only — 07 spec makes it work.
 *   carryTag(g, type, id)   the grey `운영 이관 · 메모` text tag for issue / test / CR / 검수 lists and drawers. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { todayKst, md } from '../shared/kst-date.js';

const HREF = { ISSUE: (p, id) => `/app/projects/${p}/issues?sel=${id}`, TEST: (p, id) => `/app/projects/${p}/tests?sel=${id}`, CR: (p, id) => `/app/projects/${p}/changes?sel=${id}`, ACCEPTANCE: (p, id) => `/app/projects/${p}/tests?tab=acceptance&sel=${id}` };
const LABEL = { ISSUE: '이슈', TEST: '테스트', CR: '변경 요청', ACCEPTANCE: '검수' };
export const itemHref = (pid, type, id) => (HREF[type] ? HREF[type](pid, id) : `/app/projects/${pid}`);

/** { 'ISSUE:<id>': note } from the project payload's go_live record. */
export const carryIndex = (g) => Object.fromEntries(((g && g.go_live && g.go_live.carryovers) || []).map((c) => [`${c.type}:${c.id}`, { note: c.note, owner: c.owner_name || '' }]));
/** "운영 이관 · 담당 김운영" (Phase 7 US-3: the 운영 담당 once it is chosen). */
export const carryTag = (idx, type, id, full = false) => {
  const c = idx[`${type}:${id}`]; if (c === undefined) return '';
  return html`<small class="carry" data-carry="${type}:${id}" title="${c.note}">운영 이관${c.owner ? ` · 담당 ${c.owner}` : ''}${raw(full && c.note ? html` · ${c.note}` : '')}</small>`;
};

/** Drawer line "운영 이관 · 메모 · 운영 담당 김운영" (issue / test / CR / 검수 drawers). */
export const carryLine = (idx, type, id) => {
  const c = idx[`${type}:${id}`]; if (c === undefined) return '';
  return html`<p class="carryline" data-carryline><span class="carry" style="margin-left:0">운영 이관</span> · ${c.note}${c.owner ? ` · 운영 담당 ${c.owner}` : ''}</p>`;
};

export function goLiveDialog(pid) {
  return new Promise(async (resolve) => {
    let d;
    try { d = await api('GET', wsApi(`/${pid}/go-live`)); } catch (e) { const { toast } = await import('../shared/dialogs.js'); toast(e.message); resolve(null); return; }
    const today = d.today || todayKst();
    const items = d.open_items || [];
    const dec = Object.fromEntries(items.map((it) => [`${it.type}:${it.id}`, { carry: false, note: '' }]));
    let date = today;
    const el = document.createElement('div'); el.className = 'scrim scrim--sheet';
    const decided = () => items.filter((it) => { const x = dec[`${it.type}:${it.id}`]; return x.carry && x.note.trim(); }).length;
    const row = (it) => { const k = `${it.type}:${it.id}`; const x = dec[k];
      return html`<li class="gl__row" data-k="${k}">
        <div class="gl__m"><span class="gl__type">${LABEL[it.type] || it.type_label}</span><span class="mono">${it.display_id}</span><span class="gl__t">${it.title}</span><small class="dim">${it.detail}</small></div>
        <div class="seg gl__seg" role="group" aria-label="${it.display_id} 결정"><button type="button" data-go="${k}">처리하러 가기</button><button type="button" class="${x.carry ? 'is-on' : ''}" data-carry-on="${k}" aria-pressed="${x.carry}">운영 이관</button></div>
        ${raw(x.carry ? html`<div class="gl__note"><label class="sr-only" for="gln-${it.id}">운영 이관 메모</label><input class="input input--sm" id="gln-${it.id}" data-note="${k}" maxlength="200" value="${x.note}" placeholder="예: 운영팀 1차 대응, 11월 패치에 포함"></div>` : '')}
      </li>`; };
    const draw = () => {
      const n = decided(); const ready = Boolean(date) && date <= today && n === items.length;
      el.innerHTML = html`<form class="dialog dialog--form gl" role="dialog" aria-modal="true" aria-labelledby="glT" data-golive-dialog novalidate>
        <h3 id="glT">서비스를 오픈합니다</h3>
        <p class="gl__d">오픈 뒤에도 처리할 문제는 운영 이관으로 넘기면 07에서 이어서 볼 수 있습니다.</p>
        <div class="gl__b">
          <div class="field"><label for="gl-date">오픈일 <span class="req">*</span></label><input class="input input--sm gl__date" type="date" id="gl-date" value="${date}" max="${today}" required><div class="err" data-gl-err="date"></div></div>
          ${raw(items.length ? html`<h4 class="gl__h">오픈 전에 정할 항목 ${items.length}건 <small class="dim">처리하러 가기 또는 운영 이관</small></h4><ol class="gl__list">${raw(items.map(row).join(''))}</ol>` : '')}
          ${raw(d.checklist_open ? html`<p class="gl__warn"><i class="st st--warn" aria-hidden="true">!</i>06 체크리스트에 완료되지 않은 항목 ${d.checklist_open}건이 남아 있습니다.</p>` : '')}
          <div class="err" data-gl-err="form"></div>
        </div>
        <div class="gl__f"><span class="hint" data-gl-stat>${items.length ? `${items.length}건 중 ${n}건 결정` : ''}</span>
          <span class="gl__btns"><button type="button" class="btn btn--secondary btn--sm" data-gl-cancel>취소</button><button type="submit" class="btn btn--primary btn--sm" data-gl-ok ${ready ? '' : 'disabled'}>오픈 완료</button></span></div>
      </form>`;
      bind();
    };
    const refresh = () => { const n = decided(); const st = $('[data-gl-stat]', el); if (st && items.length) st.textContent = `${items.length}건 중 ${n}건 결정`; $('[data-gl-ok]', el).disabled = !(date && date <= today && n === items.length); };
    const done = (v) => { el.remove(); resolve(v); };
    const bind = () => {
      $('#gl-date', el).oninput = (e) => { date = e.target.value; const er = $('[data-gl-err="date"]', el); er.textContent = date && date > today ? '오픈일은 오늘 이후 날짜로 정할 수 없습니다.' : ''; refresh(); };
      el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { const [type, id] = b.dataset.go.split(':'); done(null); navigate(itemHref(pid, type, id)); }; });
      el.querySelectorAll('[data-carry-on]').forEach((b) => { b.onclick = () => { const k = b.dataset.carryOn; dec[k].carry = !dec[k].carry; draw(); const inp = el.querySelector(`[data-note="${k}"]`); if (inp) inp.focus(); }; });
      el.querySelectorAll('[data-note]').forEach((inp) => { inp.oninput = () => { dec[inp.dataset.note].note = inp.value; refresh(); }; });
      $('[data-gl-cancel]', el).onclick = () => done(null);
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault(); const ok = $('[data-gl-ok]', el); if (ok.disabled) return; ok.disabled = true;
        const carryovers = items.map((it) => ({ type: it.type, id: it.id, note: dec[`${it.type}:${it.id}`].note.trim() }));
        try { const r = await api('POST', wsApi(`/${pid}/go-live`), { date, carryovers }); done(r); }
        catch (err) { $('[data-gl-err="form"]', el).textContent = err.message; ok.disabled = false; }
      };
    };
    el.addEventListener('click', (e) => { if (e.target === el) done(null); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    draw(); document.body.append(el); $('#gl-date', el).focus();
  });
}

/** 07 What's Next: "오픈 때 운영으로 넘긴 항목 N건" → the list. */
export function carryoverDialog(g) {
  const gl = g.go_live; if (!gl) return;
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog dialog--form gl" role="dialog" aria-modal="true" aria-labelledby="coT" data-carry-dialog>
    <h3 id="coT">오픈 때 운영으로 넘긴 항목 ${gl.carryovers.length}건</h3>
    <p class="gl__d">오픈 ${md(gl.date)}${gl.by_name ? ` · 기록: ${gl.by_name}` : ''}. 운영 단계에서 이어서 처리합니다.</p>
    <ol class="gl__list">${raw(gl.carryovers.map((c) => html`<li class="gl__row"><div class="gl__m"><span class="gl__type">${LABEL[c.type] || c.type}</span><a class="mono" href="${itemHref(g.project.id, c.type, c.id)}" data-co-link>${c.display_id}</a><span class="gl__t">${c.title}</span></div><p class="gl__memo">${c.note}</p></li>`).join(''))}</ol>
    <div class="gl__f"><span></span><span class="gl__btns"><button type="button" class="btn btn--secondary btn--sm" data-co-close>닫기</button></span></div></div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => { const a = e.target.closest('[data-co-link]'); if (a) { e.preventDefault(); close(); navigate(a.getAttribute('href')); return; } if (e.target === el || e.target.closest('[data-co-close]')) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(el); $('[data-co-close]', el).focus();
}
