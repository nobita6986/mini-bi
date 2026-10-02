# Library Reuse & Code Reduction Audit — Mini BI

**Revision:** R2 — Final documentation truthfulness fix.
**Auditor:** T1C — Library Reuse & Code Reduction Auditor.
**Base:** `audit/library-reuse @ e3e9e7e` (R1).
**Scope:** Read-only audit. Only file modified: `docs/audits/library-reuse-master.md`.
**Inputs verified against the working tree at `ec2f635`:**

- `git ls-tree -r HEAD -- src/` — actual files in the repo.
- `git show HEAD:package.json` — actual declared dependencies.
- `git branch -a` — spike branch `spike/p1.6-grid-react-data-grid` is on `origin` (P1.6-W01/G1 spike has PASSED).
- React 19 docs, Next.js 16 docs, and published npm pages (versions, peer deps, license) for every candidate.

**Hard guardrails (unchanged from R0/R1):** no runtime changes, no `package.json` / `pnpm-lock.yaml` edits, no schema/RPC migrations, ≤ 5 new dependencies, no modification of `docs/P1.5.md`, `docs/P1.6.md`, `docs/P2.md`, `docs/P3.md`, `docs/master-plan.md`. **R2 additionally enforces:** (a) a single, internally-consistent `CURRENT deletable` total across Executive Summary, stack table, and Acceptance, (b) correct attribution of test infrastructure to the existing `node:test` suites, (c) shadcn-generated wrapper LOC counted into `GENERATED ADDED`.

---

## 1. Executive Summary

### Top 5 code-reduction opportunities

> **R2 invariant.** Three independent cost categories. **They are NEVER summed.**

| # | Opportunity | CURRENT deletable (file:line range) | PLANNED avoided (estimate) | GENERATED ADDED (wrapper / shadcn snippet) |
|---|---|---:|---:|---:|
| 1 | Replace hand-rolled drawer focus-trap `useEffect` in `ai-settings-panel.tsx` and `ai-report-panel.tsx` with **`shadcn/ui` `Dialog` source component, built on `radix-ui` (`Dialog`)** — keep the pure `decideDismiss` / `resolveTabTarget` helpers and the discard state machine in `ai-settings-panel-logic.ts` | **96** (= 63 + 33; see `TOTALS` below) | n/a (current code only) | ~ 30 (Dialog snippet) |
| 2 | Replace `theme-selector.tsx` hand-rolled listbox keyboard code with **`shadcn/ui` `DropdownMenu` source component, built on `radix-ui` (`DropdownMenu`)** | **36** (`theme-selector.tsx:36–71`) | n/a | ~ 25 (DropdownMenu snippet) |
| 3 | Replace the inline `<div role="alertdialog">` JSX in `ai-settings-panel.tsx` with **`shadcn/ui` `AlertDialog` source component, built on `radix-ui` (`AlertDialog`)** | **25** (`ai-settings-panel.tsx:547–571`) | n/a | ~ 25 (AlertDialog snippet) |
| 4 | Adopt **`react-data-grid` 7.0.0-beta.61** for P1.6 13-column grid — spike at `spike/p1.6-grid-react-data-grid` already PASSED at W01/G1 | **0** (grid not yet on `feature/p1.6-integration`) | **ESTIMATE ≥ 1,500** (P1.6 plan + spike result) | ~ 80 (column defs + custom editors) |
| 5 | Adopt **`cmdk` 1.1.1** for Recruiter/Team/Bank typeahead — P1.6-W04, **after a focused typeahead spike passes** | **0** (P1.6-W04 not yet started) | **ESTIMATE ≥ 150** (per P1.6 plan) | ~ 50 (cmdk filter wrapper) |

> **Correction vs R1 (wording only).** The shadcn-style snippets (Dialog, DropdownMenu, AlertDialog, Tooltip, Accordion, ScrollArea, Popover, Sheet sidebar) are **generated source files under our control**, not a runtime install. They are NOT added as `package.json` entries; only the underlying `radix-ui` umbrella is added. Their LOC counts toward `GENERATED ADDED`, never toward `package.json`. We do **not** install `shadcn-ui/cli` as a runtime dependency.

### Single `TOTALS` table — the source of truth

> This table is the only authoritative count for `CURRENT deletable`. Executive Summary, §2 stack, §3 duplicate-code findings, and §6 acceptance **all use these same numbers**. If you find a disagreement elsewhere in this document, this table wins.

| Component | File | Line range (verified via `git show HEAD:`) | Lines |
|---|---|---|---:|
| Settings focus-trap `useEffect` | `src/components/dashboard/ai-settings-panel.tsx` | **310–372** | 63 |
| Report focus-trap `useEffect` | `src/components/ai-report/ai-report-panel.tsx` | **180–212** | 33 |
| Inline discard dialog JSX (`<div role="alertdialog">…</div>`) | `src/components/dashboard/ai-settings-panel.tsx` | **547–571** | 25 |
| Theme selector keyboard code (`useEffect` mousedown + keydown, `focusIndex`, `onListKeyDown`) | `src/components/dashboard/theme-selector.tsx` | **36–71** | 36 |
| Decorative Unicode icon occurrences | `src/components/dashboard/theme-selector.tsx` | **86, 118** (`▾`/`▸`; `✓`) | 2 |
| **CURRENT deletable TOTAL** | — | — | **159** |

> **Cross-reference check.** Executive Summary item 1 (63 + 33 = 96) + item 2 (36) + item 3 (25) + item 5 (2 icons) = **159** lines. Matches the table above. Ranges do not overlap (every range is in a different file, except item 3 which is in `ai-settings-panel.tsx:547–571` — disjoint from item 1's range `310–372`).

### Dependency accounting (per-package, not per-family)

> **Confirmed via `git show HEAD:package.json`** at commit `ec2f635`: project declares **8 runtime dependencies** and **11 devDependencies**. **None** of `lucide-react`, `radix-ui`, `@radix-ui/*`, `cmdk`, `sonner`, `react-data-grid`, `clsx`, `tailwind-merge`, `class-variance-authority` is currently installed.

| Recommended package | Version (verified on npm) | License | Peer | R19 / N16 / RSC compat | Decision |
|---|---|---|---|---|---|
| `radix-ui` (umbrella) | 1.4.3 (https://www.npmjs.com/package/radix-ui, MIT) | MIT | none — bundled | ✓ React 19 compatible; ships primitive wrappers that already use `@radix-ui/react-slot` 1.3.3 | **ADD AT APP-NAV-01** |
| `lucide-react` | 0.474.x (https://lucide.dev) | MIT | none | ✓ R19, tree-shaken named imports | **ADD AT APP-NAV-01** |
| `react-data-grid` | 7.0.0-beta.61 (https://github.com/Comcast/react-data-grid) | MIT | peer `react ^19.2`, `react-dom ^19.2` only — **no Chart.js peer** | ✓ R19, **Client Component only** (uses `useSyncExternalStore`) | **ADD AT P1.6-W04** (gated by P1.6-G3 PASS — spike W01/G1 has passed; W04 is the gated next step) |
| `cmdk` | 1.1.1 (https://cmdk.paco.me) | MIT | peer `react ^18 || ^19`, depends on Radix Dialog | ✓ R19, Client Component only | **CONDITIONAL — only after a focused typeahead spike in P1.6-W04 passes** (must complete in or by early W04, NOT deferred to W05) |
| `sonner` | 2.0.8 | MIT | peer `react ^18 || ^19 || ^19.0.0-rc` | ✓ R19 | **DEFER** (inline `<div role="status">` is sufficient for current spec) |
| `class-variance-authority` | 0.7.x | MIT | none | ✓ | **DO NOT ADD** unless we can prove net code deletion > cva boilerplate. Today no component uses variants. |
| `tailwind-merge` | 2.x | MIT | none | ✓ | **DO NOT ADD** — no class-merging need outside `cmdk` (Radix snippets do not require it). |
| `clsx` | 2.x | MIT | none | ✓ | **DO NOT ADD** — no caller today; 1-line inline `classnames` would do. |
| `@tanstack/react-query` | 5.104.1 | MIT | peer `react ^18 || ^19` | ✓ | **REJECT** — see §4.4 |
| `date-fns` | 4.4.0 | MIT | none | ✓ | **REJECT** — `Intl` covers single timezone + relative format |
| `next-themes` | 0.4.6 | MIT | peer `react ^16.8..19` | ✓ | **REJECT** — wrong primitive for our 5-theme registry |
| `react-hook-form` | 7.89.0 | MIT | none | ✓ | **REJECT** — `useActionState` + Zod cover Server Action forms |
| `react-dropzone` | 14.x | MIT | none | ✓ | **REJECT** — native `<input type="file">` is keyboard-accessible |
| `@mui/*`, `@chakra-ui/*`, `@mantine/*`, **admin templates** | various | various | various | partial | **REJECT** — see §4.4 |

> **Why we prefer the `radix-ui` umbrella over multiple `@radix-ui/*` packages.** The umbrella package exists on npm (https://www.npmjs.com/package/radix-ui) and is recommended in the official Radix UI snippets as of 2025. It bundles the primitives we actually use (Dialog, DropdownMenu, Popover, Tooltip, Accordion, ScrollArea, Label, Checkbox, Separator) and is the recommended path per https://www.radix-ui.com/primitives/docs/overview/getting-started. **Compatibility test is required at APP-NAV-01** — `pnpm install`, `next build`, `tsc --noEmit`, and the existing `pnpm test` suite must all stay green. Fall-back: install individual `@radix-ui/react-*` packages and document the reason in the change set.

> **Why we say `shadcn/ui Sheet` instead of `radix-ui Sheet`.** There is **no `radix-ui` Sheet primitive.** A mobile sheet is built as **shadcn/ui Sheet source component, based on Radix Dialog for the mobile overlay** (https://ui.shadcn.com/docs/components/sheet). shadcn-generated snippets are files we own and check into the repo; their LOC counts toward `GENERATED ADDED` in this audit.

### Net dependency delta if R2 is accepted

| Action | Count |
|---|---|
| Add now (APP-NAV-01) | **2** — `radix-ui`, `lucide-react` |
| Add at P1.6-W04 (conditional) | **2** — `react-data-grid`, `cmdk` (only after focused spike) |
| **Hard cap** | **4** new runtime packages (≤ 5 ceiling; leaves 1 slot for an unforeseen need) |
| Already-installed dependencies retained | 8 |
| Do not add | 9 candidates rejected above |

---

## 2. Inventory Matrix (per file, with line ranges)

> **Source of truth:** `git ls-tree -r HEAD -- src/` on `audit/library-reuse @ ec2f635`. LOC for every referenced range is computed against the actual file at that commit. Planned ranges for P1.6 are **not in this branch** and are listed in a separate column with `ESTIMATE` annotation.

### 2.1 Shared App Shell & Navigation

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| App shell (`APP-NAV-01`) | **PLANNED — no `dashboard-shell.tsx` or `dashboard-mobile-nav.tsx` exists in this branch.** Verified via `git ls-tree`. | **0** (does not exist) | Next.js 16 App Router + `react-dom` portal | **shadcn/ui Sheet/Sidebar, based on Radix Dialog for mobile overlay** | **PLANNED** | 0 | ESTIMATE 200 (avoid vs custom) | ~ 25 (Sheet/Sidebar snippet) | +9 kB gzip (shared with Dialog) | ✓ R19 via `@radix-ui/react-slot`; Sheet must be a Client Component | WAI-ARIA APG Sheet (mobile drawer) | Low |
| Breadcrumb / nav links | Custom anchor rows in `dashboard-view.tsx` (planned; not on this branch) | n/a | `<nav aria-label>` + `<ol>` | shadcn `Breadcrumb` snippet on `radix-ui` Slot | **PLANNED** | 0 | ESTIMATE 30 | ~ 10 | +4 kB | ✓ | ✓ | Low |
| Buttons | **No `src/components/ui/button.tsx` exists** — verified. Inline `inline-flex` styling in `ai-settings-panel.tsx:53–57` | 3 lines (style blocks) | Native `<button>` + Tailwind v4 utilities | none new | **KEEP native** — inline Tailwind is fine; we don't need a `Button` component | 0 | 0 | 0 | 0 | — | — | — |
| Icons | Unicode in `theme-selector.tsx:86` (`▾`/`▸`) and `:118` (`✓`); otherwise verified for no other decorative-icon occurrences | **2** | Inline SVG | `lucide-react` | **REPLACE** (APP-NAV-01) | **2** | 0 | 0 | tree-shaken, ~ 0.5 kB per named import | ✓ R19 | decorative `aria-hidden` | Low |
| Tooltips | none yet | 0 | `title=` | shadcn `Tooltip` snippet on `radix-ui` Tooltip | **DEFER to P1.6-W04** | 0 | 0 | ~ 10 (snippet) | +6 kB | ✓ | Keyboard discoverable | Low |
| Separator | none yet | 0 | `<hr>` | shadcn `Separator` snippet on `radix-ui` Separator | **DEFER** | 0 | 0 | 0 | 0 | — | — | — |

### 2.2 Drawers / Modals / Disclosure (current code on this branch)

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| **AI Settings drawer focus trap** | `src/components/dashboard/ai-settings-panel.tsx:310–372` — `useEffect` with `FOCUSABLE_SELECTOR`, `focusables()`, `onKeyDown`, `onFocusIn`, `document.addEventListener`. Helpers stay in `ai-settings-panel-logic.ts:1–54`. | 725 + 54 = 779 LOC; **focus trap 63 LOC** | `<dialog>` (limited focus-return + cross-portal stacking) | shadcn `Dialog` snippet on `radix-ui` Dialog | **REPLACE the focus-trap `useEffect` only; keep the projection, error code map, and discard-confirm state machine as-is** | **63** (`ai-settings-panel.tsx:310–372`) | n/a | ~ 25 (Dialog snippet) | +9 kB gzip (shared with Sheet) | ✓ Dialog is a Client Component; we keep Server wrappers | WAI-ARIA APG dialog pattern (focus trap, focus return, ESC, inert) — **must verify with browser keyboard test using existing tooling before claim** | Medium — touches P1.5-W05 surface; gate on T1A review |
| **AI Report drawer focus trap** | `src/components/ai-report/ai-report-panel.tsx:180–212` — same pattern. Polling untouched. | 407 LOC; **focus trap 33 LOC** | n/a | shadcn `Dialog` snippet on `radix-ui` Dialog | **REPLACE the focus-trap `useEffect` only**; keep `POLL_INTERVAL_MS = 2000` (controller untouched) | **33** (`ai-report-panel.tsx:180–212`) | n/a | shared Dialog snippet | +9 kB (shared) | ✓ | Same as above | Medium |
| **Inline discard dialog JSX** | `src/components/dashboard/ai-settings-panel.tsx:547–571` — inline `<div role="alertdialog" aria-modal="true" …>` with `Bỏ thay đổi` / `Ở lại` buttons. State machine stays in `ai-settings-panel-logic.ts`. | 25 LOC | `window.confirm()` (NOT keyboard accessible in our scope) | shadcn `AlertDialog` snippet on `radix-ui` AlertDialog | **REPLACE** | **25** (`ai-settings-panel.tsx:547–571`) | n/a | ~ 25 (AlertDialog snippet) | shared | ✓ | `role="alertdialog"` + announce | Low |
| **Theme selector listbox keyboard code** | `src/components/dashboard/theme-selector.tsx:36–71` — `useEffect` mousedown + keydown (Escape), `focusIndex(i)`, `onListKeyDown(e)` ArrowUp/ArrowDown handlers. Theme registry untouched. | 126 LOC file; **keyboard plumbing 36 LOC** | Native `<select>` (limits theme swatches) | shadcn `DropdownMenu` snippet on `radix-ui` DropdownMenu (`menu` + `menuitemradio` semantics, NOT combobox) | **REPLACE** | **36** (`theme-selector.tsx:36–71`) | n/a | ~ 25 | +7 kB (shared Radix Dialog/Tooltip machinery) | ✓ | `menuitemradio` ARIA pattern documented in WAI-ARIA APG — **must verify with browser keyboard test before claim** | Low — theme tokens unchanged |

> **Note on theme-selector semantics.** With `DropdownMenu` the items render as `role="menu"` / `role="menuitemradio"` (per WAI-ARIA APG Menu pattern, https://www.w3.org/WAI/ARIA/apg/patterns/menubar/). This is a **Menu pattern, not a Combobox** — we do not need combobox semantics because the items are static (5 brand themes). If a future need arises for radio-group semantics on the trigger button itself, evaluate `radix-ui` `RadioGroup` (already in the umbrella package) without adding a new dependency.

> **Files that do NOT exist on this branch** (verified via `git ls-tree -r HEAD -- src/`): `dashboard-shell.tsx`, `dashboard-mobile-nav.tsx`, `confirm-discard-dialog.tsx`, `components/ui/button.tsx`, `direct-entry-session-core.ts`. Discard-confirm logic lives inside `ai-settings-panel.tsx` + `ai-settings-panel-logic.ts`, not as a third component file.

### 2.3 Data grid / P1.6 direct entry

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| P1.6 grid (13 cols, 500–20k rows) | **Not on this branch.** Spike already PASSED on `spike/p1.6-grid-react-data-grid` (W01/G1); main `feature/p1.6-integration` does not yet contain the grid. | 0 | planned > 1,500 LOC of custom virtual grid | `react-data-grid` 7.0.0-beta.61 | **ADD AT P1.6-W04** (conditional on P1.6-G3 PASS — spike W01/G1 has passed; W04 implementation is gated by G3) | 0 | **ESTIMATE ≥ 1,500** (P1.6 plan + spike result) | ~ 80 (column defs + custom editors) | **MEASURE_REQUIRED** — bundle delta must be measured against `next build --profile`; cannot quote without measurement | Client Component only (uses `useSyncExternalStore`) — must NOT be imported into RSC | Out-of-box keyboard nav; **must verify IME + keyboard composition** before claim | Medium — beta channel; pin `7.0.0-beta.61` |
| Mobile row-list drawer | **PLANNED — not on this branch.** | 0 | `<dialog>` | shadcn `Sheet` snippet on `radix-ui` Dialog (mobile overlay), same as APP-NAV-01 | **PLANNED** | 0 | ESTIMATE 180 (avoid) | shared snippet | shared | ✓ | Same as APP-NAV-01 | Low |
| Recruiter / team / bank typeahead (P1.6-W04) | **PLANNED.** Not on this branch. | 0 | `<datalist>` (no virtualization) | `cmdk` 1.1.1 (depends on Radix Dialog) | **CONDITIONAL — only after a focused typeahead spike in P1.6-W04 passes** (must complete in or by early W04, NOT deferred to W05) | 0 | ESTIMATE 150 | ~ 50 (cmdk filter wrapper) | +13 kB | ✓ Client Component; **must add after** `radix-ui` umbrella is installed | WAI-ARIA Combobox 1.2 per cmdk docs (https://cmdk.paco.me) — **but app-level keyboard/IME test required** | Medium — gate on focused spike |
| Header action toolbar | Bespoke row of buttons (planned in APP-NAV-01; not yet on this branch) | 0 | n/a | keep | **KEEP native `<button>`** | 0 | 0 | 0 | 0 | — | — | — |

### 2.4 Forms & validation (current code on this branch)

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Form state | **No forms on this branch** (P1.6 form not yet implemented; settings panel uses native `useState`+`fetch`) | 0 | React 19 `useActionState` + `<Form action={...}>` (Next.js 16) | **KEEP native** — `useActionState` + Zod already cover Server Action forms | **KEEP** | 0 | 0 | 0 | 0 | ✓ R19 | ✓ | — |
| `react-hook-form` | n/a | n/a | n/a | 7.89.0 | **REJECT** — adds 13 kB without a single feature gain over `useActionState` + Zod | 0 | 0 | 0 | +13 kB if added | ✓ | ✓ | None |
| Zod schemas | already ubiquitous in `src/lib/contracts/**` and `src/lib/ai-config/**` | n/a | n/a | keep Zod 4.6.5 | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Field arrays | n/a (P1.6 not yet on this branch) | 0 | n/a | n/a | **KEEP native** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Inline error display | inline `<p role="alert">` in `ai-settings-panel.tsx` (server-side error map) | n/a (inline, low LOC) | n/a | n/a | **KEEP native** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

### 2.5 Async mutations / caching / data fetching

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| **AI report polling (durable background job)** | `src/lib/ai-report/report-controller.ts:1–123` — generation tokens, AbortController, scheduler abstraction, capability/history/analysis polling; `src/components/ai-report/ai-report-panel.tsx:24` (`POLL_INTERVAL_MS = 2000`), `:177–178` (`stopPolling`) | **123 LOC** | n/a | **none** — `useTransition` only signals pending UI state; `revalidateTag`/`updateTag` only invalidate cache; neither delivers **durable background job completion notification**. Converting to synchronous Server Actions would violate Vercel timeout / retry / cancellation semantics | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Server Action pending UX | `useFormStatus` (planned for P1.6; not on this branch) | 0 | n/a | n/a | **KEEP native** when P1.6 lands | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Data fetching for dashboard | Server Component `await db` (already used) | n/a | n/a | `@tanstack/react-query` 5.104.1 | **REJECT** — query caching is unnecessary when every page already streams from Server Components | 0 | 0 | 0 | +13 kB if added | ✓ | ✓ | None |
| Mutation cache invalidation | Server Action + `revalidateTag` (planned P1.6; not yet on this branch) | 0 | n/a | n/a | **KEEP** when P1.6 lands | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Optimistic UI for grid edits | planned `useOptimistic` for P1.6-W04 | 0 | n/a | R19 `useOptimistic` | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

> **Correction vs R0 (kept in R2).** `useTransition` and `revalidateTag`/`updateTag` do **not** replace durable-job polling. We do **not** convert durable jobs to synchronous Server Actions because Vercel imposes timeouts, retries, and cancellation semantics that long-running AI jobs would violate. Re-evaluation only when SSE / WebSocket / long-polling contract with reconnect, authorization, and terminal-state tests exists.

### 2.6 Document upload (CCCD + Hợp đồng)

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| File upload (planned P1.6) | **Not on this branch.** | 0 | `<input type="file">` + Server Action `formData` (Next 16 supports streaming Body to Server Action) | **KEEP native** | **KEEP** | 0 | ESTIMATE 60 LOC avoided (no Uppy) | 0 | 0 | ✓ | ✓ keyboard-accessible | — |
| `react-dropzone` / Uppy | n/a | n/a | n/a | 14.x / 4.x | **REJECT** — native `<input type="file">` is sufficient for 1–3 files per row and keyboard-accessible by default | 0 | 0 | 0 | +10 kB / +80 kB if added | ✓ | ✓ | None |

### 2.7 Toasts / Notifications

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Status banners | inline `<div role="status">` blocks in `ai-settings-panel.tsx` and `ai-report-panel.tsx` | a few inline occurrences | n/a | keep | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Toast on mutation | none / inline | 0 | n/a | `sonner` 2.0.8 | **DEFER** — not required by P1.5 or P1.6 spec; inline status is sufficient | 0 | 0 | 0 | +4 kB if added | ✓ | polite live region | Low |

### 2.8 Theming

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| 5-theme token engine | `src/lib/theme/theme-registry.ts:1–289` — HSL/RGB math, palette derivation for 5 themes; `src/lib/theme/theme-provider.tsx:1–99` — `useTheme` + inline `<head>` script | 388 LOC total | Tailwind v4 `@theme` directive | `next-themes` 0.4.6 | **KEEP** (custom registry is required for chart palette + 0-flash head script; `next-themes` is for **light/dark/system** only) | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Theme selector UI | see §2.2 `theme-selector.tsx` | 126 LOC file | see §2.2 | shadcn `DropdownMenu` snippet on `radix-ui` DropdownMenu | **REPLACE** (per §2.2) | 36 | 0 | ~ 25 | +7 kB | ✓ | same as §2.2 | Low — theme tokens unchanged |

> **`next-themes` is REJECTED** because it does the wrong job. `next-themes` toggles between `data-theme="light"` and `data-theme="dark"` using localStorage + flash-free inline script. Our `theme-registry.ts` is a **brand theme engine** that computes derived chart palette tokens for 5 brand themes (`hr-partner`, `executive-gold`, `emerald-growth`, `ocean-trust`, `violet-future`).

### 2.9 Date / timezone handling

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Single timezone (`Asia/Ho_Chi_Minh`) formatting | `src/lib/format.ts:1–44` using `Intl.DateTimeFormat` | 44 LOC | n/a | `date-fns` 4.4.0 | **KEEP native** — Intl is sufficient; we need only one timezone and one relative-distance helper | 0 | ESTIMATE 30 LOC avoided (no `date-fns` import) | 0 | 0 | ✓ | ✓ | None |
| Relative dates ("vừa xong", "3 phút trước") | none yet on this branch | 0 | `Intl.RelativeTimeFormat` (built-in) | n/a | **KEEP native** when needed | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

### 2.10 Validation / projection

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Server-side validation | Zod 4.6 in `src/lib/contracts/**` and `src/lib/ai-config/**` | n/a | n/a | keep Zod | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Client form validation | reuses Zod via Server Action `useActionState` errors (planned P1.6) | 0 | n/a | keep | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Review projection (P1.5-W05) | `src/lib/ai-report/review-projection.ts:1–95` | 95 LOC | n/a | keep | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

### 2.11 Tables / list rendering (outside P1.6 grid)

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Dashboard tables (≤ 200 rows) | Recharts + native `<table>` (e.g. `src/components/dashboard/source-status-table.tsx`) | n/a | n/a | keep | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Scroll area inside modals | Native `<div overflow>` | n/a | n/a | shadcn `ScrollArea` snippet on `radix-ui` ScrollArea | **DEFER** — only if a future drawer truly needs it | 0 | 0 | 0 | +5 kB if added | ✓ | ✓ | None |

### 2.12 Accordion / Disclosure

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Accordion / collapsible diff rows (P1.6 W05 review notes) | **PLANNED — not on this branch.** | 0 | `<details>`/`<summary>` | shadcn `Accordion` snippet on `radix-ui` Accordion | **DEFER to P1.6-W04** (NOT to W05; cmdk typeahead must be in or by early W04) | 0 | ESTIMATE 40 (if `<details>` instead) | 0 | +6 kB if added | ✓ | WAI-ARIA Disclosure pattern | Low |
| Inline disclosure | `<details>` (zero deps) | 0 | n/a | n/a | **KEEP** (used for "show raw toggle") | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

---

## 3. Duplicate-code findings

### 3.1 Focus traps (current state)

- **`src/components/dashboard/ai-settings-panel.tsx:310–372`** — hand-rolled `useEffect` with `FOCUSABLE_SELECTOR`, `focusables()` helper, Tab/Shift+Tab handler, `onFocusIn` catch, `aria-hidden`/`[inert]` filtering. **63 lines.**
- **`src/components/ai-report/ai-report-panel.tsx:180–212`** — similar focus-trap `useEffect`. **33 lines.**

> **R2 correction.** R0/R1 estimated "~ 60 + ~ 50 = ~ 110 LOC of similar code, of which ~ 100 LOC is deletable". Verified exact ranges now: **63 + 33 = 96 LOC** of focus-trap `useEffect` (both entirely deletable once Radix Dialog is in place). The pure decision helpers (`confirmInitialFocusIndex`, `decideDismiss`, `resolveTabTarget`) in `src/components/dashboard/ai-settings-panel-logic.ts:1–54` **must stay** — they implement the discard-confirm state machine that Radix does not provide.

### 3.2 Drawer / modal backdrop & scroll lock

- **There is no separate backdrop / scroll-lock implementation** beyond what the two focus-trap effects include. No `useStableScrollLock` helper exists. R0's claim that "`dashboard-shell.tsx` + `ai-settings-panel.tsx` both implement a `useStableScrollLock` of their own" was **wrong** — `dashboard-shell.tsx` does not exist. **R1 corrected this; R2 keeps the correction.**

### 3.3 Form helpers

- The codebase already centralises validation in Zod (`src/lib/contracts/**`, `src/lib/ai-config/**`). **No duplicate form helpers.** No `useFieldArray`.

### 3.4 Polling / cache

- `src/lib/ai-report/report-controller.ts:1–123` is the only polling loop. It exists because the AI generation is durable (long-running, cancelable, retryable). **KEEP.** Re-evaluation only when SSE / WebSocket / long-polling contract lands.
- `src/components/ai-report/ai-report-panel.tsx:177–178` (`stopPolling`) is the only panel-level coupling to polling. KEEP.

### 3.5 Table / list rendering

- Two implementations: Recharts `Bar`/`Line` (chart) + native `<table>` (`src/components/dashboard/source-status-table.tsx`). Both correctly use Server Components. **Zero duplication.**

### 3.6 Date / timezone

- `src/lib/format.ts:1–44` is the only date helper. Confirmed via `git grep` that no other inline `new Date()` formatting exists. **Zero duplication.**

### 3.7 Validation / projection

- Zod schemas in `src/lib/contracts/**` and `src/lib/ai-config/**`. Each contract has its own schema; no overlap. **Zero duplication.**

---

## 4. Recommended minimal stack

### 4.1 Already installed (no action — confirmed via `git show HEAD:package.json`)

| Package | Version (declared) | Purpose |
|---|---|---|
| `@supabase/supabase-js` | ^2.117.2 | DB client |
| `next` | 16.3.8 | framework |
| `nuqs` | ^2.10.1 | URL filter state |
| `react` | 19.2.8 | runtime |
| `react-dom` | 19.2.8 | runtime |
| `recharts` | ^3.10.1 | dashboard charts |
| `server-only` | ^0.0.1 | RSC boundary guard |
| `zod` | ^4.6.5 | validation |

### 4.2 Add now (APP-NAV-01) — 2 packages, hard ceiling ≤ 5

| Package | Why | Files affected | CURRENT deletable |
|---|---|---|---|
| `radix-ui` (umbrella, 1.4.3, MIT) | Provides Dialog, DropdownMenu, AlertDialog, Popover, Tooltip, Accordion, ScrollArea, Label, Checkbox, Separator primitives for our shadcn-generated wrappers | `theme-selector.tsx:36–71`, AI drawers focus-trap `useEffect` (per §2.2), inline discard JSX | **159** LOC total per the `TOTALS` table in §1 |
| `lucide-react` (0.474.x, MIT, 0 deps) | icons | `theme-selector.tsx:86,118` decorative arrows | **2** occurrences (counted in the 159 total) |

> **Conditional compatibility test:** `radix-ui` umbrella must pass `pnpm install`, `pnpm tsc --noEmit`, `pnpm build`, and the existing `pnpm test` suite before merge. If the umbrella build is incompatible with Next.js 16.3.8 / React 19.2.8, **fall back to individual `@radix-ui/react-*` packages** and document the reason in the change set.

### 4.3 Add only for P1.6-W04 (conditional, gated) — 0–2 packages

| Package | Why | Gate |
|---|---|---|
| `react-data-grid` 7.0.0-beta.61 | P1.6 13-column grid | **P1.6-G3 PASS.** Spike W01/G1 already passed on `spike/p1.6-grid-react-data-grid`. W04 is the gated implementation step. Pin `7.0.0-beta.61`; measure bundle via `next build --profile` before merge |
| `cmdk` 1.1.1 | P1.6 Recruiter/Team/Bank typeahead | **Focused typeahead spike passes in or by early W04.** W05 review notes are out of scope for `cmdk`; cmdk must complete in or by early W04, NOT deferred to W05. Only added if spike shows custom ≥ 150 LOC is unavoidable |

> These do not consume the ≤ 5 budget **unless** both are added — they are gated spikes, not promised adds.

### 4.4 Do NOT add

| Candidate | Why we are not adding it |
|---|---|
| **MUI / Ant Design / Chakra / Mantine** | Own theming + styling runtime conflicts with `theme-registry.ts` and Recharts theming. ≥ 100 kB gzip. |
| **Refine / AdminJS / shadcn-admin** | Kills RSC boundaries. Own routing. ≥ 30 transitive deps. |
| **Zustand / Jotai / Redux Toolkit** | React 19 `useActionState`, `useTransition`, `useOptimistic` already cover every need. |
| **`tailwindcss-animate`** | Tailwind v4 + View Transitions / CSS keyframes sufficient. |
| **Uppy** | 80 kB gzip; we upload 1–3 files per row. |
| **`react-hook-form`** | Server Actions + Zod + `useActionState` already cover form state, errors, pending UI. |
| **`@tanstack/react-query`** | We never fetch the same data twice in the dashboard. Polling is durable-job-specific (KEEP). |
| **`@tanstack/react-table`** | We chose `react-data-grid`. |
| **`date-fns`** | One timezone + relative distance — both built-in to `Intl`. |
| **`next-themes`** | Wrong primitive; our theme engine is brand-themed, not light/dark. |
| **`react-dropzone`** | Native `<input type="file">` is keyboard-accessible. |
| **`sonner`** | Inline `<div role="status">` is sufficient for the current spec. Defer until a real toast-shaped need appears. |
| **`clsx` / `tailwind-merge` / `class-variance-authority`** | **No caller today.** A 1-line inline `classnames` helper covers what we have. We will NOT adopt them just because shadcn convention says so. Add only with evidence of ≥ 20 LOC deletion per library. |
| **`jsdom` / `axe-core` / Playwright / Vitest** | **Not added by this audit.** Browser keyboard / focus acceptance MUST be done with **existing tooling only** (the `node:test` suite + manual browser verification during T1A / T1B change-set review). Any new test dependency is a separate change request, raised only if existing tooling proves insufficient. |

---

## 5. Migration order (minimal, no double-migration)

> **Ordering rule.** Each step is a **small isolated commit / change set** (not a PR — the project uses direct branch commits; "PR" wording is reserved for the upstream GitHub merge flow, not the local branch workflow). No step migrates native dialog → Radix twice. Each step gates on the previous T1A / T1B work.

### Step 0 — Branch hygiene (done)

- Worktree `audit/library-reuse` at `e3e9e7e` (R1). No code changes outside `docs/audits/library-reuse-master.md`.

### Step 1 — APP-NAV-01 (T1B, after dashboard-view lands)

- Install **`radix-ui`** + **`lucide-react`** in one change set. Verify `pnpm build`, `tsc --noEmit`, existing `pnpm test`.
- Add **shadcn-generated wrappers** for: `Dialog` (mobile Sheet/Sidebar overlay), `DropdownMenu` (theme selector), `Breadcrumb`, `Button` (only if used in the new shell). Each wrapper is a generated source file under our control.
- Replace `theme-selector.tsx:36–71` (the focus-trap + keyboard plumbing) with `DropdownMenu` (semantics: `menu` + `menuitemradio`, NOT combobox). Theme registry unchanged.
- **Reversibility**: revert by restoring the keyboard plumbing from git history.

### Step 2 — Existing AI drawers (T1A, after P1.5-W05/G5 closes)

- Migrate `ai-settings-panel.tsx:310–372` and `ai-report-panel.tsx:180–212` (focus-trap `useEffect`) to shadcn `Dialog` (built on `radix-ui` `Dialog`). **Keep** `ai-settings-panel-logic.ts` (`confirmInitialFocusIndex`, `decideDismiss`, `resolveTabTarget`) — Radix does not give us the discard-confirm state machine.
- Replace the inline `<div role="alertdialog">…</div>` JSX at `ai-settings-panel.tsx:547–571` with shadcn `AlertDialog` (built on `radix-ui` `AlertDialog`). The state machine stays in `ai-settings-panel-logic.ts`.
- **Source-string tests stay.** Update `ai-settings-panel.test.mjs` / `ai-report-panel.test.mjs` to keep their existing source-contract checks against the migrated source (e.g. `role="dialog"`, `aria-modal="true"`, `inert` / `aria-hidden` on background, `Escape` handler). Do NOT add `jsdom` or `axe-core`.
- **Browser keyboard / focus acceptance is mandatory.** Re-run manual Tab / Shift+Tab / Escape verification on `/dashboard/ai-settings` and the AI report drawer using **existing tooling only** (a real browser, the project's existing `node:test` suite, and the team's normal review process). If existing tooling proves insufficient, raise a **separate change request** for a new test dependency.
- **Reversibility**: each drawer focus effect is independently restorable.

### Step 3 — Polling: NO CHANGE (T1A — KEEP)

- `src/lib/ai-report/report-controller.ts:1–123` **stays as-is**. No step replaces polling. See §2.5 for why `useTransition` / `revalidateTag` / `updateTag` cannot replace durable-job polling, and why converting to a synchronous Server Action would violate Vercel timeout/retry/cancellation semantics.
- Revisit only when an SSE / WebSocket / long-polling contract with reconnect, authorization, and terminal-state tests exists.

### Step 4 — P1.6 grid (T1B, P1.6-W04, conditional)

- Spike `spike/p1.6-grid-react-data-grid` already PASSED at W01/G1 (verified via `git branch -a`).
- Add `react-data-grid@7.0.0-beta.61` to `BI-p1.6-integration` only. Pin version. Use the spike as template.
- W04 is **gated by P1.6-G3** (not "G3 spike" — gate name is G3; the spike is W01/G1). Implementation only begins after G3 PASS.
- **Measure bundle via `next build --profile`** before merge; report MEASURE_REQUIRED result in the change-set description. Do not claim a number we have not measured.
- **Reversibility**: `pnpm remove react-data-grid`.

### Step 5 — P1.6 typeahead (T1B, P1.6-W04, conditional)

- Add `cmdk@1.1.1` **only after** a **focused typeahead spike** passes. The spike must complete **in or by early P1.6-W04** — it must NOT be deferred to W05 (W05 is reserved for review notes / Accordion work, not typeahead).
- **Reversibility**: replace with native `<select>` / `<datalist>`.

### Step ordering rules

1. **Do not start Step 2 until T1A's P1.5-W05/G5 lands on `main`.**
2. **Do not start Step 4 / 5 until T1B's P1.6-G3 lands on `feature/p1.6-integration`** (W04 is gated by G3).
3. **No big-bang change set.** Each step is a single change set, ≤ 400 LOC diff.
4. **After every step**, run `pnpm build`, `tsc --noEmit`, and the existing `pnpm test` suite.
5. **Source-string tests survive migration.** For Radix migration, keep the source-contract assertions (role, aria-modal, inert, escape handler) updated to the migrated source. Do NOT swap kit for jsdom / axe-core / Vitest.

---

## 6. Acceptance criteria

### 6.1 Code reduction — measurable (uses the §1 `TOTALS` table as source of truth)

| Metric | Today | Target after Step 1+2 | Target after Step 4+5 (if added) | How to verify |
|---|---:|---:|---:|---|
| **CURRENT deletable LOC** | n/a | **159** (= 63 + 33 + 25 + 36 + 2 per §1 `TOTALS`) | unchanged | `git diff main..audit/library-reuse --stat` shows net deletion |
| PLANNED avoided | n/a | 0 | **≥ 1,650** (= ≥ 1,500 grid + ≥ 150 typeahead) | `wc -l` on new P1.6 components in `BI-p1.6-integration` after merge |
| GENERATED ADDED (wrapper / shadcn snippet) | n/a | ~ 75 (Dialog + DropdownMenu + AlertDialog snippets) | + ~ 130 (grid column defs + custom editors + cmdk filter wrapper) | grep new snippet files |

> **R2 invariant.** `CURRENT deletable = 159` appears identically in §1 Executive Summary, the §1 `TOTALS` table, the §4 stack row, §3 duplicate-code findings, and this §6 acceptance table. No other number is permitted in this audit.

### 6.2 No regression in behavior / accessibility / security

- **Behavior**: every drawer's `aria-label`, header, and submit semantics remain identical. Existing `src/components/dashboard/ai-settings-panel.test.mjs` and `src/components/ai-report/ai-report-panel.test.mjs` source-string tests must still pass after the assertions are updated to match migrated source (e.g. `role="dialog"`, `aria-modal="true"`, `inert`, `Escape` handler).
- **Accessibility**: every migrated component **must** be verified against **WAI-ARIA APG dialog / menu patterns** via the official docs (https://www.w3.org/WAI/ARIA/apg/, https://www.radix-ui.com/primitives). **VoiceOver / NVDA / IME testing is NOT claimed in this audit.** Browser keyboard / focus acceptance MUST be performed manually with **existing tooling only** during the T1A / T1B change-set review. **If existing tooling cannot meet the request**, the team raises a separate change request for a new test dependency.
- **Security**: no change. Server-side validation remains in Zod; Server Actions remain `use server`. No new client trust boundary.

### 6.3 Bundle size

- After Step 1: `radix-ui` umbrella + `lucide-react` add **MEASURE_REQUIRED** — actual delta must come from `next build --profile` after a real install. Quoted estimates from earlier revisions are withdrawn.
- After Step 4 (if added): `react-data-grid` is route-loaded via `next/dynamic`. Bundle delta **MEASURE_REQUIRED** — quoted "≈ 80 kB" in earlier revisions is withdrawn until measured.

### 6.4 Test infrastructure — what we have and what we don't (truthful)

> **Source of truth:** `git show HEAD:package.json` `scripts.test` and `git ls-tree -r HEAD -- src` for `.test.mjs`. The project ships **only Node `node:test` suites** (`.test.mjs`). There is **no `axe-core`, `jsdom`, `Vitest`, or `Playwright` declared anywhere**. R0's claim that "axe-core is already integrated in P1.5 testing flow" is **wrong** and was corrected in R1; R2 keeps the correction.

#### 6.4.1 (a) Node pure / behavioral tests — we have these

| Test file | Subject | Style |
|---|---|---|
| `src/components/dashboard/ai-settings-panel-logic.test.mjs` | `decideDismiss`, `resolveTabTarget`, `confirmInitialFocusIndex` | imports `.ts`, calls functions, asserts results |
| `src/lib/ai-report/report-controller.test.mjs` | `createReportController` flow (capability → submit → poll active → draft → analysis/lifecycle/history; malformed draft; generation cancellation) | imports `.ts`, asserts state transitions |
| `src/lib/ai-report/report-contract.test.mjs` | `report-contract` projections | pure |
| `src/lib/ai-report/review-projection.test.mjs` | `review-projection` | pure |
| `src/components/ai-report/ai-report-view.test.mjs` | `report-view` rendering projection | pure |
| `src/lib/theme/theme-registry.test.mjs` | `theme-registry` token math | pure |
| `src/components/dashboard/dashboard-brand.test.mjs` | dashboard brand tokens | pure |
| `src/lib/auth/pilot-access.test.mjs` | `pilot-access` | pure |
| `src/lib/reporting/p1-*.test.mjs` (multiple) | reporting layer | pure |
| `src/lib/ai-config/*.test.mjs`, `src/lib/ai/gateway/*.test.mjs`, `src/lib/analytics/**/*.test.mjs` | server boundary | pure

#### 6.4.2 (b) Node source-string / structure tests — we have these

| Test file | Subject | Style |
|---|---|---|
| `src/components/dashboard/ai-settings-panel.test.mjs` | `ai-settings-panel.tsx` source | `readFileSync`, `source.includes(...)` — checks `"use client"`, no `server-only`, no `from "@/lib/"`, presence of `role="dialog"`, `aria-modal="true"`, `aria-labelledby="ai-settings-title"`, `Escape` / `keydown` handler, discard-confirm dialog attributes, etc. |
| `src/components/ai-report/ai-report-panel.test.mjs` | `ai-report-panel.tsx` source (and `report-controller.ts` source for boundary checks) | `readFileSync`, `source.includes(...)` and `!/from\s+["']@\/lib\/ai\//.test(source)` style — checks client/server boundary, no `localStorage` / `console.log`, no API key / Bearer / `NEXT_PUBLIC_` strings |

> **R2 source-string tests survive Radix migration.** For the migrated panels, keep the source-contract assertions updated to the new pieces of source (e.g. `role="dialog"`, `aria-modal="true"`, `inert`, `Escape` handler, no `server-only`/`@/lib/ai-*`). The migration **does not delete** the source-string test infrastructure.

#### 6.4.3 (c) Browser / manual evidence — outside the repo, when needed

| Source | Status | Use |
|---|---|---|
| VoiceOver / NVDA screen reader verification | **NOT performed by this audit.** Not claimed. | Verify per migrated component before merge, using existing reviewer browser, no new dependency |
| Keyboard / focus acceptance (Tab / Escape / Arrow / IME composition) | **NOT performed by this audit.** Not claimed. | Same as above. **If existing tooling proves insufficient**, raise a separate change request for a new test dependency. |
| Manual reproduction notes from `docs/acceptance/w05r1-*.png` | exists in repo | Acceptance baseline for P1.5-W05 R1 |

### 6.5 Server Component boundaries — must not be lost

- shadcn-generated wrappers (`Dialog`, `DropdownMenu`, `AlertDialog`, `Tooltip`, `Command`, `Sheet`, etc.) are all Client Components. They **must not** be imported into RSC trees.
- The Server Component layers above them (page, layout, server-fetched data) **must remain Server Components**.
- `react-data-grid` is a Client Component. We do not attempt to use it on the server.
- RSC boundary preservation is verified by `next build` output (server/client split) and by `tsc --noEmit`.

### 6.6 Hard guardrails (unchanged)

- **No `package.json` / `pnpm-lock.yaml` changes outside §4.2 + §4.3 packages.**
- **No DB / RPC / schema migration.**
- **No removal of author ownership from T1A / T1B.** Each agent owns their phase gate.
- **No big-bang change set.** Each step ≤ 400 LOC diff, single change set per step.
- **No "MEASURE_REQUIRED" value may be quoted as a number without measurement.** Bundle delta, focus-return latency, IME composition cost: all must come from a real `next build --profile` run on a real install.
- **No new test dependency added by this audit** (`jsdom`, `axe-core`, Playwright, Vitest are explicitly excluded from this audit's scope; if T1A/T1B find existing tooling insufficient, they raise a separate change request).

---

## Appendix A — Source-of-truth docs (verified, 2026-10)

- React 19 docs — `useActionState`, `useTransition`, `useOptimistic`, `useId`: https://react.dev/reference/react.
- Next.js 16 docs — App Router, Server Actions, `revalidateTag`, `updateTag`, cache tags, View Transitions: https://nextjs.org/docs (v16.3.x).
- WAI-ARIA Authoring Practices Guide (APG) — dialog, menu, listbox, combobox patterns: https://www.w3.org/WAI/ARIA/apg/.
- Radix UI Primitives (umbrella + individual) — https://www.radix-ui.com/primitives (verified Dialog 1.1.23, DropdownMenu 2.x, Slot 1.3.3 current as of 2026-08).
- `radix-ui` umbrella package on npm — https://www.npmjs.com/package/radix-ui (1.4.3, MIT).
- shadcn/ui — https://ui.shadcn.com (CLI copy-paste snippets, **each snippet is a generated source file under our control, not a runtime install**). Sheet docs: https://ui.shadcn.com/docs/components/sheet ("built on top of the Radix UI Dialog primitive").
- cmdk — https://cmdk.paco.me (1.1.1, MIT).
- sonner — https://sonner.emilkowal.ski (2.0.8, MIT). **Not added.**
- react-data-grid — https://github.com/Comcast/react-data-grid (7.0.0-beta.61, MIT, peer `react ^19.2`, `react-dom ^19.2` — **no Chart.js peer**).
- lucide-react — https://lucide.dev (0.474.x, MIT, 0 deps).
- next-themes — https://github.com/pacocoursey/next-themes (0.4.6, MIT). **Rejected.**
- date-fns — https://date-fns.org (4.4.0, MIT). **Rejected.**
- React Hook Form — https://react-hook-form.com (7.89.0, MIT). **Rejected.**
- TanStack Query — https://tanstack.com/query (5.104.1, MIT). **Rejected.**
- react-dropzone — https://react-dropzone.js.org. **Rejected.**

## Appendix B — Rejected candidates with rationale

| Candidate | Why we are not adding it |
|---|---|
| **MUI / Ant Design / Chakra / Mantine** | Ships its own theming + styling runtime. Conflicts with `theme-registry.ts` token engine. ≥ 100 kB gzip. |
| **Refine / AdminJS / shadcn-admin** | Kills Server Component boundaries. Own routing. ≥ 30 transitive deps. |
| **Zustand / Jotai / Redux Toolkit** | React 19 `useActionState`, `useTransition`, `useOptimistic` cover every need. |
| **`tailwindcss-animate`** | Tailwind v4 + View Transitions sufficient. |
| **Uppy** | 80 kB gzip; we upload 1–3 files per row. Native `<input type="file">` is keyboard-accessible. |
| **`react-hook-form`** | Server Actions + Zod + `useActionState` already cover form state, error reporting, pending UI. |
| **`@tanstack/react-query`** | We never fetch the same data twice in the dashboard. |
| **`@tanstack/react-table`** | We chose `react-data-grid`. |
| **`date-fns`** | Only need one timezone (`Asia/Ho_Chi_Minh`) and relative distance — both built-in to `Intl`. |
| **`next-themes`** | Wrong primitive. Our `theme-registry.ts` is brand-themed, not light/dark/system. |
| **`react-dropzone`** | Native `<input type="file">` is sufficient. |
| **`sonner`** | Inline `<div role="status">` is sufficient for current spec. Defer. |
| **`clsx` / `tailwind-merge` / `class-variance-authority`** | No caller today. Add only with evidence of ≥ 20 LOC deletion per library. |
| **`jsdom` / `axe-core` / Playwright / Vitest`** | Not added by this audit. Browser acceptance uses existing tooling only; a separate change request is raised if existing tooling proves insufficient. |

## Appendix C — Decisions deferred (not now)

| Decision | Why deferred | When to revisit |
|---|---|---|
| Drop `react-data-grid` beta pinning | Wait for `7.0.0` GA |
| Replace durable-job polling | Only after SSE / WebSocket / long-polling contract with reconnect, authorization, terminal-state tests |
| Adopt shadcn `Tooltip` / `Accordion` / `ScrollArea` snippets | Only when P1.6 review notes UI is shaped (W04, not W05 for cmdk) |
| Add `sonner` | Only if a real toast-shaped need appears beyond inline status |
| Add a separate test dependency (`jsdom` / `axe-core` / Playwright) | Only if existing tooling proves insufficient for browser keyboard / focus acceptance |

## Appendix D — Migration checklist (per-step, single change set each)

- [ ] **Step 1 — APP-NAV-01**: install `radix-ui` + `lucide-react`; verify `pnpm build`, `tsc --noEmit`, `pnpm test`. Replace `theme-selector.tsx:36–71` with shadcn `DropdownMenu` snippet (semantics: `menu` + `menuitemradio`, NOT combobox). Re-run `theme-registry.test.mjs`. Update source-string tests if the import shape changes.
- [ ] **Step 2 — Existing AI drawers (T1A, post-P1.5-W05/G5)**: migrate `ai-settings-panel.tsx:310–372` and `ai-report-panel.tsx:180–212` focus-trap `useEffect` to shadcn `Dialog`. Replace inline confirm-discard `<div role="alertdialog">…</div>` at `ai-settings-panel.tsx:547–571` with shadcn `AlertDialog`. **Keep** `ai-settings-panel-logic.ts`. **Keep** source-string tests, updated to migrated source (role, aria-modal, inert, Escape). **Browser keyboard / focus acceptance** on `/dashboard/ai-settings` and AI report drawer with existing tooling only.
- [ ] **Step 3 — Polling**: **no change.** Confirm `report-controller.ts:1–123` unchanged.
- [ ] **Step 4 — P1.6 grid (T1B, P1.6-W04, conditional on P1.6-G3 PASS)**: add `react-data-grid@7.0.0-beta.61`. Spike W01/G1 already passed on `spike/p1.6-grid-react-data-grid`. Use spike as template. Measure bundle via `next build --profile`. Re-run `pnpm test`.
- [ ] **Step 5 — P1.6 typeahead (T1B, P1.6-W04, conditional)**: only after focused typeahead spike PASS in or by early W04 (NOT deferred to W05). Add `cmdk@1.1.1`. Measure bundle.

## Appendix E — Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `react-data-grid` 7.0.0-beta breaks in production | Low–Med | Pin to `7.0.0-beta.61`; have CSS-grid fallback ready in spike branch; measure bundle before merge. |
| `radix-ui` umbrella incompatible with Next.js 16.3.8 / React 19.2.8 | Low | **Conditional compatibility test** at install time (`pnpm build`, `tsc --noEmit`, `pnpm test`). Fall back to individual `@radix-ui/react-*` packages and document why in the change set. |
| `cmdk` collision with Tailwind v4 | Low | Pin to 1.1.1; isolate via shadcn `Command` snippet. |
| Radix Dialog portal + sticky header z-index | Med | Re-use the P1.5-W05 modal stacking CSS variables. |
| Lucide tree-shaking on Next.js 16 Turbopack | Low | Use named imports (`import { ChevronDown } from "lucide-react"`). |
| Polling misclassification | Low | Polling controller is **KEEP**; `useTransition` and `revalidateTag` do not replace durable background jobs. |
| Bundle-size claim before measurement | Med | **Every bundle claim must come from a real `next build --profile` run on a real install.** Quoted numbers are MEASURE_REQUIRED until then. |
| Screen-reader access we never tested | Med | Do not claim VoiceOver/NVDA pass until it has been run. Source-string tests + pure tests stay; browser keyboard/focus acceptance via existing tooling. Raise a separate change request if existing tooling proves insufficient. |
| LOC total disagreement between sections | Low | Single `TOTALS` table in §1 is authoritative. R2 enforces that all sections use **159** as the CURRENT deletable total. |

---

**End of R2 audit.**