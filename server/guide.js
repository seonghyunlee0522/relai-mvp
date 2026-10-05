/**
 * Lifecycle engine (V2): phases, activities, transitions.
 * All functions take a db and operate inside the caller's transaction where needed.
 * Activity *state* is derived in activities.js; this module stores phases/steps and the current phase.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PHASES, DEFAULT_TEMPLATE_KEY, PHASE_BY_KEY } from './templates/default-phases.js';
import { activityStates, activitySummary } from './activities.js';

const now = () => new Date().toISOString();

/* ---------- initialisation ---------- */
/** Idempotent: creates template phases/activities for a project that has none. Returns true if created. */
export async function ensurePhases(db, project, { createdBy = project.created_by, at = project.created_at } = {}) {
  const has = (await db.get('SELECT 1 FROM project_phases WHERE project_id = ? LIMIT 1', [project.id]));
  if (has) return false;
  const INS_PHASE = `INSERT INTO project_phases
    (id, project_id, template_key, phase_key, name, description, sequence, status, started_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const INS_STEP = `INSERT INTO project_steps
    (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
  const ts = at || now();
  let currentId = null;
  for (const [i, ph] of DEFAULT_PHASES.entries()) {
    const id = randomUUID();
    const isCurrent = ph.key === project.current_phase;
    if (isCurrent) currentId = id;
    await db.run(INS_PHASE, [id, project.id, DEFAULT_TEMPLATE_KEY, ph.key, ph.name, ph.description, i + 1,
      isCurrent ? 'IN_PROGRESS' : 'NOT_STARTED', isCurrent ? ts : null, ts, ts]);
    for (const [j, st] of ph.steps.entries())
      await db.run(INS_STEP, [randomUUID(), id, st.key, st.title, st.description, st.completion_criteria, j + 1, st.is_required ? 1 : 0, st.importance, st.linked_feature_type ?? null, ts, ts]);
  }
  if (!currentId) throw new Error(`project ${project.id}: current_phase ${project.current_phase} not in template`);
  (await db.run(`INSERT INTO phase_transitions (id, project_id, from_phase_id, to_phase_id, reason, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), project.id, null, currentId, 'PROJECT_CREATED', createdBy, ts]));
  return true;
}

/** Lifecycle V2 reset for a database that still has another template: drop the project's phases and re-seed from 착수. */
export async function resetPhases(db, project) {
  await db.run('DELETE FROM phase_transitions WHERE project_id = ?', [project.id]);
  await db.run('DELETE FROM project_phases WHERE project_id = ?', [project.id]);   // steps cascade
  await db.run(`UPDATE projects SET current_phase = 'INITIATION', updated_at = ? WHERE id = ?`, [now(), project.id]);
  return ensurePhases(db, { ...project, current_phase: 'INITIATION' }, { createdBy: project.created_by, at: project.created_at });
}

/* ---------- reads ---------- */
/**
 * Phases with their activities. When `ctx` ({ stats, definition, overdue_tasks }) is given, every activity carries its
 * derived state + CTA and every phase a REQUIRED-based summary (activities.js); without ctx only the stored rows are returned.
 */
export async function loadGuide(db, project, ctx = null) {
  const phases = (await db.all('SELECT * FROM project_phases WHERE project_id = ? ORDER BY sequence', [project.id]));
  const steps = (await db.all(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? ORDER BY p.sequence, s.sequence`, [project.id]));
  const byPhase = new Map(phases.map((p) => [p.id, []]));
  steps.forEach((s) => byPhase.get(s.project_phase_id).push(s));
  const out = phases.map((p) => {
    const st = byPhase.get(p.id);
    const acts = ctx ? activityStates(p.phase_key, st, { ...ctx, pid: project.id }) : st;
    const tpl = PHASE_BY_KEY[p.phase_key];
    return { ...p, short: tpl ? tpl.short : p.name, en: tpl ? tpl.en : null, steps: acts, summary: ctx ? activitySummary(acts) : null, is_current: p.phase_key === project.current_phase };
  });
  const history = (await db.all(`SELECT t.id, t.reason, t.changed_at, t.changed_by, u.name AS changed_by_name,
      f.phase_key AS from_key, f.name AS from_name, tp.phase_key AS to_key, tp.name AS to_name
    FROM phase_transitions t
    LEFT JOIN project_phases f ON f.id = t.from_phase_id
    JOIN project_phases tp ON tp.id = t.to_phase_id
    LEFT JOIN users u ON u.id = t.changed_by
    WHERE t.project_id = ? ORDER BY t.changed_at, t.seq`, [project.id]));
  const current = out.find((p) => p.is_current) || null;
  // A phase before the current one has been left for the next step — shown as ended (✓) even if some activities stayed open.
  // Display only: status stays IN_PROGRESS for such a phase (transitionTo), so the open activities are still visible.
  for (const p of out) p.is_passed = Boolean(current && p.sequence < current.sequence);
  const next = current ? out.find((p) => p.sequence === current.sequence + 1) || null : null;
  return { phases: out, current_phase: current, next_phase: next, history };
}

/* ---------- writes ---------- */
export async function updateStep(db, project, stepId, { status, note }, userId) {
  const step = (await db.get(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE s.id = ? AND p.project_id = ?`, [stepId, project.id]));
  if (!step) return null;
  const ts = now();
  const sets = ['updated_at = ?']; const vals = [ts];
  if (status !== undefined) {
    sets.push('status = ?', 'completed_at = ?', 'completed_by = ?');
    vals.push(status, status === 'COMPLETED' ? ts : null, status === 'COMPLETED' ? userId : null);
  }
  if (note !== undefined) { sets.push('note = ?'); vals.push(note); }
  vals.push(stepId);
  (await db.run(`UPDATE project_steps SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return (await db.get('SELECT * FROM project_steps WHERE id = ?', [stepId]));
}

/**
 * Make `toPhaseId` the project's current phase.
 * - Leaving phase: COMPLETED when its REQUIRED gate is met (`gateMet`, computed by the caller from derived activity
 *   states; falls back to the stored marks), otherwise stays IN_PROGRESS (visible gap).
 * - Entering phase: IN_PROGRESS; started_at set on first entry; completed_at cleared when re-entered.
 * - projects.current_phase stays in sync; a DRAFT project becomes ACTIVE the first time it leaves 착수.
 */
export async function transitionTo(db, project, toPhaseId, userId, reason = 'MANUAL', { gateMet = null } = {}) {
  const to = (await db.get('SELECT * FROM project_phases WHERE id = ? AND project_id = ?', [toPhaseId, project.id]));
  if (!to) return { error: 'not_found' };
  if (to.phase_key === project.current_phase) return { error: 'already_current' };
  const from = (await db.get('SELECT * FROM project_phases WHERE project_id = ? AND phase_key = ?', [project.id, project.current_phase]));
  const ts = now();
  if (from) {
    let done = gateMet;
    if (done === null) {
      const steps = (await db.all('SELECT status, importance FROM project_steps WHERE project_phase_id = ?', [from.id]));
      done = steps.every((s) => s.importance !== 'REQUIRED' || s.status === 'COMPLETED' || s.status === 'SKIPPED');
    }
    (await db.run(`UPDATE project_phases SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [done ? 'COMPLETED' : 'IN_PROGRESS', done ? ts : null, ts, from.id]));
  }
  (await db.run(`UPDATE project_phases SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ? WHERE id = ?`, [ts, ts, to.id]));
  (await db.run(`UPDATE projects SET current_phase = ?, status = CASE WHEN status = 'DRAFT' AND ? <> 'INITIATION' THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?`, [to.phase_key, to.phase_key, ts, project.id]));
  (await db.run(`INSERT INTO phase_transitions (id, project_id, from_phase_id, to_phase_id, reason, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), project.id, from?.id ?? null, to.id, reason, userId, ts]));
  return { ok: true };
}
