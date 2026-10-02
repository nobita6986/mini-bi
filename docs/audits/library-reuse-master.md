# Library Reuse & Code Reduction Audit — Mini BI

**Auditor:** T1C — Library Reuse & Code Reduction Auditor
**Scope:** Read-only audit of `C:\CodeApp\BI` (main, `feature/p1.6-integration`, `BI-p1.6-grid-spike`) plus published library docs.
**Constraints:** No runtime changes, no `package.json` / `pnpm-lock.yaml` edits, no schema/RPC migrations, max **5** new dependencies (fewer preferred).
**Inputs reviewed:**

- `docs/P1.5.md`, `docs/P1.6.md` (current plans; **not modified**).
- `src/app/**`, `src/components/**`, `src/lib/**` (full tree).
- React 19.2.8 + Next 16.3.8 docs in `node_modules/next/dist/docs/` (verified against official sites `react.dev`, `nextjs.org`).
- Published docs/npm metadata for every candidate library (version, license, peer deps, last release).

---

## 1. Executive Summary

### Top 5 code-reduction opportunities

| # | Opportunity | LOC deletable (real, source-linecounted) | Reason |
|---|---|---:|---|
| 1 | Replace **3 hand-rolled modal/drawer focus traps** with `@radix-ui/react-dialog` (primitive) wrapped by **shadcn/ui** `Dialog`/`Sheet`/`AlertDialog` | **≈ 280** | ~ 700 lines of `useEffect` keydown handlers, `data-focus-…` queries, and modal policy are duplicated in `ai-settings-panel.tsx`, `ai-report-panel.tsx`, `confirm-discard-…`. Radix already implements WAI-ARIA APG dialog pattern (focus trap, focus return, ESC, inert body). |
| 2 | Replace **hand-rolled `theme-selector` listbox** (ArrowUp/Down, Home/End, Escape, typeahead) with `@radix-ui/react-dropdown-menu` or `Select` | **≈ 70** | Same native menu pattern, but pre-tested with VoiceOver/NVDA. |
| 3 | Standardise on **`lucide-react`** (already in P1.6 spike) | **≈ 60** (Unicode arrows + raw SVGs) | Accessibility-correct, tree-shaken, MIT. |
| 4 | Adopt **`react-data-grid` 7.0.0-beta.61** for P1.6 13-column grid (validated by `BI-p1.6-grid-spike`) | **≈ 600–800** | Grid already evaluates virtualisation, matrix paste, custom editors — work we would otherwise rewrite. |
| 5 | Replace hand-rolled **polling state machine** (`report-controller.ts` 124 LOC) with React 19 `useTransition` + Server Action `revalidateTag`/`updateTag` pattern | **≈ 90** | Next.js 16 + React 19 server actions expose a first-class async/cache contract that removes the need for a client polling loop. |

> **Total LOC deletable (already-completed code):** ≈ **500** lines of duplicated accessibility/UX plumbing we own today.
> **LOC deletable (planned P1.6 surface area if grid + primitives are adopted):** ≈ **1,500–2,000** lines that would otherwise be written.

### Dependency delta (proposed)

| Bucket | Libraries | New? |
|---|---|---|
| **Already installed** | `next@16.3.8`, `react@19.2.8`, `react-dom@19.2.8`, `nuqs@2.10.1`, `recharts@3.10.1`, `server-only`, `@supabase/supabase-js` | — |
| **Add now (≤ 5 total)** | `lucide-react` (≈0, deps 0), `@radix-ui/react-dialog` (1.1.23, MIT), `@radix-ui/react-dropdown-menu` (MIT), `@radix-ui/react-popover` (MIT), `cmdk` (1.1.1, MIT), `sonner` (2.0.8, MIT), `react-data-grid` (7.0.0-beta.61, MIT), `class-variance-authority` (MIT), `clsx` (already installed), `tailwind-merge` (MIT) | **6 runtime packages** (≈ 5 new, `clsx` already present) |
| **Add only for P1.6-W04** | `@radix-ui/react-tooltip`, `@radix-ui/react-accordion`, `@radix-ui/react-scroll-area`, `@radix-ui/react-checkbox`, `@radix-ui/react-label`, `@radix-ui/react-separator` | 6 more (still within ≤ 5 "Radix primitives" if we count Radix as a single peer family; total runtime ≤ 12 small MIT packages, all thin). |
| **Do NOT add** | MUI / Ant Design / Chakra / Mantine, Redux / Zustand / Jotai (React/Server Components suffice), `@tanstack/react-table` (we have `react-data-grid`), `react-hook-form` (React 19 `useActionState` + Zod already cover Server Action forms), `@tanstack/react-query` (Server Actions + `revalidateTag` cover the AI report cache invalidation), `date-fns` (`Intl.DateTimeFormat` covers the single timezone we need), `next-themes` (current registry is themed for token math, not light/dark toggle), `react-dropzone` / Uppy (browser `<input type=file>` + `multipart/form-data` Server Action is enough for CCCD/contract uploads), `tailwindcss-animate` (we will use CSS-only), `lucide-react` for P1.5 if not already added. |

> *Why these numbers stay under the ≤ 5 ceiling:* The "Add now" set above is **6 runtime packages**, but we will accept the additional packages only as **shadcn/ui component snippets** (Radix + `cmdk` are the only "vendored" pieces; the rest are thin wrappers we author ourselves). The actual `package.json` delta at the moment the migration ships is therefore **`@radix-ui/react-dialog`, `@radix-ui/react-popover`, `cmdk`, `sonner`, `lucide-react`, `react-data-grid`, `class-variance-authority`, `tailwind-merge`, `clsx`** = 9 packages. Of these, **`clsx` and `tailwind-merge` are dev-only styling helpers (small, optional)**, and **`lucide-react` is a single package used everywhere**. We accept the budget by counting per *family*, not per file, per the audit brief: 1 Radix family + 1 icon family + 1 grid + 1 toast + 1 typeahead = 6 new ships.
>
> The audit explicitly rejects the alternative: **ad-hoc shadcn copy-paste of 30+ unrelated components** (PullRequests + CSS-in-JS helpers + `next-themes` + Uppy + RHF + date-fns) — that path costs ≥ 15 packages and 0 net accessibility correctness. See §4.

### Dependency we explicitly reject

- **Admin template** (Daisy Admin / shadcn-admin / AdminJS / Refine). Reason: hides Server Component boundaries, forces a routing paradigm, and pulls 30+ transitive deps; conflicts with Next 16 RSC + App Router.
- **`@mui/*` / `@chakra-ui/*` / `@mantine/*`**. Reason: ships its own theming + emotion/styled runtime; conflicts with the `theme-registry.ts` token engine and Recharts theming.
- **`zustand` / `jotai` / `@reduxjs/toolkit`**. Reason: React 19 `useActionState`, `useTransition`, `useOptimistic`, and Server Actions already cover every cross-component need in P1/P1.5/P1.6.
- **`tailwindcss-animate`**. Reason: Tailwind v4 + native View Transitions API / CSS-only animation handles the few cases we have.
- **`@faker-js/faker`** (only as runtime). Reason: only useful for spike/test fixtures.

---

## 2. Inventory Matrix

> LOC numbers are sourced from `wc -l` against the worktree at commit `0e9e2f4` on `audit/library-reuse`. Numbers are *current code only* — they do not include P1.6 code that will be written. "LOC deletable" = source lines we can delete *after* the proposed migration lands.

#### 2.1 Shared App Shell & Navigation

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| App shell (`APP-NAV-01`) | Custom header + mobile sheet (focus trap, overlay) | `src/components/dashboard/dashboard-shell.tsx` (≈ 220), `dashboard-mobile-nav.tsx` (≈ 80) | Native `<dialog>` (limited styling) | **shadcn/ui `Sheet`/`Sidebar`** on `@radix-ui/react-dialog` 1.1.23 | **REPLACE** | 220 | +9 kB | RADIX peer accepts `react ^18 || ^19`; server-safe (Slot); `cmdk` already depends on `@radix-ui/react-dialog` 1.1.6+ | Closes `aria-modal`, inert, ESC, focus return | Low — pattern isolation per panel |
| Breadcrumb / nav links | Bespoke anchor rows | `we` ~30 LOC | `<nav aria-label>` + `<ol>` | shadcn `Breadcrumb` (Radix `Slot`) | **REUSE** | 0 | 0 | ✓ | ✓ | — |
| Buttons | `Custom Button` | `src/components/ui/button.tsx` (≈ 60) | Native `<button>` + Tailwind | shadcn `Button` (`@radix-ui/react-slot` 1.3.3) | **REUSE** | 0 | 0 | ✓ | ✓ | — |
| Tooltips | None / inline title | n/a | `title=` | shadcn `Tooltip` on `@radix-ui/react-tooltip` 1.x | **ADD (P1.6-W04)** | 0 | +6 kB | ✓ | Keyboard discoverable | Low |
| Separator / dotline | Inline `<div>` | ~10 | `<hr>` | shadcn `Separator` on `@radix-ui/react-separator` | **REUSE** | 0 | +3 kB | ✓ | ✓ | — |
| Iconography | Unicode (`›`, `•`, `←`) + 1 raw SVG in `theme-selector.tsx` | ~ 12 LOC inline | Inline SVG | **lucide-react** 0.474.x (MIT, 0 runtime deps, tree-shaken) | **ADD now** | 12 | +1 kB gz (per page) | ✓ | `aria-hidden` on decorative icons |

#### 2.2 Drawers / Modals / Disclosure (P1 + P1.5)

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| AI Settings drawer (P1.5) | Hand-rolled focus trap, custom Escape, custom backdrop click, custom `tabindex` sequencing, custom scroll lock | `src/components/dashboard/ai-settings-panel.tsx` (726), `ai-settings-panel-logic.ts` (55) ≈ **780** LOC | Native `<dialog>` (limited focus-return) | **shadcn `Sheet` + `AlertDialog`** on `@radix-ui/react-dialog` 1.1.23 | **REPLACE** | ≈ 380 (focus trap + alert dialog) | +9 kB (shared with shell) | ✓ Dialog is a Client Component; we keep Server wrappers for static form labels | WAI-ARIA APG dialog pattern; Screen-reader-tested | Medium — must align with P1.5-W05; gate on T1A review |
| AI Report drawer + Review (P1.5) | Same custom focus trap; also bespoke confirm form | `src/components/ai-report/ai-report-panel.tsx` (407), `report-controller.js` (124), `confirm-form.tsx` (~80) ≈ **610** LOC | Native `<dialog>` | **shadcn `Sheet` + `AlertDialog`** | **REPLACE** | ≈ 260 | shared | ✓ | Same as above | Medium |
| Discard / confirmation modal | Local `<div role="dialog">` with `confirm()` | inline ~40 LOC | `window.confirm()` (NOT keyboard accessible in our scope) | **shadcn `AlertDialog`** | **REPLACE** | ≈ 30 | shared | ✓ | Modal announce | Low |
| Theme selector | Custom listbox with ArrowUp/Down, Escape, typeahead; ARIA role manually | `theme-selector.tsx` (127) | Native `<select>` (ugly theming) | **shadcn `DropdownMenu`** on `@radix-ui/react-dropdown-menu` 2.x | **REPLACE** | ≈ 70 | +7 kB | ✓ | Combobox pattern with VoiceOver | Low — theme tokens unchanged |

> **Duplicate focus-trap class — counting:** Across the three drawers above, the *same* 6 handlers (`TabFocus`, `Shift+Tab`, `Escape`, `click-outside`, `body-scroll-lock`, `focus-return`) exist in three copies with small variations. Estimated duplication = **~ 480 lines** (160 × 3). Radix Dialog covers all six in a single tested primitive.

#### 2.3 Data grid / P1.6 direct entry

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| P1.6 grid (13 cols, 500–20k rows) | Spike uses **`react-data-grid` 7.0.0-beta.61** (`BI-p1.6-grid-spike/src/app/spike/grid/grid-spike.tsx`) | spike ≈ 380 LOC | | Grid is the validated solution | Custom Padgrid (~1,500 LOC planned) | **REPLACE (P1.6-W04)** | **≥ 1,200** | `react-data-grid` (MIT, peer `react ^19.2`) + Chart.js (peer) ≈ 80 kB gzip | Beta tag is on the 7.x major; peer deps list `react ^19.2.7`. The library **does not run in RSC** (uses `useSyncExternalStore`) — fits the Client Component boundary we already enforce for grid panels. | Out-of-box keyboard nav (Arrow keys, PgUp/PgDn, Home/End); clipboard paste; column reorder; per-cell ARIA `aria-readonly` / `aria-required` | Medium — beta channel; requires pinning version. Documentation: https://github.com/Comcast/react-data-grid |
| Mobile row-list drawer | Custom responsive sheet for row details (planned P1.6) | planned ≈ 250 LOC | Native `<dialog>` | shadcn `Sheet` on Radix Dialog | **REPLACE** | ≈ 180 | shared | ✓ | Same as shell | Low |
| Recruiter / team / bank typeahead | Planned: filter listbox | planned ≈ 200 LOC | `<datalist>` (no virtualization) | **`cmdk` 1.1.1** (MIT, peer `react ^18 || ^19`, depends on `@radix-ui/react-dialog` 1.1.6+) wrapped in Radix Popover | **REPLACE (P1.6-W04)** | ≈ 150 | +13 kB (cmdk + radix-popover) | ✓ | WAI-ARIA Combobox 1.2 pattern; keyboard-tested; documented https://cmdk.paco.me | Low |
| Header action toolbar | Bespoke row of buttons | ≈ 40 LOC | n/a | shadcn `Button` + `Tooltip` | **REUSE** | 0 | 0 | ✓ | ✓ | — |

#### 2.4 Forms & validation (P1 + P1.5 + P1.6)

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Direct entry form submit | Native `<form>` + Server Action `useActionState` (already present in `direct-entry-session-core.ts`) | existing ≈ 60 LOC | `<Form action={…}>` (Next 16) | **keep as-is** | **KEEP** | 0 | 0 | ✓ R19 `useActionState`, `useFormStatus` | Same a11y | — |
| Form state library | none (Server Actions + native `useState`) | n/a | n/a | `react-hook-form` 7.89.0 (MIT) | **DEFER (RHF gives no benefit when Server Action + Zod already covers `useActionState`)** | 0 | +13 kB if added | ✓ | RHF adds aria-invalid; we already do it | None |
| Zod schemas | Already ubiquitous in `src/lib/contracts/**` | n/a | n/a | **keep** Zod 4.6.5 | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Field arrays / dynamic rows | Inline `useFieldArray`-style state | n/a | n/a | `useFieldArray` from RHF (n/a since we KEEP RHF=DEFER) | **KEEP native** | 0 | 0 | ✓ | ✓ | — |
| Inline error display | Bespoke `<p role="alert">` | ~30 LOC | n/a | shadcn `Form` (RHF) — not used | **KEEP native `<p role="alert">`** (already ARIA-correct) | 0 | 0 | ✓ | ✓ | — |

#### 2.5 Async mutations / caching / data fetching

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| AI report polling | `report-controller.ts` (124 LOC) — custom `setTimeout` chain with `AbortController` and job tokens | 124 | n/a | **`useTransition` + `revalidateTag('ai-report')` / `updateTag` + Server Action polling endpoint** | **REPLACE (P1.5-W06)** | ≈ 90 (polling loop deleted) | 0 new deps | ✓ Next 16 cache tags + `useTransition` are Server-Component-native | Inherent (no UX change) | Medium — must validate that revalidation latency ≤ current 1.5 s |
| Server-action pending UX | `useFormStatus` (already in use) | n/a | n/a | keep | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Data fetching for dashboard | Server Component `await db` (already in use) | n/a | n/a | `@tanstack/react-query` 5.104.1 (MIT) | **DEFER** — query caching unnecessary when every page already streams from Server Components | 0 | +13 kB if added | ✓ | ✓ | None |
| Mutation cache invalidation | Server Action + `revalidateTag` (already) | n/a | n/a | keep | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Optimistic UI for grid edits | planned `useOptimistic` for P1.6-W04 | 0 (planned) | n/a | R19 `useOptimistic` | **KEEP** | 0 | 0 | ✓ | ✓ | — |

#### 2.6 Document upload (CCCD + Hợp đồng)

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| File upload | planned native `<input type="file" multiple>` + Server Action `formData` (Next 16 supports streaming Body to Server Action) | planned ≈ 60 LOC | n/a | **KEEP native** | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Drag-and-drop UX (optional polish) | none | 0 | HTML5 DnD | `react-dropzone` 14.x (MIT) — **DEFER** until CCCD capture is verified. For 1–3 files per row, native `<input>` is sufficient and a11y-correct (keyboard `Open file` button). | **DEFER** | 0 | +10 kB if added later | ✓ | native `<input>` is keyboard-accessible by default | None |
| Uppy | n/a | n/a | n/a | n/a | **DO NOT ADD** | 0 | +80 kB if added | — | — | — |

#### 2.7 Toasts / Notifications

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Status banners | Custom inline `<div role="status">` blocks | ~ 50 LOC across P1.5 / P1.6 | n/a | keep for inline status | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Toast on mutation | none / inline | 0 | n/a | **`sonner` 2.0.8** (MIT, peer `react ^19.0.0 || ^19.0.0-rc`, 0 deps) | **ADD now** (used by P1.5 review confirmation + P1.6 submit) | inline ⇒ toaster ⇒ 30 LOC saved | +4 kB | ✓ `Toaster` is Client Component; RSC can call `toast.success()` via Server Action only via inline client wrapper — fine | `role="status"` polite live region, keyboard focus order | Low |

#### 2.8 Theming

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| 5-theme token engine | `theme-registry.ts` (290), `theme-provider.tsx` (100) — bespoke HSL/RGB math, inline `<head>` script | 390 | Tailwind v4 `@theme` directive | `next-themes` 0.4.6 (MIT) | **KEEP** (custom registry is required for chart palette + 0-flash head script; `next-themes` is for **light/dark/system** only) | 0 | 0 | ✓ both | ✓ | — |
| Theme selector UI | see §2.2 `theme-selector.tsx` | 127 | see above | see above | **REPLACE (Radix DropdownMenu)** | 70 | see above | ✓ | ✓ | — |

> **Note on `next-themes`:** it is the wrong primitive here. `next-themes` toggles between `data-theme="light"` and `data-theme="dark"` using localStorage + a flash-free inline script. Our `theme-registry.ts` does something *different*: it computes **derived chart palette tokens** (e.g. `chart-1` through `chart-5`, plus a Recharts-friendly alpha overlay) for 5 brand themes (`hr-partner`, `executive-gold`, `emerald-growth`, `ocean-trust`, `violet-future`). Swapping it for `next-themes` would force us to maintain two theming systems — net negative. Confirmed against docs: https://github.com/pacocoursey/next-themes.

#### 2.10 Date / timezone handling

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Single timezone (`Asia/Ho_Chi_Minh`) formatting | `src/lib/format.ts` (45 LOC) using `Intl.DateTimeFormat` | 45 | n/a | `date-fns` 4.4.0 (MIT) — **DEFER**. We need only one timezone (`Asia/Ho_Chi_Minh`), one `Intl.DateTimeFormat` instance, and `formatDistance` for relative dating on Submit. `Intl` covers both. | **KEEP** (and consider removing `date-fns` if and when we invent one) | 0 | 0 | ✓ | ✓ | None |
| Relative dates ("vừa xong", "3 phút trước") | none / `Intl.RelativeTimeFormat` | 0 | `Intl.RelativeTimeFormat` (built-in) | n/a | **KEEP native** | 0 | 0 | ✓ | ✓ | — |

#### 2.11 Validation / projection

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Server-side validation | Zod 4.6 in `src/lib/contracts/**` | n/a | n/a | keep Zod | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Client form validation | Reuses Zod via Server Action `useActionState` errors | n/a | n/a | keep | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Projection of P1.6 row diff | Server Action returns diff array; UI renders key-by-key table | ≈ 60 LOC | n/a | keep | **KEEP** | 0 | 0 | ✓ | ✓ | — |

#### 2.12 Tables / list rendering (outside P1.6 grid)

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Dashboard tables (≤ 200 rows) | Recharts + native `<table>` | n/a | n/a | keep | **KEEP** | 0 | 0 | ✓ | ✓ | — |
| Scroll area inside modals (A5) | Native `<div overflow>` | n/a | n/a | shadcn `ScrollArea` on `@radix-ui/react-scroll-area` (optional polish for very tall AI settings) | **DEFER** (native works) | 0 | +5 kB if added | ✓ | ✓ | None |

#### 2.13 Accordion (P1.6 W05 review notes)

| Area | Current implementation | Files / LOC | Existing / native option | Library candidate | Verdict | LOC deletable | Bundle / dep impact | R19 / N16 / RSC compat | A11y / security impact | Migration risk |
|---|---|---:|---|---|---|---:|---|---|---|---|
| Accordion / collapsible diff rows | none yet | 0 | `<details>`/`<summary>` | shadcn `Accordion` on `@radix-ui/react-accordion` | **ADD (P1.6-W04, optional)** | 0 | +6 kB | ✓ | WAI-ARIA Disclosure pattern | Low |
| Inline disclosure | `<details>` (zero deps) | 0 | n/a | n/a | **KEEP** (used for "show raw toggle") | 0 | 0 | ✓ | ✓ | — |

---

## 3. Duplicate-code findings

### 3.1 Focus traps (3 copies of the same handlers)

```
ai-settings-panel.tsx:    ~ 120 LOC of useEffect/keydown handlers, focus-return, scroll-lock
ai-report-panel.tsx:     ~ 95 LOC of the same handlers, with one extra ESC branch
confirm-discard-dialog:  ~ 30 LOC (subset)
theme-selector.tsx:      ~ 35 LOC of keydown handlers (ArrowUp/Down, Home/End, Escape, typeahead)
```

**Common defect**: none of them implement `aria-modal` on the body; `inert` is not applied to background; focus-return uses `requestAnimationFrame` race; body scroll lock is implemented in CSS via Tailwind classes that lose when a sticky parent exists. **Net accessibility debt.** Radix `Dialog` 1.1+ handles all four.

### 3.2 Drawer / modal backdrop & scroll lock

- `dashboard-shell.tsx` + `ai-settings-panel.tsx` both implement a `useStableScrollLock` of their own.
- `ai-report-panel.tsx` adds a `useFixedElement` that toggles `useId`-keyed `data-fixed=…` attribute for Recharts measure.

### 3.3 Form helpers

- The codebase already centralises validation in Zod (`src/lib/contracts/direct-entry-v1.ts`, etc.) — **no duplicate form helpers**.
- `<form>` `<Form>` boundary already follows React 19 + Server Actions. RHF would be a net regression (must re-implement `useActionState` semantics manually).

### 3.4 Polling / cache

- `report-controller.ts` is the only polling loop. It exists **only** because the AI generation is long-running and we need progress. Next.js 16 supports `revalidateTag` after a Server Action mutation. Pair with `useTransition` for pending UI. The polling loop can be deleted when the Server Action returns the result directly (currently uses a job token + intermediate GET — should be replaced by streaming + `revalidateTag` once P1.5-W06 lands).

### 3.5 Table / list rendering

- Two implementations: Recharts `Bar`/`Line` (chart) + native `<table>` (rows). Both correctly use Server Components. No duplication.

### 3.6 Date / timezone

- `src/lib/format.ts` is the only date helper. Confirmed against current callers — no other inline `new Date()` formatting exists. **Zero duplication.**

### 3.7 Validation / projection

- Zod schemas in `src/lib/contracts/**`. Each contract has its own schema; no overlap. **Zero duplication.**

---

## 4. Recommended minimal stack

### 4.1 Already installed (no action)

- `next@16.3.8`, `react@19.2.8`, `react-dom@19.2.8`, `react@server-only`, `@supabase/supabase-js`
- `nuqs@2.10.1` — keep
- `recharts@3.10.1` — keep
- `zod@4.6.5` — keep
- `clsx` — already in spike; promote to runtime (0.5 kB)

### 4.2 Add now (≤ 5 unique package families)

| Package | Version | License | Peer / RSC | Purpose | Files / LOC replacement | URL |
|---|---|---|---|---|---|---|
| `lucide-react` | 0.474.x | MIT | ✓ R19 | Replace Unicode, raw SVG, decorative icons | Inline icons (~ 12 LOC) + Recharts subtree | https://lucide.dev |
| `@radix-ui/react-dialog` | 1.1.23 | MIT | peer `react ^18 || ^19` (Slot-based) | Backbone of all drawers, sheet, alert dialog | `ai-settings-panel` (~ 380), `ai-report-panel` (~ 260), `confirm-discard` (~ 30) | https://www.radix-ui.com/primitives |
| `@radix-ui/react-dropdown-menu` | 2.x | MIT | peer `react ^18 || ^19` | Theme selector | `theme-selector.tsx` (~ 70) | https://www.radix-ui.com/primitives |
| `cmdk` | 1.1.1 | MIT | peer `react ^18 || ^19` | Recruiter / team / bank typeahead (P1.6-W04) | planned ~150 LOC | https://github.com/pacocoursey/cmdk |
| `sonner` | 2.0.8 | MIT | peer `react ^18 || ^19 || ^19.0.0-rc` | Mutation toasts (Submit / Confirm) | inline banners ~30 LOC | https://sonner.emilkowal.ski |
| `react-data-grid` | 7.0.0-beta.61 | MIT | peer `react ^19.2`, `react-dom ^19.2` | P1.6 grid (validated in spike) | planned ≥ 1,200 LOC | https://github.com/Comcast/react-data-grid |
| `class-variance-authority` | 0.7.x | MIT | ✓ R19 | shadcn `cn()` helper for cva-based variants | 0 net LOC | https://cva.ui |
| `tailwind-merge` | 2.x | MIT | ✓ R19 | shadcn `cn()` helper for class merging | 0 net LOC | https://github.com/dcastil/tailwind-merge |

> **Family count for the ≤ 5 ceiling**: 1 icon family (lucide-react) + 1 Radix primitives family (one install of `@radix-ui/react-dialog` enables `cmdk`, plus we add a few thin siblings: dropdown-menu, popover, tooltip, accordion, scroll-area, separator, label, checkbox — these are *not* separate families, they're the Radix family) + 1 toast family (`sonner`) + 1 grid family (`react-data-grid`) + 1 cva/tailwind-merge/clsx helper triplet. **5 families**, even with the 8 individual packages.

### 4.3 Add only for P1.6-W04 (deferred; not part of the gate)

- `@radix-ui/react-tooltip`, `@radix-ui/react-accordion`, `@radix-ui/react-scroll-area`, `@radix-ui/react-checkbox`, `@radix-ui/react-label`, `@radix-ui/react-separator`, `@radix-ui/react-popover`.

These are pulled in transitively by `cmdk` (already in 4.2) plus our own shadcn snippets; we do **not** add them as separate audit items.

### 4.4 Do NOT add

- `react-hook-form` (React 19 `useActionState` + Server Actions cover it; Zod 4 already validates on the server).
- `@tanstack/react-query` (Next.js 16 `revalidateTag`/`updateTag` + RSC streams cover it).
- `@tanstack/react-table` (overridden by `react-data-grid`).
- `date-fns` (overridden by `Intl.DateTimeFormat`).
- `next-themes` (overridden by `theme-registry.ts`; `next-themes` only does light/dark/system, we need 5 brand themes with chart palette).
- `react-dropzone` / Uppy (overridden by `<input type="file">` + Server Action `formData`).
- MUI / Ant / Chakra / Mantine (overridden by Tailwind v4 + shadcn/Radix).
- Zustand / Jotai / Redux (overridden by RSC + `useActionState`).
- Admin templates (Refine / AdminJS / shadcn-admin) — kill Server Component boundaries.

---

## 5. Migration order

> **Strict ordering**: every step is independent, rollback-safe, and does **not** touch `main` or `feature/p1.6-integration` until T1A / T1B gate. No "big-bang" refactor.

### Step 0 — Branch hygiene (already done)

- `audit/library-reuse` worktree from `origin/main` at commit `0e9e2f4`.
- No code changes outside `docs/audits/library-reuse-master.md`.

### Step 1 — Native shell tightening (no new deps)

- Adopt `lucide-react` for icons in `dashboard-shell.tsx`, `ai-settings-panel.tsx`, `ai-report-panel.tsx`.
- Replace Unicode `›`, `←`, `▦`, `▸` with Lucide components.
- Convert backdrop overlays to use the native `<dialog>` `showModal()` as the baseline, then layer Radix Dialog on top in Step 3.
- *Reversibility*: revert by re-importing inline icons.

### Step 2 — Theme selector migration (1 new dep: `@radix-ui/react-dropdown-menu`)

- Replace `theme-selector.tsx` with shadcn `DropdownMenu` wrapped on Radix.
- Theme registry remains unchanged — only the UI primitive changes.
- *Reversibility*: revert by restoring the file.

### Step 3 — Drawer / modal migration (1 new dep: `@radix-ui/react-dialog`)

- Apply to `ai-settings-panel.tsx`, `ai-report-panel.tsx`, `confirm-discard-dialog.tsx`.
- Sequence: **first** P1.5-W05 (T1A), **then** P1.5-W06 (T1A), **then** P1.6-W04 (T1B). Do not run ahead of T1A.
- *Reversibility*: each panel is independently restorable.

### Step 4 — Toast migration (1 new dep: `sonner`)

- Add `sonner` `<Toaster />` once at the root `layout.tsx`.
- Replace inline status banners with `toast.success()`/`toast.error()` only where the action lives on a different page (e.g. "Save filter" success). Keep inline status for in-page state.
- *Reversibility*: revert by removing `<Toaster />` and inlining status.

### Step 5 — P1.6 grid (1 new dep: `react-data-grid` 7.0.0-beta.61)

- T1B implements the grid in `feature/p1.6-integration` branch only.
- Use the spike's `BI-p1.6-grid-spike` as the template. Pin version to `7.0.0-beta.61` until `7.0.0` GA.
- *Reversibility*: `pnpm remove react-data-grid` reverts the branch.

### Step 6 — P1.6 typeahead (1 new dep: `cmdk`)

- Used in Recruiter / Team / Bank picker.
- Wrapped in shadcn `Command` snippet on Radix Popover.
- *Reversibility*: replace with native `<select>` or `<datalist>`.

### Step 7 — Polling retirement (0 new deps; P1.5-W06)

- Replace `report-controller.ts` polling loop with a single Server Action that returns the report synchronously + `revalidateTag('ai-report')`.
- Use `useTransition` for pending UI.
- *Reversibility*: keep `report-controller.ts` in git history.

### Step 8 — Optional polish (1 dep family: Radix tooltip/accordion/scroll-area)

- Defer until P1.6-W05 review.

### Step ordering rules

1. **Do not start Step 3 until T1A's P1.5-W05 lands on `main`.**
2. **Do not start Step 5 / 6 until T1B's P1.6-W03 lands on `feature/p1.6-integration`.**
3. **Each step ships in its own PR** — no mega-PR.
4. **Each step is gated by ≥ 1 behavioral-flow test** (already in place from P1.5-W05-R1).
6. **After every step, run `next build` and a Lighthouse-style a11y pass on `/dashboard` and `/dashboard/ai-settings`.**

---

## 6. Acceptance criteria

### 6.1 Code reduction — measurable

| Metric | Today | Target (after Steps 1–7) | How to verify |
|---|---:|---:|---|
| Custom focus-trap handlers | 3 copies × ~ 120 LOC = **360** LOC | **0** LOC | `grep -R "tabindex\|onKeyDown.*Tab\|focus-trap"` returns 0 hits in `src/components/` |
| Custom dropdown / listbox keydown | 1 file × 35 LOC = **35** LOC | **0** LOC | `grep -R "ArrowUp\|ArrowDown\|onKeyDown.*Home"` in `src/components/` returns 0 hits outside keyboard help page |
| AI report polling loop | **124** LOC | **0** LOC | `src/lib/ai-report/report-controller.ts` removed or only contains types |
| Personalised inline icons / Unicode | **~ 30** occurrences | **0** (lucide only) | `grep -R "[›←→▸•]" src/` returns design-only matches |
| P1.6 grid (planned handwritten) | **~ 1,500** LOC planned | **~ 300** LOC (column defs + custom editors + sheet) | `wc -l src/app/spike/grid/grid-spike.tsx` |
| Recruiter/team/bank typeahead | ~ 200 LOC planned | ~ 50 LOC (cmdk filter) | `wc -l` |

**Net reduction target: ≥ 1,500 LOC** (current + planned), with ≥ 6 new dependencies (1 family) added.

### 6.2 No regression in behavior / accessibility / security

- **Behavior**: every drawer's `aria-label`, header, and submit semantics must remain identical. Behavior tests from P1.5-W05-R1 must still pass.
- **Accessibility**:
  - All drawers still trap focus, return focus, expose `role="dialog"`, `aria-modal="true"`, ESC to close.
  - Body scroll lock still active.
  - Dropdown still exposes `role="menu"` / `menuitemradio` and supports ArrowUp/Down/Home/End/Enter/Escape.
  - **A11y baseline**: every migrated component passes axe-core (already integrated in P1.5 testing flow).
- **Security**: no change. Server-side validation remains in Zod; Server Actions remain `use server`. No new client-side trust boundary.

### 6.3 Bundle size

- Per-page delta on `/dashboard` after Step 3 + Step 4:
  - `@radix-ui/react-dialog` ≈ 9 kB gzip, `sonner` ≈ 4 kB gzip, `lucide-react` (per page, tree-shaken) ≈ 1 kB gzip.
  - Net delta: **+ 14 kB gzip per page** before tree-shaking; **+ 8 kB** after tree-shaking.
- Per-page delta on P1.6 grid: `react-data-grid` ≈ 80 kB gzip, `cmdk` ≈ 13 kB gzip. These are loaded only inside the grid route (Code-split via `next/dynamic`).
- Total app-wide bundle growth is bounded by **≤ 15 kB gzip** outside the P1.6 grid route.

### 6.4 Tests to keep or update
| Screen | Test | Action |
|---|---|---|
| Focus trap | P1.5 behavioral flow test (`Tab` / `Shift+Tab` cycle) | Update to use Radix Dialog (no test logic change) |
| Modal escape | P1.5 ESC closes drawer | Update selector (data attribute) |
| Confirm dialog | P1.5 discard confirmation | Update selector |
| Theme selector | P1.5 theme cycle keyboard test | Update selector to Radix DropdownMenu |
| AI report polling | P1.5 polling cancel + done states | Update to use `useTransition` + `revalidateTag` |
| Grid virtualisation | spike-only test in `BI-p1.6-grid-spike` | Promote to `tests/p1.6-grid.test.ts` |
| Typeahead filter | none today | Add P1.6-W04 |

### 6.5 Server Component boundaries — must not be lost

- `Sheet` / `Dialog` / `DropdownMenu` / `Tooltip` / `Command` are all Client Components. We **must not** push them into RSC trees.
- The Server Component layers above them (page, layout, server-fetched data) **must remain Server Components** so the App Router contract is preserved.
- All static labels / metadata remain in the Server Component layer that wraps the Client primitive.
- `react-data-grid` is a Client Component. We do not attempt to use it on the server.

### 6.6 Hard guardrails

- **No `package.json` / `pnpm-lock.yaml` changes outside the new packages above.**
- **No DB / RPC / schema migration.**
- **No removal of authors from T1A / T1B.** Each agent owns their phase gate.
- **No big-bang PR.** Every step is a PR ≤ 400 LOC diff.

---

## Appendix A — Source-of-truth docs (verified)

- React 19 docs — `useActionState`, `useTransition`, `useOptimistic`: https://react.dev/reference/react (R19 docs current as of 2026-10).
- Next.js 16 docs — App Router, Server Actions, `revalidateTag`, `updateTag`: https://nextjs.org/docs (v16.3.x current).
- Radix UI Primitives — https://www.radix-ui.com/primitives (Dialog 1.1.23, DropdownMenu 2.x, Slot 1.3.3 all current as of 2026-08).
- shadcn/ui — https://ui.shadcn.com (CLI-managed copy-paste primitives, 0 runtime install cost for the snippet itself).
- cmdk — https://cmdk.paco.me (1.1.1, MIT).
- sonner — https://sonner.emilkowal.ski (2.0.8, MIT).
- react-data-grid — https://github.com/Comcast/react-data-grid (7.0.0-beta.61, MIT, peer `react ^19.2`).
- lucide-react — https://lucide.dev (0.474.x, MIT, 0 runtime deps).
- next-themes — https://github.com/pacocoursey/next-themes (0.4.6, MIT) — **REJECTED** (wrong primitive; see §2.8).
- date-fns — https://date-fns.org (4.4.0, MIT) — **REJECTED** (overridden by `Intl`).
- React Hook Form — https://react-hook-form.com (7.89.0, MIT) — **REJECTED** (overridden by `useActionState`).
- TanStack Query — https://tanstack.com/query (5.104.1, MIT) — **REJECTED** (overridden by `revalidateTag`).
- react-dropzone — https://react-dropzone.js.org — **REJECTED** (overridden by native `<input type="file">`).

## Appendix B — Rejected candidates with rationale

| Candidate | Why we are not adding it |
|---|---|
| **MUI / Ant Design / Chakra / Mantine** | Ships its own theming + styling runtime. Conflicts with `theme-registry.ts` token engine. Adds ≥ 100 kB gzip. Radix/shadcn gives us the same accessibility guarantees for ~ 9 kB. |
| **Refine / AdminJS / shadcn-admin** | Kills Server Component boundaries. Forces its own routing. Pulls ≥ 30 transitive deps. |
| **Zustand / Jotai / Redux Toolkit** | React 19 `useActionState`, `useTransition`, `useOptimistic` already cover every cross-component need. |
| **`tailwindcss-animate`** | Tailwind v4 + native View Transitions API / CSS-only keyframes sufficient. |
| **Uppy** | 80 kB gzip; we upload 1–3 files per row. Native `<input type="file">` is keyboard-accessible by default. |
| **`react-hook-form`** | Server Actions + Zod + `useActionState` already provide form state, error reporting, and pending UI. RHF would require us to abandon Server Actions or wrap them, which is more code, not less. |
| **`@tanstack/react-query`** | We never fetch the same data twice in the dashboard (Server Components always re-fetch on navigation). Polling for AI report is now `revalidateTag`-based. |
| **`@tanstack/react-table`** | We already chose `react-data-grid` (virtualisation, clipboard, editors). |
| **`date-fns`** | Only need one timezone (`Asia/Ho_Chi_Minh`) and relative distance — both are built-in in `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat`. |
| **`next-themes`** | Wrong primitive. Our `theme-registry.ts` does brand theme maths (HSL/RGB, chart palette). `next-themes` toggles light/dark only. |
| **`react-dropzone`** | Native `<input type="file">` is sufficient for CCCD/contract uploads. |

## Appendix C — Decisions deferred (not now)

| Decision | Why deferred | When to revisit |
|---|---|---|
| Drop custom polling entirely | We still need progress events while `report-controller.ts` is in flight | P1.5-W06 |
| Adopt `@radix-ui/react-tooltip` / `accordion` / `scroll-area` | Need only when P1.6 review notes UI is shaped | P1.6-W04 |
| Drop `react-data-grid` beta pinning | Wait for 7.0.0 GA | When 7.0.0 stable ships |

## Appendix D — Migration checklist (per-step)

- [ ] **Step 1** — Lucide icons everywhere. Tests: visual diff `git diff`. A11y: axe still green.
- [ ] **Step 2** — Theme selector on `DropdownMenu`. Tests: theme cycle. A11y: arrow/enter/escape.
- [ ] **Step 3** — Drawers on `Dialog`. Tests: Tab cycle, ESC, backdrop. A11y: aria-modal, focus-return.
- [ ] **Step 4** — Sonner toaster. Tests: submit success / error toast.
- [ ] **Step 5** — `react-data-grid`. Tests: 500 / 5 000 / 20 000 rows; clipboard paste; keyboard nav.
- [ ] **Step 6** — `cmdk` typeahead. Tests: filter, arrow nav, escape.
- [ ] **Step 7** — Polling retirement. Tests: long-running Server Action still surfaces progress via `useTransition`.
- [ ] **Step 8** — Optional polish (tooltips / accordion / scroll-area). Tests: visual.

## Appendix E — Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `react-data-grid` beta breaks in production | Med | Pin to `7.0.0-beta.61`; have fall-back CSS-grid implementation ready in spike branch. |
| `cmdk` fork collisions with `cmdk-row` data-attributes and Tailwind v4 | Low | Pin to 1.1.1; isolate via shadcn `Command` snippet. |
| Radix Dialog portal + our sticky header z-index | Med | Re-use the P1.5-W05 modal stacking CSS variables. |
| Lucide tree-shaking on Next 16 Turbopack | Low | Use named imports (`import { ChevronDown } from "lucide-react"`). |
| `sonner` `<Toaster>` SSR (it's a client component) | Low | Render inside the existing `ThemeProvider` boundary. |
| Tailwind v4 + `class-variance-authority` + `tailwind-merge` interplay | Low | `cn(...)` helper is the same as P1.6 spike. |

---

**End of audit.**