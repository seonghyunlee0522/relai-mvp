/**
 * PM 지식 RAG (founder 2026-10-28) — background knowledge for 'RELAI에게 물어보기' (PROJECT_QA).
 *
 * What is stored: paraphrased "knowledge cards" (topic · 핵심 · 언제 · 체크포인트 · 흔한 실수) built offline from PM reference books by
 * scripts/kb/build-cards.mjs. The books themselves never reach the database, the repository, the prompt or the user, and answers name
 * no source (reference use only). Which cards an answer used is kept on ai_runs.input_summary for operators (evaluation, debugging).
 *
 * Retrieval is hybrid and in-process: cosine similarity on the cards' embeddings (OpenAI text-embedding-3-small) + Korean
 * character-bigram keyword coverage, with a small boost for cards tagged with the project's current lifecycle phase. A few
 * thousand cards fit in memory comfortably; move to pgvector when the corpus outgrows that. Any failure (no key, embedding
 * timeout, no cards) degrades to keyword-only or to no knowledge — a question is never failed because of the knowledge layer.
 */
import { createEmbedder } from './provider.js';
import { neutralize } from './prompts.js';

const num = (k, def) => { const n = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(n) ? n : def; };
export const kbConfig = () => ({
  enabled: String(process.env.KB_ENABLED ?? 'true').toLowerCase() !== 'false',
  topK: Math.max(1, Math.min(10, num('KB_TOP_K', 5))),
  minVectorScore: num('KB_MIN_SCORE', 0.38),          // cosine + 0.25 × keyword coverage
  minKeywordScore: num('KB_MIN_KEYWORD_SCORE', 0.4),  // keyword-only mode (no embeddings available)
  maxChars: Math.max(500, num('KB_MAX_CHARS', 4_500)), // knowledge text per request
  ttlMs: num('KB_CACHE_TTL_MS', 10 * 60_000),
});

/* ---------- text utilities ---------- */
const STOP = new Set(['프로젝트', '어떻게', '무엇', '뭐야', '뭐가', '뭔가', '해야', '하나요', '할까', '알려', '알려줘', '설명', '설명해', '대해', '대한', '있는', '있어', '없어', '그리고', '우리', '지금', '하는', '방법', '좋을까', '좋아', '돼', '되나요', '인가요', '이란', '란', '이야', '해줘', '주세요']);
/* Trailing particles / endings stripped so "WBS는", "수준까지", "리스크를" match "WBS", "수준", "리스크". */
const JOSA = /(으로|에서|까지|부터|에게|한테|하고|이랑|처럼|보다|이나|이란|란|은|는|이|가|을|를|에|의|로|도|와|과|만|야|요|해)$/;
const stem = (w) => (/[가-힣]/.test(w) && w.length > 2 ? w.replace(JOSA, '') : w);
const words = (s) => String(s || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w)).map(stem).filter((w) => w && !STOP.has(w));
/** Character bigrams of every word (Korean has no reliable tokenizer here; bigrams match 일정관리 ↔ 일정 관리). */
export function gramSet(s) {
  const g = new Set();
  for (const w of words(s)) { if (w.length < 2) continue; for (let i = 0; i < w.length - 1; i++) g.add(w.slice(i, i + 2)); }
  return g;
}
/** Share of the question's bigrams found in a card, weighted by rarity across the corpus (idf). Bigrams no card contains are ignored. */
const coverage = (q, c, idf) => { let tot = 0; let hit = 0; for (const x of q) { const w = idf.get(x); if (!w) continue; tot += w; if (c.has(x)) hit += w; } return tot ? hit / tot : 0; };
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}
/**
 * Longest run of consecutive words two texts share (punctuation ignored). Card generation rejects a card whose run against its
 * source chunk reaches KB_MAX_SHARED_RUN words — the guarantee that cards are rewritten, not copied.
 */
export function longestSharedRun(a, b) {
  const ta = String(a || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ' ').split(' ').filter(Boolean);
  const tb = String(b || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ' ').split(' ').filter(Boolean);
  let best = 0; let prev = new Array(tb.length + 1).fill(0);
  for (let i = 1; i <= ta.length; i++) {
    const cur = new Array(tb.length + 1).fill(0);
    for (let j = 1; j <= tb.length; j++) if (ta[i - 1] === tb[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}

/* ---------- card index (per database schema, refreshed when the cards change) ---------- */
const caches = new Map();   // schema → { at, stamp, cards, idf }
export const resetKnowledgeCache = () => caches.clear();

export async function loadKnowledge(db) {
  const key = db.schema || 'public'; const cfg = kbConfig();
  const c = caches.get(key);
  if (c && Date.now() - c.at < cfg.ttlMs) return c;
  const st = await db.get(`SELECT COUNT(*) AS n, MAX(c.updated_at) AS m, MAX(d.updated_at) AS dm FROM kb_cards c JOIN kb_documents d ON d.id = c.document_id
    WHERE d.active AND d.workspace_id IS NULL`);
  const stamp = `${st.n}|${st.m}|${st.dm}`;
  if (c && c.stamp === stamp) { c.at = Date.now(); return c; }
  const rows = await db.all(`SELECT c.card_key, c.topic, c.body, c.keywords, c.knowledge_area, c.lifecycle_phases, c.embedding, d.embedding_model
    FROM kb_cards c JOIN kb_documents d ON d.id = c.document_id WHERE d.active AND d.workspace_id IS NULL ORDER BY c.card_key`);
  const cards = rows.map((r) => ({ card_key: r.card_key, topic: r.topic, body: r.body, knowledge_area: r.knowledge_area, phases: r.lifecycle_phases || [],
    model: r.embedding_model, embedding: r.embedding ? r.embedding.map(Number) : null,
    head: gramSet(`${r.topic} ${(r.keywords || []).join(' ')}`), all: gramSet(`${r.topic} ${(r.keywords || []).join(' ')} ${r.body}`) }));
  const df = new Map(); for (const cd of cards) for (const g of cd.all) df.set(g, (df.get(g) || 0) + 1);
  const idf = new Map([...df].map(([g, n]) => [g, Math.log(1 + cards.length / n)]));
  const entry = { at: Date.now(), stamp, cards, idf };
  caches.set(key, entry);
  return entry;
}

/**
 * Cards for a question. → { cards: [{ card_key, topic, body, score }], mode: 'vector' | 'keyword' | 'none', embedding_tokens }
 * `phase` (project.current_phase) nudges ties toward the stage the PM is in; `preview` (admin prompt preview) never calls the network.
 */
export async function searchKnowledge(db, question, { phase = null, preview = false, embedder = undefined } = {}) {
  const cfg = kbConfig();
  const none = { cards: [], mode: 'none', embedding_tokens: 0 };
  if (!cfg.enabled) return none;
  let cards; let idf; try { ({ cards, idf } = await loadKnowledge(db)); } catch (e) { console.error('[kb] load failed', e.message); return none; }
  if (!cards.length) return none;
  const q = gramSet(question);
  let qv = null; let tokens = 0; let mode = 'keyword';
  const emb = embedder === undefined ? createEmbedder() : embedder;
  const model = cards.find((c) => c.embedding)?.model;
  if (!preview && emb && model && emb.model === model) {
    try { const r = await emb.embed([String(question).slice(0, 2000)]); qv = r.vectors[0]; tokens = r.usage?.input_tokens || 0; mode = 'vector'; }
    catch (e) { console.warn('[kb] query embedding failed, keyword only:', e.code || e.message); }
  }
  const scored = [];
  for (const c of cards) {
    const kw = 0.5 * coverage(q, c.head, idf) + 0.5 * coverage(q, c.all, idf);
    const cos = qv ? cosine(qv, c.embedding) : null;
    let score = cos === null ? kw : cos + 0.25 * kw;
    if (phase && c.phases.includes(phase)) score += 0.03;
    if (score >= (cos === null ? cfg.minKeywordScore : cfg.minVectorScore)) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = []; const perSection = new Map(); let chars = 0;
  for (const c of scored) {   // spread over sections: at most 2 cards from one book section
    const sec = c.card_key.split('#')[0]; const n = perSection.get(sec) || 0;
    if (n >= 2) continue;
    if (chars + c.body.length > cfg.maxChars && out.length) break;
    perSection.set(sec, n + 1); chars += c.body.length;
    out.push({ card_key: c.card_key, topic: c.topic, body: c.body, score: Number(c.score.toFixed(3)) });
    if (out.length >= cfg.topK) break;
  }
  return { cards: out, mode: out.length ? mode : 'none', embedding_tokens: tokens };
}

/** Prompt block. No source, book, author or page — only the rewritten knowledge. */
export function knowledgeBlock(cards) {
  if (!cards.length) return '';
  return `<pm_knowledge>\n${cards.map((c, i) => `[참고 ${i + 1}] ${neutralize(c.topic)}\n${neutralize(c.body)}`).join('\n\n')}\n</pm_knowledge>`;
}
/** What the run records for operators: which cards were given (keys only, fits input_summary). */
export const knowledgeSummary = (r) => (r.cards.length ? `kb ${r.mode} ${r.cards.map((c) => c.card_key).join(',')}` : 'kb none');
