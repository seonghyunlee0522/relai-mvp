/* 관리자 › 공지사항 (migration 74). 제목 · 내용 → the in-app list (/app/notices); 이미지 → the modal on the landing page and app Home.
 * List on the left, editor on the right (image upload with preview, 기간, 팝업 위치, 순서, 게시). '팝업 미리보기' opens the real modal.
 * Images over 2 MB or wider than 2,000 px are scaled down in the browser (JPEG) before upload; GIF is sent as is. */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { confirmDialog, showErrors, toast } from '../shared/dialogs.js';
import { openNoticePopup } from '../shared/notice-popup.js';
import { chip, errorBlock, fmtD, head, table } from './ui.js';

const EMPTY = { id: null, title: '', body: '', starts_at: null, ends_at: null, popup_placements: ['landing', 'app_home'], active: true, sort_order: 0, image_url: null };
const MAX = 2 * 1024 * 1024; const MAX_W = 2000; const FIT_W = 1600;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** ISO ↔ <input type=datetime-local> in Korea time. */
const toInput = (iso) => {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const fromInput = (v) => (v ? `${v}:00+09:00` : '');
const kst = (iso) => toInput(iso).replace('T', ' ').replaceAll('-', '.');
const stateOf = (n) => {
  const now = Date.now();
  if (!n.active) return ['muted', '비활성'];
  if (n.starts_at && new Date(n.starts_at).getTime() > now) return ['warn', '예정'];
  if (n.ends_at && new Date(n.ends_at).getTime() <= now) return ['muted', '종료'];
  return ['ok', '게시 중'];
};

const readAsDataUrl = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
/** File → { data (base64), type, url (preview), size }. Big or very wide stills are redrawn at ≤ 1,600 px as JPEG. */
async function prepareImage(file) {
  if (!TYPES.includes(file.type)) throw new Error('PNG · JPG · WebP · GIF 이미지만 올릴 수 있습니다.');
  let blob = file;
  if (file.type !== 'image/gif') {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('이미지를 읽지 못했습니다.')); i.src = url; });
      if (file.size > MAX || img.naturalWidth > MAX_W) {
        const w = Math.min(FIT_W, img.naturalWidth); const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
      }
    } finally { URL.revokeObjectURL(url); }
  }
  if (blob.size > MAX) throw new Error('이미지는 2MB 이하만 올릴 수 있습니다.');
  const dataUrl = await readAsDataUrl(blob);
  return { data: dataUrl.split(',')[1], type: blob.type, url: dataUrl, size: blob.size };
}

export async function adminNoticesPage(main = $('#main')) {
  document.title = '공지사항 — RELAI 관리자';
  let data; let cur = { ...EMPTY }; let pending = null; let dropImage = false;
  const load = async () => { data = await api('GET', '/api/admin/notices'); };
  try { await load(); } catch (e) { main.innerHTML = errorBlock(e); return; }
  const P = () => data.placements;
  const shownImage = () => (pending ? pending.url : dropImage ? null : cur.image_url);

  const imageField = () => {
    const src = shownImage();
    return html`<div class="field ant__img"><label for="n-file">팝업 이미지</label>
      ${raw(src ? html`<div class="ant__pv"><img src="${src}" alt="팝업 이미지 미리보기"></div>` : '<div class="ant__none">이미지가 없으면 팝업에 뜨지 않고 목록에만 보입니다.</div>')}
      <div class="ant__ib"><label class="btn btn--secondary btn--sm" for="n-file">${src ? '이미지 바꾸기' : '이미지 올리기'}</label>
        <input type="file" id="n-file" accept="${TYPES.join(',')}" hidden>
        ${raw(src ? '<button type="button" class="btn btn--ghost btn--sm" id="n-img-del">이미지 빼기</button>' : '')}</div>
      <div class="hint">PNG · JPG · WebP · GIF, 2MB 이하. 가로형(예: 1200×675) 권장 — 팝업 너비 최대 560px로 보입니다. 2MB가 넘거나 너비 2,000px가 넘는 이미지는 자동으로 줄입니다.</div>
      <div class="err" data-for="image"></div></div>`;
  };

  const editor = () => html`<section class="asec apromo__ed" id="notice-editor"><div class="asec__h">${cur.id ? '공지 수정' : '새 공지'}</div>
    <form id="nf" class="apromo__f" novalidate>
      <div class="form-err" id="ferr" role="alert" hidden></div>
      <div class="field"><label for="n-title">제목 <span class="req">*</span></label><input class="input" id="n-title" name="title" maxlength="120" value="${cur.title}" placeholder="예: RELAI 베타 서비스를 오픈합니다"><div class="err" data-for="title"></div></div>
      <div class="field"><label for="n-body">내용</label><textarea class="input ant__body" id="n-body" name="body" rows="9" maxlength="5000" placeholder="공지사항 목록에서 보이는 본문입니다. 줄바꿈이 그대로 보입니다.">${cur.body}</textarea><div class="err" data-for="body"></div></div>
      ${raw(imageField())}
      <div class="apromo__row ant__period">
        <div class="field"><label for="n-from">게시 시작</label><input class="input" id="n-from" name="starts_at" type="datetime-local" value="${toInput(cur.starts_at)}"><div class="err" data-for="starts_at"></div></div>
        <div class="field"><label for="n-to">게시 종료</label><input class="input" id="n-to" name="ends_at" type="datetime-local" value="${toInput(cur.ends_at)}"><div class="err" data-for="ends_at"></div></div>
      </div>
      <div class="field"><div class="hint">한국 시간 기준. 비워 두면 시작은 바로, 종료는 없음(직접 끌 때까지)입니다. 목록과 팝업 모두 이 기간에만 보입니다.</div></div>
      <fieldset class="field apromo__pl"><legend>팝업 위치</legend>
        ${raw(Object.entries(P()).map(([k, l]) => html`<label><input type="checkbox" name="popup_placements" value="${k}" ${cur.popup_placements.includes(k) ? 'checked' : ''}> ${l}</label>`).join(''))}
        <div class="hint">둘 다 끄면 팝업 없이 목록에만 게시됩니다. 여러 공지가 겹치면 한 팝업에서 넘겨 봅니다.</div><div class="err" data-for="popup_placements"></div></fieldset>
      <div class="apromo__row">
        <div class="field"><label for="n-sort">팝업 순서</label><input class="input" id="n-sort" name="sort_order" type="number" value="${cur.sort_order}"><div class="hint">작을수록 먼저</div></div>
        <div></div>
      </div>
      <label class="apromo__on"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> 게시 (끄면 기간과 관계없이 목록·팝업에서 숨김)</label>
      <div class="apromo__acts">${raw(cur.id ? '<button type="button" class="btn btn--ghost btn--sm is-danger" id="n-del">삭제</button>' : '')}<span class="apromo__sp"></span>
        <button type="button" class="btn btn--ghost btn--sm" id="n-pv" ${shownImage() ? '' : 'disabled'}>팝업 미리보기</button>
        <button type="button" class="btn btn--secondary btn--sm" id="n-cancel">${cur.id ? '새로 쓰기' : '비우기'}</button><button type="submit" class="btn btn--primary btn--sm" id="n-save">${cur.id ? '저장' : '등록'}</button></div>
    </form></section>`;

  const values = (f) => ({
    title: f.title.value.trim(), body: f.body.value, starts_at: fromInput(f.starts_at.value), ends_at: fromInput(f.ends_at.value),
    popup_placements: [...f.querySelectorAll('[name=popup_placements]:checked')].map((x) => x.value), active: f.active.checked, sort_order: Number(f.sort_order.value || 0),
  });
  /** Keeps what was typed when the editor re-renders (image chosen / removed). */
  const keepTyped = () => { const f = $('#nf'); if (!f) return; const v = values(f); cur = { ...cur, ...v, starts_at: v.starts_at || null, ends_at: v.ends_at || null }; };
  const select = (n) => { cur = n ? { ...EMPTY, ...n } : { ...EMPTY }; pending = null; dropImage = false; draw(); $('#n-title').focus(); };

  const draw = () => {
    main.innerHTML = html`<div class="apage">
      ${raw(head('공지사항', '<button class="btn btn--secondary btn--sm" id="n-live">앱 홈 팝업 보기</button><button class="btn btn--primary btn--sm" id="n-new">새 공지</button>'))}
      <p class="hint" style="margin:-6px 0 12px">제목과 내용은 앱 왼쪽 메뉴 <b>공지사항</b> 목록에 보이고, 이미지는 홈페이지·앱 홈에 접속할 때 팝업으로만 뜹니다. 사용자에게는 게시 중인 공지만 보입니다. 사용자는 팝업에서 <b>오늘 하루 보지 않기</b>를 고를 수 있습니다.</p>
      <div class="apromo">
        <div>${raw(table([
          { key: 'state', label: '상태', w: 76, render: (n) => chip(...stateOf(n)) },
          { key: 'img', label: '이미지', w: 84, render: (n) => (n.image_url ? html`<img class="ant__th" src="${n.image_url}" alt="" loading="lazy">` : '<span class="dim">없음</span>') },
          { key: 'title', label: '제목', cls: 'ttl', render: (n) => html`${n.title}` },
          { key: 'popup', label: '팝업', w: 130, render: (n) => (n.image_url && n.popup_placements.length ? html`${n.popup_placements.map((k) => P()[k] || k).join(', ')}` : '<span class="dim">목록만</span>') },
          { key: 'period', label: '기간', w: 190, render: (n) => (n.starts_at || n.ends_at ? html`${n.starts_at ? kst(n.starts_at) : '바로'} ~<br>${n.ends_at ? kst(n.ends_at) : '종료 없음'}` : '<span class="dim">상시</span>') },
          { key: 'sort_order', label: '순서', w: 52 },
          { key: 'updated_at', label: '수정', w: 120, render: (n) => fmtD(n.updated_at) },
        ], data.notices, { rowHref: (n) => `#${n.id}`, empty: '공지사항이 없습니다. [새 공지]로 등록하세요.', id: 'notice-tbl' }))}</div>
        ${raw(editor())}
      </div></div>`;

    main.querySelectorAll('#notice-tbl tr[data-href]').forEach((tr) => {
      const open = () => select(data.notices.find((x) => `#${x.id}` === tr.dataset.href));
      tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      tr.classList.toggle('is-sel', Boolean(cur.id) && tr.dataset.href === `#${cur.id}`);
    });
    $('#n-new').onclick = () => select(null);
    $('#n-cancel').onclick = () => select(null);
    $('#n-live').onclick = async () => {
      try {
        const r = await api('GET', '/api/notices/popup?placement=app_home');
        if (!r.notices.length) return toast('지금 앱 홈에 뜨는 팝업이 없습니다.');
        openNoticePopup(r.notices, { respectHidden: false });
      } catch (e) { toast(e.message); }
    };
    $('#n-pv').onclick = () => { const f = $('#nf'); openNoticePopup([{ id: 'preview', title: f.title.value.trim() || '미리보기', image_url: shownImage() }], { respectHidden: false }); };
    $('#n-file').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      keepTyped();
      try { pending = await prepareImage(file); dropImage = false; draw(); }
      catch (err) { showErrors($('#nf'), { image: err.message }); }
    };
    const idel = $('#n-img-del'); if (idel) idel.onclick = () => { keepTyped(); pending = null; dropImage = Boolean(cur.image_url); draw(); };

    const del = $('#n-del'); if (del) del.onclick = async () => {
      if (!(await confirmDialog({ title: `'${cur.title}' 공지를 삭제할까요?`, body: '목록과 팝업에서 바로 사라집니다. 잠시 숨기려면 삭제 대신 게시를 끄세요.', confirm: '삭제', danger: true }))) return;
      try { await api('DELETE', `/api/admin/notices/${cur.id}`); toast('공지를 삭제했습니다.'); await load(); select(null); } catch (err) { toast(err.message); }
    };

    const form = $('#nf');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showErrors(form, {});
      const v = values(form);
      if (!v.title) return showErrors(form, { title: '제목을 입력해 주세요.' });
      if (v.starts_at && v.ends_at && v.starts_at >= v.ends_at) return showErrors(form, { ends_at: '종료 시각은 시작 시각 이후여야 합니다.' });
      const btn = $('#n-save'); btn.disabled = true;
      try {
        let r = cur.id ? await api('PATCH', `/api/admin/notices/${cur.id}`, v) : await api('POST', '/api/admin/notices', v);
        const id = r.notice.id; const created = !cur.id;
        cur = { ...cur, id };   // a failed image upload below keeps editing this row, not a new one
        if (pending) r = await api('PUT', `/api/admin/notices/${id}/image`, { data: pending.data, type: pending.type });
        else if (dropImage) r = await api('DELETE', `/api/admin/notices/${id}/image`);
        toast(created ? '공지를 등록했습니다.' : '저장했습니다.');
        await load(); select(data.notices.find((x) => x.id === id) || r.notice);
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); if (cur.id) { try { await load(); } catch { /* keep */ } } }
    });
  };
  draw();
}
