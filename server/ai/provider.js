/**
 * Provider adapters. Domain code only ever calls `provider.generateStructured(...)`; nothing else in the server knows
 * which vendor is behind it. Every adapter returns `{ data, usage: { input_tokens, output_tokens } }` where `data` is the
 * JSON object the model produced for the given JSON schema (native structured output on both vendors — Anthropic
 * forced tool use, OpenAI json_schema strict mode — so free text is never parsed by hand).
 *
 * Errors are AiProviderError with a stable `code`:
 *   AI_TIMEOUT          the request exceeded timeoutMs (not retried)
 *   AI_PROVIDER_ERROR   HTTP/network failure; `transient` marks 429/5xx/network, which the caller may retry once
 *   AI_INVALID_OUTPUT   the vendor returned no parsable structured object (caller re-prompts once)
 * The raw response body is never attached to the error — only status and a short message.
 *
 * The `fake` provider is for automated tests: no network, deterministic, scriptable through setFakeProvider().
 */
export class AiProviderError extends Error {
  constructor(code, message, { status = null, transient = false } = {}) { super(message); this.code = code; this.status = status; this.transient = transient; }
}

const short = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

/** fetch with a hard timeout. Any abort surfaces as AI_TIMEOUT; other network failures are transient provider errors. */
async function call(url, init, timeoutMs) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new AiProviderError('AI_TIMEOUT', `AI 응답 시간이 ${Math.round(timeoutMs / 1000)}초를 초과했습니다.`, { transient: false });
    throw new AiProviderError('AI_PROVIDER_ERROR', `AI Provider에 연결하지 못했습니다. (${short(e.message, 80)})`, { transient: true });
  } finally { clearTimeout(timer); }
}
async function readJson(res) {
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || short(text, 120) || res.statusText;
    throw new AiProviderError('AI_PROVIDER_ERROR', `AI Provider 오류 (${res.status}): ${short(msg, 160)}`, { status: res.status, transient: res.status === 429 || res.status >= 500 });
  }
  if (!json) throw new AiProviderError('AI_INVALID_OUTPUT', 'AI Provider 응답을 해석할 수 없습니다.');
  return json;
}

/* ---------- Anthropic (Messages API, forced tool use = guaranteed JSON matching input_schema) ---------- */
function anthropicProvider({ apiKey, model, timeoutMs, maxOutputTokens }) {
  return {
    name: 'anthropic', model,
    async generateStructured({ system, user, schema, schemaName = 'result', schemaDescription = 'Structured result', maxTokens = maxOutputTokens }) {
      const res = await call('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
          tools: [{ name: schemaName, description: schemaDescription, input_schema: schema }], tool_choice: { type: 'tool', name: schemaName } }),
      }, timeoutMs);
      const json = await readJson(res);
      const tool = (json.content || []).find((c) => c.type === 'tool_use');
      if (!tool || typeof tool.input !== 'object' || tool.input === null) throw new AiProviderError('AI_INVALID_OUTPUT', 'AI가 구조화된 결과를 반환하지 않았습니다.');
      return { data: tool.input, usage: { input_tokens: json.usage?.input_tokens ?? null, output_tokens: json.usage?.output_tokens ?? null } };
    },
  };
}

/* ---------- OpenAI (Chat Completions, response_format json_schema strict) ---------- */
function openaiProvider({ apiKey, model, timeoutMs, maxOutputTokens }) {
  return {
    name: 'openai', model,
    async generateStructured({ system, user, schema, schemaName = 'result', maxTokens = maxOutputTokens }) {
      const res = await call('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } }),
      }, timeoutMs);
      const json = await readJson(res);
      const msg = json.choices?.[0]?.message;
      if (!msg || msg.refusal) throw new AiProviderError('AI_INVALID_OUTPUT', 'AI가 요청을 처리하지 않았습니다.');
      let data = null; try { data = JSON.parse(msg.content); } catch { /* invalid */ }
      if (!data || typeof data !== 'object') throw new AiProviderError('AI_INVALID_OUTPUT', 'AI가 구조화된 결과를 반환하지 않았습니다.');
      return { data, usage: { input_tokens: json.usage?.prompt_tokens ?? null, output_tokens: json.usage?.completion_tokens ?? null } };
    },
  };
}

/* ---------- Fake (tests) ---------- */
const fake = { handler: null, calls: [] };
/**
 * Script the fake provider: handler(request) → { data, usage? } | throws. `request` = { system, user, schema, schemaName, attempt }.
 * Pass null to reset. `fakeCalls()` returns every request the fake received since the last reset (prompt-injection tests inspect it).
 */
export function setFakeProvider(handler) { fake.handler = handler; fake.calls = []; }
export const fakeCalls = () => fake.calls;
function fakeProvider({ model }) {
  return {
    name: 'fake', model: model || 'fake-model',
    async generateStructured(req) {
      fake.calls.push(req);
      if (!fake.handler && process.env.AI_FAKE_AUTOREPLY === '1') return { data: autoReply(req), usage: { input_tokens: Math.ceil(req.user.length / 4), output_tokens: 120 } };
      if (!fake.handler) throw new AiProviderError('AI_PROVIDER_ERROR', 'fake provider has no handler', { status: 500, transient: false });
      const out = await fake.handler(req);
      return { data: out.data, usage: out.usage || { input_tokens: 100, output_tokens: 50 } };
    },
  };
}

/** Canned-but-grounded replies for demos/E2E without an API key (AI_PROVIDER=fake AI_FAKE_AUTOREPLY=1). Uses only ids found in the prompt. */
function autoReply({ schemaName, user }) {
  const ids = (re) => [...new Set([...user.matchAll(re)].map((m) => m[1]))];
  const reqs = ids(/^- (REQ-\d{3})/gm); const wbs = ids(/^- (\d+(?:\.\d+)*) \[/gm); const tests = ids(/^- (TC-\d{3})/gm); const risks = ids(/^- (RSK-\d{3})/gm); const issues = ids(/^- (ISS-\d{3})/gm);
  if (schemaName === 'requirement_candidates') {
    const body = (user.split('<untrusted_input>')[1] || '').split('</untrusted_input>')[0];
    const lines = body.split(/\n|\. |。/).map((l) => l.trim()).filter((l) => l.length >= 8).slice(0, 5);
    return { candidates: lines.map((l, i) => ({ title: l.slice(0, 60), description: l, type: /보안|인증|SSO|권한/.test(l) ? 'SECURITY' : /성능|응답|속도/.test(l) ? 'NON_FUNCTIONAL' : 'FUNCTIONAL', priority: i === 0 ? 'HIGH' : 'MEDIUM', scope: 'UNDECIDED', requester_name: null, requester_organization: null, acceptance_criteria: [`${l.slice(0, 40)} 동작 확인`], source_text: l, confidence: i === 0 ? 'HIGH' : 'MEDIUM', similar_to: null })) };
  }
  if (schemaName === 'wbs_draft') {
    const items = []; let n = 0;
    for (const r of reqs.slice(0, 5)) { const s = `AI-WBS-${++n}`; items.push({ temp_id: s, parent_temp_id: null, item_type: 'SUMMARY', title: `${r} 구현`, description: '', planned_duration_days: null, related_requirement_ids: [r] });
      for (const t of ['설계', '개발', '테스트']) items.push({ temp_id: `AI-WBS-${++n}`, parent_temp_id: s, item_type: 'TASK', title: `${r} ${t}`, description: '', planned_duration_days: t === '개발' ? 5 : 2, related_requirement_ids: [r] }); }
    return { items, notes: ['자동 생성된 데모 초안입니다.'] };
  }
  if (schemaName === 'change_impact') return { summary: '연결된 요구사항과 그 구현 WBS, 관련 테스트에 영향이 예상됩니다.', affected_requirements: reqs.slice(0, 2).map((d) => ({ display_id: d, reason: '변경 대상 요구사항', confidence: 'HIGH' })), affected_wbs: wbs.slice(0, 2).map((w) => ({ wbs_code: w, impact_type: 'REWORK', reason: '요구사항 구현 작업', confidence: 'MEDIUM' })), affected_tests: tests.slice(0, 2).map((d) => ({ display_id: d, reason: '재수행 필요', confidence: 'MEDIUM' })), possible_risks: risks.slice(0, 1).map((d) => ({ display_id: d, reason: '관련 Risk', confidence: 'LOW' })) };
  const top = [...issues.slice(0, 2).map((d) => ({ type: 'ISSUE', display_id: d })), ...risks.slice(0, 1).map((d) => ({ type: 'RISK', display_id: d })), ...reqs.slice(0, 1).map((d) => ({ type: 'REQUIREMENT', display_id: d }))];
  return { answer: top.length ? `현재 확인할 항목은 ${top.length}건입니다.\n${top.map((t, i) => `${i + 1}. ${t.display_id}`).join('\n')}` : '현재 프로젝트 데이터에서 특별히 확인할 항목이 없습니다.', references: top, warnings: ['데모용 자동 응답입니다.'] };
}

export function createProvider(cfg) {
  if (cfg.provider === 'anthropic') return anthropicProvider(cfg);
  if (cfg.provider === 'openai') return openaiProvider(cfg);
  if (cfg.provider === 'fake') return fakeProvider(cfg);
  throw new AiProviderError('AI_PROVIDER_ERROR', `지원하지 않는 AI Provider: ${cfg.provider || '(없음)'}`);
}
