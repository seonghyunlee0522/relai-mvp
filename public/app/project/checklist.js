/* 06 전환·오픈 · 07 운영 — per-activity checklist (…/checklist?activity=KEY).
 *
 *   Activities with no dedicated work screen (전환 계획, 데이터 마이그레이션, 교육, 오픈, 안정화, 운영 이관, 유지보수, SLA,
 *   정기 배포, 종료 정리) are worked through a checklist: 항목 · 담당 · 기한 · 완료 · 메모. The activity's state derives from it
 *   on the server (activities.js): all items done → 완료, otherwise 진행 중. 완료 처리 / 건너뛰기 / 되돌리기 and the activity
 *   memo are the same stored marks What's Next uses (PATCH …/steps/:sid). Inputs save on change; no separate save button. */
import { api, wsApi } from '../core/api.js';
import { isPhone, pcLine } from '../core/device.js';
import { $, html, raw, no2, todayLocal } from '../core/dom.js';
import { projectHead } from './guide.js';
import { ACTIVITY_STATE } from '../shared/constants.js';
import { teamFor } from '../shared/owner-picker.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { state } from '../core/state.js';
import { goLiveDialog } from './golive.js';

const PHASES = ['DEVELOPMENT', 'TRANSITION_GO_LIVE', 'OPERATIONS'];   // 04: 주요 의사결정 기록 (F6) is a decision log on this screen
/** Activities of a phase that carry a checklist: manual ones the server pointed at this screen. */
const listActs = (ph) => (ph.steps || []).filter((a) => a.checklist);
const stCls = (a) => (a.state === 'COMPLETED' ? 'done' : a.state === 'SKIPPED' ? 'skip' : a.state === 'IN_PROGRESS' ? 'prog' : 'todo');

export async function checklistPage(id) {
  const main = $('#main');
  const qs = new URLSearchParams(location.search);
  let [g, r, mem] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/checklists`)), api('GET', `/api/workspaces/${state.workspace.id}/members`).catch(() => ({ members: [] }))]);
  const members = mem.members || [];
  const textMode = new Set();   // rows switched to 직접 입력 before anything is typed
  const p = g.project; const isArch = p.status === 'ARCHIVED'; const ro = isArch || isPhone();   // phone = view mode
  let actKey = qs.get('activity');
  let dl = null;   // 07 종료 정리: 필수 산출물 제출 (batch7 #3) — GET …/deliverables, loaded when the CLOSE activity is shown
  const loadDl = async () => { try { dl = await api('GET', wsApi(`/${id}/deliverables`)); } catch { dl = null; } };
  /** 필수 산출물 n건 중 제출 완료 m건 + one checkbox per 필수 산출물 (제출 완료 = submitted_at, today). Only once the project chose from the list. */
  const dlBlock = () => {
    if (!dl || !dl.has_selection) return '';
    const req = dl.items.filter((x) => x.level === 'REQUIRED');
    return html`<div class="clk__dl" data-close-deliverables><p class="clk__crit"><b>필수 산출물</b> <span data-dl-count>필수 산출물 ${req.length}건 중 제출 완료 ${dl.summary.submitted}건</span></p>
      ${raw(req.length ? html`<ul class="clk__dll" style="list-style:none;padding:0;margin:4px 0 12px;display:flex;flex-direction:column;gap:4px">${raw(req.map((x) => html`<li><label><input type="checkbox" data-dlsub="${x.key}" ${x.submitted_at ? 'checked' : ''} ${ro ? 'disabled' : ''}> ${x.name} <small class="dim">${x.phase_name}${x.submitted_at ? ` · 제출 ${x.submitted_at}` : ''}</small></label></li>`).join(''))}</ul>` : '')}</div>`;
  };

  const pick = () => {
    const phases = (g.phases || []).filter((ph) => PHASES.includes(ph.phase_key));
    const all = phases.flatMap((ph) => listActs(ph).map((a) => ({ a, ph })));
    const want = qs.get('phase');
    const cur = all.find((x) => x.a.step_key === actKey)
      || all.find((x) => x.ph.phase_key === want)
      || all.find((x) => x.ph.is_current && x.a.state !== 'COMPLETED' && x.a.state !== 'SKIPPED')
      || all[0];
    return cur ? { ...cur, siblings: listActs(cur.ph) } : null;
  };

  /* US-6 담당 = 담당자 선택기: RELAI 사용자 / 팀원 (계정 없음) / 고객사 (Phase 5 수행자 groups) + 직접 입력… (the old free text stays as is) */
  const refOf = (it) => (it.owner_user_id ? `u:${it.owner_user_id}` : it.owner_stakeholder_id ? `s:${it.owner_stakeholder_id}` : it.owner || textMode.has(it.id) ? '__text' : '');
  const ownerOpts = (cur, missing = '') => {
    const o = r.owners || { team: [], clients: [] };
    const grp = (label, list) => (list.length ? html`<optgroup label="${label}">${raw(list.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</optgroup>` : '');
    return html`<option value="">담당 없음</option>${raw(grp('RELAI 사용자', members.map((m) => [`u:${m.id}`, m.name])))}${raw(grp('팀원 (계정 없음)', teamFor(o.team, cur).map((t) => [`s:${t.id}`, `${t.name} · 팀원`])))}${raw(grp('고객사', (o.clients || []).map((t) => [`s:${t.id}`, `${t.name} · 고객사`])))}
      ${raw(missing ? html`<option value="${cur}" selected>${missing}</option>` : '')}<option value="__text" ${cur === '__text' ? 'selected' : ''}>직접 입력…</option>`;
  };
  const ownerCell = (it, dis) => {
    if (ro) return html`<span>${it.owner_display || '-'}${raw(it.owner_org ? html` <small class="dim">· ${it.owner_org}</small>` : '')}</span>`;
    const cur = refOf(it);
    const known = !/^[us]:/.test(cur) || members.some((m) => `u:${m.id}` === cur) || [...((r.owners || {}).team || []), ...((r.owners || {}).clients || [])].some((t) => `s:${t.id}` === cur);
    return html`<div class="clk__own"><select class="select select--sm clk__in" data-own="${it.id}" aria-label="담당" ${dis}>${raw(ownerOpts(cur, known ? '' : it.owner_display || '(삭제된 담당자)'))}</select>
      ${raw(cur === '__text' ? html`<input class="input clk__in" data-f="owner" value="${it.owner}" maxlength="100" placeholder="담당 (직접 입력)" ${dis} aria-label="담당 직접 입력">` : '')}</div>`;
  };

  const itemRow = (it, dec = false) => {
    const overdue = !dec && !it.done && it.due_date && it.due_date < todayLocal();
    const dis = ro ? 'disabled' : '';
    if (dec) return html`<tr class="clk__row" data-item="${it.id}">
      <td><input class="input clk__in clk__date" type="date" data-f="due_date" value="${it.due_date || ''}" ${dis} aria-label="결정일"></td>
      <td><input class="input clk__in" data-f="title" value="${it.title}" maxlength="200" ${dis} aria-label="결정 내용"></td>
      <td>${raw(ownerCell(it, dis))}</td>
      <td><input class="input clk__in" data-f="note" value="${it.note}" maxlength="2000" placeholder="메모" ${dis} aria-label="메모"></td>
      <td class="clk__x">${raw(ro ? '' : html`<button type="button" class="link linkbtn clk__del" data-del="${it.id}" title="결정 삭제" aria-label="결정 삭제">✕</button>`)}</td>
    </tr>`;
    return html`<tr class="clk__row ${it.done ? 'is-done' : ''}" data-item="${it.id}">
      <td class="clk__ck"><input type="checkbox" data-f="done" ${it.done ? 'checked' : ''} ${dis} aria-label="완료"></td>
      <td><input class="input clk__in" data-f="title" value="${it.title}" maxlength="200" ${dis} aria-label="항목"></td>
      <td>${raw(ownerCell(it, dis))}</td>
      <td><input class="input clk__in clk__date ${overdue ? 'is-overdue' : ''}" type="date" data-f="due_date" value="${it.due_date || ''}" ${dis} aria-label="기한" title="${overdue ? '기한이 지났습니다' : ''}"></td>
      <td><input class="input clk__in" data-f="note" value="${it.note}" maxlength="2000" placeholder="메모" ${dis} aria-label="메모"></td>
      <td class="clk__x">${raw(ro ? '' : html`<button type="button" class="link linkbtn clk__del" data-del="${it.id}" title="항목 삭제" aria-label="항목 삭제">✕</button>`)}</td>
    </tr>`;
  };

  const draw = () => {
    const sel = pick();
    if (!sel) { main.innerHTML = html`<div class="page page--wide">${raw(projectHead(p, g, { title: '체크리스트' }))}${raw(pcLine())}<div class="notice">체크리스트를 사용하는 업무가 없습니다.</div></div>`; return; }
    const { a, ph, siblings } = sel; actKey = a.step_key;
    history.replaceState(null, '', `/app/projects/${id}/checklist?activity=${a.step_key}`);
    document.title = `${a.title} — ${p.name} — RELAI`;
    const items = r.items.filter((it) => it.step_id === a.id);
    const dec = a.step_key === 'DECISIONS';   // F6: decision log — 결정일 · 결정 내용 · 결정자 · 메모, every row counts as recorded (done)
    const done = items.filter((it) => it.done).length;
    const st = ACTIVITY_STATE[a.state] || ACTIVITY_STATE.NOT_STARTED;
    const manualDone = a.status === 'COMPLETED'; const skipped = a.status === 'SKIPPED';
    const marks = ro ? '' : skipped ? html`<button type="button" class="btn btn--secondary btn--sm" data-mark="TODO">업무 다시 시작</button>`
      : manualDone ? html`<button type="button" class="btn btn--secondary btn--sm" data-mark="TODO">완료 되돌리기</button>`
      : html`${raw(a.importance !== 'REQUIRED' ? html`<button type="button" class="link linkbtn np__skip" data-mark="SKIPPED">↷ 건너뛰기</button>` : '')}
        ${raw(a.state !== 'COMPLETED' ? html`<button type="button" class="btn btn--primary btn--sm" data-mark="COMPLETED">✓ 완료 처리</button>` : '')}`;
    const tabs = siblings.map((s) => html`<a class="clk__tab ${s.id === a.id ? 'is-active' : ''}" href="/app/projects/${id}/checklist?activity=${s.step_key}" data-tab="${s.step_key}">
      <span class="badge badge--st is-${stCls(s)}">${(ACTIVITY_STATE[s.state] || ACTIVITY_STATE.NOT_STARTED).label}</span>${s.title}</a>`).join('');
    main.innerHTML = html`<div class="page page--wide clk">
      ${raw(projectHead(p, g, { title: `${no2(ph.sequence)} ${ph.name}` }))}
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. 체크리스트는 조회만 할 수 있습니다.</div>' : pcLine())}
      <nav class="clk__tabs" aria-label="${ph.name} 업무">${raw(tabs)}</nav>
      <section class="clk__card" aria-labelledby="clkT">
        <header class="clk__h">
          <div class="clk__t"><span class="badge badge--imp ${a.importance === 'REQUIRED' ? 'badge--req' : 'badge--muted'}">${a.importance_label}</span><h2 id="clkT">${a.title}</h2>
            <span class="badge badge--st is-${stCls(a)}">${st.label}</span></div>
          <div class="clk__marks">${raw(marks)}</div>
        </header>
        <p class="clk__d">${a.description}</p>
        ${raw(a.close ? dlBlock() : '')}
        <p class="clk__crit"><b>완료 기준</b> ${a.completion_criteria}${raw(items.length ? html` · <span class="clk__cnt">${dec ? `기록된 결정 ${items.length}건` : `체크리스트 ${done}/${items.length} 완료`}</span>` : '')}</p>
        ${raw(a.state === 'IN_PROGRESS' && a.text && !/^체크리스트/.test(a.text) ? html`<p class="clk__hint">${a.text}</p>` : '')}
        ${raw(dec ? (items.length ? html`<table class="clk__tbl" data-decisions><thead><tr><th class="clk__w-due">결정일</th><th>결정 내용</th><th class="clk__w-owner">결정자</th><th>메모</th><th class="clk__x"></th></tr></thead>
          <tbody>${raw(items.map((it) => itemRow(it, true)).join(''))}</tbody></table>` : '<div class="clk__empty"><b>아직 기록된 의사결정이 없습니다.</b><p>프로젝트 방향에 영향을 준 결정을 결정일, 결정 내용, 결정자와 함께 남겨 두세요. 1건 이상 기록하면 이 업무가 완료로 표시됩니다.</p></div>')
          : items.length ? html`<table class="clk__tbl"><thead><tr><th class="clk__ck" aria-label="완료"></th><th>항목</th><th class="clk__w-owner">담당</th><th class="clk__w-due">기한</th><th>메모</th><th class="clk__x"></th></tr></thead>
          <tbody>${raw(items.map((it) => itemRow(it)).join(''))}</tbody></table>`
          : html`<div class="clk__empty"><b>아직 체크리스트 항목이 없습니다.</b><p>항목을 추가하면 담당과 기한을 정하고 진행 상황을 기록할 수 있습니다. ${a.go_live ? "오픈은 '완료 처리'에서 오픈일과 남은 항목을 정해 기록합니다." : a.handover ? "운영 인수는 '인수 완료 처리'에서 인수자와 인수일을 정해 기록합니다." : '모든 항목을 완료하면 이 업무가 완료로 표시됩니다.'}</p>
            ${raw(ro ? '' : '<button type="button" class="btn btn--secondary btn--sm" data-defaults>기본 항목으로 시작</button>')}</div>`)}
        ${raw(ro ? '' : dec ? html`<form class="clk__add" data-add data-dec autocomplete="off">
          <input class="input clk__w-due" type="date" name="due_date" value="${todayLocal()}" aria-label="결정일">
          <input class="input" name="title" maxlength="200" placeholder="결정 내용" aria-label="결정 내용" required>
          <span class="clk__w-owner clk__own"><select class="select" name="owner_ref" aria-label="결정자" data-add-own>${raw(ownerOpts(''))}</select><input class="input" name="owner" maxlength="100" placeholder="결정자 (직접 입력)" aria-label="결정자 직접 입력" hidden></span>
          <input class="input" name="note" maxlength="2000" placeholder="메모" aria-label="메모">
          <button type="submit" class="btn btn--secondary btn--sm">+ 결정 기록</button></form>` : html`<form class="clk__add" data-add autocomplete="off">
          <input class="input" name="title" maxlength="200" placeholder="새 항목" aria-label="새 항목" required>
          <span class="clk__w-owner clk__own"><select class="select" name="owner_ref" aria-label="담당" data-add-own>${raw(ownerOpts(''))}</select><input class="input" name="owner" maxlength="100" placeholder="담당 (직접 입력)" aria-label="담당 직접 입력" hidden></span>
          <input class="input clk__w-due" type="date" name="due_date" aria-label="기한">
          <button type="submit" class="btn btn--secondary btn--sm">+ 추가</button></form>`)}
        <div class="clk__memo"><label for="clkMemo">업무 메모</label>
          <textarea id="clkMemo" class="input" rows="3" maxlength="4000" placeholder="결정 사항, 참고 링크, 미결 사항 등을 기록합니다." ${ro ? 'disabled' : ''}>${a.note || ''}</textarea>
          ${raw(ro ? '' : '<button type="button" class="btn btn--secondary btn--sm" data-memo>메모 저장</button>')}</div>
      </section>
      <p class="clk__back"><a class="link" href="/app/projects/${id}${ph.is_current ? '' : `?phase=${ph.phase_key}`}" data-link>← 지금 할 일에서 ${ph.name} 업무 보기</a></p>
    </div>`;
    bind(a);
  };

  await loadDl();
  const reload = async () => { [g, r] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/checklists`))]); draw(); };
  const onGoLive = (a) => a.step_key === 'GO_LIVE' && a.importance === 'REQUIRED' && (g.phases || []).some((ph) => ph.phase_key === 'TRANSITION_GO_LIVE' && ph.steps.some((x) => x.id === a.id));
  const run = async (el, fn) => { if (el) el.disabled = true; try { await fn(); } catch (e) { toast(e.message); if (el) el.disabled = false; } };

  const bind = (a) => {
    main.querySelectorAll('[data-tab]').forEach((t) => { t.onclick = async (e) => { e.preventDefault(); actKey = t.dataset.tab; if (!dl) await loadDl(); draw(); }; });
    main.querySelectorAll('[data-dlsub]').forEach((cb) => { cb.onchange = () => run(cb, async () => {
      const x = dl.items.find((y) => y.key === cb.dataset.dlsub);
      dl = await api('PUT', wsApi(`/${id}/deliverables`), { items: [x.custom ? { id: x.id, submitted_at: cb.checked ? todayLocal() : null } : { catalog_id: x.catalog_id, submitted_at: cb.checked ? todayLocal() : null }] });
      draw();
    }); });
    main.querySelectorAll('.clk__row [data-f]').forEach((inp) => {
      inp.onchange = () => run(null, async () => {
        const f = inp.dataset.f; const v = f === 'done' ? inp.checked : inp.value;
        if (f === 'title' && !v.trim()) { toast('항목을 입력해 주세요.'); await reload(); return; }
        await api('PATCH', wsApi(`/${id}/checklist/${inp.closest('[data-item]').dataset.item}`), { [f]: f === 'due_date' && !v ? null : v });
        if (f === 'done' || f === 'due_date') await reload();   // state badge / overdue mark follow
        else { const it = r.items.find((x) => x.id === inp.closest('[data-item]').dataset.item); if (it) it[f] = v.trim(); }
      });
    });
    main.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => run(b, async () => {
      await api('DELETE', wsApi(`/${id}/checklist/${b.dataset.del}`)); await reload();
    }); });
    main.querySelectorAll('[data-own]').forEach((sel) => { sel.onchange = () => {
      const iid = sel.dataset.own;
      if (sel.value === '__text') { textMode.add(iid); draw(); const t = main.querySelector(`[data-item="${iid}"] [data-f="owner"]`); if (t) t.focus(); return; }
      textMode.delete(iid);
      run(null, async () => { await api('PATCH', wsApi(`/${id}/checklist/${iid}`), { owner_ref: sel.value }); await reload(); });
    }; });
    const add = main.querySelector('[data-add]');
    const addOwn = main.querySelector('[data-add-own]');
    if (addOwn) addOwn.onchange = () => { const t = add.querySelector('[name=owner]'); t.hidden = addOwn.value !== '__text'; if (!t.hidden) t.focus(); };
    if (add) add.onsubmit = (e) => { e.preventDefault(); const fd = new FormData(add); const btn = add.querySelector('button');
      const ref = fd.get('owner_ref') || ''; const ownerBody = ref === '__text' ? { owner: fd.get('owner') || '' } : ref ? { owner_ref: ref } : {};
      run(btn, async () => {
        await api('POST', wsApi(`/${id}/steps/${a.id}/checklist`), { title: fd.get('title'), ...ownerBody, due_date: fd.get('due_date') || null, ...(add.dataset.dec !== undefined ? { done: true, note: fd.get('note') || '' } : {}) });
        await reload(); const t = main.querySelector('[data-add] [name=title]'); if (t) t.focus();
      }); };
    const defs = main.querySelector('[data-defaults]');
    if (defs) defs.onclick = () => run(defs, async () => { const x = await api('POST', wsApi(`/${id}/steps/${a.id}/checklist/defaults`), {}); toast(`기본 항목 ${x.added}건을 추가했습니다.`); await reload(); });
    const memo = main.querySelector('[data-memo]');
    if (memo) memo.onclick = () => run(memo, async () => { await api('PATCH', wsApi(`/${id}/steps/${a.id}`), { note: $('#clkMemo').value }); toast('메모를 저장했습니다.'); await reload(); });
    main.querySelectorAll('[data-mark]').forEach((b) => { b.onclick = async () => {
      const status = b.dataset.mark;
      // Phase 6 US-3: 오픈 is completed through the 오픈 dialog (오픈일 + 남은 항목 처리 / 운영 이관)
      if (status === 'COMPLETED' && onGoLive(a)) { const res = await goLiveDialog(id); if (res) { toast('오픈을 기록했습니다.'); await reload(); } return; }
      const open = r.items.filter((it) => it.step_id === a.id && !it.done).length;
      if (status === 'COMPLETED' && open && !(await confirmDialog({ title: '이 업무를 완료 처리할까요?', body: `완료되지 않은 체크리스트 항목 ${open}건이 남아 있습니다. 그래도 완료로 기록합니다.`, confirm: '완료 처리' }))) return;
      if (status === 'SKIPPED' && !(await confirmDialog({ title: '이 업무를 건너뛸까요?', body: `'${a.title}'은(는) 이번 프로젝트에서 수행하지 않는 것으로 기록됩니다. 나중에 다시 시작할 수 있습니다.`, confirm: '건너뛰기' }))) return;
      run(b, async () => {
        await api('PATCH', wsApi(`/${id}/steps/${a.id}`), { status });
        toast(status === 'COMPLETED' ? '완료 처리했습니다.' : status === 'SKIPPED' ? '이 업무를 건너뛰었습니다.' : '업무를 다시 시작합니다.');
        await reload();
      });
    }; });
  };
  draw();
}
