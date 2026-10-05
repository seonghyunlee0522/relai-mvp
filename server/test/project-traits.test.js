/* 프로젝트 기본 특성: required type on create, TBD defaults, enum validation, edit via PATCH and via 프로젝트 정의 (same save flow,
 * no completion), legacy rows (type NULL), Charter read model, AI block unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, project } from './api-helpers.js';
import { PROJECT_TRAITS, TRAIT_FIELDS, traitLabel } from '../../public/app/shared/project-traits.js';
import { parseTraits } from '../validate.js';

test('traits: one option set — codes, labels, TBD defaults (never NO)', () => {
  assert.deepEqual(TRAIT_FIELDS, ['project_type', 'deployment_environment', 'data_migration', 'delivery_model', 'has_existing_system', 'has_external_integration']);
  assert.deepEqual(PROJECT_TRAITS[0].options.map((o) => o.value), ['NEW_BUILD', 'ENHANCEMENT', 'TRANSITION', 'OTHER']);
  for (const t of PROJECT_TRAITS.slice(1)) { assert.equal(t.default, 'TBD'); assert.ok(t.options.some((o) => o.value === 'TBD')); }
  assert.equal(traitLabel('project_type', null), '미설정'); assert.equal(traitLabel('data_migration', 'TBD'), '미정'); assert.equal(traitLabel('deployment_environment', 'ON_PREMISE'), 'On-Premise');
  const f = {}; assert.deepEqual(parseTraits({}, f, { requireType: false }), { project_type: null, deployment_environment: 'TBD', data_migration: 'TBD', delivery_model: 'TBD', has_existing_system: 'TBD', has_external_integration: 'TBD' });
  const f2 = {}; parseTraits({ project_type: 'SI', delivery_model: 'X' }, f2); assert.ok(f2.project_type && f2.delivery_model);
});

test('traits: create requires project_type, others default TBD, invalid codes refused; PATCH keeps / changes them', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'tr1@x.com');
  const P = `/api/workspaces/${A.w}/projects`;
  let r = await A.c('POST', P, project({ name: '유형 없음', project_type: undefined }));
  assert.equal(r.status, 400); assert.match(r.json.error.fields.project_type, /유형/);
  r = await A.c('POST', P, project({ name: '잘못된 값', project_type: 'SI' })); assert.equal(r.status, 400);
  r = await A.c('POST', P, project({ name: '잘못된 환경', deployment_environment: 'AWS' })); assert.equal(r.status, 400); assert.ok(r.json.error.fields.deployment_environment);
  r = await A.c('POST', P, project({ name: '기본값', project_type: 'ENHANCEMENT' })); assert.equal(r.status, 201);
  const p = r.json.project;
  assert.deepEqual(TRAIT_FIELDS.map((k) => p[k]), ['ENHANCEMENT', 'TBD', 'TBD', 'TBD', 'TBD', 'TBD']);
  r = await A.c('POST', P, project({ name: '전부', project_type: 'TRANSITION', data_migration: 'YES', deployment_environment: 'ON_PREMISE', delivery_model: 'ONSITE', has_existing_system: 'YES', has_external_integration: 'NO' }));
  assert.equal(r.status, 201); assert.equal(r.json.project.delivery_model, 'ONSITE'); assert.equal(r.json.project.has_external_integration, 'NO');
  const purl = `${P}/${p.id}`;
  r = await A.c('PATCH', purl, { name: '기본값 수정' }); assert.equal(r.status, 200); assert.equal(r.json.project.project_type, 'ENHANCEMENT', 'untouched traits kept');
  r = await A.c('PATCH', purl, { delivery_model: 'HYBRID' }); assert.equal(r.json.project.delivery_model, 'HYBRID');
  assert.equal((await A.c('PATCH', purl, { delivery_model: 'NOPE' })).status, 400);
  server.close();
});

test('traits: edited in 프로젝트 정의 through the same PUT, stored on the project, never completes a step; legacy NULL type allowed', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'tr2@x.com');
  const D = `${A.purl}/definition`;
  let r = await A.c('GET', D);
  assert.equal(r.json.project_traits.project_type, 'NEW_BUILD'); assert.equal(r.json.project_traits.data_migration, 'TBD');
  r = await A.c('PUT', D, { data_migration: 'YES', deployment_environment: 'CLOUD', has_existing_system: 'YES' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project_traits.data_migration, 'YES'); assert.equal(r.json.project_traits.deployment_environment, 'CLOUD');
  assert.ok(r.json.sections.every((s) => s.status === 'TODO'), 'saving traits completes nothing');
  assert.equal((await A.c('GET', A.purl)).json.project.has_existing_system, 'YES', 'stored on the project itself');
  assert.equal((await A.c('PUT', D, { delivery_model: 'FREELANCE' })).status, 400);
  // traits + section fields in one save
  r = await A.c('PUT', D, { project_type: 'OTHER', goal: '목표' }); assert.equal(r.status, 200); assert.equal(r.json.project_traits.project_type, 'OTHER'); assert.equal(r.json.definition.goal, '목표');
  // Charter reads them straight from the project
  const c = (await A.c('GET', `${A.purl}/charter`)).json.charter;
  assert.equal(c.profile.project_type, '기타');
  assert.deepEqual(c.profile.traits.map((t) => [t.field, t.value, t.value_label]), [['project_type', 'OTHER', '기타'], ['deployment_environment', 'CLOUD', 'Cloud'], ['data_migration', 'YES', '있음'], ['delivery_model', 'TBD', '미정'], ['has_existing_system', 'YES', '있음'], ['has_external_integration', 'TBD', '미정']]);
  // legacy project: NULL type → 미설정, other screens fine, PATCH without type still works
  await db.run('UPDATE projects SET project_type = NULL WHERE id = ?', [A.p.id]);
  assert.equal((await A.c('GET', A.purl)).status, 200);
  assert.equal((await A.c('GET', D)).json.project_traits.project_type, null);
  const c2 = (await A.c('GET', `${A.purl}/charter`)).json.charter; assert.equal(c2.profile.traits[0].value_label, '미설정');
  assert.equal((await A.c('PATCH', A.purl, { name: '레거시 수정' })).status, 200);
  await assert.rejects(() => db.run("UPDATE projects SET data_migration = 'MAYBE' WHERE id = ?", [A.p.id]), /check/i);
  server.close();
});
