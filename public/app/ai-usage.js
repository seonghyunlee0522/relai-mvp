/* 설정 › AI 이용 현황 (2026-10-27 — replaces 설정 › AI 크레딧). One allowance per workspace, readable by every member.
 * Shows percentages only: 이번 기간 사용률, 남은 이용률, a progress bar, the daily cumulative usage line and the next reset date.
 * No amount, token count, price or credit is ever shown (the API does not send them). 80 % / 95 % / 100 % notices. */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';

const pct = (v) => `${Number(v || 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;
const kday = (iso) => { const d = new Date(iso); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`; };
const mday = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}/${d}`; };

/** Notice for the 80 / 95 / 100 % tiers (null when fine). */
export function usageNotice(u) {
  if (!u || u.unlimited) return null;
  if (u.blocked || u.tier === 'reached') {
    return u.allowance === 'ONCE'
      ? { tone: 'crit', text: '무료 AI 이용량을 모두 사용했습니다. Pro 플랜으로 바꾸면 매월 AI 이용량이 제공됩니다.', cta: ['/app/billing/plans', '플랜 살펴보기'] }
      : { tone: 'crit', text: `이번 기간의 AI 이용량을 모두 사용했습니다.${u.resets_at ? ` ${kday(u.resets_at)}에 다시 제공됩니다.` : ''} AI 외의 기능은 그대로 쓸 수 있습니다.` };
  }
  if (u.tier === 'critical') return { tone: 'crit', text: `AI 이용량이 ${pct(u.remaining_pct)} 남았습니다.` };
  if (u.tier === 'warn') return { tone: 'warn', text: `AI 이용량의 ${pct(u.used_pct)}를 사용했습니다.` };
  return null;
}

/** Inline SVG line of the cumulative usage % per day, with 80 % / 100 % guides. Scales to its container (viewBox). */
export function usageChart(days) {
  const pts = (days || []).filter((d) => d.cum_pct !== null);
  if (!pts.length) return html`<p class="hint" id="au-chart-empty">표시할 기간이 없습니다.</p>`;
  const W = 640; const H = 220; const L = 40; const R = 12; const T = 12; const B = 28;
  const x = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cum_pct).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const step = Math.max(1, Math.ceil(pts.length / 6));
  const ticks = pts.map((p, i) => ((i % step === 0 || i === pts.length - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="au-ax">${mday(p.date)}</text>` : '')).join('');
  const grid = [0, 50, 80, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="au-grid${v === 80 ? ' is-warn' : v === 100 ? ' is-max' : ''}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="au-ax">${v}%</text>`).join('');
  const last = pts[pts.length - 1];
  return `<svg class="au-chart" id="au-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 누적 AI 사용률, 마지막 ${pct(last.cum_pct)}">
    ${grid}<path d="${area}" class="au-area"/><path d="${line}" class="au-line"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.cum_pct).toFixed(1)}" r="4" class="au-dot"/>${ticks}</svg>`;
}

export async function aiUsagePage(main = $('#main')) {
  document.title = 'AI 이용 현황 — RELAI';
  if (location.pathname.startsWith('/app/settings/credits')) history.replaceState(null, '', '/app/settings/ai-usage');
  const d = await api('GET', `/api/workspaces/${state.workspace.id}/ai-usage`);
  const u = d.usage;
  const n = usageNotice(u);
  const used = u.unlimited ? 0 : Number(u.used_pct || 0);
  const tone = u.blocked || u.tier === 'reached' || u.tier === 'critical' ? 'is-bad' : u.tier === 'warn' ? 'is-warn' : '';
  const period = u.unlimited ? '계약에 따라 제공됩니다.' : u.allowance === 'ONCE' ? 'Free 요금제는 처음 한 번 제공되며 다시 채워지지 않습니다.'
    : u.resets_at ? `다음 제공일: ${kday(u.resets_at)} · 남은 이용량은 이월되지 않습니다.` : '매월 새로 제공됩니다.';
  main.innerHTML = html`<div class="page page--narrow" id="ai-usage">
    <div class="page__head"><div><a class="link" href="/app/settings" data-link>← 설정</a><h1 style="margin-top:4px">AI 이용 현황</h1>
      <p class="dim">워크스페이스 구성원이 함께 쓰는 AI 이용량입니다. AI 기능을 실행한 만큼 사용률이 올라갑니다.</p></div></div>
    ${raw(n ? html`<div class="notice notice--${n.tone}" id="au-notice" role="status">${n.text}${raw(n.cta ? html` <a class="link" href="${n.cta[0]}" data-link data-upsell-cta>${n.cta[1]}</a>` : '')}</div>` : '')}
    <div class="panel au-sum ${tone}"><div class="panel__b">
      ${raw(u.unlimited ? html`<p class="au-big" id="au-unlimited">AI 이용량 제한 없음</p><p class="hint">${period}</p>` : html`
      <div class="au-kpis">
        <div class="au-kpi"><span class="au-kpi__l">${u.allowance === 'ONCE' ? '사용한 AI 이용량' : '이번 기간 사용량'}</span><b class="au-kpi__v" id="au-used">${pct(u.used_pct)}</b></div>
        <div class="au-kpi"><span class="au-kpi__l">남은 이용량</span><b class="au-kpi__v" id="au-left">${pct(u.remaining_pct)}</b></div>
      </div>
      <div class="au-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-label="AI 이용량 사용률"><span style="width:${Math.min(100, used)}%"></span><i style="left:80%"></i></div>
      <p class="hint" id="au-period" style="margin-top:10px">${period}</p>`)}
    </div></div>
    ${raw(u.unlimited ? '' : html`<div class="panel" style="margin-top:16px"><div class="panel__h">일별 누적 사용률<small class="dim">${u.allowance === 'ONCE' ? '최근 30일' : '이번 기간'}</small></div>
      <div class="panel__b">${raw(usageChart(d.days))}</div></div>`)}
    <p class="hint" style="margin-top:16px">AI 결과는 초안·후보이며 검토·승인한 항목만 저장됩니다. 실행 중 오류가 나도 AI 처리가 이루어졌다면 사용률에 반영됩니다.</p>
  </div>`;
}
