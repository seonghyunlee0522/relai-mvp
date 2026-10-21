/* RELAI app entry — wires routes to page modules. All pages are ES modules under /assets/. */
import { registerRoutes, render } from './core/router.js';
import { onDeviceChange } from './core/device.js';
import { wireGpops } from './core/outside.js';
import { shell } from './shell.js';
import { authPage, forgotPage, resetPage, verifyPage } from './auth.js';
import { invitePage } from './invite.js';
import { homePage } from './project/home.js';   // Workspace Home: project status cards
import { projectsPage } from './project/list.js';
import { projectFormPage } from './project/form.js';
import { overviewPage } from './project/overview.js';
import { nextPage } from './project/next.js';
import { phasePage } from './project/phase.js';
import { definitionPage } from './project/definition.js';
import { charterPage } from './project/charter.js';
import { checklistPage } from './project/checklist.js';
import { reportPage } from './project/report.js';
import { reportsPage } from './project/reports.js';
import { activityPage } from './project/activity.js';   // batch7 #22: 보고서 › 활동 기록
import { requirementsPage } from './requirements/page.js';
import { wbsPage } from './wbs/page.js';
import { changesPage } from './changes/page.js';
import { raidPage } from './raid/page.js';
import { testsPage } from './testing/page.js';
import { settingsPage } from './settings.js';
import { creditsPage } from './credits.js';
import { plansPage } from './plans.js';
import { billingPage } from './billing.js';   // 설정 › 플랜 · 결제 (pricing v3 T4)
import { subscribePage } from './subscribe.js';   // 구독 · 카드 등록 (NicePay 정기결제)
import { sampleGuidePage } from './project/sample-guide.js';   // RELAI 가이드 · 샘플로 보기
import './shared/upgrade.js';   // 402 plan_limit_reached → upgrade prompt (Phase 10)
import { adminShell } from './admin/shell.js';
import { adminDashboardPage } from './admin/dashboard.js';
import { adminUsersPage, adminUserPage } from './admin/users.js';
import { adminWorkspacesPage, adminWorkspacePage } from './admin/workspaces.js';
import { adminSubscriptionsPage, adminSubscriptionPage, adminPaymentsPage, adminPaymentPage } from './admin/billing.js';
import { adminUsagePage } from './admin/usage.js';
import { adminDeliverablesPage } from './admin/deliverables.js';
import { adminPromptsPage, adminPromptPage } from './admin/ai-prompts.js';
import { adminFunnelPage } from './admin/funnel.js';
import { adminPromotionsPage } from './admin/promotions.js';
import { adminPurgePage } from './admin/purge.js';
import { adminFeedbackPage, adminFeedbackDetailPage } from './admin/feedback.js';
import { adminAuditPage } from './admin/audit.js';
import { adminIntegrationsPage } from './admin/integrations.js';
import { adminInvitationsPage, adminEmailDeliveriesPage } from './admin/invitations.js';

registerRoutes([
  [/^\/app\/?$/, homePage],
  [/^\/app\/projects\/?$/, projectsPage],
  [/^\/app\/guide\/?$/, sampleGuidePage],
  [/^\/app\/projects\/new\/?$/, projectFormPage],
  [/^\/app\/projects\/([\w-]+)\/?$/, nextPage],            // landing = What’s Next? (existing deep links keep working)
  [/^\/app\/projects\/([\w-]+)\/overview\/?$/, overviewPage],
  [/^\/app\/projects\/([\w-]+)\/edit\/?$/, projectFormPage],
  [/^\/app\/projects\/([\w-]+)\/definition(?:\/(goals|stakeholders|milestones|operations|kickoff|approval))?\/?$/, definitionPage],   // 계획 › 프로젝트 정의: 개요 + one tab per task
  [/^\/app\/projects\/([\w-]+)\/charter\/?$/, charterPage],
  [/^\/app\/projects\/([\w-]+)\/checklist\/?$/, checklistPage],      // 06 전환·오픈 · 07 운영 activity checklists         // Overview › Project Charter (read-only view of 프로젝트 정의)
  [/^\/app\/projects\/([\w-]+)\/phases(?:\/[A-Z_]+)?\/?$/, phasePage],   // legacy deep links → What’s Next
  [/^\/app\/projects\/([\w-]+)\/reports\/?$/, reportsPage],
  [/^\/app\/projects\/([\w-]+)\/activity\/?$/, activityPage],
  [/^\/app\/projects\/([\w-]+)\/reports\/([\w-]+)\/?$/, reportPage],
  [/^\/app\/projects\/([\w-]+)\/requirements\/?$/, requirementsPage],
  [/^\/app\/projects\/([\w-]+)\/wbs\/?$/, wbsPage],
  [/^\/app\/projects\/([\w-]+)\/changes\/?$/, changesPage],
  [/^\/app\/projects\/([\w-]+)\/issues\/?$/, raidPage],
  [/^\/app\/projects\/([\w-]+)\/tests\/?$/, testsPage],
  [/^\/app\/settings\/?$/, settingsPage],
  [/^\/app\/settings\/billing\/?$/, billingPage],     // 워크스페이스 Billing (pricing v3 T4)
  [/^\/app\/settings\/credits\/?$/, creditsPage],      // 설정 › AI 크레딧 (AI-credits-only billing)
  [/^\/app\/billing\/plans\/?$/, plansPage],          // 플랜 · 구독 (batch7 T5: every limit / credit upsell lands here)
  [/^\/app\/billing\/subscribe\/?$/, subscribePage],  // 구독하기 → 카드 등록 · 정기결제 동의 (NicePay review path)
  // Admin Console — separate shell, operator-only (the server refuses /admin and /api/admin/* to everyone else)
  [/^\/admin\/?$/, adminDashboardPage],
  [/^\/admin\/users\/?$/, adminUsersPage],
  [/^\/admin\/users\/([\w-]+)\/?$/, adminUserPage],
  [/^\/admin\/workspaces\/?$/, adminWorkspacesPage],
  [/^\/admin\/workspaces\/([\w-]+)\/?$/, adminWorkspacePage],
  [/^\/admin\/subscriptions\/?$/, adminSubscriptionsPage],
  [/^\/admin\/subscriptions\/([\w-]+)\/?$/, adminSubscriptionPage],
  [/^\/admin\/payments\/?$/, adminPaymentsPage],
  [/^\/admin\/payments\/([\w-]+)\/?$/, adminPaymentPage],
  [/^\/admin\/usage\/?$/, adminUsagePage],
  [/^\/admin\/deliverables\/?$/, adminDeliverablesPage],
  [/^\/admin\/ai-prompts\/?$/, adminPromptsPage],
  [/^\/admin\/ai-prompts\/([A-Z_]+)\/?$/, adminPromptPage],
  [/^\/admin\/funnel\/?$/, adminFunnelPage],
  [/^\/admin\/promotions\/?$/, adminPromotionsPage],
  [/^\/admin\/feedback\/?$/, adminFeedbackPage],
  [/^\/admin\/feedback\/([\w-]+)\/?$/, adminFeedbackDetailPage],
  [/^\/admin\/invitations\/?$/, adminInvitationsPage],
  [/^\/admin\/email-deliveries\/?$/, adminEmailDeliveriesPage],
  [/^\/admin\/integrations\/?$/, adminIntegrationsPage],
  [/^\/admin\/audit\/?$/, adminAuditPage],
  [/^\/admin\/purge\/?$/, adminPurgePage],
], { shell: (path, view, token) => (path.startsWith('/admin') ? adminShell(path, view) : shell(path, view, token)), auth: authPage, invite: invitePage,
  account: { 'forgot-password': forgotPage, 'reset-password': resetPage, 'verify-email': verifyPage } });
wireGpops();   // .gpop popovers (Excel ▾ · 컬럼 · 필터) close on an outside click / tap / Esc on every page
onDeviceChange(render);   // rotate / resize across 768px → same page in the other mode, no reload
render();
