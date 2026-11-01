/**
 * PM 지식 RAG — offline card pipeline (shared by build-cards.mjs / load-cards.mjs / eval.mjs and the tests).
 *
 * chunk (source text, local file only) ──LLM rewrite──▶ knowledge cards ──verbatim check──▶ embed ──▶ kb_cards
 *
 * Cards are written for a PM running an IT/SI project, in RELAI's voice, and must not copy the source: any card that shares a run of
 * KB_MAX_SHARED_RUN (default 8) consecutive words with its chunk is re-written once with feedback and dropped if it still copies.
 */
import { createHash } from 'node:crypto';
import { longestSharedRun } from '../../server/ai/knowledge.js';
import { validateSchema, trimDeep } from '../../server/ai/schemas.js';

export const PHASES = ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];
const str = (maxLength) => ({ type: 'string', maxLength });
const arr = (items, maxItems) => ({ type: 'array', items, maxItems });
export const CARD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: { cards: arr({ type: 'object', additionalProperties: false,
    required: ['topic', 'summary', 'when_to_use', 'checkpoints', 'pitfalls', 'relai_phases', 'keywords'],
    properties: { topic: str(80), summary: str(500), when_to_use: str(300), checkpoints: arr(str(160), 6), pitfalls: arr(str(160), 4),
      relai_phases: arr({ type: 'string', enum: PHASES }, 3), keywords: arr(str(30), 8) } }, 3) },
};

export const CARD_SYSTEM = `당신은 IT/SI 프로젝트 PM을 돕는 RELAI의 지식 편집자입니다. 주어진 <source>는 PM 참고서의 한 부분이며, 이를 실무 PM이 바로 쓸 수 있는 "지식 카드"로 다시 씁니다.

규칙:
1. 원문 문장을 옮기지 말고 완전히 자신의 말로 다시 씁니다. 원문의 연속된 표현(여덟 단어 이상)을 그대로 쓰면 안 됩니다. 원문의 비유·예시(여행 등)는 쓰지 말고 IT 프로젝트 상황으로 바꿉니다.
2. 책·저자·표준 이름(예: PMBOK, PMI), 장·절 번호, 페이지, 시험·출제 관련 문구는 쓰지 않습니다.
3. 개념의 정의 나열이나 투입물/도구/산출물 목록 암기 대신 "언제, 왜, 어떻게 쓰는지"를 씁니다.
4. 카드 1~3장. 서로 다른 실무 주제일 때만 나눕니다. 실무에 쓸 내용이 없으면(목차·시험 요령·용어 대역만 있음) cards를 빈 배열로 둡니다.
5. topic: 짧은 한국어 주제명(예: "WBS 분해 기준", "리스크 대응 전략 고르기"). summary: 핵심 2~4문장. when_to_use: 이 지식이 필요한 상황 1~2문장.
   checkpoints: PM이 확인할 항목 2~6개(짧은 문장). pitfalls: 흔한 실수 1~4개. keywords: 검색용 한국어/영어 용어 3~8개(WBS, 주경로, EVM 같은 표준 용어 포함).
6. relai_phases: 이 지식이 가장 쓰이는 RELAI 단계 1~3개 — INITIATION(착수: 헌장·목표·이해관계자), REQUIREMENTS(요구사항 수집·범위 정의), ANALYSIS_DESIGN(WBS·일정·원가·자원·품질·리스크·의사소통 계획), DEVELOPMENT(실행·팀·의사소통·변경통제·조달·리스크 감시), TESTING(품질 통제·검증·결함), TRANSITION_GO_LIVE(인수·전환·오픈·종료), OPERATIONS(운영 인계·교훈).
7. 한국어로 간결하게. 요구된 JSON으로만 답합니다.`;

export const maxSharedRun = () => { const n = Number(process.env.KB_MAX_SHARED_RUN); return Number.isFinite(n) && n > 2 ? n : 8; };
export const cardBody = (c) => [`핵심: ${c.summary}`, c.when_to_use ? `언제 쓰나: ${c.when_to_use}` : null,
  c.checkpoints.length ? `체크포인트:\n${c.checkpoints.map((x) => `- ${x}`).join('\n')}` : null,
  c.pitfalls.length ? `흔한 실수:\n${c.pitfalls.map((x) => `- ${x}`).join('\n')}` : null].filter(Boolean).join('\n');
const cardText = (c) => `${c.topic}\n${cardBody(c)}`;
export const sha = (s) => createHash('sha256').update(s).digest('hex');
/** The text that is embedded for a card (topic + keywords + body). */
export const embedText = (card) => `${card.topic}\n${(card.keywords || []).join(', ')}\n${card.body}`;

const userPrompt = (chunk, hint = '') => `<context>\n장: ${chunk.chapter_name} · 절: ${chunk.title}\n</context>\n<source>\n${chunk.text}\n</source>${hint}`;

/**
 * One chunk → validated, non-copying cards: [{ card_key, source_hash, knowledge_area, lifecycle_phases, topic, body, keywords, shared_run }].
 * `provider` is a chat adapter from server/ai/provider.js (createProvider). Returns { cards, dropped, usage }.
 */
export async function cardsFromChunk(provider, chunk, { maxTokens = 2_000 } = {}) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const add = (u) => { usage.input_tokens += u?.input_tokens || 0; usage.output_tokens += u?.output_tokens || 0; };
  const limit = maxSharedRun();
  let hint = ''; let dropped = 0; let kept = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await provider.generateStructured({ system: CARD_SYSTEM, user: userPrompt(chunk, hint), schema: CARD_SCHEMA, schemaName: 'knowledge_cards', maxTokens });
    add(out.usage);
    const data = trimDeep(out.data); const errors = validateSchema(CARD_SCHEMA, data);
    if (errors.length) { if (attempt === 1) { hint = `\n\n이전 응답의 JSON 형식 오류: ${errors.slice(0, 5).join('; ')}`; continue; } return { cards: [], dropped: 0, usage, error: errors[0] }; }
    const cards = data.cards.filter((c) => c.topic && c.summary).map((c) => ({ ...c, shared_run: longestSharedRun(cardText(c), chunk.text) }));
    const copying = cards.filter((c) => c.shared_run >= limit);
    kept = cards.filter((c) => c.shared_run < limit);
    if (!copying.length || attempt === 2) { dropped = copying.length; break; }
    hint = `\n\n이전 응답의 카드 ${copying.map((c) => `"${c.topic}"`).join(', ')}가 원문 표현을 그대로 옮겼습니다(연속 ${limit}단어 이상). 원문 문장 구조를 따르지 말고 완전히 새로 쓰세요.`;
  }
  return {
    usage, dropped,
    cards: kept.map((c, i) => ({ card_key: `${chunk.chunk_key}.${i + 1}`, source_hash: chunk.hash, knowledge_area: chunk.knowledge_area,
      lifecycle_phases: [...new Set(c.relai_phases)], topic: c.topic, body: cardBody(c), keywords: c.keywords, shared_run: c.shared_run })),
  };
}

/** Upsert one document's full card set (cards not in the set are deleted). Runs in the caller's transaction. */
export async function replaceDocumentCards(t, { docKey, title, embeddingModel, cards, newId }) {
  let doc = await t.get('SELECT id FROM kb_documents WHERE doc_key = ?', [docKey]);
  if (!doc) { doc = { id: newId() }; await t.run('INSERT INTO kb_documents (id, doc_key, title, embedding_model) VALUES (?, ?, ?, ?)', [doc.id, docKey, title, embeddingModel]); }
  for (const c of cards) {
    await t.run(`INSERT INTO kb_cards (id, document_id, card_key, source_hash, knowledge_area, lifecycle_phases, topic, body, keywords, embedding)
      VALUES (?, ?, ?, ?, ?, ?::text[], ?, ?, ?::text[], ?::real[])
      ON CONFLICT (document_id, card_key) DO UPDATE SET source_hash = EXCLUDED.source_hash, knowledge_area = EXCLUDED.knowledge_area, lifecycle_phases = EXCLUDED.lifecycle_phases,
        topic = EXCLUDED.topic, body = EXCLUDED.body, keywords = EXCLUDED.keywords, embedding = EXCLUDED.embedding, updated_at = now()`,
    [newId(), doc.id, c.card_key, c.source_hash, c.knowledge_area || null, c.lifecycle_phases || [], c.topic, c.body, c.keywords || [], c.embedding || null]);
  }
  const removed = (await t.run('DELETE FROM kb_cards WHERE document_id = ? AND NOT (card_key = ANY(?::text[]))', [doc.id, cards.map((c) => c.card_key)])).changes;
  await t.run('UPDATE kb_documents SET title = ?, embedding_model = ?, card_count = ?, active = true, updated_at = now() WHERE id = ?', [title, embeddingModel, cards.length, doc.id]);
  return { documentId: doc.id, upserted: cards.length, removed };
}

export const readJsonl = async (path) => { const { readFile } = await import('node:fs/promises'); return (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); };
export function args(argv = process.argv.slice(2)) {
  const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } }
  return o;
}
