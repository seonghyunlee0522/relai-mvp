# 엑셀 가져오기 · 일괄 변경 · 댓글/활동 · 대시보드 API

모든 경로의 BASE = `/api/workspaces/:wid/projects/:pid`. Workspace 비멤버는 404, 보관된 프로젝트에 대한 쓰기는 409(`archived`), 검증 실패는 400(`validation_error`, `fields`).
엑셀 처리는 `exceljs`(npm 의존성)를 사용한다.

## 1. 엑셀 템플릿 / 내보내기 / 가져오기 (`kind` = `requirements` | `wbs`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `BASE/{kind}/template.xlsx` | 빈 템플릿. 시트1 = 데이터(1행 헤더, 필수 헤더 파란색, 열 고정, 열거형 드롭다운 2~1001행), 시트2 = `작성 안내` |
| GET | `BASE/{kind}/export.xlsx` | 템플릿과 같은 열에 보관되지 않은 현재 데이터를 채운 파일 |
| POST | `BASE/{kind}/import/preview` | 저장하지 않고 검증. 본문 `{ data: "<base64 xlsx>" }` 또는 `{ rows: [{ row, values }], parent_id? }` |
| POST | `BASE/{kind}/import` | `{ rows: [{ row, values }], parent_id? }` — 서버에서 전체 재검증 후 유효한 행만 한 트랜잭션으로 생성(부분 성공) |
| POST | `BASE/{kind}/import/errors.xlsx` | `{ rows: [{ row, values, errors, row_errors }] }` → `원본 행` + 템플릿 열 + `오류 사유` 파일 |

* 파일명: `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<퍼센트 인코딩 한글명>` — `요구사항 등록 템플릿.xlsx`, `WBS 등록 템플릿.xlsx`, `요구사항_<프로젝트명>_<YYYYMMDD>.xlsx`, `WBS_<프로젝트명>_<YYYYMMDD>.xlsx`, ASCII 대체명 `requirements-template.xlsx` / `requirements-export.xlsx` / `requirements-import-errors.xlsx` (wbs 동일).
* 열 키 — requirements: `display_id,title,description,type,priority,scope,status,owner,requester_name,requester_organization,criteria` / wbs: `code,parent_code,item_type,title,description,owner,start,end,status,progress,predecessors`.
* 제한: 파일 5MB(413), 데이터 2,000행(400), 필수 헤더 누락(400 `missing_columns`), xlsx가 아님/깨진 base64(400 `엑셀(.xlsx) 파일을 읽을 수 없습니다.`). JSON 본문은 import 계열 3개 경로만 8MB(인증·멤버십 확인 후 파싱), 나머지는 64KB. 초과 시 413 `payload_too_large`.
* 열거형 셀은 한글 라벨 또는 영문 코드(대소문자 무시) 모두 허용. 담당자는 이메일 또는 정확한 이름(동명이인은 오류).
* 요구사항 `요구사항 ID`: 비우면 자동 채번, 입력 시 `REQ-nnn` 형식이며 프로젝트에 이미 있거나(`중복된 요구사항 ID입니다.`) 파일 안에서 중복이면 오류. 입력한 번호는 카운터를 그 값 이상으로 올려 이후 자동 채번과 충돌하지 않는다.
* WBS: `WBS Code`는 파일 내부 참조용(실제 번호는 행 순서 기준으로 `renumber()`가 다시 부여). 상위 항목은 코드에서 마지막 단계를 뺀 값(`상위 WBS`는 선택, 입력 시 일치해야 함). 마일스톤은 `종료일` 칸이 `milestone_date`, `시작일`은 비워야 한다. 선행 작업은 같은 파일의 코드, FINISH_TO_START, `addDependency`와 같은 순환 규칙(파일 순서대로 적용). 상위 항목 또는 선행 작업 행이 오류이면 해당 행도 가져오지 않는다(`상위 항목 오류로 가져오지 못했습니다.` / `선행 작업 '…'에 오류가 있어 연결할 수 없습니다.`). `parent_id`가 있으면 최상위 행이 그 아래에 생성된다.

응답(preview): `{ columns: [{ key, label, required, type, options? }], rows: [{ row, values, errors, row_errors, ok }], summary: { total, ok, error }, warnings }`.
응답(import): `{ total, created, failed, results: [{ row, ok, id?, display_id? | wbs_code?, errors, row_errors }], summary }` — `summary`는 요구사항/WBS 통계 객체.

## 2. 일괄 변경

* `POST BASE/requirements/bulk` `{ ids[≤500], action: 'update'|'archive', patch?: { owner_user_id?, status?, priority?, scope?, type? }, source_change_request_id? }`
* `POST BASE/wbs/bulk` `{ ids[≤500], action, patch?: { owner_user_id?, status?, planned_start_date?, planned_end_date?, progress?, actual_start_date?, actual_end_date? }, shift_days?: -3650..3650 }`
* 한 트랜잭션, id별 독립 검증. 없는/보관된/검증 실패 항목은 `skipped: [{ id, reason }]`로 빠지고 나머지는 적용된다. 응답 `{ updated, skipped, summary }` (+ WBS는 `archived_ids`와 `items`/`dependencies` 등 일반 WBS 응답).
* `update`는 `patch`가 비어 있고 `shift_days`도 없으면 400. `patch` 값 형식 오류(잘못된 열거값·날짜 형식·진행률 범위)와 허용되지 않은 키는 400(전체 거부), 항목별로만 알 수 있는 오류(대상이 TASK가 아님, 병합 후 종료 < 시작, Workspace 멤버가 아닌 담당자, 마일스톤에 시작/종료일)는 `skipped`.
* `shift_days`: TASK는 계획 시작/종료, MILESTONE은 `milestone_date`를 이동. SUMMARY·일정 없는 항목은 사유와 함께 건너뜀. 부모를 보관하면 하위 항목도 한 번씩 보관(ARCHIVED 이력 포함).

## 3. 댓글 · 활동

* `POST BASE/requirements/:rid/comments` / `POST BASE/wbs/:iid/comments` `{ body }` → 201 `{ comment, comments }` (본문 trim 후 1~2,000자, 오류는 `fields.body`)
* `DELETE …/comments/:cid` → `{ comments }`. 작성자 또는 Workspace OWNER/ADMIN만 가능(그 외 403 `forbidden`). 보관된 프로젝트는 409, 보관된 항목에는 댓글 허용.
* 댓글 형태 `{ id, body, created_by, author_name, created_at }`, 오래된 순. `GET …/requirements/:rid`는 `comments`, `GET …/wbs/:iid`는 `history`(최신순, `changed_by_name` 포함)와 `comments`를 추가로 반환한다.
* `wbs_history` action_type: `CREATED`, `UPDATED`(추적 필드별 1행; 담당자는 user id), `MOVED`(`field_name=parent`: 상위 WBS 코드/`(최상위)`, 같은 부모 안 순서 변경은 `field_name=sequence`: 위치 번호), `ARCHIVED`(하위 항목 포함), `DEP_ADDED`/`DEP_REMOVED`(`"코드 제목"`), `LINKED_REQ`/`UNLINKED_REQ`(요구사항 display id), `LINK_TYPE_CHANGED`(`"REQ-001 IMPLEMENTS"` → `"REQ-001 SUPPORTS"`). 요구사항 이력(`requirement_history`)은 기존 그대로 유지한다.

## 4. 대시보드

`GET BASE/dashboard` — 저장 없이 조회 시 계산. 오늘 = DB 세션 시간대(`APP_TIMEZONE`)의 `CURRENT_DATE`, "지연" = health.js와 같은 규칙(TASK, 상태 ≠ COMPLETED, `planned_end_date` < 오늘).
`{ tasks, requirements, recent_changes[≤15], overdue_tasks[≤20], workload, milestones, timeline[≤40], issues }` — 각 항목의 필드는 요청 명세와 동일. `recent_changes.href`는 `/app/projects/<pid>/` 기준 상대 경로(`requirements?sel=…`, `wbs?sel=…`, `changes?sel=…`, `issues?sel=…`, `issues?tab=risks&sel=…`, `tests?sel=…`, `tests?tab=acceptance&sel=…`, `phases/<PHASE_KEY>`).
