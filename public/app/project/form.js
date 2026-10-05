import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { ob } from '../onboarding/state.js';
import { showErrors, toast, confirmDialog } from '../shared/dialogs.js';

export async function projectFormPage(id) {
  const main = $('#main');
  const editing = Boolean(id);
  let p = { name: '', client_name: '', project_scale: '', planned_start_date: '', planned_end_date: '', description: '' };
  if (editing) {
    p = (await api('GET', wsApi(`/${id}`))).project;
    if (p.status === 'ARCHIVED') { navigate(`/app/projects/${id}`, { replace: true }); return; }
  }
  document.title = `${editing ? '프로젝트 정보 수정' : '새 프로젝트'} — RELAI`;
  main.innerHTML = html`<div class="page page--form">
    <a class="crumb" href="${editing ? `/app/projects/${id}` : '/app/projects'}" data-link>← ${editing ? p.name : 'Projects'}</a>
    <div class="page__head"><div><h1>${editing ? '프로젝트 정보 수정' : '새 프로젝트 시작하기'}</h1>
      ${raw(editing ? '' : '<p>기본 정보만 입력하면 됩니다. 목표·범위·이해관계자는 생성 후 01 착수 단계에서 차례로 정리합니다.</p>')}</div></div>
    <form class="panel form-panel pform" id="f" novalidate>
      <div class="form-err full" role="alert" hidden></div>
      <div class="field full"><label for="name">프로젝트 이름 <span class="req">*</span></label>
        <input class="input" id="name" name="name" maxlength="100" placeholder="예: A사 AI 상담 시스템 구축" value="${p.name}"><div class="err" data-for="name"></div></div>
      <div class="field"><label for="client">고객사명 <span class="req">*</span></label>
        <input class="input" id="client" name="client_name" maxlength="100" placeholder="예: A사" value="${p.client_name}"><div class="err" data-for="client_name"></div></div>
      <div class="field"><label for="scale">프로젝트 규모 / 금액 <span style="color:var(--muted);font-weight:500">(선택)</span></label>
        <input class="input" id="scale" name="project_scale" maxlength="200" placeholder="예: 3억 원 · 6개월 · 투입 8명" value="${p.project_scale}"><div class="err" data-for="project_scale"></div></div>
      <div class="pdates full"><div class="row2">
        <div class="field"><label for="s">예상 시작일 <span class="req">*</span></label>
          <input class="input" type="date" id="s" name="planned_start_date" value="${p.planned_start_date}"><div class="err" data-for="planned_start_date"></div></div>
        <div class="field"><label for="e">예상 종료일 <span class="req">*</span></label>
          <input class="input" type="date" id="e" name="planned_end_date" value="${p.planned_end_date}"><div class="err" data-for="planned_end_date"></div></div>
      </div></div>
      <div class="field full"><label for="d">프로젝트 설명 <span style="color:var(--muted);font-weight:500">(선택)</span></label>
        <textarea class="textarea" id="d" name="description" maxlength="2000" placeholder="프로젝트의 목적이나 배경을 간단히 적어주세요.">${p.description}</textarea>
        <div class="err" data-for="description"></div></div>
      <div class="actions actions--end full" style="margin-top:4px">
        <a class="btn btn--secondary" href="${editing ? `/app/projects/${id}` : '/app/projects'}" data-link>취소</a>
        <button class="btn btn--primary" type="submit">${editing ? '저장하기' : '프로젝트 시작하기 →'}</button></div>
    </form></div>`;
  const form = $('#f');
  if (!editing) $('#name').focus();
  if (editing) { /* description is a textarea: set via value to avoid whitespace artefacts */ $('#d').value = p.description; }
  // Deep link from Project Chater (…/edit?focus=description): land on the field that is missing.
  const focus = editing && form.elements[new URLSearchParams(location.search).get('focus') || ''];
  if (focus && focus.focus) { focus.scrollIntoView({ block: 'center' }); focus.focus({ preventScroll: true }); }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const local = {};
    if (!d.name?.trim()) local.name = '프로젝트 이름을 입력해 주세요.';
    if (!d.client_name?.trim()) local.client_name = '고객사명을 입력해 주세요.';
    if (!d.planned_start_date) local.planned_start_date = '예상 시작일을 입력해 주세요.';
    if (!d.planned_end_date) local.planned_end_date = '예상 종료일을 입력해 주세요.';
    if (d.planned_start_date && d.planned_end_date && d.planned_end_date < d.planned_start_date) local.planned_end_date = '종료일은 시작일 이후여야 합니다.';
    showErrors(form, local);
    if (Object.keys(local).length) return;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const send = (body) => (editing ? api('PATCH', wsApi(`/${id}`), body) : api('POST', wsApi(), body));
      let r;
      try { r = await send(d); }
      catch (err) {   // BUG-002: same-named project exists — let the user decide instead of creating a silent duplicate
        if (err.code !== 'duplicate_name') throw err;
        const go = await confirmDialog({ title: '같은 이름의 프로젝트가 이미 있습니다', body: `'${d.name.trim()}' 프로젝트가 이 Workspace에 이미 있습니다. 그래도 ${editing ? '저장' : '생성'}할까요? 목록에서 구분하려면 이름을 바꾸는 것이 좋습니다.`, confirm: editing ? '그대로 저장' : '그래도 생성' });
        if (!go) { btn.disabled = false; showErrors(form, { name: '같은 이름의 프로젝트가 이미 있습니다.' }); return; }
        r = await send({ ...d, allow_duplicate: true });
      }
      const { project } = r;
      if (editing) toast('저장했습니다.');
      else ob.invalidate();   // first project changes onboarding state (checklist, tour routes)
      navigate(editing ? `/app/projects/${project.id}` : `/app/projects/${project.id}?created=1`);
    } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
  });
}
