# P3-W03-S02A — First Owner Bootstrap Handoff

## Status

`P3-W03-S02A_FIRST_OWNER_BOOTSTRAP_PASS_WAITING_OWNER_LOGIN_UAT`

The operator and synthetic tests are implemented on the isolated branch
`feature/p3-first-owner-bootstrap-s02a`, based on `1577c035758306c54a4cd6be4808bea8452fc7c3`.
The bootstrap was applied to the already-configured Supabase project through its
official Session Pooler. The project reference was validated as `kiam***`.
No email, Auth UUID, DB URL, or credential is recorded here.

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
- DB-aware migration dry-run before and after bootstrap: **34 applied, 0 pending,
  0 checksum mismatches**.

## Database actions and next step

Read-only check mode found exactly one Auth user match; it was confirmed and not
banned/deleted. There was no existing app-user mapping and no foreign app-user
conflict. The Auth user itself was neither created nor modified.

The operator's single `--apply` invocation completed its transaction and reported:

- One enabled app-user mapping.
- 21 effective capabilities from the canonical vocabulary.
- One effective `own` scope and one effective `all` scope.
- Zero team scopes.
- Actor-context projection enabled with 21 capabilities and `own`/`all` scopes.
- Reporting baseline and security boundary unchanged.
- Zero bootstrap audit events; no unsupported audit action was fabricated.

Two subsequent read-only check-mode passes returned `ALREADY_BOOTSTRAPPED` with
the same counts and actor projection. They made no changes and reported no
bootstrap audit events, verifying stable idempotent replay without a second
mutation. The final migration dry-run again confirmed 34/0/0.

No deployment was performed, Direct Entry flags were not changed, and `main` was
not modified. The Owner's next step is to perform their own Production login and
session/logout UAT; no credentials were requested or used.
