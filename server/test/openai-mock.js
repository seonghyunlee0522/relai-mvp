/* OpenAI Chat Completions stand-in for tests and scripts/e2e-ai-on.cjs — no network, no key needed.
 * `respond(body)` takes the JSON body the real adapter sent and returns { status, json } the way api.openai.com would:
 *   - 400 when response_format is not strict json_schema or the schema breaks strict mode (OpenAI rejects those the same way)
 *   - otherwise a grounded answer built from the prompt (the fake provider's autoReply, so ids exist in the project)
 * `script` queues one-off failures: '429', '500', 'invalid_json', 'length', 'refusal', 'oversize', 'hang'. */
import { autoReply } from '../ai/provider.js';

const TEXT_KEYS = ['title', 'description', 'answer', 'summary', 'reason', 'source_text'];   // free-text fields the 'oversize' step blows past maxLength
const SIZE_KEYS = ['maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum'];

/** Problems OpenAI strict mode would reject: object without additionalProperties:false, a property missing from required,
 * size keywords (maxLength … not accepted by strict mode). [] = accepted. */
export function strictProblems(schema, path = '$', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  for (const k of SIZE_KEYS) if (k in schema) out.push(`${path}: ${k} not permitted`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const keys = Object.keys(schema.properties || {});
    const req = schema.required || [];
    for (const k of keys) if (!req.includes(k)) out.push(`${path}.${k}: not in required`);
    for (const k of keys) strictProblems(schema.properties[k], `${path}.${k}`, out);
  }
  if (types.includes('array')) strictProblems(schema.items, `${path}[]`, out);
  return out;
}

export function openaiMock() {
  const m = { script: [], calls: [], hangMs: 60_000 };
  m.respond = async (body) => {
    const name = body?.response_format?.json_schema?.name;
    m.calls.push({ model: body?.model, max_completion_tokens: body?.max_completion_tokens, schemaName: name });   // never the prompt text
    const step = m.script.shift();
    if (step === 'hang') await new Promise((r) => setTimeout(r, m.hangMs));
    if (step === '429') return { status: 429, json: { error: { message: 'Rate limit reached for gpt-4o-mini in organization org-TEST on requests per min', type: 'requests' } } };
    if (step === '500') return { status: 500, json: { error: { message: 'The server had an error while processing your request.' } } };
    const rf = body?.response_format;
    if (rf?.type !== 'json_schema' || rf.json_schema?.strict !== true) return { status: 400, json: { error: { message: 'strict json_schema required' } } };
    const problems = strictProblems(rf.json_schema.schema);
    if (problems.length) return { status: 400, json: { error: { message: `Invalid schema for response_format '${name}': ${problems[0]}` } } };
    const user = body.messages?.find((x) => x.role === 'user')?.content || '';
    let data = autoReply({ schemaName: name, user });
    if (step === 'oversize' && data && typeof data === 'object') data = JSON.parse(JSON.stringify(data, (k, v) => (TEXT_KEYS.includes(k) && typeof v === 'string' ? v + 'ㄱ'.repeat(6000) : v)));
    if (m.transform) data = m.transform(name, data);   // a test can reshape one answer (e.g. leave a gap in a WBS draft)
    m.lastData = data;
    const content = step === 'invalid_json' ? '{"answer": "잘린' : JSON.stringify(data);
    const choice = step === 'refusal' ? { index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }
      : { index: 0, message: { role: 'assistant', content: step === 'length' ? content.slice(0, 40) : content, refusal: null }, finish_reason: step === 'length' ? 'length' : 'stop' };
    return { status: 200, json: { id: 'chatcmpl-mock', object: 'chat.completion', model: body.model, choices: [choice], usage: { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 } } };
  };
  /** globalThis.fetch replacement: api.openai.com goes to the mock, every other URL to the real fetch (the test client uses it). */
  m.fetch = (realFetch) => async (url, init = {}) => {
    if (!String(url).startsWith('https://api.openai.com/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const work = m.respond(body);
    const aborted = new Promise((_, rej) => init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    const { status, json } = await Promise.race([work, aborted]);
    const text = JSON.stringify(json);
    return { ok: status < 400, status, statusText: String(status), text: async () => text, json: async () => json };
  };
  return m;
}
