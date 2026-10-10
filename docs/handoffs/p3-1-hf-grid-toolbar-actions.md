# P3.1-HF Grid Toolbar Actions

## Base and implementation

- Base: `292833d08f293a01c7d3a51b3fd429c77457b3fd`
- Final implementation commit: `172ba117b69147f9f75a30ffdcb25047fb778ece`
- Branch: `feature/p3-1-hf-grid-toolbar-actions`

## Change

Moved the existing “Thêm dòng” and “Lưu các dòng hợp lệ” buttons into the end of the Direct Entry spreadsheet grid toolbar, after the zoom and status controls. The toolbar remains flex-wrapped for constrained widths; the action group uses `margin-left: auto` to align right when room is available and wraps safely when it is not. Buttons are 35px high with compact horizontal padding and single-line labels.

The grid exposes one optional `toolbarActions` slot. `DirectEntryLive` passes the existing buttons through it without duplicating handlers or changing callbacks, ordering, disabled rules, `aria-busy`, focus behavior, or save/validation logic. Existing status, undo, validation and save-message controls remain in the grid toolbar.

Removed the unused standalone spreadsheet action styles. Existing desktop/mobile Excel and quick-add visibility rules are unchanged. No backend, API, migration, dependency, or business logic changed.

## Files changed

- `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx`
- `src/components/direct-entry/direct-entry-spreadsheet-grid.module.css`
- `src/components/direct-entry/direct-entry-live.tsx`
- `src/components/direct-entry/direct-entry-shell.module.css`
- `src/components/direct-entry/change-request-panel.test.mjs`

## Regression and mutation evidence

- `test:p3-1-hf-change-request-panel`: passed (57 tests), covering unique CTAs, toolbar placement/order, callbacks and disabled/`aria-busy` rules, compact sizing, existing grid status controls, and desktop/mobile Excel and quick-add rules.
- Spreadsheet/zoom/Excel regression tests: passed (53 tests).
- Duplicate CCCD report lane: passed (10 tests).
- Duplicate CCCD submit-confirmation lane: passed (26 tests).
- Mutation checks all failed the focused lane as expected, then restored source byte-identically and reran the focused lane successfully:
  - removed toolbar action rendering;
  - removed `margin-left: auto`;
  - removed the add-row handler;
  - duplicated an add-row CTA test ID;
  - made the Excel CTA visible in the mobile CSS rule.

## Gates

| Gate | Result |
| --- | --- |
| `pnpm test` | PASS |
| `pnpm exec next typegen` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS, 0 errors and 15 warnings |
| `pnpm build` | PASS |
| `pnpm docs:check` | PASS |
| `pnpm secrets:check` | PASS |
| `pnpm db:migrate -- --offline` | PASS, 74 migrations validated |
| `git diff --check` | PASS |

No production query/apply, deployment, browser/Playwright/CUA, or UAT was performed.
