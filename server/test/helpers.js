/* Test database: every call opens a pool on a fresh PostgreSQL schema inside TEST_DATABASE_URL, migrates it, and drops it when the file's tests finish. */
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/relai_test';
const opened = [];
export async function testDb() {
  const schema = 't_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const db = await openDb({ url: TEST_DATABASE_URL, schema, createSchema: true, max: 4 });
  opened.push(db);
  return db;
}
after(async () => { for (const db of opened.splice(0)) { try { await db.close(); } catch { /* already closed */ } try { await db.dropSchema(); } catch { /* ignore */ } } });
