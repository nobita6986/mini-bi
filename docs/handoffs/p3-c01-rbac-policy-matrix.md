# P3-C01-R2 — Policy Contract Count Corrected (Handoff)

**Status:** `P3-C01-R2_POLICY_CONTRACT_COUNT_CORRECTED_READY_FOR_IMPLEMENTATION`
**Base:** `45c99b984be8fd81d0fb1308ec9deda94bbf901e`
**Worktree:** `C:\CodeApp\BI-p3-c01-rbac-policy`
**Branch:** `audit/p3-c01-rbac-policy-matrix`
**Revision:** R2 — capability count and v1/v2 drift claim corrected. The
canonical source of truth is `CAPABILITIES` in
`src/lib/auth/direct-entry-v2.ts:10-30`, which enumerates **21
tokens**. The `Capability` type union in
`src/lib/contracts/direct-entry-v1.ts:136-157` enumerates the **same
21 tokens** in the same order, including `entry_restore`. There is
**no v1-vs-v2 drift** at this base. C01 and R1 overstated the count
as twenty-two (`22`) and asserted a v1-missing-`entry_restore` drift;
R2 supersedes both.
**Predecessor:** [`docs/handoffs/p3-c01-rbac-policy-matrix.md`](../handoffs/p3-c01-rbac-policy-matrix.md) (R1, superseded for the count / drift items; all policy locks retained).
**Artifact:** [`docs/security/p3-minimal-rbac-capability-matrix.md`](../security/p3-minimal-rbac-capability-matrix.md)

---

## What R1 changed vs C01

Only the two C01 documents were edited. The diff is:

| Lock / change                          | Where it lands in the matrix                                                                                                | What is now banned                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **D-1 LOCKED** — `reviewer` ⊄ `payment_view` | §2.2 capability × role, §3 cross-surface, §6 decision table                                                                | Reviewer can no longer view payment data on any entry; the JS projection in `authorizeDirectEntry` mirrors the SQL deny. |
| **D-2 LOCKED** — `reader` ⊄ `document_view` at any scope | §2.2 capability × role, §3 cross-surface, §6 decision table; previous "carries `document_view (own)`" wording is replaced | Reader's path is `/dashboard` only. Document storage is unreachable. The previous matrix cell `o` for reader is `—`. |
| **D-3 LOCKED** — entire AI surface is `owner`-only (settings, enqueue, review, history) | §3 cross-surface, §4.3 nav mapping (admin entry requires AND), §4.4 panel gates, §6 decision table | The "all authenticated users read history" posture is withdrawn. Non-`owner` roles see no AI panel. |
| **Admin authority** — AND of `entry_admin` ∧ `recruiter_master_manage` ∧ `team_master_manage` | §2.1a (new subsection, T0 LOCKED), §4.3 (admin nav entry), §5 principle 8, §7 cross-check admin-authority row | OR is forbidden. No new capability token. UI visibility does not grant the rule. |
| **Owner is a granted bundle, not a back-door** | §2.1 (clarified), §2.3 (rewritten), §5 principle 5 (rewritten)                                                              | The "owner recovers from a misconfigured grant" framing is removed. The runtime is fail-closed; recovery is the sanctioned first-owner bootstrap only. |

---

## What this task produced (recap)

A **single, signed-off-ready policy spec** that maps:

- 21 capabilities (the v2 / v1 set in
  `src/lib/auth/direct-entry-v2.ts::CAPABILITIES` and
  `src/lib/contracts/direct-entry-v1.ts::Capability`; both enumerate
  the same 21 tokens, including `entry_restore`) ×
- 5 role classes (`owner`, `hrp`, `vendor`, `reviewer`, `reader`) ×
- 3 scope flavours (`own`, `team`, `all`) ×
- ~30 routes, panels and nav entries.

The matrix does **not** add tokens, **does not** change SQL, **does not**
ship a migration, and **does not** ship UI. T1B (admin surface) and T1A
(authz UX / nav) consume it as data.

---

## The policy in 30 seconds (R1)

| Role       | Capability bundle (from artifact §2.2)                                                                  | Scope          |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| `owner`    | all 21 capabilities, **admin authority** is the AND of `entry_admin` ∧ `recruiter_master_manage` ∧ `team_master_manage` at `all` scope | `all`          |
| `hrp`      | `entry_create`, `entry_own/team`, `submission_create`, `change_request_create`, `employment_status.request`, `document_*` (own) | own OR team    |
| `vendor`   | same as `hrp (own)`, **no** `payment_view`, **no** `pii_*`                                             | own only       |
| `reviewer` | `change_review`, `employment_status.review`, `document_view (all)`; **no** `payment_view` (D-1 LOCKED) | all            |
| `reader`   | **no** capability from the v2 set; reaches reporting through RLS-scoped dashboard reads only (D-2 LOCKED) | own            |

D-3 LOCKED: the entire AI Settings / AI Report surface (settings,
enqueue, review, history) is `owner`-only. The "all authenticated users
read history" posture is withdrawn.

---

## Why this exists

P3-W01A inventory @ `1f76c1d` documented that the only thing missing
for P3 implementation is a **policy spec** to glue together:

1. The capability set (21 tokens, declared once in
   `direct-entry-v2.ts` and mirrored in `contracts/direct-entry-v1.ts`; both enumerate the same 21 tokens, including `entry_restore`).
2. The grants tables (`direct_entry_capability_grants` /
   `direct_entry_scope_grants` — exist, not yet seeded).
3. The page decisions (`decideSessionPageAccess`,
   `decideDirectEntryPageAccess`).
4. The AI settings / report panels (mounted today for every session — a
   post-H04 gap).

W01A's dependency map (§6) named this work **P3-C01**. C01 wrote the
first cut; **C01-R1 locks the policy** for T1B / T1A consumption.

---

## What T1A / T1B must read

**T1A** (navigation, panels, dashboard layout):

- Artifact §2.2 (capability × role).
- Artifact §2.1a (admin authority rule, T0 LOCKED).
- Artifact §4.3 (nav mapping — note: `admin` entry requires the AND,
  not OR).
- Artifact §4.4 (panel gates — D-3 LOCKED, `owner`-only).
- Artifact §6 (D-1 / D-2 / D-3 already locked; no T0 sign-off needed).

**T1B** (admin surface + grants migration):

- Artifact §2.2 (which `direct_entry_capability_grants` to seed).
- Artifact §2.1a (admin authority — implement as
  `direct_entry_assert_admin_authority(actor)` SECURITY DEFINER helper;
  every admin mutation RPC funnels through it).
- Artifact §3 (cross-surface matrix — which routes to mount for which
  role, including the new `—` for reviewer payment and reader document).
- Artifact §5 principle 8 (admin authority is AND, not OR; no new
  token).
- Artifact §6 (D-1 / D-2 / D-3 LOCKED — no amendment before grants
  implementation).

---

## What is **out of scope** for C01-R1 (re-routed)

| Concern                                       | Routed to                  | Why not C01-R1                                                                                  |
| --------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| AI actor attribution move off `PILOT_ACTOR_REF` | **P3-W02.A**               | C01 names `owner` as the role that takes the audit slot; the move is W02.A.                    |
| Settings rate limiter (atomic, per-actor)     | **P3-W02.B**               | C01 specifies the keying target (`actor.app_user_id`); storage is W02.B.                        |
| Capability-aware navigation filter            | **T1A**                    | T1A reads C01 §4.3; C01 is the policy, not the code.                                            |
| Admin surface (`/admin/**`)                   | **T1B / P3-W02.D**         | T1B owns the route group + seed migration; C01 is the seed data.                                |
| `AiSettingsPanel` visibility per actor        | **P3-W02.F**               | W02.F consumes C01 §4.4 row for `owner`-only.                                                   |
| `AiReportPanel` visibility per actor          | **P3-W02.G**               | W02.G consumes C01 §4.4 row for `owner`-only enqueue + history (D-3 LOCKED).                    |
| `POST /api/ai/settings` session guard        | **already done @ P3-W02E** (`d2b6c3b`); matrix records the posture | W02E is already landed on `45c99b9`.                              |
| Document JS capability check (`document-api.ts:87`) | **P3-W02.H**          | Defence-in-depth UX gate; C01 keeps it; W02.H may drop it.                                      |
| `entry_restore` granted RPC                   | **T1B or contract-bump**   | No granted RPC at this base; the matrix keeps the token in `owner` and flags the gap in §8.    |
| Relaxing D-1, D-2, or D-3                    | **contract-bump task**     | R1 explicitly forbids a UI toggle; reversal requires a new capability token and a matrix PR.    |

---

## Locked principles (artifact §5)

1. **Deny by default.**
2. **SQL is authority; JS is projection.**
3. **UI visibility never grants capability.**
4. **No Basic Auth resurrection.**
5. **`owner` is the audit-attribution baseline, not a recovery
   back-door.** Runtime is fail-closed; recovery is the sanctioned
   first-owner bootstrap only.
6. **Capability / scope drift → contract bump.**
7. **No per-action UI override.**
8. **Admin authority is AND of three capabilities** (T0 LOCKED, §2.1a).
   No OR. No new token. UI does not grant the rule.

---

## What R2 changed vs R1

R2 is **docs-only** and **does not** touch policy locks, the admin
authority rule, or the owner fail-closed posture. R2 supersedes two
factual claims in R1 and updates the count throughout.

| Claim in R1 (quoted, then withdrawn)                       | R2 correction                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Count was "twenty-two capabilities" (the v2 `CAPABILITIES` array) | Count is twenty-one capabilities (the v2 `CAPABILITIES` array).                                                                      |
| v1 `Capability` was a "twenty-one-token subset" with `entry_restore` "missing from v1" | v1 `Capability` is the same twenty-one-token set, in the same order, including `entry_restore`. There is no v1-vs-v2 drift. |
| "v1-vs-v2 contract drift" was listed in §5 principle 6 of the security doc, in §8 gap #7, and in this handoff's out-of-scope table | Withdrawn. R2 §1, §5 principle 6, and §8 gap #7 all record the corrected fact. The handoff's out-of-scope table no longer lists the drift row. |
| `owner` was described as carrying "twenty-two capabilities" (twice in this handoff) | `owner` carries twenty-one capabilities (twice).                                                                                  |

R2 is **additive on retention, subtractive on the count / drift**:

- **Retained from R1 (unchanged):** D-1, D-2, D-3 LOCKED; admin
  authority AND of `entry_admin` ∧ `recruiter_master_manage` ∧
  `team_master_manage`; `owner` is a granted bundle, not a recovery
  back-door; runtime is fail-closed; no new capability tokens; no
  per-action UI override; SQL is authority, JS is projection; no
  Basic Auth resurrection; UI visibility never grants capability;
  contract bump owns any future drift.
- **Corrected in R2:** the count is 21, the v1 union mirrors the v2
  array, and there is no `entry_restore` drift to fix.

The §1 inventory table, §2.2 capability × role matrix, §3 cross-surface
matrix, §4 page / route / nav visibility, §4.4 panel gates, §7
cross-check, and the matrix verdict are **unchanged in shape** —
only the count language and the drift claim were edited.

---

## Gates passed (R2)

- `pnpm docs:check` — **PASS** (6/6).
- `pnpm secrets:check` — **PASS** (815 files scanned, no secret).
- `git diff --check` — **PASS**.
- `rg`-verified: no remaining count-of-twenty-two claim, no remaining
  "v1 missing `entry_restore`" claim, no remaining "v1-vs-v2 drift"
  claim against the v1 contract (the only remaining textual
  occurrences of the phrase are historical / superseded references
  inside R2's revision record, not forward-facing policy claims).
- File budget: 2 files (this handoff + the matrix doc). ≤ 2 as
  required. No new files.

---

## Verdict

**Status:** `P3-C01-R2_POLICY_CONTRACT_COUNT_CORRECTED_READY_FOR_IMPLEMENTATION`.

The matrix is the single artifact T1A / T1B need. No code changes. No
migrations. No UI. **D-1, D-2, D-3 are T0 LOCKED**; no Owner blocker
remains. The admin authority rule (AND of `entry_admin` ∧
`recruiter_master_manage` ∧ `team_master_manage`) is the only path
into the admin surface and uses zero new capability tokens. The
runtime is fail-closed. The capability set is **21 tokens**, mirrored
across `direct-entry-v2.ts` and `contracts/direct-entry-v1.ts`, with
no drift. P3 PASS is **not** claimed by this handoff.
