/**
 * Guided execution engine: phases, steps, progress, transitions.
 * All functions take a db and operate inside the caller's transaction where needed.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PHASES, DEFAULT_TEMPLATE_KEY } from './templates/default-phases.js';

const now = () => new Date().toISOString();

/* ---------- progress (kept separate so it can move to WBS-based weighting later) ---------- */
export function phaseProgress(steps) {
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'COMPLETED').length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}
/** Equal weight per phase. */
export function projectProgress(phases) {
  if (!phases.length) return 0;
  const sum = phases.reduce((a, p) => a + (p.progress?.percent ?? phaseProgress(p.steps).percent), 0);
  return Math.round(sum / phases.length);
}

/* ---------- initialisation ---------- */
/** Idempotent: creates template phases/steps for a project that has none. Returns true if created. */
export async function ensurePhases(db, project, { createdBy = project.created_by, at = project.created_at } = {}) {
  const has = (await db.get('SELECT 1 FROM project_phases WHERE project_id = ? LIMIT 1', [project.id]));
  if (has) return false;
  const INS_PHASE = `INSERT INTO project_phases
    (id, project_id, template_key, phase_key, name, description, sequence, status, started_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const INS_STEP = `INSERT INTO project_steps
    (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, linked_feature_type, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const ts = at || now();
  let currentId = null;
  for (const [i, ph] of DEFAULT_PHASES.entries()) {
    const id = randomUUID();
    const isCurrent = ph.key === project.current_phase;
    if (isCurrent) currentId = id;
    await db.run(INS_PHASE, [id, project.id, DEFAULT_TEMPLATE_KEY, ph.key, ph.name, ph.description, i + 1,
      isCurrent ? 'IN_PROGRESS' : 'NOT_STARTED', isCurrent ? ts : null, ts, ts]);
    for (const [j, st] of ph.steps.entries())
      await db.run(INS_STEP, [randomUUID(), id, st.key, st.title, st.description, st.completion_criteria, j + 1, st.is_required ? 1 : 0, st.linked_feature_type ?? null, ts, ts]);
  }
  if (!currentId) throw new Error(`project ${project.id}: current_phase ${project.current_phase} not in template`);
  (await db.run(`INSERT INTO phase_transitions (id, project_id, from_phase_id, to_phase_id, reason, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), project.id, null, currentId, 'PROJECT_CREATED', createdBy, ts]));
  return true;
}

/* ---------- reads ---------- */
export async function loadGuide(db, project) {
  const phases = (await db.all('SELECT * FROM project_phases WHERE project_id = ? ORDER BY sequence', [project.id]));
  const steps = (await db.all(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? ORDER BY p.sequence, s.sequence`, [project.id]));
  const byPhase = new Map(phases.map((p) => [p.id, []]));
  steps.forEach((s) => byPhase.get(s.project_phase_id).push(s));
  const out = phases.map((p) => {
    const st = byPhase.get(p.id);
    return { ...p, steps: st, progress: phaseProgress(st), is_current: p.phase_key === project.current_phase };
  });
  const history = (await db.all(`SELECT t.id, t.reason, t.changed_at, t.changed_by, u.name AS changed_by_name,
      f.phase_key AS from_key, f.name AS from_name, tp.phase_key AS to_key, tp.name AS to_name
    FROM phase_transitions t
    LEFT JOIN project_phases f ON f.id = t.from_phase_id
    JOIN project_phases tp ON tp.id = t.to_phase_id
    LEFT JOIN users u ON u.id = t.changed_by
    WHERE t.project_id = ? ORDER BY t.changed_at, t.seq`, [project.id]));
  const current = out.find((p) => p.is_current) || null;
  const next = current ? out.find((p) => p.sequence === current.sequence + 1) || null : null;
  return { phases: out, progress: projectProgress(out), current_phase: current, next_phase: next, history };
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
 * - Leaving phase: COMPLETED when every required step is done, otherwise stays IN_PROGRESS (visible gap).
 * - Entering phase: IN_PROGRESS; started_at set on first entry; completed_at cleared when re-entered.
 * - projects.current_phase stays in sync (list views and Phase 1 code read it).
 */
export async function transitionTo(db, project, toPhaseId, userId, reason = 'MANUAL') {
  const to = (await db.get('SELECT * FROM project_phases WHERE id = ? AND project_id = ?', [toPhaseId, project.id]));
  if (!to) return { error: 'not_found' };
  if (to.phase_key === project.current_phase) return { error: 'already_current' };
  const from = (await db.get('SELECT * FROM project_phases WHERE project_id = ? AND phase_key = ?', [project.id, project.current_phase]));
  const ts = now();
  if (from) {
    const steps = (await db.all('SELECT status, is_required FROM project_steps WHERE project_phase_id = ?', [from.id]));
    const allDone = steps.every((s) => !s.is_required || s.status === 'COMPLETED');
    (await db.run(`UPDATE project_phases SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [allDone ? 'COMPLETED' : 'IN_PROGRESS', allDone ? ts : null, ts, from.id]));
  }
  (await db.run(`UPDATE project_phases SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ? WHERE id = ?`, [ts, ts, to.id]));
  // UI-001: a DRAFT (아직 시작 전) project becomes 진행 중 the first time it moves past 착수.
  (await db.run(`UPDATE projects SET current_phase = ?, status = CASE WHEN status = 'DRAFT' AND ? <> 'INITIATION' THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?`, [to.phase_key, to.phase_key, ts, project.id]));
  (await db.run(`INSERT INTO phase_transitions (id, project_id, from_phase_id, to_phase_id, reason, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), project.id, from?.id ?? null, to.id, reason, userId, ts]));
  return { ok: true };
}
