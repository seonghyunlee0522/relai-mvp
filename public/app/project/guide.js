/* Project workspace header (Lifecycle V2) + phase transition dialog.
 * The header carries the minimum: project name · status · (work screens only) compact current-phase badge · (right) Activity · 보고서 · ⋯ · Help.
 * On What’s Next the phase is shown by the Lifecycle stepper and the RELAI Guide right below, so the header does not repeat it.
 * Navigation is the LNB (lnb.js); activity states come from the server payload (g.phases[].steps[].state). */
import { sampleChip } from './samples.js';
import { api, wsApi } from '../core/api.js';
import { html, no2, raw } from '../core/dom.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { revealAskButton, wireAssistant } from '../ai/assistant.js';
import { headerActions, headerMore, wireProjectActions } from './actions.js';
import { isPhone } from '../core/device.js';
import { mountProjectRail, pageHeader, pageInfo, setTopProject } from '../frame.js';
import { helpButton } from '../onboarding/ui.js';
import { mountLnb } from './lnb.js';
import { phoneHead } from '../shell.js';
import { josa } from '../shared/josa.js';
import { navigate } from '../core/router.js';
import { md } from '../shared/kst-date.js';
import { approvalGateDialog, APPROVAL_GATES, gateStep, bypassNote } from './initiation.js';

/** Status pill. Phase 7 US-2: a closed project reads `✓ 완료 · 10/30` (ok family) — never the same shape as 보관됨. */
export const statusPill = (p) => sampleChip(p) + (p.status === 'COMPLETED' && p.closed_on
  ? html`<span class="chip chip--done wsh__done" data-closed-pill>✓ 완료 · ${md(String(p.closed_on).slice(0, 10))}</span>`
  : html`<span class="chip ${STATUS_CHIP[p.status] || ''}">${STATUS[p.status]}</span>`);

/** 이슈 · 리스크 tab counts, shown on every tab of the 이슈·변경 group (batch5 P2-3): open issues, high/critical open risks. */
export const raidBadges = (is, rs) => ({ raid: is && is.active ? html`<em class="stabs__n">${is.active}</em>` : '', risks: rs && rs.high_or_critical ? html`<em class="stabs__n">${rs.high_or_critical}</em>` : '' });
/**
 * Project Workspace header (sticky) — also mounts the project LNB into the shell sidebar.
 * `tab` = LNB item key to mark active (next | overview | definition | requirements | wbs | overview-wbs | tests | acceptance | changes | raid | reports …);
 * `title` = optional screen title shown after the phase chip (e.g. "WBS 작성" vs "WBS · 운영 조회").
 */
export const projectHead = (p, g, { tab = null, title = '', badges = null } = {}) => {
  wireProjectActions();
  wireAssistant(); queueMicrotask(() => revealAskButton(p.id));   // CTA appears only when /ai/status says AI is on
  const cur = g.current_phase;
  if (!isPhone()) {
    // desktop (Redesign R1): rail door + section tabs + page header; project name / phase / status live in the top bar
    const info = pageInfo(p, g, { tab, title, badges });
    queueMicrotask(() => { mountProjectRail(p.id, info.door.key); setTopProject(p, g, statusPill(p)); });
    return pageHeader(p, g, info, html`<button type="button" class="btn btn--secondary btn--sm" data-ai-ask="${p.id}" hidden title="프로젝트 데이터를 근거로 답하는 읽기 전용 AI 보조">RELAI에게 물어보기</button>${raw(headerMore(p))}`);
  }
  queueMicrotask(() => { mountLnb(p, g, tab); phoneHead(p, g, statusPill(p)); });
  return html`<header class="wsh">
    <div class="wsh__row">
      <button type="button" class="wsh__menu" data-ws-menu aria-label="메뉴 열기" title="메뉴">☰</button>
      <a class="wsh__name" href="/app/projects/${p.id}" data-link title="${p.name}">${p.name}</a>
      ${raw(statusPill(p))}
      ${raw(cur && tab !== 'next' ? html`<a class="wsh__phase" href="/app/projects/${p.id}" data-link title="현재 단계 ${no2(cur.sequence)} ${cur.name} · 지금 할 일">${no2(cur.sequence)} ${cur.name}</a>` : '')}
      ${raw(title ? html`<span class="wsh__sep">/</span><span class="wsh__title">${title}</span>` : '')}
      <span class="wsh__sp"></span>
      <button type="button" class="btn btn--secondary btn--sm wsh__ask" data-ai-ask="${p.id}" hidden title="프로젝트 데이터를 근거로 답하는 읽기 전용 AI 보조">RELAI에게 물어보기</button>
      ${raw(headerActions(p))}${raw(helpButton())}
    </div></header>`;
};

/**
 * Dialogs for changing the current phase. Resolves true when the transition went through.
 * Every way out of 01 착수 / 02 요구사항 정의 (What's Next button, ?move=next from the guide) passes here, so the
 * approval soft gates live here (APPROVAL_GATES): 착수 결과 승인 / 요구사항 기준선 승인 not complete → record it first, or leave
 * a reason (stored in the gate step note as "[승인 전 진행] 사유 · 날짜 · 이름"). The server never blocks (확인 후 허용). */
/** REQUIRED activities still open in the phases before `target` (same rule as server/closing.js priorGaps — 완료보고서 6절 uses that number). */
export const priorGaps = (g, target) => (g.phases || []).filter((p) => p.sequence < target.sequence)
  .flatMap((p) => (p.steps || []).filter((a) => a.importance === 'REQUIRED' && a.state !== 'COMPLETED' && a.state !== 'SKIPPED').map((a) => ({ sequence: p.sequence, phase_name: p.name, title: a.title, href: a.cta ? a.cta.href : null })));

// a 앞 단계 link inside the dialog leaves it (the router handles the navigation)
document.addEventListener('click', (e) => { const a = e.target.closest('[data-gap-link]'); if (a) { const sc = a.closest('.scrim'); if (sc) sc.remove(); } }, true);

export async function moveToPhase(pid, g, target, { next = false } = {}) {
  const cur = g.current_phase;
  const acts = cur ? cur.steps || [] : [];
  const cfg = cur && target.sequence > cur.sequence ? APPROVAL_GATES[cur.phase_key] : null;
  const apv = cfg ? gateStep(g, cur.phase_key, cfg.step) : null;
  const gate = apv && apv.state !== 'COMPLETED';
  let bypass = null;
  if (gate) {
    const r = await approvalGateDialog(cfg);
    if (!r) return false;
    if (r === 'record') { navigate(cfg.record(pid)); return false; }
    bypass = r.reason;   // K16: written only after the move succeeds — cancelling the next dialog leaves no "[… 전 진행]" line
  }
  // the general dialog lists the other open REQUIRED activities (the approval gate step already handled above)
  const openReq = acts.filter((s) => s.importance === 'REQUIRED' && s.state !== 'COMPLETED' && s.state !== 'SKIPPED' && !(gate && s.step_key === cfg.step));
  // Phase 7 US-6: entering 07 names the REQUIRED activities still open in earlier phases (one line + links; never blocks)
  const gaps = target.phase_key === 'OPERATIONS' && target.sequence > (cur ? cur.sequence : 0) ? priorGaps(g, target) : [];
  const groups = []; for (const x of gaps) { const gr = groups.find((y) => y.sequence === x.sequence); if (gr) gr.items.push(x); else groups.push({ sequence: x.sequence, name: x.phase_name, items: [x] }); }
  const gapLine = gaps.length ? html`<p class="dgap" data-prior-gaps><i class="st st--warn" aria-hidden="true">!</i><span>앞 단계 미완료 필수 업무 ${gaps.length}건 (${raw(groups.map((gr) => { const label = gr.items.length === 1 ? `${no2(gr.sequence)} ${gr.items[0].title}` : `${no2(gr.sequence)} ${gr.name} ${gr.items.length}건`; const href = gr.items[0].href;
    return href ? html`<a class="link" href="${href}" data-link data-gap-link>${label}</a>` : html`${label}`; }).join(' · '))})</span></p>` : '';
  let ok;
  if (gate && !openReq.length) ok = true;   // the approval dialog was the confirmation
  else if (next && !openReq.length) {
    ok = await confirmDialog({ title: `${cur.name} 단계의 필수 업무를 모두 마쳤습니다.`, bodyHtml: html`${raw(gapLine)}다음 단계 ${no2(target.sequence)} ${josa(target.name, '을')} 시작하시겠습니까?`, confirm: '다음 단계 시작' });
  } else if (next) {
    const warns = (g.guidance && g.guidance.warnings) || [];
    ok = await confirmDialog({ title: '아직 완료되지 않은 필수 업무가 있습니다.',
      body: raw(html`${raw(gapLine)}<ul class="dlist">${raw(openReq.map((s) => html`<li>${s.title}</li>`).join(''))}${raw(warns.map((w) => html`<li class="is-warn">${w}</li>`).join(''))}</ul>그래도 <b>${no2(target.sequence)} ${target.name}</b> 단계를 시작하시겠습니까? 남은 업무는 그대로 유지되며, 이전 단계에서 다시 확인할 수 있습니다.`),
      confirm: '계속 진행' });
  } else {
    ok = await confirmDialog({ title: `${target.name} 단계를 현재 단계로 변경할까요?`,
      body: `현재 단계가 ${cur ? cur.name : '-'}에서 ${josa(target.name, '으로')} 바뀝니다. 각 단계의 업무 상태와 메모는 그대로 유지됩니다.`, confirm: '현재 단계로 변경' });
  }
  if (!ok) return false;
  try { await api('POST', wsApi(`/${pid}/phases/${target.id}/activate`), { reason: next ? 'NEXT' : 'MANUAL' }); }
  catch (e) { toast(e.message); return false; }
  if (bypass !== null) { try { await api('PATCH', wsApi(`/${pid}/steps/${apv.id}`), { note: bypassNote(apv.note, bypass, cfg) }); } catch (e) { toast(e.message); return true; } }
  toast(`현재 단계가 ${josa(target.name, '으로')} 변경되었습니다.`); return true;
}
