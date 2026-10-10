# P3.1-W04-A3 — Personnel Team Membership UI

## Scope and source baseline

W04-A3 adds membership management to the existing Admin Personnel Catalog. It uses
the W01C-B and W01C-A APIs as-is; no backend, migration, direct database access,
new dependency, or Team Catalog administration UI was added.

- Base: `1189c8a77decbecec0b402b72f428cb0525b460d`
- Implementation source/test commit: `2437740ab2d6dc857cc549ad35414a5fc521c20d`
- Branch: `feature/p3-1-w04-a3-membership-ui`
- Final branch HEAD, including this handoff-only commit, is recorded in the T1A
  completion report.

## UI and API integration

- Added `src/components/admin/personnel-team-membership-manager.tsx`, opened only
  by the “Quản lý nhóm” action on a Personnel row. It loads the selected
  personnel's `current`, `scheduled`, and `history` lists in parallel, with
  `recruiter_id`, state, page, and `page_size=25`; paging and retry remain scoped
  to that section. No membership request is made per row or before opening a
  personnel record.
- The membership lists use the canonical
  `GET /api/admin/catalog/team-memberships`. Assign, move, and close operations
  use the W01C-B `POST` endpoints under
  `/api/admin/catalog/personnel/[recruiterId]/team-memberships`; team IDs appear
  only in assign/move paths, never in their request bodies.
- Assign/move team choices come from `GET /api/admin/catalog/teams`, projected
  through W01C-A's strict list projector and filtered to active teams. Catalog
  pages are requested at 100 rows and can be loaded incrementally. Reserved
  Vendor teams are not reconstructed in the client.
- Added `src/lib/admin/team-membership-model.ts` for bounded query builders,
  strict list/team projections, exact mutation request bodies, sanitized
  outcomes, and recruiter-scoped conflict-lock helpers.
- `src/components/admin/personnel-catalog-manager.tsx` has only the integration
  action, manager mount, conflict-lock propagation, authoritative personnel
  refresh, and focus return. The Personnel create form is unchanged.

## Interaction and authority

- Membership reads preserve separate loading, empty, unauthenticated, denied,
  not-found, unavailable, and malformed-response states; invalid or unavailable
  data is never shown as an empty list.
- Mutation requests require a valid calendar date, non-empty reason, authoritative
  recruiter version, and a fresh idempotency key. Network retry resends the same
  immutable request and key. A new intent gets a new key.
- Assign/move use the recruiter version; close/cancel use the membership's
  authoritative recruiter version. No version is incremented in the client.
- On `409`, only that recruiter's mutations are locked. The lock clears only when
  the personnel detail and all three authoritative membership lists reload
  successfully. Failed reloads preserve the lock and offer retry; the dialog can
  close without releasing the lock.
- Closing a current membership remains available for inactive personnel.
  Scheduled membership can be cancelled with `valid_to` equal to its
  `valid_from`; both operations preserve audit/history and never hard-delete.
  Assign/move choices require active personnel and active teams.
- UI visibility is not an authority source. Existing server page/API and W01C-B
  database guards remain authoritative; this change adds no browser-side RBAC.
- UI copy is Vietnamese, tables use semantic markup and horizontal overflow on
  narrow screens, controls have labels, alerts/statuses are announced, and Radix
  Dialog handles keyboard dismissal and focus management.

## Validation

- `test:p3-1-w04-a3-membership-ui`: 14/14.
- `test:p3-1-w04-a1-a2`: 146/146.
- `test:p3-1-w01c-b-team-membership`: 34/34.
- `test:p3-1-w01c-a-team-catalog`: 25/25.
- `test:p3-1-w01b-personnel`: 29/29.
- Canonical `pnpm test`: 2082/2082 across 57 test summaries, including the A3
  lane.
- Mutation checks each made the focused A3 lane fail and were restored
  byte-identically: remove strict membership projection, add `team_id` to the
  mutation body, preload membership in each Personnel row, and bypass the OCC
  lock.
- `pnpm exec next typegen`, `pnpm typecheck`, and `pnpm build`: pass (Next.js
  16.3.8).
- `pnpm lint`: 0 errors; 15 warnings remain in existing, unrelated files.
- `pnpm docs:check`: 6/6; `pnpm secrets:check`: pass (1089 files).
- `pnpm db:migrate -- --offline`: 71 migrations valid; no database access.
- `git diff --check`: pass.

No browser, Playwright, CUA, or Owner UAT was run. Responsive/accessibility UAT
remains Owner-only.

## Remaining work

- W04-A4: Team Catalog UI.
- W04-B: Leader UI, dependent on W01D.
- Membership UI does not include Team administration, Leader UI, Vendor/Labor
  Type, or Access Administration.

## R1 delta — recruiter-scoped state and reload recovery

R1 changes only the client-side workflow and its tests; W01B/W01C APIs, contracts,
migrations, and dependencies remain unchanged.

- R1 base: `289538a4c4b3ba84f6386d2435cb5e60501d2705`.
- R1 final SHA: reported in the T1A completion message for this branch.
- `src/lib/admin/team-membership-model.ts` now models pending intent, messages,
  errors, and reload-required locks by recruiter ID. An applied result or OCC
  conflict keeps that recruiter locked until the authoritative personnel detail
  and CURRENT, SCHEDULED, and HISTORY lists all reload successfully. Partial
  reload failure retains the lock and retry path; detail 404 clears the stale
  workflow, closes only that personnel dialog, and refreshes the Personnel list.
- The manager retains an uncertain request's exact URL, body, and
  Idempotency-Key for retry. A different personnel dialog cannot see or retry
  that request. Other pending/conflicted personnel are represented by a
  recruiter-named reopen action when the dialog is closed; while another dialog
  is open, a generic notice directs the user to close it rather than exposing
  another recruiter's request there.
- Assign is rendered only for active personnel after both CURRENT and SCHEDULED
  lists have loaded successfully and are empty. Form, operation, team selection,
  message, and error presentation are scoped/reset by recruiter; authoritative
  row versions remain the sole source for move/close/cancel.
- Visible copy uses Vietnamese “phân công” terminology; technical identifiers
  retain their existing code/API names.
- R1 focused lane: 21/21; W04-A1/A2 lane: 146/146; W01C-B: 34/34; W01C-A:
  25/25; W01B: 29/29. Full-suite and build/type/lint/documentation/security/
  offline-migration gates: `pnpm test` 2089/2089 across 57 summaries;
  `pnpm exec next typegen`, `pnpm typecheck`, and `pnpm build` pass; `pnpm lint`
  has 0 errors and 15 existing warnings; `pnpm docs:check` 6/6;
  `pnpm secrets:check` passes (1632 files); `pnpm db:migrate -- --offline`
  validates 71 migrations; `git diff --check` passes.
- No browser, Playwright, CUA, or Owner UAT was run. Owner-only browser UAT is
  still pending.
