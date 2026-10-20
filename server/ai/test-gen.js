/**
 * AI 테스트 시나리오 만들기 (batch7 #18, spec B8) — TEST_GENERATION, 30 credits per run, up to 20 requirements.
 *   generateTests(db, …)  → runs the AI through service.runAiFeature (reserve → provider → validate → settle) and returns CANDIDATES
 *   commitTests(db, …)    → writes ONLY the scenarios the user ticked: test_cases (+ test_data, environment) and test_links (REQUIREMENT)
 * Same split as features.js: nothing in the AI path writes project data; nothing in the commit path calls the AI.
 * The rule-based 요구사항별 테스트 만들기 (testing.js createFromRequirements) stays as the free option.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { ValidationError } from '../validate.js';
import * as Q from '../testing.js';
import { REQ_TYPES } from '../requirements.js';
import { runAiFeature } from './service.js';
import { COMMON_RULES, dataBlock, neutralize } from './prompts.js';
import { charterBlock } from './context.js';
import { TEST_SCENARIO_TYPES } from './schemas.js';

export const MAX_TEST_GEN_REQUIREMENTS = 20;
export const MAX_COMMIT_SCENARIOS = 60;
export const AI_TEST_SOURCE = 'AI 시나리오에서 생성';
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

export const SYSTEM_TEST_GENERATION = `${COMMON_RULES}

작업: 선택한 요구사항마다 테스트 시나리오 초안을 1~3개 만듭니다.
- requirement_id에는 제공된 요구사항 ID(REQ-nnn)만 그대로 씁니다. 목록에 없는 요구사항은 만들지 않습니다.
- type: ${TEST_SCENARIO_TYPES.join(' | ')} — 정상 흐름 1개를 먼저 두고, 완료 조건에 근거가 있을 때만 예외·경계를 더합니다.
- precondition: 실행 전에 갖춰야 할 상태 (권한, 사전 데이터 등).
- test_data: 필요한 테스트 계정의 역할·종류와 입력 데이터 예시. 실제 비밀번호·개인정보·키 같은 비밀값은 절대 쓰지 말고 "<테스트 계정 비밀번호>"처럼 자리표시로 둡니다.
- environment: "적용 환경" 목록이 있으면 그중 이 시나리오에 해당하는 것만 적고, 없으면 빈 문자열로 둡니다.
- steps: 사용자가 따라 할 단계(instruction)와 단계별 예상 결과(expected). 3~8단계.
- expected_result: 시나리오 전체의 최종 예상 결과 — 완료 조건을 확인할 수 있게 씁니다.
- "기존 테스트" 제목과 같은 내용은 다시 만들지 않습니다. 근거 없는 수치·화면 이름을 지어내지 않습니다.`;

/** 적용 환경 (#2, T2 contract `project_definitions.environments`): any shape → short lines; absent column/value → []. */
export function environmentLines(v) {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return x.split(/\r?\n/).map((l) => l.replace(/^\s*[-•*·]\s*/, '').trim()).filter(Boolean).slice(0, 20); } }
  if (Array.isArray(x)) return x.map((e) => (typeof e === 'string' ? e : e && typeof e === 'object' ? [e.label || e.name || e.kind || e.type, e.value || e.detail || e.note].filter(Boolean).join(': ') : '')).map((l) => String(l).trim()).filter(Boolean).slice(0, 20);
  if (x && typeof x === 'object') return Object.entries(x).filter(([, val]) => val && (typeof val !== 'object' || (Array.isArray(val) && val.length))).map(([k, val]) => `${k}: ${Array.isArray(val) ? val.join(', ') : val}`).slice(0, 20);
  return [];
}

/** Default selection (B8): 확정 + 범위 내 + 테스트 미연결 (and no 테스트 제외 사유), first 20. */
export async function defaultTestGenTargets(db, projectId) {
  return (await Q.untestedRequirements(db, projectId)).slice(0, MAX_TEST_GEN_REQUIREMENTS).map((r) => r.id);
}

async function testGenContext(db, project, ids) {
  const reqs = await db.all(`SELECT id, display_id, title, description, type, priority, status, scope FROM requirements WHERE project_id = ? AND archived_at IS NULL AND id = ANY(?) ORDER BY sequence_number`, [project.id, ids]);
  const crit = reqs.length ? await db.all('SELECT requirement_id, content FROM requirement_criteria WHERE requirement_id = ANY(?) ORDER BY sequence', [reqs.map((r) => r.id)]) : [];
  const def = await db.get('SELECT * FROM project_definitions WHERE project_id = ?', [project.id]);
  const environments = environmentLines(def ? def.environments : null);
  const existing = (await db.all(`SELECT t.display_id, t.title, l.target_id FROM test_cases t JOIN test_links l ON l.test_case_id = t.id AND l.target_type = 'REQUIREMENT'
    WHERE t.project_id = ? AND t.archived_at IS NULL AND l.target_id = ANY(?) ORDER BY t.sequence_number`, [project.id, reqs.map((r) => r.id)]));
  const lines = [await charterBlock(db, project), '', '## 적용 환경', ...(environments.length ? environments.map((e) => `- ${neutralize(clip(e, 200))}`) : ['(작성되지 않음)']), '', '## 선택한 요구사항'];
  for (const r of reqs) {
    lines.push(`- ${r.display_id} [${REQ_TYPES.includes(r.type) ? r.type : 'UNSPECIFIED'} · ${r.priority}] ${neutralize(clip(r.title, 200))}`);
    if (r.description) lines.push(`  설명: ${neutralize(clip(r.description, 600))}`);
    const cs = crit.filter((c) => c.requirement_id === r.id).map((c) => neutralize(clip(c.content, 300)));
    lines.push(cs.length ? `  완료 조건:\n${cs.map((c, i) => `    ${i + 1}. ${c}`).join('\n')}` : '  완료 조건: (없음)');
    const ex = existing.filter((t) => t.target_id === r.id);
    if (ex.length) lines.push(`  기존 테스트: ${ex.map((t) => `${t.display_id} ${neutralize(clip(t.title, 120))}`).join(' / ')}`);
  }
  return { reqs, environments, text: lines.join('\n') };
}

/** requirement_ids (ids, optional) → { requirements: [{ requirement: {id, display_id, title}, scenarios: [...] }], environments, notes, warnings, run }. */
export async function generateTests(db, { project, wid, userId, requirementIds }) {
  let ids = [...new Set((Array.isArray(requirementIds) ? requirementIds : []).map((x) => String(x || '')).filter(Boolean))];
  if (ids.length > MAX_TEST_GEN_REQUIREMENTS) throw new ValidationError({ requirement_ids: `한 번에 최대 ${MAX_TEST_GEN_REQUIREMENTS}건의 요구사항을 선택할 수 있습니다.` });
  if (!ids.length) ids = await defaultTestGenTargets(db, project.id);
  if (!ids.length) throw new ValidationError({ requirement_ids: '시나리오를 만들 요구사항을 1건 이상 선택해 주세요.' });
  let ctx;
  return runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'TEST_GENERATION',
    build: async () => {
      ctx = await testGenContext(db, project, ids);
      if (!ctx.reqs.length) throw new ValidationError({ requirement_ids: '선택한 요구사항을 찾을 수 없습니다.' });
      return { system: SYSTEM_TEST_GENERATION, schemaName: 'test_scenarios', schemaDescription: '요구사항별 테스트 시나리오 초안',
        user: `${dataBlock(ctx.text)}\n\n위 선택 요구사항마다 테스트 시나리오 초안을 JSON으로 반환하세요.`,
        inputSummary: `requirements ${ctx.reqs.length}, environments ${ctx.environments.length}`, inputChars: ctx.text.length };
    },
    postValidate: async (data) => {
      const warnings = []; const byDisplay = new Map(ctx.reqs.map((r) => [r.display_id, r])); const out = new Map();
      for (const g of data.requirements) {
        const r = byDisplay.get(str(g.requirement_id));
        if (!r) { warnings.push(`선택 범위 밖의 요구사항 ${g.requirement_id || '(빈 ID)'} 시나리오를 제외했습니다.`); continue; }
        const list = out.get(r.id) || [];
        for (const sc of g.scenarios) {
          if (list.length >= 3) break;
          const title = str(sc.title); if (!title || list.some((x) => x.title === title)) continue;
          list.push({ temp_id: `${r.display_id}-${list.length + 1}`, title, type: TEST_SCENARIO_TYPES.includes(sc.type) ? sc.type : '정상', precondition: str(sc.precondition), test_data: str(sc.test_data),
            environment: str(sc.environment), steps: sc.steps.map((s) => ({ instruction: str(s.instruction), expected: str(s.expected) })).filter((s) => s.instruction).slice(0, 15), expected_result: str(sc.expected_result) });
        }
        out.set(r.id, list);
      }
      const requirements = ctx.reqs.filter((r) => (out.get(r.id) || []).length).map((r) => ({ requirement: { id: r.id, display_id: r.display_id, title: r.title }, scenarios: out.get(r.id) }));
      const missed = ctx.reqs.filter((r) => !(out.get(r.id) || []).length).map((r) => r.display_id);
      if (missed.length) warnings.push(`시나리오가 만들어지지 않은 요구사항: ${missed.join(', ')}`);
      return { data: { requirements, environments: ctx.environments, notes: data.notes || [] }, warnings };
    },
  });
}

/** One scenario → test fields (the title carries the requirement ID like the rule-based path; type tag goes to the description). */
export function testFromScenario(req, sc) {
  const title = `${req.display_id} ${str(sc.title)}`.slice(0, 200);
  const input = Q.parseTest({ title, description: sc.type ? `[${sc.type}] AI 시나리오 초안` : '', precondition: sc.precondition || '', test_data: sc.test_data || '', environment: sc.environment || '',
    steps: Array.isArray(sc.steps) ? sc.steps.slice(0, 50) : [], expected_result: sc.expected_result || '', status: 'DRAFT', priority: 'MEDIUM' });
  return input;
}

/** Approve: scenarios = [{ requirement_id, title, type, precondition, test_data, environment, steps, expected_result }] → tests + REQUIREMENT links, one transaction. */
export async function commitTests(db, { project, userId, scenarios }) {
  if (!Array.isArray(scenarios) || !scenarios.length) throw new ValidationError({ scenarios: '저장할 시나리오를 선택해 주세요.' });
  if (scenarios.length > MAX_COMMIT_SCENARIOS) throw new ValidationError({ scenarios: `한 번에 최대 ${MAX_COMMIT_SCENARIOS}개까지 저장할 수 있습니다.` });
  const reqIds = [...new Set(scenarios.map((s) => String(s?.requirement_id || '')))];
  const reqs = new Map((await db.all('SELECT id, display_id, title, archived_at FROM requirements WHERE project_id = ? AND id = ANY(?)', [project.id, reqIds])).map((r) => [r.id, r]));
  const parsed = scenarios.map((sc, i) => {
    const r = reqs.get(String(sc?.requirement_id || ''));
    if (!r || r.archived_at) throw new ValidationError({ [`scenarios.${i}.requirement_id`]: '요구사항을 찾을 수 없습니다.' });
    try { return { r, input: testFromScenario(r, sc || {}) }; } catch (e) { if (e instanceof ValidationError) throw new ValidationError(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [`scenarios.${i}.${k}`, v]))); throw e; }
  });
  const ids = await tx(db, async (t) => {
    const out = [];
    for (const { r, input } of parsed) {
      const id = await Q.createTest(t, project, input, userId);
      await t.run('INSERT INTO qa_history (id, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?,?)', [randomUUID(), 'TEST', id, 'GENERATED', 'REQUIREMENT', null, AI_TEST_SOURCE, userId]);
      await t.run('INSERT INTO test_links (id, project_id, test_case_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?)', [randomUUID(), project.id, id, 'REQUIREMENT', r.id, userId]);
      await t.run('INSERT INTO qa_history (id, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?,?)', [randomUUID(), 'TEST', id, 'LINKED', 'REQUIREMENT', null, `${r.display_id} ${r.title}`, userId]);
      out.push(id);
    }
    return out;
  });
  const created = (await db.all('SELECT id, display_id, title FROM test_cases WHERE id = ANY(?) ORDER BY sequence_number', [ids]));
  return { created, tests: await Q.testStats(db, project.id) };
}
