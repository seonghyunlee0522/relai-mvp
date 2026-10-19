/* AI answers must show the Korean labels the screen uses, not internal enum codes (prod check 2026-10-19:
 * "REQ-001 [DRAFT/UNDECIDED/HIGH]", "2.1 [TASK/NOT_STARTED] (REWORK)" reached the PM in a RELAI에게 물어보기 answer). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeCodes, CODE_LABEL } from '../ai/labels.js';
import { REQ_STATUS, REQ_SCOPE, IMPACT_TYPE, WBS_STATUS } from '../../public/app/shared/constants.js';

test('humanizeCodes: bracketed and bare status/type codes become the UI labels', () => {
  assert.equal(humanizeCodes('- REQ-001 [DRAFT/UNDECIDED/HIGH] 로그인'), '- REQ-001 [작성 중/미결정/높음] 로그인');
  assert.equal(humanizeCodes('2.1 [TASK/NOT_STARTED] 요구사항 분석 (REWORK), 3.1 (NEW_WORK)'), '2.1 [작업/시작 전] 요구사항 분석 (재작업), 3.1 (신규 작업)');
  assert.equal(humanizeCodes('범위가 IN_SCOPE 인 항목'), '범위가 범위 내 인 항목');
});

test('humanizeCodes: IDs, acronyms, unknown or mixed-case words and non-strings are left alone', () => {
  const s = 'CR-001, REQ-012, ISS-004, 1.3, UAT, API, SSO, OPEN_API, Draft, HIGHLY, DRAFTS';
  assert.equal(humanizeCodes(s), s);
  assert.equal(humanizeCodes(''), ''); assert.equal(humanizeCodes(null), null); assert.equal(humanizeCodes(undefined), undefined);
});

test('CODE_LABEL follows the screen constants', () => {
  assert.equal(CODE_LABEL.DRAFT, REQ_STATUS.DRAFT); assert.equal(CODE_LABEL.UNDECIDED, REQ_SCOPE.UNDECIDED);
  assert.equal(CODE_LABEL.REWORK, IMPACT_TYPE.REWORK); assert.equal(CODE_LABEL.NOT_STARTED, WBS_STATUS.NOT_STARTED);
});
