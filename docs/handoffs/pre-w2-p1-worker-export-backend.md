# PRE-W2-P1 — Full-PII worker Excel export backend/API

- **Status:** `PRE_W2_P1_WORKER_EXPORT_BACKEND_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@7afc02632f83a4cddff7ddfe75f7eb5308f1a969` (preflight fetch matched the expected SHA; ledger was 85, no worker-directory/auth/audit/Excel/API-route delta, only a CI-perf commit).
- **Branch / worktree:** `feature/pre-w2-p1-worker-export-backend` on a clean isolated worktree `C:\CodeApp\BI-pre-w2-p1-worker-export-backend` (`node_modules` is a junction to the primary checkout). **Primary checkout untouched.**
- **Contract:** `docs/handoffs/pre-w2-s0-pii-export-worker-name-survey.md` @ `499a212` (PRE-W2-S0-R2, accepted). UI lane T1A is **not** started.

## Migration #86

- `supabase/migrations/20261013120000_pre_w2_p1_worker_export.sql` — append-only; sha256 `1dc478d9527bd922b0de6b758081f6d36b7923ba446f34185729d69fb2ad30e6`. Offline validation: **86/86** `pnpm db:migrate -- --offline`. No table/column/schema/dependency change; no capability grant.
- One new public RPC `direct_entry_export_workers(p_auth_subject, p_app_user_id, p_scope, p_project_id, p_recruiter_id, p_employment_status, p_reason)`: `SECURITY DEFINER`, `search_path = pg_catalog, public`, revoked from every role, granted **only** `service_role`.

### Authority (server-side conjunction, fail-closed `42501`)

- Scope `recruited | managed` only — **`all` and every other token are denied before any read**. Row authority reuses `direct_entry_worker_directory_audience` (#52); capability conjunction `pii_export AND pii_view AND payment_view` uses `direct_entry_has_capability`. Any missing term denies the whole export (no partial/redacted file). `all` is denied even for a fully-capable all-scope actor.

### Read model

- **One batch query** over the authorized set (no N+1 `direct_entry_read_projection`), same eligibility + filter semantics as `direct_entry_list_workers` (SUBMITTED, non-deleted; project/recruiter/employment_status), deterministic order `first_work_date DESC, entry_id DESC`, at most **10,001** candidates.
- Row projection = exactly 18 string/null fields: `employee_code, display_name, date_of_birth, national_id, phone, address, project_display, first_work_date, labor_type_display, recruiter_display, provider_type, employment_status, leave_date, leave_reason, account_number, bank_name, account_holder_name, payment_note`. Full PII / full payment (never masked). `payment_note` is always `null` (no authoritative source; `general_note` is not used). `bank_name` is the authoritative payment column; `provider_type` via `recruitment_provider_type_display`.

### Envelope + audit

- Success `{ "status":"ok", "rows":[...] }`; over-limit `{ "status":"too_many_rows", "limit":10000 }`. On the 10,001st candidate the RPC writes an audit event (`outcome=REJECTED`, `denial_code=EXPORT_ROW_LIMIT_EXCEEDED`) **then returns without raising** (never truncates, returns no row). `v_total > 10000` triggers the cap path.
- Audit reuses `direct_entry_audit_events`: `action='worker_export'`, `capability='pii_export'`, `scope_kind` **`own`** for `recruited` / **`project`** for `managed` (never the raw token), `changed_fields={}`, `reason_id` via `direct_entry_reason`, `resource_ref = worker-export:<scope>:<row_count>:<sha256 canonical filters>` (≤128, non-PII, hash via `direct_entry_payload_hash` over `{scope, project_id, recruiter_id, employment_status}` incl. nulls). No idempotency.
- Capability/row-authority denial stays a fail-closed `42501` and does **not** claim a persisted DENY audit (a raised transaction rolls back).

## TypeScript touch set

- **New:** `src/lib/direct-entry/worker-export-contract.ts` (body allowlist + strict 18-field/envelope projection), `worker-export-repository.ts` (server-only, single RPC), `worker-export-api.ts` (gate → CSRF → content-type → body → allowlist → session → repository → XLSX), `worker-export-xlsx.ts` (`exceljs`, 18 columns, `numFmt "@"` on the four id columns), `src/app/api/direct-entry/workers/export/route.ts` (`runtime="nodejs"`, `dynamic="force-dynamic"`, `DIRECT_ENTRY_API_ENABLED` gate first, POST only), + the focused-lane tests + the mutation script.
- **Body allowlist:** `scope` (recruited|managed, required), `project_id`/`recruiter_id`/`employment_status` (optional/null), `reason` (required, trimmed, 1..4000). Unknown key, wrong type, invalid enum or filter → 400. No `Idempotency-Key`. The `scope` field is a request selector, not authority; the shared `validateClientBusinessPayload` is intentionally **not** used because it bans the literal key `scope`, and the exact allowlist already refuses every client authority key.
- **HTTP taxonomy:** 200 XLSX · 400 invalid · 401 unauthenticated · 403 denied · 422 `{ok:false, code:"WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit:10000}` · 503 unavailable. Responses set `cache-control: private, no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`; success adds the XLSX content-type, `attachment` disposition and a PII-free filename `danh-sach-nguoi-lao-dong-YYYY-MM-DD.xlsx`. No raw DB message/UUID/PII in JSON errors or logs.
- **XLSX safety:** ExcelJS stores `=`/`+`/`-`/`@`-prefixed (and tab/CR/LF) strings as literal text — no formula/hyperlink/error cells; the four id columns keep leading zeros.

## Tests + mutation

- Focused lane `test:pre-w2-p1-worker-export-backend` (registered once in the canonical `pnpm test` chain): 25 unit (contract/repository/api/xlsx) + 6 PGlite DB tests = **31 pass**. Covers recruited/managed allow, `all`/unknown scope denial, per-capability denial (incl. the all-audience+full-capability actor still denied `all`), out-of-scope project denial, directory filter parity, 10,000 success, 10,001 `too_many_rows` with a surviving `REJECTED` audit, own/project scope mapping, non-PII bounded `resource_ref`, ACL/`search_path`/`service_role`-only, no capability grant, 18-column order, leading zeros, no formula/hyperlink/error, empty column 18.
- Mutation evidence `scripts/pre-w2-p1-worker-export-mutation.mjs`: **8/8 RED**, sources restored byte-for-byte — (1) drop `pii_export`, (2) allow `all`, (3) truncate 10,001→10,000, (4) raw scope into `scope_kind`, (5) `RAISE` after the cap audit, (6) raw filter instead of the hash, (7) CCCD as a number, (8) `=`-prefixed value as a formula cell.

## Gates

- `pnpm exec next typegen` (exit 0), `pnpm typecheck` (exit 0), `pnpm lint` (0 errors; 13 pre-existing warnings), `next build --webpack` (exit 0 — `/api/direct-entry/workers/export` present, `BUILD_ID` written), `pnpm docs:check` (6/6), `pnpm secrets:check` (clean), `pnpm db:migrate -- --offline` (**86/86**), `git diff --check` (exit 0).
- Canonical ledger rebaseline 85→86 across the affected lanes: count pins (`length, 85`→86, `totalCount`), from-end position pins (`names.length - (N)`→`(N+1)`), `.at(-N)`/`slice(0,-N)` tail pins, and two "last migration" pins (W05B now `.at(-2)`). Every affected lane re-run: `p3-w05b-a-team-reporting`, `p3-1-w01d-a1a/a1b1/a1b2`, `p3-1-w02a`, `p3-1-w02c-labor-type-catalog`/`-r2`/`-r3`, `p3-1-w03a-r2-account-read`, `p2.5-hf-create-rehire`, `p2.5-status-default`, `p2-de-dim-hotfix`, `p3-w05a`, `p3-w07a-r4`, `p3-w07a-r3-vendor-doc-upload` — all green. `p3-1-w02b-vendor-catalog` asserts a clean `git status` over `supabase/migrations`; it fails only while the new migration is **untracked** and passes once this branch is committed (verified post-commit).
- Related lanes: `test:p2.5-w03` (worker directory) green; `worker-profile-xlsx.test.mjs` green.
- Full canonical `pnpm test` is intentionally **not** run in this lane (Pre-W2 integration/release owns full regression).

## Skipped / risk

- Worker display-name correction (SURVEY B) is out of scope. No UI button/dialog, no capability grant/seed, no second export RPC, no schema expansion, no client XLSX/join, no N+1.
- Column 18 (`payment_note`) is always empty until an authoritative payment note exists; `direct_entry_payments` has no note column today.
- `pnpm build` (Turbopack) cannot run inside this worktree (`node_modules` junction points out of the filesystem root); the documented Webpack opt-out was used.
- No Production query/apply, deploy, browser/UAT or merge to main.
