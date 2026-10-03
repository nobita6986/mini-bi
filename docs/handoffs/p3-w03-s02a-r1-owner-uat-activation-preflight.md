# P3-W03-S02A-R1 — Owner UAT and activation preflight

## Status and scope

`P3-W03-S02A_OWNER_UAT_PASS_READY_FOR_S02B_INTEGRATION`

This is a docs-only, read-only checkpoint on
`feature/p3-first-owner-bootstrap-s02a`, based on
`d582bff8afa4ffa7f97382235285beb69b091cb6`. It does not activate Direct Entry,
change Production configuration, deploy, or alter `main`. Activation is deferred
to a separately authorized task after T1A's S02B runtime integration.

## Owner-attested Production login UAT

Owner attested that the following flow passed on Production on **2026-10-04**
(date only; no exact timestamp was supplied):

1. Opened `/login` after passing Pilot Basic Auth.
2. Signed in with Supabase Auth and was redirected to `/dashboard`.
3. AppShell displayed Logout.
4. Refresh preserved the session.
5. Opening `/login` again redirected to Dashboard.
6. Logout returned to Login.
7. Refresh after logout did not silently sign in.
8. Signing in again succeeded.

This section records Owner attestation, not an agent-operated credential test.
No account identifier, password, cookie, Auth UUID, app-user ID, authorization
header, or raw capability payload is recorded.

## Read-only activation preflight

### Source and deployment

- Git source: `origin/main` at
  `1577c035758306c54a4cd6be4808bea8452fc7c3`.
- Production alias: `https://bi.hrpartner.vn`.
- Vercel inspection: target Production, state Ready, alias attached.
- Vercel Git deployment metadata matched branch `main` and the exact source SHA
  above.
- Current observed deployment reference: `dpl_6gsyNtcr3SYoMJVuRVYQxuTCEaz3`.

These are point-in-time read-only observations. Re-verify source, target, state,
and alias immediately before any future activation/redeploy.

### HTTP outer gate

Unauthenticated requests were made without credentials or bodies. The root route
is public; protected paths returned the expected Basic Auth `401`. A representative
Direct Entry API response included the Basic challenge and `private, no-store`.

| Request | Observed status | Interpretation |
|---|---:|---|
| `GET /` | 200 | Public route responds |
| `GET /login` | 401 | Basic Auth outer gate |
| `GET /api/auth/session` | 401 | Basic Auth outer gate |
| `GET /api/auth/login` | 401 | Basic Auth outer gate before method handling |
| `GET /api/auth/logout` | 401 | Basic Auth outer gate before method handling |
| `GET /dashboard` | 401 | Basic Auth outer gate |
| `GET /direct-entry` | 401 | Basic Auth outer gate |
| `GET /api/direct-entry/session` | 401 | Basic Auth outer gate |
| `GET /api/direct-entry/batches` | 401 | Basic Auth outer gate before method handling |

No Basic Auth or Supabase credential was used in these probes.

### Production environment presence

Vercel Production metadata was inspected for key presence and the two flag values
were compared only in-process. No environment value was copied to output, file,
source, or this handoff.

| Environment | Result |
|---|---|
| Pilot Basic Auth username and password keys | Present |
| Supabase public URL and publishable key | Present |
| Supabase server key | Present |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | All present |
| `DIRECT_ENTRY_API_ENABLED` | Absent or not exactly `true` |
| `DIRECT_ENTRY_UI_ENABLED` | Absent or not exactly `true` |

Presence is not proof that an external service operation succeeds. No R2 object
or CORS operation was made; R2 operational health remains unverified in this
checkpoint.

### Database

Using the configured official Session Pooler with process-local inputs only:

- Migration dry-run: **34 applied / 0 pending / 0 checksum mismatch**.
- Bootstrap operator check mode: `ALREADY_BOOTSTRAPPED`.
- Exactly one Auth user matched; email confirmed; operator's eligibility checks
  found no banned/deleted state.
- One enabled app-user mapping; 21 effective canonical capabilities.
- Effective scopes: one `own`, one `all`, zero team scopes.
- Actor projection: enabled, 21 capabilities, `own` and `all`.
- Reporting baseline and security boundary unchanged.

No apply, Auth mutation, R2 operation, or deployment occurred during R1.

## Activation runbook — prepared, not executed

### Preconditions and stop conditions

Execute only in a separately authorized activation task after T1A S02B is
integrated and reviewed. The source for that task must be the exact T0-approved
`origin/main` commit verified at execution time; do not deploy this feature branch
or assume the SHA above remains current.

Stop before changing anything if:

- `origin/main`, branch, or commit source is unexpected or has not been approved.
- The Production alias does not resolve to the expected project/deployment.
- Deployment is not Ready or Vercel Git metadata does not match approved `main`.
- Either Direct Entry flag is already exactly `true` before the approved change.
- Required Pilot, Supabase, or R2 variables are missing.
- Migration dry-run is not 34/0/0, or the bootstrap check is not
  `ALREADY_BOOTSTRAPPED`.
- Basic Auth, Auth session, capability/scope, API, or R2 behavior deviates from
  the expected matrix below.
- A request unexpectedly creates non-fixture data, returns a 5xx, exposes
  sensitive data, or generates an unmanifested object.

### Phase A — enable API only

1. Capture a presence-only env/deployment baseline. Set
   `DIRECT_ENTRY_API_ENABLED=true` for Production and keep
   `DIRECT_ENTRY_UI_ENABLED` absent or not `true`.
2. Redeploy through the Production Git integration from the exact approved
   `main` SHA. Do not deploy a Preview, feature, or local build.
3. Verify deployment Ready, target Production, alias `bi.hrpartner.vn`, source
   branch `main`, and exact approved SHA.
4. Run the following smoke matrix. “Basic Auth + Owner session” means the Owner
   completes the existing Basic Auth challenge and Supabase login in their own
   browser; never store or send their credentials to the agent.

| Request | Identity | Expected |
|---|---|---|
| `GET /` | Anonymous | 200; public |
| `GET /login` | No Basic Auth | 401 with Basic challenge |
| `GET /api/auth/session` | No Basic Auth | 401 with Basic challenge |
| `GET /dashboard` | No Basic Auth | 401 with Basic challenge |
| `GET /direct-entry` | No Basic Auth | 401 with Basic challenge |
| `GET /api/direct-entry/session` | No Basic Auth | 401 with Basic challenge |
| `GET /api/direct-entry/session` | Basic Auth, no Supabase session | 401 `UNAUTHENTICATED` |
| `GET /api/direct-entry/session` | Basic Auth + Owner session | 200; enabled actor projection |
| `GET /api/direct-entry/catalog?effective_date=<valid-date>` | Basic Auth + Owner session | 200; bounded catalog projection |
| `GET /api/direct-entry/drafts` | Basic Auth + Owner session | 200; own-draft projection |
| `GET /api/direct-entry/submissions` | Basic Auth + Owner session | 200; own-submission page |
| `GET /api/direct-entry/session` | Basic Auth + session for an already-provisioned actor without an active mapping | 403 `ACTOR_NOT_AVAILABLE` |

The final denial case is conditional on an existing approved test actor. Do not
create an Auth user or change grants to manufacture it. If no such actor exists,
record it as not run; the unauthenticated 401 still verifies the API denial
boundary. For the positive business-authority smoke, use the Owner's existing
mapped identity and verify only the expected `entry_create` capability and `own`
scope as needed by the approved test; do not save the actor response or raw
capability list.

All reads of drafts/submissions must be summarized without row-level names,
documents, bank data, or other PII. Do not use a write endpoint in Phase A merely
to test that it responds.

5. Phase A passes only if the API is reachable behind both gates, Owner session
   and authority resolve correctly, denied cases remain denied, UI flag is still
   off, and no unexpected writes or R2 operations occurred.

### Phase B — enable UI after Phase A passes

1. Record Phase A evidence and obtain the required approval to continue.
2. Set `DIRECT_ENTRY_UI_ENABLED=true` for Production; leave the API flag enabled.
3. Redeploy the same approved `main` source (re-verify SHA and Git source).
4. Verify deployment Ready and repeat outer-gate checks. With Basic Auth and the
   Owner's session, expect `GET /direct-entry` to render successfully, the
   AppShell navigation item to be present, and live API reads to succeed.
5. Run the authorized Production Direct Entry/R2 acceptance using only synthetic
   fixtures. Relevant API routes and contract outcomes:

| Operation | Route | Expected |
|---|---|---|
| Read actor/catalog | `GET /api/direct-entry/session`, `GET /api/direct-entry/catalog?effective_date=<valid-date>` | 200 for the Owner session |
| Create one synthetic draft entry | `POST /api/direct-entry/batches` | 201 for a new idempotency key; replay with the same key and body must not create a second submission |
| Reserve synthetic document upload | `POST /api/direct-entry/entries/{entryId}/documents` | 201 for a new reservation; idempotent existing reservation may return 200 |
| Upload to the returned short-lived signed URL | `PUT <signed upload URL>` | 2xx from the object store |
| Finalize synthetic document | `POST /api/direct-entry/entries/{entryId}/documents/{documentId}/finalize` | 200 when validated |
| Download finalized permitted document | `GET /api/direct-entry/entries/{entryId}/documents/{documentId}/download` | 302 to a short-lived signed URL |
| Repeat finalize on already-ready document | Same finalize route | 200 idempotent replay; no second storage mutation |
| Read/download without `document_view` or matching scope | Corresponding read/download route | 403; no signed URL returned |
| Access pending/ineligible or out-of-scope document | Download route | 404; no signed URL returned |

Create the draft from one row returned by the live catalog, with a valid
first-work date, a unique synthetic employee code matching `hrp-YYYY-<digits>`,
synthetic display name, omitted optional personal fields, and the
catalog's project/recruiter stable IDs. Do not invent catalog IDs or include
personal information. The Owner actor must have effective `entry_create` and
matching scope for this action; `document_upload` and matching entry scope for
upload/finalize; and `document_view` plus matching scope for download. Use only
the existing Owner identity. A denied-capability test may use only an
already-provisioned, separately approved actor; never mutate grants or create
accounts for this test.

The signed URL, upload body, document names, response actor body, and cookies are
never saved in screenshots, logs, or handoff evidence. Record route, method,
status, bounded error code if applicable, and pass/fail only.

### Fixture manifest and cleanup

Before any write acceptance, create an out-of-repository, access-controlled
manifest with a unique run ID and only synthetic data. Record the exact synthetic
entry/document references and object key needed for cleanup; do not put this
manifest or production identifiers in Git.

- Use a dedicated synthetic entry/worker label and non-PII document fixture;
  never use a real employee, bank account, or uploaded business document.
- Do not create more than the minimum single entry and document required by the
  authorized scenario. Record the API request/response correlation IDs, expected
  status, and cleanup disposition in the restricted manifest, not raw response
  bodies.
- The batch API creates a draft submission and has no general-purpose delete
  route. Unless a separately approved, supported cleanup flow is available and
  has been verified, treat the single synthetic draft as a retained acceptance
  fixture; do not promise automatic row cleanup.
- Invalid staging follows the existing application rejection flow, which deletes
  the rejected staging object. Abandoned staging has a 24-hour contract; no
  cleanup cron is assumed.
- A successfully finalized document is retained and has no automatic deletion
  contract. Do not delete its final object or DB/audit rows as generic cleanup.
  If retaining a synthetic final fixture is not approved, do not run the
  successful-finalize scenario until an explicit supported cleanup procedure is
  approved.
- Never issue bucket-wide listing, delete, or lifecycle/CORS changes for this
  acceptance. Any cleanup must be scoped to exact manifest keys and an approved
  application flow; no manual SQL or unmanifested object deletion.

### Rollback

Rollback immediately if a stop condition occurs, a smoke result is wrong, a flag
is unexpectedly enabled, auth/capability/scope checks fail, a deployment is not
the approved Ready `main` build, or an unmanifested side effect occurs.

1. Set both Direct Entry flags false or remove them according to the existing
   Production env convention.
2. Redeploy the same approved `main` source through Git integration.
3. Verify the deployment is Ready on `bi.hrpartner.vn`; after Basic Auth,
   `/api/direct-entry/session` returns 404 `NOT_FOUND` and `/direct-entry` is
   not found. Unauthenticated requests remain 401 at the outer gate.
4. Verify both flags are absent/not true using presence/value comparison only.
5. Preserve DB rows, revisions, audit, and R2 objects. Do not delete anything
   outside exact approved fixture-manifest cleanup.
6. Record sanitized evidence: deployment ID/source SHA/state, env-presence
   booleans, route/method/status/error code, fixture manifest disposition, and
   rollback result. Do not record secrets, credentials, cookies, PII, UUIDs, or
   raw actor/capability payloads.

## R1 evidence and completion

- Source/deployment, HTTP, Production env-presence, migration, and bootstrap
  checks above were read-only.
- R2 environment-key presence was verified; no bucket/object/CORS operation was
  attempted, and operational R2 readiness is not claimed.
- No Production env change, Direct Entry activation, deployment, DB mutation, or
  `main` change occurred in R1.
- Next checkpoint: integrate/review T1A S02B, then wait for a separately
  authorized activation task. This handoff does not claim Direct Entry activated,
  Production ready, P3 PASS, or P1.6 PASS.
