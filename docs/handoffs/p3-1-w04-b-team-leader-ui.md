# P3.1-W04-B — Team Leader UI

## Scope and lineage

- Base: `09376b8ed44bc304b827f099f9597a4b82980ff0`
- Branch: `feature/p3-1-w04-b-team-leader-ui`
- Implementation/final code SHA: `569cf730472f8ff8d2d1effd0559962e73e4ae0d`
- Handoff commit: separate documentation-only follow-up commit
- Migration ledger: unchanged at 74; no migration was added or edited.

Integrated the W01D/A2 Team Leader API into the existing Team Catalog workflow. The `/admin/catalog/teams` page, its page-access gate, backend/API, database, capability model, and server authority are unchanged.

## Changed files

- `src/components/admin/team-catalog-manager.tsx` — adds one Team Leader dialog entry per team row and synchronizes authoritative team-version changes; coordinates team-scoped locks with existing Team Catalog mutations.
- `src/components/admin/team-leader-manager.tsx` — current/scheduled/history views, bounded paging, candidate search, designate/replace/revoke forms, sanitized errors, exact-intent retry, and authoritative reload.
- `src/lib/admin/team-leader-model.ts` — strict projections, bounded query builders, OCC/idempotency request builders, sanitized mutation mapping, and complete authoritative snapshot validation.
- `src/components/admin/team-leader-manager.test.mjs` and `src/lib/admin/team-leader-model.test.mjs` — focused UI/model regression and invariant coverage.
- `package.json` — registers `test:p3-1-w04-b-team-leader-ui` once and includes it once in canonical `pnpm test`.

## Contract and reuse

- Reuses the W01D/A2 routes and strict contract projections. Candidate UI accepts only `{ app_user_id, display_name, personnel_code }`; leader rows show only their projected display name and dates.
- List reads are three parallel team-scoped requests (current, scheduled, history), page size 25, page bound 1–1000. Candidate lookup is on demand and bounded.
- Designate/replace/revoke requests use the team ID in the route, effective date, reason, team version as `expected_version`, and an idempotency key in both body and header. Retry submits the stored intent unchanged.
- The server remains the only authority. Existing server-side Team Catalog page gate remains in place; client UI does not derive access from role, title, email, or display name.
- Mutation locks are keyed by team. Applied/conflicted results retain the lock until team detail and all three strict lists reload successfully. Failed authoritative reload keeps the lock and exposes retry.
- Reserved/inactive or invalid outcomes, not-found, denied, conflict, and unavailable states use sanitized Vietnamese messages; raw RPC/database details are never rendered.

## Verification

- Focused lane: **PASS**, 14 tests.
- W01D/A2 and W04 A1/A2, A3, A4 focused regressions: **PASS**.
- Mutation probes: **PASS** — removing parallel state reads, rendering the candidate UUID, dropping the team OCC version, and changing the idempotency key on retry each made the focused lane fail; source restored byte-identically after each probe.
- `next typegen`: **PASS**.
- `pnpm typecheck`: **PASS**.
- Full `pnpm lint`: **PASS**, with 15 existing warnings and no errors.
- `pnpm docs:check`: **PASS**.
- `pnpm secrets:check`: **PASS**.
- `pnpm db:migrate -- --offline`: **PASS**, 74 migrations; no database access.
- `pnpm test`: **PASS**, canonical suite exited 0; includes focused Team Leader UI lane.
- `pnpm build`: **PASS**, Next.js production build completed.
- `git diff --check`: **PASS**.

All required gates passed. Full lint reports 15 existing warnings and no errors. Offline migration validation confirms 74 migrations and no database access.

No production query/apply, deployment, browser, Playwright, CUA, or UAT was performed.
