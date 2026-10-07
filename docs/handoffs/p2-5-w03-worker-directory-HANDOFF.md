# P2.5-W03 - Worker directory server projection (handoff)

Status: `P2.5-W03_LOCAL_PASS_AWAITING_T0_REVIEW`
Base: `origin/main@dcf4a6ac56deb6e236ced3184639d77c75eef8d0` (contains P2.5-W02-R2). Final SHA = branch tip (`git log -1`, local = remote, quoted in the report).
Branch `feature/p2-5-w03-worker-directory`, worktree `C:\CodeApp\BI-p2-5-w03-worker-directory`; no Production apply, no deploy, no main push.

## Delta

- Migration **#52** `20261008120000_p2_5_w03_worker_directory_projection.sql` (2 functions, migration NO schema change beyond one service-role RPC + one internal guard):
  - `direct_entry_worker_directory_audience(uuid, uuid, text, text)` internal: revoked from every role. `recruited` = verified + effective app-user/recruiter link (ambiguous link fails closed); `managed` = the W07B/W02 effective-assignment predicate, and a requested project outside the assignment is refused (42501); `all` = reuse of `direct_entry_assert_project_admin` (entry_admin + effective all scope). `created_by_user_id` is never an audience.
  - `direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)` service_role only: keyset pagination (`first_work_date desc, entry_id desc`, LIMIT page_size + 1, cursor `YYYYMMDD:entry_id`), server-side filters (project_id, recruiter_id, employment_status = latest status event, SUBMITTED + not deleted), and one row projection: identity + placement + `pending_request` + `last_decision` + `is_project_manager` + `allowed_actions`.
  - Field-sensitive: raw PII is never returned by the directory (the capability-gated detail read owns it); `payment` is present only with an effective `payment_view` grant and the account number is masked to the last four digits exactly like `direct_entry_read_projection`.
  - `allowed_actions` is server-supplied and `propose_change` stays `false` with code `PROPOSE_PENDING_W04_POLICY`; the #52 self-check fails the migration if that constant is changed before W04 closes the change-request audience policy. `is_project_manager` is exposed as data so W04/W06 can flip the action without a contract change.
- Server boundary (reuse, no second framework): `worker-directory-contract.ts` (strict query/row/page projectors), `worker-directory-repository.ts` (one RPC, shared SQLSTATE classifier), `worker-directory-api.ts`, and `src/app/api/direct-entry/workers/route.ts` under the existing `DIRECT_ENTRY_API_ENABLED` gate. Uploader history keeps using the existing own-submission RPC; no table access, no client-supplied identity.
- Ledger rebaselined to 52 files (last = W03) and the derived function inventory to `{ total: 109, service_role: 54, internal: 55 }` / `[109, 54, 55]`.
- Out of scope (unchanged): no UI/page, no project CRUD, no change-request engine change, no W04 policy.

## Tests

- `pnpm test:p2.5-w03` 22/22 (new, wired into canonical `pnpm test`): DB 8 (uploader != recruiter != PM; multi-manager; cross-project and out-of-scope project denied; all audience needs capability + all scope; keyset paging with no duplicate row; filters; payment mask + PII absence; allowed_actions; ACL) and server 14 (query/row/page fail-closed projection, one-RPC repository, error mapping, route source guards).
- Regression explicitly required by the task: an uploader who is neither the recruiter of record nor a project manager sees no directory rows, and the canonical recruiter sees only their own `recruiter_id`.

## Gates

- `pnpm test:p2.5-w03` 22/22; `pnpm test` 1494/1494, 0 fail; `pnpm test:p2.5-w02` 23/23; typegen+typecheck exit 0; lint 0 errors (12 pre-existing warnings); build exit 0; `docs:check` 6/6; `secrets:check` ĐẠT; `git diff --check` clean; W07A importer 14/14.
- `pnpm db:migrate --offline` **52 valid**; Production read-only dry-run **49 applied / 3 pending (#50 + #51 + #52) / 0 mismatch**.

## Migration / Production status

- #50 (W07E), #51 (W02) and #52 (W03) all stay PENDING and unapplied; #50 on main is untouched; no new ledger runner. Wording unchanged: **CREATE resolver fallback already closed; audience/read/withdraw policy still pending W04.**

## Blocker

- W04 must close the change-request audience/read/withdraw policy (and an apply procedure with no intermediate insecure state) before #50/#51/#52 ship and before `propose_change` may be advertised as available. W06 owns the worker-operations UI on top of this contract.
