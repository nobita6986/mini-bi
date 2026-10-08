# P2.5-HF-R1 — Episode invariant on the status path + server lookup boundary

Branch `feature/p2-5-hf-worker-create-rehire`, continues from `3bc7171` (P2.5-HF #58, unchanged).
Code commit: `dd2b9784ad0e5e21da6c31a44f42e869b8192176`. Migration: `supabase/migrations/20261008190000_p2_5_hf_r1_episode_status_guard_and_lookup_boundary.sql` (#59).
Gates: `pnpm test` exit 0 — 1649 tests / 1649 pass / 0 fail; typecheck, lint 0 errors (12 pre-existing warnings), build, docs:check 6/6, secrets:check, `git diff --check`, `db:migrate --offline` = 59 valid.

## Finding 1 — the invariant now covers every status write
- `direct_entry_guard_episode_status_event()` + trigger `direct_entry_episode_status_guard` (BEFORE INSERT on `direct_entry_employment_status_events`): the single choke point of `direct_entry_apply_employment_status`, `direct_entry_correct_latest_status` and the WORK_STATUS change-request apply.
- Same normalization (btrim of `worker_details->national_id->>'value'` where state='provided') and the same `pg_advisory_xact_lock('worker-episode:'||cccd)` key as #58, so a create and a status change for one CCCD serialize instead of both passing their own check.
- Rule 1: a non-OFF event is refused (`23505 worker_active_episode_exists`) while another episode of that CCCD has a latest status other than OFF — ON, UNCONFIRMED and missing status fail closed.
- Rule 2: a non-OFF event with `supersedes_event_id is null` is refused (`23505 worker_episode_reopen_forbidden`) when the target episode's own latest status is OFF: a closed episode is never reopened, a return to work is a new profile. The correction path (supersedes set, DRAFT-only) is unchanged.
- Regression (required): old episode OFF + new episode ON → the WORK_STATUS OFF→ON approval is refused atomically — entry version, status events, audit and idempotency rows unchanged, change request still PENDING v1. Direct status apply on the submitted episode is refused as well (W04 DRAFT-only), so both layers are asserted.
- Race: both paths take the identical advisory lock. PGlite is single-connection, so true concurrent writers cannot be executed here; the evidence is the shared lock key asserted at source level plus the sequential create→rehire→reopen regression. Not claimed as a concurrency PASS.
- Policy note: reopening an OFF episode is now refused for every caller through the append-only path. Only `direct_entry_correct_latest_status` (supersede, DRAFT-only) can still turn OFF back to ON; no other correction path changed.

## Finding 2 — server boundary for the lookup
- `GET /api/direct-entry/workers/episodes` → route (DIRECT_ENTRY_API_ENABLED gate first) → `worker-episode-lookup-api` (strict query validation, server session actor, sanitized response) → `worker-episode-lookup-repository` (service-role RPC only) → `worker-episode-lookup-contract` (exact-key projection). The browser never calls the RPC and never supplies identity.
- Query: `project_id` required; `display_name` OR `national_id` (both allowed) required; `page_size` 1..50 (default 20); `offset` 0..5000; unknown and duplicate parameters rejected.
- CCCD: digits only (separators dropped, leading zero preserved as text), exact match; a mismatched name never hides the CCCD match. Name search is project scoped, so it is never a global directory.
- #59 replaces the #58 signature with `(uuid,uuid,text,text,text,integer,integer)`; the minimum field set per episode is unchanged and no full CCCD, DOB, address, phone, bank or document value is returned. Only an effective manager of the target project or an all-scope administrator may call it.

## Finding 3 — safe error codes
- `full-profile-repository.ts` maps `worker_active_episode_exists` → `WORKER_ACTIVE_EPISODE_EXISTS` and `worker_episode_reopen_forbidden` → `WORKER_EPISODE_REOPEN_FORBIDDEN` (anything unmapped → `BATCH_INVALID`); the raw database message never reaches the API or the UI and no code carries the CCCD. `full-profile-api.ts` forwards only those safe codes.
- `scripts/lib/direct-entry-inventory.mjs` applies declarations and drops in source order and counts `alter function … rename to` as a declaration, so the derived inventory matches the live 118/59/59.

## Rollout
- #58 and #59 belong to the same maintenance window: #58 opens rehire as a new episode, #59 closes the OFF→ON substitute. Applying #58 without #59 leaves that loophole open. No Production apply, deploy, merge or push to `main`.
