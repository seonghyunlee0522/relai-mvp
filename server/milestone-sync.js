/**
 * F3 — WBS milestones follow the real events. A milestone whose title names an event that has happened becomes 완료 with the actual date:
 *   착수보고회 / 킥오프   ← 01 착수보고회 activity completed (date = the kickoff date, else the day it was completed)
 *   …설계…               ← 03 분석·설계 phase passed its gate (date = the day the phase completed)
 *   …검수…               ← every in-scope confirmed requirement sits in an ACCEPTED 검수 (date = the latest customer approval)
 *   …오픈 (goLiveMilestone) ← 06 오픈 완료 recorded (date = the go-live date) — recordGoLive does it too; this catches milestones made later
 * Idempotent: only open milestones change. Called after the events above, after 01 주요 일정 import, and before weekly report / close.
 */
import { updateWbs, todayStr } from './wbs.js';
import { GO_LIVE_TITLE } from './wbs-skeleton.js';

export const MILESTONE_KIND = [
  ['KICKOFF', /착수|킥오프|kick-?off/i],
  ['ACCEPTANCE', /검수|acceptance/i],
  ['DESIGN', /설계|design/i],
];
/** Which event a milestone / key-date title names (first match; 오픈 wins over everything). Pure — unit-tested. */
export const milestoneKind = (title) => (GO_LIVE_TITLE.test(String(title || '')) ? 'GO_LIVE' : (MILESTONE_KIND.find(([, re]) => re.test(String(title || ''))) || [null])[0]);

const kstDate = (ts) => (ts ? new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)) : null);
const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const parse = (v) => { try { const x = JSON.parse(v || 'null'); return x && typeof x === 'object' ? x : null; } catch { return null; } };

/** { KICKOFF: 'YYYY-MM-DD', DESIGN: …, ACCEPTANCE: …, GO_LIVE: … } for the events that happened (absent = not yet). */
export async function milestoneEvents(db, projectId) {
  const out = {}; const today = todayStr();
  const def = await db.get('SELECT kickoff, go_live FROM project_definitions WHERE project_id = ?', [projectId]);
  const step = (phase, key) => db.get(`SELECT s.status, s.completed_at FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? AND p.phase_key = ? AND s.step_key = ?`, [projectId, phase, key]);
  const ko = await step('INITIATION', 'KICKOFF');
  if (ko && ko.status === 'COMPLETED') { const k = parse(def?.kickoff) || {}; const d = String(k.datetime || '').slice(0, 10); out.KICKOFF = isYmd(d) && d <= today ? d : kstDate(ko.completed_at); }
  const ad = await db.get(`SELECT status, completed_at FROM project_phases WHERE project_id = ? AND phase_key = 'ANALYSIS_DESIGN'`, [projectId]);
  if (ad && ad.status === 'COMPLETED' && ad.completed_at) out.DESIGN = kstDate(ad.completed_at);
  const acc = await db.all(`SELECT customer_approval, updated_at FROM acceptances WHERE project_id = ? AND archived_at IS NULL AND status = 'ACCEPTED'`, [projectId]);
  if (acc.length) {
    const left = await db.get(`SELECT COUNT(*) n FROM requirements r WHERE r.project_id = ? AND r.archived_at IS NULL AND r.scope = 'IN_SCOPE' AND r.status = 'CONFIRMED'
      AND NOT EXISTS (SELECT 1 FROM acceptance_links l JOIN acceptances a ON a.id = l.acceptance_id WHERE l.target_type = 'REQUIREMENT' AND l.target_id = r.id AND a.status = 'ACCEPTED' AND a.archived_at IS NULL)`, [projectId]);
    if (!Number(left.n)) out.ACCEPTANCE = acc.map((a) => { const d = (parse(a.customer_approval) || {}).date; return isYmd(d) ? d : kstDate(a.updated_at); }).sort().pop();
  }
  const gl = parse(def?.go_live); if (gl && isYmd(gl.date)) out.GO_LIVE = gl.date;
  return out;
}

/** Mark the open milestones of events that happened 완료 with their actual date. Returns how many changed. */
export async function syncMilestones(db, project, userId = null) {
  const open = await db.all(`SELECT * FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND item_type = 'MILESTONE' AND status <> 'COMPLETED' ORDER BY sequence`, [project.id]);
  if (!open.length) return 0;
  const ev = await milestoneEvents(db, project.id); let n = 0;
  for (const m of open) {
    const kind = m.lifecycle_phase === 'TRANSITION_GO_LIVE' ? 'GO_LIVE' : milestoneKind(m.title);
    if (kind && ev[kind] && await updateWbs(db, project, m, { status: 'COMPLETED', actual_end_date: ev[kind] }, userId)) n++;
  }
  return n;
}
