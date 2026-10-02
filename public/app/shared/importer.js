/* Excel import wizard (full-screen modal): 파일 → 검증·수정 → 결과.
 * Server contract: POST {base}/import/preview ({data}|{rows}) · POST {base}/import ({rows}) · POST {base}/import/errors.xlsx.
 * The preview is editable: fix a cell, re-validate, then import. Invalid rows never block the valid ones (partial success). */
import { api } from '../core/api.js';
import { html, raw } from '../core/dom.js';
import { download, fileToBase64 } from '../core/ui.js';
import { toast } from './dialogs.js';

const STEPS = ['파일 선택', '검증·수정', '가져오기 결과'];
const KIND_LABEL = { requirements: '요구사항', wbs: 'WBS' };
const TEMPLATE_NAME = { requirements: '요구사항 등록 템플릿.xlsx', wbs: 'WBS 등록 템플릿.xlsx' };

/**
 * @param {{kind:'requirements'|'wbs', base:string, parentId?:string, onDone?:()=>void}} o
 *   base = `/api/workspaces/:wid/projects/:pid/<kind>`
 */
export function openImport({ kind, base, parentId, onDone = () => {} }) {
  const label = KIND_LABEL[kind];
  const el = document.createElement('div');
  el.className = 'impscrim';
  document.body.append(el);
  const prevKey = document.onkeydown;

  let step = 1; let columns = []; let rows = []; let warnings = []; let errOnly = false; let busy = false; let result = null; let fileName = '';
  let dirty = false;

  const close = () => { document.onkeydown = prevKey; el.remove(); if (result) onDone(); };
  const tryClose = () => { if (dirty && step === 2 && !confirm('검증 중인 내용이 사라집니다. 닫을까요?')) return; close(); };

  const summary = () => ({ total: rows.length, ok: rows.filter((r) => r.ok).length, error: rows.filter((r) => !r.ok).length });

  const shell = (body, footer) => html`<div class="imp" role="dialog" aria-modal="true" aria-label="${label} Excel 가져오기">
    <div class="imp__h"><h3>${label} Excel 가져오기</h3>${raw(fileName ? html`<span class="hint">${fileName}</span>` : '')}<button class="imp__x" data-x aria-label="닫기">×</button></div>
    <div class="imp__steps">${raw(STEPS.map((s, i) => html`<span class="imp__step ${step === i + 1 ? 'is-on' : step > i + 1 ? 'is-done' : ''}"><i>${step > i + 1 ? '✓' : i + 1}</i>${s}</span>`).join(''))}</div>
    <div class="imp__body">${raw(body)}</div><div class="imp__f">${raw(footer)}</div></div>`;

  /* ---------- step 1: file ---------- */
  const drawFile = () => {
    el.innerHTML = shell(html`
      <div class="drop" id="drop" tabindex="0" role="button"><b>Excel 파일(.xlsx)을 여기에 끌어다 놓거나 클릭해 선택하세요</b>
        <span>최대 5MB · 한 번에 최대 2,000행 · 첫 번째 시트를 읽습니다</span>
        <input type="file" id="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></div>
      <div class="imp__tpl"><button class="btn btn--secondary" data-tpl>${TEMPLATE_NAME[kind]} 내려받기</button>
        <span class="hint">템플릿에 입력 → 업로드 → 오류 확인·수정 → 가져오기 순서로 진행합니다. ${kind === 'wbs' ? 'WBS Code(1, 1.1, 1.2.1)로 계층이 만들어집니다.' : '요구사항 ID를 비우면 자동 채번됩니다.'}</span></div>
      <p class="hint" style="margin-top:14px">${busy ? '파일을 읽고 검증하는 중…' : ''}</p>`, '<span class="sp"></span><button class="btn btn--secondary" data-x>닫기</button>');
    const drop = el.querySelector('#drop'); const input = el.querySelector('#file');
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('is-over'); };
    drop.ondragleave = () => drop.classList.remove('is-over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('is-over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
    input.onchange = () => { if (input.files[0]) upload(input.files[0]); };
  };

  const upload = async (file) => {
    if (!/\.xlsx$/i.test(file.name)) { toast('.xlsx 파일만 업로드할 수 있습니다.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('파일은 5MB 이하여야 합니다.'); return; }
    busy = true; fileName = file.name; drawFile();
    try {
      const data = await fileToBase64(file);
      const d = await api('POST', `${base}/import/preview`, { data, ...(parentId ? { parent_id: parentId } : {}) });
      columns = d.columns; rows = d.rows; warnings = d.warnings || []; errOnly = rows.some((r) => !r.ok) && rows.length > 30; dirty = false; busy = false; step = 2; drawPreview();
    } catch (e) { busy = false; fileName = ''; drawFile(); toast(e.message); }
  };

  /* ---------- step 2: preview / fix ---------- */
  const cellInput = (c, r) => {
    const v = r.values[c.key] || '';
    if (c.type === 'enum') {
      const labels = c.options.map((o) => o.label);
      const known = labels.includes(v) || c.options.some((o) => o.value === v) || v === '';
      return html`<select data-k="${c.key}"><option value=""></option>${raw(c.options.map((o) => html`<option value="${o.label}" ${v === o.label || v === o.value ? 'selected' : ''}>${o.label}</option>`).join(''))}${raw(known ? '' : html`<option value="${v}" selected>${v}</option>`)}</select>`;
    }
    if (c.type === 'multiline') return html`<textarea data-k="${c.key}" rows="1">${v}</textarea>`;
    return html`<input data-k="${c.key}" value="${v}" ${c.type === 'number' ? 'inputmode="numeric"' : ''}>`;
  };
  const rowHtml = (r, idx) => html`<tr class="${r.ok ? '' : 'is-bad'}" data-i="${idx}"><td class="rn">${r.row}</td>
    <td class="st">${raw(r.ok ? '<span class="chip chip--done">정상</span>' : html`<span class="chip chip--fail">오류 ${Object.keys(r.errors).length + r.row_errors.length}</span>`)}</td>
    ${raw(columns.map((c) => html`<td class="${r.errors[c.key] ? 'is-err' : ''}">${raw(cellInput(c, r))}${raw(r.errors[c.key] ? html`<span class="imp__msg">${r.errors[c.key]}</span>` : '')}</td>`).join(''))}</tr>
    ${raw(r.row_errors.length ? html`<tr class="is-bad"><td></td><td></td><td colspan="${columns.length}" class="imp__rowerr">${r.row_errors.join(' · ')}</td></tr>` : '')}`;

  const drawPreview = () => {
    const s = summary();
    const shown = rows.map((r, i) => [r, i]).filter(([r]) => !errOnly || !r.ok);
    el.innerHTML = shell(html`
      ${raw(warnings.length ? html`<div class="imp__warn">${warnings.join(' · ')}</div>` : '')}
      <div class="imp__cards"><div class="imp__card"><b>${s.total.toLocaleString('ko-KR')}</b><span>읽은 행</span></div>
        <div class="imp__card is-ok"><b>${s.ok.toLocaleString('ko-KR')}</b><span>가져올 수 있음</span></div>
        <div class="imp__card is-err"><b>${s.error.toLocaleString('ko-KR')}</b><span>오류 (수정하거나 제외됩니다)</span></div></div>
      <div class="imp__opts"><label class="toggle"><input type="checkbox" id="errOnly" ${errOnly ? 'checked' : ''}> 오류 행만 보기</label>
        <span class="hint">셀을 직접 수정한 뒤 [다시 검증]을 누르세요. 오류가 남은 행은 가져오지 않습니다.</span></div>
      <div class="imp__tbl"><table><thead><tr><th>행</th><th>상태</th>${raw(columns.map((c) => html`<th>${c.label}${raw(c.required ? ' <span class="req">*</span>' : '')}</th>`).join(''))}</tr></thead>
        <tbody id="ptb">${raw(shown.map(([r, i]) => rowHtml(r, i)).join('') || `<tr><td colspan="${columns.length + 2}" class="hint" style="padding:18px">표시할 행이 없습니다.</td></tr>`)}</tbody></table></div>`,
    html`<button class="btn btn--secondary" data-back>다른 파일 선택</button>
      ${raw(s.error ? '<button class="btn btn--secondary" data-errxlsx>오류 행 Excel 내려받기</button>' : '')}<span class="sp"></span>
      <button class="btn btn--secondary" data-revalidate>다시 검증</button>
      <button class="btn btn--primary" data-run ${s.ok ? '' : 'disabled'}>${s.ok.toLocaleString('ko-KR')}건 가져오기${s.error ? ` (오류 ${s.error.toLocaleString('ko-KR')}건 제외)` : ''}</button>`);
    el.querySelectorAll('#ptb textarea').forEach(autosize);
  };
  const autosize = (t) => { t.style.height = '30px'; if (t.scrollHeight > 32) t.style.height = Math.min(t.scrollHeight, 120) + 'px'; };

  const payloadRows = () => rows.map((r) => ({ row: r.row, values: r.values }));
  const revalidate = async () => {
    const d = await api('POST', `${base}/import/preview`, { rows: payloadRows(), ...(parentId ? { parent_id: parentId } : {}) });
    rows = d.rows; warnings = d.warnings || []; dirty = false; drawPreview();
  };
  const run = async () => {
    const btn = el.querySelector('[data-run]'); btn.disabled = true; btn.textContent = '가져오는 중…';
    try {
      // Always validate once more so the user sees the current state before anything is written.
      const d = await api('POST', `${base}/import`, { rows: payloadRows(), ...(parentId ? { parent_id: parentId } : {}) });
      const byRow = new Map(rows.map((r) => [r.row, r]));
      result = { ...d, failedRows: d.results.filter((x) => !x.ok).map((x) => ({ row: x.row, values: (byRow.get(x.row) || { values: {} }).values, errors: x.errors || {}, row_errors: x.row_errors || [] })) };
      step = 3; dirty = false; drawResult();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '다시 시도'; }
  };

  /* ---------- step 3: result ---------- */
  const downloadErrors = async (list) => {
    try { await download(`${base}/import/errors.xlsx`, { method: 'POST', body: { rows: list }, filename: `${label} 가져오기 오류 목록.xlsx` }); } catch (e) { toast(e.message); }
  };
  const drawResult = () => {
    const d = result; const failed = d.failedRows;
    el.innerHTML = shell(html`<div class="imp__res"><div class="imp__cards"><div class="imp__card"><b>${d.total.toLocaleString('ko-KR')}</b><span>총 처리 건수</span></div>
      <div class="imp__card is-ok"><b>${d.created.toLocaleString('ko-KR')}</b><span>성공</span></div>
      <div class="imp__card is-err"><b>${d.failed.toLocaleString('ko-KR')}</b><span>오류</span></div></div>
      <p>${raw(d.created ? html`${label} <b>${d.created.toLocaleString('ko-KR')}건</b>을 등록했습니다.` : '등록된 항목이 없습니다.')}${d.failed ? ' 오류가 있는 행은 등록하지 않았습니다. 아래 목록을 확인하거나 오류 행만 Excel로 내려받아 수정한 뒤 다시 가져오세요.' : ''}</p>
      ${raw(failed.length ? html`<div class="imp__tbl" style="margin-top:12px"><table><thead><tr><th>행</th><th>오류 내용</th></tr></thead><tbody>${raw(failed.map((f) => html`<tr><td class="rn">${f.row}</td><td style="padding:6px 8px;min-width:420px">${Object.entries(f.errors).map(([k, m]) => `${(columns.find((c) => c.key === k) || { label: k }).label}: ${m}`).concat(f.row_errors).join(' · ')}</td></tr>`).join(''))}</tbody></table></div>` : '')}</div>`,
    html`${raw(failed.length ? '<button class="btn btn--secondary" data-errxlsx2>오류 행 Excel 내려받기</button>' : '')}<span class="sp"></span><button class="btn btn--primary" data-x>확인</button>`);
  };

  /* ---------- wiring (delegated; the wizard redraws itself on each step) ---------- */
  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === el && step !== 2) return close();
    if (t.closest('[data-x]')) return tryClose();
    if (t.closest('[data-tpl]')) { try { await download(`${base}/template.xlsx`, { filename: TEMPLATE_NAME[kind] }); } catch (err) { toast(err.message); } return; }
    if (t.closest('[data-back]')) { step = 1; fileName = ''; drawFile(); return; }
    if (t.closest('[data-revalidate]')) { const b = t.closest('button'); b.disabled = true; b.textContent = '검증 중…'; try { await revalidate(); } catch (err) { toast(err.message); drawPreview(); } return; }
    if (t.closest('[data-run]')) return run();
    if (t.closest('[data-errxlsx]')) return downloadErrors(rows.filter((r) => !r.ok).map(({ row, values, errors, row_errors }) => ({ row, values, errors, row_errors })));
    if (t.closest('[data-errxlsx2]')) return downloadErrors(result.failedRows);
  });
  el.addEventListener('change', (e) => {
    if (e.target.id === 'errOnly') { errOnly = e.target.checked; drawPreview(); return; }
    const k = e.target.dataset && e.target.dataset.k; if (!k) return;
    const tr = e.target.closest('tr[data-i]'); const r = rows[Number(tr.dataset.i)];
    r.values[k] = e.target.value; dirty = true;
  });
  el.addEventListener('input', (e) => { if (e.target.matches('textarea')) autosize(e.target); });
  document.onkeydown = (e) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) tryClose(); };

  drawFile();
}

