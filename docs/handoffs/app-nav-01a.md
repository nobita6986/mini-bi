# APP-NAV-01A — Navigation Registry + App Shell Foundation

**Branch:** `feature/app-nav-01a`
**Base:** `origin/main` @ `45ca016`
**Author:** T0 (App Shell)
**Audit reference:** `audit/library-reuse` @ `782ad2a` (R2)
**Tier:** FT0 — registry + shell compile, targeted tests pass, two routes
adopt the shell. Browser / mobile matrix and production build deferred to
APP-NAV-01B.

---

## Scope (what this commit does)

1. Navigation registry (`src/lib/navigation/registry.ts`):
   - Pure Server-safe module (no `'use client'`).
   - Stable `id` per entry, `label` / `path` / `description` / `icon` /
     `status` (`current` | `planned`) / `capability` (P3 metadata only) /
     `visibility` (desktop + mobile).
   - Two `current` entries today: Dashboard, Pipeline Check.
   - One `planned` entry reserved for P1.6 direct entry (NOT rendered).
   - Helpers: `CURRENT_NAV_ENTRIES`, `entriesForViewport(viewport)`,
     `findEntryByPath(path)`.

2. App Shell (`src/components/app-shell/`):
   - `app-shell.tsx` — Server Component. Header (sticky) with logo "HR
     Partner", `DesktopNav`, `ThemeSelector` (W05 R1 unchanged), and
     `MobileNav` trigger. Main slot renders `{children}`. Active entry
     announced via `sr-only` paragraph.
   - `desktop-nav.tsx` — Server Component. Compact horizontal nav bar,
     `hidden md:flex`. Active link gets `aria-current="page"`.
   - `mobile-nav.tsx` — Client Component. Radix UI `Dialog` shadcn-style
     pattern (Trigger + Portal + Overlay + Content + Close). Slide-in
     from left, `md:hidden` trigger. Closes on item click + ESC.

3. Integration (2 layout files):
   - `src/app/dashboard/layout.tsx` wraps `AppShell currentPath="/dashboard"`.
   - `src/app/pipeline-check/layout.tsx` wraps `AppShell currentPath="/pipeline-check"`.
   - Both page.tsx files (business data layer) are **untouched**.
   - Root `src/app/layout.tsx` is **untouched**.

4. Tests (3 new test files, 30 tests total):
   - `src/lib/navigation/registry.test.mjs` — 10 tests (pure registry).
   - `src/components/app-shell/app-shell.test.mjs` — 14 tests (source-string / structure).
   - `src/app/dashboard/layout.test.mjs` + `src/app/pipeline-check/layout.test.mjs` — 6 tests (boundary + page-untouched).

## Out of scope (explicit)

- **No RBAC / authorization.** `capability` is metadata only. Filter
  will be implemented in P3.
- **No real data fetch / no fake data route.** No new pages.
- **No change to business data, AI panels, or pilot Basic Auth.**
- **No change to mobile filter behavior** (kept non-sticky per W05 R1).
- **No direct-URL enforcement.** Middleware / server-side gate deferred.
- **No browser/mobile matrix, no production build verification, no
  Lighthouse / a11y pass.** Deferred to APP-NAV-01B per task brief.

## Dependency delta (real, per-package)

| Package | Version (installed) | License | Why |
|---|---|---|---|
| `radix-ui` (umbrella) | 1.6.7 | MIT | `Dialog` primitive for mobile Sheet (shadcn pattern). |
| `lucide-react` | 1.50.0 | MIT | `LayoutDashboard`, `Activity`, `ClipboardList`, `Menu`, `X` icons. |

`package.json` `dependencies` block changed only these 2 lines. No
devDependency change. No `clsx` / `tailwind-merge` / `class-variance-authority`
added (the existing `cn()` helper in `src/lib/utils.ts` is sufficient).

## LOC delta (added)

| File | LOC | Type |
|---|---:|---|
| `src/lib/navigation/registry.ts` | 116 | source (Server-safe module) |
| `src/components/app-shell/app-shell.tsx` | 65 | source (Server Component) |
| `src/components/app-shell/desktop-nav.tsx` | 41 | source (Server Component) |
| `src/components/app-shell/mobile-nav.tsx` | 109 | source (Client Component) |
| `src/app/dashboard/layout.tsx` | 8 | layout (Server Component) |
| `src/app/pipeline-check/layout.tsx` | 8 | layout (Server Component) |
| `src/lib/navigation/registry.test.mjs` | 79 | test |
| `src/components/app-shell/app-shell.test.mjs` | 116 | test |
| `src/app/dashboard/layout.test.mjs` | 31 | test |
| `src/app/pipeline-check/layout.test.mjs` | 27 | test |
| **TOTAL added** | **600** | 9 source files + 3 test files |

No file deleted. No file modified except `package.json` / `pnpm-lock.yaml`
(dep additions) and the existing `app/page.tsx` / root layout (untouched).

## Tests run (locally, this commit)

| Suite | Result |
|---|---|
| `node --test src/lib/navigation/registry.test.mjs` | 10/10 pass |
| `node --test src/components/app-shell/app-shell.test.mjs` | 14/14 pass |
| `node --test src/app/dashboard/layout.test.mjs src/app/pipeline-check/layout.test.mjs` | 6/6 pass |
| `pnpm test` (existing `test:main`) | 75/75 pass — no regression |
| `pnpm test:server` (existing `test:server`) | 75/75 pass — no regression |
| `pnpm tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm build` | pass (production compile, `/dashboard` and `/pipeline-check` still `ƒ Dynamic` per their existing `force-dynamic` directive) |
| `git diff --check` | clean (CRLF warnings are Windows line-ending defaults, not whitespace errors) |

## Deferred tests (not in this commit)

Per task FT0 scope, these are **not run** in this change set and are
deferred to APP-NAV-01B:

1. **Browser keyboard / focus acceptance** on `/dashboard` and
   `/pipeline-check` with real Chrome / Firefox / Safari. Verifies:
   - Tab cycle through header → nav → first interactive page element.
   - ESC closes mobile Sheet, focus returns to hamburger.
   - `aria-current="page"` announces correctly to VoiceOver / NVDA.
   - No `aria-modal` / `inert` regression on AI panels (untouched).

2. **Mobile matrix** (Chrome DevTools responsive):
   - Trigger visibility at `<768px` (sm).
   - Sheet renders inside viewport, no horizontal scroll.
   - Tap-through on overlay closes Sheet.

3. **Lighthouse a11y / perf baseline** on `/dashboard` and
   `/pipeline-check` with shell mounted.

4. **Production build verification** (the build above passed, but a
   full `next build --profile` bundle-size measurement for `radix-ui`
   + `lucide-react` is deferred to APP-NAV-01B — audit's
   `MEASURE_REQUIRED` marker for the umbrella is still open).

5. **Test registration.** The 3 new `.test.mjs` files are run via
   direct `node --test` invocations, **not** added to
   `package.json` `scripts.test` (this commit does not edit
   `package.json` scripts per task guardrail "không sửa
   package.json/pnpm-lock.yaml"). A follow-up change set or PR will
   append the new paths to `test:main` so CI picks them up.

## Checkpoint (what's left for APP-NAV-01B)

1. Browser / mobile / a11y matrix above.
2. Bundle-size measurement (`next build --profile` + source map
   inspection) for the 2 added packages.
3. `scripts.test:main` registration of 3 new test files.
4. Optional: collapse `mobile-nav.tsx` into a shadcn `Sheet` snippet
   (the current direct `radix-ui` `Dialog` usage is the shadcn
   `Sheet` pattern, so the refactor is a rename + snippet import,
   no behavior change).
5. Optional: convert the App Shell from "compact top nav" to a true
   fixed `Sidebar` on desktop (≥ md). Today's design intentionally
   keeps top nav to avoid touching the dashboard layout grid (which
   is fixed by W05 R1). Sidebar is a follow-up.

## Compatibility / integration notes

- `radix-ui` 1.6.7 (umbrella) is compatible with `next@16.3.8` and
  `react@19.2.8` on this worktree: `pnpm tsc --noEmit` and
  `pnpm build` both pass cleanly. Fall-back to individual
  `@radix-ui/react-*` packages is documented in the audit
  (`docs/audits/library-reuse-master.md`) but **not** needed in this
  commit.
- `lucide-react` 1.50.0 imports use named exports
  (`import { LayoutDashboard } from "lucide-react"`) so tree-shaking
  applies. No barrel re-export.
- Server Component / Client Component boundary is clean:
  - `app-shell.tsx` is a Server Component. It only renders props,
    no hooks, no event handlers.
  - `mobile-nav.tsx` is the only Client Component in the shell. It
    owns the `useState` for Sheet open/close and the
    `Dialog.Root` tree.
  - `desktop-nav.tsx` is a Server Component using `next/link`
    (which is the right primitive for `<Link>` per Next.js 16 docs).
- No `@/lib/ai/*` or `@/lib/ai-config/*` is imported in any new
  file. Server boundary preserved. `mobile-nav.tsx` does not use
  `localStorage` / `sessionStorage` / `document.cookie` / `console.log`
  (enforced by source-string test).

## Git state

- Branch: `feature/app-nav-01a` (tracking `origin/main`).
- One commit on top of `origin/main` (next push).
- No merge to main. No deploy.

## Status

**IMPLEMENTED_FAST_TRACK** — registry + App Shell compile, targeted
tests pass (30/30 new + 75/75 existing + 75/75 server), two routes
adopt the shell via layout wrappers, no business data layer touched.
