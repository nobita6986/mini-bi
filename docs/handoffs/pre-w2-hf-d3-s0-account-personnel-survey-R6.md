# Pre-W2-HF-D3-S0-R6 — retention consistency fixes for R5 (purge scope, block mechanism, deadline behaviour, field classification)

> Status: `PRE_W2_HF_D3_S0_R6_AWAITING_T0_REVIEW`
> Base: `origin/main@0e5e27d` (unchanged). Appended on the existing survey branch (no amend/rebase/force-push).
> Kind: docs-only. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no UAT, no Vercel/VPS deploy.
> Supersedes: R5 §2 (Option A/B deadline behaviour), R5 §4 (purge/retention table), R5 §5 (acceptance rows A13a–A13d). R5 §1 and R5 §3 remain in force. R5's body is **not** edited; only an explicit `Superseded-by` pointer was added to its header.

## 0. Revision log / cross-reference (no history rewrite)

- Chain: `S0 → R1 → R2 → R3 → R4 → R5 → R6`.
- R6 supersedes exactly: **R5 §2** (deadline/bound behaviour), **R5 §4** (purge-scope ambiguity and the block mechanism after `login_id` purge), **R5 §5** rows A13a–A13d (now corrected in §7 below).
- R6 does **not** touch R5 §1 (per-intent footprint) or R5 §3 (`auth_subject` classification / drop-from-tombstone), which stay in force. No prior revision body was silently changed or deleted.

## 1. What "purge" means: whole-intent vs PII-field purge (fixes Must-fix 1)

R5 used "purge" ambiguously. R6 defines two distinct operations and never uses "purge" without naming which one:

- **PII-field purge** — null the PII-bearing columns (`login_id`, `display_name`) on the intent row, in place. The intent row and its tombstone fields remain.
- **Row purge** — `DELETE` the intent row entirely. Allowed **only** when no reconciliation handle is needed for that state.

Intent row fields and classification:

| Field | Class | Notes |
|---|---|---|
| `idempotency_key` | opaque request token | non-personal on its own; becomes personal if co-stored with identifiers |
| `intent_kind` (`create`/`reset`) | operational | non-personal |
| `state` / `outcome` | operational | non-personal |
| `created_at` / `auth_call_started_at` / `decided_at` | operational | non-personal |
| `login_id` | **identifier (personal data)** | search key; PII-field purge target |
| `display_name` | **PII (personal data)** | purge target |
| `intent_token` | provenance token (not secret) | non-personal on its own |
| `auth_subject` | **pseudonymous identifier (personal data)** | never "non-PII" |
| `app_user_id` | **pseudonymous identifier (personal data)** | never "non-PII" |

## 2. Block mechanism after `login_id` is purged (fixes Must-fix 2)

R5 was self-contradictory: it purged `login_id` (Option B) yet claimed "the login stays blocked by the unique `login_id` guard" — but that guard lives on the intent row and no longer holds `login_id` after purge.

Corrected:

- The intent-table **unique `login_id` guard** only serializes concurrent intents **while the row still holds `login_id`**. After a PII-field purge it can block nothing.
- The **only** remaining block is **Supabase Auth's own uniqueness on the orphan user's email/login**: a new `admin.createUser` with the same login fails because that Auth user still exists. This is an existing Auth behaviour, not the intent guard.
- Consequence of Option B: after purge, re-creation is blocked **by Auth (if email uniqueness holds)**, and the operator can no longer locate the orphan from the application (the search handle is gone) → manual/out-of-band only.
- **BLOCKED — not assumed:** whether Auth email uniqueness is guaranteed for this project (email-uniqueness setting / identity linking) is **not established here**. R6 does **not** invent a block mechanism. This is **D-BLOCK**, an Owner + design decision that must be locked before implementation. Until then, the Option-B block guarantee is unproven.

## 3. Deadline behaviour at `T_decide` / `T_handle_max` (fixes Must-fix 3)

R5's Option A claimed "`T_decide` is the bound", but `T_decide` only *escalates*; if no one decides, the PII is retained forever — which contradicts bounded retention. **That claim is withdrawn.** To restore boundedness, Owner must choose one (not chosen here):

- **A1 — auto-fallback to Option B.** At `T_decide` with no decision, automatically PII-field-purge `login_id` (and row-purge if allowed). Bounded; the orphan becomes non-reconcilable, and the block depends on D-BLOCK.
- **A2 — explicit standing exception.** At `T_decide` with no decision, retain under a **standing, explicitly Owner-approved retention exception**: the approval itself is the bound, and it must be periodically re-approved and audited (otherwise it decays into indefinite retention). PII is retained only because Owner approved the exception.
- **A3 — hybrid hard ceiling.** A hard `T_handle_max` applies regardless of decisions; at it, A1's fallback runs. Bounded and decision-independent.

R6 states plainly: **without A1/A2/A3 decided, "bounded retention" for unresolved create intents is NOT met.** §2's unproven block guarantee and §3's undecided fallback are the reason the "no indefinite PII" promise cannot yet be asserted.

## 4. Reset `INDETERMINATE`: what is purged vs which identifiers remain (fixes Must-fix 4)

Reset targets an already-identified account (`account_ref → auth_subject` resolved before the Auth call), so there is no orphan-search and rows are bounded. Field-level detail:

| Field | Class | In tombstone? | In audit? | Retention | Access |
|---|---|---|---|---|---|
| `idempotency_key` | opaque request token | yes | no | replay window | service-role only |
| `app_user_id` | pseudonymous identifier (personal) | only if needed to answer replay deterministically | yes (target ref) | bounded per state | service-role only |
| `auth_subject` | pseudonymous identifier (personal) | **no** (dropped per R5 §3) | no | — | — |
| `login_id` | identifier (personal) | no | no | not needed for reset | service-role only |
| `display_name` | PII | no | no | PII-field purge at `INDETERMINATE` | service-role only |

- On reset `INDETERMINATE`: no special handle is required; the row is **row-purgeable** at `T_maxresolve` (or PII-field-purged earlier), leaving only `{idempotency_key, outcome}` if a replay window is retained.
- No UUID (`app_user_id`, `auth_subject`) is called non-PII merely because it is opaque; both are classified as personal identifiers with explicit access + retention.

## 5. Corrected purge / retention table (replaces R5 §4)

| Kind | State | Operation at deadline | PII-field purge | Row purge | Retained handle |
|---|---|---|---|---|---|
| create | `EXPIRED` (Auth never called) | at `T_retain` | `login_id`, `display_name` | allowed | tombstone `{idempotency_key, outcome}` |
| create | `APPLIED` | at `T_retain` | `login_id`, `display_name` | allowed | tombstone (+ classified `app_user_id` only if replay requires) |
| create | `FAILED` | at `T_retain` | `login_id`, `display_name` | allowed | tombstone |
| create | `INDETERMINATE`/`BLOCKED`/`CONFLICT` | per §3 (A1/A2/A3) | not before the §3 decision | not before §3 decision | `login_id` + `intent_token` (Option A2 only under approved exception) |
| reset | `APPLIED`/`FAILED`/`EXPIRED` | at `T_retain` | `login_id`(n/a), `display_name` | allowed | tombstone |
| reset | `INDETERMINATE` | at `T_maxresolve` | `display_name` | allowed | tombstone (`{idempotency_key, outcome}`); no `login_id`/provenance |

## 6. Open Owner decisions to lock before implementation (fixes Must-fix 5/6)

R6 chooses none of these:

| ID | Decision | Options / consequence |
|---|---|---|
| **D-TTL** | Lock `T_pending`, `T_inflight`, `T_retain`, `T_maxresolve`, `T_decide`, `T_handle_max`, sweeper cadence | required before any time-based acceptance test |
| **D-OPT** | Deadline behaviour for unresolved create intents | A1 (auto-fallback, bounded, orphan non-reconcilable) / A2 (standing approved exception) / A3 (hard ceiling) |
| **D-BLOCK** | Confirm the re-creation block guarantee | is Auth email uniqueness guaranteed here (email-uniqueness / identity linking)? **Currently BLOCKED / unproven** |
| **D-INTPII** | Approve the field classification (§1/§4) | which fields are PII vs pseudonymous vs allowed in tombstone/audit |
| **D5** | recruiter↔account cardinality (carried from R1/R2) | blocks **only** the personnel-link RPC, not create/edit/reset |

## 7. Acceptance corrections (replaces R5 §5 A13a–A13d)

| # | Case | Expected |
|---|---|---|
| A13a | Unresolved create intent at `T_decide`, no decision, **D-OPT undecided** | cannot be tested; flagged as blocked on D-OPT; **no** "bounded" claim asserted |
| A13b | **D-OPT=A1**, create intent at `T_decide` | PII-field purge of `login_id`; orphan becomes non-reconcilable; block depends on D-BLOCK |
| A13c | **D-OPT=A2**, create intent at `T_decide` | retains under explicitly approved, re-approvable exception; audited; not indefinite-by-default |
| A13d | Reset `INDETERMINATE` at `T_maxresolve` | row-purgeable; only `{idempotency_key, outcome}` if a replay window is kept; no `login_id`/`auth_subject` |
| A13e | Any tombstone | contains no `auth_subject`; no UUID labelled non-PII |

## 8. Boundary

Read-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no Vercel/VPS deploy, no UAT, no account creation/modification. No PII, credential, password, or raw database error was read or printed. Only the R5 pointer edit and this R6 file are written.
