/* AI layer helpers shared by the AI feature dialogs: status cache (flag + workspace AI usage %), large dialog shell, error copy.
 * Design rule: AI results are always labelled 초안/후보, stay inside the existing blue B2B look, and are never auto-saved.
 * AI usage (2026-10-27, credits retired): the server sends percentages only (usage.used_pct / remaining_pct / tier / blocked / resets_at);
 * no amount, token count or price ever reaches the browser. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from './dialogs.js';

const cache = new Map();   // pid → promise of /ai/status
export const aiStatus = (pid, { fresh = false } = {}) => {
  if (fresh || !cache.has(pid)) { const p = api('GET', wsApi(`/${pid}/ai/status`)).catch(() => ({ enabled: false, usage: null })); cache.set(pid, p); }
  return cache.get(pid);
};
export const aiStatusReset = (pid) => cache.delete(pid);
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI로 요구사항 추출', WBS_GENERATION: 'AI로 WBS 만들기', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기', TEST_GENERATION: 'AI로 시나리오 만들기' };
export const CONF = { HIGH: ['높음', 'is-good'], MEDIUM: ['보통', 'is-warn'], LOW: ['낮음', 'is-crit'] };
export const confChip = (c) => html`<span class="hchip hchip--sm ${(CONF[c] || CONF.LOW)[1]}" title="AI 확신도">${(CONF[c] || CONF.LOW)[0]}</span>`;

export const AI_USAGE_URL = '/app/settings/ai-usage';
/** @deprecated kept for older imports; 설정 › AI 이용 현황. */
export const CREDITS_URL = AI_USAGE_URL;
export const PLANS_URL = '/app/billing/plans';   // batch7 T5 upsell target
export const UPGRADE_URL = AI_USAGE_URL;
const pct = (v) => `${Number(v || 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;
const day = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
/** Home header: "AI 이용량 67.5% 남음" (or nothing when the plan has no limit). */
export const homeUsageLine = (u) => (u && !u.unlimited ? `AI 이용량 ${pct(u.remaining_pct)} 남음` : '');
/** @deprecated name kept for older imports. */
export const homeCreditLine = homeUsageLine;
/** One line for AI dialogs: "AI 이용량 32.5% 사용" — amber at 80 %, red at 95 %, blocked at 100 % with the way out. */
export const usageLine = (st) => {
  const u = st?.usage;
  if (!st?.enabled || !u || u.unlimited) return '';
  if (u.blocked) {
    const why = u.allowance === 'ONCE' ? html`무료 AI 이용량을 모두 사용했어요 · <a href="${PLANS_URL}" data-link data-upsell-cta>플랜 살펴보기</a>`
      : html`AI 이용량을 모두 사용했어요${raw(u.resets_at ? ` · ${day(u.resets_at)}에 다시 제공` : '')}`;
    return html`<span class="ai-credit is-short" title="워크스페이스 공용 AI 이용량">${raw(why)}</span>`;
  }
  const cls = u.tier === 'critical' ? 'is-short' : u.tier === 'warn' ? 'is-low' : '';
  return html`<span class="ai-credit ${cls}" title="워크스페이스 공용 AI 이용량 · 실행한 만큼 사용률이 올라갑니다"><a href="${AI_USAGE_URL}" data-link>AI 이용량</a> <b>${pct(u.used_pct)}</b> 사용</span>`;
};
/** @deprecated name kept for older imports (the feature argument is ignored: no per-feature price any more). */
export const creditLine = (st) => usageLine(st);
export const canRun = (st) => Boolean(st?.enabled) && !st?.usage?.blocked;

/** Human copy for AI error codes (the API message is kept as detail). */
export function aiErrorMessage(e) {
  const code = e?.code;
  if (code === 'AI_USAGE_LIMIT_REACHED') return e.message || 'AI 이용량을 모두 사용했습니다.';
  if (code === 'AI_DISABLED') return 'AI 기능을 사용할 수 없습니다. 관리자에게 문의하세요.';
  if (code === 'AI_RATE_LIMITED') return e.message || 'AI 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'AI_INPUT_TOO_LARGE') return e.message;
  if (['AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_INVALID_OUTPUT', 'AI_INTERNAL_ERROR'].includes(code)) return e.message || 'AI 응답을 생성하지 못했습니다. 다시 시도해 주세요.';
  return e?.message || '요청을 처리하지 못했습니다.';
}
/**
 * Large AI dialog shell: title row (with the 초안/후보 badge + credit line), scrollable body, sticky footer.
 * Returns { el, body, foot, close, setGuard(fn), busy(on, label) }. Esc / scrim click close unless `busy` (or the guard says no).
 */
export function aiDialog({ title, subtitle = '', feature, status, size = 'lg' }) {
  const el = document.createElement('div'); el.className = 'scrim scrim--ai';
  el.innerHTML = html`<div class="dialog dialog--ai dialog--ai-${size}" role="dialog" aria-modal="true" aria-labelledby="aiT">
    <div class="aid__h"><div><h3 id="aiT">${title} <span class="aid__tag">AI 초안·후보</span></h3>${raw(subtitle ? html`<p class="aid__sub">${subtitle}</p>` : '')}</div>
      <div class="aid__hr">${raw(usageLine(status))}<button type="button" class="drawer__x" data-close aria-label="닫기">×</button></div></div>
    <div class="aid__b"></div>
    <div class="aid__f"></div></div>`;
  let busy = false; let guard = null; let guarding = false;
  /** `guard` (setGuard) runs before every close (×, 취소/닫기, Esc, scrim) and may keep the dialog open by resolving false —
   *  P2 (Jim prod 10-21 #9): a paid result is never thrown away without asking. close({ force: true }) skips it (after 등록). */
  const close = async ({ force = false } = {}) => {
    if (busy || guarding) return false;
    if (guard && !force) { guarding = true; let ok = false; try { ok = await guard(); } finally { guarding = false; } if (!ok) return false; }
    el.remove(); document.removeEventListener('keydown', onKey); return true;
  };
  const onKey = (e) => { if (e.key === 'Escape' && !guarding) close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.body.append(el);
  return {
    el, body: $('.aid__b', el), foot: $('.aid__f', el), close,
    setGuard(fn) { guard = fn || null; },
    /** After a run: the header usage line shows the new percentage (it was the usage when the dialog opened). */
    setUsage(usage) { if (!usage || !status) return; status.usage = usage; const hr = $('.aid__hr', el); const old = $('.ai-credit', hr); const next = usageLine(status); if (old) old.outerHTML = next || ''; else if (next) hr.insertAdjacentHTML('afterbegin', next); },
    busy(on, label = 'AI가 분석하는 중입니다…') { busy = on; el.classList.toggle('is-busy', on); let o = $('.aid__busy', el); if (on) { if (!o) { o = document.createElement('div'); o.className = 'aid__busy'; $('.dialog', el).append(o); } o.innerHTML = html`<span class="spin"></span><span>${label}</span>`; } else if (o) o.remove(); },
  };
}

/** After a run: refreshes the dialog's header usage line; prints nothing (users never see a per-run amount). */
export const runLine = (run, d) => { if (run?.usage) d?.setUsage?.(run.usage); return ''; };
/** Standard "no result" / warnings blocks. */
export const warningsHtml = (w) => (w && w.length ? html`<ul class="aid__warn">${raw(w.map((x) => html`<li>${x}</li>`).join(''))}</ul>` : '');
export const aiNotice = (st) => html`<p class="aid__notice">${st?.notice || '현재 프로젝트의 요구사항, WBS, 이슈 데이터를 참고합니다.'}</p>`;
export const reportError = (e) => toast(aiErrorMessage(e));
