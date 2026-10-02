/**
 * Comments on requirements and WBS items (the "댓글 · 활동" tab).
 * Any workspace member may comment; only the author or a workspace OWNER/ADMIN may delete.
 * The caller has already resolved the project through workspace membership and verified that the entity belongs to it.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';

export const COMMENT_TYPES = ['REQUIREMENT', 'WBS'];
export const COMMENT_MAX = 2000;

export function parseComment(b = {}) {
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!body || body.length > COMMENT_MAX) throw new ValidationError({ body: `댓글을 1~${COMMENT_MAX.toLocaleString('en-US')}자 이내로 입력해 주세요.` });
  return { body };
}

const SHAPE = `c.id, c.body, c.created_by, u.name AS author_name, c.created_at`;

export async function listComments(db, entityType, entityId) {
  return db.all(`SELECT ${SHAPE} FROM comments c LEFT JOIN users u ON u.id = c.created_by
    WHERE c.entity_type = ? AND c.entity_id = ? ORDER BY c.created_at, c.seq`, [entityType, entityId]);
}

export async function addComment(db, project, entityType, entityId, userId, body) {
  const id = randomUUID();
  await db.run('INSERT INTO comments (id, project_id, entity_type, entity_id, body, created_by) VALUES (?,?,?,?,?,?)', [id, project.id, entityType, entityId, body, userId]);
  return db.get(`SELECT ${SHAPE} FROM comments c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`, [id]);
}

export const getComment = async (db, project, entityType, entityId, commentId) =>
  db.get('SELECT * FROM comments WHERE id = ? AND project_id = ? AND entity_type = ? AND entity_id = ?', [commentId, project.id, entityType, entityId]);

export const deleteComment = async (db, commentId) => db.run('DELETE FROM comments WHERE id = ?', [commentId]);
