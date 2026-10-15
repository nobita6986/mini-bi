# Pre-W2-HF Project ↔ Team authority — T1B handoff (backend + migration #94)

> Status: `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_T1B_COMPLETE_FOR_T0_REVIEW`
> Branch: `codex/pre-w2-hf-project-team-authority-t1b` (isolated worktree, no primary-checkout changes).
> PR for CI only (draft, not for merge by T1): nobita6986/mini-bi#23.
> Base: `origin/main@3ffc9f8c887dcb8cb75eaef1bb17409aa7316228` (93 migration files verified immediately before work).
> T0 review-fix code commit: `dd50bd9` (reject future-effective revoke dates).

## 1. Preflight (per the T0 contract)

- Contract read in full: `docs/handoffs/pre-w2-hf-project-team-authority-contract-final.md` (status `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_T0_CONTRACT_READY_FOR_T1B`).
- `git fetch origin`; `origin/main` resolved to `3ffc9f8c887dcb8cb75eaef1bb17409aa7316228` and `supabase/migrations` contained exactly **93** migration files at that SHA.
- Slot **#94 was used** (`20261015100000_pre_w2_hf_project_team_authority.sql`); no pre-reservation, no other branch reserved it during implementation. No slot collision.
- Isolated worktree at `.worktrees/pre-w2-hf-project-team-t1b` (added under `.git/info/exclude`-style conventions). Primary checkout untouched.

## 2. Migration #94 — content map

`supabase/migrations/20261015100000_pre_w2_hf_project_team_authority.sql`

| Slot | File | SHA-256 (ledger-algorithm) |
| --- | --- | --- |
| #94 | `20261015100000_pre_w2_hf_project_team_authority.sql` | `e7cd3ca5aeb73d04d6bb4e096cebb45bb6d4a176f1dfff67c021e88fde849baf` |

- **Table `public.direct_entry_project_team_scopes`** (forced RLS, revoked from every role): `mapping_id` PK, `project_id` FK→`direct_entry_projects(project_id)`, `team_id` FK→`teams(team_id)`, `valid_from`, nullable exclusive `valid_to`, pair-version OCC `version` (≥1; 0 = never mapped, monotonic per pair on grant AND revoke), `granted_by_user_id`, `revoked_by_user_id`, `reason_id`, `revoke_reason_id`, `revoked_at`, `created_at`, `updated_at`; constraint `direct_entry_project_team_scopes_revocation_check` and `direct_entry_project_team_scopes_interval_check`.
- **Indexes**: partial unique open pair `direct_entry_project_team_scopes_open_pair_uidx` (≤1 open mapping per `(project_id, team_id)`), effective lookup index, team index.
- **Triggers**: `..._no_overlap` (advisory `project-team-scope:<project_id>` + interval `&&` guard, errcode 23P01), `..._touch` (updated_at), `..._history_guard` (append-only: no DELETE, identity immutable, only version+1 close transitions), `..._marker_guard` (zero-length cancellation marker reserved for the audited revoke, errcode 23514 otherwise).
- **Internal helpers** (SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role): `direct_entry_project_team_scope_effective(text,uuid)` (single mapping predicate: project ACTIVE + effective interval on the canonical authorization date), `direct_entry_lock_project_team_scope(text,uuid)` (`FOR UPDATE` + re-read).
- **Admin mapping RPCs** (SECURITY DEFINER, pinned search_path, **service_role-only EXECUTE; `authenticated` never granted**):
  - `direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer)` — bounded paginated read (`page`, `page_size`, `total`, `has_more`, `include_history`) with fields `mapping_id, project_id, project_display_name, team_id, team_display_name, team_code, valid_from, valid_to, effective, state(CURRENT|SCHEDULED|HISTORY), version, revoked_at, created_at` and envelope key `authorization_date`.
  - `direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)` — Full Admin triple + `all` scope; rejects missing project (P0002), inactive project/team or reserved team (22023), stale pair version (40001), overlap (23P01); idempotency by key/payload (`direct_entry_idempotency_*` chain) with `reason` and audit (`project_team_scope_grant`).
  - `direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)` — Full Admin triple; kills by lock order project row → mapping row; stale version 40001, already-closed 22023 (same request replays); closes the interval, never DELETE; audit `project_team_scope_revoke`.
- **Project Operations replacement** (identical signatures and envelopes to #72): `direct_entry_list_projects_admin`, `direct_entry_get_project_admin`, `direct_entry_list_project_manager_assignments`, `direct_entry_assign_project_manager`, `direct_entry_unassign_project_manager`. Leaders now additionally require `direct_entry_project_team_scope_effective(project, leader_team)`; admins keep full behavior. Leader gate order: project row lock (existing `direct_entry_lock_project`) → `direct_entry_lock_project_team_scope` → `direct_entry_lock_project_team_manager_context` → revalidate `direct_entry_project_team_scope_effective` → write. Assign/unassign may create/close PM rows only when the project is ACTIVE and mapped.
- **Project master remains denied** to Leaders in `direct_entry_create_project/_update_project/_set_project_active` (unchanged, 42501) and `can_manage_project_master` stays `v_authority <> 'team_manager_assign'` (false for Leaders).
- **Install-time self-check** pins column set, unique open-pair index, the `>=` interval check, three guard triggers, forced RLS, table/RPC ACL boundary, internal-helper revocation, fixed search_path, and forbids a new `direct_entry_assert_project_team_admin` resolver (reuses the canonical `direct_entry_assert_actor_app_user_admin` Full Admin triple guard from #92).

## 3. Interval-rule contract clarification (T0 D6 amendment)

The D6 addendum at `docs/handoffs/pre-w2-hf-project-team-authority-d6-amendment.md` narrows the strict interval rule only for an audited same-day cancellation:

- The DB check is `valid_to is null or valid_to >= valid_from`.
- Only the audited revoke RPC may write `valid_to = valid_from` (zero-length cancellation marker, W01D marker-guard style); a grant always writes `valid_to = null`.
- Future-effective revoke dates are rejected (`22023`); revocation is immediate on the canonical authorization date, with no scheduled future close.
- A current-date revoke on an older mapping removes access immediately. All other guard/lock order/reason/OCC/idempotency rules stand.

Recorded in the migration header, marker guard and self-check, plus the DB regression (same-day cancellation, current-date close, future-date rejection with no mapping/audit/idempotency residue).

## 4. Team Leader Project Operations behavior change (contract-mandated)

After this migration the leader no longer may close (unassign) a lingering PM assignment on an unmapped/inactive project; cleanup is Admin-only. This superseded the #72 rule "Inactive projects remain revocable" and is asserted in the adapted W02A regression (leader unassign → 42501; Accounting/operator completes the close successfully). Contract §Authorization step 2 + D3.

## 5. Ledger rebaseline (mechanical, for CI)

- 42 pinned-count / from-end anchor shifts (93→94, `.at(-N)` +1, `length-N` +1) across existing DB-lane tests, plus their companion strings (`names[names.length - x]`).
- `p3-1-w02b-vendor-lifecycle-db.test.mjs` append-only allowlist and `p3-1-hf-recruiter-alias-backfill.test.mjs` pinned tail now include #94.
- `p1.6-i04c3-s01-db.test.mjs` and `p1.6-s04c-document-scope-lock-db.test.mjs` measured function inventories bumped to the #94 truth (240/113/127).
- `scripts/p3-1-w02a-team-leader-project-manager.test.mjs` fixture: applies #94 after #72, seeds the mapping `(PROJECT_ACTIVE, TEAM_A)`, and asserts the newly forbidden leader-unassign-on-inactive path.
- `scripts/p3-1-w02a-concurrency.test.mjs` fixture: seeds the mapping so race denials come from the leader/team logic, not the mapping gate.

## 6. Tests added

- `scripts/pre-w2-hf-project-team-authority-db.test.mjs` (focused DB lane): 7/7 pass, including ledger/source + ACL checks, grant validation/OCC/idempotency/interval integrity, mapping-aware leader reads/writes, history preservation, and revoke-date semantics including future-date rejection with unchanged mapping/audit/idempotency state.
- `scripts/pre-w2-hf-project-team-authority-concurrency.test.mjs` (real PostgreSQL via initdb+pg_ctl; mirrors the W02A pattern): revoke-vs-assign and revoke-vs-unassign lock ordering both directions (revoke-first denies the leader 42501; leader-assign-first then revoke succeeds without rewriting the committed assignment), plus no idempotency residue for denied leader writes. Passed under the CI Real PostgreSQL job.
- `scripts/pre-w2-hf-project-team-authority-mutation.mjs` (manual, not in the CI lane): **7/7 RED**, including mapping read/write gates, wrong-team, project-master flag, Full Admin guard, revoke row lock, and future-effective revoke guard; migration restored byte-for-byte.

## 7. Gates

- `pnpm db:migrate -- --offline`: PASS (94 migrations).
- Focused DB lane: PASS 7/7.
- W02A Project Operations regression (PGlite): PASS 2/2 after fixture adaptation.
- W02A real-PostgreSQL concurrency: PASS.
- New real-PostgreSQL mapping race: PASS.
- Mutation probes: 7/7 RED + byte-for-byte restore.
- Sharded PGlite plan shards 1-4: PASS (CI proves).
- Real-PostgreSQL CI job: PASS.
- `pnpm typecheck` (with `next typegen`): PASS.
- `pnpm lint`: 0 errors (13 pre-existing warnings).
- `pnpm build`: PASS via `next build --webpack`. `next build` (Turbopack) fails locally ONLY because the isolated worktree uses a junctioned `node_modules` shared with the primary checkout ("Symlink node_modules is invalid, it points out of the filesystem root") — the CI Static job runs the real build on a pristine checkout and PASSes, so the toolchain is fine.
- `pnpm secrets:check`: PASS (1760 files).
- `pnpm docs:check`: PASS.
- `git diff --check`: PASS (whitespace).
- T0 follow-up local checks: focused DB lane 7/7, offline migration validation 94/94, docs 6/6, secrets scan clean (1762 files), `git diff --check` clean. GitHub CI run `38686303164` for branch head `086b4a9` passed all jobs; the PR check page remains authoritative for later runs.

## 8. ACL summary

- Table: forced RLS; `SELECT/INSERT/UPDATE/DELETE` revoked from `public`, `anon`, `authenticated`, `service_role` (direct writes impossible even for the superuser-bypass roles via forced RLS).
- `direct_entry_list_project_team_scopes_admin`, `direct_entry_grant_project_team_scope`, `direct_entry_revoke_project_team_scope`, plus the five replaced Project Operations RPCs: `EXECUTE` granted to `service_role` ONLY; revoked from `public`, `anon`, `authenticated`. Fixed `search_path=pg_catalog, public`; SECDEF.
- Internal helpers `direct_entry_project_team_scope_effective`, `direct_entry_lock_project_team_scope`, `direct_entry_project_team_scopes_no_overlap`, `direct_entry_project_team_scopes_touch`, `direct_entry_project_team_scopes_history_guard`, `direct_entry_project_team_scopes_marker_guard`: never executable (revoked from every role).
- Existing `direct_entry_assert_project_operation_authority` / `direct_entry_assert_project_admin` semantics unchanged (still no project parameter); the mapping gate is added at each affected call site instead.
- Audit vocabulary: `project_team_scope_grant`, `project_team_scope_revoke` with `scope_kind='all'` each.

## 9. RPC signatures/envelopes handed to T1A

- `direct_entry_list_project_team_scopes_admin(auth uuid, app uuid, project_id text default null, team_id uuid default null, include_history boolean default false, page integer default 1, page_size integer default 25)` → jsonb `{ authorization_date, include_history, page, page_size, total, has_more, mappings[] }` with per-mapping keys `mapping_id, project_id, project_display_name, team_id, team_display_name, team_code, valid_from, valid_to, effective, state, version, revoked_at, created_at`.
- `direct_entry_grant_project_team_scope(auth uuid, app uuid, project_id text, team_id uuid, expected_pair_version integer, effective_from date, reason text, idempotency_key text)` → `{ mapping_id, project_id, team_id, valid_from, valid_to, version, created: true }`.
- `direct_entry_revoke_project_team_scope(auth uuid, app uuid, mapping_id uuid, expected_pair_version integer, effective_to date, reason text, idempotency_key text)` → `{ mapping_id, project_id, team_id, valid_to, version, revoked: true }`; same request replays the stored result; a stale or already-revoked attempt 40001/22023.
- Project Operations RPC signatures and envelopes are unchanged from #72 (`requestformation` layer for T1A can keep shape); only their mapping-aware authority changed server-side. `can_manage_project_master` remains false for Leaders; `can_assign_managers` becomes mapping-aware.

## 10. Blockers / notes for T0

- Contract §D6 is narrowed only by the same-day audited cancellation exception; future-effective revocation is prohibited. See the committed amendment linked in §3.
- `pnpm build` locally uses the shared-junction workaround; the real (Turbopack-disabled) webpack build passes both locally and in CI — no code-level blocker.
- No DB against production was touched; migration is not applied anywhere yet; no Vercel/VPS deployment executed.

## 11. What T1A/C must do next

- T1A consumes the three mapping RPCs (plus the already-projected flags) for the Collaboration Admin_surface; the UI must render the mapping projection keys as-is and the Project Operations page empty state for mapped-light Leaders.
- T1C re-verifies cross-layer behavior on merged code (API↔RPC matrix, race, inactive fail-closed, history preservation) and rebaselines any further ledger anchors if a #95 appears before the merge.
