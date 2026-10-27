/* Workspaces: operator list + detail (owner, members, plan/subscription, usage vs limits, activity) with suspend / reactivate. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { api } from '../core/api.js';
import { promptDialog, toast } from '../shared/dialogs.js';
import { ACTIONS, AI_FEATURE, adminApi, aiFeatureTable, barChart, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, fmtDay, fxNote, head, kpis, money, n, pager, pctTxt, qs, rel, sel, section, table, usageBars, usd } from './ui.js';

const STATUS = { ACTIVE: '정상', SUSPENDED: '정지', CLOSED: '종료' };
const ACT = { PROJECT_CREATED: '프로젝트 생성', PROJECT_ARCHIVED: '프로젝트 보관', MEMBER_JOINED: '멤버 합류', WEEKLY_REPORT: '주간보고 생성' };

export async function adminWorkspacesPage(main = $('#main')) {
  document.title = '워크스페이스 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let data; try { data = await adminApi('workspaces', { q: q.q, status: q.status, page: q.page, size: q.size, sort: q.sort }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('워크스페이스', '<span class="hint">회사·팀 단위 사용 현황과 운영 상태</span>'))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="워크스페이스명 · 소유자 이메일 검색" value="${q.q || ''}">
        ${raw(sel('status', '상태', STATUS, q.status))}${raw(sel('sort', '정렬: 생성일', { activity: '정렬: 최근 활동', name: '정렬: 이름', members: '정렬: 멤버 수', projects: '정렬: 프로젝트 수' }, q.sort))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'name', label: '워크스페이스', w: 240, cls: 'ttl' },
        { key: 'owner', label: '소유자', w: 220, render: (w) => (w.owner_email ? html`${w.owner_name} <small class="dim mono">${w.owner_email}</small>` : '<span class="dim">없음</span>') },
        { key: 'activation', label: '활성화', w: 130, render: (w) => (w.activation ? chip(w.activation.tone, w.activation.label) : '-') },
        { key: 'plan_label', label: '플랜', w: 70 }, { key: 'status', label: '상태', w: 80, render: (w) => chip(w.status) },
        { key: 'member_count', label: '멤버', w: 90, cls: 'num', render: (w) => n(w.member_count) }, { key: 'pending_invitations', label: '대기 중 초대', w: 110, cls: 'num', render: (w) => (Number(w.pending_invitations) ? html`<b>${n(w.pending_invitations)}</b>` : '<span class="dim">0</span>') }, { key: 'project_count', label: '프로젝트', w: 90, cls: 'num', render: (w) => n(w.project_count) },
        { key: 'created_at', label: '생성일', w: 110, render: (w) => fmtDay(w.created_at) }, { key: 'last_activity_at', label: '최근 활동', w: 130, render: (w) => html`<span title="${fmtD(w.last_activity_at)}">${rel(w.last_activity_at)}</span>` },
      ], data.items, { rowHref: (w) => `/admin/workspaces/${w.id}`, empty: '조건에 맞는 워크스페이스가 없습니다.' }))}
      ${raw(pager(data))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

const CYCLE_KO = { MONTHLY: '월간', ANNUAL: '연간' };
/** 요금 · 한도 (pricing v3, read-only): effective plan, cycle, seats used / pending / left, active projects, add-ons, AI allowance. */
function billingV3Section(b) {
  const lim = (v) => (v === null || v === undefined ? '협의' : n(v));
  return section('요금 · 한도 (v3)', dl([
    ['플랜', html`${b.plan_label}${raw(b.cycle ? ` · ${CYCLE_KO[b.cycle] || b.cycle}` : '')}${raw(b.price_version === 'v2' ? ' <span class="achip achip--warn">v2 계약</span>' : '')}`],
    ['상태', b.status ? html`${b.status}${raw(b.auto_renew ? ' · 자동 갱신' : ' · 자동 갱신 꺼짐(해지)')}${raw(b.current_period_end ? ` · ${fmtDay(b.current_period_end)}까지` : '')}` : '<span class="dim">Free</span>'],
    ['MRR (VAT 포함)', b.mrr ? `₩${n(b.mrr)}` : '-'],
    ['활성 프로젝트', `${n(b.usage.projects_active)} / ${lim(b.limits.projects)}`],
    ['사용자 (좌석)', `${n(b.usage.members)} 참여 + ${n(b.usage.pending_invites)} 초대 대기 / ${lim(b.limits.users)} · 남은 좌석 ${b.usage.seats_left === null ? '협의' : n(b.usage.seats_left)}`],
    ['추가 이용', `사용자 ${n(b.addons.extra_users)}명 · 프로젝트 ${n(b.addons.extra_projects)}개`],
    ['AI 이용량', b.ai_usage ? (b.ai_usage.limit_usd === null ? '무제한 (계약)' : `${pctTxt(b.ai_usage.used_pct)} 사용 · $${Number(b.ai_usage.used_usd).toFixed(4)} / $${b.ai_usage.limit_usd} (${b.ai_usage.allowance === 'ONCE' ? '최초 1회' : '월'})${b.ai_usage.resets_at ? ` · ${fmtDay(b.ai_usage.resets_at)} 초기화` : ''}${b.ai_usage.free_eligible === false ? ' · 같은 소유자의 다른 워크스페이스가 Free 이용량 수령' : ''}`) : '-'],
    ['한도 초과', b.over_limit ? html`<span class="achip achip--bad">초과</span> 프로젝트 ${n(b.over_limit.projects)} · 사용자 ${n(b.over_limit.members)}` : '<span class="dim">없음</span>'],
  ]) + '<p class="hint">완료·보관 프로젝트는 활성 프로젝트에 넣지 않습니다. 초대 대기는 좌석을 차지합니다. 데이터는 한도를 넘어도 삭제되지 않습니다.</p>');
}

export async function adminWorkspacePage(id, main = $('#main')) {
  const draw = async () => {
    const [d, ai] = await Promise.all([adminApi(`workspaces/${id}`), adminApi(`workspaces/${id}/ai`).catch(() => null)]);
    const w = d.workspace; const s = d.subscription;
    document.title = `${w.name} — 워크스페이스 — RELAI 관리자`;
    const actions = w.status === 'SUSPENDED' ? '<button class="btn btn--primary btn--sm" id="reactivate">정지 해제</button>' : w.status === 'ACTIVE' ? '<button class="btn btn--danger btn--sm" id="suspend">워크스페이스 정지</button>' : '';
    main.innerHTML = html`<div class="apage">
      ${raw(head(w.name, actions, { href: '/admin/workspaces', label: '워크스페이스' }))}
      ${raw(w.status === 'SUSPENDED' ? html`<div class="anotice anotice--bad">정지된 워크스페이스입니다 (${fmtD(w.suspended_at)}). 멤버는 로그인할 수 있지만 이 워크스페이스의 모든 조회·수정이 차단됩니다. 데이터와 구독은 그대로 유지됩니다.</div>` : '')}
      ${raw(d.warnings.map((x) => html`<div class="anotice anotice--warn">${x}</div>`).join(''))}
      ${raw(kpis([{ label: '활성화', value: w.activation ? chip(w.activation.tone, w.activation.label) : '-', sub: w.activation ? `정의 완료 ${n(w.defined_projects)} · 업무 시작 ${n(w.activated_projects)} 프로젝트 · 최근 활동 ${rel(w.last_activity_at)}` : '' }, { label: '멤버', value: n(d.members.length) }, { label: '진행 중 프로젝트', value: n(d.projects.active), sub: `보관 ${n(d.projects.archived)}` }, { label: '플랜', value: w.plan_label, sub: s ? `구독 ${s.status}` : '결제 미연동' }, { label: '한도 사용', value: d.usage ? (d.usage.max_pct === null ? '-' : `${d.usage.max_pct}%`) : '-', tone: d.usage?.tier === 'attention' ? 'bad' : d.usage?.tier === 'warn' ? 'warn' : '' }]))}
      <div class="agrid2">
        ${raw(section('기본 정보', dl([['워크스페이스', html`${w.name}`], ['생성일', fmtD(w.created_at)], ['상태', chip(w.status)], ['소유자', w.owner_email ? html`<a class="link" href="/admin/users/${w.owner_id}" data-link>${w.owner_name}</a> <small class="dim mono">${w.owner_email}</small>` : '<span class="dim">없음</span>'],
          ['소유자 수', n(d.owners.length)], ['현재 플랜', html`${w.plan_label}`], ['구독', s ? html`<a class="link" href="/admin/subscriptions/${s.id}" data-link>${s.status}</a> · ${s.current_period_end ? `기간 종료 ${fmtDay(s.current_period_end)}` : ''}` : '<span class="dim">결제 미연동 — 구독 정보 없음</span>'], ['워크스페이스 ID', html`<span class="mono dim">${w.id}</span>`]])))}
        ${raw(d.billing_v3 ? billingV3Section(d.billing_v3) : section('사용량 (플랜 한도 대비)', usageBars(d.usage)))}
      </div>
      ${raw(d.billing_v3 ? section(`결제 내역 (${d.billing_v3.orders.length})`, table([
        { key: 'created_at', label: '일시', w: 150, render: (o) => fmtD(o.paid_at || o.created_at) }, { key: 'title', label: '내용', w: 220, cls: 'ttl', render: (o) => html`${o.title} <small class="dim">${o.kind_label}</small>` },
        { key: 'amount', label: '금액 (VAT 포함)', w: 130, cls: 'num', render: (o) => `₩${n(o.amount)}${o.refunded_amount ? ` (환불 ₩${n(o.refunded_amount)})` : ''}` }, { key: 'status_label', label: '상태', w: 100 },
      ], d.billing_v3.orders, { empty: '결제 내역이 없습니다.', id: 'atbl-orders' })) : '')}
      ${raw(section(`멤버 (${d.members.length})`, table([
        { key: 'name', label: '이름', w: 150, cls: 'ttl' }, { key: 'email', label: '이메일', w: 240, render: (m) => html`<span class="mono">${m.email}</span>` }, { key: 'role', label: '역할', w: 90 },
        { key: 'status', label: '계정 상태', w: 90, render: (m) => chip(m.status) }, { key: 'joined_at', label: '가입일', w: 110, render: (m) => fmtDay(m.joined_at) },
      ], d.members, { rowHref: (m) => `/admin/users/${m.id}` })))}
      ${raw(section(`대기 중 초대 (${(d.invitations || []).filter((i) => i.status === 'PENDING').length})`, table([
        { key: 'email', label: '이메일', w: 240, render: (i) => html`<span class="mono">${i.email}</span>` }, { key: 'role', label: '역할', w: 90 }, { key: 'invited_by_name', label: '초대한 사람', w: 160, render: (i) => html`${i.invited_by_name || '-'}` },
        { key: 'status', label: '상태', w: 80, render: (i) => chip(i.status, { PENDING: '대기', ACCEPTED: '수락', REVOKED: '취소', EXPIRED: '만료' }[i.status]) }, { key: 'last_email_status', label: '메일', w: 90, render: (i) => (i.last_email_status ? chip(i.last_email_status === 'SENT' ? 'ok' : i.last_email_status, { SENT: '발송됨', FAILED: '발송 실패', PENDING: '발송 중' }[i.last_email_status]) : '-') },
        { key: 'expires_at', label: '만료', w: 110, render: (i) => fmtDay(i.expires_at) },
      ], (d.invitations || []).filter((i) => i.status !== 'ACCEPTED'), { empty: '대기 중인 멤버 초대가 없습니다.' }) + (d.origin_invitation ? html`<p class="hint">이 워크스페이스는 고객 초대(${d.origin_invitation.email}, ${fmtDay(d.origin_invitation.accepted_at)} 수락)로 생성되었습니다.</p>` : '<p class="hint">멤버 초대는 워크스페이스 소유자·관리자가 설정 › 팀원에서 관리합니다. 운영자는 조회만 할 수 있습니다.</p>')))}
      ${raw(ai ? section('AI 이용량 · API 비용', html`${raw(kpis([
          { label: '이번 기간 사용률', value: ai.usage.limit_usd === null ? '무제한' : pctTxt(ai.usage.used_pct), tone: ai.usage.used_pct >= 95 ? 'bad' : ai.usage.used_pct >= 80 ? 'warn' : '',
            sub: ai.usage.limit_usd === null ? '계약' : `${money(ai.usage.used_usd, ai.fx)} / $${ai.usage.limit_usd} · 남은 ${pctTxt(ai.usage.remaining_pct)}` },
          { label: ai.usage.allowance === 'ONCE' ? '한도 (최초 1회)' : '다음 초기화', value: ai.usage.allowance === 'ONCE' ? (ai.usage.free_eligible === false ? '0 (수령 완료)' : `$${ai.usage.limit_usd}`) : (ai.usage.resets_at ? fmtDay(ai.usage.resets_at) : '-') },
          { label: '30일 API 비용', value: money(ai.kpis.provider_cost_30d, ai.fx), sub: `요청 ${n(ai.kpis.runs_30d)} · 성공률 ${ai.kpis.success_rate_30d === null ? '-' : ai.kpis.success_rate_30d + '%'}` },
          { label: '토큰 (30일)', value: n(ai.kpis.input_tokens_30d + ai.kpis.output_tokens_30d), sub: `입력 ${n(ai.kpis.input_tokens_30d)} · 출력 ${n(ai.kpis.output_tokens_30d)} · 캐시 ${n(ai.kpis.cached_input_tokens_30d)}` }]))}
        <div class="asec__h" style="margin-top:12px">일별 API 비용 (30일)</div>${raw(barChart(ai.daily.map((x) => ({ label: x.date.slice(5), value: x.cost_usd })), { id: 'ws-ai-daily', fmt: (v) => `$${v.toFixed(3)}` }))}
        ${raw(aiFeatureTable(ai.features))}
        <div class="agrid2" style="margin-top:12px">
          <div><div class="asec__h">사용자별 (30일)</div>${raw(table([{ key: 'name', label: '사용자', w: 140, render: (r) => r.name || '(탈퇴)' }, { key: 'runs', label: '요청', w: 70, render: (r) => n(r.runs) },
            { key: 'tokens', label: '토큰', w: 120, render: (r) => `${n(r.input_tokens)} / ${n(r.output_tokens)}` }, { key: 'provider_cost', label: '비용', w: 130, render: (r) => money(r.provider_cost, ai.fx) }], ai.users, { empty: 'AI 요청 기록이 없습니다.', id: 'aiusers' }))}
            <div class="asec__h" style="margin-top:12px">모델별 (30일)</div>${raw(table([{ key: 'model', label: '모델', w: 160 }, { key: 'runs', label: '요청', w: 70, render: (r) => n(r.runs) }, { key: 'provider_cost', label: '비용', w: 130, render: (r) => money(r.provider_cost, ai.fx) }], ai.models, { empty: '-', id: 'aimodels' }))}</div>
          <div><div class="asec__h">최근 AI 요청</div>${raw(table([{ key: 'created_at', label: '일시', w: 130, render: (r) => fmtD(r.created_at) }, { key: 'feature', label: '기능', w: 120, render: (r) => AI_FEATURE[r.feature] || r.feature }, { key: 'user_name', label: '사용자', w: 90 },
            { key: 'status', label: '상태', w: 90, render: (r) => chip(r.status === 'SUCCEEDED' ? 'ACTIVE' : r.status === 'FAILED' ? 'SUSPENDED' : 'DRAFT', r.status === 'SUCCEEDED' ? '성공' : r.status === 'FAILED' ? `실패 ${r.error_code || ''}` : '진행 중') },
            { key: 'tokens', label: '토큰 (입/출/캐시)', w: 140, render: (r) => `${n(r.input_tokens)} / ${n(r.output_tokens)} / ${n(r.cached_input_tokens)}` },
            { key: 'provider_cost_amount', label: '비용', w: 100, render: (r) => html`${usd(r.provider_cost_amount)}${raw(r.cost_estimated ? ' <small class="dim">추정</small>' : '')}` }], ai.runs, { empty: 'AI 요청 기록이 없습니다.', id: 'airuns' }))}</div>
        </div>
        <p class="hint">사용률 = 이번 기간 API 비용 ÷ 플랜 한도(USD). 실패한 요청도 포함합니다. 원화는 ${fxNote(ai.fx)} 기준 표시용입니다.</p>`) : '')}
      <div class="agrid2">
        ${raw(section('최근 활동', d.activity.length ? html`<ul class="aact">${raw(d.activity.map((x) => html`<li><time>${fmtD(x.at)}</time><span>${ACT[x.type] || x.type}</span></li>`).join(''))}</ul>` : '<div class="aempty">활동 기록이 없습니다.</div>'))}
        ${raw(section('운영자 조작', table([{ key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) }, { key: 'admin_name', label: '운영자', w: 150 }, { key: 'summary', label: '요약', render: (r) => html`${ACTIONS[r.action] || r.action}${r.metadata?.reason ? ` — ${r.metadata.reason}` : ''}` }], d.audit, { empty: '기록 없음' })))}
      </div>
    </div>`;
    bindRows(main, navigate);
    const run = async (path, title, body, confirm, danger) => {
      const reason = await promptDialog({ title, body, label: '사유 (선택, 감사 기록에 남음)', confirm, danger });
      if (reason === null) return;
      try { await api('POST', `/api/admin/workspaces/${id}/${path}`, { reason }); toast(`${confirm} 처리했습니다.`); await draw(); } catch (e) { toast(e.message); }
    };
    const sb = $('#suspend'); if (sb) sb.onclick = () => run('suspend', `'${w.name}' 워크스페이스를 정지할까요?`, '멤버의 로그인은 유지되지만 이 워크스페이스의 모든 API 호출(조회 포함)이 차단됩니다. 데이터는 삭제되지 않고 구독도 해지되지 않습니다.', '정지', true);
    const rb = $('#reactivate'); if (rb) rb.onclick = () => run('reactivate', `'${w.name}' 워크스페이스 정지를 해제할까요?`, '멤버가 다시 접근할 수 있게 됩니다.', '정지 해제', false);
  };
  await draw();
}
