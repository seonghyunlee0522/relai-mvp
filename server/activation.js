/**
 * Customer activation state (Phase 14) — computed from workspace facts, never stored. Shared by the Admin Console and onboarding.
 */
/* ---------- activation (operator view; computed, never stored) ---------- */
export const ACTIVATION = {
  INVITED: { label: '초대 발송', tone: 'muted', order: 0 }, SIGNED_UP: { label: '가입 완료', tone: 'muted', order: 1 }, WORKSPACE_READY: { label: '프로젝트 생성 대기', tone: 'muted', order: 2 },
  PROJECT_CREATED: { label: '프로젝트 생성', tone: 'act', order: 3 }, PROJECT_DEFINED: { label: '프로젝트 정의', tone: 'act', order: 4 }, ACTIVATED: { label: '업무 시작', tone: 'ok', order: 5 }, ACTIVE: { label: '활발히 사용 중', tone: 'ok', order: 6 },
};
export const ACTIVE_WINDOW_DAYS = 14;
export function activationState(f, { now = Date.now() } = {}) {
  let state;
  if (!f.has_owner) state = 'INVITED';
  else if (f.projects === 0) state = f.last_login ? 'WORKSPACE_READY' : 'SIGNED_UP';
  else if (f.activated_projects > 0) state = (now - new Date(f.last_active_at).getTime()) <= ACTIVE_WINDOW_DAYS * 86400000 ? 'ACTIVE' : 'ACTIVATED';
  else if (f.defined_projects > 0) state = 'PROJECT_DEFINED';
  else state = 'PROJECT_CREATED';
  return { state, ...ACTIVATION[state], last_active_at: f.last_active_at || null };
}
