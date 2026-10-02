/**
 * AI layer configuration (Phase 11). Everything is read from the environment once per call so tests can flip it.
 * Secrets never leave this module except into the provider adapter; `publicConfig()` is what the frontend may see.
 *
 * Credits vs. tokens: tokens and provider cost are internal metering; the user-facing unit is the Credit.
 * FEATURE_CREDIT_COST is the single place feature prices live (development defaults — the Pricing phase changes them here).
 */
export const FEATURES = ['REQUIREMENT_EXTRACTION', 'WBS_GENERATION', 'CHANGE_IMPACT', 'PROJECT_QA'];
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI 요구사항 추출', WBS_GENERATION: 'AI WBS 초안', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기' };

const envInt = (k, def) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== undefined && process.env[k] !== '' ? n : def; };

/** Per-feature credit cost (development defaults). Overridable per feature with AI_CREDIT_COST_<FEATURE>. */
export function featureCreditCost(feature) {
  const def = { REQUIREMENT_EXTRACTION: 10, WBS_GENERATION: 15, CHANGE_IMPACT: 8, PROJECT_QA: 3 }[feature];
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
    trialCredits: Math.max(0, envInt('AI_INITIAL_TRIAL_CREDITS', 100)),       // production: one-time trial grant when a workspace's account is first created (0 = none)
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
