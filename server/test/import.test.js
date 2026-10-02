import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_TIMEZONE } from '../db.js';
import { boot, setup, addMember, xlsxBase64, readXlsx, REQ_HEADERS, WBS_HEADERS } from './api-helpers.js';
import { MAX_IMPORT_ROWS } from '../xlsx.js';

const row = (rows, n) => rows.find((r) => r.row === n);

test('template: requirements + wbs download as xlsx with styled header, dropdowns and guide sheet', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  for (const [kind, url, sheet, headers, enumCol, ascii, korean] of [
    ['requirements', `${A.req}/template.xlsx`, '요구사항', REQ_HEADERS, 4, 'requirements-template.xlsx', '요구사항 등록 템플릿.xlsx'],
    ['wbs', `${A.wbs}/template.xlsx`, 'WBS', WBS_HEADERS, 3, 'wbs-template.xlsx', 'WBS 등록 템플릿.xlsx'],
  ]) {
    const r = await A.c('GET', url);
    assert.equal(r.status, 200, kind);
    assert.match(r.headers.get('content-type'), /spreadsheetml\.sheet/);
    const cd = r.headers.get('content-disposition');
    assert.ok(cd.includes(`filename="${ascii}"`), cd);
    assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent(korean)}`), cd);
    const wb = await readXlsx(r.buf);
    assert.equal(wb.worksheets[0].name, sheet);
    assert.equal(wb.worksheets[1].name, '작성 안내');
    const ws = wb.worksheets[0];
    assert.deepEqual(headers.map((_, i) => ws.getCell(1, i + 1).value), headers);   // header text has no `*`
    assert.equal(ws.rowCount, 1);                                                  // no example rows
    assert.equal(ws.views[0].state, 'frozen');
    const req = ws.getCell(1, headers.indexOf(kind === 'requirements' ? '요구사항명' : 'WBS Code') + 1);
    assert.equal(req.font.bold, true); assert.equal(req.fill.fgColor.argb, 'FF2563EB');
    const letter = String.fromCharCode(64 + enumCol);
    const lastDataRow = MAX_IMPORT_ROWS + 1;                                        // 2,000th data row
    assert.equal(ws.getCell(`${letter}2`).dataValidation?.type, 'list');           // dropdown on every importable row
    assert.equal(ws.getCell(`${letter}1001`).dataValidation?.type, 'list');
    assert.equal(ws.getCell(`${letter}${lastDataRow}`).dataValidation?.type, 'list');
    assert.equal(ws.getCell(`${letter}${lastDataRow + 1}`).dataValidation, undefined);
    if (kind === 'wbs') {                                                           // number validation (진행률) covers the same range
      const prog = String.fromCharCode(64 + WBS_HEADERS.indexOf('진행률') + 1);
      assert.equal(ws.getCell(`${prog}2`).dataValidation?.type, 'whole');
      assert.equal(ws.getCell(`${prog}${lastDataRow}`).dataValidation?.type, 'whole');
      assert.equal(ws.getCell(`${prog}${lastDataRow + 1}`).dataValidation, undefined);
    }
    // guide sheet lists every column
    const guide = wb.worksheets[1]; const names = []; guide.eachRow((r) => names.push(r.getCell(1).value));
    for (const h of headers) assert.ok(names.includes(h), `guide misses ${h}`);
  }
  server.close();
});

test('tenant isolation (404), archived project (409 on writes only), CSRF content type', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const data = await xlsxBase64(REQ_HEADERS, [['', '로그인', '', '', '', '', '', '', '', '', '']]);
  for (const [m, p, b] of [['GET', `${A.req}/template.xlsx`], ['GET', `${A.req}/export.xlsx`], ['GET', `${A.wbs}/template.xlsx`], ['GET', `${A.wbs}/export.xlsx`],
    ['POST', `${A.req}/import/preview`, { data }], ['POST', `${A.req}/import`, { rows: [] }], ['POST', `${A.req}/import/errors.xlsx`, { rows: [] }],
    ['POST', `${A.wbs}/import/preview`, { rows: [] }], ['POST', `${A.wbs}/import`, { rows: [] }]]) {
    assert.equal((await B.c(m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.equal((await client()('GET', `${A.req}/template.xlsx`)).status, 401);
  const rid = (await A.c('POST', A.req, { title: 'x' })).json.requirement.id;
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('POST', `${A.req}/import`, { rows: [{ row: 2, values: { title: 'x' } }] })).status, 409);
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows: [{ row: 2, values: { code: '1', title: 'x' } }] })).status, 409);
  assert.equal((await A.c('POST', `${A.req}/import/preview`, { data })).status, 200);       // read-only paths stay available
  assert.equal((await A.c('GET', `${A.req}/export.xlsx`)).status, 200);
  assert.equal((await A.c('GET', `${A.req}/template.xlsx`)).status, 200);
  assert.ok(rid);
  // non-JSON content type is refused by the CSRF middleware
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  server.close();
});

test('requirements preview: label/code enums, owner match, blank rows skipped, duplicates, warnings, no DB writes', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const B = await addMember(client, A, 'kim@x.com', '김철수'); const C = await addMember(client, A, 'kim2@x.com', '김철수');
  await A.c('POST', A.req, { title: '기존' });                       // REQ-001 exists
  const data = await xlsxBase64([...REQ_HEADERS, '메모'], [
    ['', 'SSO 로그인', '설명', '기능', 'High', '범위 내', '확정', 'u@x.com', '김OO', 'A사', '조건1\n조건2'],            // 2 ok (owner by e-mail)
    [],                                                                                                                  // 3 empty -> skipped
    ['', '대문자 코드', '', 'non_functional', 'low', 'in_scope', 'REVIEWING', '홍길동', '', '', ''],                      // 4 ok (codes, owner by name)
    ['REQ-001', '이미 있는 ID', '', '', '', '', '', '', '', '', ''],                                                     // 5 existing id
    ['REQ-007', '신규 ID', '', '', '', '', '', '', '', '', ''],                                                          // 6 ok
    ['req-7', '파일 내 중복', '', '', '', '', '', '', '', '', ''],                                                       // 7 duplicate inside file
    ['', '', '', '', '', '', '', '', '', '', ''].map((x, i) => (i === 3 ? '' : x)),                                       // 8 empty
    ['', '이상한 값', '', '없는분류', 'Urgent', '모름', '끝', '없는사람@x.com', '', '', ''],                               // 9 many errors
    ['', '이름 중복 담당', '', '', '', '', '', '김철수', '', '', ''],                                                    // 10 ambiguous name
    ['ABC', 'ID 형식', '', '', '', '', '', '', '', '', ''],                                                               // 11 bad id format
    ['', 'x'.repeat(201), '', '', '', '', '', '', '', '', ''],                                                            // 12 title too long
    ['', '긴 완료조건', '', '', '', '', '', '', '', '', `ok\n${'가'.repeat(1001)}`],                                       // 13 criterion too long
    ['', '', '설명만 있음', '', '', '', '', '', '', '', ''],                                                              // 14 title missing
    ['', 'a', '', '', '', '', '', '', '', '', '', '무시될 메모'],
  ]);
  const before = (await A.c('GET', A.req)).json.requirements.length;
  const r = await A.c('POST', `${A.req}/import/preview`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json;
  assert.deepEqual(j.columns.map((c) => c.key), ['display_id', 'title', 'description', 'type', 'priority', 'scope', 'status', 'owner', 'requester_name', 'requester_organization', 'criteria']);
  assert.equal(j.columns.find((c) => c.key === 'title').required, true);
  assert.equal(j.columns.find((c) => c.key === 'type').type, 'enum');
  assert.ok(j.columns.find((c) => c.key === 'type').options.some((o) => o.value === 'NON_FUNCTIONAL' && o.label === '비기능'));
  assert.deepEqual(j.warnings, ["알 수 없는 열 '메모'은(는) 무시했습니다."]);
  assert.ok(!j.rows.some((x) => x.row === 3 || x.row === 8));
  assert.equal(j.summary.total, j.rows.length);
  assert.equal(j.summary.ok + j.summary.error, j.summary.total);
  assert.equal(row(j.rows, 2).ok, true); assert.equal(row(j.rows, 2).values.criteria, '조건1\n조건2'); assert.equal(row(j.rows, 2).values.type, '기능');
  assert.equal(row(j.rows, 4).ok, true);
  assert.equal(row(j.rows, 5).errors.display_id, '중복된 요구사항 ID입니다.');
  assert.equal(row(j.rows, 6).ok, true);
  assert.match(row(j.rows, 7).errors.display_id, /파일 내/);
  const e9 = row(j.rows, 9).errors;
  assert.deepEqual(Object.keys(e9).sort(), ['owner', 'priority', 'scope', 'status', 'type']);
  assert.equal(e9.owner, '담당자를 찾을 수 없습니다.');
  assert.match(row(j.rows, 10).errors.owner, /이메일/);
  assert.match(row(j.rows, 11).errors.display_id, /형식/);
  assert.ok(row(j.rows, 12).errors.title);
  assert.ok(row(j.rows, 13).errors.criteria);
  assert.equal(row(j.rows, 14).errors.title, '필수 항목입니다.');
  assert.equal((await A.c('GET', A.req)).json.requirements.length, before);   // preview never writes
  void B; void C;

  // re-validate edited rows (no file)
  const edited = await A.c('POST', `${A.req}/import/preview`, { rows: [{ row: 9, values: { title: '고침', type: '기능' } }, { row: 5, values: { display_id: 'REQ-001', title: 'x' } }, { row: 20, values: {} }] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.json.rows.map((x) => [x.row, x.ok]), [[9, true], [5, false]]);
  assert.equal(edited.json.summary.total, 2);
  server.close();
});

test('file errors: bad base64, not an xlsx, missing required header, too many rows, too large', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const url = `${A.req}/import/preview`;
  for (const data of ['!!!notbase64!!!', Buffer.from('hello world, not a zip').toString('base64'), '', 123]) {
    const r = await A.c('POST', url, { data });
    assert.equal(r.status, 400); assert.equal(r.json.error.message, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  }
  const zipLike = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('garbage-garbage-garbage')]).toString('base64');
  assert.equal((await A.c('POST', url, { data: zipLike })).json.error.message, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  const noTitle = await xlsxBase64(['요구사항 ID', '설명'], [['', 'x']]);
  const m = await A.c('POST', url, { data: noTitle });
  assert.equal(m.status, 400); assert.match(m.json.error.message, /필수 열이 없습니다: 요구사항명/);
  const wbsNoCode = await xlsxBase64(['업무명'], [['x']]);
  assert.match((await A.c('POST', `${A.wbs}/import/preview`, { data: wbsNoCode })).json.error.message, /WBS Code/);
  // header matching ignores case / inner spaces
  const loose = await xlsxBase64(['요구사항명 *', ' WBS  code'.trim()], [['a', 'b']]);
  assert.equal((await A.c('POST', url, { data: loose })).status, 200);
  // 2001 data rows
  const many = await xlsxBase64(['요구사항명'], Array.from({ length: 2001 }, (_, i) => [`r${i}`]));
  const t = await A.c('POST', url, { data: many });
  assert.equal(t.status, 400); assert.match(t.json.error.message, /2,000행/);
  assert.equal((await A.c('POST', url, { rows: Array.from({ length: 2001 }, (_, i) => ({ row: i + 2, values: { title: 'x' } })) })).status, 400);
  const exactly = await xlsxBase64(['요구사항명'], Array.from({ length: 2000 }, (_, i) => [`r${i}`]));
  const ok = await A.c('POST', url, { data: exactly });
  assert.equal(ok.status, 200); assert.equal(ok.json.summary.total, 2000);
  // > 5 MB file
  const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(5 * 1024 * 1024 + 10, 1)]).toString('base64');
  const tooBig = await A.c('POST', url, { data: big });
  assert.equal(tooBig.status, 413); assert.match(tooBig.json.error.message, /5MB/);
  server.close();
});

test('body limits: 64kb elsewhere, import endpoints accept a larger JSON body, > 8 MB gets a Korean 413', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const r = await A.c('POST', A.req, { title: 'x', description: 'a'.repeat(70 * 1024) });
  assert.equal(r.status, 413); assert.equal(r.json.error.code, 'payload_too_large'); assert.match(r.json.error.message, /너무 큽니다/);
  const rows = Array.from({ length: 20 }, (_, i) => ({ row: i + 2, values: { title: `t${i}`, description: 'a'.repeat(6000) } }));
  const pr = await A.c('POST', `${A.req}/import/preview`, { rows });
  assert.equal(pr.status, 200); assert.equal(pr.json.summary.total, 20);
  const huge = await A.c('POST', `${A.req}/import/preview`, { data: 'A'.repeat(9 * 1024 * 1024) });
  assert.equal(huge.status, 413); assert.match(huge.json.error.message, /너무 큽니다/);
  // the big parser only runs after auth/membership
  const B = await setup(client, 'b@x.com');
  assert.equal((await B.c('POST', `${A.req}/import/preview`, { data: 'A'.repeat(200000) })).status, 404);
  server.close();
});

test('requirements import: partial success, explicit + auto ids never collide, history + criteria written, one transaction', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  await addMember(client, A, 'kim@x.com', '김철수');
  const rows = [
    { row: 2, values: { title: '첫째 (자동)', description: 'd', type: '기능', priority: 'High', scope: '범위 내', status: '확정', owner: 'kim@x.com', requester_name: '요청자', requester_organization: '소속', criteria: '조건 A\n\n조건 B\n' } },
    { row: 3, values: { display_id: 'REQ-001', title: '명시 ID' } },            // claims REQ-001 → the auto row above must not take it
    { row: 4, values: { description: '제목 없음' } },                             // invalid
    { row: 5, values: { title: '셋째', type: '이상한값' } },                     // invalid
    { row: 6, values: { title: '넷째 (자동)', owner: '김철수' } },
    { row: 7, values: { display_id: 'REQ-010', title: '열 번째' } },
  ];
  const r = await A.c('POST', `${A.req}/import`, { rows });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 6); assert.equal(r.json.created, 4); assert.equal(r.json.failed, 2);
  const byRow = Object.fromEntries(r.json.results.map((x) => [x.row, x]));
  assert.equal(byRow[3].display_id, 'REQ-001');
  assert.equal(byRow[2].display_id, 'REQ-002'); assert.equal(byRow[6].display_id, 'REQ-003'); assert.equal(byRow[7].display_id, 'REQ-010');
  assert.equal(byRow[4].ok, false); assert.equal(byRow[4].errors.title, '필수 항목입니다.'); assert.ok(byRow[5].errors.type); assert.equal(byRow[4].id, undefined);
  assert.equal(r.json.summary.total, 4);
  const full = (await A.c('GET', `${A.req}/${byRow[2].id}`)).json.requirement;
  assert.equal(full.type, 'FUNCTIONAL'); assert.equal(full.priority, 'HIGH'); assert.equal(full.scope, 'IN_SCOPE'); assert.equal(full.status, 'CONFIRMED');
  assert.equal(full.owner_name, '김철수'); assert.equal(full.requester_name, '요청자');
  assert.deepEqual(full.criteria.map((c) => c.content), ['조건 A', '조건 B']);
  assert.equal(full.history[0].action_type, 'CREATED');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requirement_history WHERE action_type = ?', ['CREATED'])).n, 4);
  // auto numbering continues after the highest explicit id
  assert.equal((await A.c('POST', A.req, { title: '다음' })).json.requirement.display_id, 'REQ-011');
  // re-importing the same explicit id is now rejected server-side
  const again = await A.c('POST', `${A.req}/import`, { rows: [{ row: 2, values: { display_id: 'REQ-010', title: 'dup' } }] });
  assert.equal(again.json.created, 0); assert.equal(again.json.results[0].errors.display_id, '중복된 요구사항 ID입니다.');
  // every row invalid → 200 with created: 0
  const none = await A.c('POST', `${A.req}/import`, { rows: [{ row: 2, values: { title: '', type: '기능' } }, { row: 3, values: { description: 'x' } }] });
  assert.equal(none.status, 200); assert.equal(none.json.created, 0); assert.equal(none.json.failed, 2);
  assert.equal((await A.c('POST', `${A.req}/import`, { rows: 'nope' })).status, 400);
  server.close();
});

test('import atomicity: a failure while creating rolls back every row', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  // sabotage: a trigger-free way to fail late — make the last row's criteria insert violate a CHECK by dropping the table column default is invasive,
  // so instead rename the criteria table for the duration of the call.
  await db.run('ALTER TABLE requirement_criteria RENAME TO requirement_criteria_x');
  const log = console.error; console.error = () => {};            // the expected 500 is logged by the error handler
  let r;
  try { r = await A.c('POST', `${A.req}/import`, { rows: [{ row: 2, values: { title: 'a' } }, { row: 3, values: { title: 'b', criteria: 'c1' } }] }); } finally { console.error = log; }
  await db.run('ALTER TABLE requirement_criteria_x RENAME TO requirement_criteria');
  assert.equal(r.status, 500);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requirements')).n, 0);
  assert.equal((await A.c('POST', A.req, { title: 'first' })).json.requirement.display_id, 'REQ-001');   // counter rolled back too
  server.close();
});

test('requirements export: same columns as the template, non-archived data, Korean filename; errors.xlsx round trip', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const a = (await A.c('POST', A.req, { title: '로그인', description: '설명', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED', owner_user_id: A.uid, requester_name: '김', requester_organization: 'A사', criteria: ['조건1', '조건2'] })).json.requirement;
  const b = (await A.c('POST', A.req, { title: '보관됨' })).json.requirement;
  await A.c('POST', `${A.req}/${b.id}/archive`, {});
  const r = await A.c('GET', `${A.req}/export.xlsx`);
  assert.equal(r.status, 200);
  const cd = r.headers.get('content-disposition');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent(`요구사항_테스트_프로젝트_${today}.xlsx`)}`), cd);
  assert.ok(cd.startsWith('attachment; filename="requirements-export.xlsx"'), cd);
  const ws = (await readXlsx(r.buf)).worksheets[0];
  assert.equal(ws.rowCount, 2);
  assert.deepEqual(ws.getRow(2).values.slice(1, 12), ['REQ-001', '로그인', '설명', '기능', 'High', '범위 내', '확정', '홍길동', '김', 'A사', '조건1\n조건2']);
  assert.equal(a.display_id, 'REQ-001');
  // sanitised file names
  await A.c('PATCH', A.purl, { name: 'a/b:c*?"<>|', description: '', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' });
  const r2 = await A.c('GET', `${A.req}/export.xlsx`);
  assert.ok(decodeURIComponent(r2.headers.get('content-disposition').split("UTF-8''")[1]).startsWith('요구사항_abc_'));
  // error report
  const failed = [{ row: 5, values: { title: '', type: '이상' }, errors: { title: '필수 항목입니다.', type: '분류 값이 올바르지 않습니다.' }, row_errors: ['기타 오류'] }];
  const e = await A.c('POST', `${A.req}/import/errors.xlsx`, { rows: failed });
  assert.equal(e.status, 200); assert.match(e.headers.get('content-disposition'), /filename="requirements-import-errors\.xlsx"; filename\*=UTF-8''/);
  const ews = (await readXlsx(e.buf)).worksheets[0];
  assert.deepEqual(ews.getRow(1).values.slice(1), ['원본 행', ...REQ_HEADERS_LOCAL, '오류 사유']);
  assert.equal(ews.getRow(2).getCell(1).value, 5);
  assert.equal(ews.getRow(2).getCell(13).value, '요구사항명: 필수 항목입니다.\n분류: 분류 값이 올바르지 않습니다.\n기타 오류');
  assert.equal((await A.c('POST', `${A.req}/import/errors.xlsx`, { rows: 'x' })).status, 400);
  server.close();
});
const REQ_HEADERS_LOCAL = ['요구사항 ID', '요구사항명', '요구사항 설명', '분류', '우선순위', '범위', '상태', '담당자', '요청자', '요청자 소속', '완료 조건'];

test('file import round trip: xlsx dates / numbers / rich values reach the preview normalised', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const data = await xlsxBase64(WBS_HEADERS_LOCAL, [
    [1, '', '', '일정 작업', '', '', new Date(Date.UTC(2026, 10, 2)), '2026.11.13', '진행 중', 50, ''],
    ['2', '', '마일스톤', '오픈', '', '', '', '2026/12/1', '', '', ''],
    ['3', '', '', '잘못된 날짜', '', '', '2026-13-45', '', '', '', ''],
  ]);
  const r = await A.c('POST', `${A.wbs}/import/preview`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [a, b, c] = r.json.rows;
  assert.deepEqual([a.values.code, a.values.start, a.values.end, a.values.progress, a.ok], ['1', '2026-11-02', '2026-11-13', '50', true]);
  assert.deepEqual([b.values.end, b.ok], ['2026-12-01', true]);
  assert.match(c.errors.start, /날짜 형식/);
  server.close();
});
const WBS_HEADERS_LOCAL = ['WBS Code', '상위 WBS', '유형', '업무명', '업무 설명', '담당자', '시작일', '종료일', '상태', '진행률', '선행 작업'];

const W = (code, title, extra = {}) => ({ code, title, ...extra });
const wrows = (list) => list.map((values, i) => ({ row: i + 2, values }));

test('wbs preview: validation rules (codes, parent, types, dates, progress, predecessors, cycles, cascade)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const list = [
    W('1', '분석', {}),                                                       // 2 SUMMARY (has children)
    W('1.1', '요구사항', { start: '2026-11-02', end: '2026-11-06', progress: '30' }),   // 3 TASK
    W('1.2', '설계', { start: '2026-11-09', end: '2026-11-05' }),            // 4 end < start
    W('1.2', '중복 코드'),                                                    // 5 duplicate
    W('3.1', '부모 없음'),                                                    // 6 parent 3 missing
    W('4', '마일스톤', { item_type: '마일스톤', start: '2026-11-01', end: '2026-12-01' }),   // 7 milestone with start
    W('4.1', '마일스톤 아래'),                                               // 8 parent is milestone
    W('5', '상위', { progress: '10' }),                                      // 9 summary w/ progress (has child 5.1)
    W('5.1', '작업', { parent_code: '9' }),                                  // 10 wrong parent_code
    W('6', '진행률 범위', { progress: '101' }),                              // 11
    W('7', '선행 알 수 없음', { predecessors: '99' }),                       // 12
    W('8', '자기 참조', { predecessors: '8' }),                              // 13
    W('9', '순환 A', { predecessors: '10' }),                                // 14
    W('10', '순환 B', { predecessors: '9' }),                                // 15 closes the cycle
    W('11', '정상 선행', { predecessors: '1.1, 6x' }),                       // 16 6x unknown
    W('12', '상위 오류의 자식 부모'),                                         // 17 has child below (12.1) and is fine...
    W('12.1', '자식 정상'),
    W('1.3', '선행이 오류', { predecessors: '1.2' }),                         // 19 pred 1.2 failed -> error
    W('abc', '형식'),                                                         // 20
    W('', '코드 없음'),                                                       // 21
    W('13', '', {}),                                                          // 22 title missing
    W('13.1', '제목 없는 부모의 자식'),                                       // 23 cascade
    W('14', '상태', { status: '아무거나' }),                                 // 24
  ];
  const r = await A.c('POST', `${A.wbs}/import/preview`, { rows: wrows(list) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = (n) => row(r.json.rows, n);
  assert.equal(g(2).ok, true); assert.equal(g(3).ok, true);
  assert.equal(g(4).errors.end, '종료일은 시작일보다 빠를 수 없습니다.');
  assert.equal(g(5).errors.code, '중복된 WBS Code입니다.');
  assert.match(g(6).errors.code, /상위 항목\(3\)이 파일에 없습니다/);
  assert.match(g(7).errors.start, /시작일/);
  assert.match(g(8).errors.code, /마일스톤 아래/);
  assert.match(g(9).errors.progress, /하위 작업/);
  assert.match(g(10).errors.parent_code, /\(5\)/);
  assert.match(g(11).errors.progress, /0~100/);
  assert.match(g(12).errors.predecessors, /'99'/);
  assert.match(g(13).errors.predecessors, /자기 자신/);
  assert.match(g(15).errors.predecessors, /순환/);                               // the row that closes the cycle
  assert.match(g(14).errors.predecessors, /'10'.*오류/);                          // …and its partner cannot be linked to a row that fails
  assert.match(g(16).errors.predecessors, /'6x'/);
  assert.equal(g(17).ok, true); assert.equal(g(18).ok, true);
  assert.match(g(19).errors.predecessors, /'1\.2'.*오류/);
  assert.match(g(20).errors.code, /형식/);
  assert.equal(g(21).errors.code, '필수 항목입니다.');
  assert.equal(g(22).errors.title, '필수 항목입니다.');
  assert.deepEqual(g(23).row_errors, ['상위 항목 오류로 가져오지 못했습니다.']); assert.equal(g(23).ok, false);
  assert.ok(g(24).errors.status);
  // a row whose predecessor cannot be created cannot be created either (rows 14/19); 5.1 has its own parent_code error
  assert.equal(r.json.summary.total, list.length);
  server.close();
});

test('wbs import: hierarchy + file order, auto types, dates/milestone, owner, predecessors, history, parent_id, partial success', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  const pre = (await A.c('POST', A.wbs, { item_type: 'SUMMARY', title: '기존 상위' })).json.item;
  const pre2 = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '기존 작업' })).json.item;
  const list = [
    W('1', '분석'),
    W('1.1', '요구사항 분석', { start: '2026-11-02', end: '2026-11-06', owner: 'u@x.com', status: '진행 중', progress: '40', description: '설명' }),
    W('1.2', '인터뷰', { start: '2026-11-09', end: '2026-11-13', predecessors: '1.1' }),
    W('2', '설계', { item_type: '상위 항목' }),
    W('2.1', '화면 설계', { status: 'COMPLETED' }),
    W('2.1.1', '목록', {}),
    W('3', '오픈', { item_type: '마일스톤', end: '2026-12-01', predecessors: '2.1, 1.2' }),
    W('9.9', '고아'),                      // fails (no parent 9)
    W('4', '마지막 작업'),
  ];
  // children listed BEFORE their parent in the file still land in the right place
  list.splice(1, 0, W('0.5', '무시 대상'));
  const r = await A.c('POST', `${A.wbs}/import`, { rows: wrows(list) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, list.length); assert.equal(r.json.created, list.length - 2); assert.equal(r.json.failed, 2);
  const bad = r.json.results.filter((x) => !x.ok).map((x) => x.row).sort();
  assert.deepEqual(bad, [2 + 1, 2 + 8].sort());
  const tree = (await A.c('GET', A.wbs)).json;
  const codes = tree.items.map((i) => `${i.wbs_code}:${i.title}`);
  assert.deepEqual(codes, ['1:기존 상위', '2:기존 작업', '3:분석', '3.1:요구사항 분석', '3.2:인터뷰', '4:설계', '4.1:화면 설계', '4.1.1:목록', '5:오픈', '6:마지막 작업']);
  const byTitle = Object.fromEntries(tree.items.map((i) => [i.title, i]));
  assert.equal(byTitle['분석'].item_type, 'SUMMARY'); assert.equal(byTitle['요구사항 분석'].item_type, 'TASK');
  assert.equal(byTitle['화면 설계'].item_type, 'SUMMARY');                 // has a child → SUMMARY by default (status COMPLETED kept)
  assert.equal(byTitle['목록'].item_type, 'TASK');
  assert.equal(byTitle['오픈'].item_type, 'MILESTONE'); assert.equal(byTitle['오픈'].milestone_date, '2026-12-01'); assert.equal(byTitle['오픈'].planned_end_date, null);
  const t1 = byTitle['요구사항 분석'];
  assert.equal(t1.planned_start_date, '2026-11-02'); assert.equal(t1.status, 'IN_PROGRESS'); assert.equal(t1.progress, 40); assert.equal(t1.owner_user_id, A.uid); assert.equal(t1.description, '설명');
  assert.equal(byTitle['인터뷰'].predecessors.length, 1); assert.equal(byTitle['인터뷰'].predecessors[0].predecessor_id, t1.id);
  assert.equal(byTitle['오픈'].predecessors.length, 2);
  const res3 = r.json.results.find((x) => x.ok && x.id === byTitle['분석'].id); assert.equal(res3.wbs_code, '3');
  assert.equal(r.json.summary.total, 8 + 2);
  // history: CREATED for every item, DEP_ADDED for imported dependencies
  const item = (await A.c('GET', `${A.wbs}/${byTitle['오픈'].id}`)).json.item;
  assert.deepEqual(item.history.map((h) => h.action_type).sort(), ['CREATED', 'DEP_ADDED', 'DEP_ADDED']);
  assert.ok(item.history.some((h) => h.new_value === '4.1 화면 설계'), JSON.stringify(item.history));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM wbs_history WHERE action_type = 'CREATED'")).n, 2 + 8);
  assert.equal(item.history[0].changed_by_name, '홍길동');

  // parent_id: top-level rows are created under the given parent
  const r2 = await A.c('POST', `${A.wbs}/import`, { parent_id: pre.id, rows: wrows([W('1', '하위 1'), W('1.1', '하위 1-1'), W('2', '하위 2')]) });
  assert.equal(r2.json.created, 3);
  const t2 = (await A.c('GET', A.wbs)).json.items;
  assert.deepEqual(t2.filter((i) => i.wbs_code.startsWith('1')).map((i) => `${i.wbs_code}:${i.title}`), ['1:기존 상위', '1.1:하위 1', '1.1.1:하위 1-1', '1.2:하위 2']);
  // parent_id validation
  assert.equal((await A.c('POST', `${A.wbs}/import`, { parent_id: 'nope', rows: [] })).status, 400);
  assert.equal((await A.c('POST', `${A.wbs}/import/preview`, { parent_id: 'nope', rows: [] })).status, 400);
  const ms = (await A.c('POST', A.wbs, { item_type: 'MILESTONE', title: 'M', milestone_date: '2026-12-31' })).json.item;
  assert.equal((await A.c('POST', `${A.wbs}/import`, { parent_id: ms.id, rows: [] })).status, 400);
  void pre2;
  // cycles are impossible to import: rejected in validation, nothing partially created
  const r3 = await A.c('POST', `${A.wbs}/import`, { rows: wrows([W('1', 'x', { predecessors: '2' }), W('2', 'y', { predecessors: '1' })]) });
  assert.equal(r3.json.created, 0); assert.equal(r3.json.failed, 2);
  assert.match(r3.json.results[1].errors.predecessors, /순환/);
  server.close();
});

test('wbs export: columns, hierarchy, predecessors; the exported file re-imports cleanly into another project', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  await A.c('POST', `${A.wbs}/import`, { rows: wrows([W('1', '상위'), W('1.1', 'A', { start: '2026-11-02', end: '2026-11-06', progress: '20', status: '진행 중' }), W('1.2', 'B', { predecessors: '1.1' }), W('2', '완료일', { item_type: '마일스톤', end: '2026-12-01' })]) });
  const ex = await A.c('GET', `${A.wbs}/export.xlsx`);
  assert.equal(ex.status, 200);
  assert.ok(ex.headers.get('content-disposition').startsWith('attachment; filename="wbs-export.xlsx"'));
  const ws = (await readXlsx(ex.buf)).worksheets[0];
  assert.equal(ws.getCell(1, 1).value, 'WBS Code');
  assert.equal(ws.rowCount, 5);
  assert.deepEqual([ws.getCell(3, 1).value, ws.getCell(3, 2).value, ws.getCell(3, 3).value, ws.getCell(3, 4).value, ws.getCell(3, 9).value, ws.getCell(3, 10).value], ['1.1', '1', '작업', 'A', '진행 중', 20]);
  assert.equal(ws.getCell(4, 11).value, '1.1');
  assert.equal(ws.getCell(5, 3).value, '마일스톤'); assert.equal(ws.getCell(5, 7).value, null);
  // the exported file is a valid import file (re-import into a fresh project)
  const B = await setup(client, 'b@x.com');
  const pv = await B.c('POST', `${B.wbs}/import/preview`, { data: ex.buf.toString('base64') });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.equal(pv.json.summary.error, 0, JSON.stringify(pv.json.rows.filter((x) => !x.ok)));
  assert.equal(pv.json.summary.total, 4);
  const imp = await B.c('POST', `${B.wbs}/import`, { rows: pv.json.rows.map(({ row, values }) => ({ row, values })) });
  assert.equal(imp.json.created, 4);
  const e = await A.c('POST', `${A.wbs}/import/errors.xlsx`, { rows: [{ row: 3, values: { code: 'x', title: 't' }, errors: { code: '형식 오류' }, row_errors: [] }] });
  assert.equal(e.status, 200);
  const ews = (await readXlsx(e.buf)).worksheets[0];
  assert.equal(ews.getCell(1, 1).value, '원본 행'); assert.equal(ews.getCell(1, 13).value, '오류 사유'); assert.equal(ews.getCell(2, 13).value, 'WBS Code: 형식 오류');
  assert.match(e.headers.get('content-disposition'), /filename="wbs-import-errors\.xlsx"/);
  server.close();
});
