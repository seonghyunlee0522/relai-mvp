/* Admin Console 감사 로그: Korean label of every operator action (actor_kind ADMIN). Also the 작업 filter's options, so every key
 * here must be in server/admin.js AUDIT_ACTIONS (server/test/admin-fix.test.js checks both). Pure module: shared with the server tests. */
export const ACTIONS = {
  DELIVERABLE_CATALOG_CREATE: '산출물 목록 추가', DELIVERABLE_CATALOG_UPDATE: '산출물 목록 수정',
  FEEDBACK_UPDATE: '의견 처리', PROMOTION_CREATE: '프로모션 추가', PROMOTION_UPDATE: '프로모션 수정', PROMOTION_DELETE: '프로모션 삭제',
  SUSPEND_USER: '사용자 정지', REACTIVATE_USER: '사용자 정지 해제', SUSPEND_WORKSPACE: '워크스페이스 정지', REACTIVATE_WORKSPACE: '워크스페이스 정지 해제',
  GRANT_AI_CREDITS: 'AI 크레딧 지급', ADJUST_AI_CREDITS: 'AI 크레딧 조정', CREDIT_REFUND: 'AI 크레딧 환불', REFUND_PAYMENT: '결제 환불',
  PLATFORM_INVITE_CREATED: '고객 초대 발송', PLATFORM_INVITE_RESENT: '고객 초대 재발송', PLATFORM_INVITE_REVOKED: '고객 초대 취소',
  SYSTEM_ADMIN_BOOTSTRAP: '운영자 자동 부여', EMAIL_TEST: '이메일 발송 테스트',
};
