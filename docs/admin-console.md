# RELAI Admin Console (Phase 10B)

서비스 운영자용 내부 콘솔. 고객용 App(`/app`)과 분리된 `/admin` 화면과 `/api/admin/*` API로 회원·Workspace·Usage·Audit(및 Billing 구현 후 Subscription·Payment)을 관리한다.

## 1. 권한 구조

| 구분 | 저장 위치 | 값 | 검사 |
|---|---|---|---|
| Workspace 역할 | `workspace_members.role` | OWNER / ADMIN / MEMBER | `requireMember` + `authz.js` |
| 서비스 운영자 역할 | `users.system_role` | NONE / SYSTEM_ADMIN | `requireSystemAdmin` (`admin-routes.js`) |

- 두 역할은 서로 다른 컬럼·Enum이며 어느 쪽도 다른 쪽에 영향을 주지 않는다. SYSTEM_ADMIN은 어떤 Workspace의 멤버도 아니며, `/api/workspaces/*`는 기존대로 404(비멤버)를 돌려준다. `requireMember`에는 운영자 로직이 없다.
- 부여 방법은 두 가지이며 회원가입·Admin UI 어디에서도 system_role을 바꿀 수 없다.
  1. CLI: `DATABASE_URL=… node scripts/grant-system-admin.js user@example.com` (`--revoke`, `--list`).
  2. `ADMIN_EMAILS` 환경변수 부트스트랩 (DB 스크립트 없이 첫 운영자를 만들 때): `ADMIN_EMAILS=founder@example.com,ops@example.com` — 쉼표 구분, 앞뒤 공백 제거·소문자 비교. 목록에 있는 이메일의 사용자가 로그인(비밀번호·Google)하거나 기존 세션으로 요청을 보낼 때 `system_role`이 NONE이면 SYSTEM_ADMIN으로 올리고, 같은 트랜잭션에서 `admin_audit_logs`에 `SYSTEM_ADMIN_BOOTSTRAP`(actor_kind ADMIN, 대상 = 본인, metadata `{ email, source: 'ADMIN_EMAILS' }`)을 남긴다. 승격만 한다: 목록에서 빼거나 변수를 지워도 강등되지 않으므로 권한 회수는 `grant-system-admin.js --revoke`로 한다. 변수가 없거나 비어 있으면 아무 일도 하지 않는다. 목록에 없는 이메일로는 아무것도 바뀌지 않으며, 추가 쿼리는 실제 승격 때만 실행된다 (`bootstrapSystemAdmin`, `server/admin.js`). 이메일 인증 여부는 보지 않는다 (2026-10-19 창업자 결정: 메일 발송이 보류되어 인증할 수 없음). 그러므로 목록의 주소로 먼저 가입한 사람이 운영자가 된다 — 해당 계정을 먼저 만든 뒤에 `ADMIN_EMAILS`를 설정한다.
- 접근 제어: `/api/admin/*` — 미로그인 401, 비운영자 403(존재하지 않는 경로도 403 후 404). `/admin*` 페이지 — 미로그인은 `/login?next=` 리다이렉트, 비운영자 403 HTML. 프런트엔드의 메뉴 숨김은 편의일 뿐 통제 수단이 아니다.

## 2. 계정·Workspace 상태와 enforcement

- `users.status` ACTIVE / SUSPENDED / DEACTIVATED, `users.last_login_at`(로그인·가입 성공 시 기록), `users.suspended_at`.
- `workspaces.status` ACTIVE / SUSPENDED / CLOSED, `suspended_at`. 이번 Phase는 ACTIVE/SUSPENDED만 사용.
- **사용자 정지**: 상태 변경 + 해당 사용자의 모든 세션 삭제 + Audit 기록을 한 트랜잭션으로 처리. 인증 미들웨어는 ACTIVE가 아닌 사용자의 세션을 발견하면 즉시 폐기하고 API에는 403 `account_suspended`, 페이지는 `/login?suspended=1`로 보낸다. 로그인 시도는 403. Workspace·프로젝트 데이터는 그대로이며 OWNER인 Workspace도 자동 정지되지 않는다(유일한 OWNER일 때는 경고만 표시·기록).
- **Workspace 정지 정책(접근 차단 방식 채택)**: 멤버의 로그인은 유지되지만 `/api/workspaces/:wid/*` 전체(조회 포함)가 403 `workspace_suspended`. `guard = [requireAuth, requireMember, requireWorkspaceActive]`. 데이터 삭제·구독 해지 없음. 앱은 정지 안내 화면을 보여주고 다른 Workspace를 우선 선택한다.
- Workspace 삭제는 여전히 501 placeholder.

## 3. 화면

- **Dashboard** — KPI: 전체 Users · 활성 Workspaces · 전체 Projects · 최근 7일 가입(오늘 포함). Billing 연동 시 Team Workspaces · MRR · Payment Failed(7일) · Past Due 추가. 7일 활성화 Funnel(가입 → Workspace 생성 → Project 생성 [→ Paid]). 확인 필요: 정지 User/Workspace, 활성 OWNER가 없는 Workspace, Free 한도 90% 이상 Workspace, (Billing) 결제 실패·PAST_DUE. 최근 운영자 조작.
- **Users** — 서버 페이지네이션(20/50/100), 이름·이메일 검색, 상태·System Role·가입 시점(오늘/7일/30일) 필터, 정렬. 컬럼: 이름·이메일·상태·활성화·가입일·마지막 로그인·Workspace 수·Project 생성 수·System Role. 상세: 기본 정보, 최근 활동(로그인·프로젝트 생성 일시 — 프로젝트명 없음), 소속 Workspace(Role·Plan·단독 OWNER 표시), 운영자 조작. Action: 정지/정지 해제(사유 입력 → Audit). 비밀번호 조회·설정 기능 없음, impersonation 없음.
- **Workspaces** — 검색(이름·Owner 이메일), 상태 필터, 정렬. 상세: Owner·Members·Projects·Plan·Subscription(Billing 전엔 "미연동")·Usage 바·최근 Activity·운영자 조작. Action: 정지/해제.
- **Usage** — Workspace별 Projects/Members/Requirements/WBS/주간보고(이번 달) 사용량과 Free 한도 대비 %, 80% 이상 주의, 90% 이상 확인 필요. 정렬: Projects/Requirements/WBS 사용률, 최근 활동.
- **Subscriptions / Payments** — 읽기 전용. Billing 테이블이 없으면 "미연동" 안내만 표시(가짜 0 없음). 민감정보(billing key·카드번호·merchant key·생년월일·원본 TID)는 API 화이트리스트로 차단, TID는 끝 4자리만.
- **의견** (migration 48, `server/feedback.js`) — 앱 레일 맨 아래 '의견 남기기'로 사용자가 보낸 의견. 사이드바 배지 = 새 의견 수. 필터: 상태(새 의견/검토 중/처리 완료)·종류(불편/개선 제안/오류/기타)·기간(KST 날짜, 양끝 포함), 검색: 내용·이름·이메일·페이지·메모. 상세: 보낸 사람 이름·이메일(회원 상세 링크), 워크스페이스·프로젝트, 페이지 경로, 브라우저(User-Agent), 상태 변경과 운영자 메모(저장할 때마다 `FEEDBACK_UPDATE` 감사 로그 1건, 같은 트랜잭션). 보내는 쪽: 로그인 사용자만, 내용 필수 2,000자 이내, 사용자당 시간당 10건(429), 현재 경로·워크스페이스/프로젝트 id(본인이 멤버일 때만)·사용자 id·User-Agent 자동 첨부. 의견 내용은 우리 DB에만 저장하며 외부 서비스로 보내지 않는다.
- **Audit** — 일시·Admin·Action·Target·Summary. 필터: Action·Admin·Target Type, 검색: Target ID·이메일·Workspace명.
- 레이아웃: "RELAI Admin" 헤더 + 운영자 사이드바(제품 네비 없음), 테이블 중심, 390px에서 조회 가능(가로 스크롤).

## 4. Audit

`admin_audit_logs(id, seq, admin_user_id, action, target_type, target_id, metadata jsonb, created_at)`. Action: SUSPEND_USER · REACTIVATE_USER · SUSPEND_WORKSPACE · REACTIVATE_WORKSPACE. metadata에는 당시의 이메일/Workspace명·사유·폐기한 세션 수·단독 OWNER Workspace 목록이 들어가며 비밀은 없다. 프로젝트 내부 History 테이블과 섞이지 않는다.

## 5. Plan / Usage

`server/plans.js`가 Plan 한도의 단일 기준(FREE: Projects 1 · Members 3 · Requirements 10 · WBS 30 · 주간보고 8/월, TEAM: 무제한). 한도는 제품 API에서 402 `plan_limit_reached`로 강제된다(`server/billing/limits.js`, docs/production-readiness.md §8). Workspace의 플랜은 subscription에서 계산한 유효 플랜이며 `server/usage.js`는 집계 쿼리 한 번으로 계산한다(행별 쿼리 없음, 행마다 `plan_key` 포함).

## 6. API

```
GET  /api/admin/dashboard
GET  /api/admin/users?q&status&system_role&since&sort&page&size
GET  /api/admin/users/:id
POST /api/admin/users/:id/suspend      {reason?}
POST /api/admin/users/:id/reactivate   {reason?}
GET  /api/admin/workspaces?q&status&sort&page&size
GET  /api/admin/workspaces/:id
POST /api/admin/workspaces/:id/suspend | reactivate
GET  /api/admin/usage?q&sort=projects|requirements|wbs|activity&page&size
GET  /api/admin/billing
GET  /api/admin/subscriptions?q&plan&status&page&size · GET /api/admin/subscriptions/:id
GET  /api/admin/payments?q&status&provider&from&to&page&size · GET /api/admin/payments/:id
GET  /api/admin/audit?q&action&admin&target_type&target_id&page&size
POST  /api/feedback                   {category, message, page_path?, workspace_id?, project_id?}  (로그인 사용자, 시간당 10건)
GET   /api/admin/feedback?status&category&from&to&q&page&size · GET /api/admin/feedback/summary · GET /api/admin/feedback/:id
PATCH /api/admin/feedback/:id          {status?, admin_note?}
```
오류 형식은 기존과 동일(`{error:{code,message}}`): 401 unauthenticated, 403 forbidden, 404 not_found, 400 validation_error/cannot_suspend_self, 409 already_suspended/not_suspended.

## 7. 인덱스(추가분)

`users(created_at)`, `users(status)`, `users(last_login_at)`, `workspaces(created_at)`, `workspaces(status)`, `admin_audit_logs(created_at)`, `(admin_user_id, created_at)`, `(target_type, target_id, created_at)`. `workspace_members(user_id)`/`(workspace_id)`, `projects(workspace_id, status)`는 기존 인덱스를 사용.

## 8. Phase 10 Billing 연동 시

**자동으로 연결되는 것** (`server/billing-admin.js`가 테이블 존재를 감지):
- `subscriptions`, `payments`(, `subscription_events`) 테이블이 문서화된 컬럼 계약을 만족하면 Subscriptions/Payments 목록·상세, Dashboard의 Team Workspaces/Past Due/Payment Failed KPI와 결제 실패·PAST_DUE attention, Funnel의 Paid, Workspace 상세의 Subscription·Plan이 코드 수정 없이 켜진다.
- 계약: `subscriptions(id, workspace_id, plan, status, current_period_start, current_period_end, next_billing_at, cancel_at_period_end, grace_period_end, payment_method_summary, created_at, updated_at)`, `payments(id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code, provider_tid, moid, paid_at, failed_at, failure_code, failure_message, created_at)`. 추가 컬럼(billing_key 등)은 화이트리스트 밖이라 노출되지 않는다.

**완료 (billing-foundation)**: 위 테이블이 migration v25로 생성되어 콘솔이 켜진다. Plan 한도 제품 API 강제, Usage·Workspace 상세·사용자 상세의 유효 플랜 반영(PAST_DUE 유예 종료 시 FREE).

**추가 작업이 필요한 것**:
- (완료) 가격 확정: `plans.js` TEAM `base_monthly`/`extra_user_monthly`(pricing v2). MRR = 구독별 월 요금(기본 + 추가 사용자) 합계, 할인·VAT 제외.
- 실제 Payment Provider 어댑터(`server/billing/provider.js` 레지스트리에 추가).
- "Subscription 재동기화", "결제 재시도" 같은 안전한 Action과 그 Audit Action 추가. Plan 강제 변경은 만들지 않는다.
- Payment Provider별 status/provider 값 사전과 Payments 필터 옵션 정렬.

## 9. 이메일 발송 테스트 (연동 탭)

관리자 › 연동 맨 위 카드. 운영 도메인을 Resend에서 인증했는지, `EMAIL_PROVIDER=resend`로 바꾸기 **전에** 확인하는 용도.

- **설정 (서버 전용, env만)**: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_PROVIDER` (`server/email/config.js`). `EMAIL_FROM`이 비어 있으면 `RELAI <noreply@relai.kr>`. 키는 브라우저로 보내지 않고, 응답·로그·감사 로그·`email_deliveries`에 남기지 않는다 (`redactSecrets`). `public/`은 `server/email/*`을 import하지 않는다 (테스트로 확인).
- **Resend 연동 방식**: 공식 `resend` SDK 대신 `fetch` 어댑터(`server/email/provider.js`, `POST https://api.resend.com/emails` 하나). 쓰는 엔드포인트가 하나뿐이라 SDK가 주는 이득이 없고, 의존성·번들이 늘지 않으며, 테스트에서 `fetch`만 바꿔 끼우면 된다.
- **API** (둘 다 `requireAuth → requireSystemAdmin`: 비로그인 401, 운영자 아님 403)
  - `GET /api/admin/email/status` → `{ provider, from, from_is_default, default_from, key_present, domain }` — 키는 있음/없음만.
  - `POST /api/admin/email/test` `{ to }` → `EMAIL_PROVIDER` 값과 상관없이 Resend로 1통. 받는 주소는 1개, 254자 이하, 줄바꿈·제어 문자·쉼표·세미콜론·공백 불가. 운영자당 10분에 5번(`rate_limits`, 초과 시 429 `rate_limited`). 키가 없으면 400 `resend_key_missing` (발송·기록 없음).
  - 성공 200 `{ result: 'SENT', provider_message_id, ... }`. 실패 502, Resend 원문 대신 고정 한국어 메시지: `resend_key_invalid`(401) · `resend_domain_not_verified`(403) · `resend_invalid`(400/422) · `resend_rate_limited`(429) · `resend_server_error`(5xx) · `resend_timeout` · `resend_network`.
  - Resend까지 간 시도는 모두 감사 로그 `EMAIL_TEST` (target_type `EMAIL`, metadata `to`, `result`, `error_code`, `from`).
- **실서비스 전환 순서**: ① Resend › Domains에 `relai.kr` 추가 → 안내된 DKIM/SPF(필요 시 MX·DMARC) 레코드를 DNS에 넣고 Verified 확인 ② 이 카드에서 본인 주소로 테스트 → `발송 성공` 확인 ③ Vercel Production에 `EMAIL_PROVIDER=resend` 설정(`EMAIL_FROM`은 `relai.kr` 주소) 후 재배포 ④ 회원가입 인증 메일·초대 메일 수신 확인.
