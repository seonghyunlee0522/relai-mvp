/* 관리자 › 테스트 계정 정리 (one-off, founder 2026-10-20): shows what would be deleted (dry run), then deletes every user but the
 * logged-in operator and every workspace no kept user belongs to — only after '삭제' is typed. Server: server/purge.js. */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast } from '../shared/dialogs.js';
import { errorBlock, head, n, section } from './ui.js';

const CONFIRM = '삭제';

export async function adminPurgePage(main = $('#main')) {
  document.title = '테스트 계정 정리 — RELAI 관리자';
  let d;
  try { d = await api('GET', '/api/admin/purge-test-accounts'); } catch (e) { main.innerHTML = errorBlock(e); return; }
  const rows = Object.entries(d.labels).map(([k, label]) => html`<tr data-k="${k}"><td>${label}</td><td class="num">${n(d.counts[k])}</td></tr>`).join('');
  const nothing = !d.counts.users && !d.counts.workspaces;
  main.innerHTML = html`<div class="apage" id="purge">
    ${raw(head('테스트 계정 정리'))}
    <p class="hint" style="margin:-6px 0 12px">출시 전에 한 번 쓰는 도구입니다. 지금 로그인한 운영자 계정과 그 계정이 속한 워크스페이스만 남기고, 다른 회원 전부와 남는 회원이 없는 워크스페이스(프로젝트와 모든 데이터 포함)를 한 번에 삭제합니다. 되돌릴 수 없습니다.</p>
    ${raw(section('삭제될 항목 (미리 보기)', html`<div class="atwrap"><table class="atable" id="purge-counts"><thead><tr><th>항목</th><th class="num">건수</th></tr></thead><tbody>${raw(rows)}</tbody></table></div>
      <p class="hint">남는 것: 회원 ${n(d.kept.users)}명(나) · 워크스페이스 ${n(d.kept.workspaces)}개. 남는 워크스페이스에서 삭제되는 회원이 만든 항목은 나에게 넘어옵니다. 안전 한도: 회원 ${n(d.max_users)}명까지.</p>`))}
    ${raw(section('실행', nothing ? '<p class="hint" id="purge-none">삭제할 테스트 계정이 없습니다.</p>' : html`<form id="purge-f" novalidate>
      <div class="field"><label for="purge-confirm">확인을 위해 <b>${CONFIRM}</b>를 입력하세요</label><input class="input" id="purge-confirm" name="confirm" autocomplete="off" placeholder="${CONFIRM}"></div>
      <button type="submit" class="btn btn--danger btn--sm" id="purge-go" disabled>테스트 계정 삭제</button></form>`))}
  </div>`;
  const f = $('#purge-f', main); if (!f) return;
  f.confirm.addEventListener('input', () => { $('#purge-go', main).disabled = f.confirm.value.trim() !== CONFIRM; });
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (f.confirm.value.trim() !== CONFIRM) return;
    $('#purge-go', main).disabled = true;
    try {
      const r = await api('POST', '/api/admin/purge-test-accounts', { confirm: f.confirm.value.trim() });
      toast(`회원 ${n(r.counts.users)}명 · 워크스페이스 ${n(r.counts.workspaces)}개를 삭제했습니다.`);
      adminPurgePage(main);
    } catch (e) { toast(e.message); $('#purge-go', main).disabled = false; }
  });
}
