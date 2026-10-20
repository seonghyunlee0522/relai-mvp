/**
 * AI layer configuration (Phase 11). Everything is read from the environment once per call so tests can flip it.
 * Secrets never leave this module except into the provider adapter; `publicConfig()` is what the frontend may see.
 *
 * Credits vs. tokens: tokens and provider cost are internal metering; the user-facing unit is the Credit.
 * FEATURE_CREDIT_COST is the single place feature prices live (development defaults — the Pricing phase changes them here).
 */
export const FEATURES = ['REQUIREMENT_EXTRACTION', 'WBS_GENERATION', 'CHANGE_IMPACT', 'PROJECT_QA', 'WBS_PLAN_QUESTIONS', 'WBS_PLAN_FIX', 'TEST_GENERATION'];
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI 요구사항 추출', WBS_GENERATION: 'AI WBS 초안', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기', WBS_PLAN_QUESTIONS: 'AI WBS Planner 질문', WBS_PLAN_FIX: 'AI WBS Planner 보완', TEST_GENERATION: '테스트 시나리오 만들기' };

const envInt = (k, def) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== undefined && process.env[k] !== '' ? n : def; };

/**
 * Per-feature price in credits (1 credit = ₩10 VAT incl., plans.js CREDIT_PRICE_KRW) — a fixed price per action, never per token,
 * shown before every click. AI-credits-only billing §3.2. Overridable per feature with AI_CREDIT_COST_<FEATURE>.
 */
export function featureCreditCost(feature) {
  const def = { REQUIREMENT_EXTRACTION: 30, WBS_GENERATION: 50, CHANGE_IMPACT: 20, PROJECT_QA: 10, WBS_PLAN_QUESTIONS: 0, WBS_PLAN_FIX: 0, TEST_GENERATION: 30 }[feature];   // Planner: one WBS_GENERATION charge per plan; question / fix calls are free (token cost still recorded)
  if (def === undefined) throw new Error(`unknown AI feature ${feature}`);
  return Math.max(0, envInt(`AI_CREDIT_COST_${feature}`, def));
}
export const featureCreditCosts = () => Object.fromEntries(FEATURES.map((f) => [f, featureCreditCost(f)]));

/**
 * Provider price table in USD per 1M tokens [input, output]. Used only to estimate provider_cost_amount for ops analytics.
 * Unknown models estimate as null (never block a request over a missing price).
 */
export const PROVIDER_PRICES = {
  'claude-sonnet-4-5': [3, 15], 'claude-sonnet-4-5-20250929': [3, 15], 'claude-haiku-4-5': [1, 5], 'claude-haiku-4-5-20251001': [1, 5], 'claude-opus-4-1': [15, 75],
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-5': [1.25, 10], 'gpt-5-mini': [0.25, 2],
  'fake-model': [0, 0],
};
export function estimateProviderCost(model, inputTokens, outputTokens) {
  const p = PROVIDER_PRICES[model] || PROVIDER_PRICES[String(model).replace(/-\d{8}$/, '')];
  if (!p || inputTokens == null || outputTokens == null) return null;
  return Number(((inputTokens * p[0] + outputTokens * p[1]) / 1e6).toFixed(6));
}

/**
 * Output-token cap per call, sized to each feature's schema so a run cannot run away (gpt-4o-mini: $0.6 per 1M output tokens,
 * so the largest cap costs under ₩10). AI_MAX_OUTPUT_TOKENS_<FEATURE> overrides one feature; AI_MAX_OUTPUT_TOKENS, when set, is a ceiling for all.
 * WBS_GENERATION covers the Planner's full draft (up to 100 items); Q&A answers are short.
 */
const MAX_OUTPUT_TOKENS = { REQUIREMENT_EXTRACTION: 4_000, WBS_GENERATION: 8_000, CHANGE_IMPACT: 2_500, PROJECT_QA: 1_500, WBS_PLAN_QUESTIONS: 3_000, WBS_PLAN_FIX: 3_000, TEST_GENERATION: 8_000 };   // TEST_GENERATION: ≤ 20 requirements × ≤ 3 scenarios
export function maxOutputTokensFor(feature) {
  const per = Math.max(256, envInt(`AI_MAX_OUTPUT_TOKENS_${feature}`, MAX_OUTPUT_TOKENS[feature] ?? 4_000));
  const ceiling = process.env.AI_MAX_OUTPUT_TOKENS ? Math.max(256, envInt('AI_MAX_OUTPUT_TOKENS', per)) : Infinity;
  return Math.min(per, ceiling);
}

const DEFAULT_MODEL = { anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', fake: 'fake-model' };

/** Full (server-side) configuration. `enabled` is false whenever the provider has no credential. */
export function aiConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const keys = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, fake: 'fake' };
  const apiKey = keys[provider] || '';
  const flag = String(env.AI_ENABLED ?? 'true').toLowerCase() !== 'false';
  const enabled = flag && Boolean(provider) && Boolean(apiKey);
  return {
    enabled, provider, apiKey,
    model: String(env.AI_MODEL || DEFAULT_MODEL[provider] || '').trim(),
    timeoutMs: Math.min(120_000, Math.max(1_000, envInt('AI_REQUEST_TIMEOUT_MS', 25_000))),
    maxInputChars: Math.max(500, envInt('AI_MAX_INPUT_CHARS', 20_000)),
    dailyLimit: Math.max(0, envInt('AI_DAILY_LIMIT', 300)),            // per workspace per day (0 = unlimited)
    userMinuteLimit: Math.max(0, envInt('AI_USER_MINUTE_LIMIT', 10)),  // per user per minute (0 = unlimited)
    devInitialCredits: Math.max(0, envInt('DEV_INITIAL_AI_CREDITS', 0)),      // dev/test only; when > 0 it REPLACES the production trial grant
    trialCredits: Math.max(0, envInt('AI_INITIAL_TRIAL_CREDITS', 200)),       // production: Free 최초 200 (pricing v3, founder 2026-10-21) when a workspace's account is first created (0 = none)
    // D7: who the Free 200 is "once" for. 'owner' (default) = once per owner account and per e-mail hash (free_credit_claims) as well as
    // per workspace; 'workspace' = once per workspace only.
    freeClaimScope: String(env.AI_FREE_CLAIM_SCOPE || 'owner').toLowerCase() === 'workspace' ? 'workspace' : 'owner',
    maxOutputTokens: Math.max(256, envInt('AI_MAX_OUTPUT_TOKENS', 4_000)),
    disabledReason: !flag ? 'AI_ENABLED=false' : !provider ? 'AI_PROVIDER 미설정' : !apiKey ? 'Provider API Key 미설정' : null,
  };
}

/** What the frontend is allowed to know. No keys, no limits that would help abuse. */
export function publicConfig() {
  const c = aiConfig();
  return { enabled: c.enabled, provider: c.enabled ? c.provider : null, model: c.enabled ? c.model : null, costs: featureCreditCosts(),
    notice: '현재 프로젝트의 요구사항, WBS, 이슈·리스크, 테스트, 변경 데이터를 참고합니다. AI 결과는 초안·후보이며 사용자가 검토·승인한 항목만 저장됩니다.' };
}
