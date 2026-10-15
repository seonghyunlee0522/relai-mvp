/* Jim R2+R3a acceptance fixes (research/relai-redesign-spec.md §7): P1-1 담당자 지정 opens 일정 in owner mode ·
 * P2-1 01 with every 필수 done → the card is the gate, not the optional 운영 방식. The UI halves live in scripts/e2e-redesign-r2.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectGuidance } from '../guidance.js';

const base = { project: { id: 'p1', current_phase: 'INITIATION' }, next_phase: { name: '요구사항 정의', sequence: 2 }, stats: {} };
const INIT = (gateMet) => ({ phase_key: 'INITIATION', name: '착수', sequence: 1, summary: { required_open: gateMet ? 0 : 1, gate_met: gateMet } });
const def = (done) => ({ progress: { done, total: 5 }, needs_review: [], initiation_gate: { approval: { status: 'COMPLETED' }, kickoff: { status: 'COMPLETED' } } });

test('P2-1: 01 with 필수 업무 남음 0 and 정의 4/5 (only 운영 방식 left) → INIT_DONE, the blue button is the move to 02', () => {
  const r = projectGuidance({ ...base, phase: INIT(true), definition: def(4) });
  assert.equal(r.rule, 'INIT_DONE');
  assert.equal(r.primary_action.href, '/app/projects/p1?move=next');
  assert.doesNotMatch(r.title, /마저 완료/);
});

test('P2-1: 01 with 필수 work still open keeps INIT_DEFINE (4/5)', () => {
  const r = projectGuidance({ ...base, phase: INIT(false), definition: def(4) });
  assert.equal(r.rule, 'INIT_DEFINE'); assert.match(r.title, /\(4\/5\)/);
  assert.equal(projectGuidance({ ...base, phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: def(4) }).rule, 'INIT_DEFINE');   // no summary → unchanged
});

test('P1-1: the 03 card 담당자 지정 opens 일정 with ?select=owner (rows without an owner pre-ticked, owner bar)', () => {
  const r = projectGuidance({ ...base, project: { id: 'p1', current_phase: 'ANALYSIS_DESIGN' }, phase: { phase_key: 'ANALYSIS_DESIGN', name: '분석·설계', sequence: 3 }, stats: { wbs: { tasks: 10, tasks_without_owner: 10, tasks_without_dates: 0 } } });
  assert.equal(r.rule, 'WBS_ASSIGN');
  assert.equal(r.primary_action.href, '/app/projects/p1/wbs?f=no_owner&select=owner');
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(src('../activities.js'), /act\('담당자 지정 →', u\('\?f=no_owner&select=owner'\)\)/);   // the 지금 할 일 row
  assert.match(src('../../public/app/project/status.js'), /wbs\?f=no_owner&select=owner/);              // 현황 '담당자 미지정'
  assert.match(src('../../public/app/wbs/page.js'), /if \(ownerMode && !archived\) grid\.select\(/);    // pre-tick on arrival
});
