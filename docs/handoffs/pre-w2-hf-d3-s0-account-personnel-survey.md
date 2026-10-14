# Pre-W2-HF-D3-S0 — Account ↔ recruiter-personnel relationship survey (docs-only)

> Status: `PRE_W2_HF_D3_S0_SURVEY_COMPLETE_AWAITING_T0_REVIEW`
> Base: `origin/main@9c2fdb5` (branch `codex/vps-deploy-hardening`, 85 migrations).
> Kind: read-only survey. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT. Only this handoff is written.
> Owner intent (summary): recruitment personnel is an operational assignment, not a free-standing profile. Adding a recruiter must first create/select an Access Account, then link a personnel profile to that account. The current Access Account screen lacks create/edit/password flows.

## 1. Current-base facts

| # | Evidence (file:symbol:line) | Fact that binds this survey |
|---|---|---|
| E1 | `20261002170000_p1_6_direct_entry_foundation.sql:5-10` | `public.direct_entry_app_users` = the "Access Account" (app user). Columns: `app_user_id` PK, `auth_subject uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT`, `enabled bool default true`, `created_at`. |
| E2 | `20261008220000_p2_5_hf_session_identity_header.sql:18-81` (#62) | `direct_entry_app_users.display_name` added, backfilled from the login email local-part (`split_part(email,'@',1)`), NOT NULL, canonical (`= btrim`, 1..256). This is the canonical **display name**, distinct from the login identity. |
| E3 | `20261011150000_p3_1_w03a_app_user_lifecycle.sql:11-13` (#82) | `direct_entry_app_users.version` + `updated_at` added. OCC root for account status. |
| E4 | `foundation.sql:62-72` | `direct_entry_app_user_recruiter_links`: `link_id` PK, `app_user_id` FK, `recruiter_id` FK, `verified bool default false`, half-open `[valid_from, valid_to)`, `unique(app_user_id, recruiter_id, valid_from)`. Account identity is a **separate link row**, not a column on `recruiters`. |
| E5 | `foundation.sql:516-558` `direct_entry_guard_effective_interval()` + trigger `direct_entry_recruiter_link_no_overlap` | At most **one verified effective link per app_user** (key `recruiter-link:<app_user_id>`). The guard is per **app_user**, so one recruiter may still be linked to more than one app_user across different `app_user_id`. |
| E6 | `foundation.sql:12-18, 40-60, 74-106` | `recruiters` (personnel), `recruiter_provider_memberships`, `recruiter_team_memberships`, `direct_entry_capability_grants`, `direct_entry_scope_grants` — all present with half-open intervals and per-key overlap guards. |
| E7 | `foundation.sql:784-815` `direct_entry_assert_actor` + `20261011150000...:52-92` `direct_entry_assert_actor_app_user_admin` | Runtime actor check = enabled app_user whose `auth_subject` matches the session, plus capability grants (+ `all` scope for account admin). Account admin is the **Full Admin triple** (`entry_admin` + `recruiter_master_manage` + `team_master_manage`) at effective `all`. |
| E8 | `foundation.sql:3222-3248` | Every Direct Entry table (incl. `direct_entry_app_users`, `direct_entry_app_user_recruiter_links`) is `enable` + `force` RLS and `revoke all ... from public, anon, authenticated, service_role`. **`service_role` has no direct DML/SELECT**; all runtime access is via narrow SECURITY DEFINER RPCs. |
| E9 | `20261003180000_p1_6_w04_s03a_actor_context.sql` + `#62:86-177` `direct_entry_resolve_actor_context` | The single server-side actor context RPC (service-role only) returns `auth_subject, app_user_id, display_name, enabled, capabilities, recruiter_links, teams, team_scope_grants, all_scope_grants`. No email/auth metadata. |
| E10 | `src/lib/auth/direct-entry-v2.ts:328-432` `resolveActor` | TS-side fail-closed resolution: `>1 verified effective link` → `AMBIGUOUS_RECRUITER_LINK`; `>1 overlapping team scope` → `AMBIGUOUS_TEAM_MEMBERSHIP`; no mapping → `ACTOR_MAPPING_MISSING`; disabled → `ACTOR_DISABLED`. |
| E11 | `20261009040000_p3_1_w01b_personnel_catalog.sql` (#68) + `src/lib/direct-entry/personnel-catalog-*.ts` | Personnel catalog landed: `direct_entry_create_personnel`, `direct_entry_update_personnel` (only `display_name`, `personnel_code`, `personnel_position`), `direct_entry_set_personnel_active`, list/get. Create writes one `recruiters` row + one HRP `recruiter_provider_memberships` row; **no account/link is created**. |
| E12 | `20261011150000...` (#82) + `..._r2_account_read` (#83) + `..._r2_r1_account_read_repair` (#84) + `src/lib/direct-entry/app-user-access-*.ts` + `src/app/api/admin/access/accounts/**` | Account lifecycle landed: `direct_entry_enable_app_user` / `direct_entry_disable_app_user` / `direct_entry_list_app_users_admin` / `direct_entry_get_app_user_admin`. API: `GET /api/admin/access/accounts`, `GET .../[accountRef]`, `POST .../[accountRef]/{enable,disable}`. Projection = `{account_ref, display_name, enabled, version}`; mutation = `{expected_version, reason, idempotency_key}`. **Create/edit/password absent.** |
| E13 | `src/lib/auth/change-password-core.ts` + `src/app/api/auth/change-password/route.ts` | Self-service password change (W09A): session is the only authority for "which user"; re-auth via `signInWithPassword`; `updateUser({password})`. `resolveIdentifierToEmail` maps a bare HRP id to `<id>@hrpartner.vn`. |
| E14 | `scripts/p3-first-owner-bootstrap.mjs:326`, `scripts/p3-w07b-access-bootstrap.mjs:110-220`, `scripts/p2-5-accounting-project-admin-provision.mjs` | **The only current account-creation path is offline scripts**: `admin.auth.admin.createUser({email,password,email_confirm:true})` + direct `INSERT INTO public.direct_entry_app_users` (via a direct postgres connection) + capability/scope/link inserts. There is **no runtime RPC/API** that creates an account or link. |
| E15 | `20261011180000_p3_w05b_a_team_reporting.sql` (#85) | Current migration ledger = **85 migrations**. W03A = #82–#84; #85 = W05B team reporting. This survey reserves **no** slot. |

## 2. Data relationship map

```
auth.users (Supabase Auth, NOT public)
  id (uuid) = "auth_subject"        -- login identity: email + password
  email (canonical: <hrp-id>@hrpartner.vn)
        │  1:1  UNIQUE, ON DELETE RESTRICT
        ▼
public.direct_entry_app_users        -- "Tài khoản truy cập" (app user/account)
  app_user_id (uuid PK)
  auth_subject (uuid UNIQUE FK)
  display_name (canonical, NOT NULL) -- display name (≠ login email)
  enabled, version, created_at, updated_at
        │  1:0..N (half-open interval, one verified effective)
        ▼
public.direct_entry_app_user_recruiter_links
  link_id (uuid PK) · verified bool · [valid_from, valid_to)
        │
        ▼
public.recruiters                     -- "Nhân sự tuyển dụng" (personnel)
  recruiter_id (uuid PK) · display_name · personnel_code · personnel_position · active · version
        │        │
        │        └── public.recruiter_team_memberships  (personnel → team, half-open)
        └─────────── public.recruiter_provider_memberships (personnel → HRP/Vendor)

Capability/scope (on app_user):
  direct_entry_capability_grants (app_user_id, capability, [valid_from, valid_to))
  direct_entry_scope_grants       (app_user_id, scope_kind ∈ own|team|all, team_id?, interval)
```

Canonical keys and source of truth:

- **Login identity** = `auth.users.id` + `auth.users.email` (Supabase Auth). Never exposed in projections.
- **Account** = `direct_entry_app_users.app_user_id`, joined to login via unique `auth_subject`.
- **Personnel** = `recruiters.recruiter_id`.
- **Account ↔ personnel** = `direct_entry_app_user_recruiter_links` (verified + effective interval), not a column and not an email match.

Edge cases:

| Case | Today's state | Survey position |
|---|---|---|
| Personnel without account | `recruiters` row with no link (and no app_user). Valid; E11 create-personnel does exactly this. | Preserve. Do not auto-attach. |
| Account without personnel | `direct_entry_app_users` with no verified link (e.g. Accounting/Admin). Valid. | Preserve. |
| 1 account ↔ 1 personnel (verified link) | Canonical case; actor resolution yields a single `self_recruiter_suggestion`. | Target of the create-from-account flow. |
| 1 account → >1 verified effective link | Rejected by overlap trigger (23P01) and fail-closed `AMBIGUOUS_RECRUITER_LINK`. | Already guarded. |
| 1 account → multiple **historical** links | Allowed (different intervals / recruiters); history preserved. | Preserve; never rewrite. |
| 1 personnel → multiple accounts | **Not** guarded by E5 (guard is per app_user). Possible today. | Flag for T0 decision (see §8). |
| Unmapped / disabled / ambiguous | Fail-closed at session resolution (E10). | Preserve. |

## 3. Call graph (Auth user → account → personnel)

```
Supabase Auth cookie session
  └─ supabase auth.getUser()  → auth_subject = auth.users.id          [server]
       └─ getDirectEntryActor(createDirectEntryActorRepository())
            └─ resolveActor()                                         [server, direct-entry-v2]
                 └─ repository.loadByAuthSubject(auth_subject)
                      └─ RPC direct_entry_resolve_actor_context(p_auth_subject)  [service_role, SECURITY DEFINER]
                           └─ SELECT direct_entry_app_users WHERE auth_subject = $1
                                → {auth_subject, app_user_id, display_name, enabled,
                                   capabilities, recruiter_links, teams,
                                   team_scope_grants, all_scope_grants}
                 └─ resolveActor validates record, then derives:
                      capabilities (effective) · scopes (own + team + all) ·
                      self_recruiter_suggestion (from verified effective recruiter_links)
        Failure taxonomy: UNAUTHENTICATED · ACTOR_MAPPING_MISSING · ACTOR_DISABLED ·
                          AMBIGUOUS_RECRUITER_LINK · AMBIGUOUS_TEAM_MEMBERSHIP ·
                          ACTOR_REPOSITORY_MISSING/INVALID
```

Account admin mutation path (existing, W03A):

```
POST /api/admin/access/accounts/[accountRef]/{enable,disable}
  → resolveTrustedActor()            (session → auth_subject + app_user_id; CSRF/origin)
  → validateClientBusinessPayload()  (reject client authority fields)
  → parseAccountMutation()           (exact body {expected_version, reason, idempotency_key})
  → repository.{enable,disable}Account()
      → RPC direct_entry_{enable,disable}_app_user(auth_subject, actor, target, version, reason, key)
           → direct_entry_assert_actor_app_user_admin()  (Full Admin triple + all)
           → lock actor/target · OCC on app_user.version · idempotency · revision · audit
```

Personnel catalog mutation path (existing, W01B):

```
POST /api/admin/personnel...
  → direct_entry_assert_catalog_operator()  (catalog_master_manage@all OR Full Admin)
  → direct_entry_{create,update}_personnel / direct_entry_set_personnel_active
       create → one recruiters row + one HRP provider membership (+ reason/idempotency/revision/audit)
```

## 4. Reuse matrix

| New need | Reuse unchanged | Minimum delta (survey proposal) | Do not do |
|---|---|---|---|
| Create Access Account | Supabase Admin `createUser` (server, service key) — proven in E14 scripts; existing Full-Admin guard; `direct_entry_reason` / idempotency / audit; account projection shape | New SECURITY DEFINER RPC `direct_entry_create_app_user(auth_subject_of_creator, target_auth_subject, display_name, ...)` to insert the `direct_entry_app_users` row (service_role cannot DML per E8); new `POST /api/admin/access/accounts` create branch | Do not use `signUp`/public invite; do not let client send email/`auth_subject` as business authority; do not insert app_users via direct DB connection in the API |
| Edit account fields | Existing enable/disable OCC + revision + audit chain; `display_name` canonical validator | New RPC `direct_entry_update_app_user_display_name` (field-scoped to `display_name` only) with `expected_version`/reason/idempotency/revision/audit; new API `PATCH/POST .../[accountRef]/display-name` | Do not expose email edit in the smallest scope; do not reuse personnel `direct_entry_update_personnel` for accounts |
| Reset password | Self-service `change-password-core` patterns; Supabase Admin `updateUserById({password})` | New Full-Admin route `POST .../[accountRef]/reset-password` + a **service-role-only** RPC to resolve `account_ref → auth_subject` (projections deliberately hide `auth_subject`), then `admin.updateUserById`; reason/audit | Do not expose `auth_subject`/email to the browser; do not add forgot-password/recovery/email send |
| Create personnel **from** an existing account | `direct_entry_create_personnel` (recruiters + HRP membership); `direct_entry_app_user_recruiter_links` table + overlap guard | New atomic RPC `direct_entry_create_personnel_from_account` = create recruiter + HRP membership + **verified link** to the caller-chosen account, in one transaction | Do not open a standalone link editor (that is W03C); do not auto-link by email/display-name match; do not create a standalone recruiter without a chosen account |
| Read account for linking | `direct_entry_get_app_user_admin` / `direct_entry_list_app_users_admin` | Add a Full-Admin "linkable account" list/detail that may return a bounded `recruiter_link_state` (none/current/ambiguous) — **only** if T0 approves; otherwise reuse existing list/detail and select by opaque `account_ref` | Do not return `auth_subject`/email; do not derive link state client-side |

## 5. Smallest safe scope and minimal contracts (proposal)

Scope is **recruitment accounts + recruitment personnel only**. No invite link, no MFA, no recovery/forgot-password, no account recreation, no department/RBAC model.

### 5.1 Create Access Account

- Authority: **Full Admin only** (same `direct_entry_assert_actor_app_user_admin` boundary as enable/disable; not Accounting).
- Server flow (single route handler): resolve Full Admin actor → CSRF/origin → bounded JSON → `validateClientBusinessPayload` → validate input → `admin.auth.admin.createUser({ email, password, email_confirm: true })` → RPC `direct_entry_create_app_user(actor_auth_subject, actor_app_user_id, target_auth_subject, display_name, reason, idempotency_key)` → return `{ok:true}` (no optimistic projection; authoritative reload).
- Input contract (server-validated, client cannot send authority):
  - `login_id` (HRP id / email local-part, canonicalized to `<id>@hrpartner.vn`) — or an explicit email if T0 relaxes the convention;
  - `display_name` (1..256, canonical);
  - `password` (initial, server-chosen or admin-entered; never echoed/logged);
  - `reason` (1..4000) + `idempotency_key` (UUID).
- Invariants: `auth_subject` unique (reject existing); `display_name` canonical; one `direct_entry_app_users` row + reason/idempotency/audit rows in one transaction; zero residue on failure; replay returns stored result.

### 5.2 Edit account fields (smallest)

- Only `display_name` is editable in this slice. `account_ref` (`app_user_id`), `auth_subject`, `enabled` (via existing enable/disable), and `version` (OCC) are immutable here.
- Contract: `{ account_ref, expected_version, display_name, reason, idempotency_key }` → `direct_entry_update_app_user_display_name`. Result `{ok:true}`; authoritative reload. Audit action must be added to the W03A revision action vocabulary (see §7).

### 5.3 Reset password (safe)

- Only **admin-forced reset** (set a new password for a chosen account), Full Admin only.
- Server flow: `account_ref` → RPC `direct_entry_get_app_user_auth_subject(actor, target)` (service-role only, returns the `auth_subject` — never to the browser) → `admin.updateUserById(auth_subject, { password })`. Reason + idempotency + audit event recorded (no password stored).
- No self-service target naming: the session actor is never the reset target selector.

### 5.4 Create personnel from an existing account (no standalone recruiter)

- One atomic RPC `direct_entry_create_personnel_from_account(actor, target_app_user_id, display_name, personnel_code, personnel_position, valid_from, reason, idempotency_key)`:
  1. Full Admin (or Full Admin + Accounting — **T0 decision**; link creation is security-sensitive, recommend Full Admin);
  2. validate `target_app_user_id` exists and is enabled;
  3. create `recruiters` row + HRP `recruiter_provider_memberships`;
  4. create `direct_entry_app_user_recruiter_links` with `verified = true` for `valid_from` (open-ended);
  5. write reason/idempotency/revision/audit in the same transaction; rollback all on failure.
- This intentionally **replaces** the "create standalone recruiter" path for account-backed personnel and does **not** expose a standalone link editor (that remains W03C).

## 6. Identity vs display name (email-change boundary)

- **Login identity** = `auth.users.email` (canonical `<hrp-id>@hrpartner.vn`; E13/E14). It is the Supabase sign-in identifier and the input to `resolveIdentifierToEmail`.
- **Display name** = `direct_entry_app_users.display_name` (canonical; E2). Rendered in the account list/header; independent of email.
- **Recommendation:** do **not** expose email change in this slice. Email change touches Supabase Auth (`admin.updateUserById({ email })`) and alters the login label; the `auth_subject` FK is unchanged, but the `<hrp-id>@hrpartner.vn` convention (used by self-service password re-auth) would need its own guard if email becomes freely editable.
- If email change is later required, it must be a separate Full-Admin server mutation with reason/audit and an explicit decision on whether the login label stays `login_id@hrpartner.vn`.

## 7. Migration impact (observe only — no slot reserved)

Current ledger: **85 migrations**. This survey reserves nothing and edits nothing.

Required new DDL/RPC surface (each is a future append-only migration, one work item at a time):

1. `direct_entry_create_app_user` — insert into `direct_entry_app_users` (needed because `service_role` has no table DML, E8). New function + `revoke all` + `grant execute to service_role` + self-check.
2. `direct_entry_update_app_user_display_name` — field-scoped update. **Also** requires widening the `direct_entry_app_user_revisions.action` CHECK (currently 8 fixed actions) with a display-name action, or T0 chooses to reuse an existing action — decision required.
3. `direct_entry_get_app_user_auth_subject` — service-role-only resolver for admin password reset (projections hide `auth_subject` by design).
4. `direct_entry_create_personnel_from_account` — atomic recruiter + HRP membership + verified link creation.

No new tables or columns are required. Reset-password itself is **no** DB change (Supabase Admin API); it only needs resolver #3.

## 8. Decisions required from T0 / Owner

1. **Account-create authority:** Full Admin only (recommended, consistent with W03A) — or also Accounting (`catalog_master_manage@all`)? Link creation is security-sensitive; recommend Full Admin only.
2. **Login identity convention:** keep `login_id@hrpartner.vn` as the only create-account login format, or allow an explicit email?
3. **Initial password policy:** server-generated vs admin-entered; minimum length/strength (align with Supabase + `MIN_PASSWORD_BYTES` in self-service).
4. **Display-name edit** (and its revision action): approve `display_name`-only edit, and approve widening the W03A revision action vocabulary vs reusing an existing action.
5. **Create-personnel-from-account authority + link scope:** confirm the atomic "create recruiter + HRP membership + verified link" flow, and confirm it must **not** evolve into a standalone W03C link editor in this slice.
6. **One personnel ↔ multiple accounts** (E5 gap): accept as-is, or add a guard later? Not in this slice's minimal contract.
7. **Data preservation rules (locked by this survey):** no delete, no merge-by-email, no UUID change, no automatic account↔personnel attach without a proven explicit relationship. Confirm.
8. **Scope guardrails (locked):** no invite link, no public sign-up, no MFA, no forgot-password/recovery, no account recreation, no multi-department/accounting/IT model. Confirm.

## 9. Acceptance / mutation matrix (proposed, for the future implementation lane)

| # | Case | Expected |
|---|---|---|
| A1 | Full Admin creates account (new login + new app_user) | `{ok:true}`; auth user + app_user + reason/idempotency/audit rows; authoritative reload shows `display_name`/`enabled`/`version=1` |
| A2 | Accounting / Project Admin / leader / staff / disabled actor creates account | denied (403) before mutation |
| A3 | Existing `auth_subject`/login reused | conflict, zero residue |
| A4 | Invalid/oversized `display_name`, reason, or non-UUID idempotency key | 400, zero residue |
| A5 | Same key + same payload replay | byte-identical stored result, no second user/app_user |
| A6 | Same key + different payload | 22023 before mutation |
| A7 | Admin edits `display_name` with correct `expected_version` | version +1; revision + audit; `auth_subject`/`enabled` unchanged |
| A8 | Stale `expected_version` on edit | 40001, row unchanged |
| A9 | Admin reset password for `account_ref` | new password set via Supabase Admin; no password echoed/logged/stored; audit recorded |
| A10 | Reset password for missing/disabled account or by non-Full-Admin | 404 / 403, no mutation |
| A11 | Create personnel from account (recruiter + HRP membership + verified link) | one transaction; recruiter + membership + link + reason/idempotency/revision/audit; actor resolution then yields a single `self_recruiter_suggestion` |
| A12 | Create personnel from a disabled/unmapped account | denied before mutation |
| A13 | Duplicate personnel code / overlapping verified link | 23505 / 23P01, full rollback |
| A14 | Any projection | no `auth_subject`, no email, no capability/scope rows, no raw reason, no raw DB message |

## 10. Implementation ordering (proposed)

1. **Account create** (`direct_entry_create_app_user` + create API) — unblocks the "account first" precondition.
2. **Display-name edit** (`direct_entry_update_app_user_display_name` + API).
3. **Admin reset password** (`direct_entry_get_app_user_auth_subject` + route, no DB write).
4. **Create personnel from account** (`direct_entry_create_personnel_from_account`) — replaces standalone recruiter creation for account-backed personnel.
5. Account UI: extend the existing `/admin/access/accounts` page with create/edit/reset, then a "create personnel from this account" action reusing the personnel catalog create form.

Each step lands as one reviewed append-only migration + one focused API/UI lane; run focused regression + `pnpm test` + `docs:check` + `secrets:check` + `db:migrate --offline` gates.

## 11. Boundary

Read-only survey: no source/package/SQL edit, no DB access/mutation, no migration apply, no deploy VPS/Vercel, no browser/UAT, no account creation/modification. No PII, email, user UUID, credential or raw database error was read or printed. Only this handoff is written.
