/* Project workspace header (Lifecycle V2) + phase transition dialog.
 * The header carries the minimum: project name · status · current lifecycle phase · (right) Activity · 보고서 · ⋯ · Help.
 * Navigation is the LNB (lnb.js); activity states come from the server payload (g.phases[].steps[].state). */
import { api, wsApi } from '../core/api.js';
import { html, no2, raw } from '../core/dom.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { revealAskButton, wireAssistant } from '../ai/assistant.js';
import { headerActions, wireProjectActions } from './actions.js';
import { helpButton } from '../onboarding/ui.js';
import { mountLnb } from './lnb.js';

/**
 * Project Workspace header (sticky) — also mounts the project LNB into the shell sidebar.
 * `tab` = LNB item key to mark active (next | overview | definition | requirements | wbs | overview-wbs | tests | acceptance | changes | raid | reports …);
 * `title` = optional screen title shown after the phase chip (e.g. "WBS 작성" vs "WBS · 운영 조회").
 */
export const projectHead = (p, g, { tab = null, title = '' } = {}) => {
  wireProjectActions();
  wireAssistant(); queueMicrotask(() => revealAskButton(p.id));   // CTA appears only when /ai/status says AI is on
  queueMicrotask(() => mountLnb(p, g, tab));
  const cur = g.current_phase;
  return html`<header class="wsh">
    <div class="wsh__row">
      <button type="button" class="wsh__menu" data-ws-menu aria-label="메뉴 열기" title="메뉴">☰</button>
      <a class="wsh__name" href="/app/projects/${p.id}" data-link title="${p.name}">${p.name}</a>
      <span class="chip ${STATUS_CHIP[p.status] || ''}">${STATUS[p.status]}</span>
      ${raw(cur ? html`<a class="wsh__phase" href="/app/projects/${p.id}" data-link title="현재 단계 · What’s Next"><span class="wsh__phk">현재 단계</span>${no2(cur.sequence)} ${cur.name}</a>` : '')}
      ${raw(title ? html`<span class="wsh__sep">/</span><span class="wsh__title">${title}</span>` : '')}
      <span class="wsh__owner" data-owner-id="${p.created_by || ''}" title="프로젝트 등록자"></span>
      <span class="wsh__sp"></span>
      <button type="button" class="btn btn--secondary btn--sm wsh__ask" data-ai-ask="${p.id}" hidden title="프로젝트 데이터를 근거로 답하는 읽기 전용 AI 보조">RELAI에게 물어보기</button>
      ${raw(headerActions(p))}${raw(helpButton())}
    </div></header>`;
};

/** Dialogs for changing the current phase. Resolves true when the transition went through. */
export async function moveToPhase(pid, g, target, { next = false } = {}) {
  const cur = g.current_phase;
  const acts = cur ? cur.steps || [] : [];
  const openReq = acts.filter((s) => s.importance === 'REQUIRED' && s.state !== 'COMPLETED' && s.state !== 'SKIPPED');
  let ok;
  if (next && !openReq.length) {
    ok = await confirmDialog({ title: `${cur.name} 단계의 필수 업무를 모두 마쳤습니다.`, body: `다음 단계 ${no2(target.sequence)} ${target.name}을(를) 시작하시겠습니까?`, confirm: '다음 단계 시작' });
  } else if (next) {
    const warns = (g.guidance && g.guidance.warnings) || [];
    ok = await confirmDialog({ title: '아직 완료되지 않은 필수 업무가 있습니다.',
      body: raw(html`<ul class="dlist">${raw(openReq.map((s) => html`<li>${s.title}</li>`).join(''))}${raw(warns.map((w) => html`<li class="is-warn">${w}</li>`).join(''))}</ul>그래도 <b>${no2(target.sequence)} ${target.name}</b> 단계를 시작하시겠습니까? 남은 업무는 그대로 유지되며, 이전 단계에서 다시 확인할 수 있습니다.`),
      confirm: '계속 진행' });
  } else {
    ok = await confirmDialog({ title: `${target.name} 단계를 현재 단계로 변경할까요?`,
      body: `현재 단계가 ${cur ? cur.name : '-'}에서 ${target.name}(으)로 바뀝니다. 각 단계의 업무 상태와 메모는 그대로 유지됩니다.`, confirm: '현재 단계로 변경' });
  }
  if (!ok) return false;
  try { await api('POST', wsApi(`/${pid}/phases/${target.id}/activate`), { reason: next ? 'NEXT' : 'MANUAL' }); toast(`현재 단계가 ${target.name}(으)로 변경되었습니다.`); return true; }
  catch (e) { toast(e.message); return false; }
}
