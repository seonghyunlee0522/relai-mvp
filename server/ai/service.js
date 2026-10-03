/**
 * AI run orchestration — the one path every feature goes through:
 *   enabled? → input size → rate limits → reserve credits + PENDING ai_run → provider (retry policy) → schema validation
 *   → feature post-validation (ids exist, enums, hierarchy) → settle (charge | release) → result for the frontend.
 * Nothing here writes project data; approval endpoints do that separately through the existing services.
 */
import { aiConfig, estimateProviderCost, featureCreditCost, publicConfig } from './config.js';
import { createProvider, AiProviderError } from './provider.js';
import { SCHEMAS, validateSchema, trimDeep } from './schemas.js';
import { retryHint } from './prompts.js';
import { CreditError, getBalance, releaseIfPending, reserveRun, settleRun } from './credits.js';

export class AiError extends Error {
  constructor(code, message, { status = 400, ...extra } = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}
const STATUS_OF = { AI_TIMEOUT: 504, AI_PROVIDER_ERROR: 502, AI_INVALID_OUTPUT: 502 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Public status for the frontend: flag, costs, notice, and this workspace's credit balance. */
export async function aiStatus(db, wid) {
  const pub = publicConfig();
  return { ...pub, credits: pub.enabled ? await getBalance(db, wid) : null };
}

async function checkLimits(db, cfg, { wid, userId }) {
  if (cfg.userMinuteLimit > 0) {
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ? AND created_at > now() - interval '1 minute'`, [userId])).n;
    if (n >= cfg.userMinuteLimit) throw new AiError('AI_RATE_LIMITED', 'AI 요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.', { status: 429, scope: 'user' });
  }
  if (cfg.dailyLimit > 0) {
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ? AND created_at >= date_trunc('day', now())`, [wid])).n;
    if (n >= cfg.dailyLimit) throw new AiError('AI_RATE_LIMITED', '오늘 이 Workspace의 AI 요청 한도에 도달했습니다. 내일 다시 시도해 주세요.', { status: 429, scope: 'workspace' });
  }
}

/**
 * build() → { system, user, schemaName?, inputSummary, inputChars }  (prompt + metadata; runs before any credit is touched)
 * postValidate(data) → { data, warnings }  (feature-level grounding checks; throw AiError('AI_INVALID_OUTPUT') to reject)
 */
export async function runAiFeature(db, { wid, projectId = null, userId, feature, schema: schemaOverride = null, build, postValidate = async (d) => ({ data: d, warnings: [] }) }) {
  const cfg = aiConfig();
  if (!cfg.enabled) throw new AiError('AI_DISABLED', 'AI 기능을 사용할 수 없습니다. 관리자에게 문의하세요.', { status: 503 });
  const schema = schemaOverride || SCHEMAS[feature]; if (!schema) throw new AiError('AI_BAD_FEATURE', '알 수 없는 AI 기능입니다.', { status: 400 });
  const prompt = await build();
  if (prompt.inputChars > cfg.maxInputChars) throw new AiError('AI_INPUT_TOO_LARGE', `입력이 너무 깁니다. 최대 ${cfg.maxInputChars.toLocaleString('en-US')}자까지 분석할 수 있습니다.`, { status: 400, max: cfg.maxInputChars });
  await checkLimits(db, cfg, { wid, userId });

  const provider = createProvider(cfg);
  const cost = featureCreditCost(feature);
  const run = await reserveRun(db, { wid, projectId, userId, feature, provider: provider.name, model: provider.model, inputSummary: String(prompt.inputSummary || '').slice(0, 300), cost });
  const started = Date.now();
  const usageSum = { input_tokens: 0, output_tokens: 0, seen: false };
  const addUsage = (u) => { if (!u) return; if (u.input_tokens != null) { usageSum.input_tokens += u.input_tokens; usageSum.seen = true; } if (u.output_tokens != null) { usageSum.output_tokens += u.output_tokens; usageSum.seen = true; } };
  const usage = () => (usageSum.seen ? { input_tokens: usageSum.input_tokens, output_tokens: usageSum.output_tokens } : {});

  const fail = async (code, message) => {
    await settleRun(db, run.id, { success: false, usage: usage(), latencyMs: Date.now() - started, errorCode: code, errorMessage: message });
    throw new AiError(code, message, { status: STATUS_OF[code] || 502, run_id: run.id });
  };

  /* From here on a reservation exists: every exit path must settle the run (charge or release). The outer catch/finally
   * covers anything unexpected (bugs, DB errors, thrown non-AI errors) so a run can never stay PENDING/RESERVED. */
  try {
    let user = prompt.user; let data = null; let errors = [];
    for (let attempt = 1; attempt <= 2 && !data; attempt++) {
      let out;
      try {
        out = await provider.generateStructured({ system: prompt.system, user, schema, schemaName: prompt.schemaName || feature.toLowerCase(), schemaDescription: prompt.schemaDescription, attempt });
      } catch (e) {
        if (e instanceof AiProviderError && e.transient && attempt === 1) {   // one retry for transient provider failures
          await sleep(300);
          try { out = await provider.generateStructured({ system: prompt.system, user, schema, schemaName: prompt.schemaName || feature.toLowerCase(), schemaDescription: prompt.schemaDescription, attempt: 2 }); }
          catch (e2) { return await fail(e2 instanceof AiProviderError ? e2.code : 'AI_PROVIDER_ERROR', e2.message); }
          attempt = 2;
        } else if (e instanceof AiProviderError && e.code === 'AI_INVALID_OUTPUT' && attempt === 1) {
          user = prompt.user + retryHint(['응답은 반드시 요구된 JSON 객체여야 합니다.']); continue;
        } else return await fail(e instanceof AiProviderError ? e.code : 'AI_PROVIDER_ERROR', e.message);
      }
      addUsage(out.usage);
      const candidate = trimDeep(out.data);
      errors = validateSchema(schema, candidate);
      if (!errors.length) data = candidate;
      else if (attempt === 1) user = prompt.user + retryHint(errors);   // re-prompt once with the concrete validation problems
    }
    if (!data) return await fail('AI_INVALID_OUTPUT', `AI 응답이 요구된 형식을 만족하지 않았습니다. (${errors[0] || 'schema'})`);

    let final;
    try { final = await postValidate(data); }
    catch (e) { if (e instanceof AiError) return await fail(e.code, e.message); throw e; }

    const u = usage();
    const settled = await settleRun(db, run.id, { success: true, usage: u, providerCost: estimateProviderCost(provider.model, u.input_tokens, u.output_tokens), latencyMs: Date.now() - started });
    if (settled?.conflict) console.warn(`[ai] settlement conflict run=${run.id} workspace=${wid} feature=${feature}`);
    return { ...final.data, warnings: final.warnings || [], run: { id: run.id, feature, model: provider.model, credit_cost: settled?.credit_status === 'CHARGED' ? cost : 0, credit_status: settled?.credit_status || 'NONE', balance: settled?.balance ?? run.balance_before, latency_ms: Date.now() - started } };
  } catch (e) {
    if (!(e instanceof AiError)) {   // unexpected: release the reservation, record the cause, then surface a generic AI error
      await releaseIfPending(db, run.id, { errorCode: 'AI_INTERNAL_ERROR', errorMessage: e.message, latencyMs: Date.now() - started }).catch((e2) => console.error('[ai] release failed', e2.message));
      console.error('[ai] unexpected error', e);
      throw new AiError('AI_INTERNAL_ERROR', 'AI 처리 중 오류가 발생했습니다. 다시 시도해 주세요.', { status: 500, run_id: run.id });
    }
    throw e;
  } finally {
    // belt and braces: if settlement itself failed (e.g. DB hiccup) the run must still not stay PENDING
    await releaseIfPending(db, run.id, { errorCode: 'AI_INTERNAL_ERROR', errorMessage: 'settlement did not complete' }).catch(() => {});
  }
}

export { AiProviderError, CreditError };
