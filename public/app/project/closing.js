/* 07 운영 및 유지보수 (Phase 7) — 운영 인수 dialog · 프로젝트 종료 dialog · CLOSE 수동 완료 · 완료보고서 열기 · 종료 후 What's Next.
 *
 *   handoverDialog(pid)          인수자* (고객사 → RELAI 사용자 → 팀원) · 인수일* (≤ today KST) → "운영 이관 항목 N건" with 운영 담당 each (미정 allowed,
 *                                warn "운영 담당 미정 N건"). `인수 완료` (primary) records + completes HANDOVER; `담당만 저장` stores owners only.
 *   closeDialog(pid, g)          "프로젝트를 종료할까요?" 종료일* · 하자보수 종료일 (기본 종료일 + 12개월) · 남은 운영 이관 N건 → POST …/close.
 *   closeManual(pid, step)       CLOSE without a FINAL 완료보고서: 사유* (외부에서 작성) → PATCH steps {status, reason}.
 *   openCompletion(pid)          POST …/weekly-reports/completion (creates once, else opens the same report) → the report screen.
 *   closedPanel(g)               What's Next after 종료: ✓ · "프로젝트가 종료되었습니다" · 날짜 · `완료보고서 보기` (the only primary) · 종료 취소. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import { todayKst, md } from '../shared/kst-date.js';
import { confirmDialog, promptDialog, toast } from '../shared/dialogs.js';
import { term } from './initiation.js';

const LABEL = { ISSUE: '이슈', TEST: '테스트', CR: '변경 요청', ACCEPTANCE: '검수' };
const ymdSlash = (d) => (d ? String(d).slice(0, 10).replace(/-/g, '/') : '');
/** '2026-10-30' + 12 months (month end clamps) — same rule as server/closing.js addMonths. */
export function addMonths(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10);
}
const opts = (list, cur) => list.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
const grp = (label, list, cur) => (list.length ? html`<optgroup label="${label}">${raw(opts(list, cur))}</optgroup>` : '');
/** 3 groups, 고객사 운영 담당 first (spec US-3). */
const personOptions = (members, owners, cur) => {
  const o = owners || {}; const lab = (t) => (t.role ? `${t.name} · ${t.role}` : t.name);
  return grp('고객사', (o.clients || []).map((t) => [`s:${t.id}`, `${lab(t)}${t.org ? ` (${t.org})` : ''}`]), cur)
    + grp('RELAI 사용자', members.map((m) => [`u:${m.id}`, m.name]), cur) + grp('팀원 (계정 없음)', (o.team || []).map((t) => [`s:${t.id}`, lab(t)]), cur);
};

export function handoverDialog(pid) {
  return new Promise(async (resolve) => {
    let d; let members = [];
    try { [d, members] = await Promise.all([api('GET', wsApi(`/${pid}/handover`)), api('GET', `/api/workspaces/${state.workspace.id}/members`).then((r) => r.members || []).catch(() => [])]); }
    catch (e) { toast(e.message); resolve(null); return; }
    const today = d.today || todayKst(); const done0 = Boolean(d.handover);
    let receiver = d.handover ? d.handover.receiver_ref : ''; let date = d.handover ? String(d.handover.date).slice(0, 10) : today;
    const owner = Object.fromEntries((d.carryovers || []).map((c) => [`${c.type}:${c.id}`, c.owner_ref || '']));
    const el = document.createElement('div'); el.className = 'scrim scrim--sheet';
    const tbd = () => Object.values(owner).filter((v) => v === 'TBD').length;
    const unset = () => Object.values(owner).filter((v) => !v).length;
    const draw = () => {
      const items = d.carryovers || [];
      el.innerHTML = html`<form class="dialog dialog--form gl ho" role="dialog" aria-modal="true" aria-labelledby="hoT" data-handover-dialog novalidate>
        <h3 id="hoT">운영 인수인계</h3>
        <p class="gl__d">누가 언제 운영을 인수했는지 남깁니다. 운영 이관 항목마다 운영 담당을 정하세요. 고객이 아직 사람을 정하지 않았다면 미정으로 둡니다.</p>
        <div class="gl__b">
          <div class="ho__two">
            <div class="field"><label for="ho-r">인수자 <span class="req">*</span></label><select class="select select--sm" id="ho-r" required><option value="">선택하세요</option>${raw(personOptions(members, d.owners, receiver))}</select><div class="err" data-ho-err="receiver"></div></div>
            <div class="field"><label for="ho-d">인수일 <span class="req">*</span></label><input class="input input--sm gl__date" type="date" id="ho-d" value="${date}" max="${today}" required><div class="err" data-ho-err="date"></div></div>
          </div>
          ${raw(items.length ? html`<h4 class="gl__h">운영 이관 항목 ${items.length}건 ${raw(term('carryover'))}</h4><ol class="gl__list">${raw(items.map((c) => { const k = `${c.type}:${c.id}`; return html`<li class="gl__row ho__row">
            <div class="gl__m"><span class="gl__type">${LABEL[c.type] || c.type}</span><span class="mono">${c.display_id}</span><span class="gl__t">${c.title}</span>${raw(c.note ? html`<small class="dim">${c.note}</small>` : '')}</div>
            <div class="ho__own"><label class="sr-only" for="ho-o-${c.id}">${c.display_id} 운영 담당</label><select class="select select--sm" id="ho-o-${c.id}" data-owner="${k}"><option value="" ${owner[k] ? '' : 'selected'}>운영 담당 선택</option><option value="TBD" ${owner[k] === 'TBD' ? 'selected' : ''}>미정</option>${raw(personOptions(members, d.owners, owner[k]))}</select></div>
          </li>`; }).join(''))}</ol>` : '<p class="hint">운영 이관 항목이 없습니다.</p>')}
          <p class="gl__warn" data-ho-tbd ${tbd() ? '' : 'hidden'}><i class="st st--warn" aria-hidden="true">!</i><span>운영 담당 미정 ${tbd()}건</span></p>
          <div class="err" data-ho-err="form"></div>
        </div>
        <div class="gl__f"><a class="link" href="/app/projects/${pid}/checklist?activity=HANDOVER" data-ho-cl>체크리스트 보기</a>
          <span class="gl__btns"><button type="button" class="btn btn--ghost btn--sm" data-ho-cancel>취소</button>${raw(items.length && !done0 ? '<button type="button" class="btn btn--secondary btn--sm" data-ho-owners>담당만 저장</button>' : '')}<button type="submit" class="btn btn--primary btn--sm" data-ho-ok>${done0 ? '저장' : '인수 완료'}</button></span></div>
      </form>`;
      bind();
    };
    const done = (v) => { el.remove(); resolve(v); };
    const errs = (fields = {}, msg = '') => { el.querySelectorAll('[data-ho-err]').forEach((x) => { x.textContent = fields[x.dataset.hoErr] || ''; }); if (msg) $('[data-ho-err="form"]', el).textContent = msg; };
    const ownersBody = () => (d.carryovers || []).map((c) => ({ type: c.type, id: c.id, owner: owner[`${c.type}:${c.id}`] }));
    const bind = () => {
      $('#ho-r', el).onchange = (e) => { receiver = e.target.value; $('[data-ho-err="receiver"]', el).textContent = ''; };
      $('#ho-d', el).oninput = (e) => { date = e.target.value; $('[data-ho-err="date"]', el).textContent = date > today ? '인수일은 오늘 이후 날짜로 정할 수 없습니다.' : ''; };
      el.querySelectorAll('[data-owner]').forEach((s) => { s.onchange = () => { owner[s.dataset.owner] = s.value; if (!unset()) $('[data-ho-err="form"]', el).textContent = ''; const w = $('[data-ho-tbd]', el); w.hidden = !tbd(); w.querySelector('span').textContent = `운영 담당 미정 ${tbd()}건`; }; });
      $('[data-ho-cancel]', el).onclick = () => done(null);
      $('[data-ho-cl]', el).onclick = (e) => { e.preventDefault(); done(null); navigate(`/app/projects/${pid}/checklist?activity=HANDOVER`); };
      const ob = $('[data-ho-owners]', el); if (ob) ob.onclick = async () => {
        ob.disabled = true;
        try { const r = await api('PATCH', wsApi(`/${pid}/carryovers/owners`), { owners: ownersBody().filter((o) => o.owner) }); toast('운영 담당을 저장했습니다.'); done({ ...r, saved_owners: true }); }
        catch (e) { errs(e.fields, e.message); ob.disabled = false; }
      };
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = {}; if (!receiver) f.receiver = '인수자를 고르세요.'; if (!date) f.date = '인수일을 입력하세요.'; else if (date > today) f.date = '인수일은 오늘 이후 날짜로 정할 수 없습니다.';
        if (unset()) f.form = `운영 담당을 고르지 않은 항목 ${unset()}건이 있습니다. 아직 정하지 않았다면 미정을 고르세요.`;
        if (Object.keys(f).length) { errs(f, f.form || ''); return; }
        const ok = $('[data-ho-ok]', el); ok.disabled = true;
        try { const r = await api('POST', wsApi(`/${pid}/handover`), { receiver, date, owners: ownersBody() }); done(r); }
        catch (err) { errs(err.fields, err.message); ok.disabled = false; }
      };
    };
    el.addEventListener('click', (e) => { if (e.target === el) done(null); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    draw(); document.body.append(el); $('#ho-r', el).focus();
  });
}

/** 07 필수 업무 (HANDOVER · CLOSE) all done — the only state in which 프로젝트 종료 is offered as possible. */
export const closeReady = (g) => { const ops = (g.phases || []).find((p) => p.phase_key === 'OPERATIONS'); return Boolean(ops && ops.summary && ops.summary.gate_met); };

export function closeDialog(pid, g) {
  return new Promise((resolve) => {
    const today = todayKst(); let closed = today; let warranty = addMonths(today, 12); let wTouched = false;
    const carry = (g.go_live && g.go_live.carryovers) || []; const assigned = carry.filter((c) => c.owner_ref && c.owner_ref !== 'TBD').length;
    const ready = closeReady(g);
    const el = document.createElement('div'); el.className = 'scrim scrim--sheet';
    el.innerHTML = html`<form class="dialog dialog--form gl cl" role="dialog" aria-modal="true" aria-labelledby="clT" data-close-dialog novalidate>
      <h3 id="clT">프로젝트를 종료할까요?</h3>
      <p class="gl__d">종료하면 홈과 안내가 더 이상 할 일을 독촉하지 않습니다. 기록은 그대로 남고 언제든 종료를 취소할 수 있습니다.</p>
      <div class="gl__b">
        <div class="field"><label for="cl-d">종료일 <span class="req">*</span></label><input class="input input--sm gl__date" type="date" id="cl-d" value="${closed}" max="${today}" required><div class="err" data-cl-err="closed_on"></div></div>
        <div class="field"><label for="cl-w">하자보수 종료일 ${raw(term('warranty'))}</label><input class="input input--sm gl__date" type="date" id="cl-w" value="${warranty}"><small class="hint">기본: 종료일 + 12개월</small><div class="err" data-cl-err="warranty_end_on"></div></div>
        ${raw(carry.length ? html`<p class="cl__carry">남은 운영 이관 ${carry.length}건 (담당 지정 ${assigned}건)</p>` : '')}
        ${raw(ready ? '' : '<p class="gl__warn"><i class="st st--warn" aria-hidden="true">!</i>07 필수 업무(운영 이관 / 인수인계 · 프로젝트 종료 정리)를 마치면 종료할 수 있습니다.</p>')}
        <div class="err" data-cl-err="form"></div>
      </div>
      <div class="gl__f"><span></span><span class="gl__btns"><button type="button" class="btn btn--ghost btn--sm" data-cl-later>나중에</button><button type="submit" class="btn btn--primary btn--sm" data-cl-ok ${ready ? '' : 'disabled'}>프로젝트 종료</button></span></div>
    </form>`;
    const done = (v) => { el.remove(); resolve(v); };
    $('#cl-d', el).oninput = (e) => { closed = e.target.value; $('[data-cl-err="closed_on"]', el).textContent = closed > today ? '종료일은 오늘 이후 날짜로 정할 수 없습니다.' : ''; if (!wTouched && /^\d{4}-\d{2}-\d{2}$/.test(closed)) { warranty = addMonths(closed, 12); $('#cl-w', el).value = warranty; } };
    $('#cl-w', el).oninput = (e) => { wTouched = true; warranty = e.target.value; };
    $('[data-cl-later]', el).onclick = () => done(null);
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const ok = $('[data-cl-ok]', el); if (ok.disabled) return;
      if (!closed) { $('[data-cl-err="closed_on"]', el).textContent = '종료일을 입력하세요.'; return; }
      ok.disabled = true;
      try { const r = await api('POST', wsApi(`/${pid}/close`), { closed_on: closed, warranty_end_on: warranty || '' }); toast('프로젝트를 종료했습니다.'); done(r); }
      catch (err) { el.querySelectorAll('[data-cl-err]').forEach((x) => { x.textContent = (err.fields || {})[x.dataset.clErr] || ''; }); if (!err.fields || !Object.keys(err.fields).length) $('[data-cl-err="form"]', el).textContent = err.message; ok.disabled = false; }
    };
    el.addEventListener('click', (e) => { if (e.target === el) done(null); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.append(el); $('#cl-d', el).focus();
  });
}

/** CLOSE 완료 처리 without a FINAL 완료보고서 (written outside RELAI) — 사유 required (server 422 otherwise). Resolves the fresh payload or null. */
export async function closeManual(pid, stepId) {
  const reason = await promptDialog({ title: '완료보고서 없이 완료 처리할까요?', body: '완료보고서를 RELAI 밖에서 작성했다면 어디에 어떻게 남겼는지 적어 두세요. 나중에 결과를 찾을 때 근거가 됩니다.', label: '사유', placeholder: '예: 고객사 양식으로 작성해 10/30 메일로 전달함', required: true, confirm: '완료 처리' });
  if (!reason) return null;
  try { const r = await api('PATCH', wsApi(`/${pid}/steps/${stepId}`), { status: 'COMPLETED', reason }); toast('완료 처리했습니다.'); return r; }
  catch (e) { toast(e.message); return null; }
}

/** 보고서 ▾ `완료보고서 생성` / 07 CLOSE row / guide CTA: one report per project — a second call opens the existing one. */
export async function openCompletion(pid) {
  try { const r = await api('POST', wsApi(`/${pid}/weekly-reports/completion`), {}); if (!r.existing) toast('완료보고서 초안을 만들었습니다.'); navigate(`/app/projects/${pid}/reports/${r.report.id}`); return true; }
  catch (e) { toast(e.message); return false; }
}

/** 종료 취소 (⋯ 메뉴 and the closed What's Next link). Resolves the fresh payload or null. */
export async function reopenProject(pid) {
  if (!(await confirmDialog({ title: '종료를 취소할까요?', body: '프로젝트가 다시 진행 중이 되고 07 안내가 다시 보입니다. 기록은 그대로입니다.', confirm: '종료 취소' }))) return null;
  try { const r = await api('POST', wsApi(`/${pid}/reopen`), {}); toast('종료를 취소했습니다.'); return r; } catch (e) { toast(e.message); return null; }
}

/** What's Next after 종료 — empty-state pattern; the phase list stays available, folded below. */
export const closedPanel = (g) => {
  const p = g.project; const cr = g.completion_report;
  const href = cr && cr.report_id ? `/app/projects/${p.id}/reports/${cr.report_id}` : `/app/projects/${p.id}/reports`;
  return html`<section class="closed" aria-labelledby="clsT" data-closed>
    <span class="closed__ic" aria-hidden="true">✓</span>
    <h2 id="clsT">프로젝트가 종료되었습니다</h2>
    <p class="closed__d">${md(String(p.closed_on || '').slice(0, 10))} 종료${p.warranty_end_on ? ` · 하자보수 ${ymdSlash(p.warranty_end_on)}까지` : ''}</p>
    <a class="btn btn--primary closed__cta" href="${href}" data-link>완료보고서 보기</a>
    ${raw(p.status === 'COMPLETED' ? '<button type="button" class="link linkbtn closed__undo" data-reopen>종료 취소</button>' : '')}
  </section>`;
};
