#!/usr/bin/env node
/**
 * Grant (or revoke) the SYSTEM_ADMIN role to an existing user. The only way to become a service operator:
 * nothing in the signup flow or the Admin UI can set users.system_role.
 *
 *   DATABASE_URL=postgres://… node scripts/grant-system-admin.js user@email.com
 *   DATABASE_URL=postgres://… node scripts/grant-system-admin.js user@email.com --revoke
 *   node scripts/grant-system-admin.js --list
 */
import { openDb } from '../server/db.js';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const revoke = args.includes('--revoke');
const list = args.includes('--list');
if (!email && !list) { console.error('usage: grant-system-admin.js <email> [--revoke] | --list'); process.exit(2); }

const db = await openDb({ applyMigrations: false });
try {
  if (list) {
    const rows = await db.all(`SELECT email, name, status, created_at FROM users WHERE system_role = 'SYSTEM_ADMIN' ORDER BY email`);
    if (!rows.length) console.log('(no SYSTEM_ADMIN users)');
    for (const r of rows) console.log(`${r.email}\t${r.name}\t${r.status}`);
  } else {
    const u = await db.get('SELECT id, email, system_role, status FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!u) { console.error(`no user with email ${email}`); process.exit(1); }
    const role = revoke ? 'NONE' : 'SYSTEM_ADMIN';
    if (u.system_role === role) { console.log(`${u.email} already has system_role=${role}`); }
    else { await db.run('UPDATE users SET system_role = ? WHERE id = ?', [role, u.id]); console.log(`${u.email}: system_role ${u.system_role} → ${role}`); }
    if (!revoke && u.status !== 'ACTIVE') console.warn(`warning: account status is ${u.status}; the user cannot log in until reactivated.`);
  }
} finally { await db.close(); }
