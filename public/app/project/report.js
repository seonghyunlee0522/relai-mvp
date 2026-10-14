/* Weekly Report page (§26–30): document-like editor. DRAFT = editable sections (markdown textareas, autosave on blur); FINAL = read-only. */
import { api, wsApi } from '../core/api.js';
import { $, fmtDT, html, raw } from '../core/dom.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { download } from '../core/ui.js';
import { bindCoach, coachMark } from '../onboarding/ui.js';
import { projectHead } from './guide.js';
import { term } from './initiation.js';
import { closeDialog } from './closing.js';
import { navigate } from '../core/router.js';

/** 완료보고서 7절 교훈: three PM-written fields with a placeholder (no auto fill). */
const LESSON_PH = { good: '예: 요구사항 기준선 승인을 일찍 받아 변경 다툼이 적었다', bad: '예: 데이터 이관 리허설이 한 번뿐이라 오픈이 5일 밀렸다', next: '예: 이관 리허설을 일정에 두 번 넣는다' };
const lessonsBlock = (s, ro) => html`<div class="doc__lessons">${raw(s.fields.map((f) => html`<div class="doc__lesson"><h3>${f.label}</h3>${raw(ro
  ? html`<div class="doc__body">${raw(mdToHtml(f.body) || '<p class="dim">-</p>')}</div>`
  : html`<label class="sr-only" for="ls-${f.key}">${f.label}</label><textarea class="textarea doc__ta" id="ls-${f.key}" data-lesson="${f.key}" data-lesson-sec="${s.key}" rows="3" placeholder="${LESSON_PH[f.key] || ''}">${f.body}</textarea>`)}</div>`).join(''))}</div>`;

/** Minimal markdown → HTML for the read view: headings, bold, bullet lists (nested by 2-space indent), paragraphs. Escaped first via html``. */
export function mdToHtml(md) {
  const out = []; let list = null; const closeList = () => { if (list) { out.push('</ul>'.repeat(list)); list = null; } };
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^(\s*)- (.*)$/);
    if (m) { const depth = Math.floor(m[1].length / 2) + 1; if (!list) { out.push('<ul>'); list = 1; } while (list < depth) { out.push('<ul>'); list++; } while (list > depth) { out.push('</ul>'); list--; } out.push(html`<li>${raw(inline(m[2]))}</li>`); continue; }
    closeList();
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); return out.join('');
}
const inline = (t) => html`${t}`.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

const RS = { DRAFT: ['초안', 'chip--muted'], FINAL: ['확정', 'chip--done'] };

export async function reportPage(pid, rid, main = $('#main')) {
  let { report } = await api('GET', wsApi(`/${pid}/weekly-reports/${rid}`));
  const g = await api('GET', wsApi(`/${pid}`)); const proj = g.project;
  const archived = proj.status === 'ARCHIVED';
  const done = report.report_type === 'COMPLETION';   // Phase 7 US-1: 완료보고서 — same screen, buttons and export
  const kind = done ? '완료보고서' : '주간보고';
  document.title = `${report.title} — RELAI`;
  const draw = () => {
    const ro = report.status === 'FINAL' || archived; const sc = report.structured_content;
    main.innerHTML = html`${raw(projectHead(proj, g, { tab: done ? 'close' : 'overview-reports', title: kind }))}<div class="page page--doc">
      <a class="crumb" href="/app/projects/${pid}" data-link>← ${proj.name}</a>
      ${raw(done ? '' : coachMark('WEEKLY_REPORT_INTRO'))}
      <div class="doc__bar">
        <div class="doc__meta"><span class="chip ${RS[report.status][1]}">${RS[report.status][0]}</span>
          ${raw(done ? html`<span>${kind} ${raw(term('completion_report'))}</span>` : '')}<span>${done ? '프로젝트 기간' : '보고 기간'} <b>${sc.period.start} ~ ${sc.period.end}</b></span><span>생성 ${fmtDT(report.generated_at)}</span>${raw(report.finalized_at ? html`<span>확정 ${fmtDT(report.finalized_at)}</span>` : '')}<span id="dsave" class="doc__save"></span></div>
        <div class="doc__actions">
          <button class="btn btn--secondary btn--sm" data-dl="pdf">PDF 다운로드</button><button class="btn btn--secondary btn--sm" data-dl="docx">Word 다운로드</button>
          <button class="btn btn--secondary btn--sm" id="copy-md">복사 (Markdown)</button><button class="btn btn--secondary btn--sm" id="copy-txt">복사 (텍스트)</button>
          ${raw(archived ? '' : report.status === 'DRAFT' ? '<button class="btn btn--primary btn--sm" id="finalize">보고서 확정</button>' : '<button class="btn btn--secondary btn--sm" id="reopen">다시 편집</button>')}
        </div></div>
      ${raw(archived ? '<div class="notice">보관된 프로젝트의 보고서는 조회만 할 수 있습니다.</div>' : '')}
      <article class="doc">
        ${raw(ro ? html`<h1 class="doc__title">${report.title}</h1>` : html`<input class="doc__title doc__title--in" id="title" value="${report.title}" maxlength="200" aria-label="보고서 제목">`)}
        <p class="doc__period">${done ? '프로젝트 기간' : '보고 기간'}: ${sc.period.start} ~ ${sc.period.end}</p>
        ${raw(sc.sections.map((s, i) => html`<section class="doc__sec" data-key="${s.key}">
          <h2>${i + 1}. ${s.title}</h2>
          ${raw(Array.isArray(s.fields) ? lessonsBlock(s, ro)
            : ro ? html`<div class="doc__body">${raw(mdToHtml(s.body) || '<p class="dim">-</p>')}</div>`
            : html`<textarea class="textarea doc__ta" data-sec="${s.key}" rows="${Math.min(14, Math.max(3, s.body.split('\\n').length + 1))}" aria-label="${s.title}">${s.body}</textarea>
              <div class="doc__secact"><button class="link linkbtn" data-add="${s.key}">+ 항목 추가</button><span class="dim">한 줄에 한 항목(“- ”로 시작)으로 작성하면 복사 시 불릿으로 정리됩니다.</span></div>`)}
        </section>`).join(''))}
      </article>
    </div>`;
    bind();
  };
  const save = async (patch) => {
    const ind = $('#dsave'); if (ind) ind.textContent = '저장 중…';
    try { report = (await api('PATCH', wsApi(`/${pid}/weekly-reports/${rid}`), patch)).report; if (ind) ind.textContent = '저장됨'; }
    catch (e) { if (ind) ind.textContent = ''; toast(e.message); }
  };
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} 형식으로 복사했습니다.`); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(`${label} 형식으로 복사했습니다.`); }
  };
  const bind = () => {
    bindCoach(main);
    $('#copy-md').onclick = () => copy(report.rendered_content, 'Markdown');
    main.querySelectorAll('[data-dl]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await download(wsApi(`/${pid}/weekly-reports/${rid}/export.${b.dataset.dl}`)); } catch (e) { toast(e.message); } finally { b.disabled = false; }
    });
    $('#copy-txt').onclick = () => copy(report.plain_text, '텍스트');
    const t = $('#title'); if (t) t.onchange = () => { if (t.value.trim()) save({ title: t.value.trim() }); };
    const fit = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.max(72, ta.scrollHeight + 4) + 'px'; };
    main.querySelectorAll('[data-sec]').forEach((ta) => { fit(ta); ta.onchange = () => save({ sections: [{ key: ta.dataset.sec, body: ta.value }] }); ta.oninput = () => { fit(ta); const ind = $('#dsave'); if (ind) ind.textContent = ''; }; });
    main.querySelectorAll('[data-lesson]').forEach((ta) => { fit(ta); ta.onchange = () => save({ sections: [{ key: ta.dataset.lessonSec, fields: { [ta.dataset.lesson]: ta.value } }] }); ta.oninput = () => fit(ta); });
    main.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { const ta = main.querySelector(`[data-sec="${b.dataset.add}"]`); ta.value = (ta.value.trimEnd() ? ta.value.trimEnd() + '\n' : '') + '- '; fit(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    const f = $('#finalize'); if (f) f.onclick = async () => {
      if (!(await confirmDialog({ title: '보고서를 확정할까요?', body: '확정하면 읽기 전용이 되고 확정 시각이 기록됩니다. 필요하면 "다시 편집"으로 초안으로 되돌릴 수 있습니다.', confirm: '보고서 확정' }))) return;
      try { report = (await api('POST', wsApi(`/${pid}/weekly-reports/${rid}/finalize`), {})).report; toast('보고서를 확정했습니다.'); draw(); } catch (e) { toast(e.message); return; }
      // Phase 7 US-2: 완료보고서 확정 = CLOSE 완료 → "프로젝트를 종료할까요?" (07 필수가 모두 끝났을 때 종료 가능)
      if (done && proj.status !== 'COMPLETED') { const fresh = await api('GET', wsApi(`/${pid}`)); const r2 = await closeDialog(pid, fresh); if (r2) navigate(`/app/projects/${pid}`); }
    };
    const r = $('#reopen'); if (r) r.onclick = async () => {
      if (!(await confirmDialog({ title: '다시 편집할까요?', body: '보고서가 초안 상태로 돌아갑니다. 마지막 확정 시각은 기록으로 남습니다.', confirm: '다시 편집' }))) return;
      try { report = (await api('POST', wsApi(`/${pid}/weekly-reports/${rid}/reopen`), {})).report; draw(); } catch (e) { toast(e.message); }
    };
  };
  draw();
}
