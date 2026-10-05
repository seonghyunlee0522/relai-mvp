import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx, dbErrorInfo } from './db.js';
import {
  hashPassword, verifyPassword, newToken, sha256, rateLimiter,
} from './security.js';
import { parseSignup, parseProject, ValidationError } from './validate.js';
import { ensurePhases, loadGuide, updateStep, transitionTo } from './guide.js';
import * as D from './definition.js';
import { buildProjectCharter } from './charter.js';
import * as R from './requirements.js';
import * as W from './wbs.js';
import * as T from './trace.js';
import * as C from './changes.js';
import * as X from './raid.js';
import * as Q from './testing.js';
import * as M from './metrics.js';
import * as H from './health.js';
import * as WR from './reports.js';
import { mountRequirementRoutes, mountWbsRoutes, mountDashboardRoute, BIG_JSON_PATH } from './routes-extra.js';
import { ImportFileError } from './xlsx.js';
import { requireAction, requireOwner, listMembers, addMember, changeRole, removeMember, POLICY } from './authz.js';
import { mountAdminRoutes, isSystemAdmin } from './admin-routes.js';
import { AdminError } from './admin.js';
import { mountAiRoutes } from './ai/routes.js';
import { mountIntegrationRoutes } from './integrations/routes.js';
import { mountAuthRoutes } from './auth/routes.js';
import { createDirectSignupUser, createUser, touchIdentity, normEmail } from './accounts.js';
import * as I from './invitations.js';
import { writeAudit } from './admin.js';
import { mountOnboardingRoutes } from './onboarding-routes.js';
import { recordFirst } from './onboarding.js';
import { guidanceContext, workspaceHome } from './home.js';
import * as XL from './xlsx.js';
import { wbsExecutionMap, executionForWbs, executionForRequirement, homeSummary } from './integrations/jira/sync.js';
import { AiError, CreditError } from './ai/service.js';
import { ensureAccount } from './ai/credits.js';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_DAYS = 30;
const PROJECT_COLS = `id, workspace_id, name, description, client_name, project_scale, status,
  planned_start_date, planned_end_date, current_phase, created_by, created_at, updated_at,
  project_type, data_migration, deployment_environment, delivery_model, has_existing_system, has_external_integration`;

export function createApp(db, { secureCookies = process.env.NODE_ENV === 'production', sessionSecret = process.env.SESSION_SECRET || '' } = {}) {
  const app = express();
  // __Host- prefix (production only): the browser refuses the cookie unless Secure + Path=/ + no Domain — hardening for free.
  const COOKIE = secureCookies ? '__Host-relai_sid' : 'relai_sid';
  // Session tokens are random 256-bit values stored hashed; SESSION_SECRET keys the hash so a leaked sessions table cannot be replayed.
  const tokenHash = (token) => sha256(sessionSecret ? `${sessionSecret}:${token}` : token);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // 64 KB for every JSON body except the Excel import endpoints (base64 xlsx), which parse their own larger body after auth.
  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => (req.method === 'POST' && BIG_JSON_PATH.test(req.path) ? next() : smallJson(req, res, next)));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  const loginLimit = rateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
  const signupLimit = rateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

  /* ---------- helpers ---------- */
  const q = {
    userByEmail: { get: (email) => db.get('SELECT * FROM users WHERE email = ?', [email]) },
    userById: { get: (id) => db.get('SELECT id, email, name, status, system_role FROM users WHERE id = ?', [id]) },
    session: { get: (h, now) => db.get('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [h, now]) },
    insSession: { run: (h, uid, exp) => db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', [h, uid, exp]) },
    delSession: { run: (h) => db.run('DELETE FROM sessions WHERE token_hash = ?', [h]) },
    memberships: { all: (uid) => db.all(`SELECT w.id, w.name, w.status, m.role FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at`, [uid]) },
    role: { get: (wid, uid) => db.get('SELECT m.role, w.status AS workspace_status FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?', [wid, uid]) },
    delUserSessions: { run: (uid) => db.run('DELETE FROM sessions WHERE user_id = ?', [uid]) },
  };

  const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

  function setSessionCookie(res, token) {
    const maxAge = SESSION_DAYS * 86400;
    res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
  }
  const clearSessionCookie = (res) =>
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`);

  async function startSession(res, userId) {
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
    await q.insSession.run(tokenHash(token), userId, exp);
    setSessionCookie(res, token);
  }

  const fail = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /* CSRF: cookies are SameSite=Lax; additionally reject cross-origin state-changing API calls. */
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return fail(res, 403, 'forbidden_origin', '허용되지 않은 요청입니다.');
    if (req.method !== 'DELETE' && !req.is('application/json')) return fail(res, 415, 'unsupported_media', 'JSON 요청만 지원합니다.');
    next();
  });

  /* Authentication: attaches req.user or leaves it undefined.
   * Suspension enforcement (Phase 10B): a session whose user is no longer ACTIVE is revoked on the spot — the user
   * is treated as logged out, API calls get 403 account_suspended, page loads go back to /login. */
  app.use(wrap(async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = await q.session.get(tokenHash(token), new Date().toISOString());
      if (row) {
        const user = await q.userById.get(row.user_id);
        if (user && user.status !== 'ACTIVE') { await q.delUserSessions.run(user.id); clearSessionCookie(res); req.suspendedUser = user; }
        else req.user = user;
      }
      req.sessionToken = token;
    }
    next();
  }));
  app.use('/api', (req, res, next) => (req.suspendedUser ? fail(res, 403, 'account_suspended', '정지된 계정입니다. 운영자에게 문의해 주세요.') : next()));

  const requireAuth = (req, res, next) =>
    req.user ? next() : fail(res, 401, 'unauthenticated', '로그인이 필요합니다.');
  const toPublicUser = (u) => ({ id: u.id, email: u.email, name: u.name, system_role: u.system_role || 'NONE' });

  /**
   * Single choke point for tenant isolation. Every /api/workspaces/:wid/* route passes through here.
   * A non-member gets 404 (not 403) so workspace IDs cannot be probed.
   */
  const requireMember = wrap(async (req, res, next) => {
    const m = await q.role.get(req.params.wid, req.user.id);
    if (!m) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    req.role = m.role; req.workspaceStatus = m.workspace_status;
    next();
  });
  /** Workspace suspension policy (Phase 10B): a SUSPENDED workspace refuses every workspace-scoped call, reads included.
   * Members keep their login and other workspaces; nothing is deleted. Runs after requireMember so non-members still get 404. */
  const requireWorkspaceActive = (req, res, next) =>
    (req.workspaceStatus === 'SUSPENDED' ? fail(res, 403, 'workspace_suspended', '정지된 Workspace입니다. 운영자에게 문의해 주세요.') : next());

  /* ---------- operations ---------- */
  /** Liveness + database reachability. No secrets, no versions. */
  app.get('/health', wrap(async (req, res) => {
    try { await db.get('SELECT 1 AS ok'); res.json({ status: 'ok', database: 'ok' }); }
    catch { res.status(503).json({ status: 'degraded', database: 'unreachable' }); }
  }));

  /* ---------- auth ---------- */
  /** Shared post-authentication step (password login, Google callback): rotate session, stamp last login. */
  const afterLogin = async (req, res, user) => {
    if (req.sessionToken) await q.delSession.run(tokenHash(req.sessionToken));
    await db.run('UPDATE users SET last_login_at = now() WHERE id = ?', [user.id]);
    await startSession(res, user.id);
  };
  afterLogin.memberships = (uid) => q.memberships.all(uid);

  app.post('/api/auth/signup', wrap(async (req, res) => {
    const ip = req.ip;
    if (signupLimit.blocked(ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    signupLimit.hit(ip);
    const { name, email, password } = parseSignup(req.body);
    if (await q.userByEmail.get(email)) return fail(res, 409, 'email_taken', '이미 가입된 이메일입니다.', { fields: { email: '이미 가입된 이메일입니다.' } });
    // Signup through an invitation link: the server reads the invitation (never workspace/role from the browser); the e-mail must match;
    // the new user gets NO personal workspace — the invitation decides (platform → new customer workspace as OWNER, member → membership).
    let invite = null;
    if (req.body?.invite_token) {
      invite = await I.getByToken(db, String(req.body.invite_token));
      if (!invite || invite.status !== 'PENDING') return fail(res, 410, 'invite_invalid', '초대가 유효하지 않거나 만료되었습니다. 초대한 사람에게 재발송을 요청하세요.');
      if (invite.email !== normEmail(email)) return fail(res, 403, 'invite_email_mismatch', '초대받은 이메일로만 가입할 수 있습니다.', { fields: { email: `초대받은 이메일(${I.publicView(invite).email_masked})로 가입해 주세요.` } });
    }
    const password_hash = await hashPassword(password);
    let userId; let accepted = null;
    try {
      await tx(db, async (db) => {
        if (invite) {
          userId = await createUser(db, { email, name, passwordHash: password_hash });
          const user = { id: userId, email, status: 'ACTIVE' };
          accepted = await I.acceptInvite(db, invite, user);
        } else ({ userId } = await createDirectSignupUser(db, { email, name, passwordHash: password_hash }));
        await writeAudit(db, { adminUserId: userId, action: 'USER_CREATED', targetType: 'USER', targetId: userId, metadata: { email, method: 'PASSWORD', invitation_id: invite ? invite.id : null }, actorKind: 'USER' });
      });
    } catch (e) {
      if (e instanceof I.InviteError) return fail(res, e.status, e.code, e.message, e.extra);
      if (String(e.message).includes('UNIQUE') || e.code === '23505') return fail(res, 409, 'email_taken', '이미 가입된 이메일입니다.', { fields: { email: '이미 가입된 이메일입니다.' } });
      throw e;
    }
    await db.run('UPDATE users SET last_login_at = now() WHERE id = ?', [userId]);
    await startSession(res, userId);
    res.status(201).json({ user: { id: userId, email, name, system_role: 'NONE' }, workspaces: await q.memberships.all(userId), accepted: accepted ? { type: accepted.type, workspace_id: accepted.workspaceId } : null });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const key = `${req.ip}|${email}`;
    if (loginLimit.blocked(key)) return fail(res, 429, 'rate_limited', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const user = await q.userByEmail.get(email);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!user || !user.password_hash || !ok) {
      loginLimit.hit(key);
      return fail(res, 401, 'invalid_credentials', '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    loginLimit.reset(key);
    if (user.status !== 'ACTIVE') return fail(res, 403, 'account_suspended', '정지된 계정입니다. 운영자에게 문의해 주세요.');
    await afterLogin(req, res, user);
    await touchIdentity(db, 'PASSWORD', user.id);
    res.json({ user: toPublicUser(user), workspaces: await q.memberships.all(user.id) });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    if (req.sessionToken) await q.delSession.run(tokenHash(req.sessionToken));
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/me', requireAuth, wrap(async (req, res) => {
    res.json({ user: toPublicUser(req.user), workspaces: await q.memberships.all(req.user.id) });
  }));

  /* ---------- admin console API (operator role only; see admin-routes.js) ---------- */
  mountAdminRoutes(app, db, { requireAuth, wrap, fail });

  /* ---------- projects (always workspace-scoped) ---------- */
  const base = '/api/workspaces/:wid/projects';
  const guard = [requireAuth, requireMember, requireWorkspaceActive];

  const listProjects = (wid, includeArchived) => db.all(`SELECT ${PROJECT_COLS},
        (SELECT name FROM project_phases ph WHERE ph.project_id = projects.id AND ph.phase_key = projects.current_phase) AS current_phase_name,
        (SELECT sequence FROM project_phases ph WHERE ph.project_id = projects.id AND ph.phase_key = projects.current_phase) AS current_phase_sequence,
        COALESCE((SELECT ROUND(AVG(r)) FROM (
          SELECT SUM((st.status = 'COMPLETED')::int) * 100.0 / COUNT(st.id) AS r
          FROM project_phases ph JOIN project_steps st ON st.project_phase_id = ph.id
          WHERE ph.project_id = projects.id GROUP BY ph.id) pr), 0) AS progress
      FROM projects
      WHERE workspace_id = ? ${includeArchived ? '' : "AND status != 'ARCHIVED'"}
      ORDER BY created_at DESC`, [wid]);
  app.get(base, guard, wrap(async (req, res) => {
    res.json({ projects: (await listProjects(req.params.wid, req.query.include_archived === '1')) });
  }));

  const manage = [...guard, requireAction('project_manage')];
  /* BUG-002: same-named live project in the workspace. Not a hard rule (clients may pass allow_duplicate) but never silent. */
  const duplicateName = async (wid, name, exceptId = null) =>
    db.get(`SELECT id, name FROM projects WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?)) AND status <> 'ARCHIVED' ${exceptId ? 'AND id <> ?' : ''} LIMIT 1`, exceptId ? [wid, name, exceptId] : [wid, name]);
  app.post(base, manage, wrap(async (req, res) => {
    const p = parseProject(req.body, { requireType: true });   // 프로젝트 유형 is required on create only
    if (!req.body.allow_duplicate && await duplicateName(req.params.wid, p.name)) return fail(res, 409, 'duplicate_name', '같은 이름의 프로젝트가 이미 있습니다.', { fields: { name: '같은 이름의 프로젝트가 이미 있습니다.' } });
    const id = randomUUID();
    // Every project starts in 01 착수 as 진행 중; goals/scope/stakeholders are entered step by step in the lifecycle flow, never here.
    (await tx(db, async (db) => {
      (await db.run(`INSERT INTO projects (id, workspace_id, name, description, client_name, project_scale,
          status, planned_start_date, planned_end_date, current_phase, created_by,
          project_type, data_migration, deployment_environment, delivery_model, has_existing_system, has_external_integration)
        VALUES (?,?,?,?,?,?, 'ACTIVE', ?,?, 'INITIATION', ?, ?,?,?,?,?,?)`, [id, req.params.wid, p.name, p.description, p.client_name, p.project_scale, p.planned_start_date, p.planned_end_date, req.user.id,
        p.project_type, p.data_migration, p.deployment_environment, p.delivery_model, p.has_existing_system, p.has_external_integration]));
      await ensurePhases(db, await getProject(req.params.wid, id, db), { createdBy: req.user.id });
      if (Number((await db.get(`SELECT COUNT(*) n FROM projects WHERE workspace_id = ?`, [req.params.wid])).n) === 1) await recordFirst(db, { userId: req.user.id, workspaceId: req.params.wid, projectId: id, kind: 'project' });
    }));
    res.status(201).json({ project: (await getProject(req.params.wid, id)) });
  }));

  const getProject = async (wid, id, d = db) =>
    (await d.get(`SELECT ${PROJECT_COLS} FROM projects WHERE workspace_id = ? AND id = ?`, [wid, id]));

  /** Loads a project in this workspace and guarantees its guided phases exist (safe init for any older rows). */
  const loadProject = async (req, res) => {
    const project = (await getProject(req.params.wid, req.params.pid));
    if (!project) { fail(res, 404, 'not_found', '프로젝트를 찾을 수 없습니다.'); return null; }
    if ((await ensurePhases(db, project, { createdBy: project.created_by }))) return (await getProject(req.params.wid, req.params.pid));
    return project;
  };
  /** Everything What's Next / the LNB need in one payload: phases with derived activity states, stats, guidance.
   * guidanceContext() (home.js) is shared with the Workspace Home cards so both screens show the same Next Action. */
  const guideContext = (project) => guidanceContext(db, project);
  const guideResponse = async (project, pre = null) => {
    const { stats, def, guide, guidance } = pre || (await guideContext(project));
    return { project, ...guide, ...stats, kpis: (await M.headlineKpis(db, project, stats)), attention: (await M.attentionItems(db, project.id)),
      definition: { progress: def.progress, needs_review: def.needs_review, sections: def.sections.map(({ key, label, status, ready, missing, changed_after_completion }) => ({ key, label, status, ready, missing, changed_after_completion })) },
      guidance,   // Phase 14: rule-based "지금 해야 할 일" (guidance.js)
      jira: (await homeSummary(db, project.id)) };   // Phase 12: null unless the project is mapped to a Jira project
  };

  /** Workspace Home cards: list rows + per-project guidance / health / attention / upcoming (home.js). Registered before /:pid. */
  app.get(`${base}/home`, guard, wrap(async (req, res) => {
    const rows = (await listProjects(req.params.wid, false));
    const ensure = async (row) => {   // older rows without phases: seed them (same as loadProject) and fill the phase columns the list query missed
      if (!(await ensurePhases(db, row, { createdBy: row.created_by }))) return row;
      const ph = (await db.get('SELECT name, sequence FROM project_phases WHERE project_id = ? AND phase_key = ?', [row.id, row.current_phase]));
      return { ...row, current_phase_name: ph?.name ?? row.current_phase_name, current_phase_sequence: ph?.sequence ?? row.current_phase_sequence };
    };
    res.json((await workspaceHome(db, rows, { ensure })));
  }));
  app.get(`${base}/:pid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json((await guideResponse(project)));
  }));
  /** Phase 9 entry point: all metrics + attention + upcoming dates in one call (computed, never stored). */
  app.get(`${base}/:pid/guidance`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json({ guidance: (await guideResponse(project)).guidance });
  }));
  app.get(`${base}/:pid/snapshot`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json({ project, ...(await M.projectSnapshot(db, project)) });
  }));

  /* ---------- guided execution ---------- */
  const mutable = (res, project) => {
    if (project.status === 'ARCHIVED') { fail(res, 409, 'archived', '보관된 프로젝트는 수정할 수 없습니다.'); return false; }
    return true;
  };

  app.patch(`${base}/:pid/steps/:sid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const { status, note } = req.body || {};
    const fields = {};
    if (status !== undefined) {
      if (!['TODO', 'COMPLETED', 'SKIPPED'].includes(status)) return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { status: '상태 값이 올바르지 않습니다.' } });
      if (status === 'SKIPPED') {   // REQUIRED activities cannot be skipped (importance ↔ skippable kept loosely coupled: an is_skippable column can override later)
        const st = (await db.get(`SELECT s.importance FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE s.id = ? AND p.project_id = ?`, [req.params.sid, project.id]));
        if (st && st.importance === 'REQUIRED') return fail(res, 409, 'not_skippable', '필수 업무는 건너뛸 수 없습니다.');
      }
      fields.status = status;
    }
    if (note !== undefined) {
      if (typeof note !== 'string' || note.length > 4000) return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { note: '메모는 4,000자 이내로 입력해 주세요.' } });
      fields.note = note.trim();
    }
    if (!Object.keys(fields).length) return fail(res, 400, 'validation_error', '변경할 내용이 없습니다.');
    const step = (await updateStep(db, project, req.params.sid, fields, req.user.id));
    if (!step) return fail(res, 404, 'not_found', '할 일을 찾을 수 없습니다.');
    res.json({ step, ...(await guideResponse(project)) });
  }));

  /** Make a phase the current one (next phase, or any phase chosen explicitly). */
  app.post(`${base}/:pid/phases/:phid/activate`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const reason = req.body?.reason === 'NEXT' ? 'NEXT' : 'MANUAL';
    // The leaving phase is COMPLETED only when its REQUIRED activities are done — judged on derived state, not on checkboxes.
    const cur = (await guideContext(project)).guide.current_phase;
    const gateMet = cur && cur.summary ? cur.summary.gate_met : null;
    const r = (await tx(db, async (db) => (await transitionTo(db, project, req.params.phid, req.user.id, reason, { gateMet }))));
    if (r.error === 'not_found') return fail(res, 404, 'not_found', '단계를 찾을 수 없습니다.');
    if (r.error === 'already_current') return fail(res, 409, 'already_current', '이미 현재 단계입니다.');
    res.json((await guideResponse((await getProject(req.params.wid, req.params.pid)))));
  }));

  /* ---------- 프로젝트 정의 (structured INITIATION input; completion = INITIATION step status) ---------- */
  app.get(`${base}/:pid/definition`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project) return;
    res.json((await D.loadDefinition(db, project)));
  }));
  app.put(`${base}/:pid/definition`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    res.json((await tx(db, async (db) => D.saveDefinition(db, project, req.body, req.user.id))));
  }));
  // complete/confirm may carry the section fields → one click = 저장 + 완료 처리. skip (non-REQUIRED only) / resume mark the activity SKIPPED / TODO.
  app.post(`${base}/:pid/definition/sections/:key/:action(complete|confirm|reopen|skip|resume)`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    const body = ['complete', 'confirm'].includes(req.params.action) && req.body && typeof req.body === 'object' ? req.body : null;
    const r = (await tx(db, async (db) => D.setSectionStatus(db, project, req.params.key, req.params.action, req.user.id, body)));
    if (r.error === 'not_found') return fail(res, 404, 'not_found', '섹션을 찾을 수 없습니다.');
    res.json({ ...(await D.loadDefinition(db, project)), guide: (await guideResponse(project)) });
  }));
  /* ---------- Project Chater (read-only view of 프로젝트 정의; the same object feeds every AI request — server/charter.js) ---------- */
  app.get(`${base}/:pid/charter`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project) return;
    res.json({ charter: (await buildProjectCharter(db, project)) });
  }));
  // 이해관계자 Excel: template + preview (rows are committed through PUT /definition by the client after review; no nested import flow)
  app.get(`${base}/:pid/definition/stakeholders/template.xlsx`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project) return;
    const buf = await XL.buildSimpleTemplate('이해관계자', D.STAKEHOLDER_COLUMNS, ['이해관계자 등록 템플릿', '• 조직 구분: 당사 · 고객사 · 협력사 · 기타 중 하나 (필수)', '• 이름: 필수', '• 조직(회사) · 부서 · 역할 · 담당 영역 · 비고: 선택', '• 1행(열 제목)은 수정하지 말고 2행부터 입력하세요.']);
    res.set({ 'Content-Type': XL.XLSX_MIME, 'Content-Disposition': `attachment; filename="stakeholders-template.xlsx"; filename*=UTF-8''${encodeURIComponent('이해관계자 등록 템플릿.xlsx')}`, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  }));
  app.post(`${base}/:pid/definition/stakeholders/import/preview`, guard, express.json({ limit: '8mb' }), wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project) return;
    try { res.json(D.previewStakeholderRows(await XL.parseWorkbookRaw(XL.decodeBase64Xlsx(req.body?.data), { maxRows: 300 }))); }
    catch (e) { if (e instanceof XL.ImportFileError) return fail(res, e.status || 400, e.code || 'import_file', e.message); throw e; }
  }));

  app.patch(`${base}/:pid`, manage, wrap(async (req, res) => {
    const existing = (await getProject(req.params.wid, req.params.pid));
    if (!existing) return fail(res, 404, 'not_found', '프로젝트를 찾을 수 없습니다.');
    if (existing.status === 'ARCHIVED') return fail(res, 409, 'archived', '보관된 프로젝트는 수정할 수 없습니다.');
    const p = parseProject({ ...existing, ...req.body });
    if (!req.body.allow_duplicate && p.name !== existing.name && await duplicateName(req.params.wid, p.name, existing.id)) return fail(res, 409, 'duplicate_name', '같은 이름의 프로젝트가 이미 있습니다.', { fields: { name: '같은 이름의 프로젝트가 이미 있습니다.' } });
    (await db.run(`UPDATE projects SET name=?, description=?, client_name=?, project_scale=?,
        planned_start_date=?, planned_end_date=?, project_type=?, data_migration=?, deployment_environment=?, delivery_model=?,
        has_existing_system=?, has_external_integration=?, updated_at=now()
      WHERE workspace_id=? AND id=?`, [p.name, p.description, p.client_name, p.project_scale, p.planned_start_date, p.planned_end_date,
        p.project_type, p.data_migration, p.deployment_environment, p.delivery_model, p.has_existing_system, p.has_external_integration, req.params.wid, req.params.pid]));
    res.json((await guideResponse((await getProject(req.params.wid, req.params.pid)))));
  }));

  app.post(`${base}/:pid/archive`, manage, wrap(async (req, res) => {
    const existing = (await getProject(req.params.wid, req.params.pid));
    if (!existing) return fail(res, 404, 'not_found', '프로젝트를 찾을 수 없습니다.');
    if (existing.status === 'ARCHIVED') return fail(res, 409, 'archived', '이미 보관된 프로젝트입니다.');
    (await db.run(`UPDATE projects SET status='ARCHIVED', status_before_archive=status, updated_at=now()
      WHERE workspace_id=? AND id=?`, [req.params.wid, req.params.pid]));
    res.json((await guideResponse((await getProject(req.params.wid, req.params.pid)))));
  }));
  /* GAP-006: 보관 해제 — restores the status the project had when it was archived (ACTIVE for legacy rows). */
  app.post(`${base}/:pid/unarchive`, manage, wrap(async (req, res) => {
    const existing = (await db.get(`SELECT ${PROJECT_COLS}, status_before_archive FROM projects WHERE workspace_id = ? AND id = ?`, [req.params.wid, req.params.pid]));
    if (!existing) return fail(res, 404, 'not_found', '프로젝트를 찾을 수 없습니다.');
    if (existing.status !== 'ARCHIVED') return fail(res, 409, 'not_archived', '보관된 프로젝트가 아닙니다.');
    const back = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED'].includes(existing.status_before_archive) ? existing.status_before_archive : 'ACTIVE';
    (await db.run(`UPDATE projects SET status=?, status_before_archive=NULL, updated_at=now() WHERE workspace_id=? AND id=?`, [back, req.params.wid, req.params.pid]));
    res.json((await guideResponse((await getProject(req.params.wid, req.params.pid)))));
  }));
  // No DELETE route by design (Phase 1: archive only).


  /* ---------- workspace: settings & members (role-enforced) ---------- */
  const ws = '/api/workspaces/:wid';
  app.get(ws, guard, wrap(async (req, res) => {
    const w = await db.get('SELECT id, name, owner_id, created_at FROM workspaces WHERE id = ?', [req.params.wid]);
    res.json({ workspace: { ...w, role: req.role, permissions: Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, v.includes(req.role)])) } });
  }));
  app.patch(ws, guard, requireAction('workspace_settings'), wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 100) throw new ValidationError({ name: 'Workspace 이름은 1~100자로 입력하세요.' });
    await db.run('UPDATE workspaces SET name = ? WHERE id = ?', [name, req.params.wid]);
    res.json({ workspace: await db.get('SELECT id, name, owner_id, created_at FROM workspaces WHERE id = ?', [req.params.wid]) });
  }));
  app.delete(ws, guard, requireOwner(), wrap(async (req, res) => {
    // Owner-only by policy; actual deletion is deliberately not implemented yet (billing-era data retention rules first).
    fail(res, 501, 'not_implemented', 'Workspace 삭제는 아직 지원하지 않습니다.');
  }));
  const MEMBER_ERR = { bad_role: [400, '역할이 올바르지 않습니다.'], owner_only: [403, 'OWNER 역할은 OWNER만 부여하거나 회수할 수 있습니다.'], user_not_found: [404, '해당 이메일로 가입된 사용자가 없습니다.'],
    already_member: [409, '이미 Workspace 멤버입니다.'], not_member: [404, '멤버를 찾을 수 없습니다.'], last_owner: [409, 'Workspace에는 최소 한 명의 OWNER가 있어야 합니다.'] };
  const memberFail = (res, out) => fail(res, MEMBER_ERR[out.error][0], out.error, MEMBER_ERR[out.error][1]);
  app.get(`${ws}/members`, guard, wrap(async (req, res) => res.json({ members: await listMembers(db, req.params.wid) })));
  app.post(`${ws}/members`, guard, requireAction('member_manage'), wrap(async (req, res) => {
    const out = await tx(db, async (db) => addMember(db, req.params.wid, req.body?.email, String(req.body?.role || 'MEMBER'), req.role));
    if (out.error) return memberFail(res, out);
    res.status(201).json({ members: await listMembers(db, req.params.wid) });
  }));
  app.patch(`${ws}/members/:uid`, guard, requireAction('member_manage'), wrap(async (req, res) => {
    const out = await tx(db, async (db) => changeRole(db, req.params.wid, req.params.uid, String(req.body?.role || ''), req.role));
    if (out.error) return memberFail(res, out);
    res.json({ members: await listMembers(db, req.params.wid) });
  }));
  app.delete(`${ws}/members/:uid`, guard, requireAction('member_manage'), wrap(async (req, res) => {
    const out = await tx(db, async (db) => removeMember(db, req.params.wid, req.params.uid, req.role));
    if (out.error) return memberFail(res, out);
    res.json({ members: await listMembers(db, req.params.wid) });
  }));

  /* ---------- requirements ---------- */
  const rbase = `${base}/:pid/requirements`;
  const ownerOk = async (req, res, ownerId) => {
    if (ownerId && !(await R.isWorkspaceMember(db, req.params.wid, ownerId))) {
      fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { owner_user_id: 'Owner는 현재 Workspace 멤버만 지정할 수 있습니다.' } });
      return false;
    }
    return true;
  };
  const loadReq = async (req, res, project) => {
    const r = (await R.getRequirement(db, project, req.params.rid));
    if (!r) fail(res, 404, 'not_found', '요구사항을 찾을 수 없습니다.');
    return r;
  };

  mountRequirementRoutes({ app, db, guard, wrap, fail, loadProject, mutable, rbase });   // Excel / bulk / comments (before the /:rid routes)

  app.get(rbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json({ requirements: (await R.listRequirements(db, project, req.query)), summary: (await R.requirementStats(db, project.id)) });
  }));

  app.post(rbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const input = R.parseRequirement(req.body);
    if (!(await ownerOk(req, res, input.owner_user_id))) return;
    const crit = Array.isArray(req.body?.criteria) ? req.body.criteria.map((c) => R.parseCriterion(typeof c === 'string' ? { content: c } : c)) : [];
    const id = (await tx(db, async (db) => { const rid = (await R.createRequirement(db, project, { ...input, criteria: crit }, req.user.id));
      if (Number((await db.get('SELECT COUNT(*) n FROM requirements WHERE project_id = ?', [project.id])).n) === 1) await recordFirst(db, { userId: req.user.id, workspaceId: req.params.wid, projectId: project.id, kind: 'requirement' });
      return rid; }));
    res.status(201).json({ requirement: (await R.getRequirement(db, project, id)), summary: (await R.requirementStats(db, project.id)) });
  }));

  app.get(`${rbase}/:rid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    const r = (await loadReq(req, res, project));
    if (r) res.json({ requirement: { ...r, jira: (await executionForRequirement(db, project.id, r.id)) } });   // read-only trace via WBS (no requirement↔Jira table)
  }));

  app.patch(`${rbase}/:rid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const r = (await loadReq(req, res, project));
    if (!r) return;
    if (r.archived_at) return fail(res, 409, 'archived', '보관된 요구사항은 수정할 수 없습니다.');
    const input = R.parseRequirement(req.body, { partial: true });
    if (!(await ownerOk(req, res, input.owner_user_id))) return;
    const source = (await R.resolveSourceChange(db, project, req.body?.source_change_request_id));   // CR → REQ history traceability (optional)
    const changed = (await tx(db, async (db) => (await R.updateRequirement(db, project, r, input, req.user.id, { sourceChangeRequestId: source ? source.id : null }))));
    res.json({ requirement: (await R.getRequirement(db, project, r.id)), changed, summary: (await R.requirementStats(db, project.id)) });
  }));

  app.post(`${rbase}/:rid/archive`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const r = (await loadReq(req, res, project));
    if (!r) return;
    (await tx(db, async (db) => (await R.archiveRequirement(db, r, req.user.id))));
    res.json({ requirement: (await R.getRequirement(db, project, r.id)), summary: (await R.requirementStats(db, project.id)) });
  }));

  const critGuard = async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return null;
    const r = (await loadReq(req, res, project));
    if (!r) return null;
    if (r.archived_at) { fail(res, 409, 'archived', '보관된 요구사항은 수정할 수 없습니다.'); return null; }
    return { project, r };
  };
  app.post(`${rbase}/:rid/criteria`, guard, wrap(async (req, res) => {
    const ctx = (await critGuard(req, res)); if (!ctx) return;
    const { content } = R.parseCriterion(req.body);
    (await tx(db, async (db) => (await R.addCriterion(db, ctx.r.id, content, req.user.id))));
    res.status(201).json({ requirement: (await R.getRequirement(db, ctx.project, ctx.r.id)) });
  }));
  app.patch(`${rbase}/:rid/criteria/:cid`, guard, wrap(async (req, res) => {
    const ctx = (await critGuard(req, res)); if (!ctx) return;
    const patch = {};
    if (req.body?.content !== undefined) patch.content = R.parseCriterion(req.body).content;
    if (req.body?.sequence !== undefined) patch.sequence = Number(req.body.sequence);
    const c = (await tx(db, async (db) => (await R.updateCriterion(db, ctx.r.id, req.params.cid, patch, req.user.id))));
    if (!c) return fail(res, 404, 'not_found', '완료 조건을 찾을 수 없습니다.');
    res.json({ requirement: (await R.getRequirement(db, ctx.project, ctx.r.id)) });
  }));
  app.delete(`${rbase}/:rid/criteria/:cid`, guard, wrap(async (req, res) => {
    const ctx = (await critGuard(req, res)); if (!ctx) return;
    const ok = (await tx(db, async (db) => (await R.removeCriterion(db, ctx.r.id, req.params.cid, req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '완료 조건을 찾을 수 없습니다.');
    res.json({ requirement: (await R.getRequirement(db, ctx.project, ctx.r.id)) });
  }));


  /* ---------- WBS ---------- */
  const wbase = `${base}/:pid/wbs`;
  const wbsResponse = async (project, opts = {}) => ({ ...(await W.loadTree(db, project, opts)), summary: (await W.wbsStats(db, project.id)), jira: (await wbsExecutionMap(db, project.id)) });   // jira: null unless the project is mapped (Phase 12)
  const loadWbs = async (req, res, project) => {
    const w = (await W.getWbs(db, project, req.params.wid2 || req.params.iid));
    if (!w) fail(res, 404, 'not_found', 'WBS 항목을 찾을 수 없습니다.');
    return w;
  };
  const wbsMutable = async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return null;
    const w = (await loadWbs(req, res, project));
    if (!w) return null;
    if (w.archived_at) { fail(res, 409, 'archived', '보관된 WBS 항목은 수정할 수 없습니다.'); return null; }
    return { project, w };
  };

  mountWbsRoutes({ app, db, guard, wrap, fail, loadProject, mutable, wbase, wbsResponse });   // Excel / bulk / comments (before the /:iid routes)

  app.get(wbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json((await wbsResponse(project, { includeArchived: req.query.include_archived === '1' })));   // GAP-002
  }));

  app.post(wbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const input = W.parseWbs(req.body);
    if (!(await ownerOk(req, res, input.owner_user_id))) return;
    const id = (await tx(db, async (db) => { const iid = (await W.createWbs(db, project, { ...input, parent_id: req.body?.parent_id || null, convert_parent: req.body?.convert_parent }, req.user.id));
      if (Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ?', [project.id])).n) === 1) await recordFirst(db, { userId: req.user.id, workspaceId: req.params.wid, projectId: project.id, kind: 'wbs' });
      return iid; }));
    const item = (await W.getWbs(db, project, id));
    res.status(201).json({ item, warnings: W.rangeWarnings(project, item), ...(await wbsResponse(project)) });   // UX-008
  }));

  app.get(`${wbase}/:iid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    const w = (await loadWbs(req, res, project));
    if (w) res.json({ item: { ...w, jira: (await executionForWbs(db, project.id, w.id)) } });
  }));

  app.patch(`${wbase}/:iid`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const input = W.parseWbs(req.body, { partial: true, existing: ctx.w });
    if (!(await ownerOk(req, res, input.owner_user_id))) return;
    (await tx(db, async (db) => (await W.updateWbs(db, ctx.project, ctx.w, input, req.user.id))));
    const item = (await W.getWbs(db, ctx.project, ctx.w.id));
    res.json({ item, warnings: W.rangeWarnings(ctx.project, item), ...(await wbsResponse(ctx.project)) });
  }));

  app.post(`${wbase}/:iid/move`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    (await tx(db, async (db) => (await W.moveWbs(db, ctx.project, ctx.w, { parent_id: req.body?.parent_id, sequence: req.body?.sequence, convert_parent: req.body?.convert_parent }, req.user.id))));
    res.json({ item: (await W.getWbs(db, ctx.project, ctx.w.id)), ...(await wbsResponse(ctx.project)) });
  }));

  app.post(`${wbase}/:iid/archive`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const children = req.body?.children === 'promote' ? 'promote' : 'cascade';
    const archived = (await tx(db, async (db) => (await W.archiveWbs(db, ctx.project, ctx.w, req.user.id, { children }))));
    res.json({ archived_ids: archived, ...(await wbsResponse(ctx.project)) });
  }));
  /* Tree WBS structural actions (Phase 12): indent / outdent / duplicate / restore. Each returns the item + whole tree like /move. */
  app.post(`${wbase}/:iid/indent`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const undo = (await tx(db, async (db) => (await W.indentWbs(db, ctx.project, ctx.w, req.user.id, { convert_parent: req.body?.convert_parent }))));
    res.json({ item: (await W.getWbs(db, ctx.project, ctx.w.id)), undo, ...(await wbsResponse(ctx.project)) });
  }));
  app.post(`${wbase}/:iid/outdent`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const undo = (await tx(db, async (db) => (await W.outdentWbs(db, ctx.project, ctx.w, req.user.id))));
    res.json({ item: (await W.getWbs(db, ctx.project, ctx.w.id)), undo, ...(await wbsResponse(ctx.project)) });
  }));
  app.post(`${wbase}/:iid/duplicate`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const out = (await tx(db, async (db) => (await W.duplicateWbs(db, ctx.project, ctx.w, req.user.id, { withChildren: req.body?.with_children !== false }))));
    res.status(201).json({ item: (await W.getWbs(db, ctx.project, out.id)), created_ids: out.created, ...(await wbsResponse(ctx.project)) });
  }));
  app.post(`${wbase}/:iid/restore`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    const w = (await loadWbs(req, res, project)); if (!w) return;
    if (!w.archived_at) return fail(res, 409, 'not_archived', '보관된 항목이 아닙니다.');
    const ids = (await tx(db, async (db) => (await W.restoreWbs(db, project, w, req.user.id))));
    res.json({ restored_ids: ids, item: (await W.getWbs(db, project, w.id)), ...(await wbsResponse(project)) });
  }));

  app.post(`${wbase}/:iid/dependencies`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    (await tx(db, async (db) => (await W.addDependency(db, ctx.project, ctx.w, String(req.body?.predecessor_id || ''), req.user.id))));
    res.status(201).json({ item: (await W.getWbs(db, ctx.project, ctx.w.id)), ...(await wbsResponse(ctx.project)) });
  }));

  app.delete(`${wbase}/:iid/dependencies/:did`, guard, wrap(async (req, res) => {
    const ctx = (await wbsMutable(req, res)); if (!ctx) return;
    const ok = (await tx(db, async (db) => (await W.removeDependency(db, ctx.project, ctx.w, req.params.did, req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '선행 작업 관계를 찾을 수 없습니다.');
    res.json({ item: (await W.getWbs(db, ctx.project, ctx.w.id)), ...(await wbsResponse(ctx.project)) });
  }));


  /* ---------- requirement ↔ wbs links ---------- */
  const linkMutable = async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return null;
    return project;
  };
  const linkPair = async (res, project, reqId, wbsId) => {
    const requirement = (await db.get('SELECT * FROM requirements WHERE project_id = ? AND id = ?', [project.id, reqId]));
    const wbs = (await db.get('SELECT * FROM wbs_items WHERE project_id = ? AND id = ?', [project.id, wbsId]));
    if (!requirement) { fail(res, 404, 'not_found', '요구사항을 찾을 수 없습니다.'); return null; }
    if (!wbs) { fail(res, 404, 'not_found', 'WBS 항목을 찾을 수 없습니다.'); return null; }
    return { requirement, wbs };
  };
  // Requirement side
  app.post(`${rbase}/:rid/links`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const pair = (await linkPair(res, project, req.params.rid, String(req.body?.wbs_item_id || ''))); if (!pair) return;
    const type = T.parseLinkType(req.body?.link_type);
    (await tx(db, async (db) => (await T.addLink(db, project, pair, type, req.user.id))));
    res.status(201).json({ requirement: (await R.getRequirement(db, project, pair.requirement.id)), summary: (await R.requirementStats(db, project.id)) });
  }));
  app.patch(`${rbase}/:rid/links/:lid`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const link = (await T.getLink(db, project, req.params.lid));
    if (!link || link.requirement_id !== req.params.rid) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    const type = T.parseLinkType(req.body?.link_type);
    (await tx(db, async (db) => (await T.updateLinkType(db, link, type, req.user.id))));
    res.json({ requirement: (await R.getRequirement(db, project, link.requirement_id)), summary: (await R.requirementStats(db, project.id)) });
  }));
  app.delete(`${rbase}/:rid/links/:lid`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const link = (await T.getLink(db, project, req.params.lid));
    if (!link || link.requirement_id !== req.params.rid) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    (await tx(db, async (db) => (await T.removeLink(db, link, req.user.id))));
    res.json({ requirement: (await R.getRequirement(db, project, link.requirement_id)), summary: (await R.requirementStats(db, project.id)) });
  }));
  // WBS side
  app.post(`${wbase}/:iid/links`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const pair = (await linkPair(res, project, String(req.body?.requirement_id || ''), req.params.iid)); if (!pair) return;
    const type = T.parseLinkType(req.body?.link_type);
    (await tx(db, async (db) => (await T.addLink(db, project, pair, type, req.user.id))));
    res.status(201).json({ item: (await W.getWbs(db, project, pair.wbs.id)), ...(await wbsResponse(project)) });
  }));
  app.patch(`${wbase}/:iid/links/:lid`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const link = (await T.getLink(db, project, req.params.lid));
    if (!link || link.wbs_item_id !== req.params.iid) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    (await tx(db, async (db) => (await T.updateLinkType(db, link, T.parseLinkType(req.body?.link_type), req.user.id))));
    res.json({ item: (await W.getWbs(db, project, link.wbs_item_id)), ...(await wbsResponse(project)) });
  }));
  app.delete(`${wbase}/:iid/links/:lid`, guard, wrap(async (req, res) => {
    const project = (await linkMutable(req, res)); if (!project) return;
    const link = (await T.getLink(db, project, req.params.lid));
    if (!link || link.wbs_item_id !== req.params.iid) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    (await tx(db, async (db) => (await T.removeLink(db, link, req.user.id))));
    res.json({ item: (await W.getWbs(db, project, link.wbs_item_id)), ...(await wbsResponse(project)) });
  }));


  /* ---------- change requests ---------- */
  const cbase = `${base}/:pid/changes`;
  const crResponse = async (project, id) => ({ change: (await C.getChange(db, project, id)), summary: (await C.changeStats(db, project.id)) });
  const loadCr = async (req, res, project) => {
    const c = (await C.getChange(db, project, req.params.cid));
    if (!c) fail(res, 404, 'not_found', '변경 요청을 찾을 수 없습니다.');
    return c;
  };
  const crMutable = async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return null;
    const c = (await loadCr(req, res, project));
    if (!c) return null;
    if (c.archived_at) { fail(res, 409, 'archived', '보관된 변경 요청은 수정할 수 없습니다.'); return null; }
    return { project, c };
  };

  app.get(cbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    res.json({ changes: (await C.listChanges(db, project, req.query)), summary: (await C.changeStats(db, project.id)), requesters: (await C.requesterOptions(db, project.id)) });
  }));
  app.post(cbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project || !mutable(res, project)) return;
    const input = C.parseChange(req.body);
    const reqIds = Array.isArray(req.body?.requirements) ? req.body.requirements : [];
    const id = (await tx(db, async (db) => {
      const cid = (await C.createChange(db, project, input, req.user.id));
      for (const r of reqIds) {
        const rid = typeof r === 'string' ? r : r?.requirement_id;
        const out = (await C.linkRequirement(db, project, { id: cid }, String(rid || ''), C.parseRelationType(typeof r === 'object' ? r?.relation_type : undefined), req.user.id));
        if (out.error) throw new ValidationError({ requirements: '연결할 요구사항을 찾을 수 없습니다.' });
      }
      return cid;
    }));
    res.status(201).json((await crResponse(project, id)));
  }));
  app.get(`${cbase}/:cid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res));
    if (!project) return;
    const c = (await loadCr(req, res, project));
    if (c) res.json({ change: c });
  }));
  app.patch(`${cbase}/:cid`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const input = C.parseChange(req.body, { partial: true });
    const changed = (await tx(db, async (db) => (await C.updateChange(db, ctx.c, input, req.user.id))));
    res.json({ ...(await crResponse(ctx.project, ctx.c.id)), changed });
  }));
  app.post(`${cbase}/:cid/transition`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const r = (await tx(db, async (db) => (await C.transition(db, ctx.c, String(req.body?.action || ''), { note: req.body?.decision_note }, req.user.id))));
    if (r.error === 'bad_action') return fail(res, 400, 'bad_action', '지원하지 않는 작업입니다.');
    if (r.error) return fail(res, 409, 'invalid_transition', `현재 상태(${ctx.c.status})에서는 이 작업을 할 수 없습니다.`);
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.post(`${cbase}/:cid/archive`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    (await tx(db, async (db) => (await C.archiveChange(db, ctx.c, req.user.id))));
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.post(`${cbase}/:cid/requirements`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const out = (await tx(db, async (db) => (await C.linkRequirement(db, ctx.project, ctx.c, String(req.body?.requirement_id || ''), C.parseRelationType(req.body?.relation_type), req.user.id))));
    if (out.error) return fail(res, 404, 'not_found', '요구사항을 찾을 수 없습니다.');
    res.status(201).json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.patch(`${cbase}/:cid/requirements/:lid`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const ok = (await tx(db, async (db) => (await C.updateRequirementLink(db, ctx.c, req.params.lid, C.parseRelationType(req.body?.relation_type), req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.delete(`${cbase}/:cid/requirements/:lid`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const ok = (await tx(db, async (db) => (await C.unlinkRequirement(db, ctx.c, req.params.lid, req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.post(`${cbase}/:cid/impacts`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const out = (await tx(db, async (db) => (await C.addImpact(db, ctx.project, ctx.c, String(req.body?.wbs_item_id || ''), C.parseImpactType(req.body?.impact_type), req.body?.impact_note || '', req.user.id))));
    if (out.error) return fail(res, 404, 'not_found', 'WBS 항목을 찾을 수 없습니다.');
    res.status(201).json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.patch(`${cbase}/:cid/impacts/:iid`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const patch = {};
    if (req.body?.impact_type !== undefined) patch.impact_type = C.parseImpactType(req.body.impact_type);
    if (req.body?.impact_note !== undefined) patch.impact_note = String(req.body.impact_note);
    const ok = (await tx(db, async (db) => (await C.updateImpact(db, ctx.c, req.params.iid, patch, req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '영향 항목을 찾을 수 없습니다.');
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));
  app.delete(`${cbase}/:cid/impacts/:iid`, guard, wrap(async (req, res) => {
    const ctx = (await crMutable(req, res)); if (!ctx) return;
    const ok = (await tx(db, async (db) => (await C.removeImpact(db, ctx.c, req.params.iid, req.user.id))));
    if (!ok) return fail(res, 404, 'not_found', '영향 항목을 찾을 수 없습니다.');
    res.json((await crResponse(ctx.project, ctx.c.id)));
  }));


  /* ---------- issues & risks (shared handler factory) ---------- */
  for (const [seg, type, parse, getOne, listFn, create] of [
    ['issues', 'ISSUE', X.parseIssue, X.getIssue, X.listIssues, X.createIssue],
    ['risks', 'RISK', X.parseRisk, X.getRisk, X.listRisks, X.createRisk],
  ]) {
    const xbase = `${base}/:pid/${seg}`;
    const resp = async (project, id) => ({ [type === 'ISSUE' ? 'issue' : 'risk']: await getOne(db, project, id), issues: (await X.issueStats(db, project.id)), risks: (await X.riskStats(db, project.id)) });
    const loadX = async (req, res, project) => { const x = await getOne(db, project, req.params.xid); if (!x) fail(res, 404, 'not_found', type === 'ISSUE' ? 'Issue를 찾을 수 없습니다.' : 'Risk를 찾을 수 없습니다.'); return x; };
    const xMutable = async (req, res) => {
      const project = (await loadProject(req, res));
      if (!project || !mutable(res, project)) return null;
      const x = await loadX(req, res, project); if (!x) return null;
      if (x.archived_at) { fail(res, 409, 'archived', '보관된 항목은 수정할 수 없습니다.'); return null; }
      return { project, x };
    };
    app.get(xbase, guard, wrap(async (req, res) => {
      const project = (await loadProject(req, res)); if (!project) return;
      res.json({ items: await listFn(db, project, req.query), issues: (await X.issueStats(db, project.id)), risks: (await X.riskStats(db, project.id)) });
    }));
    app.post(xbase, guard, wrap(async (req, res) => {
      const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
      const input = parse(req.body);
      if (!(await ownerOk(req, res, input.owner_user_id))) return;
      const id = (await tx(db, async (db) => await create(db, project, input, req.user.id)));
      res.status(201).json((await resp(project, id)));
    }));
    app.get(`${xbase}/:xid`, guard, wrap(async (req, res) => {
      const project = (await loadProject(req, res)); if (!project) return;
      const x = await loadX(req, res, project); if (x) res.json((await resp(project, x.id)));
    }));
    app.patch(`${xbase}/:xid`, guard, wrap(async (req, res) => {
      const ctx = (await xMutable(req, res)); if (!ctx) return;
      const input = parse(req.body, { partial: true });
      if (!(await ownerOk(req, res, input.owner_user_id))) return;
      const r = (await tx(db, async (db) => (await X.updateEntity(db, type, ctx.x, input, req.user.id))));
      if (r.error) return fail(res, 409, 'invalid_transition', `현재 상태(${r.from})에서 ${r.to}(으)로 바꿀 수 없습니다.`);
      res.json({ ...(await resp(ctx.project, ctx.x.id)), changed: r.changed });
    }));
    app.post(`${xbase}/:xid/archive`, guard, wrap(async (req, res) => {
      const ctx = (await xMutable(req, res)); if (!ctx) return;
      (await tx(db, async (db) => (await X.archiveEntity(db, type, ctx.x, req.user.id))));
      res.json((await resp(ctx.project, ctx.x.id)));
    }));
    app.post(`${xbase}/:xid/links`, guard, wrap(async (req, res) => {
      const ctx = (await xMutable(req, res)); if (!ctx) return;
      const out = (await tx(db, async (db) => (await X.addLink(db, ctx.project, type, ctx.x, String(req.body?.target_type || ''), String(req.body?.target_id || ''), req.user.id))));
      if (out.error) return fail(res, 404, 'not_found', '연결 대상을 찾을 수 없습니다.');
      res.status(201).json((await resp(ctx.project, ctx.x.id)));
    }));
    app.delete(`${xbase}/:xid/links/:lid`, guard, wrap(async (req, res) => {
      const ctx = (await xMutable(req, res)); if (!ctx) return;
      const ok = (await tx(db, async (db) => (await X.removeLink(db, type, ctx.x, req.params.lid, req.user.id))));
      if (!ok) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
      res.json((await resp(ctx.project, ctx.x.id)));
    }));
    if (type === 'RISK') {
      app.post(`${xbase}/:xid/convert`, guard, wrap(async (req, res) => {
        const ctx = (await xMutable(req, res)); if (!ctx) return;
        const r = (await tx(db, async (db) => (await X.convertRiskToIssue(db, ctx.project, ctx.x, req.user.id))));
        if (r.error === 'already_converted') return fail(res, 409, 'already_converted', `이미 ${r.display_id}(으)로 전환된 Risk입니다.`);
        if (r.error) return fail(res, 409, 'invalid_state', '종료된 Risk는 Issue로 전환할 수 없습니다.');
        res.status(201).json({ ...(await resp(ctx.project, ctx.x.id)), issue: (await X.getIssue(db, ctx.project, r.issueId)) });
      }));
    }
  }


  /* ---------- tests ---------- */
  const tbase = `${base}/:pid/tests`;
  const tResp = async (project, id) => ({ test: (await Q.getTest(db, project, id)), tests: (await Q.testStats(db, project.id)) });
  const loadTest = async (req, res, project) => { const t = (await Q.getTest(db, project, req.params.tid)); if (!t) fail(res, 404, 'not_found', '테스트를 찾을 수 없습니다.'); return t; };
  const tMutable = async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return null;
    const t = (await loadTest(req, res, project)); if (!t) return null;
    if (t.archived_at) { fail(res, 409, 'archived', '보관된 테스트는 수정할 수 없습니다.'); return null; }
    return { project, t };
  };
  app.get(tbase, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; res.json({ items: (await Q.listTests(db, project, req.query)), tests: (await Q.testStats(db, project.id)) }); }));
  app.get(`${tbase}/coverage`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; res.json({ coverage: (await Q.coverage(db, project.id)), tests: (await Q.testStats(db, project.id)) }); }));
  app.post(tbase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    const input = Q.parseTest(req.body); if (!(await ownerOk(req, res, input.owner_user_id))) return;
    const id = (await tx(db, async (db) => (await Q.createTest(db, project, input, req.user.id))));
    res.status(201).json((await tResp(project, id)));
  }));
  app.get(`${tbase}/:tid`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; const t = (await loadTest(req, res, project)); if (t) res.json((await tResp(project, t.id))); }));
  app.patch(`${tbase}/:tid`, guard, wrap(async (req, res) => {
    const ctx = (await tMutable(req, res)); if (!ctx) return;
    const input = Q.parseTest(req.body, { partial: true }); if (!(await ownerOk(req, res, input.owner_user_id))) return;
    const changed = (await tx(db, async (db) => (await Q.updateTest(db, ctx.t, input, req.user.id))));
    res.json({ ...(await tResp(ctx.project, ctx.t.id)), changed });
  }));
  app.post(`${tbase}/:tid/archive`, guard, wrap(async (req, res) => { const ctx = (await tMutable(req, res)); if (!ctx) return; (await tx(db, async (db) => (await Q.archiveTest(db, ctx.t, req.user.id)))); res.json((await tResp(ctx.project, ctx.t.id))); }));
  app.post(`${tbase}/:tid/executions`, guard, wrap(async (req, res) => {
    const ctx = (await tMutable(req, res)); if (!ctx) return;
    const input = Q.parseExecution(req.body);
    const e = (await tx(db, async (db) => (await Q.addExecution(db, ctx.t, input, req.user.id))));
    res.status(201).json({ ...(await tResp(ctx.project, ctx.t.id)), execution: e });
  }));
  app.post(`${tbase}/:tid/executions/:eid/issue`, guard, wrap(async (req, res) => {
    const ctx = (await tMutable(req, res)); if (!ctx) return;
    const ex = ctx.t.executions.find((e) => e.id === req.params.eid);
    if (!ex) return fail(res, 404, 'not_found', '실행 기록을 찾을 수 없습니다.');
    const r = (await tx(db, async (db) => (await Q.raiseIssueFromExecution(db, ctx.project, ctx.t, ex, req.user.id))));
    if (r.error === 'not_failed') return fail(res, 409, 'not_failed', 'FAIL 결과에서만 Issue를 등록할 수 있습니다.');
    if (r.error === 'already_raised') return fail(res, 409, 'already_raised', `이미 ${r.issue.display_id}(으)로 등록된 실행입니다.`, { issue_id: r.issue.id });
    res.status(201).json({ ...(await tResp(ctx.project, ctx.t.id)), issue: (await X.getIssue(db, ctx.project, r.issueId)) });
  }));
  app.post(`${tbase}/:tid/links`, guard, wrap(async (req, res) => {
    const ctx = (await tMutable(req, res)); if (!ctx) return;
    const out = (await tx(db, async (db) => (await Q.addTestLink(db, ctx.project, ctx.t, String(req.body?.target_type || ''), String(req.body?.target_id || ''), req.user.id))));
    if (out.error) return fail(res, 404, 'not_found', '연결 대상을 찾을 수 없습니다.');
    res.status(201).json((await tResp(ctx.project, ctx.t.id)));
  }));
  app.delete(`${tbase}/:tid/links/:lid`, guard, wrap(async (req, res) => {
    const ctx = (await tMutable(req, res)); if (!ctx) return;
    if (!(await tx(db, async (db) => (await Q.removeTestLink(db, ctx.t, req.params.lid, req.user.id))))) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    res.json((await tResp(ctx.project, ctx.t.id)));
  }));

  /* ---------- acceptances ---------- */
  const abase = `${base}/:pid/acceptances`;
  const aResp = async (project, id) => ({ acceptance: (await Q.getAcceptance(db, project, id)), acceptances: (await Q.acceptanceStats(db, project.id)) });
  const loadAcc = async (req, res, project) => { const a = (await Q.getAcceptance(db, project, req.params.aid)); if (!a) fail(res, 404, 'not_found', '검수를 찾을 수 없습니다.'); return a; };
  const aMutable = async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return null;
    const a = (await loadAcc(req, res, project)); if (!a) return null;
    if (a.archived_at) { fail(res, 409, 'archived', '보관된 검수는 수정할 수 없습니다.'); return null; }
    return { project, a };
  };
  app.get(abase, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; res.json({ items: (await Q.listAcceptances(db, project, req.query)), acceptances: (await Q.acceptanceStats(db, project.id)) }); }));
  app.post(abase, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    const input = Q.parseAcceptance(req.body);
    const id = (await tx(db, async (db) => { const aid = (await Q.createAcceptance(db, project, input, req.user.id));
      for (const rid of Array.isArray(req.body?.requirements) ? req.body.requirements : []) { const o = (await Q.addAcceptanceLink(db, project, { id: aid }, 'REQUIREMENT', String(rid), req.user.id)); if (o.error) throw new ValidationError({ requirements: '요구사항을 찾을 수 없습니다.' }); }
      return aid; }));
    res.status(201).json((await aResp(project, id)));
  }));
  app.get(`${abase}/:aid`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; const a = (await loadAcc(req, res, project)); if (a) res.json((await aResp(project, a.id))); }));
  app.patch(`${abase}/:aid`, guard, wrap(async (req, res) => {
    const ctx = (await aMutable(req, res)); if (!ctx) return;
    const changed = (await tx(db, async (db) => (await Q.updateAcceptance(db, ctx.a, Q.parseAcceptance(req.body, { partial: true }), req.user.id))));
    res.json({ ...(await aResp(ctx.project, ctx.a.id)), changed });
  }));
  app.post(`${abase}/:aid/transition`, guard, wrap(async (req, res) => {
    const ctx = (await aMutable(req, res)); if (!ctx) return;
    const r = (await tx(db, async (db) => (await Q.transitionAcceptance(db, ctx.a, String(req.body?.action || ''), { note: req.body?.decision_note }, req.user.id))));
    if (r.error === 'bad_action') return fail(res, 400, 'bad_action', '지원하지 않는 작업입니다.');
    if (r.error) return fail(res, 409, 'invalid_transition', `현재 상태(${r.from})에서는 이 작업을 할 수 없습니다.`);
    res.json((await aResp(ctx.project, ctx.a.id)));
  }));
  app.post(`${abase}/:aid/archive`, guard, wrap(async (req, res) => { const ctx = (await aMutable(req, res)); if (!ctx) return; (await tx(db, async (db) => (await Q.archiveAcceptance(db, ctx.a, req.user.id)))); res.json((await aResp(ctx.project, ctx.a.id))); }));
  app.post(`${abase}/:aid/links`, guard, wrap(async (req, res) => {
    const ctx = (await aMutable(req, res)); if (!ctx) return;
    const out = (await tx(db, async (db) => (await Q.addAcceptanceLink(db, ctx.project, ctx.a, String(req.body?.target_type || ''), String(req.body?.target_id || ''), req.user.id))));
    if (out.error) return fail(res, 404, 'not_found', '연결 대상을 찾을 수 없습니다.');
    res.status(201).json((await aResp(ctx.project, ctx.a.id)));
  }));
  app.delete(`${abase}/:aid/links/:lid`, guard, wrap(async (req, res) => {
    const ctx = (await aMutable(req, res)); if (!ctx) return;
    if (!(await tx(db, async (db) => (await Q.removeAcceptanceLink(db, ctx.a, req.params.lid, req.user.id))))) return fail(res, 404, 'not_found', '연결을 찾을 수 없습니다.');
    res.json((await aResp(ctx.project, ctx.a.id)));
  }));

  /* ---------- Phase 9: health / attention / weekly reports ---------- */
  app.get(`${base}/:pid/health`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; res.json({ health: (await H.projectHealth(db, project)) }); }));
  app.get(`${base}/:pid/attention`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; const items = (await M.attentionAll(db, project.id)); res.json({ items, total: items.length }); }));
  mountDashboardRoute({ app, db, guard, wrap, loadProject, base });
  mountAiRoutes({ app, db, guard, wrap, fail, loadProject, mutable, base });   // Phase 11 AI (draft/candidate endpoints + approval commits)
  mountIntegrationRoutes({ app, db, guard, wrap, fail, requireAuth, loadProject, mutable, base });   // Phase 12 integrations (Jira)
  mountAuthRoutes({ app, db, guard, wrap, fail, requireAuth, startSession, afterLogin });   // Phase 13 Google sign-in + invitations
  mountOnboardingRoutes({ app, db, guard, requireAuth, wrap, fail });                   // Phase 14 onboarding / tour / guides / activation
  const wrbase = `${base}/:pid/weekly-reports`;
  const loadReport = async (req, res, project) => { const r = (await WR.getReport(db, project.id, req.params.rid)); if (!r) fail(res, 404, 'not_found', '보고서를 찾을 수 없습니다.'); return r; };
  const rResp = async (project, id) => { const report = (await WR.getReport(db, project.id, id)); return { report: { ...report, plain_text: WR.toPlainText(report.rendered_content) } }; };
  app.get(wrbase, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; res.json({ items: (await WR.listReports(db, project.id)), default_period: WR.defaultPeriod() }); }));
  app.post(`${wrbase}/generate`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return;
    const period = WR.parsePeriod(req.body || {});
    const id = (await tx(db, async (db) => (await WR.generateReport(db, project, period, req.user.id))));
    res.status(201).json((await rResp(project, id)));
  }));
  app.get(`${wrbase}/:rid`, guard, wrap(async (req, res) => { const project = (await loadProject(req, res)); if (!project) return; const r = (await loadReport(req, res, project)); if (r) res.json((await rResp(project, r.id))); }));
  app.patch(`${wrbase}/:rid`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return; const r = (await loadReport(req, res, project)); if (!r) return;
    const out = (await tx(db, async (db) => (await WR.updateReport(db, r, req.body || {}))));
    if (out.error === 'final') return fail(res, 409, 'final', '확정된 보고서는 수정할 수 없습니다. 다시 편집을 눌러 초안으로 되돌리세요.');
    res.json((await rResp(project, r.id)));
  }));
  app.post(`${wrbase}/:rid/finalize`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return; const r = (await loadReport(req, res, project)); if (!r) return;
    const out = (await tx(db, async (db) => (await WR.finalizeReport(db, r)))); if (out.error) return fail(res, 409, out.error, '이미 확정된 보고서입니다.');
    res.json((await rResp(project, r.id)));
  }));
  app.post(`${wrbase}/:rid/reopen`, guard, wrap(async (req, res) => {
    const project = (await loadProject(req, res)); if (!project || !mutable(res, project)) return; const r = (await loadReport(req, res, project)); if (!r) return;
    const out = (await tx(db, async (db) => (await WR.reopenReport(db, r)))); if (out.error) return fail(res, 409, out.error, '초안 상태의 보고서입니다.');
    res.json((await rResp(project, r.id)));
  }));

  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.all('/api/*', (req, res) => fail(res, 404, 'not_found', '찾을 수 없습니다.'));

  /* ---------- pages ---------- */
  const pub = resolve(here, '../public');
  app.use('/assets', express.static(resolve(pub, 'app'), { maxAge: 0, etag: true }));
  app.get(['/login', '/signup'], (req, res) => {
    if (req.user && !(req.path === '/signup' && req.query.invite)) return res.redirect('/app');
    res.sendFile(resolve(pub, 'app/index.html'));
  });
  app.get(/^\/invite\/[A-Za-z0-9_-]+\/?$/, (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(resolve(pub, 'app/index.html')); });   // public invite landing (Phase 13)
  /* Admin Console page: same SPA bundle, but the server refuses it to non-operators (403) — the frontend hiding is not the control. */
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!isSystemAdmin(req.user)) return res.status(403).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>403</title><body style="font-family:sans-serif;padding:40px"><h1>403</h1><p>운영자 권한이 필요합니다.</p><a href="/app">앱으로 돌아가기</a></body>');
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(pub, 'app/index.html'));
  });
  app.get(/^\/app(\/.*)?$/, (req, res) => {
    if (!req.user) return res.redirect(req.suspendedUser ? '/login?suspended=1' : `/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(pub, 'app/index.html'));
  });
  app.use(express.static(pub, { index: 'index.html', extensions: ['html'], setHeaders: (r, p) => { if (p.includes('/app/')) r.set('Cache-Control', 'no-store'); } }));
  /* UX-001: unknown non-API paths get a friendly page instead of Express's "Cannot GET". Signed-in users are sent into the app. */
  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text').send('Not found');
    if (req.user) return res.redirect('/app');
    res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;padding:40px"><h1>404</h1><p>페이지를 찾을 수 없습니다.</p><a href="/login">로그인</a></body>');
  });

  /* ---------- errors ---------- */
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return fail(res, err.code === 'parent_has_values' ? 409 : 400, err.code || 'validation_error', err.code === 'parent_has_values' ? '상위 작업의 일정·진행률 처리 방식을 선택해 주세요.' : '입력값을 확인해 주세요.', { fields: err.fields, ...(err.parent ? { parent: err.parent } : {}) });
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json', '잘못된 요청입니다.');
    if (err.type === 'entity.too.large') return fail(res, 413, 'payload_too_large', '요청 데이터가 너무 큽니다. (엑셀 가져오기는 5MB 이하 파일만 지원합니다.)');
    if (err instanceof ImportFileError) return fail(res, err.status, err.code, err.message);
    if (err instanceof AdminError) return fail(res, err.status, err.code, err.message);
    if (err instanceof AiError || err instanceof CreditError) return fail(res, err.status, err.code, err.message, err.extra || {});
    const dbe = dbErrorInfo(err);
    if (dbe) { if (dbe.status >= 500) console.error('[db]', err.message); return fail(res, dbe.status, dbe.code, dbe.message); }
    console.error(err);
    if (res.headersSent) return next(err);
    fail(res, 500, 'internal', '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  });

  return app;
}
