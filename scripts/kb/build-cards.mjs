#!/usr/bin/env node
/**
 * PM 지식 RAG — step 2: section chunks → knowledge cards (LLM rewrite + verbatim check). Resumable: chunks whose hash already has
 * cards in --out are skipped, so a crash or Ctrl-C loses nothing. Keep --in / --out OUTSIDE the repository.
 *
 *   OPENAI_API_KEY=… node scripts/kb/build-cards.mjs --in ~/kb/chunks.jsonl --out ~/kb/cards.jsonl [--limit 20] [--concurrency 4]
 *
 * Model: KB_CARD_MODEL (default gpt-4o-mini). 920쪽 교재 ≈ 360 chunks ≈ 0.6M input + 0.25M output tokens ≈ US$0.3 on gpt-4o-mini.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createProvider } from '../../server/ai/provider.js';
import { estimateProviderCost } from '../../server/ai/config.js';
import { args, cardsFromChunk, readJsonl } from './lib.mjs';

const a = args();
if (!a.in || !a.out) { console.error('usage: node scripts/kb/build-cards.mjs --in chunks.jsonl --out cards.jsonl [--limit N] [--concurrency 4]'); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is required'); process.exit(1); }
const model = process.env.KB_CARD_MODEL || 'gpt-4o-mini';
const provider = createProvider({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model, timeoutMs: 90_000, maxOutputTokens: 2_000 });

const chunks = await readJsonl(a.in);
const done = new Set(existsSync(a.out) ? (await readFile(a.out, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).source_hash) : []);
const todo = chunks.filter((c) => !done.has(c.hash)).slice(0, a.limit ? Number(a.limit) : undefined);
console.log(`chunks ${chunks.length}, already carded ${done.size}, to do ${todo.length} (model ${model})`);

let i = 0; let cards = 0; let dropped = 0; let empty = 0; let failed = 0; const usage = { input_tokens: 0, output_tokens: 0 };
async function worker() {
  while (i < todo.length) {
    const chunk = todo[i++];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await cardsFromChunk(provider, chunk);
        usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens; dropped += r.dropped;
        // a chunk with no usable card still gets a marker line so it is not retried on the next run
        const lines = r.cards.length ? r.cards : [{ card_key: null, source_hash: chunk.hash, empty: true }];
        if (!r.cards.length) empty++;
        await appendFile(a.out, lines.map((c) => JSON.stringify(c)).join('\n') + '\n');
        cards += r.cards.length;
        process.stdout.write(`\r${i}/${todo.length} chunks · ${cards} cards · dropped(copy) ${dropped} · empty ${empty} · failed ${failed}   `);
        break;
      } catch (e) {
        if (attempt === 3 || !(e.transient || e.code === 'AI_TIMEOUT')) { failed++; console.error(`\n[${chunk.chunk_key}] ${e.code || ''} ${e.detail || e.message}`); break; }
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(a.concurrency) || 4) }, worker));
console.log(`\ndone: ${cards} cards, ${dropped} dropped for copying, ${empty} chunks without cards, ${failed} failed (rerun to retry).`);
console.log(`tokens in ${usage.input_tokens.toLocaleString()} / out ${usage.output_tokens.toLocaleString()} ≈ US$${estimateProviderCost(model, usage.input_tokens, usage.output_tokens) ?? '?'}`);
