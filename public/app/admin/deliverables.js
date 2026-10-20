/* 관리자 › 산출물 목록 (batch7 #3, migration 49): the standard deliverable catalog every project picks from (01 착수 › 범위).
 * List on the left, editor on the right (same layout as 프로모션). A new item shows in every project at once (default level by tier;
 * in a project whose 범위 is already complete it shows as 새 항목 · 선택). Items are never deleted — 끄기 hides them from new choices. */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { showErrors, toast } from '../shared/dialogs.js';
import { chip, errorBlock, fmtD, head, n, table } from './ui.js';

const EMPTY = { id: null, name: '', phase_key: 'INITIATION', tier: 'BASIC', default_level: 'REQUIRED', description: '', sort: '', active: true };

export async function adminDeliverablesPage(main = $('#main')) {
  document.title = '산출물 목록 — RELAI 관리자';
  let data; let cur = { ...EMPTY };
  const load = async () => { data = await api('GET', '/api/admin/deliverables'); };
  try { await load(); } catch (e) { main.innerHTML = errorBlock(e); return; }
  const phaseName = (k) => (data.phases.find((p) => p.key === k) || { name: k }).name;
  const opts = (list, v) => list.map(([k, l]) => html`<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');

  const editor = () => html`<section class="asec apromo__ed" id="dl-editor"><div class="asec__h">${cur.id ? '산출물 수정' : '새 산출물'}</div>
    <form id="df" class="apromo__f" novalidate>
      <div class="form-err" id="ferr" role="alert" hidden></div>
      <div class="field"><label for="d-name">이름 <span class="req">*</span></label><input class="input" id="d-name" name="name" maxlength="100" value="${cur.name}" placeholder="예: 개인정보 영향평가서"><div class="err" data-for="name"></div></div>
      <div class="apromo__row">
        <div class="field"><label for="d-phase">단계</label><select class="select" id="d-phase" name="phase_key">${raw(opts(data.phases.map((p) => [p.key, p.name]), cur.phase_key))}</select></div>
        <div class="field"><label for="d-tier">구분</label><select class="select" id="d-tier" name="tier">${raw(opts(Object.entries(data.tiers), cur.tier))}</select></div>
      </div>
      <div class="apromo__row">
        <div class="field"><label for="d-level">프로젝트 기본값</label><select class="select" id="d-level" name="default_level">${raw(opts(Object.entries(data.levels), cur.default_level))}</select><div class="hint">프로젝트가 고르지 않았을 때의 값</div></div>
        <div class="field"><label for="d-sort">순서</label><input class="input" id="d-sort" name="sort" type="number" value="${cur.sort}" placeholder="비우면 단계 맨 뒤"><div class="hint">작을수록 앞</div></div>
      </div>
      <div class="field"><label for="d-desc">설명</label><textarea class="input" id="d-desc" name="description" rows="2" maxlength="300" placeholder="무엇을 담는 문서인지 한 줄로">${cur.description || ''}</textarea></div>
      <label class="apromo__on"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> 사용 (끄면 프로젝트 선택 목록에서 숨김)</label>
      <div class="apromo__acts"><span class="apromo__sp"></span>
        <button type="button" class="btn btn--secondary btn--sm" id="d-cancel">${cur.id ? '새로 쓰기' : '비우기'}</button><button type="submit" class="btn btn--primary btn--sm" id="d-save">${cur.id ? '저장' : '추가'}</button></div>
    </form></section>`;
  const values = (f) => ({ name: f.name.value.trim(), phase_key: f.phase_key.value, tier: f.tier.value, default_level: f.default_level.value, description: f.description.value.trim(),
    ...(f.sort.value === '' ? {} : { sort: Number(f.sort.value) }), active: f.active.checked });

  const draw = () => {
    main.innerHTML = html`<div class="apage">
      ${raw(head('산출물 목록', '<button class="btn btn--primary btn--sm" id="d-new">새 산출물</button>'))}
      <p class="hint" style="margin:-6px 0 12px">프로젝트가 01 착수 › 범위에서 고르는 표준 산출물입니다. 여기서 추가한 항목은 모든 프로젝트의 선택 목록에 바로 나타납니다. 베이직은 기본 필수, 심화는 기본 제외입니다.</p>
      <div class="apromo">
        <div>${raw(table([
          { key: 'phase_key', label: '단계', w: 110, render: (x) => phaseName(x.phase_key) },
          { key: 'name', label: '산출물', cls: 'ttl', render: (x) => html`${x.name}${raw(x.active ? '' : ` ${chip('muted', '꺼짐')}`)}` },
          { key: 'tier', label: '구분', w: 70, render: (x) => data.tiers[x.tier] || x.tier },
          { key: 'default_level', label: '기본값', w: 70, render: (x) => data.levels[x.default_level] || x.default_level },
          { key: 'required_in', label: '필수로 쓰는 프로젝트', w: 140, render: (x) => n(x.required_in) },
          { key: 'updated_at', label: '수정', w: 110, render: (x) => fmtD(x.updated_at) },
        ], data.items, { rowHref: (x) => `#${x.id}`, empty: '산출물이 없습니다.', id: 'dl-tbl' }))}</div>
        ${raw(editor())}
      </div></div>`;
    main.querySelectorAll('#dl-tbl tr[data-href]').forEach((tr) => {
      const open = () => { const x = data.items.find((y) => `#${y.id}` === tr.dataset.href); if (x) { cur = { ...EMPTY, ...x }; draw(); $('#d-name').focus(); } };
      tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      tr.classList.toggle('is-sel', Boolean(cur.id) && tr.dataset.href === `#${cur.id}`);
    });
    $('#d-new').onclick = () => { cur = { ...EMPTY }; draw(); $('#d-name').focus(); };
    $('#d-cancel').onclick = () => { cur = { ...EMPTY }; draw(); };
    const form = $('#df');
    // 구분 → 기본값 follows the tier until the operator picks one (베이직 필수 / 심화 제외)
    form.tier.onchange = () => { if (!cur.id) form.default_level.value = form.tier.value === 'ADVANCED' ? 'EXCLUDED' : 'REQUIRED'; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showErrors(form, {});
      const v = values(form);
      if (!v.name) return showErrors(form, { name: '산출물 이름을 입력해 주세요.' });
      const btn = $('#d-save'); btn.disabled = true;
      try {
        const r = cur.id ? await api('PATCH', `/api/admin/deliverables/${cur.id}`, v) : await api('POST', '/api/admin/deliverables', v);
        toast(cur.id ? '저장했습니다.' : '산출물을 추가했습니다. 모든 프로젝트의 선택 목록에 나타납니다.');
        await load(); cur = { ...EMPTY, ...r.item }; draw();
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    });
  };
  draw();
}
