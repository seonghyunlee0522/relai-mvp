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
import * as P from './planner.js';

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

  /* ---------- Phase 15: AI Project WBS Planner ----------
   *   GET  /ai/wbs-plans                 { active, plans }         resume support
   *   POST /ai/wbs-plans                 { requirement_ids | all } → plan + area assessment + questions (0 credits)
   *   GET  /ai/wbs-plans/:planId
   *   PATCH /ai/wbs-plans/:planId/answers { answers }
   *   POST /ai/wbs-plans/:planId/generate                         → draft + coverage (WBS_GENERATION credits, once per plan)
   *   POST /ai/wbs-plans/:planId/coverage { items }                → save edits, recompute coverage (no AI)
   *   POST /ai/wbs-plans/:planId/fix      { areas? }               → extra candidates for missing areas (0 credits)
   *   POST /ai/wbs-plans/:planId/commit   { items }                → real WBS (mutable project only; idempotent)
   *   POST /ai/wbs-plans/:planId/cancel */
  const plans = `${ai}/wbs-plans`;
  const planErr = (res, fn) => fn().catch((e) => { if (e instanceof P.PlanError) return fail(res, e.status, e.code, e.message); throw e; });
  const loadPlan = async (req, res, project) => { const plan = await P.getPlan(db, project, req.params.planId); if (!plan) fail(res, 404, 'not_found', 'AI WBS 초안을 찾을 수 없습니다.'); return plan; };
  app.get(plans, guard, wrap(async (req, res) => { const project = await loadProject(req, res); if (!project) return; res.json(await P.listPlans(db, project)); }));
  app.post(plans, guard, wrap(async (req, res) => { const project = await loadProject(req, res); if (!project) return; const b = req.body || {}; res.status(201).json(await P.createPlan(db, { ...ctx(req, project), requirementIds: b.all ? null : (b.requirement_ids ?? null), all: Boolean(b.all) })); }));
  app.get(`${plans}/:planId`, guard, wrap(async (req, res) => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; res.json({ plan }); }));
  app.patch(`${plans}/:planId/answers`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; const answers = await P.saveAnswers(db, plan, req.body?.answers); res.json({ answers, plan: await P.getPlan(db, project, plan.id) }); })));
  app.post(`${plans}/:planId/generate`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; res.json(await P.generatePlanDraft(db, { ...ctx(req, project), plan })); })));
  app.post(`${plans}/:planId/coverage`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; res.json(await P.reviewCoverage(db, { plan, project, items: req.body?.items ?? null })); })));
  app.post(`${plans}/:planId/fix`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; res.json(await P.fixPlan(db, { ...ctx(req, project), plan, areas: Array.isArray(req.body?.areas) ? req.body.areas : null })); })));
  app.post(`${plans}/:planId/commit`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project || !mutable(res, project)) return; const plan = await loadPlan(req, res, project); if (!plan) return; res.status(201).json(await P.commitPlan(db, { plan, project, userId: req.user.id, items: req.body?.items ?? null })); })));
  app.post(`${plans}/:planId/cancel`, guard, wrap(async (req, res) => planErr(res, async () => { const project = await loadProject(req, res); if (!project) return; const plan = await loadPlan(req, res, project); if (!plan) return; await P.cancelPlan(db, plan); res.json({ plan: await P.getPlan(db, project, plan.id) }); })));

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
