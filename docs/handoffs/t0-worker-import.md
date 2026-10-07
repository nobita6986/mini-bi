# T0 operator worker import — local implementation

- Base: `origin/main@60075b17`; branch: `codex/t0-operator-worker-import`.
- Required references: `C:\CodeApp\import_data_byT0.md` and `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`.
- Entry point: `node scripts/t0-import-workers.mjs` (`.xlsx` or `.csv`, one sheet).
- Reuse: existing `exceljs`, `pg`, Supabase config/TLS helpers, date/identifier normalization, full-profile v2 RPC, submission-transition RPC, reason/audit/idempotency contracts.
- No migration, schema, dependency, lockfile, UI, RBAC, import framework or canonical-table DML added.

## Contract

- Required flags: exactly one of `--check` / `--apply`, plus `--input`, `--batch-id`, `--operator`, `--reason`.
- `--check` executes the exact RPC transaction and post-check, then rolls back.
- `--apply` additionally requires the source-bound token printed by check: `--confirm T0_WORKER_IMPORT_APPLY:<sha256>`.
- Technical operator must be enabled with current `entry_admin` + `all`; each `uploader_login` remains canonical `created_by` and must have create capabilities, exactly one current own scope, and current project-manager assignment.
- Preflight fails closed on ledger mismatch, ambiguous/inactive catalog data, cutoff breach, duplicate CCCD, missing reporting alias/provider history, or unsafe numeric identifiers.
- One immutable batch audit records technical operator, reason, batch ID and fingerprint; existing RPC audit preserves the business uploader.
- Output is counts, dates, provider/state splits and source-row error IDs only; no PII payload or raw DB error is logged.
- Max 100 rows/submission; larger inputs split deterministically inside one transaction. Same batch/source replays; same batch with another fingerprint is denied.

## Gates

- `pnpm test:t0-worker-import`: 9/9.
- `pnpm test`: exit 0; typegen/typecheck pass.
- `pnpm lint`: 0 errors / 10 baseline warnings; `pnpm build`: pass.
- `pnpm docs:check`: 6/6; `pnpm secrets:check`: pass.
- `git diff --check`: clean.
- Production was not connected to or mutated; no migration/deploy performed.
