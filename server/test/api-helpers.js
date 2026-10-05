/* Shared by import.test.js / bulk.test.js / activity.test.js: HTTP client that also returns raw bytes + headers, and xlsx builders. */
import ExcelJS from 'exceljs';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';

export async function boot() {
  const db = await testDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, { raw = false } = {}) => {
      const res = await fetch(base + path, { method, redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const type = res.headers.get('content-type') || '';
      if (raw || type.includes('spreadsheetml')) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()), json: null };
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json, headers: res.headers, location: res.headers.get('location') || '' };
    };
  };
  return { db, server, client };
}
export const project = (o = {}) => ({ name: '테스트 프로젝트', client_name: '테스트 고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });

export async function setup(client, email = 'u@x.com', name = '홍길동') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name, email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  return { c, w, uid, p, purl, req: `${purl}/requirements`, wbs: `${purl}/wbs`, email };
}
/** Signs up `email` and adds them to A's workspace with the given role. */
export async function addMember(client, A, email, name, role = 'MEMBER') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name, email, password: 'passw0rd!' });
  const r = await A.c('POST', `/api/workspaces/${A.w}/members`, { email, role });
  if (r.status !== 201) throw new Error(`addMember failed: ${r.status}`);
  return { c, uid: s.json.user.id };
}

/** Builds an xlsx (sheet 1 = data) and returns it base64-encoded. headers: array of header texts; rows: array of arrays. */
export async function xlsxBase64(headers, rows, { sheet = 'Sheet1' } = {}) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(sheet);
  ws.addRow(headers); for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
export async function readXlsx(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }

export const REQ_HEADERS = ['요구사항 ID', '요구사항명', '요구사항 설명', '분류', '우선순위', '범위', '상태', '담당자', '요청자', '요청자 소속', '완료 조건'];
export const WBS_HEADERS = ['WBS Code', '상위 WBS', '유형', '업무명', '업무 설명', '담당자', '시작일', '종료일', '상태', '진행률', '선행 작업'];
