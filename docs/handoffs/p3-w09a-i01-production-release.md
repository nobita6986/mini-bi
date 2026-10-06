# P3-W09A-I01 — Production self-service password change (release record)

| Attribute | Value |
|---|---|
| Status | `P3-W09A-I01_PRODUCTION_DEPLOYED_WAITING_OWNER_UI_UAT` |
| Pre-main | `bf015af12e71914a922271bf676784836892d96b` |
| Post-main | `eea2630323096aad8602af5bfdf04d70b6dcd138` (non-force fast-forward) |
| Branch | `feature/p3-w09a-i01-production-release` (kept for rollback) |
| Cherry-picks (order preserved, `-x`) | `feabc51` (feat: self-service password change) → `102b2d2` (R1: request-scoped resolver + matching auth response headers) |
| Local = remote | `origin/main: eea2630`; worktree `C:\CodeApp\BI-p3-w09a-i01-production-release` clean |
| Alias | `https://bi.hrpartner.vn` |
| Deployment | Ready; live HTTP 200 on `/`, `/login`, `/dashboard`, `/dashboard/account/password`; X-Vercel-Id rotated after push |
| Migration ledger | 43 applied / 0 pending / 0 mismatch (read-only dry-run; no new migration added by this integration) |

## Change scope (delta-only)

| File | Δ |
|---|---|
| `src/app/api/auth/change-password/route.ts` | new |
| `src/app/dashboard/account/password/page.tsx` | new |
| `src/components/auth/change-password-form.tsx` | new |
| `src/components/app-shell/user-session-control.tsx` | +6 |
| `src/lib/auth/change-password-core.ts` | new |
| `src/lib/auth/change-password-core.test.mjs` | new |
| `src/lib/auth/change-password-route-composition.ts` | new |
| `src/lib/auth/change-password-surface.test.mjs` | new |
| `src/lib/auth/auth-ui.ts` | +3 (sanitized error codes only) |
| `package.json` | +`test:p3-w09a` script; `test:server` +2 files; `test` chain order — **no dependency, no version pin, no `packageManager` change** |

No `pnpm-lock.yaml`, no `supabase/migrations/*`, no `.env*`, no capability contract, no env/flag change.

## Gates

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK (27.7s) |
| `pnpm test:p3-w09a` | 16/16 |
| `pnpm test:server` | 143/143 |
| `pnpm test` (full chain) | 0 fail (each chain subset reported above) |
| `pnpm exec next typegen` | OK |
| `pnpm typecheck` | OK (0 errors) |
| `pnpm lint` | 0 errors, 8 pre-existing warnings (unrelated to W09A) |
| `pnpm build` | OK; `/dashboard/account/password` registered as `ƒ Dynamic` |
| `pnpm docs:check` | 6/6 |
| `pnpm secrets:check` | 1228 files scanned, 0 secrets |
| `pnpm db:migrate -- --offline` | 43 VALID |
| `pnpm db:migrate -- --dry-run` | 43 APPLIED / 0 pending / 0 mismatch (read-only) |
| `git diff --check` | OK |

## Rollback

Revert `main` to `bf015af` (`git push origin bf015af:main` non-force, or open a revert PR for `eea2630`); no migration added; no env flag change. The integration branch (`feature/p3-w09a-i01-production-release`) preserves both cherry-pick commits for reference.

## Stop point

Owner UI UAT pending. Per the integration scope, no P3 PASS, no P2/P3 completion claim.

## Owner UAT checklist (post-deploy)

1. Sign in as the trial account.
2. Open `Đổi mật khẩu` from the user-session control.
3. Wrong current password → `AUTH_INVALID_CURRENT_PASSWORD`.
4. Mismatched confirm → `AUTH_REQUEST_INVALID`.
5. Successful change → log out, log back in with the new password.
6. Verify `/dashboard` and `/direct-entry` still work.