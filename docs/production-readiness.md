# RELAI Production Readiness (Phase 1~9 위, Billing 전 기반 정리)

## 1. PostgreSQL 구조
- 드라이버: `pg` 8.x (Pool). ORM 없음. 모든 SQL은 `server/*.js`의 문자열 그대로이며 `?` 플레이스홀더를 `server/db.js`가 `$n`으로 변환한다.
- 접근 API: `db.get / db.all / db.run / db.exec`, 트랜잭션은 `tx(db, async (t) => …)` — **트랜잭션 안의 모든 쿼리는 `t`로 실행**해야 한다(별도 커넥션이라 `db`를 쓰면 미커밋 행을 못 본다). 중첩 `tx`는 바깥 트랜잭션을 재사용한다. 라우트에서는 `tx(db, async (db) => …)`로 섀도잉해 실수를 막는다.
- 타입: 모든 `*_at`은 `timestamptz`(API에는 ISO 문자열로 나감), 일정/기한 컬럼은 `date`('YYYY-MM-DD' 문자열로 나감), `COUNT/SUM`은 Number. `structured_content`는 TEXT(JSON 문자열) 유지.
- 세션 타임존: 커넥션마다 `timezone=APP_TIMEZONE`(기본 Asia/Seoul)을 설정한다. `CURRENT_DATE`, `timestamptz::date`(주간보고 기간 집계)가 이 TZ 기준으로 계산된다. 서버 OS TZ와 무관.
- 무결성: FK 전부 실제 제약. polymorphic 테이블(`raid_links`, `test_links`, `acceptance_links`)과 동일-프로젝트 규칙은 plpgsql 트리거(`rl_fail`, SQLSTATE `RL001` → HTTP 400) + 서비스 검증(`common.js resolveLinkTarget`) 이중 방어.
- History 정렬: `requirement_history / change_request_history / raid_history / qa_history / phase_transitions`에 `seq BIGSERIAL` 추가(SQLite `rowid` 대체).
- Display ID 카운터: `project_counters`에 `INSERT … ON CONFLICT DO NOTHING` 후 `UPDATE … SET value = value + 1 RETURNING value`. 행 잠금으로 동시 요청이 직렬화된다(테스트: 40 병렬 생성 → REQ-001~040 중복/결번 없음).
- 스키마 적용: `server/schema.sql`은 멱등(IF NOT EXISTS / CREATE OR REPLACE)이며 기동마다 적용. 버전별 `up()`은 `schema_migrations` 테이블로 추적, 다중 인스턴스 동시 기동은 `pg_advisory_lock(7101)`로 직렬화.

## 2. 환경변수
| 변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | O | `postgres://user:pw@host:5432/db` |
| `NODE_ENV` | O | `production`이면 Secure + `__Host-` 쿠키, `SESSION_SECRET` 필수 |
| `SESSION_SECRET` | production | 세션 토큰 해시 키. 회전하면 전원 로그아웃 |
| `PORT` | | 기본 3000 |
| `DB_POOL_MAX` | | 인스턴스당 풀 크기, 기본 10. 인스턴스 수 × 풀 ≤ PostgreSQL `max_connections` − 여유분 |
| `APP_TIMEZONE` | | 기본 Asia/Seoul |
| `TEST_DATABASE_URL` | 테스트 | 기본 `postgres://postgres@127.0.0.1:5432/relai_test` |
| `BILLING_PROVIDER` | | 결제 Provider 이름(`server/billing/provider.js` 레지스트리: `fake` · `nicepay`). 미설정 시 개발=`fake`, production=결제 비활성(checkout 503) |
| `NICEPAY_CLIENT_KEY` | nicepay | NicePay 클라이언트 키(clientId). 샌드박스 `S…`, 운영 `R…`. Vercel Production에만 운영 키 |
| `NICEPAY_SECRET_KEY` | nicepay | NicePay 시크릿 키. 서명 검증·Basic 인증·카드정보 암호화에 사용. 로그·응답에 절대 노출하지 않는다 |
| `NICEPAY_MODE` | nicepay | `live`면 `api.nicepay.co.kr`, 그 외(기본)는 `sandbox-api.nicepay.co.kr`. 키 접두사(S/R)와 모드가 다르면 결제가 비활성화된다(부팅은 정상) |
| `NICEPAY_RECURRING_ENABLED` | | `true`면 정기결제(빌키) 경로를 연다. 기본 `false` (NicePay 정기결제 심사 완료 전까지) |
| `CREDITS_ONLY_MODE` | | `true`면 나이스페이 카드사 심사 모드(2026-10-26 나이스페이 안내): 랜딩 #pricing은 AI 크레딧 상품 3종(카드 1회 결제)만, 앱의 요금제 탭·플랜/구독 화면·업그레이드 문구를 숨기고 Free 워크스페이스도 충전 가능. 플랜 한도는 그대로. 정기결제 심사 통과 후 끈다. `/pay/agent`는 영향 없음 |
| `SERVICE_PAY_ENABLED` | | `/pricing` 서비스 결제(로그인 없는 구매) 스위치. 값이 정확히 `true`이고 NicePay Provider가 설정됐을 때만 결제가 열린다. 그 외(미설정 포함)에는 페이지만 보이고 버튼은 '결제 준비 중'. **Preview는 `false`**(운영 DB를 공유하고 키가 같으면 실제 카드가 결제된다), Production은 대표 승인 뒤에만 `true` |
| `NICEPAY_SDK_URL` | | 결제창 JS SDK URL 재정의(기본 `https://pay.nicepay.co.kr/v1/js/`) |
| `CRON_SECRET` | 결제 운영 | `GET /api/billing/cron/daily` 인증(`Authorization: Bearer …`, Vercel Cron이 자동 첨부). 미설정 시 503 |
| `FAKE_BILLING_SECRET` | | fake Provider Webhook HMAC 키(개발/테스트용) |
| `BILLING_ALLOW_FAKE` | | `1`이면 production에서도 fake Provider 허용(스테이징 전용) |
| `PLAN_LIMITS` | | `off`면 Plan 한도 강제 해제(레거시 테스트 전용). 운영에서는 설정하지 않는다 |

`.env`는 git에 넣지 않는다(`.gitignore`). `.env.example` 참고.

## 3. 마이그레이션 방법
### 신규 설치
```
createdb relai
DATABASE_URL=postgres://…/relai npm start      # 기동 시 schema.sql 적용 + schema_migrations 기록
```
### 기존 SQLite 데이터 이전
```
DATABASE_URL=postgres://…/relai node scripts/migrate-sqlite-to-postgres.js --sqlite data/relai.db [--dry-run] [--truncate]
```
- 단일 트랜잭션. PK, display ID, History(`rowid` 순서 → `seq`), 모든 junction 유지. 빈 문자열 날짜/시각은 NULL로.
- 종료 시 테이블별 `sqlite / copied / postgres` 행 수 표와 orphan 검사(21개 관계) 결과를 출력하고, 불일치가 있으면 exit 1.
- 대상 DB가 비어 있지 않으면 거부(`--truncate`로 RELAI 테이블만 비움).
- 이전 후 검증만: `npm run db:validate`.
- 기동 시 `node:sqlite`는 더 이상 로드되지 않는다(스크립트와 마이그레이션 테스트만 사용).

## 4. 백업 필요사항
- `pg_dump -Fc relai > relai-$(date +%F).dump` 일 1회 이상 + WAL 아카이브(PITR)를 권장. Billing 이후에는 결제 이벤트 테이블이 생기므로 PITR을 필수로 본다.
- 복구 리허설: `pg_restore -d relai_restore relai.dump` 후 `npm run db:validate`로 orphan 0 확인.
- 세션 테이블은 백업 대상에서 제외 가능(재로그인으로 복구).

## 5. Session
- 서버 메모리에 세션 없음. `sessions(token_hash, user_id, expires_at)` 테이블에 저장되므로 다중 인스턴스에서 공유된다(테스트: 같은 DB의 두 번째 `createApp` 인스턴스가 동일 쿠키를 인증).
- 토큰은 256-bit 랜덤, DB에는 `sha256(SESSION_SECRET + token)`만 저장 → 테이블 유출만으로 재사용 불가.
- 쿠키: `HttpOnly; SameSite=Lax; Path=/; Max-Age=30일`, production은 `Secure` + `__Host-relai_sid`. 개발(localhost)은 `relai_sid`.
- 만료 행 정리: `server/maintenance.js purgeExpired()` — 만료 세션, 하루 지난 auth_tokens, 끝난 rate_limits 창, 만료 OAuth state 삭제. Vercel은 `vercel.json crons` → `GET /api/cron/purge` (매일 18:30 UTC, `Authorization: Bearer $CRON_SECRET`; `CRON_SECRET` 미설정 시 라우트 404). 장기 실행 호스트는 `scripts/integration-cron.js`가 같은 정리를 함께 실행. `idx_sessions_expires` 있음.
- CSRF: SameSite=Lax + Origin 검사 + 비-GET은 `application/json`만 허용.

## 6. Rate Limit
- `server/security.js rateLimiter(db, { name, max, windowMs })`는 **PostgreSQL `rate_limits(key, count, reset_at)`** 고정 창 카운터(`INSERT … ON CONFLICT DO UPDATE`). 모든 서버리스 인스턴스가 같은 카운트를 보고, 콜드 스타트로 초기화되지 않는다(테스트: 같은 DB의 두 번째 `createApp` 인스턴스가 첫 인스턴스의 로그인 실패로 429).
- key는 `sha256(name:key)`로 저장 — IP/이메일 원문은 DB에 남지 않는다. 끝난 창은 purge가 지운다.
- 한도: 로그인 8회/15분(IP+이메일, 성공 시 초기화), 가입 10회/1시간(IP), 비밀번호 찾기 10회/1시간(IP) + 3회/1시간(이메일, 초과 시 조용히 미발송), 재설정 20회/1시간(IP), 인증 링크 30회/1시간(IP), 인증 메일 재발송 3회/1시간(사용자), 초대·Google 시작 한도는 `server/auth/routes.js`.
- 결제 Webhook 엔드포인트는 Provider IP 기준 별도 정책이 필요하므로 전용 `name`으로 인스턴스를 따로 만든다.

## 7. Role Policy (`server/authz.js`)
| 작업 | OWNER | ADMIN | MEMBER |
|---|---|---|---|
| 프로젝트 생성/수정/보관 | O | O | ✕ (403) |
| 프로젝트 내 업무(요구사항·WBS·변경·이슈·테스트·검수·주간보고) | O | O | O |
| 멤버 추가/제거, MEMBER↔ADMIN 변경 | O | O | ✕ |
| OWNER 부여/회수(소유권 이전) | O | ✕ | ✕ |
| Workspace 설정(이름) | O | O | ✕ |
| Billing(Phase 10: upgrade/결제수단/해지/재개/플랜 변경) | O | ✕ | ✕ |
| Workspace 삭제 | O (현재 501) | ✕ | ✕ |

- 미들웨어: `requireMember`(비멤버 404) → `requireRole(...)` / `requireAction('billing')` / `requireOwner()`. `GET /api/workspaces/:wid`가 `permissions` 맵을 내려주므로 프런트는 그 값으로 버튼만 숨기고, 강제는 항상 서버.
- OWNER 보호: 마지막 OWNER는 강등·제거 불가(`last_owner` 409). 이전은 "다른 멤버에게 OWNER 부여 → 본인 강등" 순서로 가능. 역할 변경·제거는 `SELECT … FOR UPDATE`로 동시 요청에서도 OWNER 0명이 되지 않는다.
- 프로젝트 단위 권한은 없다(Workspace 멤버 전원이 모든 프로젝트 접근).

## 8. Billing Webhook 설계 주의사항 (Phase 10)
- `billing_events(provider, provider_event_id UNIQUE, …)`: 수신 즉시 `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`. 반환 행이 없으면 중복 → 200 응답 후 종료. 반환 행이 있으면 같은 트랜잭션에서 `subscriptions`를 `SELECT … FOR UPDATE`로 잠그고 상태 전이 + `payments` 기록 + `processed_at` 갱신 후 COMMIT. 실패 시 ROLLBACK되면 event 행도 사라지므로 Provider 재시도가 자연스럽게 재처리한다.
- 동일 event의 동시 도착: UNIQUE 제약이 한쪽을 실패시키고(23505), `dbErrorInfo`가 409로 매핑하므로 핸들러에서 23505는 "이미 처리 중"으로 200 처리한다.
- 서명 검증은 `express.json()` 이전에 raw body가 필요하다 → 해당 라우트만 `express.raw({ type: '*/*' })`로 등록하고 전역 JSON 파서보다 먼저 선언한다.
- 상태 전이는 서비스 함수 한 곳(`subscriptions.transition`)에서만 하고 `subscription_events`(또는 billing_events payload)로 감사 추적.
- Webhook 라우트는 `requireAuth`/CSRF Origin 검사/`application/json` 강제에서 제외해야 한다(현재 `/api` 전역 미들웨어가 적용되므로 `/api/billing/webhook`은 그 앞에 등록).
- 시간 비교(`current_period_end`, grace period)는 `now()` 기준 SQL에서 하고 클라이언트 시계를 믿지 않는다.

**구현 (billing-foundation, migration v25)** — 위 규칙대로 구현됨:
- 테이블: `subscriptions`(workspace당 1행, `UNIQUE(provider, provider_subscription_id)`), `payments`(`UNIQUE(provider, provider_tid)`), `billing_events`(`UNIQUE(provider, provider_event_id)`, `result`=APPLIED|IGNORED:<사유>), `subscription_events`(전이 감사). DDL은 `schema.sql`, 버전 기록은 `migrations.js` v25.
- `POST /api/billing/webhook/:provider` — `createApp`에서 JSON 파서·CSRF·인증보다 먼저 `express.raw`로 등록, 전용 IP rate limiter(300/분). 서명 실패 400, 중복 200 `{duplicate:true}`.
- Provider 인터페이스 `server/billing/provider.js`: `createCheckout / handleWebhook / cancel`. Provider는 자기 Webhook을 정규화 이벤트(`subscription.activated`, `payment.succeeded`, `payment.failed`, `subscription.canceled`, `subscription.expired`)로 바꿔 돌려준다. 실제 Provider는 미선정 → fake만 등록.
- 상태 전이는 `server/billing/subscriptions.js transition()` 한 곳. 유효 플랜: ACTIVE(해지 예약 + 기간 종료 시 FREE) · PAST_DUE는 `grace_period_end`(실패 후 7일)까지 유지 · CANCELED/EXPIRED는 FREE.
**NicePay (billing-nicepay, migration v29)**:
- 가격은 `server/plans.js` 한 곳(부가세 별도, 2026-10-14 v2): FREE ₩0 · TEAM ₩20,000/월 · 워크스페이스 1개(소유자 포함) + 사용자 추가 1명당 ₩5,000/월, 최소 인원 없음, 1개월 또는 연간 선결제(12개월 × 월 요금, `ANNUAL_DISCOUNT_PCT` 기본 0) · ENTERPRISE 가격 비공개, 영업 문의. 파운딩: 선착순 10개 Workspace 첫 1년 40% 할인. 결제 금액 = (월 요금 × 개월 − 할인) + 부가세 10%.
- 서버 가격: checkout이 `billing_orders` 행(사용자 수·기간·할인·VAT·합계)을 만들고, 결제창·승인·웹훅 모두 이 `amount`와 대조한다(금액 위변조 방지). 클라이언트가 보낸 금액은 쓰지 않는다.
- 기본 경로 = 일반결제(서버 승인): `/api/billing/nicepay/pay/:orderId`(결제창) → NicePay가 `/api/billing/nicepay/return`으로 POST → 인증 서명 `sha256(authToken+clientId+amount+secretKey)`·금액·clientId 검증 → 승인 `POST /v1/payments/{tid}` → 응답 서명 `sha256(tid+amount+ediDate+secretKey)`·금액·orderId 검증 → `subscription.activated`(이벤트 id `paid:<tid>`, 웹훅과 같은 id라 한 번만 반영). 승인 응답이 끊기면 망취소, 반영 실패 시 자동 환불.
- 일반결제는 자동 갱신 없음(`auto_renew=false`): `current_period_end`만 연장(남은 기간에 이어서), 기간이 끝나면 FREE. 만료 7일 전 OWNER에게 연장 안내 메일(`GET /api/billing/cron/daily`, Vercel Cron 매일 00:00 UTC).
- TEAM 멤버 한도 = 구매 사용자 수(소유자 포함, `subscriptions.seats` = 1 + 추가 사용자).
- 정기결제(빌키): `NICEPAY_RECURRING_ENABLED=true`일 때만. 카드정보는 AES 암호화(encData)로 NicePay에만 전달하고 저장하지 않는다. 빌키는 `INTEGRATION_ENCRYPTION_KEY`로 암호화해 `subscriptions.billing_key_enc`에만 둔다. 갱신 청구는 같은 cron, 실패 시 PAST_DUE + 7일 유예, 하루 1회 재시도. OWNER 해지 시 빌키 삭제.
- 서비스 결제(`/pricing`, `service_orders`): 금액은 서버 카탈로그만. 결제창 결과 POST는 검증 뒤 주문을 `PENDING → APPROVING`으로 선점(조건부 UPDATE)한 요청 하나만 승인한다. 두 번째 POST는 승인·실패 처리·환불을 하지 않고 현재 상태(확인 중/완료)를 보여 준다. 반영 실패 시 자동 환불, 환불까지 실패하면 `failure_code=refund_failed` + `SUPPORT_EMAIL`(없으면 사업자 문의 메일)로 운영자 알림(`email_deliveries` type `SERVICE_PAY_ALERT`), 구매자에게는 '결제 확인 중 문제가 생겼습니다. 영업일 1일 안에 연락드립니다'. 웹훅 금액 불일치는 해당 tid 자동 환불 + 알림. 일일 cron: 24시간 지난 PENDING 주문 삭제, 30분 넘게 APPROVING인 주문은 `approval_unknown`으로 닫고 알림(늦게 온 paid 웹훅은 그대로 반영), 실패한 영수증 메일 7일간 재시도. 주문 생성 제한: IP당 20건/시간, 이메일당 5건/시간. 관리자 목록 조회마다 감사 로그 `SERVICE_ORDERS_VIEW`.
- **PCI 범위(정기결제를 열기 전 결정)**: `/pricing` 월 구독과 `/app/billing/subscribe`는 카드번호·비밀번호 앞 2자리를 RELAI 서버로 받아 NicePay용으로 암호화한다. 저장·로그는 하지 않지만 카드 데이터가 RELAI 서버를 지나므로 PCI DSS 범위(SAQ D 수준)에 들어간다. `NICEPAY_RECURRING_ENABLED`를 켜기 전에 NicePay 호스팅 빌키 발급 창(카드 데이터가 RELAI를 거치지 않음)으로 바꾸는 것을 우선 검토하고, 못 바꾸면 해당 라우트의 요청 본문 로깅이 꺼져 있는지(Vercel·APM·에러 리포터) 확인한다. 카드 입력란에는 `name` 속성이 없어 기본 폼 전송에 실리지 않는다.
- 환불: `POST /api/billing/admin/payments/:id/refund {reason}`(SYSTEM_ADMIN) → NicePay 전체 취소 → 결제 REFUNDED, 이용 기간에서 해당 주문 개월 수 차감(남는 기간이 없으면 즉시 CANCELED). Audit `REFUND_PAYMENT`.
- OWNER 해지(`requestCancel`)는 Provider 호출을 DB 트랜잭션 밖에서 한다(확인 → provider.cancel → 잠금·재확인·전이).
- NicePay 웹훅은 `200 text/html "OK"`로 응답해야 성공 처리된다(`provider.webhookAck`).

- Plan 한도(`server/billing/limits.js`): 생성 서비스 함수(요구사항·WBS·주간보고·멤버 추가/초대/수락·프로젝트 생성/보관 해제)에서 검사 → 402 `plan_limit_reached` `{limit:{dimension,label,used,limit,plan,adding}, upgrade:{plan,url}}`. 트랜잭션 안에서는 workspace 행을 `FOR UPDATE`로 잠가 동시 생성이 마지막 자리를 함께 통과하지 못한다. 다운그레이드 시 데이터는 지우지 않고 새 생성만 막는다.

## 9. 운영 엔드포인트
- `GET /health` → `{status:'ok', database:'ok'}` / DB 불가 시 503 `{status:'degraded', database:'unreachable'}`. 버전·비밀 미노출.
- SIGTERM/SIGINT: 새 연결 거부 → 진행 중 요청 완료 → 풀 종료(10초 후 강제 종료).
- DB 오류 매핑(`db.js dbErrorInfo`): 23505→409 conflict, 23503→400 invalid_reference, 23514/23502→400 invalid_value, RL001(트리거)→400 integrity, 연결 오류→503 db_unavailable. 서버는 종료되지 않는다.

## 10. 인덱스 (Phase 10 Usage / Dashboard 대비)
추가분과 이유:
- `idx_members_ws (workspace_members.workspace_id)` — 멤버 수 한도
- `idx_projects_ws_status (projects.workspace_id, status)` — 활성 프로젝트 수 한도, 목록
- `idx_req_project_scope_status (requirements.project_id, scope, status) WHERE archived_at IS NULL` — 요구사항 수 한도, Coverage/Health
- `idx_wbs_project_status (wbs_items.project_id, status) WHERE archived_at IS NULL` — WBS 수 한도, overdue
- `idx_issues_project_status_sev`, `idx_risks_project_status_level`, `idx_cr_project_status` (partial, archived 제외) — attention/health 집계
- `idx_weekly_reports_project_created (project_id, created_at)` — 월별 주간보고 수 한도
- `idx_sessions_expires` — 세션 정리
기존 인덱스(project_id+archived_at+sequence 등, 관계 테이블 source/target)는 유지. Usage Counter Cache는 두지 않는다(indexed COUNT로 처리).

## 11. 테스트
- `npm test` — 각 테스트 파일이 `TEST_DATABASE_URL` 안에 임시 스키마(`t_xxxx`)를 만들어 격리하고 종료 시 DROP. 서로 데이터 오염 없음, 병렬 실행 가능.
- 로컬 준비: `createdb relai_test` (또는 `TEST_DATABASE_URL` 지정).
