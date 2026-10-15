/* 관리자 › 프로모션 (migration 47): the offers shown on signup, login, landing pricing, 설정 › AI 크레딧 and Home.
 * List on the left, editor with a live preview (the same shared component the placements render) on the right.
 * Display only — editing here never changes credit grants or early-access dates. */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { confirmDialog, showErrors, toast } from '../shared/dialogs.js';
import { promoHtml } from '../shared/promo.js';
import { chip, errorBlock, fmtD, head, table } from './ui.js';

const EMPTY = { id: null, title: '', body: '', badge: '', link_url: '', link_label: '', placements: [], starts_on: '', ends_on: '', active: true, sort_order: 0 };

/** Shown / scheduled / ended / off, from active + the KST date window. */
const stateOf = (p, today) => (!p.active ? ['muted', '꺼짐'] : p.starts_on && p.starts_on > today ? ['warn', '예정'] : p.ends_on && p.ends_on < today ? ['muted', '종료'] : ['ok', '노출 중']);

export async function adminPromotionsPage(main = $('#main')) {
  document.title = '프로모션 — RELAI 관리자';
  let data; let cur = { ...EMPTY };
  const load = async () => { data = await api('GET', '/api/admin/promotions'); };
  try { await load(); } catch (e) { main.innerHTML = errorBlock(e); return; }

  const editor = () => {
    const P = data.placements;
    return html`<section class="asec apromo__ed" id="promo-editor"><div class="asec__h">${cur.id ? '프로모션 수정' : '새 프로모션'}</div>
      <form id="pf" class="apromo__f" novalidate>
        <div class="form-err" id="ferr" role="alert" hidden></div>
        <div class="field"><label for="p-title">제목 <span class="req">*</span></label><input class="input" id="p-title" name="title" maxlength="120" value="${cur.title}" placeholder="예: 12개월 동안 전체 기능 무료"><div class="err" data-for="title"></div></div>
        <div class="field"><label for="p-body">본문</label><textarea class="input" id="p-body" name="body" rows="3" maxlength="400" placeholder="한두 문장으로">${cur.body}</textarea>
          <div class="hint">{until}은 보는 사람의 얼리 액세스 종료일로 바뀝니다 (설정 › AI 크레딧, 홈). 종료일이 없는 사람에게는 이 프로모션을 보여 주지 않습니다.</div></div>
        <div class="apromo__row">
          <div class="field"><label for="p-badge">배지</label><input class="input" id="p-badge" name="badge" maxlength="20" value="${cur.badge || ''}" placeholder="예: 얼리 액세스"></div>
          <div class="field"><label for="p-sort">순서</label><input class="input" id="p-sort" name="sort_order" type="number" value="${cur.sort_order}"><div class="hint">작을수록 앞</div></div>
        </div>
        <div class="apromo__row">
          <div class="field"><label for="p-link">링크</label><input class="input" id="p-link" name="link_url" maxlength="300" value="${cur.link_url || ''}" placeholder="/signup 또는 https://…"><div class="err" data-for="link_url"></div></div>
          <div class="field"><label for="p-ll">버튼 문구</label><input class="input" id="p-ll" name="link_label" maxlength="30" value="${cur.link_label || ''}" placeholder="예: 무료로 시작하기"></div>
        </div>
        <fieldset class="field apromo__pl"><legend>노출 위치 <span class="req">*</span></legend>
          ${raw(Object.entries(P).map(([k, l]) => html`<label><input type="checkbox" name="placements" value="${k}" ${cur.placements.includes(k) ? 'checked' : ''}> ${l}</label>`).join(''))}
          <div class="err" data-for="placements"></div></fieldset>
        <div class="apromo__row">
          <div class="field"><label for="p-from">시작일</label><input class="input" id="p-from" name="starts_on" type="date" value="${cur.starts_on || ''}"><div class="err" data-for="starts_on"></div></div>
          <div class="field"><label for="p-to">종료일</label><input class="input" id="p-to" name="ends_on" type="date" value="${cur.ends_on || ''}"><div class="err" data-for="ends_on"></div></div>
        </div>
        <label class="apromo__on"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> 노출 (끄면 기간과 관계없이 숨김)</label>
        <div class="apromo__pv"><div class="apromo__pvh">미리보기</div><div id="p-preview"></div></div>
        <div class="apromo__acts">${raw(cur.id ? '<button type="button" class="btn btn--ghost btn--sm is-danger" id="p-del">삭제</button><span class="apromo__sp"></span>' : '<span class="apromo__sp"></span>')}
          <button type="button" class="btn btn--secondary btn--sm" id="p-cancel">${cur.id ? '새로 쓰기' : '비우기'}</button><button type="submit" class="btn btn--primary btn--sm" id="p-save">${cur.id ? '저장' : '추가'}</button></div>
      </form></section>`;
  };
  const values = (form) => ({
    title: form.title.value.trim(), body: form.body.value.trim(), badge: form.badge.value.trim(), link_url: form.link_url.value.trim(), link_label: form.link_label.value.trim(),
    placements: [...form.querySelectorAll('[name=placements]:checked')].map((x) => x.value), starts_on: form.starts_on.value, ends_on: form.ends_on.value,
    active: form.active.checked, sort_order: Number(form.sort_order.value || 0),
  });
  const preview = () => { const f = $('#pf'); if (!f) return; const v = values(f); $('#p-preview').innerHTML = v.title ? promoHtml([{ ...v, id: 'preview' }], { placement: 'preview', until: '2027.10.15' }) : '<p class="dim">제목을 입력하면 미리 보입니다.</p>'; };

  const draw = () => {
    main.innerHTML = html`<div class="apage">
      ${raw(head('프로모션', '<button class="btn btn--primary btn--sm" id="p-new">새 프로모션</button>'))}
      <p class="hint" style="margin:-6px 0 12px">회원가입 · 로그인 · 랜딩 요금 · 설정 › AI 크레딧 · 홈에 보이는 혜택 문구입니다. 화면 표시만 바뀌며, 크레딧 지급과 얼리 액세스 기간은 바뀌지 않습니다. 기간은 한국 시간 기준이며 시작일과 종료일을 포함합니다.</p>
      <div class="apromo">
        <div>${raw(table([
          { key: 'state', label: '상태', w: 80, render: (p) => chip(...stateOf(p, data.today)) },
          { key: 'title', label: '제목', cls: 'ttl', render: (p) => html`${raw(p.badge ? html`<small class="dim">[${p.badge}]</small> ` : '')}${p.title}` },
          { key: 'placements', label: '노출 위치', w: 170, render: (p) => html`${p.placements.map((k) => data.placements[k] || k).join(', ')}` },
          { key: 'period', label: '기간', w: 170, render: (p) => (p.starts_on || p.ends_on ? html`${p.starts_on || '…'} ~ ${p.ends_on || '…'}` : '<span class="dim">상시</span>') },
          { key: 'sort_order', label: '순서', w: 56 },
          { key: 'updated_at', label: '수정', w: 120, render: (p) => fmtD(p.updated_at) },
        ], data.promotions, { rowHref: (p) => `#${p.id}`, empty: '프로모션이 없습니다. [새 프로모션]으로 추가하세요.', id: 'promo-tbl' }))}</div>
        ${raw(editor())}
      </div></div>`;
    main.querySelectorAll('#promo-tbl tr[data-href]').forEach((tr) => {
      const open = () => { const p = data.promotions.find((x) => `#${x.id}` === tr.dataset.href); if (p) { cur = { ...EMPTY, ...p, starts_on: p.starts_on || '', ends_on: p.ends_on || '' }; draw(); $('#p-title').focus(); } };
      tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      tr.classList.toggle('is-sel', cur.id && tr.dataset.href === `#${cur.id}`);
    });
    $('#p-new').onclick = () => { cur = { ...EMPTY }; draw(); $('#p-title').focus(); };
    $('#p-cancel').onclick = () => { cur = { ...EMPTY }; draw(); };
    const form = $('#pf'); form.addEventListener('input', preview); form.addEventListener('change', preview); preview();
    const del = $('#p-del'); if (del) del.onclick = async () => {
      if (!(await confirmDialog({ title: `'${cur.title}' 프로모션을 삭제할까요?`, body: '모든 노출 위치에서 바로 사라집니다. 잠시 숨기려면 삭제 대신 노출을 끄세요.', confirm: '삭제', danger: true }))) return;
      try { await api('DELETE', `/api/admin/promotions/${cur.id}`); toast('프로모션을 삭제했습니다.'); cur = { ...EMPTY }; await load(); draw(); } catch (e) { toast(e.message); }
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showErrors(form, {});
      const v = values(form); const local = {};
      if (!v.title) local.title = '제목을 입력해 주세요.';
      if (!v.placements.length) local.placements = '노출 위치를 하나 이상 고르세요.';
      if (Object.keys(local).length) return showErrors(form, local);
      const btn = $('#p-save'); btn.disabled = true;
      try {
        const r = cur.id ? await api('PATCH', `/api/admin/promotions/${cur.id}`, v) : await api('POST', '/api/admin/promotions', v);
        toast(cur.id ? '저장했습니다.' : '프로모션을 추가했습니다.');
        await load(); cur = { ...EMPTY, ...r.promotion, starts_on: r.promotion.starts_on || '', ends_on: r.promotion.ends_on || '' }; draw();
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    });
  };
  draw();
}
