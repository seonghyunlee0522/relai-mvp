#!/usr/bin/env node
/**
 * PM 지식 RAG — retrieval evaluation against a golden set: hit@1 / hit@5 by book section of the returned cards. Run after every
 * card rebuild, model change or scoring change (KB_MIN_SCORE, KB_TOP_K). Prints misses so the cards or the set can be fixed.
 *
 *   DATABASE_URL=… OPENAI_API_KEY=… node scripts/kb/eval.mjs [--set scripts/kb/golden-pmbok6.json]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../server/db.js';
import { searchKnowledge } from '../../server/ai/knowledge.js';
import { args } from './lib.mjs';

export async function evaluate(db, set, opts = {}) {
  const rows = [];
  for (const g of set) {
    const r = await searchKnowledge(db, g.q, opts);
    const secs = r.cards.map((c) => c.card_key.split('#')[0]);
    const hit = (s) => g.expect.some((e) => s === e || s.startsWith(`${e}.`));
    rows.push({ q: g.q, mode: r.mode, top: secs.slice(0, 5), hit1: secs.length > 0 && hit(secs[0]), hit5: secs.slice(0, 5).some(hit), none: !secs.length });
  }
  const n = rows.length || 1;
  return { rows, hit1: rows.filter((r) => r.hit1).length / n, hit5: rows.filter((r) => r.hit5).length / n, empty: rows.filter((r) => r.none).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args();
  const set = JSON.parse(await readFile(a.set || new URL('./golden-pmbok6.json', import.meta.url), 'utf8'));
  const db = await openDb({ max: 2, applyMigrations: false });
  try {
    const r = await evaluate(db, set);
    for (const x of r.rows) if (!x.hit5) console.log(`MISS  ${x.q}  → [${x.top.join(', ')}] (${x.mode})`);
    console.log(`questions ${r.rows.length} · hit@1 ${(r.hit1 * 100).toFixed(0)}% · hit@5 ${(r.hit5 * 100).toFixed(0)}% · no knowledge ${r.empty}`);
  } finally { await db.close(); }
}
