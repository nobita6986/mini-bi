# P2.5-HF-R5 — session identity header (#62)

Status: `P2.5-HF-R5_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@910fa2f` (61 migrations). Branch `feature/p2-5-hf-r5-session-identity-header`.

## Schema before -> after

- `direct_entry_app_users`: (app_user_id, auth_subject, enabled, created_at) -> **+ display_name text**, NOT NULL, canonical CHECK (`display_name = btrim(display_name) and length between 1 and 256`), not unique.
- Backfill: login label = `btrim(split_part(auth.users.email,'@',1))` for the mapped auth subject. Fail-closed if any app user is unmapped, has no email, or has no usable login label (no placeholder, no UUID). Production read-only preflight before the migration: app_users 56, missing auth mapping 0, no-email 0, not-derivable 0, backfillable 56, distinct labels 56, email-like labels 0, transaction rolled back.
- `direct_entry_resolve_actor_context` now returns `display_name` (still service-role only, no email/auth_subject metadata leak).

## Session/UI before -> after

- Session response: `{ok,actor:{app_user_id,capabilities,scopes,self_recruiter_suggestion}}` -> **+ display_name** (validated trim 1..256, malformed fails the actor projection closed). No email/auth_subject added; still a single `GET /api/auth/session`.
- Header: top-level "Đổi mật khẩu" + "Đăng xuất" -> **one account trigger** (display_name + chevron) opening a Radix `DropdownMenu` with exactly "Đổi mật khẩu" (`/dashboard/account/password`) and "Đăng xuất" (POST `/api/auth/logout`). 44px trigger, truncate + title/accessible name, keyboard/click-outside/focus return via Radix, busy lock, red error, skeleton, 401 -> "Đăng nhập", 503/malformed -> fail-closed with no stale name.

## Tests / gates

- New: `scripts/p2-5-hf-r5-session-identity-db.test.mjs` (5/5) + `src/components/app-shell/user-session-control.test.mjs` (7/7); malformed display_name regression in `direct-entry-v2.test.mjs`; actor-context contract test updated for #62. Fixtures/provisioning (`p3-first-owner-bootstrap.mjs`, `p3-w07b-access-bootstrap.mjs` + shared fixtures) now always supply a canonical display name; partial-ledger historical suites keep working.
- `pnpm test` 0 fail; typegen + typecheck clean; **lint 0 errors** (13 pre-existing warnings, unchanged); build ok; `docs:check` 6/6; `secrets:check` ĐẠT; `db:migrate --offline` **62 valid**; `git diff --check` clean.

## Ledger / residue

- Migrations #1-#61 byte-identical; #62 appended. Not applied to Production, not deployed, main not merged.
- Residue: no admin UI to change display_name (P3.1); display name is currently the login label, so Owner may want a rename surface later.
