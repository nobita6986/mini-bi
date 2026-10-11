# P3.1-W03A-R2-R1 — Existing-account read/API contract repair

- **Status:** `P3_1_W03A_R2_R1_ACCOUNT_READ_API_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@b1f3bedf70181698bad3d77bfa3897d3604d9245`
- **Final:** pending commit
- **Branch:** `feature/p3-1-w03a-r2-account-read-api`
- **Scope:** repair R2 account read/API contract; no W05 UI.

## Implemented

- Migration #84: `20261011170000_p3_1_w03a_r2_r1_account_read_repair.sql`
  - Drops the obsolete #83 five-argument list RPC signature.
  - Replaces the effective projection with canonical `direct_entry_app_users.display_name` from migration #62.
  - Exact row keys: `account_ref`, `display_name`, `enabled`, `version`.
  - Exact list keys: `search`, `enabled`, `page`, `page_size`, `total`, `accounts`.
  - Case-insensitive server-side substring search over canonical display name only.
  - Stable `display_name ASC, app_user_id ASC` ordering.
  - Service-role-only execution and Full Admin authority reuse.
- Strict TypeScript projection/repository/API boundary updated for display name/search.
- Routes unchanged:
  - `GET /api/admin/access/accounts`
  - `GET /api/admin/access/accounts/[accountRef]`
  - `POST /api/admin/access/accounts/[accountRef]/enable`
  - `POST /api/admin/access/accounts/[accountRef]/disable`
- Query rejects unknown/duplicate/malformed/empty search; mutation validates canonical UUID actor fields, UUID idempotency key, exact body and matching Idempotency-Key header.
- Mutation success remains exactly `{ok:true}`; no optimistic row is returned.
- Enable/disable reuses W03A lifecycle RPCs.

## Tests/evidence

- Focused R2 DB/API lane: **8/8 pass**.
- Existing W03A lifecycle regression: **4/4 pass**.
- Covers canonical display name, no account label/hash/UUID/email/auth subject, server search, exact query echo, stable two-key order, Full Admin allow, Accounting/disabled/forged denial, strict projection/query/body, OCC, idempotency replay and reload-safe mutation response.
- Mutation probes all RED and restored source byte-identical:
  - server authority bypass;
  - extra projection field;
  - raw UUID display label;
  - missing OCC validation;
  - optimistic mutation projection;
  - account-label regression;
  - actor UUID validation regression;
  - malformed search validation regression;
  - server search removal regression.

## Gates

- `next typegen`: pass
- `pnpm typecheck`: pass
- `pnpm build`: pass
- `pnpm lint`: 0 errors; 13 pre-existing warnings
- `pnpm docs:check`: 6/6 pass
- `pnpm secrets:check`: pass
- `pnpm db:migrate -- --offline`: 84/84 pass
- `git diff --check`: pass
- No full canonical `pnpm test`: not required; focused R2/R1 and W03A lifecycle lanes cover the changed boundary.

## Boundaries/deferred

- No W05 UI.
- No W03B/C/D/E surfaces.
- No P3.2 account creation/reset/MFA/recovery.
- No Production query/apply, deploy or browser/UAT.
- T0 must reconcile/integrate this branch from current `origin/main`; no rebase/merge/amend/force-push performed.
