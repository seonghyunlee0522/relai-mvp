/* 관리자 › AI 프롬프트 (migration 68): every prompt the AI features send, stored in the DB (no row = code default).
 * List → one prompt: editor (diff vs the saved text, 기본값으로 되돌리기), a second confirm before every save / reset / restore,
 * version history with restore, and 전송 내용 보기 — system prompt, user-message template, JSON schema, model settings, plus a
 * per-project preview of the exact request (built by the real feature code; no AI call, no AI usage). Saving is desktop-only
 * (phone = view mode, core/api.js); viewing and the preview work on a phone. */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { isPhone } from '../core/device.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { bindRows, chip, errorBlock, fmtD, head, n, section, table } from './ui.js';

const who = (by) => (by ? by.name || by.email : '탈퇴한 사용자');
const ACTION = { SAVE: '저장', RESET: '기본값으로', RESTORE: '복원' };
const lastChange = (c) => (c ? html`${fmtD(c.at)} · ${who(c.by)} <small class="muted">(${ACTION[c.action] || c.action})</small>` : '<span class="muted">변경 없음 (코드 기본값)</span>');
const pre = (text, cls = '') => html`<pre class="acode ${cls}">${text}</pre>`;
const json = (v) => JSON.stringify(v, null, 2);
/** Unsaved editor text per key: survives the re-render a resize / rotation triggers; cleared on save, reset, restore and 편집 취소. */
const drafts = new Map();
const previews = new Map();   // last 전송 내용 미리보기 per key, kept across re-renders the same way

export async function adminPromptsPage(main = $('#main')) {
  document.title = 'AI 프롬프트 — RELAI 관리자';
  let d; try { d = await api('GET', '/api/admin/ai/prompts'); } catch (e) { main.innerHTML = errorBlock(e); return; }
  main.innerHTML = html`<div class="apage">
    ${raw(head('AI 프롬프트'))}
    <p class="hint aprm__lead">AI 기능이 보내는 프롬프트입니다. 저장하면 모든 워크스페이스에 약 ${d.cache_seconds / 60}분 안에 적용됩니다. 저장한 적 없는 항목은 코드 기본값을 그대로 씁니다.
      현재 AI: ${raw(d.enabled ? chip('ok', '사용 중') : chip('muted', '꺼짐'))} ${d.provider || '제공사 미설정'}${d.model ? ` · ${d.model}` : ''}</p>
    ${raw(table([
      { key: 'label', label: '프롬프트', w: 210, cls: 'ttl', render: (p) => html`<a href="/admin/ai-prompts/${p.key}" data-link>${p.label}</a>` },
      { key: 'where', label: '쓰이는 곳', render: (p) => html`${p.where}` },
      { key: 'overridden', label: '상태', w: 110, render: (p) => (p.overridden ? chip('act', `수정됨 v${p.version}`) : chip('muted', '기본값')) },
      { key: 'chars', label: '글자 수', w: 80, render: (p) => n(p.chars) },
      { key: 'last_change', label: '마지막 변경', w: 230, render: (p) => lastChange(p.last_change) },
    ], d.prompts, { rowHref: (p) => `/admin/ai-prompts/${p.key}`, id: 'aprm-tbl' }))}
    <p class="hint aprm__lead">실제 사용자의 AI 요청 원문은 저장하지 않습니다 (개인정보·보관 기간). 각 프롬프트의 ‘전송 내용 보기’에서 프로젝트를 골라 보낼 내용을 미리 볼 수 있습니다.</p>
  </div>`;
  bindRows(main, navigate);
}

/* ---------- line diff (LCS; prompts are a few hundred lines at most) ---------- */
function lineDiff(a, b) {
  const A = a.split('\n'); const B = b.split('\n');
  const m = A.length; const k = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(k + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < m && j < k) { if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', A[i++]]); else out.push(['+', B[j++]]); }
  while (i < m) out.push(['-', A[i++]]); while (j < k) out.push(['+', B[j++]]);
  return out;
}
const diffHtml = (a, b) => {
  const d = lineDiff(a, b); const changed = d.filter(([t]) => t !== ' ').length;
  if (!changed) return '<div class="aempty">바뀐 줄이 없습니다.</div>';
  // unchanged runs longer than 6 lines fold to their first and last 2
  const rows = []; let run = [];
  const flush = () => { if (run.length > 6) rows.push(...run.slice(0, 2), ['…', `(같은 줄 ${run.length - 4}개)`], ...run.slice(-2)); else rows.push(...run); run = []; };
  for (const r of d) { if (r[0] === ' ') run.push(r); else { flush(); rows.push(r); } } flush();
  return html`<div class="adiff" aria-label="바뀐 줄">${raw(rows.map(([t, l]) => html`<div class="adiff__l adiff__l--${t === '+' ? 'add' : t === '-' ? 'del' : t === '…' ? 'fold' : 'eq'}"><i>${t}</i><span>${l || ' '}</span></div>`).join(''))}</div>`;
};

export async function adminPromptPage(key, main = $('#main')) {
  let p; let preview = previews.get(key) || null; let draft = null; let tab = 'edit'; let lastProject = preview?.project.id || '';
  const load = async () => { p = await api('GET', `/api/admin/ai/prompts/${key}`); draft = drafts.get(key) ?? p.body; };
  try { await load(); } catch (e) { main.innerHTML = errorBlock(e); return; }
  document.title = `${p.label} — AI 프롬프트 — RELAI 관리자`;
  const phone = isPhone();
  const affectedText = () => (p.affected.length > 1 ? `AI 기능 ${p.affected.length}개 전부` : p.affected[0].label);

  const editTab = () => html`
    ${raw(section('프롬프트', html`<div class="aprm__ed">
      ${raw(phone ? '<p class="hint">휴대폰에서는 보기만 할 수 있습니다. 수정은 PC에서 해 주세요.</p>' : '')}
      <textarea class="input acode aprm__ta" id="pt" spellcheck="false" ${phone ? 'readonly' : ''} aria-label="${p.label} 프롬프트">${draft}</textarea>
      <div class="aprm__meta"><span id="pcount"></span><span class="aprm__sp"></span>
        <span class="muted">자리표시자: ${raw(Object.entries(p.placeholders).map(([k, v]) => html`<code title="${v.value}">{{${k}}}</code> ${v.label}`).join(' · ') || '없음')}</span></div>
      <div class="form-err" id="perr" role="alert" hidden></div>
      <div class="aprm__acts">
        <button type="button" class="btn btn--secondary btn--sm" id="p-default" ${phone || !p.overridden ? 'disabled' : ''}>기본값으로 되돌리기</button>
        <button type="button" class="btn btn--secondary btn--sm" id="p-undo" ${phone ? 'disabled' : ''}>편집 취소</button><span class="aprm__sp"></span>
        <button type="button" class="btn btn--primary btn--sm" id="p-save" ${phone ? 'disabled' : ''}>저장…</button></div>
    </div>`, html`<span class="aprm__h2">${raw(p.overridden ? chip('act', `수정됨 v${p.version}`) : chip('muted', '코드 기본값'))}</span>`))}
    ${raw(section('저장된 내용과 비교', '<div id="pdiff"></div>'))}
    ${raw(section('변경 이력', p.versions.length ? table([
      { key: 'version', label: '버전', w: 60, render: (v) => `v${v.version}` },
      { key: 'action', label: '변경', w: 110, render: (v) => html`${ACTION[v.action] || v.action}${v.restored_from ? ` (v${v.restored_from})` : ''}` },
      { key: 'created_at', label: '일시', w: 140, render: (v) => fmtD(v.created_at) },
      { key: 'created_by', label: '변경한 사람', render: (v) => html`${who(v.created_by)}` },
      { key: 'chars', label: '글자 수', w: 80, render: (v) => n(v.body.length) },
      { key: 'x', label: '', w: 150, render: (v) => html`<button type="button" class="btn btn--secondary btn--xs" data-vview="${v.version}">비교</button> ${raw(v.version === p.version || phone ? '' : html`<button type="button" class="btn btn--secondary btn--xs" data-vrestore="${v.version}">이 버전으로 복원</button>`)}` },
    ], p.versions, { id: 'pv-tbl' }) : '<div class="aempty">아직 저장한 적이 없습니다. 지금은 코드 기본값을 씁니다.</div>'))}`;

  const settingsDl = (s) => html`<dl class="adl">
    <dt>AI 제공사 · 모델</dt><dd>${s.provider || '미설정'} · ${s.model || '-'} ${raw(s.enabled ? '' : chip('muted', `AI 꺼짐${s.disabled_reason ? ` — ${s.disabled_reason}` : ''}`))}</dd>
    ${raw(s.feature ? html`<dt>AI 기능</dt><dd>${s.feature_label || s.feature}</dd><dt>최대 출력 토큰</dt><dd>${n(s.max_output_tokens)}</dd>` : '')}
    <dt>temperature</dt><dd>${s.temperature ?? s.temperature_note}</dd>
    <dt>제한 시간</dt><dd>${n(Math.round(s.timeout_ms / 1000))}초 · 입력 최대 ${n(s.max_input_chars)}자</dd>
    <dt>재시도</dt><dd>${s.retry}</dd>
    <dt>재요청 문구</dt><dd><code>${s.retry_hint}</code></dd>
    <dt>적용 시간</dt><dd>저장 후 약 ${s.cache_seconds}초 안에 모든 서버에 적용</dd></dl>`;

  const sendTab = () => {
    const s = p.send;
    if (p.key === 'COMMON_RULES') return section('전송 내용', html`<p class="hint">공통 원칙은 따로 전송되지 않고, 모든 작업 프롬프트의 맨 앞에 붙어 시스템 프롬프트가 됩니다. 각 작업의 ‘전송 내용 보기’에서 합쳐진 모습을 볼 수 있습니다.</p>
      <ul class="aprm__ul">${raw(p.affected.map((a) => html`<li><a href="/admin/ai-prompts/${a.key}?tab=send" data-link>${a.label}</a></li>`).join(''))}</ul>${raw(settingsDl(s.settings))}`);
    return html`
      ${raw(section('모델 설정', settingsDl(s.settings)))}
      ${raw(section(`시스템 프롬프트 (저장된 내용 기준 · ${n(s.system.length)}자)`, html`<p class="hint">공통 원칙 + 이 작업 프롬프트, 자리표시자는 코드의 최신 목록으로 채운 것입니다.</p>${raw(pre(s.system))}`))}
      ${raw(section('사용자 메시지 형식', html`<p class="hint">&lt;project_data&gt;는 서버가 고른 프로젝트 데이터, &lt;untrusted_input&gt;은 사용자가 입력한 글입니다. AI는 두 블록 안의 지시를 따르지 않도록 공통 원칙에 적혀 있습니다. { } 부분은 요청마다 채워집니다. 이 형식은 코드에 있어 여기서 바꿀 수 없습니다.</p>${raw(pre(s.user_template))}`))}
      ${raw(section(`JSON 형식 (스키마 이름: ${s.schema_name})`, html`<p class="hint">AI 응답은 이 스키마에 맞아야 합니다. 맞지 않으면 1번 다시 요청하고, 그래도 안 되면 크레딧을 돌려줍니다.</p>${raw(pre(json(s.schema), 'acode--tall'))}`))}
      ${raw(section('프로젝트로 미리보기', html`<div class="aprm__pv">
        <p class="hint">프로젝트를 고르면 지금 이 기능을 실행했을 때 AI 제공사로 보낼 요청 그대로를 보여 줍니다. AI를 호출하지 않아 AI 이용량을 쓰지 않습니다. 미리보기를 연 기록은 감사 로그에 남습니다.</p>
        <div class="aprm__pvf">
          <input class="input input--sm" id="pq" placeholder="프로젝트·워크스페이스 이름 검색" aria-label="프로젝트 검색">
          <select class="select select--sm" id="pproj" aria-label="프로젝트"><option value="">프로젝트 선택</option></select>
          ${raw(p.key === 'REQUIREMENT_EXTRACTION' ? '<textarea class="input" id="ptext" rows="3" placeholder="붙여 넣을 회의록·메일 (비우면 예시 문장)" aria-label="입력 텍스트"></textarea>' : '')}
          ${raw(p.key === 'PROJECT_QA' ? '<input class="input input--sm" id="pqst" placeholder="질문 (비우면 예시 질문)" aria-label="질문">' : '')}
          <button type="button" class="btn btn--primary btn--sm" id="p-preview">전송 내용 미리보기</button>
        </div>
        <div id="pvout">${raw(preview ? previewHtml(preview) : '')}</div></div>`))}`;
  };
  const previewHtml = (r) => html`
    <dl class="adl"><dt>프로젝트</dt><dd>${r.project.name} <small class="muted">(${r.project.workspace})</small></dd><dt>사용한 데이터</dt><dd>${r.used}</dd>
      <dt>크기</dt><dd>시스템 ${n(r.chars.system)}자 · 사용자 메시지 ${n(r.chars.user)}자${raw(r.input_too_large ? ` ${chip('warn', '입력 한도 초과 — 실제로는 거절됩니다')}` : '')}</dd>
      <dt>보낼 곳</dt><dd><code>${r.request.endpoint}</code></dd></dl>
    <h4 class="aprm__h4">시스템 프롬프트</h4>${raw(pre(r.system))}
    <h4 class="aprm__h4">사용자 메시지</h4>${raw(pre(r.user, 'acode--tall'))}
    <h4 class="aprm__h4">요청 본문 (JSON, API 키 제외)</h4>${raw(pre(json(r.request.body), 'acode--tall'))}`;

  const draw = () => {
    main.innerHTML = html`<div class="apage">
      ${raw(head(p.label, '', { href: '/admin/ai-prompts', label: 'AI 프롬프트' }))}
      <p class="hint aprm__lead">${p.where}</p>
      <div class="aprm__tabs" role="tablist">
        <button type="button" role="tab" class="aprm__tab ${tab === 'edit' ? 'is-on' : ''}" aria-selected="${tab === 'edit'}" data-tab="edit">프롬프트 편집</button>
        <button type="button" role="tab" class="aprm__tab ${tab === 'send' ? 'is-on' : ''}" aria-selected="${tab === 'send'}" data-tab="send">전송 내용 보기</button></div>
      <div id="ptab">${raw(tab === 'edit' ? editTab() : sendTab())}</div></div>`;
    main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; history.replaceState(null, '', `${location.pathname}${tab === 'send' ? '?tab=send' : ''}`); draw(); }; });
    if (tab === 'edit') bindEdit(); else bindSend();
  };

  const showDiff = (base, label) => { $('#pdiff').innerHTML = html`<p class="hint">${label}</p>${raw(diffHtml(base, $('#pt').value))}`; };
  const refreshEdit = () => {
    const t = $('#pt').value; draft = t; if (t === p.body) drafts.delete(key); else drafts.set(key, t);
    $('#pcount').textContent = `${t.length.toLocaleString('ko-KR')} / ${p.max_chars.toLocaleString('ko-KR')}자${t === p.body ? '' : ' · 저장 안 됨'}`;
    $('#pcount').classList.toggle('is-over', t.length > p.max_chars);
    showDiff(p.body, '왼쪽 −: 지금 저장된 내용, +: 편집 중인 내용');
  };
  const fail = (e) => { const el = $('#perr'); if (el) { el.textContent = e.message; el.hidden = false; } else toast(e.message); };
  /** 409 (someone else saved first) → reload but keep the operator's text in the editor. */
  const conflict = async (e, keep) => { if (e.status === 409 && e.code === 'prompt_conflict') { await load(); draft = keep; draw(); fail(e); return true; } return false; };

  const bindEdit = () => {
    const ta = $('#pt'); ta.oninput = refreshEdit; refreshEdit();
    $('#p-undo').onclick = () => { ta.value = p.body; refreshEdit(); };
    $('#p-save').onclick = async () => {
      $('#perr').hidden = true;
      const body = ta.value;
      if (body === p.body) return fail({ message: '바뀐 내용이 없습니다.' });
      let chk; try { chk = await api('POST', `/api/admin/ai/prompts/${key}/check`, { body }); } catch (e) { return fail(e); }
      if (chk.errors.length) return fail({ message: chk.errors.join(' ') });
      const ok = await confirmDialog({ title: 'AI 프롬프트를 저장할까요?', confirm: '저장하고 적용', danger: true, bodyHtml: html`
        <p><b>${affectedText()}</b>에 적용됩니다. 저장하면 <b>모든 워크스페이스</b>의 AI 요청에 약 ${p.send.settings.cache_seconds}초 안에 반영되고, 결과 품질이 크게 달라질 수 있습니다.</p>
        ${raw(p.affected.length > 1 ? html`<p class="hint">${p.affected.map((a) => a.label).join(' · ')}</p>` : '')}
        ${raw(chk.is_default ? '<p class="hint">코드 기본값과 같은 내용이라 ‘기본값으로 되돌리기’로 저장됩니다.</p>' : '')}
        ${raw(chk.warnings.length ? html`<div class="aprm__warn"><b>확인해 주세요</b><ul>${raw(chk.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul></div>` : '')}
        <p class="hint">글자 수 ${n(p.body.length)} → ${n(body.length)} · 이전 버전은 변경 이력에서 언제든 복원할 수 있습니다.</p>` });
      if (!ok) return;
      try { const r = await api('PUT', `/api/admin/ai/prompts/${key}`, { body, base_version: p.version }); drafts.delete(key); toast(`저장했습니다 (v${r.version}). 약 1분 안에 모든 워크스페이스에 적용됩니다.`); await load(); draw(); }
      catch (e) { if (!(await conflict(e, body))) fail(e); }
    };
    $('#p-default').onclick = async () => {
      const ok = await confirmDialog({ title: '코드 기본값으로 되돌릴까요?', confirm: '기본값으로 되돌리기', danger: true, bodyHtml: html`
        <p><b>${affectedText()}</b>이(가) 코드에 들어 있는 기본 프롬프트를 다시 씁니다. 모든 워크스페이스에 약 1분 안에 적용됩니다.</p><p class="hint">지금 내용은 변경 이력에 남아 복원할 수 있습니다.</p>` });
      if (!ok) return;
      try { await api('POST', `/api/admin/ai/prompts/${key}/reset`, { base_version: p.version }); drafts.delete(key); toast('기본값으로 되돌렸습니다.'); await load(); draw(); }
      catch (e) { if (!(await conflict(e, ta.value))) fail(e); }
    };
    main.querySelectorAll('[data-vview]').forEach((b) => { b.onclick = () => { const v = p.versions.find((x) => String(x.version) === b.dataset.vview); showDiff(v.body, `−: v${v.version}, +: 편집 중인 내용`); $('#pdiff').scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
    main.querySelectorAll('[data-vrestore]').forEach((b) => { b.onclick = async () => {
      const v = Number(b.dataset.vrestore);
      const ok = await confirmDialog({ title: `v${v}으로 복원할까요?`, confirm: '복원하고 적용', danger: true, bodyHtml: html`
        <p>v${v}의 내용을 새 버전으로 저장합니다. <b>${affectedText()}</b>에 적용되며 모든 워크스페이스에 약 1분 안에 반영됩니다.</p>` });
      if (!ok) return;
      try { await api('POST', `/api/admin/ai/prompts/${key}/restore`, { version: v, base_version: p.version }); drafts.delete(key); toast(`v${v} 내용으로 복원했습니다.`); await load(); draw(); }
      catch (e) { if (!(await conflict(e, ta.value))) fail(e); }
    }; });
  };

  const bindSend = () => {
    const btn = $('#p-preview'); if (!btn) return;
    const sel = $('#pproj'); let t;
    const fill = async (q = '') => {
      try {
        const { projects } = await api('GET', `/api/admin/ai/preview-projects?q=${encodeURIComponent(q)}`);
        sel.innerHTML = html`<option value="">프로젝트 선택 (${projects.length})</option>${raw(projects.map((x) => html`<option value="${x.id}" ${x.id === lastProject ? 'selected' : ''}>${x.name} — ${x.workspace} · 요구사항 ${x.requirements} · 변경 ${x.changes}${x.sample_key ? ' · 예시' : ''}</option>`).join(''))}`;
      } catch (e) { toast(e.message); }
    };
    fill();
    $('#pq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => fill(e.target.value.trim()), 300); };
    btn.onclick = async () => {
      if (!sel.value) { toast('프로젝트를 골라 주세요.'); sel.focus(); return; }
      lastProject = sel.value; btn.disabled = true; $('#pvout').innerHTML = '<div class="loading">만드는 중…</div>';
      try {
        preview = await api('POST', `/api/admin/ai/prompts/${key}/preview`, { project_id: sel.value, text: $('#ptext')?.value || '', question: $('#pqst')?.value || '' });
        previews.set(key, preview); $('#pvout').innerHTML = previewHtml(preview);
      } catch (e) { $('#pvout').innerHTML = errorBlock(e); }
      btn.disabled = false;
    };
  };

  if (new URLSearchParams(location.search).get('tab') === 'send') tab = 'send';
  draw();
}
