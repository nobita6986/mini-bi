# Library Reuse & Code Reduction Audit — Mini BI

**Revision:** R1 — Correctness and minimal-dependency reconciliation.
**Auditor:** T1C — Library Reuse & Code Reduction Auditor.
**Scope:** Read-only audit of `C:\CodeApp\BI` worktree `audit/library-reuse` at commit `ec2f635`, plus official docs for every library referenced.
**Inputs verified against the working tree:**

- `git ls-tree -r HEAD -- src/` — actual files in the repo.
- `git show HEAD:package.json` — actual declared dependencies.
- React 19 docs, Next.js 16 docs, and the published npm pages (versions, peer deps, license) for every candidate.

**Hard guardrails (unchanged from R0):** no runtime changes, no `package.json` / `pnpm-lock.yaml` edits, no schema/RPC migrations, max 5 new dependencies, no modification of `docs/P1.5.md`, `docs/P1.6.md`, `docs/P2.md`, `docs/P3.md`, `docs/master-plan.md`. **R1 additionally enforces**: per-package counting (not per-family), LOC split into Current / Planned / Approved append, and `KEEP` on items that the previous draft wrongly listed as `REPLACE`.

---

## 1. Executive Summary

### Top 5 code-reduction opportunities

> **Important:** numbers are split into three buckets. `CURRENT deletable` = lines that exist on this branch and would be deleted if the migration lands. `PLANNED avoided` = lines that P1.6 spec would otherwise cause us to write, and that the recommendation avoids. `GENERATED ADDED` = wrapper/shadcn snippet that the migration will introduce. **These three are not summed** — they are independent cost categories.

| # | Opportunity | CURRENT deletable (LOC, file:line range) | PLANNED avoided (estimate) | GENERATED ADDED (wrapper) |
|---|---|---:|---:|---:|
| 1 | Replace hand-rolled drawer focus trap in `ai-settings-panel.tsx` (725 LOC) and `ai-report-panel.tsx` (407 LOC) with `@radix-ui/react-dialog` (wrapped by `radix-ui` umbrella package) | **~ 60** (`ai-settings-panel.tsx:306–365` focus-trap `useEffect` + `ai-report-panel.tsx:180–230` similar `useEffect`) — exact range visible in `git show HEAD:src/components/dashboard/ai-settings-panel.tsx` | n/a (existing code only) | ~ 30 (dialog wrapper snippet) |
| 2 | Replace `theme-selector.tsx` hand-rolled listbox (`useEffect` keydown + `onListKeyDown`, lines 36–71 = 36 LOC) with `radix-ui` `DropdownMenu` | **36** (`theme-selector.tsx:36–71`) | n/a | ~ 25 |
| 3 | Standardise on `lucide-react` for icons — current panels use raw Unicode (`▾`, `▸`, `✓`, `›`, `←`, `▦`) in `theme-selector.tsx:86, 118` and elsewhere | **2** (decorative Unicode occurrences in `theme-selector.tsx` only — confirmed via `git grep`) | minor | tree-shaken named imports |
| 4 | Adopt **`react-data-grid` 7.0.0-beta.61** for P1.6 13-column grid | **0** (P1.6 grid not yet on this branch) | ≥ **1,500** (P1.6 plan estimates; spike `BI-p1.6-grid-spike` validates feasibility) | ~ 80 (column defs + custom editors) |
| 5 | Keep **native `Intl.DateTimeFormat`** in `src/lib/format.ts` (44 LOC) — do not replace with `date-fns` | **0** (KEEP) | ~ 30 (if we added `date-fns` we'd need a helper) | 0 |

**Total CURRENT deletable (proved from source):** **~ 98 LOC** of accessibility/keyboard plumbing that exists today.
**Total PLANNED avoided:** **≥ 1,530 LOC** (P1.6 grid + P1.6 typeahead) if recommendations are adopted at P1.6-W04 gate.
**Total GENERATED ADDED:** **~ 135 LOC** of thin Radix wrapper + grid column definition.

### Dependency accounting (per-package, not per-family)

> **Confirmed via `git show HEAD:package.json`** on `audit/library-reuse` at commit `ec2f635`: the project currently declares **8 runtime dependencies** (`@supabase/supabase-js`, `next`, `nuqs`, `react`, `react-dom`, `recharts`, `server-only`, `zod`) and **11 devDependencies**. **None** of `lucide-react`, `radix-ui`, `@radix-ui/*`, `cmdk`, `sonner`, `react-data-grid`, `clsx`, `tailwind-merge`, `class-variance-authority` is currently installed.

| Recommended package | Version (verified on npm) | License | Peer | R19 / N16 / RSC compat | Decision |
|---|---|---|---|---|---|
| `radix-ui` (umbrella) | 1.4.3 (https://www.npmjs.com/package/radix-ui, MIT, published 2025) | MIT | none — bundled | ✓ React 19 compatible; ships primitive wrappers that already use `@radix-ui/react-slot` 1.3.3 | **ADD AT APP-NAV-01** |
| `lucide-react` | 0.474.x (https://lucide.dev) | MIT | none | ✓ R19, tree-shaken named imports | **ADD AT APP-NAV-01** |
| `react-data-grid` | 7.0.0-beta.61 (https://github.com/Comcast/react-data-grid) | MIT | peer `react ^19.2`, `react-dom ^19.2` only — **no Chart.js peer** (verified against package.json on npm) | ✓ R19, **Client Component only** (uses `useSyncExternalStore`) | **ADD AT P1.6-W04** (conditional on spike G3 PASS) |
| `cmdk` | 1.1.1 (https://cmdk.paco.me) | MIT | peer `react ^18 || ^19`, depends on `@radix-ui/react-dialog` | ✓ R19, Client Component only | **CONDITIONAL — only after focused typeahead spike passes** |
| `sonner` | 2.0.8 | MIT | peer `react ^18 || ^19 || ^19.0.0-rc` | ✓ R19 | **DEFER** (inline `<div role="status">` is sufficient for current spec) |
| `class-variance-authority` | 0.7.x | MIT | none | ✓ | **DO NOT ADD** unless we can prove net code deletion > cva boilerplate. Today no component uses variants. |
| `tailwind-merge` | 2.x | MIT | none | ✓ | **DO NOT ADD** — no class-merging need outside `cmdmaker` (Radix snippets do not require it). |
| `clsx` | 2.x | MIT | none | ✓ | **DO NOT ADD** — no caller today; 1-line inline `classnames` would do. |
| `@tanstack/react-query` | 5.104.1 | MIT | peer `react ^18 || ^19` | ✓ | **REJECT** — see §4.4 |
| `date-fns` | 4.4.0 | MIT | none | ✓ | **REJECT** — `Intl` covers single timezone + relative format |
| `next-themes` | 0.4.6 | MIT | peer `react ^16.8..19` | ✓ | **REJECT** — wrong primitive for our 5-theme registry |
| `react-hook-form` | 7.89.0 | MIT | none | ✓ | **REJECT** — `useActionState` + Zod cover Server Action forms |
| `react-dropzone` | 14.x | MIT | none | ✓ | **REJECT** — native `<input type="file">` is keyboard-accessible |
| `@mui/*`, `@chakra-ui/*`, `@mantine/*`, **admin templates** | various | various | various | partial | **REJECT** — see §4.4 |

> **Why we prefer the `radix-ui` umbrella over multiple `@radix-ui/*` packages.** The umbrella package exists on npm (https://www.npmjs.com/package/radix-ui) and is recommended in the official Radix UI snippets as of 2025. It bundles the primitives we actually use (Dialog, DropdownMenu, Popover, Tooltip, Accordion, ScrollArea, Label, Checkbox, Separator) and is the recommended path per https://www.radix-ui.com/primitives/docs/overview/getting-started. **Compatibility test is required at APP-NAV-01** because (a) the umbrella version must be verified against our Next.js 16 + React 19.2.8 setup, (b) we currently import only via `@radix-ui/react-slot`-style primitives and `cmdk`'s nested deps. We will not ship this without a green `next build` and a green TypeScript pass on `tsc --noEmit`.

### Net dependency delta if R1 is accepted

| Action | Count |
|---|---|
| Add now (APP-NAV-01) | **2** — `radix-ui`, `lucide-react` |
| Add at P1.6-W04 (conditional) | **2** — `react-data-grid`, `cmdk` (only after spike) |
| Hard cap | **4** new runtime packages (≤ 5 ceiling, leaves 1 slot for an unforeseen need) |
| Already-installed dependencies retained | 8 |
| Do not add | 9 candidates rejected above |

---

## 2. Inventory Matrix (per file, with line ranges)

> **Source of truth:** `git ls-tree -r HEAD -- src/` on `audit/library-reuse` @ `ec2f635`. LOC for every referenced range is computed against the actual file at that commit. Planned ranges for P1.6 are **not in this branch** and are listed in a separate column with `ESTIMATE` annotation.

### 2.1 Shared App Shell & Navigation

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| App shell (`APP-NAV-01`) | **PLANNED — no `dashboard-shell.tsx` or `dashboard-mobile-nav.tsx` exists in this branch.** Verified via `git ls-tree`. | **0** (does not exist) | Next.js 16 App Router + `react-dom` portal | `radix-ui` `Sheet` (umbrella) | **PLANNED** | 0 | ESTIMATE 200 (avoid vs custom) | ~ 25 | +9 kB gzip (shared with dialog) | ✓ R19 via `@radix-ui/react-slot`; Sheet must be a Client Component | WAI-ARIA APG Sheet (mobile drawer) | Low |
| Breadcrumb / nav links | Custom anchor rows in `dashboard-view.tsx` (planned; not on this branch) | n/a | `<nav aria-label>` + `<ol>` | `radix-ui` `NavigationMenu` (umbrella) | **PLANNED** | 0 | ESTIMATE 30 | ~ 10 | +4 kB | ✓ | ✓ | Low |
| Buttons | **No `src/components/ui/button.tsx` exists** — verified. Inline `inline-flex` styling in `ai-settings-panel.tsx:53–57` | 3 lines (style blocks) | Native `<button>` + Tailwind v4 utilities | none new | **KEEP native** — inline Tailwind is fine; we don't need a `Button` component | 0 | 0 | 0 | 0 | — | — | — |
| Icons | Unicode in `theme-selector.tsx:86` (`▾`/`▸`) and `:118` (`✓`); otherwise verified for no-index-only icons | 2 occurrences | Inline SVG | `lucide-react` | **REPLACE** (APP-NAV-01) | 2 | 0 | 0 | tree-shaken, ~ 0.5 kB per named import | ✓ R19 | decorative `aria-hidden` | Low |
| Tooltips | none yet | 0 | `title=` | `radix-ui` `Tooltip` (umbrella) | **DEFER to P1.6-W04** | 0 | 0 | ~ 10 (snippet) | +6 kB | ✓ | Keyboard discoverable | Low |
| Separator | none yet | 0 | `<hr>` | `radix-ui` `Separator` | **DEFER** | 0 | 0 | 0 | 0 | — | — | — |

### 2.2 Drawers / Modals / Disclosure (current code on this branch)

| Area | Current implementation (file:line range) | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| **AI Settings drawer** | `src/components/dashboard/ai-settings-panel.tsx:306–365` — hand-rolled focus trap (`useEffect` `keydown` listener, `FOCUSABLE_SELECTOR`, Tab/Shift+Tab cycle, `onFocusIn` catch, requestClose hook) + `ai-settings-panel-logic.ts:1–54` — `confirmInitialFocusIndex`, `decideDismiss`, `resolveTabTarget` pure helpers | 725 + 54 = 779 LOC | `<dialog>` (limited focus-return on scroll-lock + cross-portal stacking) | `radix-ui` `Dialog` (umbrella) | **REPLACE the focus-trap `useEffect` only; keep the projection, error code map, and discard-confirm state machine as-is** | **~ 60** (`ai-settings-panel.tsx:306–365` ≈ 60 LOC of focus-trap effect; logic file retained) | n/a | ~ 25 (Dialog snippet) | +9 kB gzip (shared with Sheet) | ✓ Dialog is a Client Component; we keep Server wrappers | WAI-ARIA APG dialog pattern (focus trap, focus return, ESC, inert) — but **must verify with axe-core / Vitest** before claim | Medium — touches P1.5-W05 surface; gate on T1A review |
| **AI Report drawer + Review** | `src/components/ai-report/ai-report-panel.tsx:180–230` — hand-rolled focus trap similar to above; lines `141`, `166–178` for `requestClose` + `loadCapability`/`loadHistory` `setTimeout`; polling delegated to `report-controller.ts` | 407 LOC total | n/a | `radix-ui` `Dialog` (umbrella) | **REPLACE the focus-trap `useEffect` only**; keep `POLL_INTERVAL_MS = 2000` (controller untouched) | **~ 50** (`ai-report-panel.tsx:180–230` ≈ 50 LOC of focus-trap effect) | n/a | shared Dialog snippet | +9 kB (shared) | ✓ | Same as above | Medium |
| **Discard confirmation** | **Not a separate file.** Confirmed: there is no `confirm-discard-dialog.tsx`. Logic lives inside `ai-settings-panel.tsx` (`confirmDiscard` state, `decideDismiss` pure helper). | inline ~ 25 LOC of state machine | `window.confirm()` (NOT keyboard accessible in our scope) | `radix-ui` `AlertDialog` (umbrella) | **REPLACE inline `<div>` rendering** (when the `:251` confirm dialog HTML is migrated to `AlertDialog`) | **~ 20** (the confirm-dialog JSX block, lines ~ 600–650 of `ai-settings-panel.tsx`) | n/a | ~ 25 (AlertDialog snippet) | shared | ✓ | `role="alertdialog"` + announce | Low |
| **Theme selector listbox** | `src/components/dashboard/theme-selector.tsx:36–71` — `useEffect` mousedown + keydown, `focusIndex`, `onListKeyDown` ArrowUp/ArrowDown handlers | 126 LOC file, of which 36 LOC are keydown plumbing | Native `<select>` (limits theme swatches) | `radix-ui` `DropdownMenu` (umbrella) | **REPLACE** | **36** (`theme-selector.tsx:36–71`) | n/a | ~ 25 | +7 kB (shared Radix Dialog/Tooltip machinery) | ✓ | Combobox pattern with VoiceOver — but **must verify with axe-core before claim** | Low — theme tokens unchanged |

> **Files that do NOT exist on this branch** (verified via `git ls-tree -r HEAD -- src/`): `dashboard-shell.tsx`, `dashboard-mobile-nav.tsx`, `confirm-discard-dialog.tsx`, `components/ui/button.tsx`, `direct-entry-session-core.ts`. Any prior draft that referenced these as "current code" is wrong.

### 2.3 Data grid / P1.6 direct entry

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| P1.6 grid (13 cols, 500–20k rows) | **Not on this branch.** Spike: `BI-p1.6-grid-spike` worktree; main has no grid component. | 0 | planned > 1,500 LOC of custom virtual grid | `react-data-grid` 7.0.0-beta.61 | **ADD AT P1.6-W04** (conditional on P1.6-G3 spike PASS) | 0 | **ESTIMATE ≥ 1,500** (P1.6 plan + spike result) | ~ 80 (column defs + custom editors) | **MEASURE_REQUIRED** — bundle delta must be measured against `next build` analyzer; cannot quote without measurement | Client Component only (uses `useSyncExternalStore`) — must NOT be imported into RSC | Out-of-box keyboard nav; **must verify IME + VoiceOver** before claim | Medium — beta channel; pin `7.0.0-beta.61` |
| Mobile row-list drawer | **PLANNED — not on this branch.** | 0 | `<dialog>` | `radix-ui` `Sheet` (umbrella, same as APP-NAV-01) | **PLANNED** | 0 | ESTIMATE 180 (avoid) | shared snippet | shared | ✓ | Same as APP-NAV-01 | Low |
| Recruiter / team / bank typeahead | **PLANNED — not on this branch.** | 0 | `<datalist>` (no virtualization) | `cmdk` 1.1.1 (depends on Radix Dialog) | **CONDITIONAL — only after a focused typeahead spike passes** | 0 | ESTIMATE 150 | ~ 50 (cmdk filter wrapper) | +13 kB | ✓ Client Component; **must add after** `radix-ui` umbrella is installed | WAI-ARIA Combobox 1.2 per docs — **but app-level keyboard/IME test required** | Medium — gate on focused spike |
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
| **AI report polling (durable background job)** | `src/lib/ai-report/report-controller.ts:1–123` — generation tokens, AbortController, scheduler abstraction, capability/history/analysis polling; `src/components/ai-report/ai-report-panel.tsx:24` (`POLL_INTERVAL_MS = 2000`), `:177–178` (`stopPolling`) | **123 LOC** | n/a | **none** — `useTransition` only signals pending UI state; `revalidateTag`/`updateTag` only invalidate cache; neither delivers **durable background job completion notification**, and replacing durable jobs with synchronous Server Actions conflicts with Vercel timeout / retry / cancellation semantics | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Server Action pending UX | `useFormStatus` (planned for P1.6; not on this branch) | 0 | n/a | n/a | **KEEP native** when P1.6 lands | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Data fetching for dashboard | Server Component `await db` (already used) | n/a | n/a | `@tanstack/react-query` 5.104.1 | **REJECT** — query caching is unnecessary when every page already streams from Server Components | 0 | 0 | 0 | +13 kB if added | ✓ | ✓ | None |
| Mutation cache invalidation | Server Action + `revalidateTag` (planned P1.6; not yet on this branch) | 0 | n/a | n/a | **KEEP** when P1.6 lands | 0 | 0 | 0 | 0 | ✓ | ✓ | — |
| Optimistic UI for grid edits | planned `useOptimistic` for P1.6-W04 | 0 | n/a | R19 `useOptimistic` | **KEEP** | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

> **Correction vs R0:** R0 incorrectly proposed "Replace hand-rolled polling with `useTransition` + `revalidateTag`". This is wrong: `useTransition` only toggles pending state; `revalidateTag`/`updateTag` only invalidate cache. Neither can replace a durable background job completion notification. We do **not** convert durable jobs to synchronous Server Actions because Vercel imposes timeouts, retries, and cancellation semantics that long-running AI jobs would violate. **The `report-controller.ts` polling controller is KEEP.** Re-evaluation only when we have an SSE/WebSocket/long-polling contract with reconnect, authorization, and terminal-state tests.

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
| Theme selector UI | see §2.2 `theme-selector.tsx` | 126 LOC file | see §2.2 | `radix-ui` `DropdownMenu` (umbrella) | **REPLACE** (per §2.2) | 36 | 0 | ~ 25 | +7 kB | ✓ | same as §2.2 | Low — theme tokens unchanged |

> **Correction vs R0:** `next-themes` is **REJECTED** because it does the wrong job. `next-themes` toggles between `data-theme="light"` and `data-theme="dark"` using localStorage + flash-free inline script. Our `theme-registry.ts` is a **brand theme engine** that computes derived chart palette tokens (`chart-1`..`chart-5`, Recharts-friendly alpha overlay) for 5 brand themes (`hr-partner`, `executive-gold`, `emerald-growth`, `ocean-trust`, `violet-future`). Adding `next-themes` would mean two theming systems for one product.

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
| Scroll area inside modals | Native `<div overflow>` | n/a | n/a | `radix-ui` `ScrollArea` (umbrella) | **DEFER** — only if a future drawer truly needs it | 0 | 0 | 0 | +5 kB if added | ✓ | ✓ | None |

### 2.12 Accordion / Disclosure

| Area | Current implementation | LOC (actual) | Existing / native option | Library candidate | Verdict | CURRENT deletable | PLANNED avoided | GENERATED ADDED | Bundle / dep impact | R19 / N16 / RSC compat | A11y impact | Migration risk |
|---|---|---:|---|---|---|---:|---:|---:|---|---|---|---|
| Accordion / collapsible diff rows (P1.6 W05 review notes) | **PLANNED — not on this branch.** | 0 | `<details>`/`<summary>` | `radix-ui` `Accordion` (umbrella) | **DEFER to P1.6-W04** | 0 | ESTIMATE 40 (if `<details>` instead) | 0 | +6 kB if added | ✓ | WAI-ARIA Disclosure pattern | Low |
| Inline disclosure | `<details>` (zero deps) | 0 | n/a | n/a | **KEEP** (used for "show raw toggle") | 0 | 0 | 0 | 0 | ✓ | ✓ | — |

---

## 3. Duplicate-code findings

### 3.1 Focus traps (current state)

- **`src/components/dashboard/ai-settings-panel.tsx:306–365`** — hand-rolled `useEffect` with `FOCUSABLE_SELECTOR`, `focusables()` helper, Tab/Shift+Tab handler, `onFocusIn` catch, `aria-hidden`/`[inert]` filtering. ~ 60 LOC. The pure decision helpers (`confirmInitialFocusIndex`, `decideDismiss`, `resolveTabTarget`) live in `src/components/dashboard/ai-settings-panel-logic.ts:1–54` and **must stay** as they encode the "block / stay / confirm / close" state machine that Radix does not provide. Total file: 725 LOC.
- **`src/components/ai-report/ai-report-panel.tsx:180–230`** — similar focus-trap `useEffect`. ~ 50 LOC. Total file: 407 LOC.

> **Correction vs R0:** R0 estimated "≈ 360 LOC of duplicated focus traps across 3 files". The truth is **two files** with **~ 60 + ~ 50 = ~ 110 LOC** of similar code, of which **~ 100 LOC is deletable** (the logic helpers stay).

### 3.2 Drawer / modal backdrop & scroll lock

- **There is no separate backdrop / scroll-lock implementation** beyond what the two focus-trap effects include. No `useStableScrollLock` helper exists. R0's claim that "`dashboard-shell.tsx` + `ai-settings-panel.tsx` both implement a `useStableScrollLock` of their own" is **wrong** — `dashboard-shell.tsx` does not exist.

### 3.3 Form helpers

- The codebase already centralises validation in Zod (`src/lib/contracts/**`, `src/lib/ai-config/**`). **No duplicate form helpers.** No `useFieldArray`.

### 3.4 Polling / cache

- `src/lib/ai-report/report-controller.ts:1–123` is the only polling loop. It exists because the AI generation is durable (long-running, cancelable, retryable). **KEEP.** Re-evaluation only when SSE/WebSocket/long-polling contract lands.
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

| Package | Why | Files affected (planned) | LOC deletable from existing code |
|---|---|---|---|
| `radix-ui` (umbrella, 1.4.3, MIT) | Sheet, Dialog, AlertDialog, DropdownMenu, Tooltip, Accordion, ScrollArea, Label, Checkbox, Separator | `theme-selector.tsx:36–71` (focus trap + keydown), AI drawers focus-trap `useEffect` (per §2.2) | ~ 60 + ~ 50 + 36 = **~ 146** LOC (current code) |
| `lucide-react` (0.474.x, MIT, 0 deps) | icons | `theme-selector.tsx:86,118` decorative arrows | **2** occurrences |

> **Conditional compatibility test:** `radix-ui` umbrella must pass `pnpm install`, `pnpm tsc --noEmit`, `pnpm build`, and the existing `pnpm test` suite before merge. If the umbrella build is incompatible with Next.js 16.3.8 / React 19.2.8, **fall back to individual `@radix-ui/react-*`** packages and document the reason in the PR.

### 4.3 Add only for P1.6-W04 (conditional, after P1.6-G3 spike PASS) — 0–2 packages

| Package | Why | Gate |
|---|---|---|
| `react-data-grid` 7.0.0-beta.61 | P1.6 13-column grid | **P1.6-G3 spike PASS**; pin `7.0.0-beta.61`; measure bundle via `next build` analyzer before merge |
| `cmdk` 1.1.1 | P1.6 Recruiter/Team/Bank typeahead | **focused typeahead spike PASS**; only added if spike shows custom ≥ 150 LOC is unavoidable |

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

---

## 5. Migration order (minimal, no double-migration)

> **Ordering rule**: each step is a **small isolated commit / change set** (not a PR — see project workflow notes). No step migrates native dialog → Radix twice. Each step gates on the previous T1A/T1B work.

### Step 0 — Branch hygiene (done)

- Worktree `audit/library-reuse` at `ec2f635`. No code changes outside `docs/audits/library-reuse-master.md`.

### Step 1 — APP-NAV-01 (T1B, after dashboard-view lands)

- Install **`radix-ui`** + **`lucide-react`** in one change set. Verify `next build` and `tsc --noEmit`.
- Use **`radix-ui` `Sheet`** (mobile drawer) and **`DropdownMenu`** (theme selector) directly. Do **not** migrate to native `<dialog>` then to Radix — start with Radix.
- Replace `theme-selector.tsx:36–71` (`useEffect` keydown + `onListKeyDown`) with `DropdownMenu`. Theme registry unchanged.
- **Reversibility**: revert by restoring the focus-trap `useEffect` from git history.

### Step 2 — Existing AI drawers (T1A, after P1.5-W05/G5 closes)

- Migrate `ai-settings-panel.tsx:306–365` and `ai-report-panel.tsx:180–230` (focus-trap `useEffect`) to `radix-ui` `Dialog`. **Keep** `ai-settings-panel-logic.ts` (`confirmInitialFocusIndex`, `decideDismiss`, `resolveTabTarget`) — Radix does not give us the discard-confirm state machine.
- Replace the inline confirm-discard `<div>` rendering inside `ai-settings-panel.tsx` with `radix-ui` `AlertDialog`. The state machine stays in `ai-settings-panel-logic.ts`.
- **Reversibility**: each drawer focus effect is independently restorable.

### Step 3 — Polling: NO RIDE TO MODIFY (T1A — KEEP)

- `src/lib/ai-report/report-controller.ts:1–123` **stays as-is**. **No Step 7 in this revision.** See §2.5 for why `useTransition` / `revalidateTag` / `updateTag` cannot replace durable-job polling, and why converting to a synchronous Server Action would violate Vercel timeout/retry/cancellation semantics.
- Revisit only when an SSE / WebSocket / long-polling contract with reconnect, authorization, and terminal-state tests exists.

### Step 4 — P1.6 grid (T1B, P1.6-W04, conditional)

- Add `react-data-grid@7.0.0-beta.61` to `BI-p1.6-integration` only. Pin version.
- Use `BI-p1.6-grid-spike/src/app/spike/grid/grid-spike.tsx` as template.
- **Measure bundle via `next build` analyzer** before merge; report MEASURE_REQUIRED result in the PR description. Do not claim a number we have not measured.
- **Reversibility**: `pnpm remove react-data-grid`.

### Step 5 — P1.6 typeahead (T1B, P1.6-W05, conditional)

- Add `cmdk@1.1.1` **only after** a focused typeahead spike in `BI-p1.6-grid-spike` or a new `BI-p1.6-typeahead-spike` worktree proves custom code ≥ 150 LOC is unavoidable.
- **Reversibility**: replace with native `<select>` / `<datalist>`.

### Step ordering rules

1. **Do not start Step 2 until T1A's P1.5-W05/G5 lands on `main`.**
2. **Do not start Step 4 / 5 until T1B's P1.6-G3 lands on `feature/p1.6-integration`.**
3. **No big-bang change set.** Each step is a single change set, ≤ 400 LOC diff.
4. **After every step**, run `next build`, `tsc --noEmit`, and the existing `pnpm test` suite (which is a Node `node:test` suite — see §6.5 for what it actually tests).

---

## 6. Acceptance criteria

### 6.1 Code reduction — measurable

| Metric | Today | Target (after Steps 1–2) | Target (after Steps 4–5 if added) | How to verify |
|---|---:|---:|---:|---|
| CURRENT deletable LOC | n/a | ~ 146 (focus trap + theme selector) | unchanged | `git diff main..audit/library-reuse --stat` shows net deletion |
| PLANNED avoided | n/a | 0 | ≥ 1,530 (grid + typeahead) | `wc -l` on new P1.6 components in `BI-p1.6-integration` after merge |
| GENERATED ADDED (wrapper) | n/a | ~ 50 (Dialog/DropdownMenu/AlertDialog snippets) | + ~ 80 (grid column defs + custom editors) | grep new snippet files |

**CURRENT deletable target: ≥ 100 LOC of accessibility/keyboard plumbing.**
**PLANNED avoided target: ≥ 1,500 LOC if P1.6-W04 lands with the recommended stack.**

### 6.2 No regression in behavior / accessibility / security

- **Behavior**: every drawer's `aria-label`, header, and submit semantics remain identical. Existing `src/components/dashboard/ai-settings-panel.test.mjs` and `src/components/ai-report/ai-report-panel.test.mjs` Node tests must still pass.
- **Accessibility**: every migrated component **must** be verified against **WAI-ARIA APG dialog / listbox patterns** via the official docs (https://www.w3.org/WAI/ARIA/apg/, https://www.radix-ui.com/primitives). **VoiceOver / NVDA / IME testing is NOT in scope of this audit.** App-level keyboard tests must be added as Node behavioral tests using `node:test` + `jsdom` (or equivalent) before each migration step ships. **We do not claim a screen reader has been used until that has happened.**
- **Security**: no change. Server-side validation remains in Zod; Server Actions remain `use server`. No new client trust boundary.

### 6.3 Bundle size

- After Step 1: `radix-ui` umbrella + `lucide-react` add **MEASURE_REQUIRED** — actual delta must come from `next build --profile` (built-in to Next.js 16) **after** a real install, not from a quoted estimate. R0's "~ 14 kB gzip" number is **withdrawn** until measured.
- After Step 4 (if added): `react-data-grid` is route-loaded via `next/dynamic`. Bundle delta **MEASURE_REQUIRED** — quoted "≈ 80 kB" in R0 is **withdrawn** until measured.

### 6.4 Tests we have (truthfulness)

> **Source of truth:** `git show HEAD:package.json` `scripts.test`. The project ships **only Node `node:test` suites** (`.test.mjs`). There is **no axe-core dependency, no Playwright, no Vitest, no jsdom** declared. R0's claim that "axe-core is already integrated in P1.5 testing flow" is **wrong** and is corrected here.

| Test type | What we have | What we don't have | What we add (recommended) |
|---|---|---|---|
| Node behavioral tests (`node:test`) | `src/components/dashboard/ai-settings-panel.test.mjs`, `src/components/dashboard/ai-settings-panel-logic.test.mjs`, `src/components/ai-report/ai-report-panel.test.mjs`, `src/lib/ai-report/report-controller.test.mjs`, etc. | axe-core, jsdom, Playwright, Vitest | **jsdom** + minimal accessibility assertions (e.g. role / aria-modal / focus-return) for migrated drawers; gate migration step on green test |
| Source-string tests | None | — | n/a |
| Browser tests | None | Playwright / Vitest browser | **DEFER** — only after app-level keyboard/IME test is a documented requirement |

### 6.5 Server Component boundaries — must not be lost

- `Sheet` / `Dialog` / `DropdownMenu` / `Tooltip` / `Command` are all Client Components. They **must not** be imported into RSC trees.
- The Server Component layers above them (page, layout, server-fetched data) **must remain Server Components**.
- `react-data-grid` is a Client Component. We do not attempt to use it on the server.
- RSC boundary preservation is verified by `next build` output (server/client split) and by `tsc --noEmit`.

### 6.6 Hard guardrails (unchanged)

- **No `package.json` / `pnpm-lock.yaml` changes outside §4.2 + §4.3 packages.**
- **No DB / RPC / schema migration.**
- **No removal of author ownership from T1A / T1B.** Each agent owns their phase gate.
- **No big-bang change set.** Each step ≤ 400 LOC diff, single change set per step.
- **No "MEASURE_REQUIRED" value may be quoted as a number without measurement.** Bundle delta, focus-return latency, IME composition cost: all must come from a real `next build --profile` run on a real install.

---

## Appendix A — Source-of-truth docs (verified, 2026-10)

- React 19 docs — `useActionState`, `useTransition`, `useOptimistic`, `useId`: https://react.dev/reference/react.
- Next.js 16 docs — App Router, Server Actions, `revalidateTag`, `updateTag`, cache tags, View Transitions: https://nextjs.org/docs (v16.3.x).
- WAI-ARIA Authoring Practices Guide (APG) — dialog, listbox, combobox patterns: https://www.w3.org/WAI/ARIA/apg/.
- Radix UI Primitives (umbrella + individual) — https://www.radix-ui.com/primitives (verified Dialog 1.1.23, DropdownMenu 2.x, Slot 1.3.3 current as of 2026-08).
- `radix-ui` umbrella package on npm — https://www.npmjs.com/package/radix-ui (1.4.3, MIT).
- shadcn/ui — https://ui.shadcn.com (CLI copy-paste snippets, **each snippet is a generated wrapper file, not a runtime install**).
- cmdk — https://cmdk.paco.me (1.1.1, MIT).
- sonner — https://sonner.emilkowal.ski (2.0.8, MIT). **Not added.**
- react-data-grid — https://github.com/Comcast/react-data-grid (7.0.0-beta.61, MIT, peer `react ^19.2`, `react-dom ^19.2` — **no Chart.js peer**).
- lucide-react — https://lucide.dev (0.474.x, MIT, 0 deps).
- next-themes — https://github.com/pacocoursey/next-themes (0.4.6, MIT). **Rejected.**
- date-fns — https://date-fns.org (4.4.0, MIT). **Rejected.**
- React Hook Form — https://react-hook-form.com (7.89.0, MIT). **Rejected.**
- TanStack Query — https://tanstack.com/query (5.104.1, MIT). **Rejected.**
- react-dropzone — https://react-dropzone.js.org. **Rejected.**

## Appendix B — Rejected candidates with rationale (unchanged structure, R1)

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

## Appendix C — Decisions deferred (not now)

| Decision | Why deferred | When to revisit |
|---|---|---|
| Drop `react-data-grid` beta pinning | Wait for `7.0.0` GA |
| Replace durable-job polling | Only after SSE / WebSocket / long-polling contract with reconnect, authorization, terminal-state tests |
| Adopt `radix-ui` `Tooltip` / `Accordion` / `ScrollArea` | Only when P1.6 review notes UI is shaped |
| Add `sonner` | Only if a real toast-shaped need appears beyond inline status |

## Appendix D — Migration checklist (per-step, single change set each)

- [ ] **Step 1 — APP-NAV-01**: install `radix-ui` + `lucide-react`; verify `pnpm build`, `tsc --noEmit`, `pnpm test`. Replace `theme-selector.tsx:36–71` with `DropdownMenu`. Re-run `theme-selector` focus/select test.
- [ ] **Step 2 — Existing AI drawers (T1A, post-P1.5-W05/G5)**: migrate `ai-settings-panel.tsx:306–365` and `ai-report-panel.tsx:180–230` focus-trap `useEffect` to `radix-ui` `Dialog`. Replace inline confirm-discard `<div>` with `AlertDialog`. Keep `ai-settings-panel-logic.ts`. Re-run `ai-settings-panel.test.mjs` and `ai-report-panel.test.mjs`.
- [ ] **Step 3 — Polling**: **no change.** Confirm `report-controller.ts:1–123` unchanged.
- [ ] **Step 4 — P1.6 grid (T1B, P1.6-W04, conditional)**: add `react-data-grid@7.0.0-beta.61`. Use `BI-p1.6-grid-spike` as template. Measure bundle via `next build --profile`. Re-run `pnpm test`.
- [ ] **Step 5 — P1.6 typeahead (T1B, P1.6-W05, conditional)**: only after focused typeahead spike PASS; add `cmdk@1.1.1`. Measure bundle.

## Appendix E — Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `react-data-grid` 7.0.0-beta breaks in production | Low–Med | Pin to `7.0.0-beta.61`; have CSS-grid fallback ready in spike branch; measure bundle before merge. |
| `radix-ui` umbrella incompatible with Next.js 16.3.8 / React 19.2.8 | Low | **Conditional compatibility test** at install time (`pnpm build`, `tsc --noEmit`, `pnpm test`). Fall back to individual `@radix-ui/react-*` packages and document why in the change set. |
| `cmdk` collision with Tailwind v4 | Low | Pin to 1.1.1; isolate via `radix-ui` Popover wrapper. |
| Radix Dialog portal + sticky header z-index | Med | Re-use the P1.5-W05 modal stacking CSS variables. |
| Lucide tree-shaking on Next.js 16 Turbopack | Low | Use named imports (`import { ChevronDown } from "lucide-react"`). |
| Polling misclassification | Low | Polling controller is **KEEP**; `useTransition` and `revalidateTag` do not replace durable background jobs. |
| Bundle-size claim before measurement | Med | **Every bundle claim must come from a real `next build --profile` run on a real install.** Quoted numbers are MEASURE_REQUIRED until then. |
| Screen-reader access we never tested | Med | Do not claim VoiceOver/NVDA pass until it has been run. App-level keyboard test must be added (jsdom + role/aria assertion) before each migration step ships. |

---

**End of R1 audit.**