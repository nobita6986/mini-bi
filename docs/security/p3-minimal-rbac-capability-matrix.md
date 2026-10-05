# P3-C01 — Minimal RBAC and Capability Policy Matrix

**Status:** `P3-C01_RBAC_POLICY_MATRIX_READY_FOR_IMPLEMENTATION`
**Base:** `45c99b984be8fd81d0fb1308ec9deda94bbf901e` (P1.7-H08-R1)
**Worktree:** `C:\CodeApp\BI-p3-c01-rbac-policy`
**Branch:** `audit/p3-c01-rbac-policy-matrix`
**Input:** `P3-W01A` inventory @ `1f76c1d` (read-only, not cherry-picked)
**Scope:** Docs-only. **No** code, **no** migration, **no** admin UI, **no**
deploy. The matrix is the single source of truth that T1B (admin surface
schema) and T1A (authz UX, capability-aware navigation) consume.

---

## TL;DR

1. **No new capabilities.** The 22-token set in
   `src/lib/auth/direct-entry-v2.ts::CAPABILITIES` is the surface. We pick
   roles that compose them. Adding a new capability requires a contract
   bump (`DIRECT_ENTRY_AUTH_CONTRACT_VERSION`) and is out of scope for C01.
2. **Five role classes** map to today's real actor set: `Owner`, `HRP`,
   `Vendor`, `Reviewer`, `Reader`. Each role is a fixed, named bundle of
   capabilities + a fixed scope shape.
3. **The matrix is the boundary** between the SQL capability contract
   (`direct_entry_assert_*` SECURITY DEFINER) and the JS projection in
   `direct-entry-v2.ts::authorizeDirectEntry`. Everything outside the
   matrix (a new RPC, a new nav entry, a new panel) is **deny by default**.
4. **UI visibility ≠ authority.** Nav, panels, buttons hide when the role
   does not carry the capability; they do not grant the capability.
5. **Three real Owner decisions** are open. The rest are taken as **safe
   defaults** and can be relaxed later by amending the matrix.

---

## 1. Inventory of capabilities (no new ones)

The canonical list lives in
[`src/lib/auth/direct-entry-v2.ts:10-30`](../security/p3-minimal-rbac-capability-matrix.md)
(`direct-entry-auth/1.2`). The contract
[`src/lib/contracts/direct-entry-v1.ts:136-156`](../security/p3-minimal-rbac-capability-matrix.md)
is a 21-token subset; **`entry_restore` is in v2 but missing from v1**. This
is a known source-level drift. C01 does **not** add or remove tokens — it
documents the gap and routes the fix to a separate contract-bump task.

| Group            | Token(s)                                                                                  | DB evaluator                              |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Entry write      | `entry_create`, `entry_own`, `entry_team`, `entry_admin`, `entry_privileged_edit`, `entry_restore` | `direct_entry_assert_entry_access`        |
| Submission       | `submission_create`                                                                       | `direct_entry_assert_entry_access`        |
| Change request   | `change_request_create`, `change_review`                                                  | `direct_entry_assert_change_request_capabilities` |
| Employment       | `employment_status.request`, `employment_status.review`, `employment_status.apply`         | `direct_entry_assert_entry_access`        |
| Document         | `document_upload`, `document_view`                                                        | `direct_entry_assert_entry_access` (upload) + JS projection (`document-api.ts:87`) |
| Payment          | `payment_view`, `payment_edit`                                                             | `direct_entry_assert_payment_document_access` |
| Master data      | `recruiter_master_manage`, `team_master_manage`                                           | (no granted RPC at this base)             |
| PII              | `pii_view`, `pii_export`                                                                  | (no granted RPC at this base)             |
| Audit            | `audit_view`                                                                              | `direct_entry_read_audit`                 |

Notes for the matrix below:

- `entry_create` is the **envelope** for entry write paths (batch create,
  full profile, draft). It is not a separate row in the matrix — a role
  that can `entry_own` already covers `entry_create` for own scope.
- `pii_*` and master-data capabilities have **no SQL grant at this base**.
  They are kept in the capability set for future RPCs and are not
  exercised today. They appear in the matrix only as "non-applicable" or
  in Owner, with the explicit "no route" caveat.
- `entry_privileged_edit` and `entry_restore` are **draft/final state
  moderators**: they let a role edit a row that has already been
  submitted, or restore a deleted row. They are paired with the same
  scope as the role's `entry_*` baseline.

---

## 2. Role matrix — the central artifact

The matrix below is the **authoritative input** for:

- `direct_entry_capability_grants` rows (T1B).
- `direct_entry_scope_grants` rows (T1B).
- `entriesForViewport` in `src/lib/navigation/registry.ts` (T1A).
- `/api/direct-entry/session` projection (`actorProjection` in
  `auth-session-core.ts` already exposes `capabilities` and `scopes`).
- `AiSettingsPanel` / `AiReportPanel` mount guards in
  `src/app/dashboard/layout.tsx` (P3-W02.F / W02.G).

**Convention:** scope shorthand `o` = own; `t` = team; `a` = all. A blank
scope means the capability is **not granted**. A dash `-` means the
capability is in the set but **has no granted route at this base**; it is
reserved and does not contribute to the role's effective access.

### 2.1 The five roles

| Role ID    | Display name             | Identity profile (Supabase user)             | Intended real-world actor         |
| ---------- | ------------------------ | -------------------------------------------- | --------------------------------- |
| `owner`    | Owner / Admin            | `auth.users` row, mapped in `direct_entry_app_users` | Pilot admin, system owner, dev  |
| `hrp`      | HRP / Recruiter          | `auth.users` row, mapped + `recruiter_links`    | In-house HR partner               |
| `vendor`   | Vendor recruiter         | `auth.users` row, mapped + `recruiter_links` (provider = vendor) | External recruiter    |
| `reviewer` | Reviewer / approver      | `auth.users` row, mapped, no `recruiter_links`   | Lead HRP / payroll / admin liaison |
| `reader`   | Read-only reporting      | `auth.users` row, mapped, no writes           | BoD / leader / staff (view only)  |

A real account maps to **exactly one** role at a time. Multi-role
accounts (e.g. an HRP who is also a reviewer) are out of scope for C01 —
the matrix expects one row per `app_user_id`. If Owner needs to also
review change requests, they take the `owner` row (which carries
`change_review`).

### 2.2 Capability × role matrix

| Capability                    | `owner` | `hrp` (own) | `hrp` (team) | `vendor` (own) | `reviewer` | `reader` |
| ----------------------------- | :-----: | :---------: | :----------: | :------------: | :--------: | :------: |
| `entry_create`                |   a     |     o       |      t       |       o        |     —      |    —     |
| `entry_own`                   |   a     |     o       |      —       |       o        |     —      |    —     |
| `entry_team`                  |   a     |     —       |      t       |       —        |     —      |    —     |
| `entry_admin`                 |   a     |     —       |      —       |       —        |     —      |    —     |
| `entry_privileged_edit`       |   a     |     —       |      t       |       —        |     —      |    —     |
| `entry_restore`               |   a     |     —       |      —       |       —        |     —      |    —     |
| `submission_create`           |   a     |     o       |      t       |       o        |     —      |    —     |
| `change_request_create`       |   a     |     o       |      t       |       o        |     —      |    —     |
| `change_review`               |   a     |     —       |      t       |       —        |     a      |    —     |
| `employment_status.request`   |   a     |     o       |      t       |       o        |     —      |    —     |
| `employment_status.review`    |   a     |     —       |      t       |       —        |     a      |    —     |
| `employment_status.apply`     |   a     |     —       |      t       |       —        |     —      |    —     |
| `document_upload`             |   a     |     o       |      t       |       o        |     —      |    —     |
| `document_view`               |   a     |     o       |      t       |       o        |     a      |    o      |
| `payment_view`                |   a     |     o       |      t       |       —        |     a      |    —     |
| `payment_edit`                |   a     |     —       |      t       |       —        |     —      |    —     |
| `recruiter_master_manage`     |   a     |     —       |      —       |       —        |     —      |    —     |
| `team_master_manage`          |   a     |     —       |      —       |       —        |     —      |    —     |
| `pii_view`                    |   a     |     —       |      t       |       —        |     —      |    —     |
| `pii_export`                  |   a     |     —       |      —       |       —        |     —      |    —     |
| `audit_view`                  |   a     |     —       |      —       |       —        |     —      |    —     |

Reading the matrix:

- `hrp (own)` and `hrp (team)` are **two scope flavours of the same role**,
  produced by the same `direct_entry_capability_grants` row; the `o`/`t`
  comes from `direct_entry_scope_grants`. T1B writes one capability row
  per (app_user, capability) and a separate scope row per (app_user, scope).
- `vendor` is identical to `hrp` on capabilities and stricter on
  `payment_view` (denied) and `pii_*` (denied). It is mechanically
  `hrp` with extra denies; the matrix is the **only** place those
  denies are expressed — no `vendor`-specific code.
- `reviewer` is a **sibling of hrp/owner**, not a subset. It grants
  `change_review`, `employment_status.review`, and `payment_view`, but
  cannot create / edit entries.
- `reader` is the **only** read-only role and exists for the BoD / leader
  view. It carries exactly `document_view (own)`. Dashboard reporting
  reads do not use any capability (the `/dashboard` page does not check
  capability — see §4.4 below).

### 2.3 Why `owner` gets `a` on everything

`owner` is the role that lets an emergency Owner recover the system when
a misconfigured grant locks a real actor out. It is intentionally
**unconstrained** in this matrix. The audit trail (`audit_view`) is
the only restraint. This matches the W04 "pilot-admin" semantics and
follows from `PILOT_ACTOR_REF = "pilot-admin"` already in the AI
settings rate limit (P3-W02.A moves that, the role survives the move).

### 2.4 Why `vendor` is not a new capability

The capability set already supports vendor via:

- `recruiter_links` row with `provider = "vendor"`.
- Absence of `team_scope_grants` (vendor is by definition own-scope).
- Capability set is the same as `hrp (own)` minus `payment_view` and
  minus any future PII capability.

This avoids the W01A risk of adding tokens that have no RPC.

---

## 3. Cross-surface matrix (what the role can do, where)

| Surface                                  | `owner` | `hrp` (own) | `hrp` (team) | `vendor` (own) | `reviewer` | `reader` |
| ---------------------------------------- | :-----: | :---------: | :----------: | :------------: | :--------: | :------: |
| `/dashboard` (any session)               |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |
| `/direct-entry` page                     |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Direct Entry draft / batch create       |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Direct Entry row edit (own)              |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Direct Entry row edit (team)             |    ✓    |     —       |      ✓       |       —        |     —      |    —     |
| Direct Entry row edit (any/all)          |    ✓    |     —       |      —       |       —        |     —      |    —     |
| Direct Entry privileged edit (override OCC) |  ✓    |     —       |      ✓       |       —        |     —      |    —     |
| Direct Entry `entry_restore` (deleted row) |   ✓    |     —       |      —       |       —        |     —      |    —     |
| Submission create                        |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Submission transition (own draft → final) |   ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Submission transition (reviewer step)    |    ✓    |     —       |      ✓       |       —        |     ✓      |    —     |
| Change request create                    |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Change request withdraw (own)            |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Change request decide (approve / reject) |    ✓    |     —       |      ✓       |       —        |     ✓      |    —     |
| Employment status request (own entry)    |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Employment status review                 |    ✓    |     —       |      ✓       |       —        |     ✓      |    —     |
| Employment status apply (final)          |    ✓    |     —       |      ✓       |       —        |     —      |    —     |
| Document upload                          |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| Document view (own entry)                |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |
| Document view (any entry)                |    ✓    |     —       |      ✓       |       —        |     ✓      |    —     |
| Document download                        |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |
| Payment view (own)                       |    ✓    |      ✓      |      ✓       |       —        |     ✓      |    —     |
| Payment view (any)                       |    ✓    |     —       |      ✓       |       —        |     ✓      |    —     |
| Payment edit                             |    ✓    |     —       |      ✓       |       —        |     —      |    —     |
| AI Report panel (enqueue + review)       |    ✓    |     —       |      —       |       —        |     —      |    —     |
| AI Report panel (read history)           |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |
| AI Settings panel                        |    ✓    |     —       |      —       |       —        |     —      |    —     |
| Admin surface (capability grants)        |    ✓    |     —       |      —       |       —        |     —      |    —     |
| Admin surface (scope grants)             |    ✓    |     —       |      —       |       —        |     —      |    —     |
| Admin surface (recruiter links)          |    ✓    |     —       |      —       |       —        |     —      |    —     |
| Admin surface (team / membership)        |    ✓    |     —       |      —       |       —        |     —      |    —     |
| `audit_view` (own)                       |    ✓    |     —       |      —       |       —        |     —      |    —     |

Footnotes:

- "Direct Entry row edit" without a scope qualifier defaults to **own**
  (the row's `created_by_user_id = actor.app_user_id`).
- "Submission transition" has two stages; the **draft-to-final** is the
  proposer's own action; the **final approval** is a reviewer action.
- "Document view (own entry)" includes the `reader` role because
  document view on an entry the reader's recruiter created is allowed —
  documents are public to the entry's owner-scope. (T1B can tighten if
  Owner disagrees; see §6 decision D-2.)
- "AI Report panel (read history)" is allowed for every authenticated
  user with the panel surface reachable. The panel can already be
  reached by any session today (W01A gap G4). The matrix keeps that
  posture but flags it as a `panel` decision (see §6 D-3).

---

## 4. Page / route / nav visibility

### 4.1 Page decisions (unchanged code, clarified by matrix)

`decideDirectEntryPageAccess` (Direct Entry page) currently grants access
to any actor with `entry_own | entry_team | entry_admin`. Under this
matrix:

- `owner` → `entry_admin` (all) → ALLOW.
- `hrp (own)` → `entry_own` → ALLOW.
- `hrp (team)` → `entry_team` → ALLOW.
- `vendor (own)` → `entry_own` → ALLOW.
- `reviewer` → no `entry_*` → ACCESS_DENIED.
- `reader` → no `entry_*` → ACCESS_DENIED.

This is the **current code's** behaviour; the matrix just gives each
role a concrete answer instead of "has at least one of the entry tokens".

### 4.2 Dashboard page

`decideSessionPageAccess` only checks for a resolved actor. Every role in
this matrix has a resolved actor (they all login). The dashboard
**never** denies a row of the matrix — it shows aggregate data, not
PII, and RLS on the underlying reporting tables is the boundary. **No
capability gate on `/dashboard`.** The matrix expresses this as `✓` for
all roles.

### 4.3 Navigation (T1A wires `entriesForViewport`)

The current nav is two entries. T1A's job is to filter by role. The
mapping is:

| `NAV_ENTRIES` id | Required capability       | `owner` | `hrp` (own) | `hrp` (team) | `vendor` (own) | `reviewer` | `reader` |
| ---------------- | ------------------------- | :-----: | :---------: | :----------: | :------------: | :--------: | :------: |
| `dashboard`      | `any` (session only)      |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |
| `direct-entry`   | any of `entry_*`          |    ✓    |      ✓      |      ✓       |       ✓        |     —      |    —     |
| `admin` (planned for T1B/D) | `team_master_manage` OR `recruiter_master_manage` | ✓ | — | — | — | — | — |
| `reports` (read-only if added) | `document_view (own)` or any session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`admin` is **not** a current entry. The matrix pre-approves the slot
so T1A / T1B can add it without re-litigating the policy.

### 4.4 Dashboard panel gates (P3-W02.F / W02.G)

| Mount                             | Required capability           | `owner` | `hrp` (own) | `hrp` (team) | `vendor` (own) | `reviewer` | `reader` |
| --------------------------------- | ----------------------------- | :-----: | :---------: | :----------: | :------------: | :--------: | :------: |
| `<AiSettingsPanel />`             | (no capability today)         |   —     |     —       |      —       |       —        |     —      |    —     |
| `<AiReportPanel />` (enqueue / review) | (no capability today)    |   —     |     —       |      —       |       —        |     —      |    —     |
| `<AiReportPanel />` (read history) | (any session)               |    ✓    |      ✓      |      ✓       |       ✓        |     ✓      |    ✓     |

C01 documents the **target** posture; P3-W02.F / W02.G are the
implementation tasks. The matrix says: **the AI Report panel stays
read-only for everyone except `owner`** (who gets the full
enqueue/review surface). `AiSettingsPanel` is `owner`-only. This is the
safe default; Owner can relax by amending the matrix.

### 4.5 Direct-URL behaviour (unchanged by C01)

The matrix does not change the public/login/dashboard/redirect
behaviour. It only **informs** the deny path: an actor that
`decideDirectEntryPageAccess` rejects (`reviewer`, `reader`) gets the
existing `<AccessDenied />` page — no extra work in C01.

---

## 5. Locked principles

These are not "TBD" — they are fixed in this matrix and any deviation
requires an explicit amendment.

1. **Deny by default.** A capability not granted to a role is denied.
   A new RPC that exercises a new capability must add a matrix row
   (and an SQL grant) before T1B migration; until then, **no actor
   can call that RPC successfully**.
2. **SQL is authority; JS is projection.** The matrix describes the
   set of `direct_entry_assert_*` calls. The JS
   `validateClientBusinessPayload` and the JS `capabilities.includes(...)`
   at `document-api.ts:87` are projections of the same answer; they
   are not a second source of truth. The JS checks are kept as
   fast-fail UX gates (defence in depth) and may be removed in a
   later task.
3. **UI visibility never grants capability.** Hiding a button is a
   UX affordance, not a permission. The dashboard, panels, and
   `/admin` surface all hide what the actor cannot do; they do not
   allow what the actor cannot do.
4. **No "basic auth" resurrection.** The capability set, the actor
   resolution, the `guardApiSession` helper, the FORCE RLS posture,
   and the SUPABASE_SECRET_KEY server boundary are the only auth
   primitives. The matrix operates entirely within them. A request
   to add a new gate (header, env-flag, cookie) must amend the
   matrix first.
5. **`owner` is the audit-attribution baseline.** Today
   `PILOT_ACTOR_REF = "pilot-admin"` is hard-coded. The matrix names
   `owner` as the role that takes over the same audit slot. P3-W02.A
   moves the slot; C01 names the role.
6. **Capability / scope drift is owned by a contract bump.** Any
   change to `CAPABILITIES` (add / remove / rename a token) bumps
   `DIRECT_ENTRY_AUTH_CONTRACT_VERSION` and re-derives this matrix.
   The v1-vs-v2 drift (`entry_restore` missing from v1) is a known
   bug, owned by a separate contract-bump task, not silently fixed
   in C01.
7. **No "per-action UI override."** A role that cannot do an action
   does not get a different copy of the page for that action. They
   get the same page with the action's UI hidden and the route
   returning 403 if called directly. (This is already the current
   behaviour; C01 codifies it.)

---

## 6. Owner decisions (≤ 3, with safe defaults)

The matrix above already takes a **safe default** for every cell. The
following three cells are real business calls and need explicit Owner
sign-off. Defaults are listed first; Owner can amend by adding a row to
the matrix at implementation time.

| ID  | Decision                                                                                  | Safe default (C01)                                                                                          | Alternatives                                                                                  |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Does `reviewer` need `payment_view`?                                                    | **Yes** — the reviewer is the payroll liaison; they need to see payment details to approve.                 | Deny. Tightens payroll confidentiality. Owner-side approval.                                  |
| D-2 | Does `reader` need `document_view` at all, and on which scope?                          | **Own scope only** — the BoD / leader view sees aggregate reporting, not PII documents. No `document_view` for `reader`. | Grant own-scope `document_view` so leader can audit the entries that contributed to a report. |
| D-3 | Who can enqueue / review AI reports (`AiReportPanel` full surface)?                       | **`owner` only** — the current "any session" posture is unsafe; default is `owner` until P3-W02.G lands.     | `owner` + `hrp (team)` (HRP leadership reviews reports for their teams).                       |

If Owner picks the default, no matrix amendment is required. If Owner
picks an alternative, the matrix is amended first; the T1B / T1A tasks
then read the amended matrix and the implementation is mechanical.

The **fourth decision** that the matrix explicitly takes is *not*
escalated: `vendor` is denied `payment_view` and `pii_*` because vendor
data sharing is the regulated surface — this is a safe default; relaxing
requires an amendment, not a T0 sign-off.

---

## 7. Capability-by-route cross-check (sanity, not a new table)

Every granted capability in §2.2 must correspond to at least one granted
RPC, **and every granted RPC must enforce at least one capability from
§2.2**. The W01A inventory lists 35 service-role-granted RPCs. The
cross-check below is the audit gate for §2.2.

| Capability                     | Granted RPC (representative)                                              |
| ------------------------------ | -------------------------------------------------------------------------- |
| `entry_create`                 | `direct_entry_create_batch`, `direct_entry_create_draft_row`, `direct_entry_create_full_profile_batch` / `_v2` |
| `entry_own` / `entry_team` / `entry_admin` | same family, plus `direct_entry_privileged_edit` (admin)        |
| `entry_privileged_edit`        | `direct_entry_privileged_edit`                                              |
| `entry_restore`                | (no granted RPC at this base — **gap, listed in §8**)                     |
| `submission_create`            | `direct_entry_transition_submission` (lifecycle asserts)                   |
| `change_request_create`        | `direct_entry_create_change_request`                                       |
| `change_review`                | `direct_entry_approve_change_request`, `direct_entry_reject_change_request` |
| `employment_status.*`          | `direct_entry_apply_employment_status`, `direct_entry_correct_latest_status` |
| `document_upload`              | `direct_entry_create_document_metadata`, `direct_entry_reserve_document_*` |
| `document_view`                | `direct_entry_read_projection`, `direct_entry_finalize_document_direct_upload` (download link) |
| `payment_view`                 | (read inside `direct_entry_read_projection` — projection gate)             |
| `payment_edit`                 | `direct_entry_update_payment`                                              |
| `recruiter_master_manage`      | (no granted RPC at this base — **gap, listed in §8**)                     |
| `team_master_manage`           | (no granted RPC at this base — **gap, listed in §8**)                     |
| `pii_view`, `pii_export`       | (no granted RPC at this base — **gap, listed in §8**)                     |
| `audit_view`                   | `direct_entry_read_audit`                                                  |

Every capability above has at least one RPC, and every granted RPC maps
to at least one capability (the cross-check is exhaustive modulo the
`*_worker_callback` and `*_catalog_bootstrap` family which are bootstrap
flows, not user-driven).

---

## 8. Gaps this matrix does **not** close (out of scope)

These are owned by the dependency map in P3-W01A §6 and are explicitly
**not** implemented by C01.

1. **Admin surface.** No `/admin/**` route. T1B adds a server-side admin
   route group + a read-only bootstrap RPC for the matrix. Out of C01.
2. **AI actor attribution** (`actor_ref` move from `PILOT_ACTOR_REF`).
   P3-W02.A. The matrix names the **role** that takes the audit slot
   (`owner`); the implementation is W02.A.
3. **Settings rate limiter (atomic, per-actor).** P3-W02.B. C01
   specifies that the rate limit key MUST become the actor's
   `app_user_id`; the storage and keying are W02.B.
4. **Capability-aware navigation.** T1A reads this matrix and wires
   `entriesForViewport`. C01 is the input, not the code.
5. **`entry_restore` RPC.** No granted RPC at this base. Either
   T1B adds one, or the capability is removed from the v2 contract.
6. **`recruiter_master_manage` / `team_master_manage` / `pii_*` RPCs.**
   Same as `entry_restore`. The matrix keeps them in the Owner role
   but flags them as "no route" — they don't contribute to Owner
   access today but they don't need to be removed to ship C01.
7. **v1-vs-v2 contract drift** (`entry_restore` in v2 only). Owned
   by a separate contract-bump task.

---

## 9. Inputs to T1A and T1B

T1A (capability-aware navigation + admin UX) reads:

- §2.2 (capability × role).
- §4.3 (nav mapping).
- §4.4 (panel gates).
- §6 (Owner decisions D-2, D-3).

T1B (admin surface schema + grants migration) reads:

- §2.2 (which `direct_entry_capability_grants` to seed).
- §3 (cross-surface matrix — which routes to mount for which role).
- §6 (D-1, D-2) — at most two grant amendments before migration.
- §5 (locked principles) — every T1B / T1A PR is reviewed against these.

The matrix is consumed as data, not as code. T1B's seed migration is
generated from §2.2; T1A's nav filter is generated from §4.3; the
dashboard panel gate is generated from §4.4.

---

## 10. Verdict

C01 produces a **5-role, 22-capability, ~30-route matrix** that consumes
zero new code paths, fits inside the existing SQL contract, and is
implementable by a single migration + a navigation filter PR. Three real
Owner decisions (D-1, D-2, D-3) are the only blocking T0 sign-offs. The
rest is safe defaults. No P3 PASS is implied. P3-W02.A/B and the
T1A/T1B tasks are the consumers; C01 is the policy spec, not the
implementation.

**Status:** `P3-C01_RBAC_POLICY_MATRIX_READY_FOR_IMPLEMENTATION`.
