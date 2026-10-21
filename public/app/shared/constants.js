/* batch7 B2 — one tone per meaning on every screen. The ONLY place a status code gets its colour: badges.js tag(kind, code)
 * and the *_CHIP maps below read it. Tones: done 초록 (끝남·확정) · active 파랑 (진행·검토) · draft 노랑 (작성·초안) ·
 * hold 보라 회색 (멈춤) · bad 빨강 (문제) · muted 회색 (끝났지만 제외·미착수). Colour is never the only signal: the label always shows. */
export const TAG_TONE = {
  req: { CONFIRMED: 'done', REVIEWING: 'active', DRAFT: 'draft', ON_HOLD: 'hold', REJECTED: 'muted' },
  scope: { IN_SCOPE: 'done', UNDECIDED: 'draft', OUT_OF_SCOPE: 'muted' },
  wbs: { COMPLETED: 'done', IN_PROGRESS: 'active', PLANNED: 'muted', NOT_STARTED: 'muted', DELAYED: 'bad', ON_HOLD: 'hold' },
  test: { PASS: 'done', FAIL: 'bad', BLOCKED: 'hold', NOT_RUN: 'muted' },
  tc: { COMPLETED: 'done', READY: 'active', DRAFT: 'draft', BLOCKED: 'hold' },
  verify: { VERIFIED: 'done', IN_PROGRESS: 'active', FAILED: 'bad', UNLINKED: 'muted' },
  cr: { IMPLEMENTED: 'done', APPROVED: 'active', UNDER_REVIEW: 'active', DRAFT: 'draft', REJECTED: 'muted' },
  issue: { RESOLVED: 'done', CLOSED: 'done', IN_PROGRESS: 'active', OPEN: 'bad', BLOCKED: 'hold' },
  risk: { MONITORING: 'active', OPEN: 'draft', MATERIALIZED: 'bad', CLOSED: 'muted' },
  acc: { ACCEPTED: 'done', REQUESTED: 'active', DRAFT: 'draft', REWORK_REQUIRED: 'bad', REJECTED: 'muted' },
};
/** { CODE: 'tag--done' } for statusChip() — the old *_CHIP maps are kept as this wrapper (removed next batch). */
const tones = (kind) => Object.fromEntries(Object.entries(TAG_TONE[kind]).map(([k, t]) => [k, `tag--${t}`]));

export const STATUS = { DRAFT: '초안', ACTIVE: '진행 중', ON_HOLD: '보류', COMPLETED: '완료', ARCHIVED: '보관됨' };
export const STATUS_CHIP = { DRAFT: 'chip--muted', ACTIVE: 'chip--active', ON_HOLD: 'chip--hold', COMPLETED: 'chip--done' };
export const FEATURE_ROUTES = { tests: (pid, qs = '') => `/app/projects/${pid}/tests${qs}`, acceptance: (pid, qs = '') => `/app/projects/${pid}/tests?tab=acceptance${qs ? '&' + qs.replace(/^\?/, '') : ''}`, raid: (pid, qs = '') => `/app/projects/${pid}/issues${qs}`, changes: (pid, qs = '') => `/app/projects/${pid}/changes${qs}`, requirements: (pid, qs = '') => `/app/projects/${pid}/requirements${qs}`, wbs: (pid, qs = '') => `/app/projects/${pid}/wbs${qs}` };
export const ISSUE_STATUS = { OPEN: '열림', IN_PROGRESS: '진행 중', BLOCKED: '차단됨', RESOLVED: '해결', CLOSED: '종료' };   // Phase 4 US-7
export const ISSUE_STATUS_CHIP = tones('issue');
export const ISSUE_TRANSITIONS = { OPEN: ['IN_PROGRESS', 'BLOCKED', 'RESOLVED'], IN_PROGRESS: ['BLOCKED', 'RESOLVED', 'OPEN'], BLOCKED: ['IN_PROGRESS', 'OPEN', 'RESOLVED'], RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: ['OPEN'] };   // mirrors server/raid.js (Phase 4 US-5: 차단됨 → 해결)
export const SEVERITY = { CRITICAL: '심각', HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
export const RISK_STATUS = { OPEN: '열림', MONITORING: '모니터링', MATERIALIZED: '발생', CLOSED: '종료' };
export const RISK_STATUS_CHIP = tones('risk');
export const RISK_TRANSITIONS = { OPEN: ['MONITORING', 'MATERIALIZED', 'CLOSED'], MONITORING: ['MATERIALIZED', 'CLOSED'], MATERIALIZED: ['CLOSED'], CLOSED: ['OPEN'] };
export const LEVEL3 = { LOW: '낮음', MEDIUM: '보통', HIGH: '높음' };
export const RISK_LEVEL = { LOW: '낮음', MEDIUM: '보통', HIGH: '높음', CRITICAL: '심각' };
export const STRATEGY = { AVOID: '회피', MITIGATE: '완화', TRANSFER: '전가', ACCEPT: '수용' };
export const RAID_TARGET = { WBS: '관련 WBS', REQUIREMENT: '관련 요구사항', CHANGE: '관련 변경 요청' };
export const CR_STATUS = { DRAFT: '작성 중', UNDER_REVIEW: '검토 중', APPROVED: '승인', REJECTED: '반려', IMPLEMENTED: '반영 완료' };
export const CR_STATUS_CHIP = tones('cr');
export const CR_PRIORITY = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
export const RELATION_TYPE = { MODIFIES: '변경', ADDS: '추가', REMOVES: '제외' };
export const IMPACT_TYPE = { SCHEDULE: '일정 영향', SCOPE: '범위 변경', REWORK: '재작업', NEW_WORK: '신규 작업', NONE: '영향 없음' };
export const LINK_TYPE = { IMPLEMENTS: '구현', SUPPORTS: '지원', VALIDATES: '검증' };
export const WBS_TYPE = { SUMMARY: '상위 항목', TASK: '작업', MILESTONE: '마일스톤' };
export const WBS_CSTATUS = { PLANNED: '예정', IN_PROGRESS: '진행중', COMPLETED: '완료', DELAYED: '지연', ON_HOLD: '보류' };
export const WBS_CSTATUS_CHIP = tones('wbs');
export const WBS_STATUS = { NOT_STARTED: '시작 전', IN_PROGRESS: '진행 중', COMPLETED: '완료', ON_HOLD: '보류' };
export const WBS_STATUS_CHIP = tones('wbs');
export const REQ_TYPE = { UNSPECIFIED: '미지정', FUNCTIONAL: '기능', NON_FUNCTIONAL: '비기능', INTERFACE: '인터페이스', DATA: '데이터', SECURITY: '보안', OPERATION: '운영', OTHER: '기타' };
export const REQ_PRIORITY = { UNSPECIFIED: '미지정', HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
export const REQ_SCOPE = { UNDECIDED: '미결정', IN_SCOPE: '범위 내', OUT_OF_SCOPE: '범위 외' };
export const REQ_STATUS = { DRAFT: '작성 중', REVIEWING: '검토 중', CONFIRMED: '확정', ON_HOLD: '보류', REJECTED: '반려' };
/** AI WBS Planner default selection: 확정 + 작성 중 (AI-extracted requirements start as DRAFT), never 반려 or 범위 외. Archived ones are filtered before. */
export const plannerDefaultReq = (r) => (r.status === 'CONFIRMED' || r.status === 'DRAFT') && r.scope !== 'OUT_OF_SCOPE';
export const REQ_STATUS_CHIP = tones('req');
export const REQ_SCOPE_CHIP = tones('scope');
export const REQ_FIELD_LABEL = { title: '제목', description: '설명', type: '유형', priority: '우선순위', scope: '범위', status: '상태', owner_user_id: '담당자', requester: '요청자' };
export const PHASE_STATUS = { NOT_STARTED: '시작 전', IN_PROGRESS: '진행 중', COMPLETED: '완료' };
/* Lifecycle V2 — the same names the server template uses (templates/default-phases.js); landing page copy must match these. */
export { PHASE_NAME as LIFECYCLE_LABEL } from './lifecycle.js';
export const IMPORTANCE_LABEL = { REQUIRED: '필수', RECOMMENDED: '권장', OPTIONAL: '선택' };
export const ACTIVITY_STATE = { NOT_STARTED: { icon: '○', label: '미시작' }, IN_PROGRESS: { icon: '●', label: '진행 중' }, COMPLETED: { icon: '✓', label: '완료' }, SKIPPED: { icon: '—', label: '제외' } };
export const TC_STATUS = { DRAFT: '작성 중', READY: '준비됨', BLOCKED: '막힘', COMPLETED: '완료' };
export const TC_STATUS_CHIP = tones('tc');
export const TC_PRIORITY = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
export const RESULT = { PASS: '통과', FAIL: '실패', BLOCKED: '막힘', NOT_RUN: '미실행' };
export const VERIFY = { UNLINKED: '테스트 없음', IN_PROGRESS: '검증 중', VERIFIED: '검증 완료', FAILED: '실패 있음' };
export const VERIFY_CHIP = tones('verify');
export const ACC_STATUS = { DRAFT: '작성 중', REQUESTED: '검수 요청', ACCEPTED: '승인', REWORK_REQUIRED: '보완 필요', REJECTED: '반려' };
export const ACC_STATUS_CHIP = tones('acc');
export const ACC_ACTIONS = { DRAFT: ['accept', 'submit', 'rework', 'reject'], REQUESTED: ['accept', 'rework', 'reject'],   // 2026-10-21: 승인 straight from 작성 중 (no 검수 요청 step required)
  REWORK_REQUIRED: ['resubmit'], ACCEPTED: [], REJECTED: [] };
export const ACC_ACTION_LABEL = { submit: '검수 요청', accept: '승인', rework: '보완 요청', reject: '반려', resubmit: '재요청' };
export const testSummaryText = (s) => (s.total ? `${s.pass}/${s.total} 통과${s.fail ? ` · 실패 ${s.fail}` : ''}${s.not_run ? ` · 미실행 ${s.not_run}` : ''}` : '테스트 없음');
