/* Admin Console building blocks: server-paged table, pager, KPI strip, status chips, query-string helpers.
 * Table-centric and deliberately plain — the console shares RELAI's tokens but reads as an internal tool. */
import { api } from '../core/api.js';
import { fmtDT, html, raw } from '../core/dom.js';

export const fmtD = (iso) => (iso ? fmtDT(iso) : '-');
export const fmtDay = (iso) => (iso ? fmtDT(iso).slice(0, 10) : '-');
export const n = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('ko-KR'));
export const rel = (iso) => {
  if (!iso) return '-';
  const d = (Date.now() - new Date(iso).getTime()) / 60000;
  if (d < 1) return '방금'; if (d < 60) return `${Math.floor(d)}분 전`; if (d < 1440) return `${Math.floor(d / 60)}시간 전`; if (d < 43200) return `${Math.floor(d / 1440)}일 전`; return fmtDay(iso);
};

/* Blue = action · Green = normal/active · Orange = attention · Red = suspended/failed · Gray = inactive */
const TONE = { RECONNECT_REQUIRED: 'warn', ERROR: 'bad', DISABLED: 'muted', PARTIAL: 'warn', SUCCESS: 'ok', RUNNING: 'act', ACTIVE: 'ok', SUSPENDED: 'bad', DEACTIVATED: 'muted', CLOSED: 'muted', SYSTEM_ADMIN: 'act', NONE: 'muted', PAST_DUE: 'warn', UNPAID: 'warn', FAILED: 'bad', DECLINED: 'bad', PAID: 'ok', SUCCEEDED: 'ok', PENDING: 'warn', CANCELED: 'muted', CANCELLED: 'muted', TRIALING: 'act',
  REGISTERED: 'muted', WORKSPACE_CREATED: 'warn', PROJECT_CREATED: 'act', ACTIVE_USER: 'ok', ok: 'ok', warn: 'warn', attention: 'bad', act: 'act', muted: 'muted', bad: 'bad' };
const LABEL = { RECONNECT_REQUIRED: '재연결 필요', ERROR: '오류', DISABLED: '해제됨', PARTIAL: '부분 실패', SUCCESS: '성공', RUNNING: '실행 중', ACTIVE: '정상', SUSPENDED: '정지', DEACTIVATED: '탈퇴', CLOSED: '종료', SYSTEM_ADMIN: 'System Admin', NONE: '-', REGISTERED: '가입', WORKSPACE_CREATED: 'Workspace 생성', PROJECT_CREATED: 'Project 생성', ACTIVE_USER: '활성 사용자', ok: '정상', warn: '주의', attention: '확인 필요' };
export const chip = (v, label) => html`<span class="achip achip--${TONE[v] || 'muted'}">${label ?? LABEL[v] ?? v ?? '-'}</span>`;
export const ACTIONS = { SUSPEND_USER: '사용자 정지', REACTIVATE_USER: '사용자 정지 해제', SUSPEND_WORKSPACE: 'Workspace 정지', REACTIVATE_WORKSPACE: 'Workspace 정지 해제', GRANT_AI_CREDITS: 'AI Credit 지급', ADJUST_AI_CREDITS: 'AI Credit 조정' };
export const TARGET = { USER: 'User', WORKSPACE: 'Workspace', SUBSCRIPTION: 'Subscription', PAYMENT: 'Payment' };

/* ---- query string state (list pages keep filters in the URL so reloads and back navigation keep them) ---- */
export const qs = () => Object.fromEntries(new URLSearchParams(location.search));
export const setQs = (patch, { resetPage = true } = {}) => {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null || v === undefined) q.delete(k); else q.set(k, v); }
  if (resetPage && !('page' in patch)) q.delete('page');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`);
};
export const adminApi = (path, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  return api('GET', `/api/admin/${path}${q.toString() ? '?' + q : ''}`);
};

/* ---- table: cols [{key,label,w?,cls?,render}] rows [] rowHref(r)? ---- */
export const table = (cols, rows, { rowHref, empty = '데이터가 없습니다.', id = 'atbl' } = {}) => html`<div class="atwrap"><table class="atable" id="${id}">
  <thead><tr>${raw(cols.map((c) => html`<th class="${c.cls || ''}" ${raw(c.w ? html`style="width:${c.w}px"` : '')}>${c.label}</th>`).join(''))}</tr></thead>
  <tbody>${raw(rows.length ? rows.map((r) => html`<tr ${raw(rowHref ? html`data-href="${rowHref(r)}" tabindex="0"` : '')}>${raw(cols.map((c) => html`<td class="${c.cls || ''}">${raw(c.render ? c.render(r) : html`${r[c.key] ?? '-'}`)}</td>`).join(''))}</tr>`).join('')
    : html`<tr><td colspan="${cols.length}" class="aempty">${empty}</td></tr>`)}</tbody></table></div>`;
export const bindRows = (root, navigate) => root.querySelectorAll('tr[data-href]').forEach((tr) => {
  tr.onclick = (e) => { if (e.target.closest('a,button,input,select')) return; navigate(tr.dataset.href); };
  tr.onkeydown = (e) => { if (e.key === 'Enter') navigate(tr.dataset.href); };
});

/* ---- pager (server-side) ---- */
export const pager = ({ page, size, total }) => {
  const pages = Math.max(1, Math.ceil(total / size));
  return html`<div class="apager"><span>총 <b>${n(total)}</b>건 · ${total ? (page - 1) * size + 1 : 0}–${Math.min(total, page * size)}</span><span class="apager__sp"></span>
    <select class="select select--xs" data-size aria-label="페이지당 행 수">${raw([20, 50, 100].map((s) => html`<option value="${s}" ${s === size ? 'selected' : ''}>${s}행</option>`).join(''))}</select>
    <button type="button" class="btn btn--secondary btn--xs" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button><span class="apager__pg">${page} / ${pages}</span><button type="button" class="btn btn--secondary btn--xs" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>›</button></div>`;
};
export const bindPager = (root, reload) => {
  root.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => { setQs({ page: b.dataset.page }, { resetPage: false }); reload(); }; });
  const s = root.querySelector('[data-size]'); if (s) s.onchange = () => { setQs({ size: s.value }); reload(); };
};
/** Wires every [data-f] control (input → debounced, select → immediate) to the query string + reload. */
export const bindFilters = (root, reload) => {
  let t;
  root.querySelectorAll('[data-f]').forEach((el) => {
    if (el.tagName === 'SELECT') el.onchange = () => { setQs({ [el.dataset.f]: el.value }); reload(); };
    else el.oninput = () => { clearTimeout(t); t = setTimeout(() => { setQs({ [el.dataset.f]: el.value.trim() }); reload(); }, 300); };
  });
  const clr = root.querySelector('[data-clear]'); if (clr) clr.onclick = () => { history.replaceState(null, '', location.pathname); reload(); };
};
export const sel = (key, label, map, cur) => html`<select class="select select--sm" data-f="${key}" aria-label="${label}"><option value="">${label}</option>${raw(Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</select>`;

/* ---- KPI strip (max 6) ---- */
export const kpis = (items) => html`<div class="akpi">${raw(items.map((k) => html`${raw(k.href ? html`<a href="${k.href}" data-link class="akpi__i ${k.tone ? 'is-' + k.tone : ''}">` : html`<div class="akpi__i ${k.tone ? 'is-' + k.tone : ''}">`)}<span>${k.label}</span><b>${raw(k.value)}</b>${raw(k.sub ? html`<small>${k.sub}</small>` : '')}${raw(k.href ? '</a>' : '</div>')}`).join(''))}</div>`;

/* ---- page frame ---- */
export const head = (title, right = '', crumb = '') => html`<div class="ahead">${raw(crumb ? html`<a class="acrumb" href="${crumb.href}" data-link>← ${crumb.label}</a>` : '')}<div class="ahead__r"><h1>${title}</h1><div class="ahead__a">${raw(right)}</div></div></div>`;
export const section = (title, body, extra = '') => html`<section class="asec"><div class="asec__h">${title}${raw(extra)}</div>${raw(body)}</section>`;
export const dl = (pairs) => html`<dl class="adl">${raw(pairs.map(([k, v]) => html`<dt>${k}</dt><dd>${raw(v)}</dd>`).join(''))}</dl>`;
export const usageBars = (usage) => (!usage ? '' : html`<div class="ause">${raw(usage.dims.map((d) => html`<div class="ause__r"><span class="ause__l">${d.label}</span>
  <div class="ause__b"><i class="${d.pct === null ? '' : d.pct >= 90 ? 'is-bad' : d.pct >= 80 ? 'is-warn' : ''}" style="width:${d.pct === null ? 0 : Math.min(100, d.pct)}%"></i></div>
  <span class="ause__v"><b>${n(d.used)}</b> / ${d.limit === null ? 'Unlimited' : n(d.limit)}${raw(d.pct === null ? '' : html` <small>${d.pct}%</small>`)}</span></div>`).join(''))}</div>`);
export const errorBlock = (e) => html`<div class="aempty aempty--err">${e.message}</div>`;

/* ---- AI usage (Phase 11) ---- */
export const AI_FEATURE = { REQUIREMENT_EXTRACTION: '요구사항 추출', WBS_GENERATION: 'WBS 초안 (Planner 포함)', CHANGE_IMPACT: '변경 영향 분석', PROJECT_QA: '프로젝트 Q&A', WBS_PLAN_QUESTIONS: 'WBS Planner 질문 (무과금)', WBS_PLAN_FIX: 'WBS Planner 보완 (무과금)' };
export const usd = (v) => (v === null || v === undefined ? '-' : `$${Number(v).toFixed(4)}`);
/** Per-feature metering table shared by the dashboard and the workspace page. */
export const aiFeatureTable = (features) => table([
  { key: 'label', label: '기능', w: 150, render: (f) => AI_FEATURE[f.feature] || f.feature },
  { key: 'runs', label: '요청', w: 70, render: (f) => n(f.runs) }, { key: 'succeeded', label: '성공', w: 70, render: (f) => n(f.succeeded) },
  { key: 'success_rate', label: '성공률', w: 70, render: (f) => (f.success_rate === null ? '-' : `${f.success_rate}%`) },
  { key: 'avg_input_tokens', label: '평균 입력 토큰', w: 110, render: (f) => n(f.avg_input_tokens) }, { key: 'avg_output_tokens', label: '평균 출력 토큰', w: 110, render: (f) => n(f.avg_output_tokens) },
  { key: 'avg_provider_cost', label: '평균 Provider Cost', w: 130, render: (f) => usd(f.avg_provider_cost) }, { key: 'avg_credit', label: '평균 Credit', w: 90, render: (f) => n(f.avg_credit) },
  { key: 'credits', label: 'Credit 합계', w: 90, render: (f) => n(f.credits) }, { key: 'avg_latency_ms', label: '평균 응답', w: 90, render: (f) => (f.avg_latency_ms === null ? '-' : `${(f.avg_latency_ms / 1000).toFixed(1)}s`) },
], features, { empty: 'AI 요청 기록이 없습니다.', id: 'aiftbl' });
