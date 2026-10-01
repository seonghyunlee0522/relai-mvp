import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { SITUATION, TYPE } from '../shared/constants.js';
import { showErrors, toast } from '../shared/dialogs.js';

export async function projectFormPage(id) {
  const main = $('#main');
  const editing = Boolean(id);
  let p = { name: '', project_type: '', current_situation: '', planned_start_date: '', planned_end_date: '', description: '' };
  if (editing) {
    p = (await api('GET', wsApi(`/${id}`))).project;
    if (p.status === 'ARCHIVED') { navigate(`/app/projects/${id}`, { replace: true }); return; }
  }
  document.title = `${editing ? '프로젝트 정보 수정' : '새 프로젝트'} — RELAI`;
  const radios = (name, map, cur) => Object.entries(map).map(([v, l]) =>
    html`<label class="choice"><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}><span>${l}</span></label>`).join('');
  main.innerHTML = html`<div class="page page--narrow">
    <a class="crumb" href="${editing ? `/app/projects/${id}` : '/app/projects'}" data-link>← ${editing ? p.name : 'Projects'}</a>
    <div class="page__head"><div><h1>${editing ? '프로젝트 정보 수정' : '새 프로젝트 시작하기'}</h1>
      ${raw(editing ? '' : '<p>몇 가지만 알려주시면 RELAI가 지금 상황에 맞게 안내합니다.</p>')}</div></div>
    <form class="panel form-panel" id="f" novalidate>
      <div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="name">프로젝트 이름 <span class="req">*</span></label>
        <input class="input" id="name" name="name" maxlength="100" placeholder="예: A사 AI 상담 시스템 구축" value="${p.name}"><div class="err" data-for="name"></div></div>
      <div class="field"><span class="lbl">프로젝트 유형 <span class="req">*</span></span>
        <div class="choices" role="radiogroup">${raw(radios('project_type', TYPE, p.project_type))}</div><div class="err" data-for="project_type"></div></div>
      <div class="field"><span class="lbl">현재 상황 <span class="req">*</span></span>
        <div class="choices" role="radiogroup">${raw(radios('current_situation', SITUATION, p.current_situation))}</div>
        <div class="err" data-for="current_situation"></div></div>
      <div class="row2">
        <div class="field"><label for="s">예상 시작일 <span class="req">*</span></label>
          <input class="input" type="date" id="s" name="planned_start_date" value="${p.planned_start_date}"><div class="err" data-for="planned_start_date"></div></div>
        <div class="field"><label for="e">예상 종료일 <span class="req">*</span></label>
          <input class="input" type="date" id="e" name="planned_end_date" value="${p.planned_end_date}"><div class="err" data-for="planned_end_date"></div></div>
      </div>
      <div class="field"><label for="d">프로젝트 설명 <span style="color:var(--muted);font-weight:500">(선택)</span></label>
        <textarea class="textarea" id="d" name="description" maxlength="2000" placeholder="프로젝트의 목적이나 배경을 간단히 적어주세요.">${p.description}</textarea>
        <div class="err" data-for="description"></div></div>
      <div class="actions" style="margin-top:8px">
        <button class="btn btn--primary btn--lg" type="submit">${editing ? '저장하기' : '프로젝트 시작하기'}</button>
        <a class="btn btn--secondary btn--lg" href="${editing ? `/app/projects/${id}` : '/app/projects'}" data-link>취소</a></div>
    </form></div>`;
  const form = $('#f');
  if (!editing) $('#name').focus();
  if (editing) { /* description is a textarea: set via value to avoid whitespace artefacts */ $('#d').value = p.description; }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const local = {};
    if (!d.name?.trim()) local.name = '프로젝트 이름을 입력해 주세요.';
    if (!d.project_type) local.project_type = '프로젝트 유형을 선택해 주세요.';
    if (!d.current_situation) local.current_situation = '현재 상황을 선택해 주세요.';
    if (!d.planned_start_date) local.planned_start_date = '예상 시작일을 입력해 주세요.';
    if (!d.planned_end_date) local.planned_end_date = '예상 종료일을 입력해 주세요.';
    if (d.planned_start_date && d.planned_end_date && d.planned_end_date < d.planned_start_date) local.planned_end_date = '종료일은 시작일 이후여야 합니다.';
    showErrors(form, local);
    if (Object.keys(local).length) return;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const { project } = editing ? await api('PATCH', wsApi(`/${id}`), d) : await api('POST', wsApi(), d);
      if (editing) toast('저장했습니다.');
      navigate(`/app/projects/${project.id}`);
    } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
  });
}
