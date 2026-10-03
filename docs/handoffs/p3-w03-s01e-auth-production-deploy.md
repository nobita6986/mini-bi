# P3-W03-S01E — Auth production deployment (push to main + Git-integrated Production smoke)

| Step | Field | Value |
| --- | --- | --- |
| Task | P3-W03-S01E | Auth production deployment |
| Owner | T1A | T0 close DB gate after S01D |
| Pre-push source | `1577c035758306c54a4cd6be4808bea8452fc7c3` (`origin/feature/p1.6-integration` = release/p3-auth-production; chore(integration): record P3 auth release candidate) |
| Pre-push `origin/main` | `2045472d15f98500670dd1a70e84f9b00ba86e70` |
| Post-push `origin/main` | `1577c035758306c54a4cd6be4808bea8452fc7c3` |
| Push type | fast-forward `2045472..1577c03` (no `--force`) |
| Production deployment | `dpl_6gsyNtcr3SYoMJVuRVYQxuTCEaz3` (alias `bi.hrpartner.vn`) |
| Trạng thái | `P3-W03-S01E_AUTH_PRODUCTION_DEPLOYED_WAITING_OWNER_UAT` |

## Provenance chain `origin/feature/p1.6-integration → origin/main`

`origin/main @ 2045472d` → **`origin/main @ 1577c03`** (after this push), where
the new commits brought in by the fast-forward are:

1. `612f75d4874abc51e2f04766763dfc9c186f4fb5` — S01A auth session server; parent `726120a`.
2. `7c665a615bf8f5418f194b1a16f2246eadb38e10` — S01B login/logout UI; parent `612f75d`.
3. `56ece710af2c95cee59b96a66f9eef4fdf0b11f3` — S01C source/browser acceptance; parent `7c665a6`.
4. `1577c035758306c54a4cd6be4808bea8452fc7c3` — S01D release-candidate record; parent `726120a` (release/p3-auth-production was created from `release branch`'s merge of `56ece71` ancestry via the existing merge chain; the final tip is `1577c03`).

All four are S01A → S01B → S01C → S01D deliverable chain. S01D is the release
candidate record (does not alter runtime). S01A–S01C are the same direct-descendant chain documented in S01D's integration provenance.

`release/p3-auth-production` is the alias of the source branch pushed
(`feature/p1.6-integration` HEAD = `1577c03`); `origin/main` was fast-forwarded
to the same SHA via `git push origin HEAD:main`. No merge commit, no
cherry-pick, no `--force`.

## DB gate verification

T0 closed the DB gate before this push (S01D had already documented
read-only dry-run). Re-confirmation just before push:

- Release worktree `C:\CodeApp\BI-p3-auth-production-release` HEAD
  `1577c035758306c54a4cd6be4808bea8452fc7c3`.
- T0 injected `SUPABASE_POOLER_HOST` and `SUPABASE_POOLER_PORT` into the
  process env only; no read/in/copy of credential values, no DB mutation.
- DB-aware read-only dry-run result: **34 applied, 0 pending, 0 checksum
  mismatch**.
- No re-run of the 897-test aggregate or the previously-green quality gates
  (T0 evidence accepted as release-gate proof per the prompt).

## Production deployment verification

Git-integrated Vercel production deployment picked up the push within ~6
minutes. Two Production deployments were created from the same commit; the
later one is the canonical serving deployment:

| Deployment id | URL | Aliases | Created (UTC+7) | Status |
| --- | --- | --- | --- | --- |
| `dpl_GLQKDTQLckdCeUJsugKJwBcu48bT` | `https://mini-9fsov0wde-thuans-projects-0b7f4d74.vercel.app` | `bi.hrpartner.vn` + 3 Vercel-managed | 2026-10-04 01:53:45 | Ready (initial) |
| **`dpl_6gsyNtcr3SYoMJVuRVYQxuTCEaz3`** | **`https://mini-ptw7cdxbt-thuans-projects-0b7f4d74.vercel.app`** | **`bi.hrpartner.vn` + 3 Vercel-managed** | **2026-10-04 01:59:06** | **Ready (canonical)** |

Source → deployment mapping (URL evidence):

- Branch ref: `mini-bi-git-main-thuans-projects-0b7f4d74.vercel.app` ⇒ branch
  `main`.
- `origin/main @ 1577c03` ⇒ built by the canonical Production deployment
  `dpl_6gsyNtcr3SYoMJVuRVYQxuTCEaz3`; alias `bi.hrpartner.vn` serves this
  deployment.

## HTTP smoke (unauthenticated outer-gate)

| URL | Status | Body / Headers | Notes |
| --- | --- | --- | --- |
| `https://bi.hrpartner.vn/` | **200** | full landing HTML (Sales Performance / Reporting System V1) | Root page not behind pilot gate; served normally. |
| `https://bi.hrpartner.vn/login` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Pilot Basic Auth outer gate active. |
| `https://bi.hrpartner.vn/api/auth/login` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |
| `https://bi.hrpartner.vn/api/auth/logout` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |
| `https://bi.hrpartner.vn/api/auth/session` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |
| `https://bi.hrpartner.vn/dashboard` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |
| `https://bi.hrpartner.vn/direct-entry` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |
| `https://bi.hrpartner.vn/pipeline-check` | **401** | `WWW-Authenticate: Basic realm="Mini BI Pilot"`, body `Unauthorized` | Same as above. |

Outer-gate behavior is **correct** under the prompt's "Basic Auth credential
intentionally absent" condition:

- The deployment includes the new `/login`, `/api/auth/login`,
  `/api/auth/logout`, `/api/auth/session` route handlers (S01A + S01B) and the
  middleware (`src/proxy.ts`) that gates `/login`, `/login/*`, `/api/auth`,
  `/api/auth/*`, `/direct-entry`, `/direct-entry/*`, `/pipeline-check`,
  `/dashboard`, and other pilot-gated paths.
- Without valid Basic Auth credentials the proxy returns 401 with the
  `WWW-Authenticate: Basic realm="Mini BI Pilot"` challenge, which is the
  expected outer-gate fail-closed behavior.
- An authenticated smoke cannot be run because Basic Auth credentials are
  intentionally absent (per prompt). This is recorded as **deferred to
  Owner** rather than treated as a deployment failure.
- Direct Entry API/UI feature flags are not yet true; `DIRECT_ENTRY_API_ENABLED`
  and `DIRECT_ENTRY_UI_ENABLED` are not set, so Direct Entry remains
  fail-closed at runtime regardless of auth state. This was already documented
  by S01D.
- R2 Production credentials (`R2_ACCOUNT_ID`, `R2_BUCKET_NAME`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are present in the deployment
  environment per the owner. Their presence is **not** consumed by this task:
  no read/print/copy, no use, no mutation. Direct Entry continues to fail
  closed because the Direct Entry feature flags are still disabled.

## Auth and infrastructure invariants verified in this deployment

- `/login`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/session` exist as
  compiled routes (build log from the canonical deployment enumerates them).
- The Pilot Basic Auth proxy still gates every pilot-protected path
  (`/login`, `/api/auth/*`, `/dashboard`, `/direct-entry`, `/pipeline-check`,
  etc.).
- Auth route contracts (S01A) are unchanged on main:
  `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` with
  the documented sanitized error codes.
- Login UI (S01B) is bundled into the static route `/login`.
- S01C acceptance artifacts (52/52 source, 113 prior, 5 CDP screenshots) are
  included in the merged tree; they do not affect the runtime path.

## Deferred

- **Authenticated smoke** for `/login`, `/api/auth/*`, `/dashboard`,
  `/direct-entry`, `/pipeline-check` — pending Owner-supplied Basic Auth
  credential. Not a deployment failure; deferred to Owner per the prompt.
- **Real Supabase Auth / live user UAT** — unchanged from S01D.
- **R2 Production usage** — owner-supplied R2 credentials are present in the
  deployment environment but **not** exercised by this task; Direct Entry is
  still fail-closed because `DIRECT_ENTRY_API_ENABLED` and
  `DIRECT_ENTRY_UI_ENABLED` are not `true`.
- **Capability-aware navigation, role/scope mapping, signup, password-reset,
  admin-user management** — unchanged from S01D.

## Status

`P3-W03-S01E_AUTH_PRODUCTION_DEPLOYED_WAITING_OWNER_UAT`. Not claiming P3 PASS,
P1.6 PASS, or Production ready.