/** Jira issue JSON → snapshot row (minimum fields only; raw payloads are never stored). */
const CATEGORY = { new: 'new', undefined: 'new', indeterminate: 'indeterminate', done: 'done' };
export function toSnapshot(issue, { siteUrl } = {}) {
  const f = issue.fields || {};
  const cat = f.status?.statusCategory?.key || CATEGORY[String(f.status?.statusCategory?.name || '').toLowerCase()] || null;
  return {
    external_entity_id: String(issue.id), external_key: issue.key,
    summary: String(f.summary || '').slice(0, 500), issue_type: f.issuetype?.name || null,
    status_id: f.status?.id ? String(f.status.id) : null, status_name: f.status?.name || null, status_category: CATEGORY[cat] || (cat === 'done' ? 'done' : cat === 'indeterminate' ? 'indeterminate' : 'new'),
    assignee_account_id: f.assignee?.accountId || null, assignee_name: f.assignee?.displayName || null,
    external_updated_at: f.updated ? new Date(f.updated).toISOString() : null,
    browser_url: browserUrl(siteUrl, issue.key),
  };
}
/** Only https site URLs from accessible-resources + the issue key — never a URL taken from a payload. */
export function browserUrl(siteUrl, key) {
  if (!siteUrl || !key) return null;
  let u; try { u = new URL(siteUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) return null;
  return `${u.origin}/browse/${key}`;
}
export const isDone = (cat) => cat === 'done';
