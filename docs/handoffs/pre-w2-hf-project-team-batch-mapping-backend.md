# PRE-W2-HF Project↔Team batch mapping — backend handoff

- **Status:** `PRE_W2_HF_PROJECT_TEAM_BATCH_MAPPING_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@614a9393a93e9591f08a8e835b08adcded697fbf` (fetched latest; includes the requested `d9c7299` baseline and subsequent main commits).
- **Migration ledger:** #97; #94 remains Project↔Team authority, #95 reporting-only, #96 is worker-export text/CCCD issue date, #97 is batch mapping.
- **Migration SHA-256:** `20261015130000_pre_w2_hf_project_team_batch_mapping.sql` — `5147fb8073f00995fc5d0da0fd7f6888a3a6193a97aa0727ce9581d20f67c9e0`.
- **Branch/worktree:** `feature/pre-w2-hf-project-team-mapping-backend` at `C:\CodeApp\BI-pre-w2-hf-project-team-mapping`.
- **Scope:** backend/API/database migration/tests only. No persistent database was changed; no deploy or UAT was performed.

## Rollout warning

The old T1A browser request format is intentionally retired by the new server contract:

- Grant no longer accepts `project_id`, `expected_pair_version`, or `effective_from`; it requires `project_ids` and one `team_id`.
- Revoke no longer accepts `expected_pair_version`.
- The route hierarchy is unchanged, but the grant response now contains `batch` rather than a single `scope`.
- Existing T1A UI code still builds the legacy request. Its model test now pins that stale payload as blocked; the UI implementation itself is unchanged.

Migration-first is non-disruptive: #97 leaves the existing versioned grant/revoke RPCs and their service-role ACLs intact, so the currently deployed server/UI can continue to call them after the migration is applied. The new API contract does not accept the old UI payload, however. Do not deploy the new API alone with the old UI; coordinate the T1A client cutover to send `project_ids`, omit client versions, and consume the batch result. Retiring the old RPC signatures/grants is explicitly deferred until that client/server cutover is complete.

## API and repository contract

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `GET /api/admin/catalog/project-team-scopes` | Existing bounded list filters; unchanged | `{ ok: true, list }` |
| `POST /api/admin/catalog/project-team-scopes` | Exact keys: `team_id`, `project_ids`, `reason`, `idempotency_key`. `project_ids` has 1–100 unique project IDs. | `{ ok: true, batch: { team_id, effective_from, created, skipped } }` |
| `POST /api/admin/catalog/project-team-scopes/[mappingId]/revoke` | Exact keys: `mapping_id`, `effective_to`, `reason`, `idempotency_key`. `effective_to` is a real date or `null`. | Existing `{ ok: true, scope }` revoke projection |

`expected_pair_version`, `expected_version`, authority fields, unknown keys, invalid dates, oversized JSON, and malformed batch entries are rejected before resolving the session. The actor is derived from the existing session helper only. Responses remain `private, no-store`.

`project-team-scope-repository.ts` continues to use the existing service-role RPC transport and calls:

- `direct_entry_list_project_team_scopes_admin` for reads (#94).
- `direct_entry_grant_project_team_scopes_batch` for atomic batch grants (#97).
- The versionless `direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text)` overload (#97).

RPC projections are exact-key and fail closed. SQLSTATEs are converted to sanitized API results: denied `403`, missing `404`, conflicts `409`, invalid input `400`, and unknown database failures generic `500`.

## Database behavior and authority

Migration `20261015130000_pre_w2_hf_project_team_batch_mapping.sql` is append-only #97. It leaves migrations #1–#96 unchanged and retains the existing canonical Full Admin guard `direct_entry_assert_actor_app_user_admin`; no capability or scope was added. The migration contains no staging-derived IDs, project/team names, mapping rows, or seed logic.

The supplied read-only staging audit is not encoded as a rule or fixture. Backend behavior accepts only the project IDs explicitly sent by an authorized Full Admin and applies the same per-pair checks to each; no staging mapping was seeded or written.

- **Batch grant:** Full Admin only. Validates an active, non-reserved team and 1–100 unique active projects, normalizes project order, locks projects in stable order and the team, then serializes pair updates. The DB authorization date supplies `effective_from`; no grant date or pair version is accepted from the client.
- A currently effective pair is returned in `skipped` with its mapping ID/version. Only newly created pairs receive a mapping and one immutable audit event apiece.
- Pair version is computed and incremented inside the transaction. An exception during any insert rolls back every mapping, audit, restricted reason, and idempotency record from that request.
- Idempotency binds the normalized pair set, team, and reason. Exact replay returns the saved batch; reused-key/different-payload is rejected.
- **Revoke:** Full Admin only. The versionless overload locks project then mapping, reads and increments the persisted version under lock, preserves the existing effective-date/reason/audit semantics, and returns exact idempotent replay.
- Old versioned grant/revoke function signatures and their existing `service_role` execute grants remain unchanged for migration-first compatibility. New functions are `SECURITY DEFINER`, pin `search_path`, and are executable only by `service_role`; the self-check enforces the new and legacy RPC ACL boundaries. The mapping table remains forced-RLS and inaccessible to application roles.

| Actor / request | Read mappings | Batch grant | Revoke |
| --- | --- | --- | --- |
| Canonical Full Admin | Allow | Allow | Allow |
| `entry_admin@all` only | Deny | Deny | Deny |
| `catalog_master_manage@all` only | Deny | Deny | Deny |
| Team Leader, staff, anonymous, disabled or mismapped actor | Deny | Deny | Deny |

## Regression evidence

- `pnpm test:pre-w2-hf-project-team-batch`: **pass** — strict request/result contract, session/CSRF/body ordering, authority and version-field rejection, sanitized errors, malformed projection handling, PGlite batch rollback/idempotency/authority, and local PostgreSQL simultaneous grant/revoke locking.
- `pnpm test:pre-w2-hf-project-team-authority-db`: **9/9 pass**, including the full #97 ledger, legacy #94 behavior, migration-first RPC ACL posture, batch atomicity (including an injected second-insert failure), skipped effective pairs, persisted versions, audit-per-created-pair, Full Admin-only access and exact replay.
- `pnpm test:pre-w2-hf-project-team-authority-ui`: **66/66 pass**. The UI source is unchanged; a model regression pins the old versioned request as blocked until coordinated UI work.
- `node scripts/pre-w2-hf-project-team-batch-mapping-mutation.mjs`: **6/6 probes made the focused lane fail**, with source files restored byte-for-byte. Probes cover removed Full Admin authority, swallowed mid-batch failure, accepted client pair version, accepted client authority, leaked error details, and revoked legacy RPC access.
- `pnpm test` is the canonical full repository chain and includes the focused batch lane exactly once; the full chain passes on the 97-migration ledger.

## Validation

Rebased onto the latest fetched `origin/main` (`614a9393a93e9591f08a8e835b08adcded697fbf`), which includes the requested `d9c7299` base and later main commits. Ledger pins and end-relative anchors now target 97 migrations.

- Focused batch/API/database/concurrency lane: pass.
- Project↔Team authority DB regression: pass, including the injected mid-batch failure rollback assertion and legacy-RPC ACL compatibility.
- Project↔Team UI contract regression: **66/66 pass**; UI implementation unchanged.
- `pnpm test`: pass on the rebased 97-migration ledger. The full chain also identified and rebaselined one stale W03A migration-count assertion; its focused lane passes.
- `pnpm exec next typegen`: pass.
- `pnpm typecheck`: pass.
- `pnpm lint`: pass (0 errors; 14 existing warnings).
- `pnpm build`: pass.
- `pnpm docs:check`: pass (6/6).
- `pnpm secrets:check`: pass.
- `pnpm db:migrate -- --offline`: pass (**97/97**; no database was applied).
- `git diff --check`: pass.

Appending #97 required updating historical regression fixtures that pin migration count, relative ledger positions, and RPC inventory. No prior migration is edited. The handoff/code changes are ready to publish to the feature branch as a fast-forward after final remote verification.

No migration was applied to a persistent database. Do not merge `main`, deploy, or perform UAT before T0 review and coordinated UI integration.
