# P3-W03-S02A — First Owner Bootstrap Handoff

## Status

`P3-W03-S02A_BLOCKED_DATABASE_DNS`

The operator and synthetic tests are implemented on the isolated branch
`feature/p3-first-owner-bootstrap-s02a`, based on `1577c035758306c54a4cd6be4808bea8452fc7c3`.
No live Auth identity lookup, bootstrap check, or database mutation was performed.

## Implementation

- `scripts/p3-first-owner-bootstrap.mjs` defaults to read-only check mode and requires
  `--apply` for mutation. Its email input is runtime-only.
- Apply work is protected by a transaction-scoped advisory lock, revalidates the
  canonical capability vocabulary, and does not revoke existing grants.
- The operator rejects non-unique/ineligible Auth identities and foreign existing
  app-user mappings, and verifies actor context, table/RPC privilege boundaries,
  append-only audit behavior, and reporting row counts before commit.
- The current audit vocabulary has no truthful bootstrap action. No audit event is
  fabricated; replay therefore writes no additional audit event.
- Synthetic PGlite tests apply the local migration set from scratch and cover
  check-only, identity failures, conflict, apply/replay, rollback, and vocabulary
  drift: **7/7 passed**.

## Validation

- Full `pnpm test`: **897/897 passed**.
- P3 S01A auth/session regression: **55/55 passed**.
- P3 S01C source acceptance: **52/52 passed**.
- P3 S01C prior replay: **113/113 passed**.
- `pnpm exec next typegen`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 0 errors and 3 existing warnings in unrelated files.
- `pnpm build`: passed.
- `pnpm docs:check`: 6/6 examples passed.
- `pnpm secrets:check`: passed; 652 files scanned.
- `git diff --check`: passed.
- The final DB-aware migration dry-run was attempted three times and each attempt
  failed before connecting with DNS `ENOTFOUND`. Local migration inventory remains
  34 files; live applied/pending/checksum counts could not be revalidated.

## Database actions and next step

No production Auth user was created or edited. No mapping, capability, scope,
reporting, submission, document, R2, or AI data was changed. Because DNS prevented
the required read-only checks, the operator was not run against the live database
and `--apply` was not used. The acceptance counts for the live mapping, 21
capabilities, `own`/`all` scopes, actor projection, and replay remain unverified.

After database DNS is restored, rerun the migration dry-run and require 34 applied,
0 pending, and 0 checksum mismatches. Then run the operator in check mode with the
authorized target supplied only through the current process environment. Apply only
if every account, mapping, grant, scope, reporting, and security preflight passes;
then verify replay and all required effective projections.
