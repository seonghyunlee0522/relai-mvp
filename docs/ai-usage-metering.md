# AI 이용량 (Usage Metering) — 2026-10-27

AI 크레딧을 폐지하고, AI 제공사 API의 실제 비용(USD)으로 워크스페이스 AI 이용량을 관리한다.
사용자에게는 사용률(%)만, 관리자에게는 토큰·비용(USD, 원화 환산)을 보여 준다.

## 정책

| 플랜 | 내부 한도 (USD, 비공개) | 제공 주기 |
|---|---|---|
| Free | $2 | 최초 1회 (소유자 계정·이메일당 1개 워크스페이스, `free_credit_claims`) |
| Pro | $10 | 매월 (구독 `current_period_start` 기준 지급 주기), 이월 없음 |
| Team | $30 | 매월, 이월 없음 |
| Enterprise | 무제한 (계약) | `AI_LIMIT_USD_ENTERPRISE`로 지정 가능 |

- 실패한 요청도 사용한 토큰만큼 반영한다. 응답이 없던 타임아웃은 최악 비용(입력 글자 수 + 출력 상한)으로 반영하고 `cost_estimated = true`로 표시한다.
- 기능별 횟수 제한은 없다. 남용 방지용 분당(사용자 10회)·일일(워크스페이스 300회) 호출 제한은 유지한다.
- 업그레이드(Pro → Team)는 현재 주기에 즉시 Team 한도를 적용한다. 해지·만료로 Free가 되면 Free 기간에 쓴 이용량(`plan_key` FREE)만 Free 한도에 합산한다.
- 사용자 화면에는 금액·토큰·단가·한도 금액을 노출하지 않는다(API도 보내지 않음). 요금 안내는 모든 플랜 "AI 이용량 포함".

## 구조

```
runAiFeature (server/ai/service.js)
  ├ 입력 검사 · 분당/일일 제한
  ├ reserveRun (ai/usage-limit.js): 워크스페이스 advisory lock → 사용액 + 미정산 예약 ≥ 한도면 402 AI_USAGE_LIMIT_REACHED
  │                                 → ai_runs PENDING (plan_key, reserved_usd = 최악 비용 × 2)
  ├ provider 호출 (input / output / cached 토큰; 오류에도 usage 보존)
  └ settleRun: provider_cost_amount = (input − cached) × 입력 단가 + cached × 캐시 단가 + output × 출력 단가 (USD)
사용률 = SUM(provider_cost_amount, 현재 창) ÷ 한도
```

- 현재 창: Free = `plan_key IN ('FREE','EARLY')` 전체, Pro/Team = 현재 지급 주기 시작 이후 (`plan_key IS NOT NULL`). 초기화 배치 없음 — 새 주기가 곧 새 창.
- 마이그레이션 v72 이전 실행분(`plan_key` NULL)은 합산하지 않는다(전체 초기화).
- 단가: `server/ai/config.js` `PROVIDER_PRICES` ([입력, 출력, 캐시] USD/1M 토큰), 배포 없이 `AI_PRICE_<MODEL>=in,out,cached`로 덮어쓰기. 모델 추가·가격 변경 시 공식 가격표로 확인할 것.

## API

| | |
|---|---|
| `GET …/projects/:pid/ai/status` | `{ enabled, notice, plan, usage: { used_pct, remaining_pct, tier, blocked, allowance, resets_at, unlimited } }` |
| `GET /api/workspaces/:wid/ai-usage?days=30` | `{ usage, days: [{ date, day_pct, cum_pct }] }` (Asia/Seoul 일 단위) |
| `GET /api/workspaces/:wid/credits/*` | 410 `credits_retired` |
| `GET /api/admin/ai/usage` | 이번 달·30일 비용, 일별 30일·월별 12개월, 기능별, 모델별, 워크스페이스 상위 10(한도·사용률), 실패, 환율 |
| `GET /api/admin/workspaces/:id/ai` | 한도·사용액·사용률, 30일 비용·토큰(캐시 포함), 일별, 기능·사용자·모델별, 최근 실행 |
| `GET /api/cron/fx` | 한국수출입은행 USD 매매기준율, Vercel Cron `0 1 * * *` (10:00 KST), `KOREAEXIM_API_KEY` 필요. 관리자 표시 전용 |

오류: `AI_USAGE_LIMIT_REACHED` (402, `usage` 포함) — 화면은 Free면 플랜 안내, 유료면 다음 제공일 안내.

## DB (v72, additive)

- `ai_runs`: `cached_input_tokens`, `reserved_usd`, `plan_key`, `cost_estimated` + 부분 인덱스 `idx_ai_runs_ws_metered`
- `fx_rates(rate_date, currency, krw_per_unit, source, fetched_at)`
- 데이터: 모든 `workspace_credit_accounts` 잔액 0 + `credit_ledger` ADJUSTMENT 1건씩(reference v72). 크레딧 테이블은 이력으로 보존(쓰기 없음). 시드 프로모션 문구 교체(운영자가 고친 행 제외).

## 화면

- 설정 › AI 이용 현황 (`/app/settings/ai-usage`, 구 `/app/settings/credits` 경로 포함): 사용률·남은 이용량·Progress Bar·일별 누적 사용률(SVG)·다음 제공일, 80/95/100% 안내
- AI 다이얼로그 상단: "AI 이용량 32.5% 사용" (80% 주황, 95% 빨강, 100% 실행 불가 + 안내)
- 홈: "AI 이용량 67.5% 남음" · 설정 › 플랜 · 결제: AI 이용량 패널
- 관리자 대시보드·워크스페이스·사용량: USD 비용(원화 병기), 일별·월별 막대그래프, 모델·사용자별, 한도·사용률
- 랜딩·요금 카드·FAQ·약관(제8조의2 AI 이용량 정책)·개인정보 처리방침 문구 갱신

## 남은 결정

- 약관 시행일(`termsEffectiveDate`): 버전은 2026-10-27로 올렸고 시행일은 공지 기간 결정 후 갱신
- `KOREAEXIM_API_KEY` 발급·등록, 수출입은행 당일 고시가 10시 전에 반영되는지 확인(빈 응답이면 직전 값 유지)
