# P3.1-W04-C — Vendor Catalog UI handoff

## Scope and implementation

- Base: `5f41caf689dbfd52bb889744f227aa659da393db` (`origin/main` verified before work).
- Branch: `feature/p3-1-w04-c-vendor-ui`.
- Reuses the existing W02-B Vendor Catalog projection, API routes and migration #75. No API, server-library, schema, migration, dependency, or `package.json` changes.
- Adds an internal Admin “Nhà cung cấp” navigation item and a separately guarded `/admin/catalog/vendors` page. Access uses the existing `catalog_master_manage@all OR Full Admin` Admin-area decision.
- The manager provides bounded search, page navigation, inactive filtering, loading/empty/denied/error/unavailable and retry states.
- Create uses API `expected_version: 0`, business `vendor_id`, `display_name`, `valid_from`, reason and idempotency key. Update carries only `display_name`, expected version, reason and idempotency key. Activate/deactivate uses the dedicated route with active value, expected version, reason and idempotency key.
- Responses and query echoes are strictly projected with the existing Vendor contract projectors. Recruiter identity metadata is never rendered or sent from the client; display uses business vendor ID and name only.
- Applied writes and stale OCC conflicts remain locked until a strict authoritative detail reload succeeds; create is confirmed with an exact vendor-ID list query. Network/unknown-result retries reuse the exact mutation intent and idempotency key.
- Browser/UAT was not run (Owner-owned).

## Changed files

- `src/app/admin/admin-access.test.mjs`
- `src/app/admin/catalog/vendors/page.tsx`
- `src/components/admin/vendor-catalog-manager.test.mjs`
- `src/components/admin/vendor-catalog-manager.tsx`
- `src/lib/admin/admin-navigation.test.mjs`
- `src/lib/admin/admin-navigation.ts`
- `src/lib/admin/vendor-catalog-model.test.mjs`
- `src/lib/admin/vendor-catalog-model.ts`
- `src/lib/auth/direct-entry-page-access.test.mjs`
- `src/lib/auth/direct-entry-page-access.ts`
- `docs/handoffs/p3-1-w04-c-vendor-catalog-ui.md`

## Verification

- Focused Vendor UI/navigation/page-guard lane: `node --test src/lib/admin/vendor-catalog-model.test.mjs src/components/admin/vendor-catalog-manager.test.mjs src/lib/admin/admin-navigation.test.mjs src/app/admin/admin-access.test.mjs src/lib/auth/direct-entry-page-access.test.mjs` — 25/25 passing.
- Existing Vendor backend API tests with server-only condition: `node --conditions=react-server --test src/lib/direct-entry/vendor-catalog-api.test.mjs` — 10/10 passing.
- Mutation probe removed the active-badge no-wrap class; focused test failed as expected. Source was restored byte-identically (Git blob object ID `6c4e79f835cde23e92b8e6b2ad6f4cf2574d9e4d`) and the focused lane passed again.
- `next typegen`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS, 0 errors and 15 pre-existing warnings in unrelated files.
- `pnpm build`: PASS; `/admin/catalog/vendors` and existing API routes were generated.
- `pnpm docs:check`: PASS, 6/6 examples.
- `pnpm secrets:check`: PASS, no secrets found.
- `pnpm db:migrate -- --offline`: PASS, 78 migration files validated; no database connection or apply occurred.
- `git diff --check`: PASS.
- Canonical `pnpm test`: PASS; all configured test programs completed with zero failures, including the locked W02-B Vendor Catalog backend/database lane.

## Release boundaries

- No backend/API/schema/migration/dependency/package-script changes.
- No Production query or apply, deployment, or browser/UAT.
- No merge, rebase, amend, or force-push.
