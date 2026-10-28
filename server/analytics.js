/**
 * First-party product analytics (migration 46). Events go to our own Postgres only — no third-party scripts, no cookies.
 * An event carries ids only (user · workspace · project) plus a short key (stage '01'…'07', feature or screen key); never
 * names, e-mails, IPs or project content. Landing visits are anonymous (no user, no IP).
 *
 * Funnel milestones are stored once per user (uq_analytics_once). Sample projects (projects.sample_key) never produce
 * milestones, and their feature/screen events are flagged `sample` and left out of every aggregate. SYSTEM_ADMIN users
 * are left out at query time, so an account promoted later drops out of past numbers too.
 */
import { todayKst } from '../public/app/shared/kst-date.js';

/** Events that count once per user (the funnel). feature / screen / landing_visit are repeatable. */
export const ONCE = ['signup', 'email_verified', 'sample_opened', 'project_created', 'stage_reached', 'first_requirement', 'first_wbs', 'first_issue', 'first_report', 'first_invite', 'jira_connected', 'project_closed'];
export const STAGES = { INITIATION: '01', REQUIREMENTS: '02', ANALYSIS_DESIGN: '03', DEVELOPMENT: '04', TESTING: '05', TRANSITION_GO_LIVE: '06', OPERATIONS: '07' };
const STAGE_NAMES = { '01': '착수', '02': '요구사항 정의', '03': '분석·설계', '04': '구현', '05': '시험', '06': '전환 및 오픈', '07': '운영 및 유지보수' };

/** Main funnel, in journey order. `stage` steps are stage_reached with that key. A `side` step does not gate the next one
 * (you can create a project without verifying your e-mail), so it and the step after it compare with the last non-side step. */
export const FUNNEL = [
  { key: 'landing_visit', label: '랜딩 방문' },
  { key: 'signup', label: '가입' },
  { key: 'email_verified', label: '이메일 인증', side: true },
  { key: 'sample_opened', label: '샘플 프로젝트 열람', side: true },
  { key: 'project_created', label: '첫 프로젝트 생성 (01 착수)' },
  ...['02', '03', '04', '05', '06', '07'].map((s) => ({ key: `stage_${s}`, label: `${s} ${STAGE_NAMES[s]} 도달` })),
  { key: 'project_closed', label: '프로젝트 종료' },
];
/** Key features, first use — not a sequence, shown as % of signups. */
export const FIRST_USE = [
  { key: 'first_requirement', label: '첫 요구사항 등록' }, { key: 'first_wbs', label: '첫 WBS 작업' }, { key: 'first_issue', label: '첫 이슈 등록' },
  { key: 'first_report', label: '첫 보고서 작성' }, { key: 'first_invite', label: '첫 팀원 초대' }, { key: 'jira_connected', label: 'Jira 연결' },
];

/** Route (method + Express pattern without '/api/workspaces/:wid') → funnel milestone. */
export const ROUTE_MILESTONES = {
  'POST /projects': 'project_created',
  'POST /projects/:pid/requirements': 'first_requirement', 'POST /projects/:pid/requirements/import': 'first_requirement', 'POST /projects/:pid/ai/requirements/commit': 'first_requirement',
  'POST /projects/:pid/wbs': 'first_wbs', 'POST /projects/:pid/wbs/skeleton': 'first_wbs', 'POST /projects/:pid/wbs/import': 'first_wbs', 'POST /projects/:pid/ai/wbs/commit': 'first_wbs', 'POST /projects/:pid/ai/wbs-plans/:planId/commit': 'first_wbs',
  'POST /projects/:pid/issues': 'first_issue', 'POST /projects/:pid/tests/:tid/executions/:eid/issue': 'first_issue',
  'POST /projects/:pid/weekly-reports/generate': 'first_report', 'POST /projects/:pid/weekly-reports/completion': 'first_report',
  'POST /invitations': 'first_invite', 'POST /members': 'first_invite',
  'POST /projects/:pid/close': 'project_closed',
};

/** Korean labels for the feature table. Unknown keys show as-is (method + route, or the screen path). */
export const FEATURE_LABELS = {
  'POST /projects': '프로젝트 만들기', 'PATCH /projects/:pid': '프로젝트 정보 수정', 'POST /projects/:pid/close': '프로젝트 종료',
  'PATCH /projects/:pid/steps/:sid': '할 일 상태 변경', 'POST /projects/:pid/phases/:phid/activate': '단계 이동',
  'PUT /projects/:pid/definition': '프로젝트 정의 저장', 'POST /projects/:pid/definition/sections/:key/:action(complete|confirm|reopen|skip|resume)': '정의 항목 완료·확정',
  'POST /projects/:pid/requirements': '요구사항 등록', 'PATCH /projects/:pid/requirements/:rid': '요구사항 수정', 'POST /projects/:pid/requirements/import': '요구사항 엑셀 가져오기', 'POST /projects/:pid/requirements/bulk': '요구사항 일괄 변경',
  'POST /projects/:pid/requirements/baseline/:action(complete|reopen)': '요구사항 확정',
  'POST /projects/:pid/wbs': 'WBS 작업 추가', 'PATCH /projects/:pid/wbs/:iid': 'WBS 작업 수정', 'POST /projects/:pid/wbs/skeleton': 'WBS 뼈대 만들기', 'POST /projects/:pid/wbs/import': 'WBS 엑셀 가져오기', 'POST /projects/:pid/wbs/bulk': 'WBS 일괄 변경',
  'POST /projects/:pid/changes': '변경 요청 등록', 'POST /projects/:pid/issues': '이슈 등록', 'POST /projects/:pid/risks': '리스크 등록',
  'POST /projects/:pid/tests': '테스트 등록', 'POST /projects/:pid/tests/:tid/executions': '테스트 수행 기록', 'POST /projects/:pid/acceptances': '검수 등록',
  'POST /projects/:pid/weekly-reports/generate': '주간보고 만들기', 'POST /projects/:pid/weekly-reports/completion': '완료보고서 만들기', 'POST /projects/:pid/weekly-reports/:rid/finalize': '보고서 확정',
  'GET /projects/:pid/charter/export': '사업수행계획서 내보내기', 'GET /projects/:pid/requirements/export-doc': '요구사항 정의서 내보내기', 'GET /projects/:pid/requirements/export.xlsx': '요구사항 엑셀 내보내기', 'GET /projects/:pid/wbs/export.xlsx': 'WBS 엑셀 내보내기',
  'POST /projects/:pid/ai/requirements/extract': 'AI 요구사항 추출', 'POST /projects/:pid/ai/wbs/generate': 'AI WBS 생성', 'POST /projects/:pid/ai/ask': 'AI 질문', 'POST /projects/:pid/changes/:cid/ai/impact': 'AI 영향 분석',
  'POST /invitations': '팀원 초대', 'POST /members': '팀원 추가', 'POST /integrations/jira/connect': 'Jira 연결 시작', 'POST /projects/:pid/integrations/jira/sync': 'Jira 동기화',
  'POST /samples': '샘플 프로젝트 다시 추가', 'DELETE /samples': '샘플 프로젝트 삭제',
  'POST /onboarding/:key/:action(start|step|complete|skip|replay)': '시작 안내(온보딩) 진행', 'POST /projects/:pid/archive': '프로젝트 보관',
  'POST /projects/:pid/steps/:sid/checklist': '체크리스트 항목 추가', 'PATCH /projects/:pid/checklist/:iid': '체크리스트 체크',
  'POST /projects/:pid/requirements/:rid/links': '요구사항–WBS 연결', 'POST /projects/:pid/wbs/:iid/links': 'WBS–요구사항 연결', 'POST /projects/:pid/requirements/:rid/criteria': '인수 기준 추가',
  'POST /projects/:pid/changes/:cid/transition': '변경 요청 처리', 'PATCH /projects/:pid/issues/:xid': '이슈 수정', 'PATCH /projects/:pid/risks/:xid': '리스크 수정',
  'POST /projects/:pid/acceptances/:aid/transition': '검수 진행', 'POST /projects/:pid/go-live': '오픈 기록', 'POST /projects/:pid/handover': '운영 인수 기록',
  'PATCH /projects/:pid/weekly-reports/:rid': '보고서 편집', 'POST /projects/:pid/requirements/:rid/comments': '요구사항 댓글', 'POST /projects/:pid/wbs/:iid/comments': 'WBS 댓글',
  'GET /projects/:pid/weekly-reports/:rid/export.pdf': '보고서 PDF 내보내기', 'GET /projects/:pid/weekly-reports/:rid/export.docx': '보고서 Word 내보내기',
};
const SCREEN_LABELS = {
  '/app': '홈', '/app/projects': '프로젝트 목록', '/app/projects/new': '새 프로젝트', '/app/projects/:id': '프로젝트 개요', '/app/projects/:id/requirements': '요구사항',
  '/app/projects/:id/wbs': 'WBS', '/app/projects/:id/issues': '이슈·리스크', '/app/projects/:id/changes': '변경 요청', '/app/projects/:id/tests': '테스트',
  '/app/projects/:id/reports': '보고서', '/app/projects/:id/definition': '프로젝트 정의', '/app/projects/:id/charter': '사업수행계획서', '/app/settings': '설정', '/app/credits': 'AI 이용 현황 (구 AI 크레딧)',
};
export const featureLabel = (kind, key) => (kind === 'screen' ? `화면 · ${SCREEN_LABELS[key] || key}` : FEATURE_LABELS[key] || key);

const warn = (e) => console.warn('[analytics]', e.message);

/**
 * Records one event. Never throws (analytics must not break a request) — so never call it inside a tx(): a failed
 * statement would abort the caller's transaction. Milestones repeat harmlessly (ON CONFLICT DO NOTHING).
 */
export async function track(db, name, { userId = null, workspaceId = null, projectId = null, key = null, sample = false } = {}) {
  if (process.env.ANALYTICS === 'off') return;
  try {
    await db.run(`INSERT INTO analytics_events (name, key, user_id, workspace_id, project_id, sample) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [name, key === null ? null : String(key).slice(0, 160), userId, workspaceId, projectId, Boolean(sample)]);
  } catch (e) { warn(e); }
}

/** Stage reached (01–07) for a project phase key; samples never count. */
export async function trackStage(db, { userId, workspaceId, projectId, phaseKey, sample = false }) {
  if (sample || !STAGES[phaseKey]) return;
  await track(db, 'stage_reached', { userId, workspaceId, projectId, key: STAGES[phaseKey] });
}

/** Marks the user active today (KST) — once per user per day per server instance, then the in-memory set skips the write. */
const seen = new Set();
export async function markActive(db, userId, at = new Date()) {
  if (!userId || process.env.ANALYTICS === 'off') return;
  const day = todayKst(at); const k = `${userId}|${day}`;
  if (seen.has(k)) return;
  if (seen.size > 20000) seen.clear();
  try { await db.run('INSERT INTO analytics_active_days (user_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING', [userId, day]); seen.add(k); } catch (e) { warn(e); }
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|go-http|java\/|headless|lighthouse|monitor|uptime/i;
export const isBot = (ua) => !ua || BOT.test(ua);

/** Sample flag for a project id, cached (sample_key never changes on a project). */
const sampleCache = new Map();
async function isSampleProject(db, pid) {
  if (!pid) return false;
  if (sampleCache.has(pid)) return sampleCache.get(pid);
  let v = false;
  try { v = Boolean((await db.get('SELECT sample_key FROM projects WHERE id = ?', [pid]))?.sample_key); } catch (e) { warn(e); }
  if (sampleCache.size > 5000) sampleCache.clear();
  sampleCache.set(pid, v);
  return v;
}

const WS_PATH = /^\/api\/workspaces\/([\w-]+)(?:\/projects\/([\w-]+))?/;
const EXPORT_GET = /\/(export[\w.-]*|charter\/export|[\w-]+\.(xlsx|csv|pdf|docx))$/;
/**
 * Express middleware: marks the signed-in user active today, and records one `feature` event (plus its funnel milestone)
 * for every successful workspace-scoped write — and for exports (GET downloads). The write happens just before the
 * response is sent, so it also completes on serverless hosts that freeze after the response.
 */
export function analyticsMiddleware(db) {
  return async (req, res, next) => {
    if (!req.user) return next();
    await markActive(db, req.user.id);
    const m = WS_PATH.exec(req.path);
    if (!m || (req.method === 'GET' && !EXPORT_GET.test(req.path)) || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const send = res.send; let done = false;
    res.send = function (body) {
      if (done || res.statusCode >= 400 || !req.route) { res.send = send; return send.call(this, body); }
      done = true;
      const key = `${req.method} ${String(req.route.path).replace(/^\/api\/workspaces\/:wid/, '') || '/'}`;
      const [, wid, pid] = m; const userId = req.user.id;
      (async () => {
        const sample = await isSampleProject(db, pid);
        await track(db, 'feature', { userId, workspaceId: wid, projectId: pid || null, key, sample });
        const milestone = ROUTE_MILESTONES[key];
        if (milestone && !sample) {
          await track(db, milestone, { userId, workspaceId: wid, projectId: pid || null });
          if (milestone === 'project_created') await track(db, 'stage_reached', { userId, workspaceId: wid, key: '01' });
        }
      })().catch(warn).finally(() => { res.send = send; send.call(this, body); });
      return this;
    };
    next();
  };
}

/** Normalises an app path into a screen key: ids become ':id', query strings and admin paths are dropped. */
export function screenKey(path) {
  const p = String(path || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (!/^\/app(\/|$)/.test(p) || p.length > 200) return null;
  const k = p.split('/').map((s) => (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) || /^\d+$/.test(s) || (s.length >= 16 && /\d/.test(s) && /^[\w-]+$/.test(s)) ? ':id' : s)).join('/');
  return /^[\w/:.-]+$/.test(k) ? k.slice(0, 120) : null;
}

/** POST /api/analytics/screen { path } — one screen view. The project id is taken from the path and kept only for members. */
export function mountAnalyticsRoutes(app, db, { requireAuth, wrap }) {
  app.post('/api/analytics/screen', requireAuth, wrap(async (req, res) => {
    const key = screenKey(req.body?.path);
    if (!key) return res.status(204).end();
    const pid = /^\/app\/projects\/([\w-]+)/.exec(String(req.body.path))?.[1];
    const p = pid && pid !== 'new' ? await db.get(`SELECT p.id, p.workspace_id, p.sample_key FROM projects p JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ? WHERE p.id = ?`, [req.user.id, pid]).catch(() => null) : null;
    await track(db, 'screen', { userId: req.user.id, workspaceId: p?.workspace_id || null, projectId: p?.id || null, key, sample: Boolean(p?.sample_key) });
    res.status(204).end();
  }));
}

/* ---------------------------------------------------------------- aggregates (admin) ---------------------------------------------------------------- */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
/** { from, to } as KST dates, inclusive. Default: the last 30 days ending today. Swapped if reversed, capped at 366 days. */
export function parseRange(q = {}, today = todayKst()) {
  let to = DAY.test(q.to || '') ? q.to : today;
  let from = DAY.test(q.from || '') ? q.from : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  if (addDays(from, 366) < to) from = addDays(to, -366);
  return { from, to };
}
// created_at window for KST dates [from, to] inclusive
const RANGE_SQL = (col) => `${col} >= (?::date)::timestamp AT TIME ZONE 'Asia/Seoul' AND ${col} < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Seoul'`;
const NOT_ADMIN = `NOT EXISTS (SELECT 1 FROM users ux WHERE ux.id = e.user_id AND ux.system_role = 'SYSTEM_ADMIN')`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Signups in range (non-admin) → how many reached each step at any time; landing visits are the anonymous count in range. */
export async function funnel(db, { from, to }) {
  const visits = Number((await db.get(`SELECT COUNT(*) AS n FROM analytics_events e WHERE e.name = 'landing_visit' AND ${RANGE_SQL('e.created_at')}`, [from, to])).n);
  const rows = await db.all(`WITH cohort AS (SELECT DISTINCT e.user_id FROM analytics_events e WHERE e.name = 'signup' AND ${RANGE_SQL('e.created_at')} AND ${NOT_ADMIN})
    SELECT CASE WHEN e.name = 'stage_reached' THEN 'stage_' || e.key ELSE e.name END AS step, COUNT(DISTINCT e.user_id) AS n
    FROM analytics_events e JOIN cohort c ON c.user_id = e.user_id
    WHERE e.name IN (${ONCE.map(() => '?').join(',')}) AND NOT e.sample GROUP BY 1`, [from, to, ...ONCE]);
  const by = Object.fromEntries(rows.map((r) => [r.step, Number(r.n)]));
  by.landing_visit = visits;
  const signups = by.signup || 0;
  let gate = null;   // last non-side step
  const steps = FUNNEL.map((s, i) => {
    const count = by[s.key] || 0; const prev = gate ? by[gate.key] || 0 : null;
    const out = { key: s.key, label: s.label, side: Boolean(s.side), base: gate ? gate.key : null, count, pct_prev: i ? pct(count, prev) : null, pct_signup: i >= 1 ? pct(count, signups) : null, drop: i && prev ? Math.max(0, prev - count) : 0 };
    if (!s.side) gate = s;
    return out;
  });
  // Biggest drop-off: the step that loses the largest share of the step before it (needs a non-empty previous step).
  let biggest = null;
  for (const s of steps.slice(1)) if (s.pct_prev !== null && (biggest === null || 100 - s.pct_prev > 100 - biggest.pct_prev)) biggest = s;
  return { signups, landing_visits: visits, steps, biggest_drop: biggest && biggest.pct_prev < 100 ? { key: biggest.key, label: biggest.label, lost: biggest.drop, pct_lost: Math.round((100 - biggest.pct_prev) * 10) / 10 } : null,
    first_use: FIRST_USE.map((f) => ({ ...f, count: by[f.key] || 0, pct_signup: pct(by[f.key] || 0, signups) })) };
}

/** Top features and screens in range by distinct users, then uses. Samples and admins excluded. */
export async function topFeatures(db, { from, to, limit = 30 }) {
  const rows = await db.all(`SELECT e.name AS kind, e.key, COUNT(DISTINCT e.user_id) AS users, COUNT(*) AS uses FROM analytics_events e
    WHERE e.name IN ('feature', 'screen') AND NOT e.sample AND ${RANGE_SQL('e.created_at')} AND ${NOT_ADMIN}
    GROUP BY e.name, e.key ORDER BY users DESC, uses DESC, e.key LIMIT ?`, [from, to, limit]);
  return rows.map((r) => ({ kind: r.kind, key: r.key, label: featureLabel(r.kind, r.key), users: Number(r.users), uses: Number(r.uses) }));
}

/** Weekly signup cohorts (KST weeks from Monday). D1/D7/D30 = came back on or after day N; null until day N has arrived for someone in the cohort. */
export async function cohorts(db, { from, to }, today = todayKst()) {
  const rows = await db.all(`WITH s AS (
      SELECT e.user_id, MIN((e.created_at AT TIME ZONE 'Asia/Seoul')::date) AS d FROM analytics_events e
      WHERE e.name = 'signup' AND ${RANGE_SQL('e.created_at')} AND ${NOT_ADMIN} GROUP BY e.user_id)
    SELECT date_trunc('week', s.d)::date AS week, COUNT(*) AS users,
      ${[1, 7, 30].map((n) => `COUNT(*) FILTER (WHERE s.d + ${n} <= ?::date) AS e${n},
      COUNT(*) FILTER (WHERE s.d + ${n} <= ?::date AND EXISTS (SELECT 1 FROM analytics_active_days a WHERE a.user_id = s.user_id AND a.day >= s.d + ${n})) AS r${n}`).join(',\n      ')}
    FROM s GROUP BY 1 ORDER BY 1`, [from, to, today, today, today, today, today, today]);
  const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return rows.map((r) => {
    const o = { week: day(r.week), users: Number(r.users) };
    for (const n of [1, 7, 30]) { const e = Number(r[`e${n}`]); const k = Number(r[`r${n}`]); o[`d${n}`] = e ? { eligible: e, returned: k, pct: pct(k, e) } : null; }
    return o;
  });
}

/** DAU / WAU / MAU ending on `to` (non-admin). */
export async function activeUsers(db, { to }) {
  const r = await db.get(`SELECT
      COUNT(DISTINCT a.user_id) FILTER (WHERE a.day = ?::date) AS dau,
      COUNT(DISTINCT a.user_id) FILTER (WHERE a.day > ?::date - 7) AS wau,
      COUNT(DISTINCT a.user_id) AS mau
    FROM analytics_active_days a WHERE a.day > ?::date - 30 AND a.day <= ?::date
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id AND u.system_role = 'SYSTEM_ADMIN')`, [to, to, to, to]);
  return { dau: Number(r.dau), wau: Number(r.wau), mau: Number(r.mau) };
}

export async function funnelReport(db, q = {}) {
  const range = parseRange(q);
  const [f, features, weekly, active] = await Promise.all([funnel(db, range), topFeatures(db, range), cohorts(db, range), activeUsers(db, range)]);
  return { range, ...f, features, cohorts: weekly, active };
}

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** One CSV with four blocks (funnel, first use, features, cohorts). BOM so Excel opens Korean correctly. */
export function funnelCsv(r) {
  const out = [['RELAI 사용 분석', `${r.range.from} ~ ${r.range.to}`], [],
    ['퍼널 단계', '사용자 수', '전 단계 대비 %', '가입 대비 %'], ...r.steps.map((s) => [s.label, s.count, s.pct_prev ?? '', s.pct_signup ?? '']),
    ['가장 큰 이탈', r.biggest_drop ? `${r.biggest_drop.label} (-${r.biggest_drop.pct_lost}%)` : ''], [],
    ['기능 첫 사용', '사용자 수', '가입 대비 %'], ...r.first_use.map((f) => [f.label, f.count, f.pct_signup ?? '']), [],
    ['기능', '구분', '사용자 수', '사용 횟수'], ...r.features.map((f) => [f.label, f.kind === 'screen' ? '화면' : '작업', f.users, f.uses]), [],
    ['가입 주', '가입자', 'D1 %', 'D7 %', 'D30 %'], ...r.cohorts.map((c) => [c.week, c.users, c.d1?.pct ?? '', c.d7?.pct ?? '', c.d30?.pct ?? '']), [],
    ['DAU', r.active.dau], ['WAU', r.active.wau], ['MAU', r.active.mau]];
  return '﻿' + out.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
