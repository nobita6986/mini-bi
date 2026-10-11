# P3.1-W03A-R2 — Existing-account read/API boundary

- **Status:** `P3_1_W03A_R2_ACCOUNT_READ_API_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@b1f3bedf70181698bad3d77bfa3897d3604d9245`
- **Final:** pending commit
- **Branch:** `feature/p3-1-w03a-r2-account-read-api`
- **Scope:** bounded Full-Admin existing-account reads and server API boundary; no W05 UI.

## Implemented

- Migration #83: `20261011160000_p3_1_w03a_r2_account_read.sql`
  - Full-Admin-only list/detail read RPCs.
  - Exact row keys: `account_ref`, `account_label`, `enabled`, `version`.
  - Exact list keys: `enabled`, `page`, `page_size`, `total`, `accounts`.
  - Stable `app_user_id ASC` pagination.
  - `TK-` plus server-derived short hash label.
  - Service-role-only execution; no table/API exposure to browser roles.
- Strict TypeScript projection/repository/API boundary.
- Routes:
  - `GET /api/admin/access/accounts`
  - `GET /api/admin/access/accounts/[accountRef]`
  - `POST /api/admin/access/accounts/[accountRef]/enable`
  - `POST /api/admin/access/accounts/[accountRef]/disable`
- Mutation body is exact `expected_version`, `reason`, `idempotency_key`; target comes only from route; actor comes only from session; same-origin and bounded JSON enforced; success is exactly `{ok:true}`.
- Enable/disable reuses W03A lifecycle RPCs and does not return an optimistic row.

## Tests/evidence

- Focused R2 DB/API lane: **8/8 pass**.
- Existing W03A lifecycle regression: **4/4 pass**.
- Covers Full Admin allow, Accounting/disabled/forged denial, strict projection/query/body, bounded paging/order, no PII, OCC, idempotency replay, disabled targets and reload-safe mutation response.
- Mutation probes all RED and restored source byte-identical:
  - server authority bypass;
  - extra projection field;
  - raw UUID display leak;
  - missing OCC validation;
  - optimistic mutation projection.

## Gates

- `next typegen`: pass
- `pnpm typecheck`: pass
- `pnpm build`: pass
- `pnpm lint`: 0 errors; 13 pre-existing warnings
- `pnpm docs:check`: 6/6 pass
- `pnpm secrets:check`: pass
- `pnpm db:migrate -- --offline`: 83/83 pass
- `git diff --check`: pass
- No full canonical `pnpm test`: not required; focused R2 and relevant W03A lanes cover the changed boundary.

## Boundaries/deferred

- No W05 UI.
- No W03B/C/D/E surfaces.
- No P3.2 account creation/reset/MFA/recovery.
- No Production query/apply, deploy or browser/UAT.
- T0 must reconcile/integrate this branch from current `origin/main`; no rebase/merge/amend/force-push performed.
