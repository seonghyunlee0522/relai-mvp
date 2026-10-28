#!/usr/bin/env node
/**
 * PM 지식 RAG — step 3: embed the cards and load them into kb_cards (one document = one source). Re-running replaces the
 * document's card set (cards removed from the file are deleted); embeddings are cached in <out>.emb.jsonl so unchanged cards
 * are never embedded twice. The database must already have migration 75 (deploy first).
 *
 *   DATABASE_URL=… OPENAI_API_KEY=… node scripts/kb/load-cards.mjs --in ~/kb/cards.jsonl --doc-key pmbok6-guide --title "PM 참고서 (PMBOK 6 해설)" [--dry-run]
 *
 * Embedding model: KB_EMBEDDING_MODEL (default text-embedding-3-small, US$0.02 / 1M tokens — a 1,000-card corpus costs under US$0.01).
 * The server must embed questions with the same model (same env), otherwise it falls back to keyword search.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, tx } from '../../server/db.js';
import { createEmbedder } from '../../server/ai/provider.js';
import { args, embedText, readJsonl, replaceDocumentCards, sha } from './lib.mjs';

const a = args();
if (!a.in || !a['doc-key'] || !a.title) { console.error('usage: node scripts/kb/load-cards.mjs --in cards.jsonl --doc-key KEY --title "label" [--dry-run]'); process.exit(1); }
const embedder = createEmbedder();
if (!embedder) { console.error('OPENAI_API_KEY is required (embeddings)'); process.exit(1); }

const cards = (await readJsonl(a.in)).filter((c) => c.card_key && !c.empty);
const keys = new Set(); for (const c of cards) { if (keys.has(c.card_key)) { console.error(`duplicate card_key ${c.card_key}`); process.exit(1); } keys.add(c.card_key); }
const cachePath = `${a.in}.emb.jsonl`;
const cache = new Map(existsSync(cachePath) ? (await readFile(cachePath, 'utf8')).split('\n').filter(Boolean).map((l) => { const x = JSON.parse(l); return [`${x.model}:${x.hash}`, x.embedding]; }) : []);
const need = cards.filter((c) => !cache.has(`${embedder.model}:${sha(embedText(c))}`));
console.log(`cards ${cards.length}, embeddings cached ${cards.length - need.length}, to embed ${need.length} (${embedder.model})`);
let tokens = 0;
for (let i = 0; i < need.length; i += 64) {
  const batch = need.slice(i, i + 64); const r = await embedder.embed(batch.map(embedText)); tokens += r.usage?.input_tokens || 0;
  const lines = batch.map((c, j) => { const hash = sha(embedText(c)); cache.set(`${embedder.model}:${hash}`, r.vectors[j]); return JSON.stringify({ model: embedder.model, hash, embedding: r.vectors[j] }); });
  await appendFile(cachePath, lines.join('\n') + '\n');
  process.stdout.write(`\rembedded ${Math.min(i + 64, need.length)}/${need.length}   `);
}
if (need.length) console.log(`\nembedding tokens ${tokens.toLocaleString()}`);
const rows = cards.map((c) => ({ ...c, embedding: cache.get(`${embedder.model}:${sha(embedText(c))}`) }));
if (a['dry-run']) { console.log('dry run — database not touched'); process.exit(0); }

const db = await openDb({ max: 2, applyMigrations: false });
try {
  const has = await db.get(`SELECT to_regclass('kb_cards') AS t`);
  if (!has.t) throw new Error('kb_cards 테이블이 없습니다. 마이그레이션 75가 포함된 버전을 먼저 배포하세요.');
  const r = await tx(db, (t) => replaceDocumentCards(t, { docKey: a['doc-key'], title: a.title, embeddingModel: embedder.model, cards: rows, newId: randomUUID }));
  console.log(`loaded: document ${r.documentId}, ${r.upserted} cards upserted, ${r.removed} removed`);
} finally { await db.close(); }
