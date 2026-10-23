/* 요구사항 담당자 = 01 관계자 only (founder 2026-10-23): migration 71 moves RELAI-user owners to a 관계자 (same name, else the user is
 * added to 01 as 당사), samples are copied with their 당사 관계자 as owner, and the API's owner directory carries no members. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup } from './api-helpers.js';
import { migrations } from '../migrations.js';
import { addSampleProjects } from '../samples/index.js';

const insReq = (db, pid, title, uid, seq) => db.run(`INSERT INTO requirements (id, project_id, sequence_number, display_id, title, owner_user_id) VALUES (?,?,?,?,?,?)`,
  [randomUUID(), pid, seq, `REQ-${String(seq).padStart(3, '0')}`, title, uid]);

test('migration 71: a requirement owned by a user moves to the 관계자 with the same name, or the user is added to 01 as 당사', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'mig71@x.com');   // name 홍길동
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: [{ id: 'sh-hong', name: '홍 길동', org_type: 'OWN' }, { id: 'sh-c', name: '고객', org_type: 'CLIENT' }] });
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: '두 번째', client_name: 'B', planned_start_date: '2026-11-01', planned_end_date: '2027-01-31', project_type: 'NEW_BUILD' })).json.project;
  await insReq(db, A.p.id, '같은 이름 관계자 있음', A.uid, 901);
  await insReq(db, p2.id, '관계자 없음', A.uid, 901);
  await migrations.find((m) => m.version === 71).up(db);
  const one = await db.get(`SELECT owner_user_id, owner_stakeholder_id FROM requirements WHERE title = '같은 이름 관계자 있음'`);
  assert.deepEqual([one.owner_user_id, one.owner_stakeholder_id], [null, 'sh-hong']);
  const two = await db.get(`SELECT owner_user_id, owner_stakeholder_id FROM requirements WHERE title = '관계자 없음'`);
  assert.equal(two.owner_user_id, null); assert.ok(two.owner_stakeholder_id);
  const sh = JSON.parse((await db.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [p2.id])).stakeholders);
  assert.deepEqual(sh.map((x) => [x.id, x.name, x.org_type]), [[two.owner_stakeholder_id, '홍길동', 'OWN']]);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM requirements WHERE owner_user_id IS NOT NULL')).n, 0);
  // the list shows the 관계자, and the owner directory offered to the picker is 01 관계자 (no members)
  const list = (await A.c('GET', `/api/workspaces/${A.w}/projects/${p2.id}/requirements`)).json;
  assert.equal(list.requirements[0].owner_name, '홍길동'); assert.equal(list.requirements[0].owner_no_account, true);
  server.close();
});

test('samples: requirement owners are the sample 당사 관계자, never the account user', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'smp-owner@x.com');
  const created = await addSampleProjects(db, { workspaceId: A.w, userId: A.uid, userName: '홍길동' });
  assert.ok(created.length >= 1);
  const ids = created.map((c) => c.id);
  const rows = await db.all(`SELECT project_id, owner_user_id, owner_stakeholder_id FROM requirements WHERE project_id = ANY(?::text[])`, [ids]);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.owner_user_id === null), 'no RELAI user owns a sample requirement');
  for (const pid of ids) {
    const sh = JSON.parse((await db.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [pid])).stakeholders);
    const own = sh.find((x) => x.org_type === 'OWN');
    for (const r of rows.filter((x) => x.project_id === pid)) assert.equal(r.owner_stakeholder_id, own.id);
  }
  server.close();
});
