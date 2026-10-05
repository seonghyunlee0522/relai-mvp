# Workspace Home — 프로젝트별 상황 카드 (2026-10)

## 화면 역할
* **Home** (`/app`, `project/home.js`) — "각 프로젝트가 지금 어디까지 왔고, 내가 다음에 무엇을 해야 하는가?" 프로젝트별 상황 카드. 통계 Dashboard가 아니다.
* **Projects** (`/app/projects`, `project/list.js`) — 검색 · 상태 필터 · 보관 조회 · 정렬 · 목록 관리 Table. 변경 없음. 두 화면에 같은 프로젝트가 보여도 중복이 아니다 (목적이 다름).
* Project Home(What's Next) · Overview · Lifecycle · Navigation 은 그대로. Home 은 *무엇을 먼저 보여줄지*만 결정한다.

## 카드 구성 (위 → 아래)
1. 우선순위 배지 · 프로젝트명 · 고객사 · 상태 chip
2. 현재 단계 `NN 단계명` + Lifecycle 인디케이터(`.lcpos`, Projects 와 동일) · (D-7 이내 마일스톤이 있으면 `D-n 제목`)
3. **다음 할 일** — What's Next 의 `guidance.title` + `primary_action` 을 그대로. CTA 는 실제 업무 화면으로 직행 (Home → WBS, Home → Requirements …). `?move=next`(단계 전환)만 Project Home 으로 보내 기존 확인 대화상자를 거친다.
   * 모니터링형 rule(`DEV_STATUS`, `TRANSITION_RUN`, `OPS_HANDOVER`)은 버튼 대신 "정상 진행 중 · 다음 확인 {가까운 마일스톤}" + 보조 링크. 억지 CTA 없음.
   * DRAFT / ON_HOLD 는 상태 문구 + 링크만.
4. 한 줄 요약: 진행률 · 일정 상태(`scheduleState`, Overview 와 동일) · 확인 필요 N건 · Project Health chip
5. 확인 필요 항목 최대 3건 (`attentionAll` 상위) + "외 n건 →" (Overview #att)
6. 주요 일정 최대 3건 — `upcomingDates` 중 MILESTONE · KEY_DATE · PROJECT_END, 오늘 이후만 (지난 일정 제외)

## 우선순위 (정렬 + 배지, `server/home.js homePriority`)
| key | 조건 | 표시 |
|---|---|---|
| BLOCKER | Health CRITICAL 또는 attention crit > 0 또는 Blocked Issue > 0 | 빨강 Blocker |
| ATTENTION | attention 항목 ≥ 1 | 주황 확인 필요 |
| ACTION | guidance kind = ACTION (기본) | 파랑 Action 필요 |
| NORMAL | 모니터링형 rule, attention 0 | 초록 정상 |
| WAITING | status DRAFT / ON_HOLD | 회색 대기 |

같은 우선순위 안에서는 가까운 마일스톤 순 → 이름순. COMPLETED 는 카드 밖 접힌 영역(한 줄 row), ARCHIVED 는 Home 에 없음(Projects 에서 조회).

## API
`GET /api/workspaces/:wid/projects/home` → `{ projects: Card[], completed: Row[], counts: {BLOCKER,ATTENTION,ACTION,NORMAL,WAITING}, today }`
* `Card`: 리스트 행 필드 + `guidance {rule, kind, title, description, primary_action, secondary_action, warnings}` · `next_phase` · `wbs {tasks, progress, planned_progress, variance, overdue_tasks, overdue_milestones, max_overdue_days, tasks_without_dates}` · `health {status, status_label, partial_unknown}` · `attention {total, crit, items[≤3]}` · `upcoming[≤3]` · `next_date` · `next_date_days` · `soon` · `priority` · `priority_label`
* 라우트는 `/:pid` 보다 먼저 등록된다 (Express 순서 매칭).
* 저장하는 값 없음. `guidanceContext()`(home.js) 가 `GET /:pid` 와 공유되므로 **Home 과 What's Next 의 Next Action 은 항상 같다** (`server/test/home.test.js` 에서 검증).
* 비용: 프로젝트당 stats + definition + guide + health + attention + upcoming (≈25 쿼리), 동시성 4. COMPLETED 는 계산하지 않는다.

## Density
Desktop(>1100px) 2 column, 그 아래 1 column. 카드 높이 ≈ 160–240px (확인 필요 항목 수에 따라). 큰 KPI 숫자 · 그래프 · 긴 설명문 없음.
