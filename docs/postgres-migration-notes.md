# SQLite → PostgreSQL 전환 항목 — **전환 완료** (Production Readiness Phase)

> 아래 항목은 모두 반영되었다. 현재 구조는 `docs/production-readiness.md` 참고. 이 문서는 전환 당시의 점검 목록으로 보존한다.

현재 RELAI는 `node:sqlite`(DatabaseSync, Node ≥ 22) 위에서 동작한다. 아래는 PostgreSQL로 옮길 때 반드시 손봐야 하는 지점의 목록이다. 이번 안정화 작업에서는 **실제 이전을 하지 않았고**, 종속 코드를 가능한 한 `server/common.js` / `server/db.js`로 모아 두었다.

## 1. 드라이버·트랜잭션 (`server/db.js`, `server/app.js`)
| 항목 | 현재 | PostgreSQL |
|---|---|---|
| 드라이버 | `node:sqlite` `DatabaseSync` (동기 API) | `pg` 비동기 API → 모든 `db.prepare().get/all/run`을 `await`로 바꿔야 함. 라우트/엔진 함수가 전부 동기라 가장 큰 작업 |
| 트랜잭션 | `tx()`가 `BEGIN IMMEDIATE` (쓰기 잠금 직렬화) | `BEGIN` + 필요한 행에 `SELECT … FOR UPDATE` (project_counters) |
| PRAGMA | `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout`, `user_version` | 전부 제거. 마이그레이션 버전은 별도 테이블(`schema_migrations`)로 |
| DB 파일 경로 | `DATABASE_FILE` 환경변수 (`:memory:` 테스트) | `DATABASE_URL`; 테스트는 임시 스키마 또는 testcontainers |

## 2. SQL 방언
| 패턴 | 위치 | 대체 |
|---|---|---|
| `UPDATE … RETURNING value` | `common.js getNextProjectSequence` | PostgreSQL도 지원. `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING` |
| `INSERT OR IGNORE` | `common.js`, `testing.js raiseIssueFromExecution`(raid_links 복사) | `ON CONFLICT DO NOTHING` |
| `SUM(boolean_expr)` (0/1 합산) | `requirements.js`, `changes.js`, `raid.js`, `testing.js`, `trace.js`, `app.js` 프로젝트 목록 progress | `COUNT(*) FILTER (WHERE …)` 또는 `SUM(CASE WHEN … THEN 1 ELSE 0 END)` |
| `COALESCE(SUM(...),0)` | 위와 동일 | FILTER 사용 시 COUNT는 NULL이 아니므로 제거 가능 |
| `date('now','localtime')`, `date('now','localtime','+N days')` | `raid.js TODAY`, `metrics.js` | `CURRENT_DATE`, `CURRENT_DATE + INTERVAL 'N days'` (서버 TZ 주의 — 현재는 로컬 날짜 기준) |
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` DEFAULT | `schema.sql` 모든 created_at/updated_at/changed_at | `timestamptz DEFAULT now()`; 애플리케이션은 ISO 문자열을 넣고 있으므로 컬럼 타입을 `timestamptz`로 바꾸면 비교·정렬 호환 |
| `ORDER BY h.changed_at DESC, h.rowid DESC` | 모든 history 조회 | `rowid` 없음 → `id`에 `bigserial` 보조 컬럼 또는 `created_seq` 추가 |
| `LIKE … ESCAPE '\'` 검색 | 모든 list 함수 | `ILIKE` (대소문자 무시) 로 교체 권장 |
| `TEXT` + `CHECK (x IN (...))` enum | schema 전체 | 그대로 가능. 선택적으로 PostgreSQL ENUM |
| `||` 문자열 연결 | `raid.js source_test_label` | 동일하게 동작 |
| `EXISTS` 서브쿼리/스칼라 서브쿼리 다수 | list/stat 함수 | 동일 동작, 성능은 인덱스로 보완 |

## 3. 트리거 (schema.sql, 20개)
SQLite 트리거로 강제하는 규칙. PostgreSQL에서는 `plpgsql` 트리거로 다시 쓰거나 **서비스 검증(`common.js resolveLinkTarget`)만으로 대체**할 수 있다. 서비스 검증은 이미 모든 관계 생성 경로에서 동일 프로젝트·보관·중복·유형 whitelist를 검사한다.
- 소유자 멤버십: `trg_*_owner_is_member_*` (requirements, wbs_items, issues, risks, test_cases)
- 프로젝트 불변: `trg_*_project_immutable`
- 동일 프로젝트 관계: `trg_wbs_parent_same_project*`, `trg_wbsdep_same_project`, `trg_rwl_same_project`, `trg_crr_same_project`, `trg_crw_same_project`, `trg_issue_source_same_project`, `trg_raid_same_project`, `trg_tl_same_project`, `trg_al_same_project`
- 프로젝트 생성자 멤버십: `trg_projects_creator_is_member`, `trg_projects_workspace_immutable`

polymorphic 테이블(`raid_links`, `test_links`, `acceptance_links`)은 FK를 걸 수 없으므로 PostgreSQL에서도 트리거 또는 서비스 검증 유지가 필요하다. 전환 시 `(target_type, target_id)` 조합 인덱스는 그대로 가져간다.

## 4. 마이그레이션 러너 (`server/migrations.js`)
- `PRAGMA user_version` 기반 → 버전 테이블 기반으로 교체.
- v1은 테이블 재생성(트리거 drop → rebuild) 패턴. PostgreSQL은 `ALTER TABLE`로 충분.
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 대신 현재는 `PRAGMA table_info`로 존재 여부를 확인 → `information_schema.columns`로 교체.

## 5. 애플리케이션 레벨에서 바뀌지 않는 것
- display_id 생성 규칙(`project_counters` + 원자적 증가)은 동일 설계 유지 가능 (`SELECT … FOR UPDATE` 또는 `UPDATE … RETURNING` 단독으로 충분).
- 모든 계산값(진행률, Coverage, overdue, 검증 상태)은 저장하지 않고 조회 시 계산 → 전환 시 데이터 정합 이슈 없음. 유일하게 저장되는 파생값은 `risks.risk_level`(필터용, 쓰기 시 재계산).
- 아카이브는 `archived_at` 소프트 삭제 → 그대로.
