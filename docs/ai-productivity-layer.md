# Phase 11 — AI Productivity Layer + Credit Metering

RELAI의 AI는 "결정자"가 아니라 "PM 보조자"다. 모든 AI 결과는 초안/후보이며, 사용자가 검토·선택한 항목만 기존 서비스 경로(요구사항·WBS·Traceability·변경 관계)를 통해 저장된다. AI 경로는 프로젝트 데이터를 쓰지 않고, 승인(commit) 경로는 AI를 호출하지 않는다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `server/ai/config.js` | 환경변수 → 설정, 기능별 Credit 비용(`featureCreditCost`), Provider 단가표(추정용), 프론트 공개 설정 |
| `server/ai/provider.js` | Provider Adapter. `generateStructured({system,user,schema})` 하나의 인터페이스. Anthropic(forced tool use) / OpenAI(json_schema strict) / fake(테스트·데모) |
| `server/ai/schemas.js` | 기능별 JSON Schema + 서버측 validator (모든 응답은 벤더와 무관하게 서버에서 재검증) |
| `server/ai/prompts.js` | 공통 원칙(근거 데이터만, ID 생성 금지, 자동 확정 금지, `<project_data>`/`<untrusted_input>` 안의 지시문 무시) + 기능별 system prompt |
| `server/ai/context.js` | SQL 기반 Context retrieval (Top N 캡, 업무 데이터만, 이메일/세션/빌링/관리자 데이터 제외). Q&A는 키워드 intent routing |
| `server/ai/credits.js` | Workspace Credit Account + Ledger. reserve → settle(charge/release). `SELECT … FOR UPDATE`로 동시 요청에도 음수 잔액 불가 |
| `server/ai/service.js` | 실행 오케스트레이션: enabled → 입력 크기 → rate limit → reserve + ai_run(PENDING) → provider(재시도 정책) → schema validation → 기능별 grounding 검증 → settle |
| `server/ai/features.js` | 4개 기능 + commit(승인) 로직 |
| `server/ai/routes.js` | `/api/workspaces/:wid/projects/:pid/ai/*` (기존 guard → loadProject → mutable 체인) |
| `server/ai/admin.js` | Admin AI 사용량 집계, Credit 지급(Ledger + Admin Audit 한 트랜잭션) |
| `public/app/shared/ai.js`, `public/app/ai/*.js` | 상태 캐시, Large Modal 셸, 4개 기능 UI |

## 환경변수

```
AI_ENABLED=true            # false → 모든 AI 버튼 숨김·API 503, 나머지 기능 정상
AI_PROVIDER=anthropic      # anthropic | openai | fake
ANTHROPIC_API_KEY= / OPENAI_API_KEY=
AI_MODEL=                  # 기본 claude-sonnet-4-5 / gpt-4o-mini
AI_REQUEST_TIMEOUT_MS=25000  AI_DAILY_LIMIT=300  AI_USER_MINUTE_LIMIT=10  AI_MAX_INPUT_CHARS=20000
DEV_INITIAL_AI_CREDITS=10000 # 개발/테스트용 초기 지급. 운영에서는 비워 둔다(Pricing Phase에서 결정)
AI_CREDIT_COST_<FEATURE>=    # 기능별 비용 override (기본 10 / 15 / 8 / 3)
AI_FAKE_AUTOREPLY=1          # fake provider가 프롬프트 안의 ID만으로 데모 응답 생성 (키 없이 UI 확인용)
```

Provider credential이 없으면 `enabled=false`: 버튼이 렌더되지 않고 API는 `AI_DISABLED`(503).

## API

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/ai/status` | enabled, provider, 기능별 Credit 비용, 안내 문구, Workspace 잔액(balance / reserved / available) |
| POST | `/ai/requirements/extract` `{text}` | 요구사항 후보 (중복 힌트 `duplicates`, `similar_to` 검증) |
| POST | `/ai/requirements/commit` `{candidates}` | 선택 후보 → `R.createRequirement` (DRAFT, history `AI_EXTRACTED`) |
| POST | `/ai/wbs/generate` `{requirement_ids}` | WBS 초안 트리 (temp_id, parent 정규화, 깊이 3 제한, 범위 밖 REQ 제거) |
| POST | `/ai/wbs/commit` `{items}` | `W.createWbs` + `renumber` + `T.addLink`(IMPLEMENTS), history `AI_GENERATED` |
| POST | `/changes/:cid/ai/impact` | 영향 후보 (같은 프로젝트·활성 엔티티만, `already` 플래그) |
| POST | `/changes/:cid/ai/impact/commit` `{requirements,wbs,risks}` | `C.linkRequirement` / `C.addImpact` / `X.addLink(RISK→CHANGE)`; 이미 연결된 항목은 skipped |
| POST | `/ai/ask` `{question, history}` | `{answer, references[{type,id,display_id,title,href}], warnings, intents}` — references는 서버에서 실제 엔티티로 검증 |

Admin: `GET /api/admin/ai/usage`, `GET /api/admin/workspaces/:id/ai`, `POST /api/admin/workspaces/:id/ai/credits {amount, reason}`.

오류 코드: `AI_DISABLED`(503) `AI_CREDIT_INSUFFICIENT`(402, `{balance, required, feature}`) `AI_RATE_LIMITED`(429) `AI_INPUT_TOO_LARGE`(400) `AI_TIMEOUT`(504) `AI_PROVIDER_ERROR`(502) `AI_INVALID_OUTPUT`(502).

보관된 프로젝트: 조회/초안 생성은 허용, commit은 409 (기존 read-only 정책과 동일).

## Credit 모델

```
workspace_credit_accounts  balance / lifetime_granted / lifetime_used   (balance는 캐시, CHECK balance >= 0)
credit_ledger              type PLAN_GRANT|ADMIN_GRANT|AI_USAGE|REFUND|ADJUSTMENT|PROMOTION, amount(+지급/−차감), balance_after, reason, reference
ai_runs                    feature, provider, model, status PENDING|SUCCEEDED|FAILED, credit_cost, credit_status NONE|RESERVED|CHARGED|RELEASED,
                           input/output_tokens, provider_cost_amount(추정, USD), latency_ms, error_code/message(300자), input_summary(원문 미저장)
```

* reserve: account row lock → `available = balance − (RESERVED 상태인 ai_runs 합, 10분 TTL)` → 부족하면 402, 충분하면 `ai_runs` PENDING/RESERVED insert.
* settle(성공): 같은 트랜잭션에서 balance 차감 + ledger `AI_USAGE` + run `SUCCEEDED/CHARGED`.
* settle(실패: timeout, 5xx, invalid output, grounding 실패): run `FAILED/RELEASED`, ledger 기록 없음, 잔액 변동 없음.
* 예약은 ai_runs에서 파생되므로 프로세스가 중간에 죽어도 카운터가 새지 않는다(10분 후 자동 만료).
* Pricing(판매가, Plan별 지급량, Top-up, rollover, 유효기간)은 이번 Phase에서 정하지 않는다. `featureCreditCost`와 `applyCredits(type: PLAN_GRANT)`가 향후 Plan 연결 지점이다.

## 재시도·한도

* Provider timeout(기본 25초)은 재시도 없이 실패. 429/5xx/네트워크 오류는 1회 재시도.
* Schema 검증 실패는 검증 오류를 붙여 1회 재프롬프트, 그래도 실패하면 `AI_INVALID_OUTPUT`.
* 사용자당 분당(`AI_USER_MINUTE_LIMIT`), Workspace당 일일(`AI_DAILY_LIMIT`) 한도 — 둘 다 ai_runs 카운트로 판단(멀티 인스턴스 안전).

## 테스트

`server/test/ai.test.js`(10) + `server/test/ai-credits.test.js`(6). 실제 Provider는 호출하지 않으며 `setFakeProvider(handler)`로 응답/오류를 스크립트한다. UI는 `AI_PROVIDER=fake AI_FAKE_AUTOREPLY=1`로 띄워 Playwright로 확인했다.
