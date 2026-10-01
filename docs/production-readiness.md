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
- 만료 행 정리: `DELETE FROM sessions WHERE expires_at < now()`를 주기 작업(cron)으로 돌린다. `idx_sessions_expires` 있음.
- CSRF: SameSite=Lax + Origin 검사 + 비-GET은 `application/json`만 허용.

## 6. Rate Limit 한계
- `server/security.js rateLimiter`는 **프로세스 메모리** Map 기반(로그인 8회/15분, 가입 10회/1시간, IP 키).
- 다중 인스턴스에서는 인스턴스별로 따로 센다 → 실제 한도는 인스턴스 수 배. 로드밸런서 뒤 단일 인스턴스이거나 sticky session이면 문제 없음.
- 확장 시 선택지: PostgreSQL `rate_limits(key, window_start, count)` 테이블(동시성은 `INSERT … ON CONFLICT DO UPDATE`), 또는 Redis. Phase 10 결제 Webhook 엔드포인트는 Provider IP 기준 별도 정책이 필요하므로 `rateLimiter`를 공유하지 말고 엔드포인트별 인스턴스를 만든다(`app.use('/api/billing/webhook', …)` 전용).

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
