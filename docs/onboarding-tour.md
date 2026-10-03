# Phase 14 — Customer Onboarding, Guided Product Tour & First Project Activation

## Three layers (never confused)
- **First-use onboarding** — welcome dialog + "RELAI 시작하기" checklist (OWNER/ADMIN). Server state `user_onboarding` (per user × workspace, keys `WELCOME`, `PRODUCT_TOUR`, `CHECKLIST`; statuses NOT_STARTED / IN_PROGRESS / COMPLETED / SKIPPED).
- **Product tour** — one-time walkthrough over `[data-tour-id]` targets (`public/app/onboarding/tour.js`). Steps are server config (`TOUR_STEPS` in `server/onboarding.js`, OWNER vs MEMBER). Position is saved on every step; replay from Help keeps history (`meta.replays`).
- **Guided project execution** — product feature, never skippable: `server/guidance.js` computes "지금 해야 할 일 / 왜 / CTA / Next" deterministically from existing stats (phase, definition progress, requirements, WBS, issues, tests, acceptances). Embedded in `GET …/projects/:pid` as `guidance` (also `GET …/:pid/guidance`).

## Eligibility / backfill
- Computed from data on every read (`workspaceFacts`): projects, defined projects (INITIATION steps complete), projects with requirements, projects with leaf WBS.
- A manager whose workspace already has projects gets WELCOME/PRODUCT_TOUR rows created (or upgraded from NOT_STARTED) as `COMPLETED` with `meta.backfilled = true` → no "첫 프로젝트" tour for existing customers. Members never get the owner checklist or create-project/invite steps.
- Checklist auto-completes from data (never un-completes); [숨기기] = SKIPPED.

## Coach marks
`user_feature_guides(user_id, guide_key)`; keys in `GUIDE_KEYS` (REQ_TRACE_INTRO, CHANGE_REQUEST_INTRO, ISSUE_RISK_INTRO, TESTING_INTRO, ACCEPTANCE_INTRO, JIRA_EXECUTION_INTRO, JIRA_OPTIONAL_INTRO, WEEKLY_REPORT_INTRO, AI_INTRO, PHASE_INTRO_*). Dismiss once → hidden; Help › 기능 안내 다시 보기 resets.

## Activation (operator view)
`server/activation.js` — INVITED → SIGNED_UP → WORKSPACE_READY → PROJECT_CREATED → PROJECT_DEFINED → ACTIVATED → ACTIVE (activity within 14 days). Shown in Admin › Workspaces (Activation, Last Active) and workspace detail; owners can read `GET /api/workspaces/:wid/activation`.

## API
- `GET /api/workspaces/:wid/onboarding` (one call: audience, welcome, tour + steps, checklist, guides_seen, activation, support_email)
- `POST /api/workspaces/:wid/onboarding/:key/(start|step|complete|skip|replay)` body `{ step }`
- `POST /api/guides/:guideKey/seen`, `POST /api/guides/reset`
- Analytics (audit `actor_kind = USER`): ONBOARDING_STARTED / SKIPPED / COMPLETED, FIRST_PROJECT_CREATED, FIRST_REQUIREMENT_CREATED, FIRST_WBS_CREATED.

## Tests
`server/test/onboarding-tour.test.js`; Playwright `/tmp/onboard14-flow.cjs` (§58 1–31).
