/**
 * Plan limit enforcement (pricing v3, design.md §5). `server/plans.js` stays the single source of truth for the numbers
 * (limitsFor); this module only counts and refuses. Limits are ACTIVE PROJECTS and USERS only (decision D1) — the
 * requirements / WBS / weekly-report call sites still call assertWithinLimit and pass straight through.
 *
 * Counting (countUsage):
 *   members          workspace_members whose account is ACTIVE and not deleted — one seat per person per workspace, however
 *                    many projects they are in; the same person in two workspaces counts in both (each is billed separately)
 *   pending_invites  unexpired PENDING WORKSPACE_MEMBER invitations — each holds a seat (reservation)
 *   projects_active  DRAFT / ACTIVE / ON_HOLD, samples excluded. COMPLETED and ARCHIVED never count.
 * Seats:
 *   invite   members + pending + 1 ≤ users (assertSeatForInvite, under the workspace row lock → two concurrent invites
 *            cannot both take the last seat). Re-sending a still-pending invite reserves nothing new.
 *   accept   members + 1 ≤ users (pending invites not counted: a reserved seat can always be taken). The accept transaction
 *            locks the workspace row first, so two accepts racing for the last seat serialize; the second gets 402 and
 *            its invite stays PENDING.
 * Inside a transaction the workspace row is locked (`FOR UPDATE`) before counting. Unlimited dimensions skip lock and count.
 *
 * Over limit (decision D6): data is never deleted. When usage > limits (after a downgrade, expiry or refund) the workspace is
 * OVER_LIMIT: new projects / invites are refused by the checks above and editing inside active projects is refused by the
 * project write guard (app.js) until the owner completes / archives projects or removes members. `OVER_LIMIT_LOCK=off` turns
 * the edit lock off (creation checks stay). `PLAN_LIMITS=off` disables everything (legacy test fixtures).
 */
import { PLANS, USAGE_DIMS, PLANS_URL, limitsFor } from '../plans.js';
import { effectivePlan } from './subscriptions.js';

export const limitsEnforced = () => process.env.PLAN_LIMITS !== 'off';
export const overLimitLockEnabled = () => limitsEnforced() && process.env.OVER_LIMIT_LOCK !== 'off';

/** Project statuses that count toward the active-project limit (and stay editable). */
export const ACTIVE_PROJECT_STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD'];
const ACTIVE_IN = `('${ACTIVE_PROJECT_STATUSES.join("','")}')`;
/** SQL predicates shared with usage.js / admin screens (alias `p`, `m`/`u`, `i`). */
export const ACTIVE_PROJECT_SQL = (a = 'p') => `${a}.sample_key IS NULL AND ${a}.status IN ${ACTIVE_IN}`;
export const SEAT_MEMBER_SQL = `u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
export const PENDING_INVITE_SQL = (a = 'i') => `${a}.type = 'WORKSPACE_MEMBER' AND ${a}.status = 'PENDING' AND ${a}.expires_at > now()`;

const COUNT_SQL = {
  projects: `SELECT COUNT(*) AS n FROM projects p WHERE p.workspace_id = ? AND ${ACTIVE_PROJECT_SQL('p')}`,
  members: `SELECT COUNT(*) AS n FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND ${SEAT_MEMBER_SQL}`,
};

/** Live usage of one workspace → { projects_active, members, pending_invites } (T1 contract). */
export async function countUsage(db, workspaceId) {
  const r = await db.get(`SELECT
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND ${ACTIVE_PROJECT_SQL('p')}) AS projects_active,
      (SELECT COUNT(*) FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND ${SEAT_MEMBER_SQL}) AS members,
      (SELECT COUNT(*) FROM invitations i WHERE i.workspace_id = w.id AND ${PENDING_INVITE_SQL('i')}) AS pending_invites
    FROM workspaces w WHERE w.id = ?`, [workspaceId]);
  return { projects_active: Number(r?.projects_active || 0), members: Number(r?.members || 0), pending_invites: Number(r?.pending_invites || 0) };
}

/** Subscription fields limitsFor needs, with the EFFECTIVE plan. */
export async function workspaceLimits(db, workspaceId) {
  const plan = await effectivePlan(db, workspaceId);
  const sub = plan === 'FREE' ? null : await db.get('SELECT plan, extra_users, extra_projects, seats, project_limit, price_version FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  return { plan, limits: limitsFor({ ...(sub || {}), plan }) };
}

const DIM_LIMIT = { projects: 'projects', members: 'users' };
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;

/** 402 Payment Required: the workspace's plan does not allow another `dimension`. Rendered by app.js's error handler. */
export class PlanLimitError extends Error {
  constructor({ dimension, used, limit, plan, adding = 1, pending = 0 }) {
    const label = USAGE_DIMS.find((d) => d.key === dimension)?.label || dimension;
    const allowed = Math.max(0, limit - used);
    const name = PLANS[plan]?.label || plan;
    const addon = PLANS[plan]?.addons?.[dimension === 'members' ? 'user' : 'project'];
    const how = addon ? `${dimension === 'members' ? '추가 사용자 1명' : '추가 프로젝트 1개'} 월 ${won(addon.MONTHLY)}로 한도를 늘리거나 ` : '';
    const msg = dimension === 'members'
      ? `${name} 플랜의 사용자 한도(${limit}명)를 모두 사용 중입니다${pending ? ` (대기 중인 초대 ${pending}건 포함)` : ''}. ${how || '상위 플랜으로 업그레이드하거나 '}멤버·대기 중인 초대를 정리해 주세요.`
      : adding > 1 ? `${name} 플랜의 ${label} 한도(${limit}개)를 넘습니다. ${adding}건 중 ${allowed}건만 추가할 수 있어 아무것도 추가하지 않았습니다.`
        : `${name} 플랜의 ${label} 한도(${limit}개)에 도달했습니다. ${how || '상위 플랜으로 업그레이드하거나 '}다른 프로젝트를 완료·보관해 주세요.`;
    super(msg);
    this.status = 402; this.code = 'plan_limit_reached';
    this.extra = { limit: { dimension, label, used, limit, plan, adding, allowed, ...(pending ? { pending } : {}) }, upgrade: { plan: plan === 'PRO' ? 'TEAM' : 'PRO', url: PLANS_URL } };
  }
}

/**
 * Throws PlanLimitError when `adding` more of `dimension` ('projects' | 'members') would exceed the workspace's limit.
 * Any other dimension (requirements, wbs, weekly_reports) is unlimited in v3 and returns at once.
 * `members` counts current members only (acceptance, direct adds); invitations use assertSeatForInvite.
 */
export async function assertWithinLimit(db, workspaceId, dimension, adding = 1) {
  if (!limitsEnforced() || adding <= 0 || !DIM_LIMIT[dimension]) return;
  const { plan, limits } = await workspaceLimits(db, workspaceId);
  const limit = limits[DIM_LIMIT[dimension]];
  if (limit === null || limit === undefined) return;
  if (db.isTx) await db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
  const used = Number((await db.get(COUNT_SQL[dimension], [workspaceId])).n);
  if (used + adding > limit) throw new PlanLimitError({ dimension, used, limit, plan, adding });
}

/**
 * Seat reservation at invite time: members + pending invites + 1 ≤ users. Call inside the transaction that inserts the
 * invitation (or re-opens an expired one) so the workspace lock covers check + insert.
 */
export async function assertSeatForInvite(db, workspaceId, adding = 1) {
  if (!limitsEnforced() || adding <= 0) return;
  const { plan, limits } = await workspaceLimits(db, workspaceId);
  if (limits.users === null || limits.users === undefined) return;
  if (db.isTx) await db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
  const u = await countUsage(db, workspaceId);
  if (u.members + u.pending_invites + adding > limits.users) {
    throw new PlanLimitError({ dimension: 'members', used: u.members + u.pending_invites, limit: limits.users, plan, adding, pending: u.pending_invites });
  }
}

/**
 * Over-limit state (D6) → null when within limits, else { plan, limits, usage, projects: excess, members: excess }.
 * Pending invites are not part of it (revoking them is not "cleanup" the owner owes).
 */
export async function overLimit(db, workspaceId) {
  if (!limitsEnforced()) return null;
  const { plan, limits } = await workspaceLimits(db, workspaceId);
  if (limits.projects === null && limits.users === null) return null;
  const usage = await countUsage(db, workspaceId);
  const projects = limits.projects === null ? 0 : Math.max(0, usage.projects_active - limits.projects);
  const members = limits.users === null ? 0 : Math.max(0, usage.members - limits.users);
  return projects || members ? { plan, limits, usage, projects, members } : null;
}

/** 409 for a write inside a workspace that is over its limits (D6). */
export class OverLimitError extends Error {
  constructor(state) {
    const parts = [state.projects ? `활성 프로젝트 ${state.projects}개` : '', state.members ? `사용자 ${state.members}명` : ''].filter(Boolean).join(', ');
    super(`${PLANS[state.plan]?.label || state.plan} 플랜 한도를 넘어 편집이 잠겼습니다. ${parts}을(를) 정리(프로젝트 완료·보관, 멤버 내보내기)하거나 플랜을 변경하면 다시 편집할 수 있어요. 데이터는 삭제되지 않습니다.`);
    this.status = 409; this.code = 'over_limit';
    this.extra = { over_limit: { plan: state.plan, limits: state.limits, usage: state.usage, excess: { projects: state.projects, members: state.members } }, upgrade: { url: PLANS_URL } };
  }
}

/*
 * Project read-only after a downgrade (founder policy 2026-10-21, research/relai-pricing-v3/founder-cancel-retention-2026-10-21.md;
 * replaces the D6 "lock every active project" edit lock). When a workspace has more active projects than its plan allows
 * (cancel → period end → FREE, payment grace over, refund, downgrade to a smaller plan), the newest projects by created_at — as
 * many as the plan allows — stay editable and every other active project is read-only. Samples are never counted or locked;
 * COMPLETED / ARCHIVED projects keep their own rules. The user is not asked to pick: the order is created_at DESC (id as tie-break).
 * Nothing is stored: the state follows the effective plan, so re-subscribing / upgrading restores edit access at once, newest first,
 * up to the new limit, and no project row is changed or deleted. Member excess does not lock editing (invites/accepts stay refused).
 * `OVER_LIMIT_LOCK=off` turns the lock off; `PLAN_LIMITS=off` disables limits altogether.
 */
const NEWER_SQL = `SELECT COUNT(*) AS n FROM projects q WHERE q.workspace_id = p.workspace_id AND ${ACTIVE_PROJECT_SQL('q')}
  AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id))`;

/** Workspace view → { plan, limit, readOnly: Set<projectId>, editable: [projectId] } (limit null = unlimited, nothing read-only). */
export async function projectAccess(db, workspaceId) {
  if (!overLimitLockEnabled()) return { plan: null, limit: null, readOnly: new Set(), editable: [] };
  const { plan, limits } = await workspaceLimits(db, workspaceId);
  if (limits.projects === null || limits.projects === undefined) return { plan, limit: null, readOnly: new Set(), editable: [] };
  const rows = await db.all(`SELECT p.id FROM projects p WHERE p.workspace_id = ? AND ${ACTIVE_PROJECT_SQL('p')} ORDER BY p.created_at DESC, p.id DESC`, [workspaceId]);
  return { plan, limit: limits.projects, editable: rows.slice(0, limits.projects).map((r) => r.id), readOnly: new Set(rows.slice(limits.projects).map((r) => r.id)) };
}

/** One project → null when editable, else { plan, limit } (read-only because newer active projects already fill the plan). */
export async function projectReadOnly(db, workspaceId, projectId) {
  if (!overLimitLockEnabled()) return null;
  const p = await db.get(`SELECT p.id, (${NEWER_SQL}) AS newer FROM projects p WHERE p.workspace_id = ? AND p.id = ? AND ${ACTIVE_PROJECT_SQL('p')}`, [workspaceId, projectId]);
  if (!p) return null;
  const { plan, limits } = await workspaceLimits(db, workspaceId);
  if (limits.projects === null || limits.projects === undefined || Number(p.newer) < limits.projects) return null;
  return { plan, limit: limits.projects };
}

/** User-facing policy line for a read-only project (banner, 409 message). */
export const readOnlyNotice = ({ plan, limit }) => `${PLANS[plan]?.label || plan} 플랜에서는 가장 최근에 만든 프로젝트 ${limit}개만 편집할 수 있어 이 프로젝트는 조회 전용입니다. 데이터는 삭제되지 않고 그대로 보관되며 조회·내보내기는 계속할 수 있어요. 다시 구독하거나 플랜을 올리면 한도만큼 최근 프로젝트부터 편집 권한이 돌아와요.`;

/** 409 for a write inside a project that is read-only after a downgrade. */
export class ProjectReadOnlyError extends Error {
  constructor(state) {
    super(readOnlyNotice(state));
    this.status = 409; this.code = 'project_read_only';
    this.extra = { read_only: { plan: state.plan, limit: state.limit }, upgrade: { url: PLANS_URL } };
  }
}
