/* v1 gaps: weekly report PDF/Word download, test case Excel, change-request approval rule, Vercel cron route for Jira jobs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember, xlsxBase64, readXlsx } from './api-helpers.js';
import { parseReportMarkdown } from '../report-export.js';
import { parseStepLines } from '../importer.js';
import { reviewPermission } from '../changes.js';

const TC_HEADERS = ['테스트 ID', '테스트명', '설명', '사전 조건', '테스트 절차', '기대 결과', '우선순위', '상태', '담당자', '연결 요구사항', '연결 WBS'];

test('report markdown subset parser: headings, nested bullets, bold runs', () => {
  const b = parseReportMarkdown('# 제목\n\n## 1. 현황\n\n**이슈**\n- A **굵게** 끝\n  - 하위\n일반');
  assert.deepEqual(b.map((x) => x.type), ['h1', 'blank', 'h2', 'blank', 'para', 'bullet', 'bullet', 'para']);
  assert.equal(b[5].level, 0); assert.equal(b[6].level, 1);
  assert.deepEqual(b[5].runs, [{ text: 'A ', bold: false }, { text: '굵게', bold: true }, { text: ' 끝', bold: false }]);
  assert.deepEqual(b[4].runs, [{ text: '이슈', bold: true }]);
});

test('weekly report: PDF and Word download with Korean file name; 404 for another project / unknown report', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'rep@x.com'); const B = await setup(client, 'rep2@x.com');
  await A.c('POST', A.req, { title: '로그인 기능' });
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: '2026-10-12', period_end: '2026-10-18' })).json.report;
  const pdf = await A.c('GET', `${A.purl}/weekly-reports/${rep.id}/export.pdf`, undefined, { raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.buf.toString('latin1'), /NanumGothic/);   // Hangul font embedded
  assert.match(pdf.headers.get('content-disposition'), /filename\*=UTF-8''.*%EC%A3%BC%EA%B0%84%EB%B3%B4%EA%B3%A0/);   // 주간보고
  const docx = await A.c('GET', `${A.purl}/weekly-reports/${rep.id}/export.docx`, undefined, { raw: true });
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get('content-type'), /wordprocessingml/);
  assert.equal(docx.buf.subarray(0, 2).toString(), 'PK');
  assert.ok(docx.buf.length > 3000);
  assert.equal((await B.c('GET', `${B.purl}/weekly-reports/${rep.id}/export.pdf`)).status, 404);
  assert.equal((await B.c('GET', `${A.purl}/weekly-reports/${rep.id}/export.pdf`)).status, 404);   // not a member: workspace hidden
  server.close();
});

test('test steps parser: numbering stripped, "=>" splits expected result', () => {
  assert.deepEqual(parseStepLines('1. 로그인 화면 접속\n2) 계정 입력 => 메인 이동\n\n- 로그아웃 → 로그인 화면'), [
    { instruction: '로그인 화면 접속', expected: '' }, { instruction: '계정 입력', expected: '메인 이동' }, { instruction: '로그아웃', expected: '로그인 화면' }]);
});

test('test cases Excel: template, preview errors, partial import with links + explicit ids, export round-trip', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'tc@x.com');
  const ts = `${A.purl}/tests`;
  const req1 = (await A.c('POST', A.req, { title: 'SSO 로그인' })).json.requirement;
  const w1 = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '화면 개발' })).json.item;

  const tpl = await A.c('GET', `${ts}/template.xlsx`);
  assert.equal(tpl.status, 200);
  const wb = await readXlsx(tpl.buf);
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), TC_HEADERS);
  assert.equal(wb.worksheets[0].name, '테스트');

  const data = await xlsxBase64(TC_HEADERS, [
    ['', '정상 로그인', '설명', '계정 있음', '1. 접속\n2. 로그인 => 메인 이동', '메인 표시', 'High', '준비됨', 'tc@x.com', req1.display_id, w1.wbs_code],
    ['TC-010', '지정 ID', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],          // blank row skipped
    ['', '오류 행', '', '', '', '', '긴급', '', '없는사람', 'REQ-999', '9.9'],
    ['TC-010', '중복 ID', '', '', '', '', '', '', '', '', ''],
  ], { sheet: '테스트' });
  const pv = await A.c('POST', `${ts}/import/preview`, { data });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.json.summary, { total: 4, ok: 2, error: 2 });
  const bad = pv.json.rows.find((r) => r.values.title === '오류 행');
  assert.deepEqual(Object.keys(bad.errors).sort(), ['owner', 'priority', 'requirements', 'wbs']);
  assert.match(pv.json.rows.find((r) => r.values.title === '중복 ID').errors.display_id, /중복/);

  const im = await A.c('POST', `${ts}/import`, { rows: pv.json.rows.map(({ row, values }) => ({ row, values })) });
  assert.equal(im.status, 200);
  assert.equal(im.json.created, 2); assert.equal(im.json.failed, 2);
  assert.equal(im.json.summary.total, 2);
  const created = im.json.results.filter((r) => r.ok).map((r) => r.display_id).sort();
  assert.deepEqual(created, ['TC-001', 'TC-010']);
  assert.equal((await A.c('POST', ts, { title: '다음 번호' })).json.test.display_id, 'TC-011');   // explicit id advanced the counter

  const t1 = (await A.c('GET', `${ts}/${im.json.results.find((r) => r.display_id === 'TC-001').id}`)).json.test;
  assert.equal(t1.priority, 'HIGH'); assert.equal(t1.status, 'READY'); assert.equal(t1.precondition, '계정 있음');
  assert.deepEqual(t1.steps, [{ instruction: '접속', expected: '' }, { instruction: '로그인', expected: '메인 이동' }]);
  assert.deepEqual(t1.links.requirements.map((l) => l.code), [req1.display_id]);
  assert.deepEqual(t1.links.wbs.map((l) => l.code), [w1.wbs_code]);

  const ex = await A.c('GET', `${ts}/export.xlsx`);
  assert.equal(ex.status, 200);
  const ews = (await readXlsx(ex.buf)).worksheets[0];
  const r2 = ews.getRow(2).values.slice(1);
  assert.equal(r2[0], 'TC-001'); assert.equal(r2[4], '1. 접속\n2. 로그인 => 메인 이동'); assert.equal(r2[6], 'High'); assert.equal(r2[7], '준비됨');
  assert.equal(r2[9], req1.display_id); assert.equal(r2[10], w1.wbs_code);
  // re-importing the export reports the existing ids as duplicates instead of creating copies
  const again = await A.c('POST', `${ts}/import/preview`, { data: ex.buf.toString('base64') });
  assert.equal(again.json.summary.ok, 0);
  server.close();
});

test('change request approval: author cannot self-approve, MEMBER needs designation, OWNER/ADMIN may decide', async () => {
  assert.deepEqual(reviewPermission({ created_by: 'u1' }, { userId: 'u1', role: 'OWNER', memberCount: 1 }), { allowed: true, reason: null });   // solo workspace
  assert.deepEqual(reviewPermission({ created_by: 'u1' }, { userId: 'u1', role: 'OWNER', memberCount: 2 }), { allowed: false, reason: 'author' });
  assert.deepEqual(reviewPermission({ created_by: 'u1', approver_user_id: 'u2' }, { userId: 'u2', role: 'MEMBER', memberCount: 3 }), { allowed: true, reason: null });
  assert.deepEqual(reviewPermission({ created_by: 'u1' }, { userId: 'u2', role: 'MEMBER', memberCount: 3 }), { allowed: false, reason: 'role' });

  const { server, client } = await boot();
  const A = await setup(client, 'own@x.com', '오너');
  const M1 = await addMember(client, A, 'm1@x.com', '멤버1');
  const M2 = await addMember(client, A, 'm2@x.com', '멤버2');
  const cbase = `${A.purl}/changes`;
  const mk = async (c, title) => { const cr = (await c('POST', cbase, { title })).json.change; await c('POST', `${cbase}/${cr.id}/transition`, { action: 'submit' }); return cr; };

  // MEMBER-authored CR: author blocked, other MEMBER blocked, OWNER allowed
  const cr1 = await mk(M1.c, '화면 추가');
  let r = await M1.c('POST', `${cbase}/${cr1.id}/transition`, { action: 'approve' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'self_approval');
  r = await M2.c('POST', `${cbase}/${cr1.id}/transition`, { action: 'approve' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'forbidden');
  const view = (await M2.c('GET', `${cbase}/${cr1.id}`)).json.change;
  assert.deepEqual(view.review, { allowed: false, reason: 'role' });
  // designate M2 → M2 may decide; author may not be designated; non-member rejected
  assert.equal((await M1.c('PATCH', `${cbase}/${cr1.id}`, { approver_user_id: M1.uid })).status, 400);
  assert.equal((await M1.c('PATCH', `${cbase}/${cr1.id}`, { approver_user_id: 'nobody' })).status, 400);
  r = await M1.c('PATCH', `${cbase}/${cr1.id}`, { approver_user_id: M2.uid });
  assert.equal(r.status, 200); assert.equal(r.json.change.approver_name, '멤버2');
  assert.equal(r.json.change.history.find((h) => h.field_name === 'approver_user_id').new_value, '멤버2');
  r = await M2.c('POST', `${cbase}/${cr1.id}/transition`, { action: 'reject', decision_note: '범위 밖' });
  assert.equal(r.status, 200); assert.equal(r.json.change.status, 'REJECTED');

  // OWNER-authored CR: OWNER blocked (author), MEMBER blocked, promoted ADMIN allowed
  const cr2 = await mk(A.c, '일정 변경');
  assert.equal((await A.c('POST', `${cbase}/${cr2.id}/transition`, { action: 'approve' })).json.error.code, 'self_approval');
  assert.equal((await A.c('GET', `${cbase}/${cr2.id}`)).json.change.review.reason, 'author');
  assert.equal((await M1.c('POST', `${cbase}/${cr2.id}/transition`, { action: 'approve' })).status, 403);
  assert.equal((await A.c('PATCH', `/api/workspaces/${A.w}/members/${M1.uid}`, { role: 'ADMIN' })).status, 200);
  r = await M1.c('POST', `${cbase}/${cr2.id}/transition`, { action: 'approve', decision_note: '승인' });
  assert.equal(r.status, 200); assert.equal(r.json.change.status, 'APPROVED');
  // implement stays open to every member
  assert.equal((await M2.c('POST', `${cbase}/${cr2.id}/transition`, { action: 'implement' })).status, 200);
  server.close();
});

test('cron route: off without CRON_SECRET, 401 on a wrong token, runs the integration jobs with the right one', async () => {
  const prev = process.env.CRON_SECRET;
  const { server, client } = await boot();
  const c = client();
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await c('GET', '/api/cron/integrations')).status, 404);
    process.env.CRON_SECRET = 'cron-test-secret';
    assert.equal((await c('GET', '/api/cron/integrations')).status, 401);
    const base = `http://127.0.0.1:${server.address().port}`;
    let res = await fetch(`${base}/api/cron/integrations`, { headers: { authorization: 'Bearer wrong-secret-xxxx' } });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/api/cron/integrations`, { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true); assert.equal(j.synced, 0); assert.equal(j.webhooks, 0); assert.equal(j.failed, 0);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    server.close();
  }
});
