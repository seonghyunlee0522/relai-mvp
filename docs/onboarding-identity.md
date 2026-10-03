# Phase 13 — Customer Onboarding, Identity & Invitation Foundation

## Architecture
- RELAI DB is the source of truth: `users`, `user_identities`, `sessions`, `workspaces`, `workspace_members`, `invitations`, `auth_oauth_states`, `email_deliveries`.
- `users.password_hash` is nullable (Google-only accounts). Every login method is a `user_identities` row (`PASSWORD` subject = user id, `GOOGLE` subject = Google `sub`; unique(provider, provider_subject)).
- Shared account primitives (`server/accounts.js`): `createUser`, `createWorkspaceForOwner` (workspace + OWNER + AI credit account), `createDirectSignupUser`.
- Invitations (`server/invitations.js`): `WORKSPACE_CREATE` (platform invite, SYSTEM_ADMIN → new customer) vs `WORKSPACE_MEMBER` (OWNER/ADMIN → teammate). Acceptance runs in a transaction with `SELECT … FOR UPDATE`; double accept / duplicate membership / duplicate workspace are impossible under concurrency.
- Google OIDC (`server/auth/google.js`): authorization code + PKCE S256, state/nonce hashed in `auth_oauth_states` (separate from Jira integration state), ID token verified with `jose` against Google JWKS (iss, aud, exp, nonce). No Google tokens are stored. `GOOGLE_PROVIDER=fake` enables a local consent page for dev/E2E.
- E-mail (`server/email/`): provider abstraction (`fake` | `resend`), templates, `email_deliveries` log (status/error only — never HTML, tokens, secrets). Links are built from `APP_BASE_URL` only.
- Routes: `server/auth/routes.js` (`/api/auth/providers`, `/api/auth/google/start|callback`, `/api/invitations/:token[/accept]`, `/api/workspaces/:wid/invitations…`, admin `/api/admin/invitations…`, `/api/admin/email-deliveries`).

## Flows
- Direct signup: unchanged (user + personal workspace + OWNER + AI account).
- Platform invite: Admin Console [고객 초대] → mail → `/invite/:token` → [이메일로 가입] (`/signup?invite=`; server validates token + exact e-mail; user created and invite accepted atomically, **no personal workspace**) or [Google로 계속하기] / [이미 계정이 있습니다] → login → back to `/invite/:token` → explicit [초대 수락].
- Member invite: Settings › 멤버 › [멤버 초대] (OWNER → MEMBER/ADMIN, ADMIN → MEMBER) → same landing; accept adds membership with the invited role, never creates a workspace.
- Google login: existing GOOGLE identity → login; else verified e-mail exactly matching an existing user → auto-link (audit `GOOGLE_IDENTITY_LINKED`); else new user (personal workspace unless INVITE intent).
- Suspended user: password login, Google login and invite acceptance blocked. Suspended workspace: member invites cannot be created/resent/accepted.

## Audit
`admin_audit_logs.actor_kind` = `ADMIN` (operator actions, default view) | `USER` (signup/accept/member-invite events). Admin Audit page shows `ADMIN` by default (`?actor_kind=USER|all`).

## ENV
`APP_BASE_URL`, `EMAIL_PROVIDER=fake|resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `SUPPORT_EMAIL`, `INVITE_EXPIRY_DAYS=7`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_PROVIDER=fake` (dev only). Production requires https `APP_BASE_URL` and `RESEND_API_KEY` when `EMAIL_PROVIDER=resend`.

## Tests
`server/test/onboarding.test.js` (auth regression, platform/member invitations, concurrency, Google, e-mail, admin). Playwright flow: `/tmp/onboard-flow.cjs` (needs `EMAIL_PROVIDER=fake GOOGLE_PROVIDER=fake`; reads the fake outbox via dev-only `/api/_dev/email-outbox`).
