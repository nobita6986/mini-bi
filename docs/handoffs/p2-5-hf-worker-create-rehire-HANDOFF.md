# P2.5-HF — Worker create authority + CCCD rehire (backend)

Base: `8b01b67db08c68ccaeb9b369593159c9d9a0668a` (origin/main verified, ledger 57 = `20261008170000_p2_5_initial_employment_status_on.sql`)
Code commit: `3d5a64ab3e0da6e930df202473fe9a2a7d39f731` on branch `feature/p2-5-hf-worker-create-rehire` (no amend/rebase/force-push; #1–#57 untouched)
Migration: `supabase/migrations/20261008180000_p2_5_hf_worker_create_and_rehire.sql` (#58, T1B slot)
Gates: `pnpm test` exit 0 — 1638 tests / 1638 pass / 0 fail; new suite `scripts/p2-5-hf-worker-create-rehire-db.test.mjs` 7/7; typecheck, lint 0 errors (12 pre-existing warnings), build, docs:check 6/6, secrets:check, `git diff --check`, `db:migrate --offline` = 58 valid

## Root cause
- An assigned PM without global capability could not create a full profile: every create path was guarded by legacy `entry_create` + `submission_create` + exactly-one-`own`-scope, never by the assignment; conversely a recruiter/uploader holding those capabilities could create in any own-scope project.
- `direct_entries_worker_national_id_uidx` (one row per CCCD forever) made rehire structurally impossible and left merge/restore as the only apparent workaround.

## Delta (backend only; no new RBAC/framework/RPC family)
- New `direct_entry_create_authority(actor, project, action, date)`: effective PM assignment on the row's project → `manager`; else legacy `entry_create`+`submission_create`+exactly one effective `own` scope → `legacy`; else `42501`. Managers receive no global capability.
- Guards of `direct_entry_create_full_profile_batch`, `..._v2_unscoped_h03`, `direct_entry_create_batch` and `direct_entry_create_draft_row` now pre-pass every row through that helper before any write: a mixed-project batch is refused whole with zero residue; the own-scope-only block and the `NATIONAL_ID_DUPLICATE` 23505 block are gone.
- Payment caps (`payment_view`/`payment_edit`) still gate non-manager rows; `employment_status.apply` is still required for an explicit initial `OFF`; #57 semantics kept (new profile starts `ON`, initial event may be ON or UNCONFIRMED).
- CCCD: the unique index is dropped and replaced by trigger `direct_entry_active_episode_guard` (BEFORE INSERT/UPDATE OF worker_details) taking `pg_advisory_xact_lock(hashtextextended('worker-episode:'||cccd))`; it refuses with `23505` / `worker_active_episode_exists` (message never contains the CCCD) when any prior episode of the same CCCD has a latest status other than `OFF` (ON / UNCONFIRMED / absent → fail closed). Rehire is refused, never merged, restored or edited; the new stint is a new entry with a server-generated `employee_code` and `entry_id`.
- New `direct_entry_lookup_worker_episodes(actor, project, name, cccd)`: caller must be the server-confirmed manager of the target project or the all-scope project admin; returns only `display_name, employee_code, entry_id, first_work_date, latest_status, project_id, project_display` plus `authorization_date, episode_count, active_episode_exists, rehire_allowed`, limit 50. No full CCCD, DOB, address, phone, bank or documents; it is not a global worker directory.

## Verified without further code change
- §2.3 PM detail projection: the existing PM-scoped projection already exposes exactly the fields P2.5 §2.3 lets an assigned PM propose; routes/repositories read through RPCs, not tables.
- OFF→ON cannot substitute for a new episode: direct status application is DRAFT-only (W04 #53) and keeps the same `entry_id`/`employee_code`, so rehire still requires the new-episode path — which #58 blocks while the prior episode is ON.
- CCCD/STK/account-holder stay lookup text: no payment integration, no bank transaction flow, no CCCD file upload/view right opened.

## Residue (non-blocking)
- A PAYMENT proposal with an out-of-enum `state` is still accepted at CREATE and fails only at APPLY (pre-existing stuck-PENDING class, W04-owned).
- The public `direct_entry_create_full_profile_batch_v2` wrapper keeps its pre-existing project gate (already accepts an effective PM); unchanged.
- PGlite is single-connection, so two true concurrent writers cannot be exercised: the per-CCCD advisory lock is asserted at source level plus a sequential ON→rehire→ON proof.
- No route/UI surface was added; the three RPCs above are the backend contract for the table-driven lanes. No Production apply, deploy, merge or push to `main`.
