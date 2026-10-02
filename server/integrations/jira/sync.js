/**
 * Jira ↔ RELAI project/WBS integration logic.
 *   mapping     1 RELAI project ↔ 1 Jira project (+ issue-type choices, auto-complete option)
 *   links       integration_entity_links keyed by wbs_items.id (stable). EXECUTION → leaf TASK, EPIC → group. One live
 *               link per Jira issue per connection (unique index). Milestones never link.
 *   snapshots   jira_issue_snapshots, refreshed by manual / webhook / scheduled sync — the UI never calls Jira to render.
 *   execution   Done(statusCategory) / linked EXECUTION issues; groups aggregate descendant leaves (deduplicated), epics excluded.
 *   auto-complete (opt-in per mapping): leaf TASK with ≥1 EXECUTION link, all Done → WBS COMPLETED/100 via wbs.updateWbs.
 * WBS progress/status are otherwise never touched; wbs.js never imports this file.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../../db.js';
import { ValidationError } from '../../validate.js';
import { updateWbs } from '../../wbs.js';
import { addWbsHistory } from '../../wbs-history.js';
import { integrationConfig } from '../config.js';
import { IntegrationError, withClient, requireActiveConnection, getConnectionById, markError } from '../service.js';
import { logActivity, startRun, finishRun } from '../events.js';
import { toSnapshot, isDone } from './mapper.js';
import { wbsDescription } from './adf.js';
import { JiraApiError } from './client.js';

const LIVE = `status <> 'REMOVED'`;
const esc = (s) => String(s).replace(/["\\]/g, (c) => '\\' + c);

/* ---------- mapping ---------- */
export async function getMapping(db, projectId) {
  return db.get(`SELECT m.*, c.site_url, c.status AS connection_status, c.last_error AS connection_error, c.workspace_id FROM integration_project_mappings m JOIN integration_connections c ON c.id = m.connection_id
    WHERE m.project_id = ? AND m.status = 'ACTIVE'`, [projectId]);
}
/** Mapping screen model. */
export async function projectIntegration(db, project, env = process.env) {
  const cfg = integrationConfig(env);
  const c = await db.get(`SELECT id, status, site_url, last_error, last_synced_at, external_account_name FROM integration_connections WHERE workspace_id = ? AND provider = 'JIRA'`, [project.workspace_id]);
  const m = await getMapping(db, project.id);
  const lastRun = m ? await db.get('SELECT trigger, status, items_total, items_success, items_failed, started_at, finished_at, error_summary FROM integration_sync_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1', [project.id]) : null;
  const counts = m ? await db.get(`SELECT COUNT(*) FILTER (WHERE l.link_role = 'EXECUTION' AND l.${LIVE}) AS execution, COUNT(*) FILTER (WHERE l.link_role = 'EPIC' AND l.${LIVE}) AS epics, COUNT(*) FILTER (WHERE l.status = 'MISSING') AS missing FROM integration_entity_links l WHERE l.project_id = ?`, [project.id]) : { execution: 0, epics: 0, missing: 0 };
  const removed = !m ? await db.get(`SELECT external_project_key, removed_at FROM integration_project_mappings WHERE project_id = ? AND status = 'REMOVED' ORDER BY removed_at DESC LIMIT 1`, [project.id]) : null;
  return {
    configured: cfg.jira.configured || cfg.provider === 'fake',
    connection: c ? { id: c.id, status: c.status, site_url: c.site_url, last_error: c.last_error, last_synced_at: c.last_synced_at, account_name: c.external_account_name, reconnect_required: c.status === 'ERROR' && /재연결/.test(c.last_error || '') } : null,
    mapping: m ? { id: m.id, external_project_id: m.external_project_id, external_project_key: m.external_project_key, external_project_name: m.external_project_name, leaf_issue_type_id: m.leaf_issue_type_id, leaf_issue_type_name: m.leaf_issue_type_name, group_issue_type_id: m.group_issue_type_id, group_issue_type_name: m.group_issue_type_name, auto_complete_leaf_wbs: m.auto_complete_leaf_wbs, created_at: m.created_at, updated_at: m.updated_at } : null,
    previous_mapping: removed || null, last_run: lastRun, counts, summary: m ? await projectExecutionSummary(db, project.id) : null,
  };
}

export async function listJiraProjects(db, project, query = '', env = process.env) {
  const c = await requireActiveConnection(db, project.workspace_id);
  return withClient(db, c.id, async (jira) => { const r = await jira.searchProjects({ query }); return (r.values || []).map((p) => ({ id: String(p.id), key: p.key, name: p.name })); }, env);
}
export async function listIssueTypes(db, project, projectKey, env = process.env) {
  const c = await requireActiveConnection(db, project.workspace_id);
  return withClient(db, c.id, async (jira) => { const r = await jira.issueTypesForProject(projectKey); return (r.issueTypes || []).filter((t) => !t.subtask).map((t) => ({ id: String(t.id), name: t.name, description: t.description || '' })); }, env);
}

export async function saveMapping(db, project, body = {}, userId, env = process.env) {
  const c = await requireActiveConnection(db, project.workspace_id);
  const key = String(body.external_project_key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(key)) throw new ValidationError({ external_project_key: 'Jira 프로젝트 키를 확인해 주세요.' });
  const leafId = body.leaf_issue_type_id ? String(body.leaf_issue_type_id) : null; const groupId = body.group_issue_type_id ? String(body.group_issue_type_id) : null;
  // validate against Jira (project exists, issue types creatable there)
  const { jp, types } = await withClient(db, c.id, async (jira) => {
    let jp; try { jp = await jira.getProject(key); } catch (e) { if (e instanceof JiraApiError && e.status === 404) throw new ValidationError({ external_project_key: `Jira 프로젝트 '${key}'을(를) 찾을 수 없거나 접근 권한이 없습니다.` }); throw e; }
    const t = await jira.issueTypesForProject(key);
    return { jp, types: (t.issueTypes || []).filter((x) => !x.subtask) };
  }, env);
  const leaf = leafId ? types.find((t) => String(t.id) === leafId) : null; const group = groupId ? types.find((t) => String(t.id) === groupId) : null;
  if (leafId && !leaf) throw new ValidationError({ leaf_issue_type_id: '선택한 Issue Type을 이 Jira 프로젝트에서 생성할 수 없습니다.' });
  if (groupId && !group) throw new ValidationError({ group_issue_type_id: '선택한 Issue Type을 이 Jira 프로젝트에서 생성할 수 없습니다.' });
  const auto = Boolean(body.auto_complete_leaf_wbs);
  return tx(db, async (db) => {
    const cur = await db.get(`SELECT * FROM integration_project_mappings WHERE project_id = ? AND status = 'ACTIVE' FOR UPDATE`, [project.id]);
    const vals = [c.id, String(jp.id), jp.key, jp.name || '', leaf ? String(leaf.id) : null, leaf ? leaf.name : null, group ? String(group.id) : null, group ? group.name : null, auto];
    let id;
    if (cur) {
      id = cur.id;
      if (cur.external_project_id !== String(jp.id)) { // project change → old links no longer belong to the mapped project; keep them as history (REMOVED) rather than deleting
        await db.run(`UPDATE integration_entity_links SET status = 'REMOVED', removed_at = now(), updated_at = now() WHERE project_id = ? AND ${LIVE}`, [project.id]);
      }
      await db.run('UPDATE integration_project_mappings SET connection_id = ?, external_project_id = ?, external_project_key = ?, external_project_name = ?, leaf_issue_type_id = ?, leaf_issue_type_name = ?, group_issue_type_id = ?, group_issue_type_name = ?, auto_complete_leaf_wbs = ?, updated_at = now() WHERE id = ?', [...vals, id]);
    } else {
      id = randomUUID();
      await db.run('INSERT INTO integration_project_mappings (id, project_id, connection_id, external_project_id, external_project_key, external_project_name, leaf_issue_type_id, leaf_issue_type_name, group_issue_type_id, group_issue_type_name, auto_complete_leaf_wbs, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, project.id, ...vals, userId]);
    }
    if (!cur || cur.external_project_id !== String(jp.id)) await logActivity(db, { projectId: project.id, action: 'PROJECT_MAPPED', summary: `Jira 프로젝트 ${jp.key} — ${jp.name}을(를) 연결했습니다.`, actorId: userId });
    return id;
  }).then(async (id) => { try { await ensureWebhook(db, project, id, env); } catch (e) { /* webhook is best-effort; scheduled sync covers it */ console.warn('[jira] webhook registration failed:', e.message); } return projectIntegration(db, project, env); });
}

export async function removeMapping(db, project, userId, env = process.env) {
  const m = await getMapping(db, project.id);
  if (!m) throw new IntegrationError(404, 'not_found', '연결된 Jira 프로젝트가 없습니다.');
  await tx(db, async (db) => {
    await db.run(`UPDATE integration_project_mappings SET status = 'REMOVED', removed_at = now(), updated_at = now() WHERE id = ?`, [m.id]);
    await db.run(`UPDATE integration_webhooks SET status = 'DELETED', updated_at = now() WHERE project_mapping_id = ? AND status = 'ACTIVE'`, [m.id]);
    await logActivity(db, { projectId: project.id, action: 'PROJECT_UNMAPPED', summary: `Jira 프로젝트 ${m.external_project_key} 연결을 해제했습니다. 기존 Jira 연결 기록은 유지되며 동기화는 중단됩니다.`, actorId: userId });
  });
  const hooks = await db.all(`SELECT external_webhook_id FROM integration_webhooks WHERE project_mapping_id = ?`, [m.id]);
  if (hooks.length) { try { await withClient(db, m.connection_id, (jira) => jira.deleteWebhooks(hooks.map((h) => Number(h.external_webhook_id))), env); } catch { /* best effort */ } }
  return projectIntegration(db, project, env);
}

/* ---------- WBS rules ---------- */
async function wbsNode(db, project, wbsId) {
  const w = await db.get(`SELECT w.*, (SELECT COUNT(*) FROM wbs_items c WHERE c.parent_id = w.id AND c.archived_at IS NULL) AS children_count FROM wbs_items w WHERE w.id = ? AND w.project_id = ?`, [wbsId, project.id]);
  if (!w) throw new IntegrationError(404, 'not_found', 'WBS 항목을 찾을 수 없습니다.');
  return { ...w, is_group: Number(w.children_count) > 0 };
}
function assertRole(w, role) {
  if (w.archived_at) throw new ValidationError({ wbs_item_id: '보관된 WBS 항목에는 연결할 수 없습니다.' });
  if (w.item_type === 'MILESTONE') throw new ValidationError({ wbs_item_id: '마일스톤에는 Jira Issue를 연결하지 않습니다. 실제 실행 작업(Leaf Task)에 연결하세요.' });
  if (role === 'EXECUTION' && w.is_group) throw new ValidationError({ wbs_item_id: '하위 작업이 있는 항목(Group)에는 실행 Issue를 직접 연결하지 않습니다. 하위 Leaf 작업에 연결하거나 Group을 Jira Epic과 연결하세요.' });
  if (role === 'EPIC' && !w.is_group) throw new ValidationError({ wbs_item_id: 'Epic 연결은 하위 작업이 있는 Group 항목에만 할 수 있습니다.' });
}
async function requireMapping(db, project) {
  const m = await getMapping(db, project.id);
  if (!m) throw new IntegrationError(409, 'jira_not_mapped', '이 프로젝트에 연결된 Jira 프로젝트가 없습니다. 헤더 ⋯ → Jira 연동 설정에서 먼저 연결하세요.');
  if (m.connection_status === 'DISABLED') throw new IntegrationError(409, 'integration_disabled', 'Workspace의 Jira 연동이 해제되어 있습니다.');
  return m;
}

/* ---------- links ---------- */
export async function linksForWbs(db, wbsId) {
  return db.all(`SELECT l.id, l.external_entity_id, l.external_key, l.link_role, l.status, l.created_at, l.last_synced_at, u.name AS created_by_name,
      s.summary, s.issue_type, s.status_name, s.status_category, s.assignee_name, s.external_updated_at, s.browser_url, s.synced_at
    FROM integration_entity_links l LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id LEFT JOIN users u ON u.id = l.created_by
    WHERE l.wbs_item_id = ? AND l.${LIVE} ORDER BY l.link_role, l.created_at`, [wbsId]);
}

async function upsertSnapshot(db, linkId, snap) {
  await db.run(`INSERT INTO jira_issue_snapshots (integration_link_id, external_key, summary, issue_type, status_id, status_name, status_category, assignee_account_id, assignee_name, external_updated_at, browser_url, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,now()) ON CONFLICT (integration_link_id) DO UPDATE SET external_key = EXCLUDED.external_key, summary = EXCLUDED.summary, issue_type = EXCLUDED.issue_type, status_id = EXCLUDED.status_id, status_name = EXCLUDED.status_name,
      status_category = EXCLUDED.status_category, assignee_account_id = EXCLUDED.assignee_account_id, assignee_name = EXCLUDED.assignee_name, external_updated_at = EXCLUDED.external_updated_at, browser_url = EXCLUDED.browser_url, synced_at = now()`,
    [linkId, snap.external_key, snap.summary, snap.issue_type, snap.status_id, snap.status_name, snap.status_category, snap.assignee_account_id, snap.assignee_name, snap.external_updated_at, snap.browser_url]);
  await db.run(`UPDATE integration_entity_links SET status = 'ACTIVE', last_synced_at = now(), updated_at = now() WHERE id = ?`, [linkId]);
}

/** Inserts a link + snapshot inside the caller's tx. Throws ValidationError when the issue is already linked elsewhere. */
async function insertLink(db, { m, project, w, issue, role, userId }) {
  const snap = toSnapshot(issue, { siteUrl: m.site_url });
  const dup = await db.get(`SELECT l.id, l.wbs_item_id, x.wbs_code, x.title FROM integration_entity_links l JOIN wbs_items x ON x.id = l.wbs_item_id WHERE l.connection_id = ? AND l.external_entity_id = ? AND l.${LIVE}`, [m.connection_id, snap.external_entity_id]);
  if (dup) {
    if (dup.wbs_item_id === w.id) throw new ValidationError({ issue_key: `${snap.external_key}은(는) 이미 이 항목에 연결되어 있습니다.` });
    throw new ValidationError({ issue_key: `${snap.external_key}은(는) 이미 WBS ${dup.wbs_code} ${dup.title}에 연결되어 있습니다. 하나의 Jira Issue는 하나의 WBS에만 연결할 수 있습니다.`, linked_wbs: { id: dup.wbs_item_id, wbs_code: dup.wbs_code, title: dup.title } });
  }
  if (issue.fields?.project && String(issue.fields.project.id) !== String(m.external_project_id) && issue.fields.project.key !== m.external_project_key) throw new ValidationError({ issue_key: `${snap.external_key}은(는) 연결된 Jira 프로젝트(${m.external_project_key})의 Issue가 아닙니다.` });
  const id = randomUUID();
  await db.run('INSERT INTO integration_entity_links (id, connection_id, project_id, wbs_item_id, external_entity_type, external_entity_id, external_key, link_role, created_by) VALUES (?,?,?,?,?,?,?,?,?)', [id, m.connection_id, project.id, w.id, 'ISSUE', snap.external_entity_id, snap.external_key, role, userId]);
  await upsertSnapshot(db, id, snap);
  await addWbsHistory(db, w.id, 'JIRA_LINKED', { field: 'jira', newValue: `${snap.external_key} ${snap.summary}`.trim() }, userId);
  return { id, snap };
}

/** Link existing issues (keys) to a WBS item. Role EXECUTION for leaves, EPIC for groups (explicit). Returns per-key results. */
export async function linkIssues(db, project, wbsId, { issue_keys = [], link_role = 'EXECUTION' } = {}, userId, env = process.env) {
  const m = await requireMapping(db, project);
  const w = await wbsNode(db, project, wbsId);
  const role = link_role === 'EPIC' ? 'EPIC' : 'EXECUTION';
  assertRole(w, role);
  const keys = [...new Set((Array.isArray(issue_keys) ? issue_keys : [issue_keys]).map((k) => String(k || '').trim().toUpperCase()).filter(Boolean))];
  if (!keys.length) throw new ValidationError({ issue_keys: '연결할 Jira Issue를 선택하세요.' });
  if (keys.length > 50) throw new ValidationError({ issue_keys: '한 번에 50개까지 연결할 수 있습니다.' });
  const issues = await withClient(db, m.connection_id, async (jira) => {
    const out = [];
    for (const k of keys) { try { out.push({ key: k, issue: await jira.getIssue(k) }); } catch (e) { if (e instanceof JiraApiError && (e.status === 404 || e.status === 403)) out.push({ key: k, error: 'Jira에서 Issue를 찾을 수 없습니다.' }); else throw e; } }
    return out;
  }, env);
  const results = [];
  for (const r of issues) {
    if (r.error) { results.push({ key: r.key, ok: false, error: r.error }); continue; }
    try { const { id, snap } = await tx(db, (db) => insertLink(db, { m, project, w, issue: r.issue, role, userId })); results.push({ key: snap.external_key, ok: true, link_id: id }); }
    catch (e) { if (e instanceof ValidationError) results.push({ key: r.key, ok: false, error: Object.values(e.fields)[0], linked_wbs: e.fields.linked_wbs || null }); else throw e; }
  }
  const okCount = results.filter((x) => x.ok).length;
  if (okCount) await logActivity(db, { projectId: project.id, action: 'ISSUE_LINKED', summary: `${w.wbs_code} ${w.title}에 Jira ${results.filter((x) => x.ok).map((x) => x.key).join(', ')}을(를) ${role === 'EPIC' ? 'Epic으로 ' : ''}연결했습니다.`, wbsItemId: w.id, actorId: userId });
  if (okCount && role === 'EXECUTION') await maybeAutoComplete(db, project, m, w.id, userId);
  return { results, links: await linksForWbs(db, w.id), summary: await executionForWbs(db, project.id, w.id) };
}

/** Create a Jira issue from a leaf WBS item (summary defaults to "[code] title"; description is ADF). Checks create metadata first. */
export async function createIssueForWbs(db, project, wbsId, body = {}, userId, env = process.env) {
  const cfg = integrationConfig(env);
  const m = await requireMapping(db, project);
  const w = await wbsNode(db, project, wbsId);
  assertRole(w, 'EXECUTION');
  const typeId = String(body.issue_type_id || m.leaf_issue_type_id || '');
  if (!typeId) throw new ValidationError({ issue_type_id: 'Jira 연동 설정에서 Leaf 작업의 Issue Type을 먼저 지정하세요.' });
  const summary = String(body.summary || `[${w.wbs_code}] ${w.title}`).trim().slice(0, 255);
  if (!summary) throw new ValidationError({ summary: 'Summary를 입력하세요.' });
  const reqs = await db.all(`SELECT r.display_id, r.title FROM requirement_wbs_links l JOIN requirements r ON r.id = l.requirement_id WHERE l.wbs_item_id = ? AND r.archived_at IS NULL ORDER BY r.sequence_number`, [w.id]);
  const projectUrl = cfg.jira.appBaseUrl ? `${cfg.jira.appBaseUrl}/app/projects/${project.id}/wbs?sel=${w.id}` : null;
  const description = wbsDescription({ wbsCode: w.wbs_code, title: w.title, description: body.description !== undefined ? String(body.description) : w.description, reqs, projectUrl, projectName: project.name });
  const issue = await withClient(db, m.connection_id, async (jira) => {
    const meta = await jira.createFieldsFor(m.external_project_key, typeId);
    const supported = new Set(['summary', 'issuetype', 'project', 'description', 'reporter', 'labels', 'priority']);
    const required = (meta.fields || []).filter((f) => f.required && !supported.has(f.fieldId || f.key) && !f.hasDefaultValue);
    if (required.length) throw new IntegrationError(409, 'jira_required_fields', `현재 Jira 프로젝트는 추가 필수 필드가 필요합니다: ${required.map((f) => f.name).join(', ')}. Jira에서 필드 설정을 조정하거나 Jira에서 Issue를 만든 뒤 '기존 Jira Issue 연결'을 사용하세요.`, { required_fields: required.map((f) => ({ id: f.fieldId || f.key, name: f.name })) });
    const created = await jira.createIssue({ project: { id: String(m.external_project_id), key: m.external_project_key }, issuetype: { id: typeId }, summary, description });
    return jira.getIssue(created.key);
  }, env);
  const { id, snap } = await tx(db, (db) => insertLink(db, { m, project, w, issue, role: 'EXECUTION', userId }));
  await logActivity(db, { projectId: project.id, action: 'ISSUE_CREATED', summary: `${w.wbs_code} ${w.title}에서 Jira ${snap.external_key}을(를) 생성했습니다.`, wbsItemId: w.id, actorId: userId });
  return { link_id: id, issue: snap, links: await linksForWbs(db, w.id), summary: await executionForWbs(db, project.id, w.id) };
}

export async function unlinkIssue(db, project, wbsId, linkId, userId) {
  const l = await db.get(`SELECT l.*, w.wbs_code, w.title FROM integration_entity_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.id = ? AND l.project_id = ? AND l.wbs_item_id = ? AND l.${LIVE}`, [linkId, project.id, wbsId]);
  if (!l) throw new IntegrationError(404, 'not_found', 'Jira 연결을 찾을 수 없습니다.');
  await tx(db, async (db) => {
    await db.run(`UPDATE integration_entity_links SET status = 'REMOVED', removed_at = now(), updated_at = now() WHERE id = ?`, [l.id]);
    await addWbsHistory(db, l.wbs_item_id, 'JIRA_UNLINKED', { field: 'jira', oldValue: l.external_key }, userId);
    await logActivity(db, { projectId: project.id, action: 'ISSUE_UNLINKED', summary: `${l.wbs_code} ${l.title}에서 Jira ${l.external_key} 연결을 해제했습니다. (Jira Issue는 삭제되지 않습니다)`, wbsItemId: l.wbs_item_id, actorId: userId });
  });
  return { links: await linksForWbs(db, wbsId), summary: await executionForWbs(db, project.id, wbsId) };
}

/** Search issues of the mapped Jira project by key or text; marks issues already linked (and where). */
export async function searchIssues(db, project, q = '', env = process.env) {
  const m = await requireMapping(db, project);
  const term = String(q || '').trim().slice(0, 100);
  const jql = /^[A-Z][A-Z0-9_]*-\d+$/i.test(term) ? `project = "${esc(m.external_project_key)}" AND key = "${term.toUpperCase()}"` : term ? `project = "${esc(m.external_project_key)}" AND text ~ "${esc(term)}*" ORDER BY updated DESC` : `project = "${esc(m.external_project_key)}" ORDER BY updated DESC`;
  const r = await withClient(db, m.connection_id, (jira) => jira.searchIssues({ jql, maxResults: 30 }), env);
  const issues = (r.issues || []).map((i) => toSnapshot(i, { siteUrl: m.site_url }));
  const linked = issues.length ? await db.all(`SELECT l.external_entity_id, w.id AS wbs_item_id, w.wbs_code, w.title FROM integration_entity_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.connection_id = ? AND l.${LIVE} AND l.external_entity_id = ANY(?::text[])`, [m.connection_id, issues.map((i) => i.external_entity_id)]) : [];
  const by = new Map(linked.map((x) => [x.external_entity_id, x]));
  return { issues: issues.map((i) => ({ ...i, linked_wbs: by.get(i.external_entity_id) || null })) };
}

/* ---------- execution aggregation (snapshots only; no Jira calls) ---------- */
/** Direct EXECUTION links per WBS id of a project: Map(wbsId → { total, done, in_progress, todo, missing }). */
async function directExecution(db, projectId) {
  const rows = await db.all(`SELECT l.wbs_item_id, l.status AS link_status, s.status_category FROM integration_entity_links l LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id
    WHERE l.project_id = ? AND l.link_role = 'EXECUTION' AND l.${LIVE}`, [projectId]);
  const m = new Map();
  for (const r of rows) {
    const o = m.get(r.wbs_item_id) || { total: 0, done: 0, in_progress: 0, todo: 0, missing: 0 }; m.set(r.wbs_item_id, o);
    o.total++; if (r.link_status !== 'ACTIVE') o.missing++;
    if (isDone(r.status_category)) o.done++; else if (r.status_category === 'indeterminate') o.in_progress++; else o.todo++;
  }
  return m;
}
const rate = (o) => ({ ...o, rate: o.total ? Math.round((o.done / o.total) * 100) : null });
/** Per-WBS execution for the whole live tree: leaves = direct links, groups = union of descendant leaves (dedup by construction: one issue → one WBS). */
export async function executionByWbs(db, projectId) {
  const direct = await directExecution(db, projectId);
  if (!direct.size) return { map: new Map(), total: 0 };
  const items = await db.all('SELECT id, parent_id FROM wbs_items WHERE project_id = ? AND archived_at IS NULL', [projectId]);
  const acc = new Map(items.map((i) => [i.id, { total: 0, done: 0, in_progress: 0, todo: 0, missing: 0 }]));
  const parent = new Map(items.map((i) => [i.id, i.parent_id]));
  for (const [wid, o] of direct) { let cur = wid; while (cur && acc.has(cur)) { const a = acc.get(cur); for (const k of Object.keys(o)) a[k] += o[k]; cur = parent.get(cur); } }
  const map = new Map(); let total = 0;
  for (const [id, o] of acc) if (o.total) map.set(id, rate(o));
  for (const o of direct.values()) total += o.total;
  return { map, total };
}
export async function executionForWbs(db, projectId, wbsId) { const { map } = await executionByWbs(db, projectId); return map.get(wbsId) || rate({ total: 0, done: 0, in_progress: 0, todo: 0, missing: 0 }); }
/** Project-level: every live EXECUTION link once. */
export async function projectExecutionSummary(db, projectId) {
  const r = await db.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE s.status_category = 'done') AS done, COUNT(*) FILTER (WHERE s.status_category = 'indeterminate') AS in_progress,
      COUNT(*) FILTER (WHERE s.status_category IS NULL OR s.status_category = 'new') AS todo, COUNT(*) FILTER (WHERE l.status <> 'ACTIVE') AS missing,
      COUNT(DISTINCT l.wbs_item_id) AS linked_wbs
    FROM integration_entity_links l LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id WHERE l.project_id = ? AND l.link_role = 'EXECUTION' AND l.${LIVE}`, [projectId]);
  return rate({ total: Number(r.total), done: Number(r.done), in_progress: Number(r.in_progress), todo: Number(r.todo), missing: Number(r.missing), linked_wbs: Number(r.linked_wbs) });
}
/** Project home: null when unmapped, else the execution summary + project key (one small card line). */
export async function homeSummary(db, projectId) {
  const m = await db.get(`SELECT m.external_project_key, c.site_url, c.status FROM integration_project_mappings m JOIN integration_connections c ON c.id = m.connection_id WHERE m.project_id = ? AND m.status = 'ACTIVE'`, [projectId]);
  if (!m) return null;
  return { project_key: m.external_project_key, site_url: m.site_url, connection_status: m.status, ...(await projectExecutionSummary(db, projectId)) };
}
/** For the WBS list response: { enabled, by: { wbsId: summary } } or null when the project is not mapped. Cheap (2 queries). */
export async function wbsExecutionMap(db, projectId) {
  const m = await db.get(`SELECT 1 FROM integration_project_mappings WHERE project_id = ? AND status = 'ACTIVE'`, [projectId]);
  if (!m) return null;
  const { map } = await executionByWbs(db, projectId);
  return { enabled: true, by: Object.fromEntries(map) };
}
/** Requirement trace: Jira execution of each WBS linked to the requirement (direct or descendant leaves) + a total. Read-only; no requirement↔Jira table. */
export async function executionForRequirement(db, projectId, requirementId) {
  const links = await db.all(`SELECT w.id, w.wbs_code, w.title FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = ? AND w.archived_at IS NULL ORDER BY w.sequence`, [requirementId]);
  const { map } = await executionByWbs(db, projectId);
  const per = links.map((w) => ({ ...w, jira: map.get(w.id) || null }));
  // dedupe at requirement level: count distinct issues across the linked WBS subtrees
  const ids = links.map((w) => w.id);
  const tot = ids.length ? await db.get(`WITH RECURSIVE sub AS (SELECT id FROM wbs_items WHERE id = ANY(?::text[]) UNION SELECT c.id FROM wbs_items c JOIN sub ON c.parent_id = sub.id WHERE c.archived_at IS NULL)
    SELECT COUNT(DISTINCT l.external_entity_id) AS total, COUNT(DISTINCT l.external_entity_id) FILTER (WHERE s.status_category = 'done') AS done, COUNT(DISTINCT l.external_entity_id) FILTER (WHERE s.status_category = 'indeterminate') AS in_progress
    FROM integration_entity_links l LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id WHERE l.wbs_item_id IN (SELECT id FROM sub) AND l.link_role = 'EXECUTION' AND l.${LIVE}`, [ids]) : { total: 0, done: 0, in_progress: 0 };
  const total = Number(tot.total); const done = Number(tot.done); const inp = Number(tot.in_progress);
  return { wbs: per, total, done, in_progress: inp, todo: total - done - inp, rate: total ? Math.round((done / total) * 100) : null };
}

/* ---------- auto complete ---------- */
/** Leaf TASK + ≥1 EXECUTION link + all Done → COMPLETED/100 through the regular WBS update (history gets source=jira_sync). Groups are skipped. */
export async function maybeAutoComplete(db, project, mapping, wbsId, userId = null) {
  if (!mapping.auto_complete_leaf_wbs) return false;
  const w = await db.get(`SELECT w.*, (SELECT COUNT(*) FROM wbs_items c WHERE c.parent_id = w.id AND c.archived_at IS NULL) AS children_count FROM wbs_items w WHERE w.id = ?`, [wbsId]);
  if (!w || w.archived_at || w.item_type !== 'TASK' || Number(w.children_count) > 0) return false;
  const st = await db.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE s.status_category = 'done') AS done FROM integration_entity_links l LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id WHERE l.wbs_item_id = ? AND l.link_role = 'EXECUTION' AND l.status = 'ACTIVE'`, [wbsId]);
  if (!Number(st.total) || Number(st.total) !== Number(st.done)) return false;
  if (w.status === 'COMPLETED' && w.progress === 100) return false;
  await tx(db, async (db) => {
    await updateWbs(db, project, w, { status: 'COMPLETED', progress: 100 }, userId);
    await addWbsHistory(db, w.id, 'JIRA_AUTO_COMPLETED', { field: 'source', newValue: 'jira_sync' }, userId);
    await logActivity(db, { projectId: project.id, action: 'AUTO_COMPLETED', summary: `${w.wbs_code} ${w.title}: 연결된 Jira 작업이 모두 Done이어서 완료 처리했습니다.`, wbsItemId: w.id, actorId: userId });
  });
  return true;
}

/* ---------- sync ---------- */
/** Refreshes snapshots of the mapped project's live links (not archived WBS). Returns the run summary. */
export async function syncProject(db, project, { trigger = 'MANUAL', wbsId = null, userId = null } = {}, env = process.env) {
  const m = await requireMapping(db, project);
  const runId = await startRun(db, { connectionId: m.connection_id, projectId: project.id, trigger });
  const links = await db.all(`SELECT l.id, l.external_entity_id, l.external_key, l.wbs_item_id, l.link_role FROM integration_entity_links l JOIN wbs_items w ON w.id = l.wbs_item_id
    WHERE l.project_id = ? AND l.${LIVE} AND w.archived_at IS NULL ${wbsId ? 'AND l.wbs_item_id = ?' : ''} ORDER BY l.created_at`, wbsId ? [project.id, wbsId] : [project.id]);
  let success = 0; let failed = 0; let error = null; const touched = new Set();
  try {
    for (let i = 0; i < links.length; i += 50) {
      const batch = links.slice(i, i + 50);
      const found = await withClient(db, m.connection_id, async (jira) => { const r = await jira.searchIssues({ jql: `id in (${batch.map((l) => l.external_entity_id).join(',')})`, maxResults: 50 }); return r.issues || []; }, env);
      const byId = new Map(found.map((i) => [String(i.id), i]));
      for (const l of batch) {
        const issue = byId.get(String(l.external_entity_id));
        if (issue) { await upsertSnapshot(db, l.id, toSnapshot(issue, { siteUrl: m.site_url })); success++; }
        else { await db.run(`UPDATE integration_entity_links SET status = 'MISSING', last_synced_at = now(), updated_at = now() WHERE id = ?`, [l.id]); failed++; }
        if (l.link_role === 'EXECUTION') touched.add(l.wbs_item_id);
      }
    }
    for (const id of touched) await maybeAutoComplete(db, project, m, id, userId);
    await db.run('UPDATE integration_connections SET last_synced_at = now(), updated_at = now() WHERE id = ?', [m.connection_id]);
  } catch (e) {
    error = e.message; failed = links.length - success;
    if (e.code === 'reconnect_required') await markError(db, m.connection_id, e.message);
    await logActivity(db, { projectId: project.id, action: 'SYNC_FAILED', summary: `Jira 동기화 실패: ${e.message}`, actorId: userId });
  }
  const status = await finishRun(db, runId, { total: links.length, success, failed, error });
  return { run_id: runId, status, items_total: links.length, items_success: success, items_failed: failed, error_summary: error };
}

/** Webhook payload → one link refresh. Returns 'updated' | 'missing' | 'ignored'. */
export async function applyIssueEvent(db, connection, { eventType, issueId, issueKey }, env = process.env) {
  const link = await db.get(`SELECT l.* FROM integration_entity_links l JOIN wbs_items w ON w.id = l.wbs_item_id AND w.archived_at IS NULL
    WHERE l.connection_id = ? AND l.${LIVE} AND (l.external_entity_id = ? OR l.external_key = ?) LIMIT 1`, [connection.id, String(issueId || ''), String(issueKey || '')]);
  if (!link) return 'ignored';
  const mp = await db.get(`SELECT m.auto_complete_leaf_wbs, c.site_url FROM integration_project_mappings m JOIN integration_connections c ON c.id = m.connection_id WHERE m.project_id = ? AND m.status = 'ACTIVE' AND m.connection_id = ?`, [link.project_id, connection.id]);
  if (!mp) return 'ignored';
  link.auto_complete_leaf_wbs = mp.auto_complete_leaf_wbs; link.site_url = mp.site_url;
  const pr = await db.get('SELECT id, workspace_id, name, status FROM projects WHERE id = ?', [link.project_id]);
  const project = pr;
  if (eventType === 'jira:issue_deleted') { await db.run(`UPDATE integration_entity_links SET status = 'MISSING', last_synced_at = now(), updated_at = now() WHERE id = ?`, [link.id]); return 'missing'; }
  const runId = await startRun(db, { connectionId: connection.id, projectId: project.id, trigger: 'WEBHOOK' });
  try {
    const issue = await withClient(db, connection.id, async (jira) => { try { return await jira.getIssue(link.external_entity_id); } catch (e) { if (e instanceof JiraApiError && e.status === 404) return null; throw e; } }, env);
    if (!issue) { await db.run(`UPDATE integration_entity_links SET status = 'MISSING', last_synced_at = now(), updated_at = now() WHERE id = ?`, [link.id]); await finishRun(db, runId, { total: 1, success: 0, failed: 1 }); return 'missing'; }
    await upsertSnapshot(db, link.id, toSnapshot(issue, { siteUrl: link.site_url }));
    if (link.link_role === 'EXECUTION') await maybeAutoComplete(db, project, { auto_complete_leaf_wbs: link.auto_complete_leaf_wbs }, link.wbs_item_id, null);
    await db.run('UPDATE integration_connections SET last_synced_at = now(), updated_at = now() WHERE id = ?', [connection.id]);
    await finishRun(db, runId, { total: 1, success: 1, failed: 0 });
    return 'updated';
  } catch (e) { await finishRun(db, runId, { total: 1, success: 0, failed: 1, error: e.message }); throw e; }
}

/* ---------- scheduled reconciliation (cron entry point; also runnable in-process) ---------- */
export async function syncAllDue(db, { olderThanMinutes = 15, limit = 50 } = {}, env = process.env) {
  const rows = await db.all(`SELECT p.*, m.id AS mapping_id FROM integration_project_mappings m JOIN integration_connections c ON c.id = m.connection_id JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'ACTIVE' AND c.status = 'ACTIVE' AND p.status <> 'ARCHIVED' AND (c.last_synced_at IS NULL OR c.last_synced_at < now() - (? || ' minutes')::interval) ORDER BY c.last_synced_at NULLS FIRST LIMIT ?`, [String(olderThanMinutes), limit]);
  const out = [];
  for (const p of rows) { try { out.push({ project_id: p.id, ...(await syncProject(db, p, { trigger: 'SCHEDULED' }, env)) }); } catch (e) { out.push({ project_id: p.id, status: 'FAILED', error_summary: e.message }); } }
  return out;
}

/* ---------- webhooks (dynamic, per mapping; 30-day expiry → renew) ---------- */
export function webhookUrl(cfg, connection) { return cfg.jira.appBaseUrl && connection.webhook_secret ? `${cfg.jira.appBaseUrl}/api/integrations/jira/webhook/${connection.id}/${connection.webhook_secret}` : null; }
export async function ensureWebhook(db, project, mappingId, env = process.env) {
  const cfg = integrationConfig(env);
  const m = await db.get('SELECT * FROM integration_project_mappings WHERE id = ?', [mappingId]); if (!m) return null;
  const conn = await getConnectionById(db, m.connection_id);
  const url = webhookUrl(cfg, conn); if (!url) return null;
  const existing = await db.get(`SELECT * FROM integration_webhooks WHERE project_mapping_id = ? AND status = 'ACTIVE'`, [mappingId]);
  if (existing) return existing;
  const jql = `project = "${esc(m.external_project_key)}"`;
  const r = await withClient(db, conn.id, (jira) => jira.registerWebhooks(url, [{ jqlFilter: jql, events: cfg.jira.webhookEvents }]), env);
  const res = (r.webhookRegistrationResult || [])[0];
  if (!res || !res.createdWebhookId) { await db.run('INSERT INTO integration_webhooks (id, connection_id, project_mapping_id, external_webhook_id, jql, events, status) VALUES (?,?,?,?,?,?,?)', [randomUUID(), conn.id, mappingId, '0', jql, cfg.jira.webhookEvents.join(','), 'ERROR']); return null; }
  const exp = new Date(Date.now() + 30 * 864e5).toISOString();
  await db.run('INSERT INTO integration_webhooks (id, connection_id, project_mapping_id, external_webhook_id, jql, events, expires_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), conn.id, mappingId, String(res.createdWebhookId), jql, cfg.jira.webhookEvents.join(','), exp]);
  return db.get(`SELECT * FROM integration_webhooks WHERE project_mapping_id = ? AND status = 'ACTIVE'`, [mappingId]);
}
/** Renews webhooks expiring within `webhookRenewBeforeDays`; re-registers ones that already expired. Cron entry point. */
export async function renewWebhooks(db, env = process.env) {
  const cfg = integrationConfig(env);
  const due = await db.all(`SELECT w.*, c.status AS cstatus FROM integration_webhooks w JOIN integration_connections c ON c.id = w.connection_id JOIN integration_project_mappings m ON m.id = w.project_mapping_id
    WHERE w.status = 'ACTIVE' AND c.status = 'ACTIVE' AND m.status = 'ACTIVE' AND (w.expires_at IS NULL OR w.expires_at < now() + (? || ' days')::interval)`, [String(cfg.jira.webhookRenewBeforeDays)]);
  const out = [];
  for (const w of due) {
    try {
      if (w.expires_at && new Date(w.expires_at) < new Date()) { await db.run(`UPDATE integration_webhooks SET status = 'EXPIRED', updated_at = now() WHERE id = ?`, [w.id]); try { await withClient(db, w.connection_id, (jira) => jira.deleteWebhooks([Number(w.external_webhook_id)]), env); } catch { /* already gone */ } const p = await db.get('SELECT p.* FROM projects p JOIN integration_project_mappings m ON m.project_id = p.id WHERE m.id = ?', [w.project_mapping_id]); await ensureWebhook(db, p, w.project_mapping_id, env); out.push({ id: w.id, action: 'reregistered' }); continue; }
      const r = await withClient(db, w.connection_id, (jira) => jira.refreshWebhooks([Number(w.external_webhook_id)]), env);
      await db.run('UPDATE integration_webhooks SET expires_at = ?, updated_at = now() WHERE id = ?', [r.expirationDate ? new Date(r.expirationDate).toISOString() : new Date(Date.now() + 30 * 864e5).toISOString(), w.id]);
      out.push({ id: w.id, action: 'refreshed' });
    } catch (e) { await db.run(`UPDATE integration_webhooks SET status = 'ERROR', updated_at = now() WHERE id = ?`, [w.id]); out.push({ id: w.id, action: 'error', error: e.message }); }
  }
  return out;
}

/* ---------- AI context helper (DB only) ---------- */
export async function jiraContextLines(db, projectId, limit = 40) {
  const m = await db.get(`SELECT external_project_key FROM integration_project_mappings WHERE project_id = ? AND status = 'ACTIVE'`, [projectId]);
  if (!m) return null;
  const sum = await projectExecutionSummary(db, projectId);
  const rows = await db.all(`SELECT w.wbs_code, w.title, w.progress, COUNT(*) AS total, COUNT(*) FILTER (WHERE s.status_category = 'done') AS done FROM integration_entity_links l JOIN wbs_items w ON w.id = l.wbs_item_id LEFT JOIN jira_issue_snapshots s ON s.integration_link_id = l.id
    WHERE l.project_id = ? AND l.link_role = 'EXECUTION' AND l.${LIVE} AND w.archived_at IS NULL GROUP BY w.id, w.wbs_code, w.title, w.progress, w.sequence ORDER BY w.sequence LIMIT ?`, [projectId, limit]);
  return { project_key: m.external_project_key, summary: sum, lines: rows.map((r) => `- ${r.wbs_code} ${r.title}: progress ${r.progress}% · jira_execution ${r.done}/${r.total} Done`) };
}
