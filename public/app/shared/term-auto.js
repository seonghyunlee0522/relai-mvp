/* Redesign R3b (copy pass): on desktop, the first use of WBS · 간트 · 기준선 · 마일스톤 · 완료 조건 inside #main gets the "?" tooltip
 * (same .term as term()), once per render. Text in controls, tabs, chips, table headers and page titles is not a "use". */
import { isPhone } from '../core/device.js';

const TERMS = [
  ['WBS', 'WBS', '프로젝트에서 해야 할 일을 잘게 나눈 작업 목록'],
  ['간트', '간트', '작업의 시작일·종료일을 막대로 그린 일정표'],
  ['확정본', '확정본', '고객이 승인해 확정한 범위·요구사항. 이후 바뀌는 것은 변경 요청으로 관리합니다'],
  ['마일스톤', '마일스톤', '고객과 공유할 주요 시점 (예: 착수보고회, 오픈)'],
  ['완료 조건', '완료 조건', '이 요구사항이 다 됐다고 판단하는 기준. 검수 기준이 됩니다'],
];
export const TERM_SKIP = 'button,a,select,option,textarea,input,label,summary,script,style,th,h1,.term,.stabs,.dtabs,[role="tab"],.chip,.mono,.wcode,.toast,.gtable,.rtable,.gantt,.np__menu,.tmenu,.gpop,[contenteditable="true"]';

/** Annotate `root` (idempotent: a host that already holds a .term is left alone). */
export function annotateTerms(root) {
  if (!root || isPhone()) return;
  const left = TERMS.slice(); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while (left.length && (n = w.nextNode())) {
    const el = n.parentElement; if (!el || el.closest(TERM_SKIP) || !el.getClientRects().length) continue;
    for (const t of left.filter((x) => n.nodeValue.includes(x[0]))) {
      left.splice(left.indexOf(t), 1);
      const has = (x) => x && x.matches('.term') && (x.getAttribute('aria-label') || '').split(':')[0].includes(t[1]);
      if ([...el.querySelectorAll('.term')].some(has) || has(el.nextElementSibling)) continue;
      const s = document.createElement('span'); s.className = 'term'; s.tabIndex = 0; s.setAttribute('role', 'note'); s.dataset.auto = t[0];
      s.setAttribute('aria-label', `${t[1]}: ${t[2]}`); s.dataset.tip = `${t[1]} — ${t[2]}`; s.textContent = '?';
      n.after(' ', s);
    }
  }
}
let queued = false;
/** Watch the page body; re-annotate #main after each render (debounced to one pass per task). */
export function watchTerms() {
  new MutationObserver(() => { if (queued) return; queued = true; setTimeout(() => { queued = false; annotateTerms(document.querySelector('#main')); }, 0); })
    .observe(document.body, { childList: true, subtree: true });
}
