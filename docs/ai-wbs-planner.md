# Phase 15 — AI Project WBS Planner

## What it does
WBS › **[AI로 WBS 만들기]** opens a 6-step wizard: 대상 확인 → 추가 확인 질문 → AI WBS 초안 생성 → 초안 검토 → Coverage 검토 → WBS 반영.
RELAI reads the project (definition, requirements, existing WBS, type), judges which **delivery areas** the project needs
(PROJECT_MANAGEMENT, ANALYSIS_DESIGN, FUNCTIONAL_DEVELOPMENT, NON_FUNCTIONAL, INTERFACE, DATA_MIGRATION, INFRASTRUCTURE, SECURITY,
ENVIRONMENT, TESTING, UAT, DEPLOYMENT, CUTOVER, TRAINING, DOCUMENTATION, OPERATION_HANDOVER, STABILIZATION, OTHER), asks only about
areas it cannot settle from the data (max 8 structured questions), generates a full-project WBS draft, computes requirement +
delivery coverage, lets the user edit/select, and commits only the selected candidates through the existing `commitWbs()`.

## Reuse
- Provider / credits / rate limits / structured output / retry: `runAiFeature()` (service.js) — unchanged; `schema` override added.
- `commitWbs()` (features.js) creates WBS + requirement links + `AI_GENERATED` history (`source=AI Project WBS Planner (plan_id=…)`).
- Credits: **one `WBS_GENERATION` charge per plan** (draft generation). `WBS_PLAN_QUESTIONS` and `WBS_PLAN_FIX` runs cost 0 credits but record tokens / provider cost in `ai_runs`.

## Data
`ai_wbs_plans` (migration v20): status DRAFT → QUESTIONS_READY → GENERATING → REVIEW → COMMITTED | CANCELLED; `requirement_ids`,
`areas`, `questions`, `answers`, `draft` (normalized candidates), `coverage`, `ai_run_id` / `question_run_id`, `commit_result`.
Raw provider responses are never stored.

## API (`/api/workspaces/:wid/projects/:pid/ai/wbs-plans`)
`GET` (active + recent), `POST { all | requirement_ids }`, `GET /:planId`, `PATCH /:planId/answers`, `POST /:planId/generate`,
`POST /:planId/coverage { items }` (save edits + recompute, no AI), `POST /:planId/fix { areas? }`, `POST /:planId/commit { items }`
(mutable project only, idempotent), `POST /:planId/cancel`.

## Guards
Questions / candidates / areas are post-validated on the server (`normalizeQuestions`, `normalizeCandidates`): invalid areas →
dropped / OTHER, settled areas never asked, ≤ 8 questions, ≤ 8 options, hallucinated requirement ids stripped, no SUMMARY,
milestones have no children, depth ≤ WBS rule (5), ≤ 80 candidates, cycles broken, candidates similar to existing WBS flagged and
deselected by default. Coverage is deterministic (candidates + answers + existing WBS), never an AI claim.

## Real OpenAI smoke test (manual — never in CI)
Local `.env` (never commit; `.gitignore` already excludes `.env`):
```
AI_ENABLED=true
AI_PROVIDER=openai
OPENAI_API_KEY=<직접 입력>
AI_MODEL=<현재 사용 가능한 Structured Outputs 지원 모델, 예: gpt-4o-mini / gpt-4.1-mini>
AI_REQUEST_TIMEOUT_MS=60000
AI_MAX_OUTPUT_TOKENS=8000
DEV_INITIAL_AI_CREDITS=1000
```
1. `npm start`, sign in, create project **ERP 구축** (SI), definition goal "고객사 Azure, 기존 시스템 데이터 존재", requirements REQ-001 로그인 기능 / REQ-002 권한 관리 / REQ-003 사용자 조회.
2. WBS → [AI로 WBS 만들기] → 전체 요구사항 → 질문이 데이터 이관 / 외부 연계 / 교육·전환 등 컨텍스트에 맞게 생성되는지 확인 (Azure가 정의에 있으면 인프라는 묻지 않음).
3. Answer: 데이터 이관 있음, SSO 연계 있음, 사용자 교육 필요 → 초안 생성 → 기능 구현 / 데이터 이관 / Azure 환경 / SSO 연계 / 테스트 / 교육 / 전환 작업 확인.
4. Coverage → 필요 시 [누락 작업 추가 제안] → [WBS에 반영] → WBS 트리와 요구사항 연결 확인. Admin › Usage에서 `WBS_GENERATION` 1건 과금, `WBS_PLAN_QUESTIONS` 0 credit + 토큰 기록 확인.
Logs show feature / model / provider / duration / tokens / cost only — never the key, prompt or raw response.
