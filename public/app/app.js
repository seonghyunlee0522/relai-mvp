/* RELAI app entry — wires routes to page modules. All pages are ES modules under /assets/. */
import { registerRoutes, render } from './core/router.js';
import { shell } from './shell.js';
import { authPage } from './auth.js';
import { invitePage } from './invite.js';
import { homePage, projectsPage } from './project/list.js';
import { projectFormPage } from './project/form.js';
import { overviewPage } from './project/overview.js';
import { phasePage } from './project/phase.js';
import { definitionPage } from './project/definition.js';
import { reportPage } from './project/report.js';
import { requirementsPage } from './requirements/page.js';
import { wbsPage } from './wbs/page.js';
import { changesPage } from './changes/page.js';
import { raidPage } from './raid/page.js';
import { testsPage } from './testing/page.js';
import { settingsPage } from './settings.js';
import { adminShell } from './admin/shell.js';
import { adminDashboardPage } from './admin/dashboard.js';
import { adminUsersPage, adminUserPage } from './admin/users.js';
import { adminWorkspacesPage, adminWorkspacePage } from './admin/workspaces.js';
import { adminSubscriptionsPage, adminSubscriptionPage, adminPaymentsPage, adminPaymentPage } from './admin/billing.js';
import { adminUsagePage } from './admin/usage.js';
import { adminAuditPage } from './admin/audit.js';
import { adminIntegrationsPage } from './admin/integrations.js';
import { adminInvitationsPage, adminEmailDeliveriesPage } from './admin/invitations.js';

registerRoutes([
  [/^\/app\/?$/, homePage],
  [/^\/app\/projects\/?$/, projectsPage],
  [/^\/app\/projects\/new\/?$/, projectFormPage],
  [/^\/app\/projects\/([\w-]+)\/?$/, overviewPage],
  [/^\/app\/projects\/([\w-]+)\/edit\/?$/, projectFormPage],
  [/^\/app\/projects\/([\w-]+)\/definition\/?$/, definitionPage],
  [/^\/app\/projects\/([\w-]+)\/phases\/([A-Z_]+)\/?$/, phasePage],
  [/^\/app\/projects\/([\w-]+)\/reports\/([\w-]+)\/?$/, reportPage],
  [/^\/app\/projects\/([\w-]+)\/requirements\/?$/, requirementsPage],
  [/^\/app\/projects\/([\w-]+)\/wbs\/?$/, wbsPage],
  [/^\/app\/projects\/([\w-]+)\/changes\/?$/, changesPage],
  [/^\/app\/projects\/([\w-]+)\/issues\/?$/, raidPage],
  [/^\/app\/projects\/([\w-]+)\/tests\/?$/, testsPage],
  [/^\/app\/settings\/?$/, settingsPage],
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
  [/^\/admin\/invitations\/?$/, adminInvitationsPage],
  [/^\/admin\/email-deliveries\/?$/, adminEmailDeliveriesPage],
  [/^\/admin\/integrations\/?$/, adminIntegrationsPage],
  [/^\/admin\/audit\/?$/, adminAuditPage],
], { shell: (path, view) => (path.startsWith('/admin') ? adminShell(path, view) : shell(path, view)), auth: authPage, invite: invitePage });
render();
