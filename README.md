# RELAI — Phase 1~9 + Production Readiness (PostgreSQL · Role Enforcement)

## 실행
    npm install
    createdb relai && createdb relai_test
    cp .env.example .env               # DATABASE_URL, SESSION_SECRET …
    DATABASE_URL=postgres://…/relai npm start      # http://localhost:3000   (Node >= 22.13, PostgreSQL >= 14)
    npm test                            # TEST_DATABASE_URL(기본 postgres://postgres@127.0.0.1:5432/relai_test) 안에 임시 스키마로 격리 실행
    npm run migrate:sqlite -- --sqlite data/relai.db   # 기존 SQLite 데이터 이전 (행 수·orphan 검증 포함)

환경변수와 운영 사항: `docs/production-readiness.md` (PostgreSQL 구조, 세션, Rate Limit 한계, Role 정책, Billing Webhook 설계 주의사항)

## 구조
- `public/index.html` 랜딩(운영 SaaS 기준 카피 · 로그인/회원가입 CTA, 로그인 상태면 "프로젝트로 이동")
- `public/app/` App SPA (index.html, app.css, app.js) — 랜딩과 동일한 디자인 토큰
- `server/db.js` PostgreSQL 접근 계층(`pg` Pool, `?`→`$n`, `tx(db, async (t) => …)`, 타입 파서, 오류 매핑) · `server/schema.sql` 멱등 스키마(plpgsql 무결성 트리거 포함) · `server/migrations.js` 버전 마이그레이션(`schema_migrations`) · `server/app.js` API/라우팅/접근제어 · `server/authz.js` Workspace Role 정책(OWNER/ADMIN/MEMBER, 멤버 관리, 마지막 OWNER 보호) · `server/security.js` 해시/세션 토큰/인메모리 Rate Limit
- `scripts/migrate-sqlite-to-postgres.js` SQLite → PostgreSQL 데이터 이전 + 검증(`--validate`)
- `server/raid.js` Issue/Risk(ISS/RSK 번호·Risk Matrix·상태 전이·Risk→Issue 전환·WBS/요구사항/변경요청 N:M 연결)
- `server/common.js` 공통 도메인 헬퍼 — 프로젝트별 display ID 시퀀스(`getNextProjectSequence`/`nextDisplayId`), 관계 대상 검증(`resolveLinkTarget`: 유형 whitelist·동일 프로젝트·보관 제외·중복 방지)
- `server/metrics.js` 프로젝트 지표 서비스 — `projectStats`/`headlineKpis`(4 KPI)/`attentionAll`(13종 후보, 우선순위 사다리)/`upcomingDates`(7일)/`projectSnapshot` (전부 조회 시 계산)
- `server/health.js` Project Health (Phase 9) — Schedule/Scope/Quality/Change/Risk 5개 dimension + Overall, 임계값은 `HEALTH_RULES`, 저장하지 않음
- `server/reports.js` Weekly Report — `buildReportData`(구조화 데이터, History 기준 기간 집계) → `sectionsFromData`(편집 가능한 8개 섹션) → `renderMarkdown`; `weekly_reports` 테이블(DRAFT/FINAL)
- `server/testing.js` Test Case(TC 번호·절차·불변 실행 이력·최근 결과)·요구사항/WBS 연결·Coverage·검증 상태·Fail→Issue 등록·Acceptance(ACC 번호·DRAFT→REQUESTED→ACCEPTED|REWORK_REQUIRED|REJECTED·요구사항/테스트 연결)
- `server/changes.js` 변경 요청(CR-001·워크플로·요구사항 연결·WBS 후보/영향·Impact·History)
- `server/trace.js` Requirement ↔ WBS N:M 링크·Coverage·가이드 통계
- `server/wbs.js` WBS(계층·코드 재계산·이동·Progress 롤업·FS Dependency·사이클 방지)
- `server/requirements.js` 요구사항(번호 생성·CRUD·완료조건·History·검색/필터·통계)
- `server/guide.js` 가이드 엔진(Phase/Step 생성·진행률·단계 전환) · `server/templates/default-phases.js` 기본 7단계×5 템플릿
- `server/importspec.js` · `server/xlsx.js` · `server/importer.js` 엑셀 템플릿/내보내기/가져오기(요구사항·WBS, `exceljs`) — 스펙(열·라벨·옵션), 파일 I/O, 검증 + 부분 성공 생성(한 트랜잭션)
- `server/bulk.js` 일괄 변경/보관(요구사항·WBS, 항목별 검증 + `skipped`) · `server/comments.js` 요구사항/WBS 댓글 · `server/wbs-history.js` WBS 변경 이력(`wbs_history`) · `server/dashboard.js` 프로젝트 대시보드(조회 시 계산) · `server/routes-extra.js` 위 기능의 라우트(`app.js`에서 mount)
- `server/test/api.test.js`

## Route
프런트엔드(`public/app`, ES module): `app.js`(라우트 등록) · `core/{dom,api,state,router,ui}.js` · `shell.js` `auth.js` `settings.js` · `shared/{constants,badges,dialogs,filters,empty-state,drawer,trace-strip,grid,bulk,detail,importer}.js` · `project/{list,form,guide,overview,phase}.js` · `requirements/page.js` `wbs/page.js` `changes/page.js` `raid/page.js` `testing/page.js`

화면: `/login` `/signup` `/app` `/app/projects` `/app/projects/new` `/app/projects/:id` `/app/projects/:id/edit` `/app/projects/:id/phases/:phaseKey` `/app/projects/:id/requirements[?view=trace&q&type&priority&scope&status&owner&link=linked|unlinked&archived&sel&new]` `/app/projects/:id/issues[?tab=risks&q&status&severity|probability&impact&risk_level&response_strategy&owner&wbs&requirement&change&overdue=1|review=1&archived&sel&new]` `/app/projects/:id/changes[?q&status&priority&requester&requirement&schedule=1&cost=1&archived&sel&new]` `/app/projects/:id/wbs[?view=gantt&f=no_owner|no_dates|linked|unlinked|overdue&sel&new&parent&type]` `/app/projects/:id/tests[?tab=cases|acceptance|coverage&q&status&priority&owner&last_result&requirement&wbs&archived&sel&new]` `/app/settings`
API: `POST /api/auth/{signup,login,logout}` · `GET /api/me` · `GET|POST /api/workspaces/:wid/projects` · `GET|PATCH /api/workspaces/:wid/projects/:pid` · `POST …/:pid/archive` · `PATCH …/:pid/steps/:sid` {status|note} · `POST …/:pid/phases/:phid/activate` {reason: NEXT|MANUAL} · `GET /api/workspaces/:wid/members` · `GET|POST …/:pid/requirements` · `GET|PATCH …/requirements/:rid` · `POST …/:rid/archive` · `POST …/:rid/criteria` · `PATCH|DELETE …/:rid/criteria/:cid` · `GET|POST …/:pid/wbs` · `GET|PATCH …/wbs/:iid` · `POST …/wbs/:iid/move|archive|dependencies` · `DELETE …/wbs/:iid/dependencies/:did` · `POST …/requirements/:rid/links` `PATCH|DELETE …/requirements/:rid/links/:lid` · `POST …/wbs/:iid/links` `PATCH|DELETE …/wbs/:iid/links/:lid` · `GET|POST …/:pid/changes` `GET|PATCH …/changes/:cid` `POST …/changes/:cid/transition|archive` `POST …/changes/:cid/requirements` `PATCH|DELETE …/requirements/:lid` `POST …/changes/:cid/impacts` `PATCH|DELETE …/impacts/:iid` · `GET|POST …/:pid/issues|risks` `GET|PATCH …/:xid` `POST …/:xid/archive|links` `DELETE …/:xid/links/:lid` `POST …/risks/:xid/convert` · `GET|POST …/:pid/tests` `GET …/tests/coverage` `GET|PATCH …/tests/:tid` `POST …/tests/:tid/archive|executions|links` `DELETE …/tests/:tid/links/:lid` `POST …/tests/:tid/executions/:eid/issue` · `GET|POST …/:pid/acceptances` `GET|PATCH …/acceptances/:aid` `POST …/acceptances/:aid/transition|archive|links` `DELETE …/acceptances/:aid/links/:lid` · `GET …/:pid/snapshot` (stats·kpis·health·attention(7)+attention_total·upcoming 7일) · `GET …/:pid/health` · `GET …/:pid/attention`(전체) · `GET /health`(앱·DB 상태) · `GET|PATCH /api/workspaces/:wid`(권한 맵 포함, PATCH는 OWNER/ADMIN) · `GET|POST /api/workspaces/:wid/members` `PATCH|DELETE …/members/:uid`(OWNER/ADMIN, OWNER 부여·회수는 OWNER만) · `DELETE /api/workspaces/:wid`(OWNER, 501 placeholder) · `GET …/:pid/weekly-reports` (+default_period) `POST …/weekly-reports/generate` {period_start, period_end} `GET|PATCH …/weekly-reports/:rid` {title?, sections?:[{key, body}]} `POST …/weekly-reports/:rid/finalize|reopen` · `PATCH …/requirements/:rid` body에 `source_change_request_id` 추가 시 History에 변경 출처 CR 기록

문서: `docs/production-readiness.md` · `docs/postgres-migration-notes.md`(전환 완료 기록) · `docs/schema.sqlite.legacy.sql`(이전 스크립트용 구 스키마)

추가 API(상세 요청/응답은 `docs/excel-bulk-comments-dashboard.md`): `GET …/requirements|wbs/template.xlsx` `GET …/requirements|wbs/export.xlsx` · `POST …/requirements|wbs/import/preview` {data(base64 xlsx) | rows, parent_id?} `POST …/requirements|wbs/import` {rows, parent_id?} `POST …/requirements|wbs/import/errors.xlsx` {rows} · `POST …/requirements|wbs/bulk` {ids, action: update|archive, patch?, shift_days?(WBS), source_change_request_id?(요구사항)} · `POST …/requirements/:rid/comments` `POST …/wbs/:iid/comments` {body} `DELETE …/comments/:cid` · `GET …/:pid/dashboard` · `GET …/wbs/:iid` 응답에 `history`(WBS 변경 이력)·`comments`, `GET …/requirements/:rid` 응답에 `comments` 추가

의존성: 엑셀 입출력에 `exceljs`(`npm install`로 설치). 가져오기 JSON 본문은 `…/import*` 경로에 한해 8MB까지 허용(파일 5MB·2,000행 제한), 그 외 JSON은 64KB.

UI/UX 개편(Project Workspace · Data Grid · Excel Import · Bulk · Activity): `docs/ux-overhaul.md`
