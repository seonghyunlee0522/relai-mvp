# Wide-screen layout (founder 2026-10-21: laptop 1707 CSS px vs 4K monitor 2560 CSS px)

## Step 1 — analysis (measured on c05021a = production CSS, `scripts/e2e-wide-layout.cjs`)

Measured 14 screens × 11 viewports (390 … 2560). Horizontal overflow: 0 everywhere. The main column already starts at the
rail and spans the full remaining width (84e1d03 / fb189b2, 2026-10-15): at 2560 the content uses 2436 of 2484 px. So the
4K problem is **not** a narrow max-width any more; it is that every component *stretches* to fill 2400 px:

| Area | What happens at 2560 | Cause (file:rule) |
|---|---|---|
| Data grids (프로젝트 목록, 요구사항, WBS) | 7–9 columns, extra ~1300 px split across all of them → 150–300 px gaps between short values (ID, 상태, 담당자) | `shared/grid.js` sets each `<col>` to a px width; `.gtable{min-width:100%}` + `table-layout:fixed` spread surplus proportionally |
| Legacy tables (변경·이슈·시험·주간보고) | same spread, auto layout | `.rtable{width:100%}`, every column grows with its max-content |
| Forms (/projects/new, /edit) | 2-column form 1900 px wide; inputs ~920 px, labels far from fields | `.page--form` / `.pform` have no cap since `html:not(.is-phone) .page{max-width:none}` |
| 설정 / AI 크레딧 cards | label + 375 px input on a 1900 px card; buttons pushed to the far right edge | same: `.page--settings` uncapped |
| 대시보드 (지금 할 일, 건강도) | right side column fixed 288 px while the main column grows to 2000 px; KPI tiles 600 px wide holding one number | `.dlayout{grid-template-columns:minmax(0,1fr) 288px}`, `.dkpi repeat(5,1fr)`, `.kpis` |
| Right drawers | 420 / 520 px fixed — at 2560 they take 17–21 % of the screen, fine; at 1280 they leave 700 px for the list | `.rlayout.has-drawer` |
| Page gutters | 24 px at every width | `.shell--ws .page--wide>*{margin:0 24px}` |

Fixed LNB: 76 px icon rail (unchanged by this work).

## Plan (Step 2)
All new rules live in ONE block at the end of app.css behind `@media (min-width:1760px)` — the wide tier. 1707 and below
(laptop, tablet, phone, 125/150 % zoom of the laptop) do not match it, so they render exactly as before.
- A. common: page gutter `clamp(24px, 1.5vw, 40px)`.
- B. lists: the title column takes the surplus; ID/상태/담당자/날짜 keep their designed width (grid: title `<col>` → auto;
  rtable: non-title cells shrink to content).
- C. dashboards: side column grows with the screen `clamp(288px, 16vw, 400px)`.
- D. forms / settings: readable cap (the laptop's own width, 1600 px) — they stop growing past what the laptop shows.
- E. drawers: grow modestly with the screen `clamp(420px, 22vw, 560px)`.

## Result (Step 2–3)
Implemented as planned except: page gutters left at 24px (inside the spec's "일정 범위"); dashboards already used
clamp()/auto-fit. Laptop 1707 and every narrower viewport are pixel-identical apart from data (timestamps). Full report:
hive research/relai-wide-layout-2026-10-21.md.
