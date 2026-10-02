/* Feature 4 — RELAI에게 물어보기. A slide-over panel inside the project workspace (no floating chatbot). Read-only:
 * every answer cites project entities (validated server-side) and the conversation lives only for this page session. */
import { api, wsApi } from '../core/api.js';
import { $, esc, html, raw } from '../core/dom.js';
import { aiErrorMessage, aiStatus, canRun, creditLine } from '../shared/ai.js';

const SUGGEST = ['지금 프로젝트에서 가장 위험한 것은?', '이번 주에 확인할 건 뭐야?', 'WBS에 연결되지 않은 요구사항이 있어?', '테스트 실패한 항목 정리해줘', '오픈 일정에 영향을 줄 만한 건 뭐야?'];
const TYPE_LABEL = { REQUIREMENT: 'REQ', WBS: 'WBS', CHANGE: 'CR', ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', ACCEPTANCE: 'Acc.' };
const sessions = new Map();   // pid → [{ role, content, references?, warnings? }]
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

/** Shows the header CTA once the status says AI is on (the header is rendered synchronously, before the status is known). */
export function revealAskButton(pid) {
  aiStatus(pid).then((st) => { document.querySelectorAll(`[data-ai-ask="${pid}"]`).forEach((b) => { b.hidden = !st.enabled; }); });
}

export async function openAssistant(pid) {
  document.querySelector('.aipanel')?.remove();
  const st = await aiStatus(pid, { fresh: true });
  const history = sessions.get(pid) || []; sessions.set(pid, history);
  const el = document.createElement('div'); el.className = 'aipanel';
  el.innerHTML = html`<div class="aipanel__scrim" data-close></div><aside class="aipanel__p" role="dialog" aria-modal="true" aria-labelledby="aiAT">
    <div class="aipanel__h"><div><b id="aiAT">RELAI에게 물어보기</b><small class="dim">읽기 전용 · 답변은 프로젝트 데이터를 근거로 합니다</small></div><button type="button" class="drawer__x" data-close aria-label="닫기">×</button></div>
    <div class="aipanel__b" id="ai-log"></div>
    <form class="aipanel__f" id="ai-form"><div class="aipanel__meta">${raw(creditLine(st, 'PROJECT_QA'))}<small class="dim">${st.notice || ''}</small></div>
      <div class="aipanel__in"><textarea class="textarea" id="ai-q" rows="2" maxlength="1000" placeholder="예) CR-003 영향은 어디까지야?  (Enter 전송, Shift+Enter 줄바꿈)" ${canRun(st, 'PROJECT_QA') ? '' : 'disabled'}></textarea><button class="btn btn--primary btn--sm" type="submit" id="ai-send" ${canRun(st, 'PROJECT_QA') ? '' : 'disabled'}>질문</button></div></form></aside>`;
  document.body.append(el);
  const log = $('#ai-log', el); const form = $('#ai-form', el); const ta = $('#ai-q', el);
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  const draw = () => {
    log.innerHTML = html`${raw(history.length ? '' : html`<div class="aichat__hello"><p>프로젝트 상태, 일정, 요구사항, 이슈·리스크, 테스트에 대해 물어보세요. 저는 데이터를 읽고 설명만 하며, 아무것도 변경하지 않습니다.</p><div class="aichat__sug">${raw(SUGGEST.map((s) => html`<button type="button" class="fchip2" data-sug="${s}">${s}</button>`).join(''))}</div></div>`)}
      ${raw(history.map((m) => (m.role === 'user' ? html`<div class="aichat aichat--u"><div class="aichat__m">${m.content}</div></div>`
        : html`<div class="aichat aichat--a"><div class="aichat__m ${m.error ? 'is-err' : ''}">${raw(md(m.content))}
            ${raw(m.references?.length ? html`<div class="aichat__refs">${raw(m.references.map((r) => html`<a href="/app/projects/${pid}/${r.href}" data-link data-close><span class="chip chip--muted">${TYPE_LABEL[r.type] || r.type}</span><span class="mono">${r.display_id}</span> ${r.title}</a>`).join(''))}</div>` : '')}
            ${raw(m.warnings?.length ? html`<ul class="aid__warn aid__warn--sm">${raw(m.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul>` : '')}
            ${raw(m.run ? html`<small class="aichat__meta">${m.run.credit_cost} Credits · ${(m.run.latency_ms / 1000).toFixed(1)}s</small>` : '')}</div></div>`)).join(''))}
      ${raw(pending ? '<div class="aichat aichat--a"><div class="aichat__m is-wait"><span class="spin"></span> 프로젝트 데이터를 확인하는 중…</div></div>' : '')}`;
    log.querySelectorAll('[data-sug]').forEach((b) => b.onclick = () => { ta.value = b.dataset.sug; ask(); });
    log.scrollTop = log.scrollHeight;
  };
  let pending = false;
  const ask = async () => {
    const q = ta.value.trim(); if (q.length < 2 || pending) return;
    history.push({ role: 'user', content: q }); ta.value = ''; pending = true; draw(); $('#ai-send', el).disabled = true;
    try {
      const r = await api('POST', wsApi(`/${pid}/ai/ask`), { question: q, history: history.slice(-5, -1).map((m) => ({ role: m.role, content: m.content })) });
      history.push({ role: 'assistant', content: r.answer, references: r.references, warnings: r.warnings, run: r.run });
      const meta = $('.aipanel__meta', el); if (meta) meta.firstElementChild.outerHTML = creditLine({ ...st, credits: { ...st.credits, available: r.run.balance } }, 'PROJECT_QA');
    } catch (e) { history.push({ role: 'assistant', content: aiErrorMessage(e), error: true }); }
    finally { pending = false; $('#ai-send', el).disabled = !canRun(st, 'PROJECT_QA'); draw(); ta.focus(); }
  };
  form.onsubmit = (e) => { e.preventDefault(); ask(); };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };
  draw(); ta.focus();
}

let wired = false;
export function wireAssistant() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-ai-ask]'); if (b) openAssistant(b.dataset.aiAsk); });
}
