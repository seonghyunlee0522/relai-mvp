/**
 * Shared domain helpers used by every entity module.
 *  - project-scoped display ID sequencing (REQ/CR/ISS/RSK/TC/ACC)
 *  - link target resolution + validation shared by all relation tables
 *
 * Caller is expected to run these inside tx() (BEGIN IMMEDIATE) so the counter update is serialized.
 */
import { ValidationError } from './validate.js';

export const now = () => new Date().toISOString();
export const str = (v) => (typeof v === 'string' ? v.trim() : '');

/* ---------- display ids ---------- */
/** Entity type → counter key + id prefix. Add new entity types here only. */
export const SEQUENCE_KEYS = { REQUIREMENT: 'REQ', CHANGE: 'CR', ISSUE: 'ISS', RISK: 'RSK', TEST: 'TC', ACCEPTANCE: 'ACC' };

/**
 * Atomically reserves the next sequence number for (project, entityType).
 * UPDATE … RETURNING inside BEGIN IMMEDIATE guarantees no two callers get the same value.
 * Numbers are never reused (archive does not release them).
 */
export async function getNextProjectSequence(db, projectId, entityType) {
  const key = SEQUENCE_KEYS[entityType] || entityType;
  (await db.run('INSERT INTO project_counters (project_id, key, value) VALUES (?,?,0) ON CONFLICT DO NOTHING', [projectId, key]));
  return (await db.get('UPDATE project_counters SET value = value + 1 WHERE project_id = ? AND key = ? RETURNING value', [projectId, key])).value;
}
export const formatDisplayId = (entityType, seq) => `${SEQUENCE_KEYS[entityType] || entityType}-${String(seq).padStart(3, '0')}`;
/** Convenience: returns { sequence, display_id }. */
export async function nextDisplayId(db, projectId, entityType) {
  const sequence = (await getNextProjectSequence(db, projectId, entityType));
  return { sequence, display_id: formatDisplayId(entityType, sequence) };
}

/* ---------- relation targets ---------- */
/** Whitelist of linkable entity types → table + label column. display_id or wbs_code is only used for labels, never as a key. */
export const LINK_TARGETS = {
  REQUIREMENT: { table: 'requirements', code: 'display_id', label: '요구사항' },
  WBS: { table: 'wbs_items', code: 'wbs_code', label: 'WBS' },
  CHANGE: { table: 'change_requests', code: 'display_id', label: '변경 요청' },
  ISSUE: { table: 'issues', code: 'display_id', label: 'Issue' },
  RISK: { table: 'risks', code: 'display_id', label: 'Risk' },
  TEST: { table: 'test_cases', code: 'display_id', label: '테스트' },
  ACCEPTANCE: { table: 'acceptances', code: 'display_id', label: '검수' },
};

/**
 * Resolves a link target by id within the given project, enforcing:
 *  - target_type ∈ allowed (whitelist)
 *  - row exists AND belongs to the same project (workspace scoping is guaranteed by loadProject upstream)
 *  - row is not archived
 * Returns { error:'bad_type' } (→400) | { error:'not_found' } (→404) | throws ValidationError for archived | { row, label }.
 */
export async function resolveLinkTarget(db, project, targetType, targetId, allowed = Object.keys(LINK_TARGETS)) {
  const def = LINK_TARGETS[targetType];
  if (!def || !allowed.includes(targetType)) throw new ValidationError({ target_type: '연결 대상 유형이 올바르지 않습니다.' });
  const row = (await db.get(`SELECT * FROM ${def.table} WHERE project_id = ? AND id = ?`, [project.id, String(targetId || '')]));
  if (!row) return { error: 'not_found' };
  if (row.archived_at) throw new ValidationError({ target_id: `보관된 ${def.label}은(는) 연결할 수 없습니다.` });
  return { row, label: `${row[def.code]} ${row.title}` };
}
/** Label for an already-linked row (archived rows allowed — used for history text). */
export async function linkLabel(db, targetType, targetId) {
  const def = LINK_TARGETS[targetType]; if (!def) return String(targetId);
  const row = (await db.get(`SELECT ${def.code} AS code, title FROM ${def.table} WHERE id = ?`, [targetId]));
  return row ? `${row.code} ${row.title}` : String(targetId);
}
/** Throws ValidationError when a (table, where) pair already has a row — generic duplicate-link guard. */
export async function ensureNoDuplicate(db, table, where, params, field = 'target_id') {
  if ((await db.get(`SELECT 1 FROM ${table} WHERE ${where}`, [...params]))) throw new ValidationError({ [field]: '이미 연결되어 있습니다.' });
}
