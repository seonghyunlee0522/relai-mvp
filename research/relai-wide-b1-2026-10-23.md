# RELAI wide-b1 — the detail panel fills the width on wide screens (2026-10-23, Jim)

Branch `wide-b1` (from origin/main 1dd810e), pushed to origin, not merged, not deployed. CSS only: no markup, JS, behaviour or migration change.

## 1. Cause
The founder's screenshot (`research/relai-wbs-right-gap-2026-10-23.png`) is a 1710 px wide Chrome window at 67 % zoom, which is a
**~2560 CSS px viewport**. With a row selected, the B1 rule (`app.css`, `@media (min-width:1280px)`) lays the page out as
`grid-template-columns: minmax(0,max-content) var(--panel-w-eff); justify-content:start`. That makes the list column only as wide
as its table, and on WBS the title column is pinned at 220 px (`release-r2r3` rule). Whatever is left over stays empty to the
right of the panel. Inside the WBS panel, `.dlayout` keeps `align-items:start` from its old two-column layout, so the title,
description and owner fields shrink to their content (369 / 505 px). In the requirement, change, issue and test panels,
`.dgrid .dfield` selects are capped at `max-width:280px`.

## 2. Fix (`public/app/app.css`, the WIDE SCREENS block = `@media (min-width:1760px)`, desktop only)
```css
/* F. list takes what the panel leaves; panel fields use the panel width */
.rlayout.has-drawer:has(>.drawer--lg|--side:not([hidden])){grid-template-columns:minmax(0,1fr) var(--panel-w-eff)}
… .gtable col{width:calc(var(--cw) * 1.15)}               /* other columns ≈ designed width (round 2) */
… .gtable col.gcol--grow{width:auto}                       /* title column absorbs the surplus */
… .gtable--wbs{width:100%!important}  … col[data-col="title"]{width:auto!important}
.drawer--lg .dlayout{align-items:stretch}
.drawer--lg .dgrid .dfield :is(.select,.input){max-width:none}
```
(each selector is prefixed `html:not(.is-phone)`). I removed one older wide-tier line that held the title column at 1.6× its width
while the panel is open, because it conflicted with the fix. The panel width is unchanged: `clamp(480px, 34vw, 960px)` = 653 px
at 1920 and 870 px at 2560. A width the user sets by dragging still applies.

## 3. Measured on relai.kr (QA account, read only; the local CSS is swapped in for "after")
The numbers are the right edges of the list and of the panel, in CSS px. The content area ends at viewport − 24.

| page @ width | before: list / panel right | after: list / panel right | empty right of panel: before → after |
|---|---|---|---|
| WBS @2560 | 1407 / 2293 | 1650 / 2536 | 243 → 0 |
| 요구사항 @2560 | 1343 / 2230 | 1650 / 2536 | 306 → 0 |
| 변경 @2560 | 751 / 1637 | 1650 / 2536 | 899 → 0 |
| 이슈 @2560 | 564 / 1450 | 1650 / 2536 | 1086 → 0 |
| 시험 @2560 | 575 / 1461 | 1650 / 2536 | 1075 → 0 |
| WBS @1920 | 1227 / 1896 | 1227 / 1896 | 0 → 0 (already filled) |
| 변경·이슈·시험 @1920 | 751·564·575 / 1419·1233·1244 | 1227 / 1896 | 477·663·652 → 0 |

Panel fields at 2560 (WBS title, description, owner): 369 / 369 / 250 px before, 832 / 832 / 413 px after. The requirement panel's
범위 · 우선순위 · 담당자: 280 → 728 px. No sideways scroll at any width.

**Laptop widths (<1760 px) are unchanged.** I pixel-compared all 5 pages at 1440 and 1707 against a control run that serves the
unchanged CSS through the same route. 8 of the 10 shots are identical. The other 2 differ by 9 antialiased pixels on the bottom
2 rows, and two runs of the unchanged CSS show the same noise.

## 3b. Round 2 (god / founder 2026-10-23: titles still truncated with the panel open)
In round 1, the non-title columns kept the wide-screen 1.6× width while the panel was open (889 px together at 1920), so the WBS
작업 column got 198 px ('요...', '착수 보고회 ...'). Now, with the panel open, these columns are 1.15 × their designed width. At
1.0×, the 진행률 column clipped "100%". The title column takes the rest:

| WBS, panel open | 작업 (title) | 번호 · 기간 · 진행률 · 담당자 · 상태 |
|---|---|---|
| 1920 before → after | 198 → **448 px** | 112·208·179·224·166 → 81·150·129·161·120 |
| 2560 before → after | 620 → **870 px** | same as above |

All WBS titles in the QA project now show in full at 1920 (the longest is '데이터 이관 프로그램 개발·리허설 1차'). 요구사항 uses the
same rule; its 제목 column is about 510 px at 1920. I re-shot every `after-*` screenshot. The laptop check (1440 / 1707 against
a control run) found nothing new: 8 of 10 shots are identical, and 변경 differs by 13 to 53 pixels, which also varies between
unchanged runs (three runs of the unchanged CSS at 1707 matched "after" exactly). The test suite gives the same result:
566 / 568, with the same 2 server-side failures.

## 4. Screenshots — `research/design/wide-b1/`
Files are named `before|after-<wbs|requirements|changes|issues|tests>-<1440|1707|1920|2560>.png`, 39 files in all. Reproduce with
`PW=… node scripts/e2e-wide-b1.cjs <before|after|control> 1440,1920,2560 wbs,requirements,changes,issues,tests`.

## 5. Tests
`TEST_DATABASE_URL=…/relai_b1 npm test -- --test-concurrency=3`: 568 tests, **566 pass, 2 fail**. Both failures are server
tests:
- `changes.test.js:144`: a Korean name sort order (`김보안` vs `A사…`). The local DB collation is en_US.UTF-8.
- `lifecycle-v3.test.js:126`: add-on proration (`2 !== 1`). This looks date-dependent.

This branch changes no server code (`git diff origin/main` = app.css, the measuring script and research files only), so the two
failures come from main or this machine, not from this fix.

## 6. Left as is (outside the brief)
- Below 1760 px (laptop), the change, issue and test panels still leave about 180 px empty on the right at 1440. This is the same B1 rule. I didn't change it because the brief says laptop widths must look identical. The founder
  should decide whether to apply F there too.
- With the panel open on a very wide screen, WBS shows a wide gap between the title and 기간 / 진행률. The title column takes the
  whole surplus, as it does on lists without a panel.
