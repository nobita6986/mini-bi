# P3-W07D — Draft scope precedence + historical draft edit

Status: `P3-W07D_DRAFT_SCOPE_HISTORICAL_EDIT_LOCAL_PASS_AWAITING_INTEGRATION`
Base: `origin/main@6f5d38e` (branch `feature/p3-w07d-draft-scope-precedence-hotfix`)
Task: T1B, backend/DB contract. LOCAL ONLY — no merge, no deploy, no Production mutation,
no write to `main`, migrations #1-#46 byte-identical.

## Root cause (read-only Production evidence, counts/booleans only)

`direct_entry_assert_draft_access` / `..._assert_entry_access` required EXACTLY one
matching scope grant (`select count(*), min(scope_kind) ... if v_matches <> 1 then raise
42501`). The reporting owner account holds `own` + `all`, both `valid_from = 2026-10-04`,
over an imported DRAFT batch of 17 rows (14 at `2026-10-02`, 3 at `2026-10-05`).

- 3 rows at `2026-10-05` match TWO grants -> `42501 draft scope/capability denied` -> the
  whole `direct_entry_list_own_drafts` call fails -> UI collapses to `DRAFTS_UNAVAILABLE`.
- 14 rows at `2026-10-02` match ZERO grants at their own work date -> neither listed nor
  editable (fail-closed, but the historical edit is impossible).

Evidence: `matched_accounts 1`, `enabled 1`, `all_scope {total 1, open 1,
effective_at_historical 0}`, `owned_drafts {total 17, before_scope_start 14,
from_scope_start 3}`, `probe {denied true, code 42501}`.

## Delta

1. `supabase/migrations/20261008080000_p3_w07d_draft_scope_precedence.sql` (NEW):
   - both assert helpers resolve the STRONGEST effective scope `all > team > own`
     (`bool_or` per kind) instead of demanding one match. Zero matching effective scopes
     still fail closed with `42501`; the capability of the WINNING kind must still be
     effective; `p_required_scope` semantics unchanged; ACLs re-asserted (revoked from
     public/anon/authenticated/service_role, i.e. the EXACT revoke-only posture migration
     #3 defined for these two internal helpers — no grant is added, so the derived
     function/service_role inventory stays `[80, 39, 41]`) + data-agnostic self-check
     that now also fails if an internal helper becomes PostgREST-callable.
   - `direct_entry_update_draft_row` compares the patch with the PERSISTED row, not with
     the patch shape: only a real `recruiter_id` / `first_work_date` change re-derives
     provider/team, resolved at the row's OWN effective date (`v_new_work_date`) — the
     same date `direct_entry_validate_identity` checks, so a derived identity can never
     disagree with the row invariant. A changed recruiter with no effective team fails
     closed with `P0001 draft identity change needs an explicit team rule` (Vendor case)
     instead of a misleading `42501`.
2. `scripts/p3-w07d-historical-all-scope.mjs` (NEW) — data-plane op for that one account.
   `--check`: `begin read only` + rollback, prints counts/booleans only. `--apply` refuses
   BEFORE opening any connection unless `P3_W07D_CONFIRM == P3_W07D_HISTORICAL_ALL_SCOPE_APPLY`;
   then requires exactly one enabled account and exactly one open `all` grant, is idempotent
   (`ALREADY_EFFECTIVE`), writes a `direct_entry_audit_events` row (`w07d_historical_all_scope`)
   and commits only when it applied. Exactly one mode flag is accepted.
3. `src/lib/direct-entry/draft-error-copy.ts` (NEW) — the only place that turns a sanitized
   code into the two contract sentences; no SQL text, UUID, provider wording or PII.
4. `src/lib/direct-entry/draft-api.ts` — list `denied` -> `DRAFT_SCOPE_DENIED` 403 (was
   `ACTOR_NOT_AVAILABLE`); draft PATCH validates the PAGE catalog at `todayDateIso()`
   (HCM) instead of `parsed.patch.first_work_date`.
5. `src/components/direct-entry/direct-entry-live.tsx` — both draft load paths forward the
   sanitized server code; the notice renders the exact W07D copy.
6. Migration inventory rebaseline (every assertion that counted 46 source files — exactly
   the files the W05A-R1 rebaseline touched): `p1.6-i04c3-i03-live-acceptance.mjs`,
   `p1.6-i04c3-s01-db.test.mjs`, `p1.6-production-catalog-bootstrap.test.mjs`,
   `p1.6-s04c-change-request-read-db.test.mjs`, `p1.6-s04c-change-request-read-local-acceptance.mjs`,
   `p1.6-s04c-document-scope-lock-db.test.mjs`, `p1.6-s04c-policy-closure-db.test.mjs`,
   `p1.6-s04c-submission-read-db.test.mjs`, `p1.6-s04c-submission-read-local-acceptance.mjs`,
   `p2-w04a-migration.test.mjs` (last-file + `names.length`), `p2-w04a-reconcile-verify.test.mjs`
   (last-file + W04B index from the end), `p3-w07b-project-manager-scope.test.mjs`.
   Function / service_role inventory assertions are NOT touched (80 functions, 39 with
   service_role EXECUTE — unchanged).
7. Tests: `scripts/p3-w07d-draft-scope-db.test.mjs` (11 PGlite cases),
   `scripts/p3-w07d-draft-error-copy.test.mjs` (5), `scripts/p3-w07d-data-plane-safety.test.mjs`
   (5 offline), wired as `test:p3-w07d` inside canonical `pnpm test`.

Required copy (exact):
- scope/grant: `Không tải được bản nháp do phạm vi quyền chưa phù hợp. Mã lỗi: DRAFT_SCOPE_DENIED.`
- transient:  `Không tải được bản nháp do máy chủ đang bận. Mã lỗi: DRAFTS_UNAVAILABLE.`

## Migration slot — T0 decision required

`origin/main` holds 46 migrations (#46 = `20261008060000_p3_w07c_r3_issue_place_server_default.sql`).
On this branch the W07D file is therefore #47, but its timestamp `20261008080000`
deliberately sorts AFTER W05A's `20261008070000`, so once W05A integrates it becomes #48 —
W07D does NOT claim W05A's slot and needs no renumbering either way. Ledger on this branch:
`pnpm db:migrate --offline` = 47 valid; `--dry-run` = 46 applied (checksum matches) / 1 pending
/ 0 mismatch. Only the filename would change if T0 prefers another slot; there is no
cross-migration dependency. Rebaseline note: the same 13 source-count assertions are bumped to
47 by both branches, so the second branch to integrate must bump them to 48.

## Gates (local, all green)

- `pnpm test:p3-w07d` — 21/21 (11 PGlite + 5 copy + 5 data-plane safety).
- `pnpm test` (canonical) — 1371/1371, 0 fail.
- Count-affected files re-run after the rebaseline: `p1.6-w04-s04c-s03b3-r1` 15/15,
  `p1.6-i04c2b` 16/16, `p3-w07b-project-scope` 2/2, `p1.6-i04c3-s01` 10/10,
  `p2-w04a-migration` + `p2-w04a-reconcile-verify` 12/12, read-db 13/13, both local
  acceptance scripts exit 0.
- `pnpm exec next typegen` ok; `pnpm typecheck` ok; `pnpm lint` 0 errors (10 pre-existing
  warnings, none introduced here); `pnpm build` ok; `git diff --check` clean.
- `pnpm db:migrate --offline` = 47 valid / `--dry-run` = 46 applied (checksum matches),
  1 pending, 0 mismatch — both read-only, no DB write. Production `--apply` NOT executed.

## Limitations / open items for T0

- Until `--apply` runs in the integration lane, the 14 historical rows stay unauthorized at
  their own work date: the precedence fix alone cannot authorize a row no grant covers.
  `--check` was executed read-only against Production; `--apply` was NOT executed.
- PATCH validates the page catalog at today's HCM date (consistent with the W07C-R6-R1 UI
  picker). A row whose recruiter/project left today's catalog therefore cannot be saved; the
  DB still re-validates activity (`inactive draft master`, 22023) independently.
- `direct_entry_validate_identity` still raises a bare `23514` when a date-only move lands
  outside the recruiter's team window; `classify()` maps `23514` on `update` to
  `unavailable` (HTTP 500). Pre-existing, unchanged here, listed for a future pass.
- Full-profile fields (DOB/CCCD/address/phone) stay read-only; untouched by this task.
- W06C was not started or touched.
