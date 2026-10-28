/**
 * AI run orchestration — the one path every feature goes through:
 *   enabled? → input size → rate limits → allowance check + PENDING ai_run (worst-case reservation) → provider (retry policy)
 *   → schema validation → feature post-validation (ids exist, enums, hierarchy) → settle (tokens + USD cost, success or failure).
 * Nothing here writes project data; approval endpoints do that separately through the existing services.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { aiConfig, maxOutputTokensFor, publicConfig, worstCaseCost } from './config.js';
import { createProvider, AiProviderError } from './provider.js';
import { SCHEMAS, validateSchema, trimDeep } from './schemas.js';
import { retryHint } from './prompts.js';
import { AiUsageError, releaseIfPending, reserveRun, settleRun, usageSummary, publicUsage } from './usage-limit.js';

export class AiError extends Error {
  constructor(code, message, { status = 400, ...extra } = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}
const STATUS_OF = { AI_TIMEOUT: 504, AI_PROVIDER_ERROR: 502, AI_INVALID_OUTPUT: 502 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Public status for the frontend: flag, notice, and this workspace's AI usage as percentages (no amounts). */
export async function aiStatus(db, wid) {
  const pub = publicConfig();
  const usage = publicUsage(await usageSummary(db, wid));
  return { ...pub, plan: usage.plan, usage };
}

async function checkLimits(db, cfg, { wid, userId }) {
  if (cfg.userMinuteLimit > 0) {
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ? AND created_at > now() - interval '1 minute'`, [userId])).n;
    if (n >= cfg.userMinuteLimit) throw new AiError('AI_RATE_LIMITED', 'AI 요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.', { status: 429, scope: 'user' });
  }
  if (cfg.dailyLimit > 0) {
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ? AND created_at >= date_trunc('day', now())`, [wid])).n;
    if (n >= cfg.dailyLimit) throw new AiError('AI_RATE_LIMITED', '오늘 이 워크스페이스의 AI 요청 한도에 도달했습니다. 내일 다시 시도해 주세요.', { status: 429, scope: 'workspace' });
  }
}

/* 관리자 › AI 프롬프트 › 전송 내용 미리보기: a feature call made inside previewPrompt() stops right after build(), before the enabled
 * check, rate limits, allowance check, ai_runs row and provider call, and hands back exactly what would have been sent. */
const previewStore = new AsyncLocalStorage();
class PromptPreview extends Error { constructor(payload) { super('prompt preview'); this.payload = payload; } }
/** True inside previewPrompt() — feature builders skip anything that would reach the network (knowledge embedding). */
export const isPreview = () => Boolean(previewStore.getStore());
export async function previewPrompt(fn) {
  try { await previewStore.run({}, fn); } catch (e) { if (e instanceof PromptPreview) return e.payload; throw e; }
  throw new Error('the feature returned without reaching the AI call');
}

/**
 * build() → { system, user, schemaName?, inputSummary, inputChars }  (prompt + metadata; runs before any ai_run exists)
 * postValidate(data) → { data, warnings }  (feature-level grounding checks; throw AiError('AI_INVALID_OUTPUT') to reject)
 */
export async function runAiFeature(db, { wid, projectId = null, userId, feature, schema: schemaOverride = null, build, postValidate = async (d) => ({ data: d, warnings: [] }) }) {
  const cfg = aiConfig();
  const preview = previewStore.getStore();
  if (!cfg.enabled && !preview) throw new AiError('AI_DISABLED', 'AI 기능을 사용할 수 없습니다. 관리자에게 문의하세요.', { status: 503 });
  const schema = schemaOverride || SCHEMAS[feature]; if (!schema) throw new AiError('AI_BAD_FEATURE', '알 수 없는 AI 기능입니다.', { status: 400 });
  const prompt = await build();
  if (preview) throw new PromptPreview({ feature, prompt, schema, maxTokens: maxOutputTokensFor(feature), inputTooLarge: prompt.inputChars > cfg.maxInputChars, maxInputChars: cfg.maxInputChars });
  if (prompt.inputChars > cfg.maxInputChars) throw new AiError('AI_INPUT_TOO_LARGE', `입력이 너무 깁니다. 최대 ${cfg.maxInputChars.toLocaleString('en-US')}자까지 분석할 수 있습니다.`, { status: 400, max: cfg.maxInputChars });
  await checkLimits(db, cfg, { wid, userId });

  const provider = createProvider(cfg);
  const maxTokens = maxOutputTokensFor(feature);
  // Worst case of one provider call (every input char a token + the whole output cap): the reservation, and the cost of a call that
  // timed out without reporting usage. A retry doubles it.
  const oneCall = worstCaseCost(provider.model, String(prompt.system || '').length + String(prompt.user || '').length, maxTokens);
  const run = await reserveRun(db, { wid, projectId, userId, feature, provider: provider.name, model: provider.model, inputSummary: String(prompt.inputSummary || '').slice(0, 300),
    reserveUsd: oneCall === null ? 0 : oneCall * 2, requestHash: createHash('sha256').update(`${feature}\n${prompt.system}\n${prompt.user}`).digest('hex') });
  const started = Date.now();
  const usageSum = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, seen: false, blind: 0 };
  const addUsage = (u) => {
    if (!u || (u.input_tokens == null && u.output_tokens == null)) return;
    usageSum.seen = true; usageSum.input_tokens += u.input_tokens || 0; usageSum.output_tokens += u.output_tokens || 0; usageSum.cached_input_tokens += u.cached_input_tokens || 0;
  };
  const usage = () => (usageSum.seen ? { input_tokens: usageSum.input_tokens, output_tokens: usageSum.output_tokens, cached_input_tokens: usageSum.cached_input_tokens } : {});
  /* A call that failed after the vendor answered carries its usage (provider.js); a timed-out call reports nothing and is counted at its
   * worst case — but only when no other call of this run reported usage (the cost then comes from the tokens, a slight under-count). */
  const noteFailure = (e) => { if (e?.usage) addUsage(e.usage); else if (e?.code === 'AI_TIMEOUT') usageSum.blind += 1; };
  const fallbackUsd = () => (usageSum.blind && oneCall !== null ? oneCall * usageSum.blind : null);

  // `message` is what the user reads (Korean, no vendor text); `detail` (vendor status / validation path) is kept on the run for operators
  const fail = async (code, message, detail = null) => {
    await settleRun(db, run.id, { success: false, usage: usage(), model: provider.model, fallbackUsd: fallbackUsd(), latencyMs: Date.now() - started, errorCode: code, errorMessage: detail ? `${message} [${detail}]`.slice(0, 500) : message });
    throw new AiError(code, message, { status: STATUS_OF[code] || 502, run_id: run.id });
  };

  /* From here on a PENDING run exists: every exit path must settle it (success or failure, both with their cost). The outer
   * catch/finally covers anything unexpected (bugs, DB errors, thrown non-AI errors) so a run can never stay PENDING. */
  try {
    let user = prompt.user; let data = null; let errors = [];
    for (let attempt = 1; attempt <= 2 && !data; attempt++) {
      let out;
      try {
        out = await provider.generateStructured({ system: prompt.system, user, schema, schemaName: prompt.schemaName || feature.toLowerCase(), schemaDescription: prompt.schemaDescription, maxTokens, attempt });
      } catch (e) {
        noteFailure(e);
        if (e instanceof AiProviderError && e.transient && attempt === 1) {   // one retry for transient provider failures
          await sleep(300);
          try { out = await provider.generateStructured({ system: prompt.system, user, schema, schemaName: prompt.schemaName || feature.toLowerCase(), schemaDescription: prompt.schemaDescription, maxTokens, attempt: 2 }); }
          catch (e2) { noteFailure(e2); return await fail(e2 instanceof AiProviderError ? e2.code : 'AI_PROVIDER_ERROR', e2.message, e2.detail); }
          attempt = 2;
        } else if (e instanceof AiProviderError && e.code === 'AI_INVALID_OUTPUT' && attempt === 1) {
          user = prompt.user + retryHint(['응답은 반드시 요구된 JSON 객체여야 합니다.']); continue;
        } else return await fail(e instanceof AiProviderError ? e.code : 'AI_PROVIDER_ERROR', e.message, e.detail);
      }
      addUsage(out.usage);
      const candidate = trimDeep(out.data);
      errors = validateSchema(schema, candidate);
      if (!errors.length) data = candidate;
      else if (attempt === 1) user = prompt.user + retryHint(errors);   // re-prompt once with the concrete validation problems
    }
    if (!data) return await fail('AI_INVALID_OUTPUT', 'AI 응답 형식이 올바르지 않아 결과를 만들지 못했습니다. 다시 시도해 주세요.', errors[0] || 'schema');

    let final;
    try { final = await postValidate(data); }
    catch (e) { if (e instanceof AiError) return await fail(e.code, e.message); throw e; }

    await settleRun(db, run.id, { success: true, usage: usage(), model: provider.model, latencyMs: Date.now() - started });
    const after = publicUsage(await usageSummary(db, wid));
    return { ...final.data, warnings: final.warnings || [], run: { id: run.id, feature, model: provider.model, latency_ms: Date.now() - started, usage: after } };
  } catch (e) {
    if (!(e instanceof AiError)) {   // unexpected: release the reservation, record the cause, then surface a generic AI error
      await releaseIfPending(db, run.id, { errorCode: 'AI_INTERNAL_ERROR', errorMessage: e.message, latencyMs: Date.now() - started, usage: usage(), model: provider.model }).catch((e2) => console.error('[ai] release failed', e2.message));
      console.error('[ai] unexpected error', e);
      throw new AiError('AI_INTERNAL_ERROR', 'AI 처리 중 오류가 발생했습니다. 다시 시도해 주세요.', { status: 500, run_id: run.id });
    }
    throw e;
  } finally {
    // belt and braces: if settlement itself failed (e.g. DB hiccup) the run must still not stay PENDING
    await releaseIfPending(db, run.id, { errorCode: 'AI_INTERNAL_ERROR', errorMessage: 'settlement did not complete', usage: usage(), model: provider.model }).catch(() => {});
  }
}

export { AiProviderError, AiUsageError };
