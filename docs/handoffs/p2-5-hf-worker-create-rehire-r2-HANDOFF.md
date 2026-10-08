# P2.5-HF-R2 — one canonical CCCD rule for guards, lookup and preflight

Branch `feature/p2-5-hf-worker-create-rehire`, continues from `e917d16` (P2.5-HF-R1 #59).
Code commit: `082982330fdcb52c09daaf29ae643e96c2b9daf0`. Migration: `supabase/migrations/20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql` (#60; the #58/#59 files are untouched).
Gates: `pnpm test` exit 0 — 1658 tests / 1658 pass / 0 fail; typecheck, lint 0 errors (12 pre-existing warnings), build, docs:check 6/6, secrets:check, `git diff --check`, `db:migrate --offline` = 60 valid.

## Verified hole
- #58 compared the stored national_id with `btrim` while #59's lookup compared digits only, so a historical value that still carries formatting characters is one person for the lookup and a different string for the guard: a digits-only episode could be created while that episode was still active.
- The DB validator (W07C-R2 #46) already enforces digits only with length 9/12; the permissive path was the legacy TS contract `direct-entry-v1.validateWorkerDetails` (≤64 chars) used by the draft/quick-add write-api.

## Delta
- `src/lib/contracts/national-id.ts`: the single rule (ASCII digits, business length 9 or 12, leading zero preserved as text) plus a digits-only reading used to compare legacy values. `direct-entry-v1` (`WORKER_DETAILS_INVALID`), `full-profile-contract` (`NATIONAL_ID_INVALID`) and the paste path now all call it, so no write path accepts a formatted value; nothing rewrites stored data.
- #60 helpers: `direct_entry_canonical_national_id(text)` (digit form, NULL when the value holds no digit), `direct_entry_is_canonical_national_id(text)`, `direct_entry_national_id_lock_key(text)` = `hashtextextended('worker-episode:'||digits)`.
- #60 re-creates the create guard, the status-event guard and the lookup with that shared rule and that shared lock key; the lookup also takes the lock and refuses a lookup key whose digits are not 9/12 (22023). Every other semantic — one active episode per CCCD, reopen forbidden, minimum field set, manager/all-scope authority — is unchanged.
- `direct_entry_national_id_canonical_audit()`: counts only (episodes with a CCCD, non-canonical, unmatchable, and canonical CCCDs owning more than one active episode). Granted to service_role for a read-only Production preflight; it returns no PII and repairs nothing.
- #60 install-time gate: raises `p2_5_hf_r2_national_id_preflight_failed` (23514) with a hint carrying the two counts only, when `noncanonical_entries > 0` or `duplicate_active_cccd_groups > 0`.

## Regression (all in `scripts/p2-5-hf-r2-cccd-canonicalization-db.test.mjs`, 7/7, plus `src/lib/contracts/national-id.test.mjs`, 2/2)
- Historical `"0123 456 78901"` active + new digits-only create → refused `23505 worker_active_episode_exists`, no row written, and an unrelated CCCD is still creatable.
- Malformed values (`"0123 456 78901"`, `"012.345.678"`, `"NOT-REAL"`, 8 digits, 13 digits, leading/trailing space) are refused by the legacy batch, full-profile v1 and v2 (23514/22023) and by the TS contract, while the same payload with a canonical value is accepted.
- Leading zero: 9- and 12-digit values are stored as text unchanged, both spellings are found by the lookup, and `"12345678"` / `"NOT-REAL"` / 13 digits are refused as lookup keys.
- Guards and lookup agree on one identity: the lookup returns the very legacy episode the create guard blocks on, with consistent `active_episode_exists`/`rehire_allowed`, and no CCCD appears in either spelling in the response.
- Preflight audit on a clean database is all zeros; after seeding legacy values it reports counts only, leaks no PII and rewrites nothing (the stored formatted value is still there afterwards).
- The #60 self-check asserts that both spellings map to one lock key and that `direct_entry_valid_worker_details` still rejects formatted, 8-digit and 13-digit values.

## Not proven — concurrency
- The repo's PostgreSQL harnesses (`scripts/*-acceptance.mjs`, `scripts/apply-migrations.mjs`) need credentials. A local PostgreSQL 18 service exists but rejects every available credential; `.env.local` points at the Production pooler, which must not be used; `@electric-sql/pglite-socket` is not installed and no dependency may be added; PGlite is single-connection. Two real connections were therefore **not** run: concurrency is not proven and no race-test PASS is claimed — only the shared lock key asserted at source level.

## Production precondition
- #58, #59 and #60 belong to one maintenance window. #60 refuses to install while any live episode carries a non-canonical CCN/CCCD or while one canonical CCCD already owns more than one active episode, so T0 must run `direct_entry_national_id_canonical_audit()` and resolve those rows manually — the migration never repairs data. No Production apply, deploy, merge or push to `main`.
