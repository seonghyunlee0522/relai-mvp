/**
 * /api/workspaces/:wid/projects/:pid/ai/* — project-scoped AI endpoints. Same guard chain as every other project route
 * (requireAuth → requireMember → requireWorkspaceActive → loadProject). Read/draft calls work on archived projects;
 * every commit (approval) call goes through `mutable`, exactly like the manual create endpoints.
 *
 *   GET  /ai/status                          flag, costs, notice, credit balance
 *   POST /ai/requirements/extract            { text }                     → requirement candidates
 *   POST /ai/requirements/commit             { candidates }               → creates requirements (existing service)
 *   POST /ai/wbs/generate                    { requirement_ids }          → WBS draft tree
 *   POST /ai/wbs/commit                      { items }                    → creates WBS + requirement links
 *   POST /changes/:cid/ai/impact             {}                           → impact candidates
 *   POST /changes/:cid/ai/impact/commit      { requirements, wbs, risks } → change relations
 *   POST /ai/ask                             { question, history }        → grounded answer + references
 */
import * as C from '../changes.js';
import { aiStatus } from './service.js';
import { extractRequirements, commitRequirements, generateWbs, commitWbs, changeImpact, commitImpact, askProject } from './features.js';

export function mountAiRoutes({ app, db, guard, wrap, fail, loadProject, mutable, base }) {
  const ai = `${base}/:pid/ai`;
  const ctx = (req, project) => ({ project, wid: req.params.wid, userId: req.user.id });

  app.get(`${ai}/status`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await aiStatus(db, req.params.wid));
  }));

  app.post(`${ai}/requirements/extract`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await extractRequirements(db, { ...ctx(req, project), text: req.body?.text }));
  }));
  app.post(`${ai}/requirements/commit`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    res.status(201).json(await commitRequirements(db, { project, userId: req.user.id, candidates: req.body?.candidates }));
  }));

  app.post(`${ai}/wbs/generate`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await generateWbs(db, { ...ctx(req, project), requirementIds: req.body?.requirement_ids }));
  }));
  app.post(`${ai}/wbs/commit`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    res.status(201).json(await commitWbs(db, { project, userId: req.user.id, items: req.body?.items }));
  }));

  const loadChange = async (req, res, project) => {
    const c = await C.getChange(db, project, req.params.cid);
    if (!c) fail(res, 404, 'not_found', '변경 요청을 찾을 수 없습니다.');
    return c;
  };
  app.post(`${base}/:pid/changes/:cid/ai/impact`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    const change = await loadChange(req, res, project); if (!change) return;
    res.json(await changeImpact(db, { ...ctx(req, project), change }));
  }));
  app.post(`${base}/:pid/changes/:cid/ai/impact/commit`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project || !mutable(res, project)) return;
    const change = await loadChange(req, res, project); if (!change) return;
    if (change.archived_at) return fail(res, 409, 'archived', '보관된 변경 요청은 수정할 수 없습니다.');
    const b = req.body || {};
    res.status(201).json(await commitImpact(db, { project, userId: req.user.id, change, requirements: b.requirements, wbs: b.wbs, risks: b.risks }));
  }));

  app.post(`${ai}/ask`, guard, wrap(async (req, res) => {
    const project = await loadProject(req, res); if (!project) return;
    res.json(await askProject(db, { ...ctx(req, project), question: req.body?.question, history: req.body?.history }));
  }));
}
