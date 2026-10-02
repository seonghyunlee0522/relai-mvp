# Jira Cloud Integration (Phase 12 — Integration Foundation + Jira)

RELAI = Project Delivery Control Layer, Jira = Development Execution Layer. 연결 구조는 **Requirement → WBS → Jira Issue**;
Requirement와 Jira는 직접 연결하지 않고 RequirementWBSLink → WBS → Jira Link로만 간접 조회한다.

## 구조
```
server/integrations/
  config.js      env (ATLASSIAN_*, INTEGRATION_*), scopes, timeouts
  crypto.js      AES-256-GCM 토큰 암호화 (v1.<iv>.<tag>.<ct>), webhook JWT verify (jose: HS256 + exp/nbf), 키 검증
  registry.js    provider 조회 (live | fake)  — tests: setProvider(fake)
  service.js     connection CRUD, OAuth 3LO start/finish, disconnect, ensureAccessToken (FOR UPDATE + rotating refresh), withClient (401→refresh 1회→reconnect_required), withRetry
  events.js      integration_activity (feed), integration_events (idempotency), sync runs
  scheduler.js   runIntegrationJobs(db) — cron 진입점; INTEGRATION_SCHEDULER_INTERVAL_MIN>0 이면 in-process timer
  routes.js      workspace / callback / project / WBS / webhook / admin 라우트
  jira/client.js REST v3 over api.atlassian.com/ex/jira/{cloudId} (search/jql, createmeta/issuetypes, webhook)
  jira/oauth.js  authorize URL, code exchange, refresh, accessible-resources
  jira/provider.js live + fake provider (same interface)
  jira/mapper.js issue JSON → snapshot (statusCategory 기반), browser URL (https + key만)
  jira/adf.js    ADF 생성 (paragraph / bulletList / link / text)
  jira/sync.js   mapping, links, create/search, snapshot sync, execution 집계, auto-complete, webhook 등록/갱신, AI context helper
  jira/webhook.js inbound webhook (JWT + URL secret, idempotent)
scripts/integration-cron.js   외부 스케줄러용 1회 실행
```
Domain(wbs.js / requirements.js / trace.js)은 integrations를 import하지 않는다. 반대로 sync.js가 wbs.updateWbs(자동 완료)와 wbs-history를 사용한다.

## 테이블 (v16, v17)
integration_connections(workspace, provider, status PENDING|ACTIVE|ERROR|DISABLED, cloud_id, site_url, *_token_encrypted, webhook_secret …) UNIQUE(workspace, provider)
integration_oauth_states(state PK, workspace, user, expires_at) · integration_project_mappings(project ↔ Jira project, leaf/group issue type, auto_complete_leaf_wbs, status ACTIVE|REMOVED; partial unique on project_id ACTIVE)
integration_entity_links(wbs_item_id = wbs_items.id, external_entity_id, external_key(표시용), link_role EXECUTION|EPIC, status ACTIVE|MISSING|ERROR|REMOVED; partial unique (connection, external_entity_id) on live)
jira_issue_snapshots(link ↔ summary/issue_type/status_id/status_name/status_category/assignee/external_updated_at/browser_url/synced_at)
integration_events(연결+payload_hash unique) · integration_sync_runs(trigger MANUAL|WEBHOOK|SCHEDULED, status, counts) · integration_webhooks(external_webhook_id, expires_at) · integration_activity(feed)

## 정책
* 연결 대상: **Leaf TASK** (is_group=false, item_type≠MILESTONE). Group은 EPIC role만(선택), 마일스톤은 불가. SUMMARY는 enum이 아니라 is_group으로 판단.
* 1 Jira Issue → 1 WBS (live link partial unique). 이미 연결된 Issue는 검색 결과에 "연결됨 · WBS x.y"로 표시되고 선택 불가.
* 실행률 = Done statusCategory / EXECUTION 링크. Group = 하위 Leaf 합(1 issue → 1 WBS이므로 자연 dedup), Epic 제외. **WBS progress/computed_status와 분리.**
* Auto complete(매핑 옵션, 기본 OFF): Leaf TASK + EXECUTION ≥1 + 전부 Done → updateWbs(COMPLETED/100) + history JIRA_AUTO_COMPLETED(source=jira_sync). Group 미적용.
* WBS archive → 링크 유지, sync 제외(paused 표시). restore → 자동 재개. duplicate → 링크 복사 안 함. promote/indent/outdent/move → id 기반이라 그대로.
* Jira Issue 삭제/접근 불가 → link MISSING(스냅샷 유지, WBS 유지). Connection 해제 → 토큰 삭제, 매핑/링크/이력 보존. 매핑 해제 → REMOVED(이력), sync 중단.

## 인증·보안
* OAuth 2.0 3LO: `https://auth.atlassian.com/authorize` (audience, prompt=consent, state) → `/oauth/token` → `accessible-resources`(cloudId). Scopes 기본: `read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access`.
* state: 서버 생성, workspace+user 바인딩, 10분 만료, 1회 사용. callback은 state의 workspace만 신뢰.
* Refresh: rotating(1회용) — connection row `SELECT … FOR UPDATE` 아래에서 1회만 교환, 새 access/refresh/expiry를 같은 트랜잭션에서 교체. invalid_grant/401 → `reconnect_required`(ERROR), 재시도 루프 없음.
* Retry: 429/5xx/timeout만 최대 2회(Retry-After ≤20s), createIssue는 재시도 안 함.
* Webhook: `POST /api/integrations/jira/webhook/:connectionId/:secret` — URL secret(connection별, 불일치 404) → Authorization Bearer JWT를 `jose.jwtVerify`로 검증(HS256만, exp/nbf 60s 허용오차; Atlassian이 문서화하지 않은 claim은 요구하지 않음, 실패 401, 토큰·헤더 미로그). payload의 issue id/key만 사용하고 실제 데이터는 Jira에서 재조회. 중복은 integration_events로 차단. 등록은 매핑 시 `POST /rest/api/3/webhook`(jqlFilter project=KEY, issue_updated/deleted), 30일 만료 → `PUT /webhook/refresh`, 만료분은 재등록(scheduler).
* 로그/응답/Admin에 토큰·secret·authorization code 없음.
* `INTEGRATION_ENCRYPTION_KEY`: 64 hex 또는 정확히 32바이트로 디코딩되는 base64/base64url만 허용(모든 환경). 다른 값은 `IntegrationConfigError`로 서버 기동 실패. 미설정 시 production은 기동 실패, dev/test는 SESSION_SECRET 파생 키.

## API
* `GET /api/workspaces/:wid/integrations`, `POST …/integrations/jira/connect`(OWNER/ADMIN → {url}), `POST …/jira/disconnect`, `GET /api/integrations/jira/callback`
* `GET/PUT/DELETE …/projects/:pid/integrations/jira[/mapping]`, `GET …/jira/projects?q`, `GET …/jira/issue-types?project_key`, `POST …/jira/sync`, `GET …/jira/issues/search?q`
* `GET …/wbs/:iid/jira`, `POST …/wbs/:iid/jira/issues`, `POST …/wbs/:iid/jira/links {issue_keys[], link_role}`, `DELETE …/wbs/:iid/jira/links/:lid`, `POST …/wbs/:iid/jira/refresh`
* 응답에 포함: `GET /wbs` → `jira {enabled, by}` / `GET /wbs/:id` → `item.jira` / `GET /requirements/:id` → `requirement.jira` / `GET /:pid` → `jira`(홈 요약)
* `GET /api/admin/integrations` (operator)

## 운영 설정 (Atlassian Developer Console)
OAuth 2.0 (3LO) 앱 생성 → Permissions: Jira API `read:jira-work write:jira-work read:jira-user manage:jira-webhook` + `offline_access` → Authorization callback URL = `ATLASSIAN_REDIRECT_URI` → Settings의 Client ID/Secret을 env에. 운영 도메인(APP_BASE_URL)은 https여야 webhook URL이 등록된다. 비공개(개발) 앱은 앱 소유자와 webhook 등록 사용자가 같아야 webhook이 전달된다(Atlassian 제약). 스케줄러: `*/15 * * * * node scripts/integration-cron.js`.
