# P3.1-W04-A4 — Team Catalog UI handoff

## Delta

- Stacked on W04-A3-R1 base `c61e8c05055f379c375352dffbd2e4b3c90c716e`; no rebase or main merge.
- Added the internal Admin “Nhóm” section and a separately guarded `/admin/catalog/teams` page. Admin access continues to use the canonical `catalog_master_manage@all OR Full Admin` predicate; client state is not an authority source.
- Added the Team Catalog manager and a team-specific model. It reuses W01C-A strict projectors/API routes, shared `Alert`, `Card`, `EmptyState`, and `ErrorState`, and the existing reason/version/idempotency validators.
- Shared `Alert` now accepts an explicit `role` while retaining its `status` default; the denied-list state uses `alert` semantics.
- Team list requests always use explicit `page_size=25`; response envelope, query echo, paging, and every team row are projected strictly. Any reserved Vendor row rejects the entire response; the reserved code is rejected for create, and update bodies cannot carry a code.
- Create, update, and set-active use exact contract bodies and matching `Idempotency-Key` headers. A network retry sends the retained intent unchanged. No parallel route, RPC, table access, dependency, or authority input was introduced.
- OCC is scoped by team ID; create has its own lock. The dialog only renders the matching conflict. Applied writes and conflicts remain locked until a strict authoritative detail reload succeeds, or (for create) an exact-code list reload confirms the row. Reload failures keep the lock and reload action; a team 404 clears only that team’s stale state and refreshes the list.
- W04-B Team Leader designation/revocation remains deferred. Browser UAT was not run; that is Owner-only.

## Files changed

- `package.json`
- `src/app/admin/catalog/teams/page.tsx`
- `src/components/admin/team-catalog-manager.tsx`
- `src/components/admin/team-catalog-manager.test.mjs`
- `src/components/ui/alert.tsx`
- `src/lib/admin/team-catalog-model.ts`
- `src/lib/admin/team-catalog-model.test.mjs`
- `src/lib/admin/admin-navigation.ts`
- `src/lib/admin/admin-navigation.test.mjs`
- `src/lib/auth/direct-entry-page-access.ts`
- `src/lib/auth/direct-entry-page-access.test.mjs`

## Verification

- Focused A4 lane: 19/19 passing; W04-A1/A2: 146/146; W04-A3: 21/21.
- Backend lanes: W01C-A 25/25, W01C-B 34/34, W01B 29/29.
- Full canonical `pnpm test`: 58 test programs, 2,108 tests, 0 failures; the new focused lane runs once in the canonical chain.
- Next typegen, TypeScript check, and production build: passed.
- Targeted ESLint on changed source/tests: 0 warnings. Full lint: 0 errors, 15 pre-existing warnings in unrelated files.
- `docs:check`: 6/6 examples; `secrets:check`: 1,096 files scanned, no findings; offline migration validation: 71 valid migrations, no database access.
- Eight required mutation probes were killed; all probed files were restored byte-identically. `git diff --check` passed. `team-catalog-model.ts` has no NUL/control bytes and is recognized as text.
- Owner’s browser UAT was not run. Push and final clean-worktree verification are recorded after commit.
