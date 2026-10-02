# Tree WBS (Phase 12)

WBS 화면이 "유형 먼저 고르는 목록"에서 **계층형 Tree Grid**로 바뀌었다. 데이터 모델과 API는 기존 것을 유지하고 필요한 필드만 더했다.

## 데이터 구조
* 테이블 `wbs_items` 그대로. 추가 컬럼: `depth INTEGER NOT NULL DEFAULT 0`(캐시, `renumber()`가 매번 다시 씀), `weight INTEGER NOT NULL DEFAULT 1 CHECK 0~1000`(상위 진행률 가중치). 마이그레이션 v14가 기존 행의 `depth`를 재귀 CTE로 채운다.
* **그룹 = 살아있는 하위 항목이 있는 항목.** `item_type`은 더 이상 UI에서 고르지 않는다(기본 `TASK`, 마일스톤만 별도 버튼). `SUMMARY`는 레거시 값으로 API/데이터에서 계속 허용·표시되지만 새 UI·AI 초안·Excel 가져오기는 만들지 않는다. `parseWbs`는 `item_type`이 비어 있으면 `TASK`로 둔다.
* 최대 깊이 5 (`MAX_DEPTH`). 생성·이동·들여쓰기·복제 모두 하위 트리 깊이까지 검사한다.
* 트리 응답(`GET /wbs`)의 각 노드: `depth`, `children_count`, `is_group`, `computed_progress`, `rollup`(그룹이면 true), `planned_start/planned_end/actual_start/actual_end`(그룹은 하위 min/max, 리프는 자기 값), `computed_status`, `weight`.

## 번호(WBS Code)
항상 서버가 계산한다(`renumber()`, 형제 순서 기준 1, 1.1, 1.1.1 …). 생성·이동·들여쓰기·내어쓰기·복제·삭제·복구 후 전체 재번호. 보관된 항목은 번호를 차지하지 않는다.

## Roll-up
* 일정: 하위(모든 깊이)의 계획/실적 시작 min, 종료 max. 마일스톤은 `milestone_date`를 시작·종료로 센다. 그룹의 자체 날짜는 지우지 않지만 표시·집계에서는 무시한다.
* 진행률: 직계 하위(마일스톤 제외)의 Σ(progress×weight)/Σweight. `weight=0`은 제외, 모두 0이면 단순 평균. 다단계는 재귀.
* 그룹의 진행률·계획/실적 일정 PATCH는 400(`하위 작업이 있는 항목의 진행률은 하위 작업에서 자동 계산됩니다.`). 상태·담당자·가중치는 편집 가능. Bulk `progress/planned dates/shift_days`도 그룹은 사유와 함께 건너뜀.
* 지표(`metrics.js`, `dashboard.js`, `health.js`, `reports.js`, `trace.js`)는 **리프 TASK만** 센다(`LEAF_SQL`). 대시보드 타임라인은 그룹(`is_group`)과 최상위 항목만.

## 표시 상태 (`computed_status`)
`보류`(stored `ON_HOLD`, 명시 우선) > `완료`(progress 100 또는 `COMPLETED`) > `지연`(계획 종료 < 오늘, 미완료) > `진행중`(progress > 0 또는 `IN_PROGRESS`) > `예정`. 마일스톤은 완료/지연/예정. 저장 enum(`NOT_STARTED/IN_PROGRESS/COMPLETED/ON_HOLD`)은 바뀌지 않았고, 인라인 상태 셀은 저장값(예정/진행중/완료/보류)을 편집하며 지연이면 앞에 `지연` 칩을 붙인다.

## 엔드포인트 (기존 유지 + 추가)
* `POST /wbs/:id/indent`, `/outdent` → `{ item, undo:{from,to}, items, summary }` (undo는 `/move`에 `from`을 그대로 보내면 됨)
* `POST /wbs/:id/duplicate` `{ with_children? }` → 201 `{ item, created_ids, items, summary }` — 바로 뒤에 `"(복사)"`로 복제
* `POST /wbs/:id/archive` `{ children:'cascade'|'promote' }` — 기본 cascade(기존 동작), promote는 하위를 삭제 항목 자리로 올림
* `POST /wbs/:id/restore` — 같은 시각에 보관된 하위까지 복구(409 `not_archived`)
* `POST /wbs/import/inspect` `{ data }` → `{ headers, sample, suggested, layout:'levels'|'code'|'flat', fields }`; `POST /wbs/import/preview` `{ data, mapping }`로 매핑 적용. 매핑 없이 보내면 기존 템플릿 경로 그대로.

## Excel 가져오기 레이아웃
1. **WBS Code 열**: `1`, `1.`, `1-1-1` 모두 정규화. 상위는 코드에서 유추.
2. **Lv1~Lv5 열**: 파일 순서로 걸으며 비어 있는 상위는 직전 노드로, 같은 라벨이 반복되면 재사용, 새 라벨이면 새 그룹(번호는 카운터로 생성).
3. **둘 다 없음**: 모든 행이 최상위.
그룹 행의 진행률(0 제외)은 오류, 상태·담당자·설명은 그대로 저장. 가져오기 결과는 전부 `TASK`(유형 열이 `마일스톤`이면 `MILESTONE`).

## 변경 이력 (`wbs_history`)
자동 기록: title, description, status, owner, progress, weight, 계획/실적 일정, milestone_date(UPDATED), 상위/순서(MOVED), ARCHIVED/RESTORED, DEP_*, LINKED_REQ/UNLINKED_REQ/LINK_TYPE_CHANGED, CREATED(복제·AI·가져오기 출처 포함).

## 프런트 (`public/app/wbs/page.js`)
* 컬럼: WBS · 업무명 · 계획 시작 · 계획 종료 · 진행률 · 담당자 · 상태 (기본), 실적 시작/종료 · 가중치 · 유형 (숨김, `컬럼` 메뉴). 첫 두 컬럼·헤더 고정, 설정은 `grid.wbs.tree` 키로 저장.
* 인라인 추가: `+ 항목 추가`/`◆ 마일스톤 추가`/행 `+`/행 메뉴 → 고스트 행에서 Enter 생성(연속 입력), Esc 취소, Tab 들여쓰기. `?new=1&parent=<id>&type=MILESTONE` 지원.
* 행 메뉴(⋯): 하위 작업 추가 / 같은 레벨 작업 추가 / 마일스톤 추가 / 들여쓰기 / 내어쓰기 / 복제 / 삭제.
* DnD(HTML5): 제목 셀의 ⋮⋮ 핸들. 위 30% 앞으로, 아래 30% 뒤로, 가운데 안으로(마일스톤 안으로는 불가). 자기 자신·하위로는 drop 불가. 이동·들여쓰기·내어쓰기·삭제는 6초 `실행 취소` 토스트.
* 삭제: 하위가 있으면 `하위 작업과 함께 삭제 / 하위 작업을 상위 레벨로 이동 후 삭제 / 취소` 선택 창.
* 상세(큰 모달): 기본 정보 / 관련 요구사항(N:M, 연결 유형) / 선행 작업(순환 검증은 서버) / 변경 이력 / 댓글.
* 검색은 이름·번호, 조상은 항상 함께 표시. 담당자/상태(계산값)/빠른 보기 필터. Gantt는 그룹 roll-up 일정을 사용.
