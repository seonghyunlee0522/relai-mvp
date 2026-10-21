# RELAI — 승인 절차 제거 → "진행 여부 체크" (2026-10-21)

Founder request (verbatim, thread 1792584498.840779): research/relai-no-approval-request-2026-10-21.md
Branch `no-approval` off origin/main c05021a. Worker: worker-relai-no-approval.

## Step 1 — inventory (before)

| # | Screen | Current flow (before) | New check item (after) |
|---|---|---|---|
| 1 | 01 착수 › 착수 결과 승인 drawer (`public/app/project/definition.js` approvalForm, `server/definition.js` APPROVAL) | Form: 승인자* (관계자 선택/직접 입력 → 관계자에 자동 추가) · 승인일* · 승인 방법* · 근거(증빙)* · 조건. 완료 처리 refused until all 4 filled (UI inline errors + server `missingFor('APPROVAL')` + `app.js` 409 approval_required). After 완료: fingerprint → any change to 목표·범위·일정 shows "다시 승인받기 / 다시 승인 완료" (REAPPROVAL). | Checkbox "착수 결과를 고객·스폰서와 공유·확인했나요? (진행 여부 체크)" + optional one-line 메모. Check = step COMPLETED (who/when = completed_by/at). No required fields, no re-approval loop. |
| 2 | 01→02 phase move (`public/app/project/guide.js`, `initiation.js` approvalGateDialog) | Dialog "착수 승인 기록 없이 요구사항 단계로 넘어갑니다" [승인 기록하기 / 승인 없이 진행], writes "[승인 전 진행]" note. | No dialog; phase moves like any other (an unchecked check item is just an open 권장 활동). |
| 3 | 02 요구사항 › 요구사항 확정 승인(고객) drawer (`requirements/page.js` drawApproval, `server/req-baseline.js`) | REQUIRED activity. Same 4-field form; refused without in-scope requirements; 완료 = record + optional 미확정 일괄 확정. | 권장 activity "요구사항 확정 내용을 고객과 확인했나요?" checkbox + 메모; keeps the optional "범위 내 미확정도 함께 확정" toggle; never refused. |
| 4 | 02→03 phase move | Dialog "고객 승인 없이 분석·설계 단계로 넘어가려 합니다" + reason required → "[승인 전 진행] 사유" note. | No dialog. |
| 5 | 04 변경 요청 › 승인 (`changes/page.js`, `server/changes.js`, `app.js` transition) | 승인 only from 검토 중; opens "변경 요청 고객 승인" drawer, 4 fields required (422 customer_approval_required); only OWNER/ADMIN/지정 승인자, never the author (403 self_approval); "내부 처리자(승인자)" field; "승인 기록 추가" afterwards. | 승인(반영 결정) from 작성 중 or 검토 중 by any editor; drawer = checkbox "고객과 협의·확인했나요?" + 메모 (optional). No 422/403. "내부 처리자" field hidden (column kept). |
| 6 | 06 시험 › 검수 › 승인 (`testing/page.js`, `server/testing.js`) | 승인 only from 검수 요청; 4-field customer approval required (422). | 승인 from 작성 중 or 검수 요청; checkbox "고객 검수 확인을 받았나요?" + 메모, optional. |
| 7 | 06 ACCEPTANCE activity completion (`app.js` 409 acceptance_required) | Manual 완료 refused until every in-scope requirement is in an approved 검수. | Manual 완료 allowed (derived ✓ unchanged). |
| 8 | 지금 할 일 / guidance (`server/guidance.js`, `activities.js`) | INIT_APPROVE "착수 결과를 고객에게 승인받으세요", INIT_REAPPROVE, REQ_APPROVE, DEV_CHANGE "고객 결정을 받아 기록하세요", ACC texts "인수 승인을 요청하세요"; warnings "승인 전 진행 사유 기록됨". | Approval steps are no longer next-step gates; wording → "확인했는지 체크". |
| 9 | Charter / 사업수행계획서 export / reports (`charter.js`, `charter-export.js`, `doc-export.js`, `reports.js`) | Show 승인자·승인일·방법·근거 or "미승인 — 사유". | Show "✓ 확인 (이름 · 날짜) · 메모" or "미체크"; legacy records still printed when present. |
| 10 | Step templates (`templates/default-phases.js`) + existing projects | APPROVAL "착수 결과 승인(고객·스폰서)" 권장; BASELINE_APPROVAL "요구사항 확정 승인(고객)" 필수, criteria "승인자·승인일·방법·근거가 기록되어 있습니다." | New titles/criteria "…확인 (체크)"; BASELINE_APPROVAL → 권장. Additive data migration updates rows still holding the seeded text. |
| 11 | Sample guide, onboarding tips, lifecycle tooltips | "고객 승인을 받아 근거(서명본) 남깁니다" | "확인했으면 체크" wording. |

Not approval flows (unchanged): billing "결제 승인" (NicePay), AI "approval commits" (AI 초안 적용 확인), 요구사항 확정(CONFIRMED status), 착수보고회 record, change-guard prompt (already optional: "그냥 저장").
Emails/links to customers: none exist for approvals (grep of server/email/templates.js: only billing/auth mails). Nothing to remove.

## Data mapping
Records stay in the same JSON columns (project_definitions.approval / req_approval, change_requests.customer_approval, acceptances.customer_approval). New keys `checked`, `note`, `checked_by`, `checked_by_name`, `checked_at`; legacy keys kept untouched.
- legacy record with all 4 fields (or step COMPLETED) → checked.
- pending / partial → unchecked, never blocking.

## Before → after per screen (done, branch `no-approval`)

| Screen | Before | After |
|---|---|---|
| 01 착수 › 착수 확인 drawer | 승인자·승인일·승인 방법·근거 필수, 없으면 완료 409; 목표·범위·일정 수정 시 "다시 승인받기" | 체크박스 "착수 결과를 고객·스폰서와 공유·확인했나요?" + 메모(선택). 체크 = 완료, 누가·언제 자동 기록. 재승인 루프 없음 |
| 01→02, 02→03 단계 이동 | "승인 없이 진행" 다이얼로그 + 사유 필수 | 다이얼로그 없음 — 미체크는 열린 권장 활동일 뿐 |
| 02 요구사항 › 요구사항 확정 내용 고객 확인 | 필수 활동, 4필드 필수, 범위 내 요구사항 0건이면 거절 | 권장 활동, 체크 + 메모, "범위 내 미확정도 함께 확정" 토글 유지, 거절 없음 |
| 04 변경 요청 › 승인 | 검토 중에서만, 4필드 필수(422), OWNER/ADMIN/지정 승인자만, 작성자 본인 불가(403) | 작성 중·검토 중에서 편집 권한자 누구나 승인·반려. "고객과 협의·확인했나요?" 체크 + 메모(선택) |
| 06 검수 › 승인 | 검수 요청에서만, 4필드 필수(422); 검수 활동 수동 완료 409 | 작성 중·검수 요청에서 승인. "고객과 검수 결과를 확인했나요?" 체크 + 메모(선택); 수동 완료 허용 |
| 지금 할 일 / 활동 행 | "고객에게 승인받으세요", "승인 전 진행 · 사유 있음" | "…확인했는지 체크하세요" (INIT_CHECK / REQ_CHECK), 체크 안 해도 다음 단계 |
| 사업수행계획서·요구사항 정의서·완료보고서 | 승인자·승인일·방법 또는 "미승인 — 사유", "재승인 필요" 버전 | "✓ 체크됨 (이름 · 날짜) · 메모" 또는 "아직 체크하지 않음"; 완료보고서 검수 줄 "✓ 고객 확인 …" / "고객 확인 미체크" |
| 템플릿 + 기존 프로젝트 | 승인 제목·기준 문구, BASELINE_APPROVAL 필수 | 새 문구, BASELINE_APPROVAL 권장 (migration 69) |

Customer-facing approval request e-mails/links: none existed; nothing to remove.

Local screenshots (no preview opened): hive `research/design/no-approval/` — 01-착수결과-확인, 02-요구사항확정-확인, 04-변경요청-승인, 06-검수-승인 (.png).

## Migration 69 (data only)
- Only `UPDATE`s on `project_steps` / `project_phases` text where the row still holds the exact seeded text, plus `BASELINE_APPROVAL` `REQUIRED → RECOMMENDED`. No DROP / RENAME / type change, no schema change.
- Local run on a copy (3 sample projects rolled back to the pre-69 text, one with a PM-edited title): seeded titles/criteria rewritten, 06 "검수 / 인수 승인" → "검수 / 인수", BASELINE_APPROVAL → 권장, **PM-edited title kept**; rerun gives byte-identical rows (idempotent).
- Previews share the prod DB, so the first boot of a preview runs 69 on prod. Live main code still works on the rewritten rows (text + importance only). One preview request was made at ~21:41 KST before the hold (see god).
- Local boot: `node server/index.js` on a fresh DB → migrates to 69, `GET /api/me` → 401.

## Tests
`TEST_DATABASE_URL=… node --test --test-concurrency=3 "server/test/*.test.js"`: **566 / 568 pass**.
- Failing: `changes.test.js` 'list, search, filters…' (known pre-existing collation order of 김보안); `lifecycle-v3.test.js` 'add-on now' flaked once in the full run, passes 12/12 alone twice.
- Updated tests (approval gates → check): phase1, phase2, phase4, phase6, phase7, polish, activities, guide, onboarding-tour, checklist, v1-func, changes, testing, v1-features.
- Full concurrency (default) on this machine hits "too many clients" on local Postgres — environment, not code.

## Known gaps (not blocking)
- Generic `PATCH …/steps/:id {COMPLETED}` on APPROVAL / BASELINE_APPROVAL marks the step done without stamping who/when in the record; screens read the step status, so display is right.
- An old client sending only the 4 legacy fields (no `checked`) to CR/검수 is saved as unchecked.
