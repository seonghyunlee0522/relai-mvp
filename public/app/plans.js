/* 플랜 · 구독 (batch7 T5 paywall): where every plan-limit / AI-credit upsell lands (/app/billing/plans).
 * 무료 vs 유료 플랜 cards, a limit table built from the server catalogue (server/plans.js via GET …/billing, so numbers never drift),
 * and an FAQ. Payments are off (PAYMENTS_ENABLED): no price in won anywhere on this page (batch7 #7) — the paid plan says
 * '가격 안내 예정' — and 구독하기 only says that checkout is being prepared. No checkout call is ever made from here. */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { toast } from './shared/dialogs.js';

export const SUBSCRIBE_SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';
const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const lim = (v, unit = '') => (v === null || v === undefined ? '무제한' : `${n(v)}${unit}`);

const FAQ = [
  ['한도를 넘으면 지금까지 만든 데이터는 어떻게 되나요?', '그대로 남아 있고 계속 보고 고칠 수 있어요. 한도를 넘는 새 항목을 추가할 때만 안내가 나와요. 데이터는 삭제되거나 읽기 전용으로 바뀌지 않아요.'],
  ['이미 만든 프로젝트가 한도보다 많으면요?', '무료 플랜 한도를 넘는 프로젝트와 항목도 모두 그대로 있어요. 한도 안으로 줄어들 때까지 새로 추가하는 것만 막혀요.'],
  ['AI 크레딧은 어떻게 받나요?', '워크스페이스마다 무료 크레딧이 한 번 제공돼요(프로젝트별이 아니라 워크스페이스 전체 기준). 유료 플랜에서는 매달 크레딧이 추가로 제공됩니다. AI 실행에 실패하면 크레딧은 차감되지 않아요.'],
  ['샘플 프로젝트도 한도에 포함되나요?', '아니요. 샘플 프로젝트와 WBS의 고정 단계(착수·요구사항 정의 등)는 사용량과 한도에 포함되지 않아요.'],
  ['유료 플랜은 언제부터 구독할 수 있나요?', '결제를 준비하고 있어요. 열리면 이 페이지에서 바로 구독할 수 있고, 가격도 이곳에서 먼저 안내해 드려요.'],
];

export async function plansPage(main = $('#main')) {
  document.title = '플랜 — RELAI';
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${state.workspace.id}/billing`)).billing; } catch { b = null; }
  const plans = b?.plans || [];
  const free = plans.find((p) => p.key === 'FREE')?.limits || { projects: 2, members: 3, requirements: 50, wbs: 100, weekly_reports: 8 };
  const team = plans.find((p) => p.key === 'TEAM') || {};
  const tl = team.limits || {};
  const starter = b?.starter_credits ?? 500;
  const cur = b?.plan || 'FREE';
  // Price: payments off → never a won amount (batch7 #7); on → the catalogue price, VAT excluded.
  const teamPrice = b?.payments_enabled && team.base_monthly ? `월 ${n(team.base_monthly)}원부터 (부가세 별도)` : '가격 안내 예정';
  const rows = [
    ['진행 중 프로젝트', lim(free.projects, '개'), lim(tl.projects, '개')],
    ['멤버 (소유자 포함)', lim(free.members, '명'), '구매한 사용자 수만큼'],
    ['요구사항', lim(free.requirements, '건'), lim(tl.requirements, '건')],
    ['WBS 항목', lim(free.wbs, '개'), lim(tl.wbs, '개')],
    ['주간보고 (한 달)', lim(free.weekly_reports, '건'), lim(tl.weekly_reports, '건')],
    ['AI 크레딧', `워크스페이스당 ${n(starter)} (1회)`, team.ai_credits_monthly ? `매달 ${n(team.ai_credits_monthly)}` : '매달 제공'],
    ['7단계 가이드 · 문서 · 보고서', '모두 사용', '모두 사용'],
    ['지라 연동 · 엑셀 가져오기/내보내기', '사용', '사용'],
  ];
  const card = (key, name, price, desc, cta) => html`<div class="pl-card ${cur === key ? 'is-current' : ''}" data-plan="${key}">
    <div class="pl-card__h"><b>${name}</b>${raw(cur === key ? '<span class="chip chip--active">현재 플랜</span>' : '')}</div>
    <p class="pl-card__price">${price}</p><p class="dim">${desc}</p><div class="actions" style="margin-top:12px">${raw(cta)}</div></div>`;
  main.innerHTML = html`<div class="page page--narrow page--plans" id="plans-page">
    <div class="page__head"><div><a class="link" href="/app/settings#billing" data-link>← 설정</a><h1 style="margin-top:4px">플랜</h1>
      <p class="dim" style="margin-top:4px">무료로 시작하고, 팀이 커지면 유료 플랜으로 한도 없이 쓰세요.</p></div></div>
    <div class="pl-cards">
      ${raw(card('FREE', '무료', '무료', `프로젝트 ${lim(free.projects, '개')}까지 · AI 크레딧 ${n(starter)} 제공`, cur === 'FREE' ? '<button class="btn btn--secondary btn--sm" disabled>사용 중</button>' : ''))}
      ${raw(card('TEAM', '유료 플랜', teamPrice, '프로젝트·요구사항·WBS·주간보고 한도 없음 · 매달 AI 크레딧', cur === 'TEAM' ? '<button class="btn btn--secondary btn--sm" disabled>사용 중</button>' : '<button class="btn btn--primary btn--sm" id="pl-subscribe" data-subscribe>구독하기</button>'))}
    </div>
    <p class="hint" style="margin-top:8px">기업 맞춤(Enterprise)은 별도로 문의해 주세요.</p>
    <div class="panel" style="margin-top:20px" id="pl-compare"><div class="panel__h">기능 · 한도 비교</div>
      <div class="rtable-wrap--in"><table class="rtable pl-table" style="margin:0"><thead><tr><th>항목</th><th>무료</th><th>유료 플랜</th></tr></thead><tbody>
      ${raw(rows.map(([k, f, t]) => html`<tr><td>${k}</td><td>${f}</td><td>${t}</td></tr>`).join(''))}</tbody></table></div></div>
    <div class="panel" style="margin-top:20px" id="pl-faq"><div class="panel__h">자주 묻는 질문</div><div class="panel__b">
      ${raw(FAQ.map(([q, a]) => html`<details class="pl-faq"><summary>${q}</summary><p class="dim">${a}</p></details>`).join(''))}</div></div>
  </div>`;
  const sub = $('#pl-subscribe', main);
  if (sub) sub.onclick = () => toast(SUBSCRIBE_SOON);   // PAYMENTS_ENABLED off: never calls checkout
}
