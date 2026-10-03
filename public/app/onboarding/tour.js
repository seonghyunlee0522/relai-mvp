/* Product Tour (Phase 14) — lightweight guided walkthrough, no library.
 * Overlay + spotlight on a [data-tour-id] target + popover with [이전] [다음] [건너뛰기] [가이드 종료] (+ optional CTA).
 * - Steps come from the server config (ob.tour.steps); position (current_step) is saved server-side on every step.
 * - A step whose route differs navigates first, then waits for the page to render ('relai:rendered'); a missing target
 *   falls back to a centered guide (never crashes, never waits forever).
 * - ≤720px: the popover becomes a bottom sheet; the spotlight stays.
 * - Keyboard: → / Enter = 다음, ← = 이전, Esc = 가이드 종료. Focus is trapped inside the popover while open. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import { toast } from '../shared/dialogs.js';
import { ob } from './state.js';

const MOBILE = () => window.innerWidth <= 720;
const WAIT_MS = 1500; const POLL_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = {
  active: false, paused: false, steps: [], idx: 0, el: null, key: null,
  async start({ replay = false } = {}) {
    const o = await ob.get(); if (!o) { toast('가이드를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.'); return; }
    this.steps = usable(o); if (!this.steps.length) { toast('지금 화면에서는 안내할 단계가 없습니다.'); return; }
    let idx = 0;
    if (replay) await ob.update('PRODUCT_TOUR', 'replay', this.steps[0].key);
    else if (o.tour.status === 'IN_PROGRESS' && o.tour.current_step) { const i = this.steps.findIndex((s) => s.key === o.tour.current_step); idx = i >= 0 ? i : 0; }
    else await ob.update('PRODUCT_TOUR', 'start', this.steps[0].key);
    this.active = true; this.paused = false;
    await this.show(idx);
  },
  /** Called after every page render: resumes an in-progress tour when the page matches (refresh / after project creation). */
  async onRender() {
    if (this.active && !this.paused) { this.place(); return; }
    const o = ob.peek() || await ob.get(); if (!o || o.tour.status !== 'IN_PROGRESS' || !o.tour.current_step) { pill(false); return; }
    const cur = o.tour.steps.find((s) => s.key === o.tour.current_step);
    if (cur && cur.pauseUntilProject && /^\/app\/projects\/(?!new)[\w-]+/.test(location.pathname)) {   // project was just created → continue from the project steps
      const fresh = await ob.refresh(); if (fresh && fresh.workspace.project_count > 0) { this.steps = usable(fresh); const i = this.steps.findIndex((s) => s.key === 'PROJECT_HOME'); if (i >= 0) { this.active = true; this.paused = false; await this.show(i); return; } }
    }
    if (cur && cur.pauseUntilProject && /^\/app\/projects\/new/.test(location.pathname)) { pill(false); return; }   // the guide waits quietly while the project form is open
    if (cur && samePage(cur.route) && !this.paused && !$('.tour')) { this.steps = usable(o); const i = this.steps.findIndex((s) => s.key === cur.key); if (i >= 0) { this.active = true; await this.show(i); return; } }
    pill(true, () => this.start());
  },
  async show(i) {
    this.idx = i; const step = this.steps[i]; if (!step) return this.finish();
    pill(false);
    if (!samePage(step.route)) { this.hide(); const done = waitRender(); navigate(withPid(step.route)); await done; }
    await ob.update('PRODUCT_TOUR', 'step', step.key);
    const target = await findTarget(step.target);
    this.render(step, target);
  },
  render(step, target) {
    this.hide();
    const n = this.steps.length; const i = this.idx; const center = !target || MOBILE() && step.placement === 'right';
    const el = document.createElement('div'); el.className = `tour ${center ? 'tour--center' : ''} ${MOBILE() ? 'tour--mobile' : ''}`;
    el.innerHTML = html`<div class="tour__spot" hidden></div>
      <div class="tour__pop" role="dialog" aria-modal="true" aria-labelledby="tourT" aria-describedby="tourB" tabindex="-1">
        <div class="tour__step">${i + 1} / ${n}</div>
        <h3 id="tourT">${step.title}</h3><p id="tourB">${step.body}</p>
        <div class="tour__btns">
          <button type="button" class="btn btn--ghost btn--sm" data-t="end">가이드 종료</button><span class="tour__sp"></span>
          ${raw(i > 0 ? '<button type="button" class="btn btn--secondary btn--sm" data-t="prev">이전</button>' : '')}
          ${raw(step.cta ? html`<button type="button" class="btn btn--secondary btn--sm" data-t="skip">건너뛰기</button><a class="btn btn--primary btn--sm" data-t="cta" href="${step.cta.href}" data-link>${step.cta.label}</a>` : html`<button type="button" class="btn btn--primary btn--sm" data-t="next">${i === n - 1 ? '완료' : '다음'}</button>`)}
        </div></div>`;
    document.body.append(el); this.el = el; this.target = target; this.active = true; this.paused = false;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      if (b.dataset.t === 'cta') { this.pause(); return; }   // link navigates (data-link); tour resumes when the page it waits for appears
      if (b.dataset.t === 'next' || b.dataset.t === 'skip') this.next(); else if (b.dataset.t === 'prev') this.prev(); else if (b.dataset.t === 'end') this.end();
    });
    this.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.end(); }
      else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('a,button'))) { e.preventDefault(); if (!step.cta) this.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prev(); }
      else if (e.key === 'Tab') trap(e, el.querySelector('.tour__pop'));
    };
    document.addEventListener('keydown', this.onKey);
    this.onMove = () => this.place(); window.addEventListener('resize', this.onMove); window.addEventListener('scroll', this.onMove, true);
    this.place();
    const first = el.querySelector('[data-t="next"],[data-t="cta"]') || el.querySelector('.tour__pop'); first.focus({ preventScroll: true });
  },
  place() {
    const el = this.el; if (!el) return; const pop = el.querySelector('.tour__pop'); const spot = el.querySelector('.tour__spot');
    const t = this.target && document.contains(this.target) ? this.target : null;
    if (!t || el.classList.contains('tour--center') || MOBILE()) {
      spot.hidden = !t; if (t) spotAt(spot, t.getBoundingClientRect());
      pop.style.cssText = ''; return;
    }
    const r = t.getBoundingClientRect(); spot.hidden = false; spotAt(spot, r);
    const pw = pop.offsetWidth || 340; const ph = pop.offsetHeight || 180; const gap = 12; const step = this.steps[this.idx]; let top; let left;
    const pl = step.placement || 'bottom';
    if (pl === 'right' && r.right + gap + pw <= window.innerWidth) { left = r.right + gap; top = r.top; }
    else if (pl === 'left' && r.left - gap - pw >= 0) { left = r.left - gap - pw; top = r.top; }
    else if (pl === 'top' && r.top - gap - ph >= 0) { left = r.left; top = r.top - gap - ph; }
    else if (r.bottom + gap + ph <= window.innerHeight) { left = r.left; top = r.bottom + gap; }
    else { left = r.left; top = Math.max(8, r.top - gap - ph); }
    left = Math.min(Math.max(8, left), window.innerWidth - pw - 8); top = Math.min(Math.max(8, top), window.innerHeight - ph - 8);
    pop.style.cssText = `position:fixed;left:${left}px;top:${top}px`;
  },
  hide() { if (this.el) { this.el.remove(); this.el = null; } if (this.onKey) { document.removeEventListener('keydown', this.onKey); this.onKey = null; } if (this.onMove) { window.removeEventListener('resize', this.onMove); window.removeEventListener('scroll', this.onMove, true); this.onMove = null; } },
  pause() { this.hide(); this.paused = true; },
  async next() { if (this.idx >= this.steps.length - 1) return this.finish(); await this.show(this.idx + 1); },
  async prev() { if (this.idx > 0) await this.show(this.idx - 1); },
  async finish() { this.hide(); this.active = false; this.paused = false; pill(false); await ob.update('PRODUCT_TOUR', 'complete'); toast('가이드를 모두 봤습니다. 언제든 도움말(?)에서 다시 볼 수 있습니다.'); },
  async end() { this.hide(); this.active = false; this.paused = false; pill(false); const o = ob.peek(); if (o && o.tour.status !== 'COMPLETED') await ob.update('PRODUCT_TOUR', 'skip'); toast('가이드를 종료했습니다. 도움말(?)에서 다시 볼 수 있습니다.'); },
};
export const tour = T;

/* ---------- helpers ---------- */
const usable = (o) => (o.tour.steps || []).filter((s) => s.available !== false && !(s.key === 'CREATE_PROJECT' && o.workspace.project_count > 0));
/* BUG-001: tour routes come from the server with the workspace's FIRST project id. When the user is inside a project
 * (e.g. the one just created) the tour must stay in that project instead of navigating away. */
const currentPid = () => (location.pathname.match(/^\/app\/projects\/(?!new)([\w-]+)/) || [])[1] || null;
const inProject = (route) => /^\/app\/projects\/(?!new)[\w-]+/.test(route || '');
const withPid = (route) => { const pid = currentPid(); return pid && inProject(route) ? String(route).replace(/^\/app\/projects\/[\w-]+/, `/app/projects/${pid}`) : route; };
const samePage = (route) => location.pathname.replace(/\/$/, '') === String(withPid(route) || '').replace(/\/$/, '');
const waitRender = () => new Promise((res) => { const done = () => { document.removeEventListener('relai:rendered', done); res(); }; document.addEventListener('relai:rendered', done); setTimeout(done, 4000); });
async function findTarget(id) {
  if (!id) return null;
  for (let t = 0; t < WAIT_MS; t += POLL_MS) {
    const el = document.querySelector(`[data-tour-id="${id}"]`);
    if (el && el.offsetParent !== null) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); await sleep(60); return el; }
    await sleep(POLL_MS);
  }
  return null;   // caller falls back to a centered guide
}
function spotAt(spot, r) { const pad = 6; spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`; }
function trap(e, box) {
  const f = [...box.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')]; if (!f.length) return;
  const first = f[0]; const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
/** Small "가이드 이어보기" chip when a tour is in progress but not showing on this page. */
function pill(show, onClick) {
  let p = $('#tourpill');
  if (!show) { if (p) p.remove(); return; }
  if (!state.user) return;
  if (!p) { p = document.createElement('button'); p.id = 'tourpill'; p.type = 'button'; p.className = 'tourpill'; p.innerHTML = '<span>▶</span> 가이드 이어보기'; document.body.append(p); }
  p.onclick = onClick;
}
