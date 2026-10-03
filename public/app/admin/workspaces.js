/* Workspaces: operator list + detail (owner, members, plan/subscription, usage vs limits, activity) with suspend / reactivate. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { api } from '../core/api.js';
import { promptDialog, toast } from '../shared/dialogs.js';
import { ACTIONS, AI_FEATURE, adminApi, aiFeatureTable, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, fmtDay, head, kpis, n, pager, qs, rel, sel, section, table, usageBars, usd } from './ui.js';

const STATUS = { ACTIVE: '정상', SUSPENDED: '정지', CLOSED: '종료' };
const ACT = { PROJECT_CREATED: '프로젝트 생성', PROJECT_ARCHIVED: '프로젝트 보관', MEMBER_JOINED: '멤버 합류', WEEKLY_REPORT: '주간보고 생성' };

export async function adminWorkspacesPage(main = $('#main')) {
  document.title = 'Workspaces — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let data; try { data = await adminApi('workspaces', { q: q.q, status: q.status, page: q.page, size: q.size, sort: q.sort }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('Workspaces', '<span class="hint">회사·팀 단위 사용 현황과 운영 상태</span>'))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="Workspace명 · Owner 이메일 검색" value="${q.q || ''}">
        ${raw(sel('status', '상태', STATUS, q.status))}${raw(sel('sort', '정렬: 생성일', { activity: '정렬: 최근 활동', name: '정렬: 이름', members: '정렬: 멤버 수', projects: '정렬: 프로젝트 수' }, q.sort))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'name', label: 'Workspace', w: 240, cls: 'ttl' },
        { key: 'owner', label: 'Owner', w: 220, render: (w) => (w.owner_email ? html`${w.owner_name} <small class="dim mono">${w.owner_email}</small>` : '<span class="dim">없음</span>') },
        { key: 'activation', label: 'Activation', w: 130, render: (w) => (w.activation ? chip(w.activation.tone, w.activation.label) : '-') },
        { key: 'plan_label', label: 'Plan', w: 70 }, { key: 'status', label: 'Status', w: 80, render: (w) => chip(w.status) },
        { key: 'member_count', label: 'Members', w: 90, cls: 'num', render: (w) => n(w.member_count) }, { key: 'pending_invitations', label: 'Pending Invites', w: 110, cls: 'num', render: (w) => (Number(w.pending_invitations) ? html`<b>${n(w.pending_invitations)}</b>` : '<span class="dim">0</span>') }, { key: 'project_count', label: 'Projects', w: 90, cls: 'num', render: (w) => n(w.project_count) },
        { key: 'created_at', label: 'Created', w: 110, render: (w) => fmtDay(w.created_at) }, { key: 'last_activity_at', label: 'Last Active', w: 130, render: (w) => html`<span title="${fmtD(w.last_activity_at)}">${rel(w.last_activity_at)}</span>` },
      ], data.items, { rowHref: (w) => `/admin/workspaces/${w.id}`, empty: '조건에 맞는 Workspace가 없습니다.' }))}
      ${raw(pager(data))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminWorkspacePage(id, main = $('#main')) {
  const draw = async () => {
    const [d, ai] = await Promise.all([adminApi(`workspaces/${id}`), adminApi(`workspaces/${id}/ai`).catch(() => null)]);
    const w = d.workspace; const s = d.subscription;
    document.title = `${w.name} — Workspaces — RELAI Admin`;
    const actions = w.status === 'SUSPENDED' ? '<button class="btn btn--primary btn--sm" id="reactivate">정지 해제</button>' : w.status === 'ACTIVE' ? '<button class="btn btn--danger btn--sm" id="suspend">Workspace 정지</button>' : '';
    main.innerHTML = html`<div class="apage">
      ${raw(head(w.name, actions, { href: '/admin/workspaces', label: 'Workspaces' }))}
      ${raw(w.status === 'SUSPENDED' ? html`<div class="anotice anotice--bad">정지된 Workspace입니다 (${fmtD(w.suspended_at)}). 멤버는 로그인할 수 있지만 이 Workspace의 모든 조회·수정이 차단됩니다. 데이터와 구독은 그대로 유지됩니다.</div>` : '')}
      ${raw(d.warnings.map((x) => html`<div class="anotice anotice--warn">${x}</div>`).join(''))}
      ${raw(kpis([{ label: 'Activation', value: w.activation ? chip(w.activation.tone, w.activation.label) : '-', sub: w.activation ? `정의 완료 ${n(w.defined_projects)} · 업무 시작 ${n(w.activated_projects)} 프로젝트 · 최근 활동 ${rel(w.last_activity_at)}` : '' }, { label: 'Members', value: n(d.members.length) }, { label: 'Active Projects', value: n(d.projects.active), sub: `보관 ${n(d.projects.archived)}` }, { label: 'Plan', value: w.plan_label, sub: s ? `구독 ${s.status}` : 'Billing 미연동' }, { label: '한도 사용', value: d.usage ? (d.usage.max_pct === null ? '-' : `${d.usage.max_pct}%`) : '-', tone: d.usage?.tier === 'attention' ? 'bad' : d.usage?.tier === 'warn' ? 'warn' : '' }]))}
      <div class="agrid2">
        ${raw(section('기본 정보', dl([['Workspace', html`${w.name}`], ['생성일', fmtD(w.created_at)], ['상태', chip(w.status)], ['Owner', w.owner_email ? html`<a class="link" href="/admin/users/${w.owner_id}" data-link>${w.owner_name}</a> <small class="dim mono">${w.owner_email}</small>` : '<span class="dim">없음</span>'],
          ['OWNER 수', n(d.owners.length)], ['현재 Plan', html`${w.plan_label}`], ['Subscription', s ? html`<a class="link" href="/admin/subscriptions/${s.id}" data-link>${s.status}</a> · ${s.current_period_end ? `기간 종료 ${fmtDay(s.current_period_end)}` : ''}` : '<span class="dim">Billing 미연동 — 구독 정보 없음</span>'], ['Workspace ID', html`<span class="mono dim">${w.id}</span>`]])))}
        ${raw(section('Usage (Plan 한도 대비)', usageBars(d.usage) + '<p class="hint">한도는 plans.js의 기준값이며 현재 제품 API에서 강제되지 않습니다. 주간보고는 이번 달 생성 건수입니다.</p>'))}
      </div>
      ${raw(section(`Members (${d.members.length})`, table([
        { key: 'name', label: '이름', w: 150, cls: 'ttl' }, { key: 'email', label: '이메일', w: 240, render: (m) => html`<span class="mono">${m.email}</span>` }, { key: 'role', label: 'Role', w: 90 },
        { key: 'status', label: '계정 상태', w: 90, render: (m) => chip(m.status) }, { key: 'joined_at', label: '가입일', w: 110, render: (m) => fmtDay(m.joined_at) },
      ], d.members, { rowHref: (m) => `/admin/users/${m.id}` })))}
      ${raw(section(`Pending Invitations (${(d.invitations || []).filter((i) => i.status === 'PENDING').length})`, table([
        { key: 'email', label: '이메일', w: 240, render: (i) => html`<span class="mono">${i.email}</span>` }, { key: 'role', label: 'Role', w: 90 }, { key: 'invited_by_name', label: '초대한 사람', w: 160, render: (i) => html`${i.invited_by_name || '-'}` },
        { key: 'status', label: '상태', w: 80, render: (i) => chip(i.status, { PENDING: '대기', ACCEPTED: '수락', REVOKED: '취소', EXPIRED: '만료' }[i.status]) }, { key: 'last_email_status', label: '메일', w: 90, render: (i) => (i.last_email_status ? chip(i.last_email_status === 'SENT' ? 'ok' : i.last_email_status, { SENT: '발송됨', FAILED: '발송 실패', PENDING: '발송 중' }[i.last_email_status]) : '-') },
        { key: 'expires_at', label: '만료', w: 110, render: (i) => fmtDay(i.expires_at) },
      ], (d.invitations || []).filter((i) => i.status !== 'ACCEPTED'), { empty: '대기 중인 멤버 초대가 없습니다.' }) + (d.origin_invitation ? html`<p class="hint">이 Workspace는 고객 초대(${d.origin_invitation.email}, ${fmtDay(d.origin_invitation.accepted_at)} 수락)로 생성되었습니다.</p>` : '<p class="hint">멤버 초대는 Workspace OWNER/ADMIN이 Settings › 멤버에서 관리합니다. 운영자는 조회만 할 수 있습니다.</p>')))}
      ${raw(ai ? section('AI Credit · 사용량 (최근 30일)', html`${raw(kpis([
          { label: '현재 Credit', value: n(ai.account.balance), sub: `누적 지급 ${n(ai.account.lifetime_granted)} · 누적 사용 ${n(ai.account.lifetime_used)}` },
          { label: '30일 AI 요청', value: n(ai.kpis.runs_30d), sub: `성공률 ${ai.kpis.success_rate_30d === null ? '-' : ai.kpis.success_rate_30d + '%'}` },
          { label: 'Input / Output Tokens', value: `${n(ai.kpis.input_tokens_30d)} / ${n(ai.kpis.output_tokens_30d)}` },
          { label: 'Provider Cost (추정)', value: usd(ai.kpis.provider_cost_30d), sub: `Credit 사용 ${n(ai.kpis.credits_30d)}` }]))}
        ${raw(aiFeatureTable(ai.features))}
        <div class="agrid2" style="margin-top:12px">
          <div><div class="asec__h">최근 AI 요청</div>${raw(table([{ key: 'created_at', label: '일시', w: 130, render: (r) => fmtD(r.created_at) }, { key: 'feature', label: '기능', w: 120, render: (r) => AI_FEATURE[r.feature] || r.feature }, { key: 'user_name', label: '사용자', w: 90 }, { key: 'status', label: '상태', w: 90, render: (r) => chip(r.status === 'SUCCEEDED' ? (r.error_code ? 'ON_HOLD' : 'ACTIVE') : r.status === 'FAILED' ? 'SUSPENDED' : 'DRAFT', r.status === 'SUCCEEDED' ? (r.error_code ? '성공 · 정산 충돌' : '성공') : r.status === 'FAILED' ? `실패 ${r.error_code || ''}` : '진행 중') }, { key: 'credit_cost', label: 'Credit', w: 70, render: (r) => (r.credit_status === 'CHARGED' ? n(r.credit_cost) : html`<span class="dim">0</span>`) }, { key: 'tokens', label: '토큰', w: 110, render: (r) => `${n(r.input_tokens)} / ${n(r.output_tokens)}` }], ai.runs, { empty: 'AI 요청 기록이 없습니다.', id: 'airuns' }))}</div>
          <div><div class="asec__h">Credit Ledger</div>${raw(table([{ key: 'created_at', label: '일시', w: 130, render: (r) => fmtD(r.created_at) }, { key: 'type', label: '유형', w: 110 }, { key: 'amount', label: '증감', w: 70, render: (r) => html`<b style="color:${r.amount < 0 ? '#B42318' : '#067647'}">${r.amount > 0 ? '+' : ''}${n(r.amount)}</b>` }, { key: 'balance_after', label: '잔액', w: 80, render: (r) => n(r.balance_after) }, { key: 'reason', label: '사유', render: (r) => html`${r.feature ? AI_FEATURE[r.feature] || r.feature : r.reason}${r.created_by_name ? html` <small class="dim">· ${r.created_by_name}</small>` : ''}` }], ai.ledger, { empty: '원장 기록이 없습니다.', id: 'ailed' }))}</div>
        </div>
        <p class="hint">Credit은 Ledger를 통해서만 증감합니다. 가격·Plan별 지급량·Top-up은 아직 정하지 않았으며, 지급은 운영자 사유와 함께 Audit에 기록됩니다.</p>`,
        w.status === 'CLOSED' ? '' : '<button class="btn btn--secondary btn--sm" id="ai-grant">Credit 지급 / 조정</button>') : '')}
      <div class="agrid2">
        ${raw(section('최근 Activity', d.activity.length ? html`<ul class="aact">${raw(d.activity.map((x) => html`<li><time>${fmtD(x.at)}</time><span>${ACT[x.type] || x.type}</span></li>`).join(''))}</ul>` : '<div class="aempty">활동 기록이 없습니다.</div>'))}
        ${raw(section('운영자 조작', table([{ key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) }, { key: 'admin_name', label: 'Admin', w: 150 }, { key: 'summary', label: 'Summary', render: (r) => html`${ACTIONS[r.action] || r.action}${r.metadata?.reason ? ` — ${r.metadata.reason}` : ''}` }], d.audit, { empty: '기록 없음' })))}
      </div>
    </div>`;
    bindRows(main, navigate);
    const run = async (path, title, body, confirm, danger) => {
      const reason = await promptDialog({ title, body, label: '사유 (선택, Audit에 기록)', confirm, danger });
      if (reason === null) return;
      try { await api('POST', `/api/admin/workspaces/${id}/${path}`, { reason }); toast(`${confirm} 처리했습니다.`); await draw(); } catch (e) { toast(e.message); }
    };
    const sb = $('#suspend'); if (sb) sb.onclick = () => run('suspend', `'${w.name}' Workspace를 정지할까요?`, '멤버의 로그인은 유지되지만 이 Workspace의 모든 API 호출(조회 포함)이 차단됩니다. 데이터는 삭제되지 않고 구독도 해지되지 않습니다.', '정지', true);
    const gb = $('#ai-grant'); if (gb) gb.onclick = async () => {
      const r = await creditDialog(w.name, ai ? ai.account.balance : 0);
      if (!r) return;
      try { const out = await api('POST', `/api/admin/workspaces/${id}/ai/credits`, r); toast(`Credit을 반영했습니다. 현재 잔액 ${out.balance.toLocaleString('ko-KR')}`); await draw(); } catch (e) { toast(e.message); }
    };
    const rb = $('#reactivate'); if (rb) rb.onclick = () => run('reactivate', `'${w.name}' Workspace 정지를 해제할까요?`, '멤버가 다시 접근할 수 있게 됩니다.', '정지 해제', false);
  };
  await draw();
}

/** Grant / adjust dialog: signed integer amount + required reason (recorded in the ledger and the admin audit). */
function creditDialog(name, balance) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cdT"><h3 id="cdT">AI Credit 지급 / 조정</h3>
      <div class="dialog__b">'${name}' Workspace · 현재 ${balance.toLocaleString('ko-KR')} Credits. 양수는 지급, 음수는 조정(잔액 이내)입니다. Ledger와 Audit에 기록됩니다.</div>
      <div class="field"><label for="cd-amt">수량 <span class="req">*</span></label><input class="input" id="cd-amt" type="number" step="1" placeholder="예: 500 또는 -100"><div class="err" id="cd-err"></div></div>
      <div class="field"><label for="cd-reason">사유 <span class="req">*</span></label><textarea class="textarea" id="cd-reason" maxlength="500" placeholder="예: 파일럿 고객 지원" style="min-height:72px"></textarea></div>
      <div class="actions"><button class="btn btn--secondary" data-v="0">취소</button><button class="btn btn--primary" data-v="1">반영</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === '0') return done(null);
      const amount = Number($('#cd-amt', el).value); const reason = $('#cd-reason', el).value.trim();
      if (!Number.isInteger(amount) || amount === 0) { $('#cd-err', el).textContent = '0이 아닌 정수를 입력해 주세요.'; return; }
      if (!reason) { $('#cd-err', el).textContent = '사유를 입력해 주세요.'; return; }
      done({ amount, reason }); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.append(el); $('#cd-amt', el).focus();
  });
}
