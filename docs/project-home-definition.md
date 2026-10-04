# 프로젝트 홈 · 프로젝트 정의 (Overview/프로세스 개편)

## 화면 역할
* **프로젝트 홈** (`/app/projects/:id`, `project/overview.js`) — 조회 전용. 현재 단계와 단계 준비율(할 일 완료 수) → 다음 할 일(각 업무 화면으로 링크) → 실행 진척률(WBS 기준, WBS가 없으면 집계 전 안내) → 확인 필요·7일 내 일정 → 요약 바·상태 → 진행 단계(7단계, 기록 조회 링크). 입력 폼·체크박스 없음. 단계 이동은 확인 대화상자(`moveToPhase`)로만.
* **프로젝트 정의** (`/app/projects/:id/definition`, `project/definition.js`) — 착수 단계 업무 화면. 탭 "프로세스" 자리를 대체. 5개 섹션(목표·성공 기준 / 수행·제외 범위 / 이해관계자 / 주요 일정·마일스톤 / 운영 방식) + 선택 메모.
* **단계 기록** (`/app/projects/:id/phases/:KEY`, `project/phase.js`) — 탭에서는 빠지고 홈의 진행 단계·헤더 단계 링크·⋯ 메뉴에서 진입. 할 일 완료 처리·메모·현재 단계 변경(확인 후)은 여기. `INITIATION`은 프로젝트 정의로 리다이렉트.

## 데이터
* `project_definitions` (project_id PK): goal, success_criteria/scope_in/scope_out `[{id,text}]`, stakeholders `[{id,name,org,role,area,authority(DECIDER|APPROVER|CONSULTED|INFORMED),note}]`, key_dates `[{id,title,date,note}]`, operations `{meetings,reporting,communication,decisions}`, memo, section_updated `{KEY: ts}`. 마이그레이션 v14(스키마만).
* **완료 상태는 저장하지 않는다.** 섹션 완료 = INITIATION 단계의 step(GOALS/SCOPE/STAKEHOLDERS/MILESTONES/OPERATIONS) status. 홈·헤더 진행률·단계 기록이 모두 같은 값을 읽는다.
* 기존 step `note`는 그대로 보존되어 섹션의 "참고 기록 (이전 메모)"로 읽기 전용 표시. 자동 해석·이관 없음.
* WBS 마일스톤·프로젝트 기간은 정의 화면에서 조회만(링크), 중복 저장하지 않음.

## API
* `GET /projects/:pid/definition` → `{definition, sections[{key,label,step_id,status,completed_at,completed_by_name,updated_at,changed_after_completion,ready,missing[],legacy_note}], progress, needs_review[], project_dates, wbs_milestones}`
* `PUT /projects/:pid/definition` 부분 저장(보낸 필드만). 저장과 완료 분리: 빈 섹션도 저장 가능.
* `POST /projects/:pid/definition/sections/:KEY/complete|confirm|reopen` — complete/confirm은 최소 내용(ready) 필요. 응답에 `guide`(= GET /:pid) 포함.
* `GET /projects/:pid`에 `definition {progress, needs_review, sections(요약)}` 추가.

## 완료·재확인 규칙
완료된 섹션을 수정하면 완료는 유지되고 `changed_after_completion`(section_updated > completed_at)으로 표시 → "다시 확인 완료"(confirm)로 completed_at 갱신. "완료 취소"(reopen)는 내용은 남기고 step만 TODO. 홈·탭 배지에 재확인 필요 수 노출.


> **Lifecycle V2 (2026-10)**: 이 문서의 Phase/Step·진행률 설명은 V1 기준이다. 현재 구조(7단계 Lifecycle, Activity importance, 파생 상태, LNB)는 `docs/lifecycle-v2.md`를 본다.
