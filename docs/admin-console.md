# RELAI Admin Console (Phase 10B)

서비스 운영자용 내부 콘솔. 고객용 App(`/app`)과 분리된 `/admin` 화면과 `/api/admin/*` API로 회원·Workspace·Usage·Audit(및 Billing 구현 후 Subscription·Payment)을 관리한다.

## 1. 권한 구조

| 구분 | 저장 위치 | 값 | 검사 |
|---|---|---|---|
| Workspace 역할 | `workspace_members.role` | OWNER / ADMIN / MEMBER | `requireMember` + `authz.js` |
| 서비스 운영자 역할 | `users.system_role` | NONE / SYSTEM_ADMIN | `requireSystemAdmin` (`admin-routes.js`) |

- 두 역할은 서로 다른 컬럼·Enum이며 어느 쪽도 다른 쪽에 영향을 주지 않는다. SYSTEM_ADMIN은 어떤 Workspace의 멤버도 아니며, `/api/workspaces/*`는 기존대로 404(비멤버)를 돌려준다. `requireMember`에는 운영자 로직이 없다.
- 부여 방법은 CLI뿐: `DATABASE_URL=… node scripts/grant-system-admin.js user@email.com` (`--revoke`, `--list`). 회원가입·Admin UI 어디에서도 system_role을 바꿀 수 없다.
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
- **Audit** — 일시·Admin·Action·Target·Summary. 필터: Action·Admin·Target Type, 검색: Target ID·이메일·Workspace명.
- 레이아웃: "RELAI Admin" 헤더 + 운영자 사이드바(제품 네비 없음), 테이블 중심, 390px에서 조회 가능(가로 스크롤).

## 4. Audit

`admin_audit_logs(id, seq, admin_user_id, action, target_type, target_id, metadata jsonb, created_at)`. Action: SUSPEND_USER · REACTIVATE_USER · SUSPEND_WORKSPACE · REACTIVATE_WORKSPACE. metadata에는 당시의 이메일/Workspace명·사유·폐기한 세션 수·단독 OWNER Workspace 목록이 들어가며 비밀은 없다. 프로젝트 내부 History 테이블과 섞이지 않는다.

## 5. Plan / Usage

`server/plans.js`가 Plan 한도의 단일 기준(FREE: Projects 1 · Members 3 · Requirements 10 · WBS 30 · 주간보고 8/월, TEAM: 무제한). Billing 전까지 모든 Workspace는 FREE이며 한도는 제품 API에서 강제되지 않는다(Billing Phase 과제). `server/usage.js`는 집계 쿼리 한 번으로 계산한다(행별 쿼리 없음).

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
```
오류 형식은 기존과 동일(`{error:{code,message}}`): 401 unauthenticated, 403 forbidden, 404 not_found, 400 validation_error/cannot_suspend_self, 409 already_suspended/not_suspended.

## 7. 인덱스(추가분)

`users(created_at)`, `users(status)`, `users(last_login_at)`, `workspaces(created_at)`, `workspaces(status)`, `admin_audit_logs(created_at)`, `(admin_user_id, created_at)`, `(target_type, target_id, created_at)`. `workspace_members(user_id)`/`(workspace_id)`, `projects(workspace_id, status)`는 기존 인덱스를 사용.

## 8. Phase 10 Billing 연동 시

**자동으로 연결되는 것** (`server/billing-admin.js`가 테이블 존재를 감지):
- `subscriptions`, `payments`(, `subscription_events`) 테이블이 문서화된 컬럼 계약을 만족하면 Subscriptions/Payments 목록·상세, Dashboard의 Team Workspaces/Past Due/Payment Failed KPI와 결제 실패·PAST_DUE attention, Funnel의 Paid, Workspace 상세의 Subscription·Plan이 코드 수정 없이 켜진다.
- 계약: `subscriptions(id, workspace_id, plan, status, current_period_start, current_period_end, next_billing_at, cancel_at_period_end, grace_period_end, payment_method_summary, created_at, updated_at)`, `payments(id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code, provider_tid, moid, paid_at, failed_at, failure_code, failure_message, created_at)`. 추가 컬럼(billing_key 등)은 화이트리스트 밖이라 노출되지 않는다.

**추가 작업이 필요한 것**:
- `plans.js`의 `price_monthly` 확정(MRR은 가격이 있을 때만 계산), Plan 한도의 제품 API 강제(현재 미강제).
- Workspace의 실제 Plan을 subscription에서 읽어 Usage 집계·정렬에 반영(지금은 FREE 고정; `usage.js`의 `planOf` 훅 지점).
- "Subscription 재동기화", "결제 재시도" 같은 안전한 Action과 그 Audit Action 추가. Plan 강제 변경은 만들지 않는다.
- Payment Provider별 status/provider 값 사전과 Payments 필터 옵션 정렬.
