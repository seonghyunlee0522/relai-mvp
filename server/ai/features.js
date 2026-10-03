/**
 * The four Phase 11 features. Each has:
 *   <feature>(db, …)        → runs the AI through service.runAiFeature (reserve → provider → validate → settle) and returns CANDIDATES
 *   commit<Feature>(db, …)  → writes ONLY what the user approved, through the existing requirement / WBS / trace / change / raid services
 * Nothing in the AI path writes project data; nothing in the commit path calls the AI.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { ValidationError } from '../validate.js';
import * as R from '../requirements.js';
import * as W from '../wbs.js';
import * as T from '../trace.js';
import * as C from '../changes.js';
import * as X from '../raid.js';
import { addWbsHistory } from '../wbs-history.js';
import { runAiFeature, AiError } from './service.js';
import { SYSTEM, dataBlock, inputBlock, neutralize } from './prompts.js';
import { extractionContext, wbsGenerationContext, changeImpactContext, assistantContext } from './context.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const uniq = (a) => [...new Set(a)];

/* =========================================================================
 * 1. Meeting notes / text → requirement candidates
 * ========================================================================= */
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const bigrams = (s) => { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
/** Dice coefficient on character bigrams of normalized titles — cheap, language-agnostic, good enough for a hint. */
export function titleSimilarity(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const bx = bigrams(x); const by = bigrams(y); let hit = 0;
  for (const g of bx) if (by.has(g)) hit++;
  return (2 * hit) / (bx.size + by.size || 1);
}
export const DUPLICATE_THRESHOLD = 0.6;

export async function extractRequirements(db, { project, wid, userId, text }) {
  const input = str(text);
  if (input.length < 10) throw new ValidationError({ text: '분석할 텍스트를 10자 이상 입력해 주세요.' });
  let ctx;
  return runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'REQUIREMENT_EXTRACTION',
    build: async () => {
      ctx = await extractionContext(db, project);
      return { system: SYSTEM.REQUIREMENT_EXTRACTION, schemaName: 'requirement_candidates', schemaDescription: '추출된 요구사항 후보 목록',
        user: `${dataBlock(ctx.text)}\n\n${inputBlock(neutralize(input))}\n\n위 <untrusted_input> 텍스트에서 요구사항 후보를 추출해 JSON으로 반환하세요.`,
        inputSummary: `text ${input.length} chars, existing ${ctx.existing.length}`, inputChars: input.length };
    },
    postValidate: async (data) => {
      const byId = new Map(ctx.existing.map((r) => [r.display_id, r]));
      const warnings = [];
      const candidates = data.candidates.map((c, i) => {
        const dup = ctx.existing.map((r) => ({ id: r.id, display_id: r.display_id, title: r.title, score: titleSimilarity(c.title, r.title) }))
          .filter((d) => d.score >= DUPLICATE_THRESHOLD).sort((a, b) => b.score - a.score).slice(0, 3);
        if (c.similar_to && byId.has(c.similar_to) && !dup.some((d) => d.display_id === c.similar_to)) { const r = byId.get(c.similar_to); dup.unshift({ id: r.id, display_id: r.display_id, title: r.title, score: null }); }
        if (c.similar_to && !byId.has(c.similar_to)) warnings.push(`후보 ${i + 1}: 존재하지 않는 요구사항 ID(${c.similar_to})를 참조해 무시했습니다.`);
        return { ...c, similar_to: byId.has(c.similar_to) ? c.similar_to : null, acceptance_criteria: uniq(c.acceptance_criteria.map(str).filter(Boolean)).slice(0, 10), duplicates: dup.map(({ score, ...d }) => ({ ...d, score: score === null ? null : Number(score.toFixed(2)) })) };
      });
      return { data: { candidates }, warnings };
    },
  });
}

/** Approve: every candidate becomes a real requirement through the existing create path (display id, history, validation). */
export async function commitRequirements(db, { project, userId, candidates }) {
  if (!Array.isArray(candidates) || !candidates.length) throw new ValidationError({ candidates: '등록할 후보를 선택해 주세요.' });
  if (candidates.length > 40) throw new ValidationError({ candidates: '한 번에 최대 40건까지 등록할 수 있습니다.' });
  const parsed = candidates.map((c, i) => {
    try {
      const input = R.parseRequirement({ title: c.title, description: c.description, type: c.type, priority: c.priority, scope: c.scope, status: 'DRAFT', requester_name: c.requester_name || '', requester_organization: c.requester_organization || '' });
      const criteria = (Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria : []).map(str).filter(Boolean).map((content) => R.parseCriterion({ content }));
      return { ...input, criteria };
    } catch (e) { if (e instanceof ValidationError) throw new ValidationError(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [`candidates.${i}.${k}`, v]))); throw e; }
  });
  const ids = await tx(db, async (t) => {
    const out = [];
    for (const input of parsed) {
      const id = await R.createRequirement(t, project, input, userId);
      await t.run(`INSERT INTO requirement_history (id, requirement_id, action_type, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?)`, [randomUUID(), id, 'AI_EXTRACTED', 'source', null, 'AI 추출 후보에서 생성', userId]);
      out.push(id);
    }
    return out;
  });
  const created = [];
  for (const id of ids) { const r = await R.getRequirement(db, project, id); created.push({ id: r.id, display_id: r.display_id, title: r.title }); }
  return { created, summary: await R.requirementStats(db, project.id) };
}

/* =========================================================================
 * 2. Requirements → WBS draft
 * ========================================================================= */
export const MAX_WBS_DEPTH = 3;
export async function generateWbs(db, { project, wid, userId, requirementIds }) {
  const ids = uniq((Array.isArray(requirementIds) ? requirementIds : []).map((x) => String(x || '')).filter(Boolean));
  if (!ids.length) throw new ValidationError({ requirement_ids: 'WBS 초안의 대상 요구사항을 1건 이상 선택해 주세요.' });
  if (ids.length > 60) throw new ValidationError({ requirement_ids: '한 번에 최대 60건의 요구사항을 선택할 수 있습니다.' });
  let ctx;
  return runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'WBS_GENERATION',
    build: async () => {
      ctx = await wbsGenerationContext(db, project, ids);
      if (!ctx.reqs.length) throw new ValidationError({ requirement_ids: '선택한 요구사항을 찾을 수 없습니다.' });
      return { system: SYSTEM.WBS_GENERATION, schemaName: 'wbs_draft', schemaDescription: 'WBS 초안 트리',
        user: `${dataBlock(ctx.text)}\n\n위 선택 요구사항을 구현하기 위한 WBS 초안을 JSON으로 반환하세요.`,
        inputSummary: `requirements ${ctx.reqs.length}, existing wbs ${ctx.wbs.length}`, inputChars: ctx.text.length };
    },
    postValidate: async (data) => {
      const warnings = []; const selected = new Map(ctx.reqs.map((r) => [r.display_id, r]));
      const seen = new Set(); const items = [];
      for (const it of data.items) {
        let temp = str(it.temp_id) || `AI-WBS-${items.length + 1}`;
        if (seen.has(temp)) { const t2 = `${temp}-${items.length + 1}`; warnings.push(`중복 임시 ID ${temp} → ${t2}`); temp = t2; }
        seen.add(temp);
        items.push({ ...it, item_type: it.item_type === 'SUMMARY' ? 'TASK' : it.item_type, temp_id: temp, parent_temp_id: it.parent_temp_id ? str(it.parent_temp_id) : null, related_requirement_ids: uniq(it.related_requirement_ids) });   // SUMMARY is legacy: a TASK with children is the group
      }
      const byTemp = new Map(items.map((i) => [i.temp_id, i]));
      for (const it of items) {
        if (it.parent_temp_id && !byTemp.has(it.parent_temp_id)) { warnings.push(`${it.temp_id}: 존재하지 않는 상위 항목(${it.parent_temp_id})을 참조해 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
        if (it.parent_temp_id === it.temp_id) { warnings.push(`${it.temp_id}: 자기 자신을 상위로 지정해 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
        if (it.parent_temp_id && byTemp.get(it.parent_temp_id).item_type === 'MILESTONE') { warnings.push(`${it.temp_id}: 마일스톤 아래에는 항목을 둘 수 없어 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
        const unknown = it.related_requirement_ids.filter((d) => !selected.has(d));
        if (unknown.length) warnings.push(`${it.temp_id}: 선택 범위 밖의 요구사항 ${unknown.join(', ')} 참조를 제거했습니다.`);
        it.related_requirement_ids = it.related_requirement_ids.filter((d) => selected.has(d));
        it.requirement_ids = it.related_requirement_ids.map((d) => selected.get(d).id);
      }
      // break cycles and cap depth (walk up at most MAX_WBS_DEPTH parents)
      const depthOf = (it, guard = 0) => (!it.parent_temp_id || guard > 50 ? 1 : 1 + depthOf(byTemp.get(it.parent_temp_id), guard + 1));
      for (const it of items) {
        const trail = new Set([it.temp_id]); let p = it.parent_temp_id;
        while (p) { if (trail.has(p)) { warnings.push(`${it.temp_id}: 순환 참조를 끊고 최상위로 옮겼습니다.`); it.parent_temp_id = null; break; } trail.add(p); p = byTemp.get(p)?.parent_temp_id || null; }
      }
      for (const it of items) {
        if (depthOf(it) > MAX_WBS_DEPTH) {
          let anc = byTemp.get(it.parent_temp_id); while (anc && depthOf(anc) > MAX_WBS_DEPTH - 1) anc = byTemp.get(anc.parent_temp_id);
          warnings.push(`${it.temp_id}: 깊이 ${MAX_WBS_DEPTH}단계를 넘어 ${anc ? anc.temp_id : '최상위'} 아래로 옮겼습니다.`); it.parent_temp_id = anc ? anc.temp_id : null;
        }
      }
      // order: parents before children, in the model's order
      const ordered = []; const placed = new Set();
      const place = (it) => { if (placed.has(it.temp_id)) return; if (it.parent_temp_id) place(byTemp.get(it.parent_temp_id)); placed.add(it.temp_id); ordered.push(it); };
      items.forEach(place);
      if (!ordered.length) throw new AiError('AI_INVALID_OUTPUT', 'AI가 WBS 항목을 제안하지 않았습니다.');
      return { data: { items: ordered.map((it) => ({ ...it, depth: depthOf(it) })), notes: data.notes, requirements: ctx.reqs.map((r) => ({ id: r.id, display_id: r.display_id, title: r.title })) }, warnings };
    },
  });
}

/** Approve: create the selected tree through W.createWbs (real codes/sequence) and link requirements through T.addLink. */
export async function commitWbs(db, { project, userId, items, source = null }) {
  if (!Array.isArray(items) || !items.length) throw new ValidationError({ items: '생성할 항목을 선택해 주세요.' });
  if (items.length > 80) throw new ValidationError({ items: '한 번에 최대 80건까지 생성할 수 있습니다.' });
  const temps = new Set(items.map((i) => str(i.temp_id)));
  const parsed = items.map((it, i) => {
    try {
      const input = W.parseWbs({ item_type: it.item_type, title: it.title, description: it.description || '' });
      const parentTemp = it.parent_temp_id ? str(it.parent_temp_id) : null;
      if (parentTemp && !temps.has(parentTemp)) throw new ValidationError({ parent_temp_id: '선택되지 않은 상위 항목입니다. 상위 항목을 함께 선택하거나 최상위로 바꿔 주세요.' });
      return { ...input, temp_id: str(it.temp_id) || `AI-${i + 1}`, parent_temp_id: parentTemp, parent_id: !parentTemp && it.parent_id ? String(it.parent_id) : null,
        requirement_ids: uniq((Array.isArray(it.requirement_ids) ? it.requirement_ids : []).map((x) => String(x || '')).filter(Boolean)) };
    } catch (e) { if (e instanceof ValidationError) throw new ValidationError(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [`items.${i}.${k}`, v]))); throw e; }
  });
  const result = await tx(db, async (t) => {
    const idOf = new Map(); const created = []; let links = 0; const pending = [...parsed]; let guard = 0;
    while (pending.length) {
      if (++guard > 500) throw new ValidationError({ items: '상위 항목 관계를 해석할 수 없습니다.' });
      const it = pending.shift();
      if (it.parent_temp_id && !idOf.has(it.parent_temp_id)) { pending.push(it); continue; }
      const parentId = it.parent_temp_id ? idOf.get(it.parent_temp_id) : it.parent_id;
      const id = await W.createWbs(t, project, { ...it, parent_id: parentId }, userId, { skipRenumber: true });
      await addWbsHistory(t, id, 'AI_GENERATED', { field: 'source', newValue: source && source.kind === 'AI_PROJECT_WBS_PLANNER' ? `AI Project WBS Planner에서 생성 (plan_id=${source.plan_id})` : 'AI WBS 초안에서 생성' }, userId);
      idOf.set(it.temp_id, id); created.push({ temp_id: it.temp_id, id, requirement_ids: it.requirement_ids });
    }
    await W.renumber(t, project.id);   // real wbs_code / sequence come from the existing numbering, never from the AI
    for (const c of created) {
      const wbs = await t.get('SELECT * FROM wbs_items WHERE id = ?', [c.id]);
      for (const rid of c.requirement_ids) {
        const requirement = await t.get('SELECT * FROM requirements WHERE project_id = ? AND id = ?', [project.id, rid]);
        if (!requirement || requirement.archived_at) continue;
        try { await T.addLink(t, project, { requirement, wbs }, 'IMPLEMENTS', userId); links++; } catch (e) { if (!(e instanceof ValidationError)) throw e; }
      }
    }
    return { created: created.map(({ requirement_ids, ...c }) => c), links };
  });
  const tree = await W.loadTree(db, project);
  const byId = new Map(tree.items.map((i) => [i.id, i]));
  return { created: result.created.map((c) => ({ ...c, wbs_code: byId.get(c.id)?.wbs_code, title: byId.get(c.id)?.title })), links: result.links, summary: await W.wbsStats(db, project.id) };
}

/* =========================================================================
 * 3. Change request → impact candidates
 * ========================================================================= */
export async function changeImpact(db, { project, wid, userId, change }) {
  let ctx;
  return runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'CHANGE_IMPACT',
    build: async () => {
      ctx = await changeImpactContext(db, project, change);
      return { system: SYSTEM.CHANGE_IMPACT, schemaName: 'change_impact', schemaDescription: '변경 영향 후보',
        user: `${dataBlock(ctx.text)}\n\n변경 요청 ${change.display_id}의 영향 후보를 JSON으로 반환하세요.`,
        inputSummary: `${change.display_id}: req ${ctx.reqs.length}, wbs ${ctx.wbs.length}, tests ${ctx.tests.length}`, inputChars: ctx.text.length };
    },
    postValidate: async (data) => {
      const warnings = []; const dropped = [];
      const pick = (rows, key, list, href, extra = () => ({})) => {
        const by = new Map(rows.map((r) => [r[key], r])); const seen = new Set(); const out = [];
        for (const c of list) {
          const code = str(c[key === 'wbs_code' ? 'wbs_code' : 'display_id']);
          const row = by.get(code);
          if (!row) { dropped.push(code || '(빈 ID)'); continue; }
          if (seen.has(code)) continue; seen.add(code);
          out.push({ id: row.id, display_id: code, title: row.title, reason: c.reason, confidence: c.confidence, href: href(row), ...extra(row, c) });
        }
        return out;
      };
      const linkedReq = new Set(change.requirements.map((r) => r.requirement_id)); const impacted = new Set(change.impacts.map((i) => i.wbs_item_id));
      const linkedRisk = new Set((await db.all(`SELECT source_id FROM raid_links WHERE source_type = 'RISK' AND target_type = 'CHANGE' AND target_id = ?`, [change.id])).map((r) => r.source_id));
      const out = {
        summary: data.summary,
        affected_requirements: pick(ctx.reqs, 'display_id', data.affected_requirements, (r) => `requirements?sel=${r.id}`, (r) => ({ already: linkedReq.has(r.id), status: r.status, scope: r.scope })),
        affected_wbs: pick(ctx.wbs, 'wbs_code', data.affected_wbs, (w) => `wbs?sel=${w.id}`, (w, c) => ({ already: impacted.has(w.id), impact_type: c.impact_type, item_type: w.item_type, status: w.status })),
        affected_tests: pick(ctx.tests, 'display_id', data.affected_tests, (t) => `tests?sel=${t.id}`, (t) => ({ last_result: t.last_result, status: t.status })),
        possible_risks: pick(ctx.risks, 'display_id', data.possible_risks, (r) => `issues?tab=risks&sel=${r.id}`, (r) => ({ already: linkedRisk.has(r.id), risk_level: r.risk_level })),
      };
      if (dropped.length) warnings.push(`프로젝트에 없거나 보관된 항목을 제외했습니다: ${uniq(dropped).slice(0, 10).join(', ')}`);
      return { data: out, warnings };
    },
  });
}

/** Approve: requirements → C.linkRequirement, WBS → C.addImpact, risks → X.addLink(RISK→CHANGE). Already-linked rows are skipped, not errors. */
export async function commitImpact(db, { project, userId, change, requirements = [], wbs = [], risks = [] }) {
  const n = (Array.isArray(requirements) ? requirements.length : 0) + (Array.isArray(wbs) ? wbs.length : 0) + (Array.isArray(risks) ? risks.length : 0);
  if (!n) throw new ValidationError({ items: '추가할 영향 항목을 선택해 주세요.' });
  if (n > 120) throw new ValidationError({ items: '한 번에 최대 120건까지 추가할 수 있습니다.' });
  const added = { requirements: 0, wbs: 0, risks: 0 }; const skipped = [];
  await tx(db, async (t) => {
    for (const r of requirements || []) {
      const out = await C.linkRequirement(t, project, change, String(r.id || ''), C.parseRelationType(r.relation_type), userId).catch((e) => { if (e instanceof ValidationError) return { skipped: true }; throw e; });
      if (out.error) throw new ValidationError({ requirements: '연결할 요구사항을 찾을 수 없습니다.' }); if (out.skipped) skipped.push(String(r.id)); else added.requirements++;
    }
    for (const w of wbs || []) {
      const out = await C.addImpact(t, project, change, String(w.id || ''), C.parseImpactType(w.impact_type), w.note || w.reason || '', userId).catch((e) => { if (e instanceof ValidationError) return { skipped: true }; throw e; });
      if (out.error) throw new ValidationError({ wbs: '영향 WBS를 찾을 수 없습니다.' }); if (out.skipped) skipped.push(String(w.id)); else added.wbs++;
    }
    for (const r of risks || []) {
      const risk = await X.getRisk(t, project, String(r.id || ''));
      if (!risk) throw new ValidationError({ risks: 'Risk를 찾을 수 없습니다.' });
      if (risk.archived_at) { skipped.push(risk.display_id); continue; }
      const out = await X.addLink(t, project, 'RISK', risk, 'CHANGE', change.id, userId).catch((e) => { if (e instanceof ValidationError) return { skipped: true }; throw e; });
      if (out.skipped) skipped.push(risk.display_id); else added.risks++;
    }
  });
  return { added, skipped, change: await C.getChange(db, project, change.id), summary: await C.changeStats(db, project.id) };
}

/* =========================================================================
 * 4. Project Q&A
 * ========================================================================= */
export async function askProject(db, { project, wid, userId, question, history = [] }) {
  const q = str(question);
  if (q.length < 2) throw new ValidationError({ question: '질문을 입력해 주세요.' });
  if (q.length > 1000) throw new ValidationError({ question: '질문은 1,000자 이내로 입력해 주세요.' });
  const prior = (Array.isArray(history) ? history : []).slice(-4).filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string')
    .map((h) => `${h.role === 'user' ? 'PM' : 'RELAI'}: ${neutralize(h.content).slice(0, 600)}`);
  let ctx;
  return runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'PROJECT_QA',
    build: async () => {
      ctx = await assistantContext(db, project, q);
      return { system: SYSTEM.PROJECT_QA, schemaName: 'project_answer', schemaDescription: '프로젝트 질문에 대한 근거 기반 답변',
        user: `${dataBlock(ctx.text)}${prior.length ? `\n\n<untrusted_input>\n이전 대화 (데이터):\n${prior.join('\n')}\n</untrusted_input>` : ''}\n\n${inputBlock(neutralize(q))}\n\n위 <untrusted_input>의 질문에 <project_data>만 근거로 답하세요.`,
        inputSummary: `question ${q.length} chars, intents ${ctx.intents.join('+')}`, inputChars: q.length };
    },
    postValidate: async (data) => {
      const warnings = [...data.warnings]; const refs = []; const seen = new Set(); const unknown = [];
      for (const r of data.references) {
        const code = str(r.display_id); const ref = ctx.refs.get(code);
        if (!ref) { unknown.push(code); continue; }
        if (seen.has(code)) continue; seen.add(code); refs.push(ref);
      }
      if (unknown.length) warnings.push(`근거를 확인할 수 없는 항목은 제외했습니다: ${uniq(unknown).slice(0, 8).join(', ')}`);
      return { data: { answer: data.answer, references: refs, intents: ctx.intents }, warnings };
    },
  });
}
