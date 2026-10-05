# Lifecycle V2 — Project Guidance System IA

RELAI의 정보구조는 기능이 아니라 프로젝트 생애주기 순서로 놓인다. "지금 어디에 있고, 무엇을 먼저 해야 하며, 그 일을 어느 화면에서 하는가"가 설계 기준이다.

## Lifecycle (phase_key · 이름)
| # | key | 이름 | 업무 화면 |
|---|---|---|---|
| 01 | INITIATION | 착수 | 프로젝트 정의(`/definition`, 섹션 anchor: 이해관계자/조직 · 상위 일정/마일스톤 · 운영 방식) |
| 02 | REQUIREMENTS | 요구사항 정의 | 요구사항 · 분류/우선순위(`?type=UNSPECIFIED`) · Requirement Trace(`?view=trace`) |
| 03 | ANALYSIS_DESIGN | 분석·설계 | WBS 작성(`/wbs`, planning context) · Requirements ↔ WBS Trace |
| 04 | DEVELOPMENT | 구현 | 구현 현황(`/wbs?ctx=monitor&phase=DEVELOPMENT`) |
| 05 | TESTING | 시험 | 테스트 계획(Coverage) · Tests · Defects(`?last_result=FAIL`) |
| 06 | TRANSITION_GO_LIVE | 전환 및 오픈 | **검수 / 인수 승인**(`/tests?tab=acceptance`, 첫 Gate) · 전환 계획 · 데이터 마이그레이션 · 교육 · Go-Live · 안정화(Activity) |
| 07 | OPERATIONS | 운영 및 유지보수 | 운영 이관 · 유지보수 · SLA · 정기 배포 · 종료 정리(Activity) |

"일정"은 단계가 아니다: 착수의 상위 일정(프로젝트 정의)과 분석·설계의 WBS 세부 일정 두 레벨로 관리한다. 기존 SCHEDULE / EXECUTION / ACCEPTANCE / LAUNCH 키는 폐기되었고 호환 레이어는 없다(`migrations.js` v21이 기존 DB의 phase를 착수부터 다시 생성).

## Project → Phase → Activity
- `project_phases` 7행/프로젝트, `project_steps` = Activity(`importance` REQUIRED | RECOMMENDED | OPTIONAL, `status` TODO | COMPLETED | SKIPPED).
- **상태는 파생된다** (`server/activities.js`): 저장된 status는 수동 완료/제외 표시일 뿐이고, 실제 상태(NOT_STARTED / IN_PROGRESS / COMPLETED / SKIPPED)는 요구사항·WBS·테스트·검수·Issue·변경 데이터에서 계산한다. 예: 요구사항 0건 → 수집 NOT_STARTED, 유형 미지정이 있으면 분류 IN_PROGRESS, 모두 지정 → COMPLETED.
- **Gate = REQUIRED 완료(또는 제외)**. 권장/선택은 미완료로 남아도 다음 단계로 이동할 수 있고, 미완료 상태의 이동도 확인 후 허용된다(단계는 IN_PROGRESS로 남는다). 퍼센트 진행률은 어디에도 없다.
- `wbs_items.lifecycle_phase`(nullable)로 작업을 단계에 태깅하면 04 구현/05 시험/06 전환이 같은 WBS의 자기 영역만 본다.

## Navigation
- **LNB**(`public/app/project/lnb.js`, IA 상수 `shared/lifecycle.js`): PROJECT HOME(What’s Next · Overview ▾ 프로젝트 현황/WBS/주간보고/일정·마일스톤/Project Health) → PROJECT LIFECYCLE(01~07 Accordion: 현재=파란 bar·기본 펼침, 완료=✓ 초록, 미래=회색·접힘) → PROJECT MANAGEMENT(Changes · Issues & Risks · Activity · Reports). Expanded/Collapsed 지원.
- `enabled:false` 항목(분석·설계 도구, 실행 작업, 전환/운영 하위 화면)은 IA에만 있고 렌더링하지 않는다. Coming Soon/준비 중 화면 없음.
- Top header는 프로젝트명 · 상태 · 현재 단계 · (우측) Activity · 보고서 · ⋯ · Help 만.
- What’s Next → 실제 업무 화면으로 바로 이동. 중간 Phase 상세 화면은 없다(`/phases/*`는 What’s Next로 redirect). 완료 조건·메모는 Activity 행에서 펼쳐 본다.
- CTA 규칙: 화면 이동은 업무 중심 + `→`("요구사항 입력 시작 →"), 현재 화면 Action(저장/완료 처리/제외)은 화살표 없음. Primary CTA는 영역당 1개.

## WBS dual-entry
분석·설계 > WBS 작성(`/wbs`)과 Overview > WBS(`/wbs?ctx=monitor`)는 같은 화면·같은 데이터. `ctx`는 헤더 제목("WBS 작성" / "WBS · 운영 조회")과 LNB active 판정에만 쓰인다.

## 주간보고
`/reports` 목록 · 생성 · 상세 진입(`/reports/:rid`). 기존 `server/reports.js`(기간 내 WBS/변경/Issue/테스트 이력 기반 초안)를 그대로 쓴다. AI 초안은 범위 밖.

## Landing
`public/index.html`은 앱과 동일한 Lifecycle 명칭을 쓴다(Hero flowline · Lifecycle 섹션 · What’s Next 목업). gtag `AW-18437024959` 유지. Footer의 사업자/약관/개인정보/통신판매/요금 정보는 저장소·배포 이력 어디에도 실제 값이 없어 비워 두었다(HTML 주석에 채울 자리 표시).

## Process View / Work Screen (01 착수, 2026-10-05)
- 화면 계층: Project → Lifecycle Phase → Business Activity → Work Screen → View/Tab/Function. 같은 Phase의 Activity는 동일 업무 레벨, presentation만 다를 수 있다.
- **Main Process View**(`/definition`, `project/definition.js`): 단계 설명 · 현재 해야 할 일(Primary CTA 1개, 우측) · Activity 행(목적 1줄 + 입력값 요약 + 상태) · 다음 단계 CTA(모든 Activity가 COMPLETED/SKIPPED이면 Primary, 필수만 끝났으면 link). 입력 Form·메모 없음.
- **Work Screen**: 행 선택 → 우측 Drawer(560px, 이해관계자/일정은 700px) → [확대]로 Full Screen. 같은 DOM·같은 working copy라 확대/축소 시 입력값 유지. Drawer 중첩 없음(Excel 업로드는 Modal).
- Footer: `임시저장`(PUT /definition) · `완료 처리`(POST …/sections/:key/complete + body → 저장+검증+COMPLETED 한 번에) · `↷ 이 업무 건너뛰기`(RECOMMENDED/OPTIONAL만, 확인 dialog → POST …/skip → SKIPPED) · 건너뛴 업무는 `업무 다시 시작 →`(POST …/resume).
- Phase Gate: REQUIRED = COMPLETED 필요, 그 외 COMPLETED 또는 SKIPPED. `PATCH /steps/:sid {status:'SKIPPED'}`는 REQUIRED에 409.
- 색상: 현재 Activity만 Blue left bar, 완료는 ✓ 아이콘만 Green, Skip 액션은 Amber 텍스트, SKIPPED 결과는 Gray. 라벨·배지는 Neutral 텍스트.
- 이해관계자: `org_type`(OWN/CLIENT/PARTNER/OTHER = 당사/고객사/협력사/기타) · 조직 · 부서 · 이름 · 역할. 의사결정 권한 제거. Excel: `GET …/definition/stakeholders/template.xlsx`, `POST …/definition/stakeholders/import/preview {data}` → Modal에서 검증 후 목록에 병합 → 임시저장/완료 처리로 저장. 요약은 조직 구분 → 부서 → 사람 계층.
- What's Next: 착수 Activity 행은 클릭 시 해당 Work Screen(`/definition?activity=KEY`)으로 이동. 행 CTA는 현재 Activity와 진행 중 Activity에만, 완료/미래/건너뜀 행은 CTA 없음. 메모·완료조건 섹션 제거.

## 프로젝트 생성 화면 (2026-10-05)
`/app/projects/new`는 기본 정보만 받는다: 프로젝트 이름* · 고객사명* · 프로젝트 규모/금액(선택) · 예상 시작일* · 예상 종료일* · 프로젝트 설명(선택). `프로젝트 유형`·`현재 상황`은 폼과 DB(`projects.project_type`, `current_situation`, migration v22에서 drop)에서 제거했고 새 컬럼은 `client_name`, `project_scale`. 모든 프로젝트는 ACTIVE·01 착수로 시작하며(DRAFT 분기 없음), 목표/범위/이해관계자/운영 방식은 생성 후 What's Next → 01 착수 → 프로젝트 정의 Flow에서만 입력한다. CTA는 폼 하단 우측 `[취소] [프로젝트 시작하기 →]`. 프로젝트 목록의 '유형' 컬럼은 '고객사'로 바뀌었다.
