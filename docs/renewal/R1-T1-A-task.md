# T1-A — TypeScript Authorization Contract

**Status:** Ready for implementation under the locked contract. S0-C1 is a TEST cutover gate, not a coding gate.  
**Baseline to use:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af`.

## Prompt

You are T1-A for Mini BI R1. Implement only the TypeScript authorization-contract work described here and in `docs/renewal/R1-authorization-contract.md`. Start from the newly approved `main` baseline in a dedicated branch. Do not touch the user’s hotfix checkout, database migrations, or worker API/projection implementation.

### Own

- `src/lib/auth/direct-entry-v2.ts` and `src/lib/auth/direct-entry-v2.test.mjs`.
- `src/lib/contracts/direct-entry-v1.ts` only for the shared capability type union and its directly related tests.
- `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` if the central contract change affects its assertions. T1-B owns the shared SQL/TypeScript capability-parity script.
- `src/lib/auth/direct-entry-page-access.ts` and its tests.
- `src/lib/navigation/registry-capability.ts` and its tests, only where a central predicate must follow the new contract.
- Directly related actor/scope fixtures required by those tests.

### Change

1. Remove active authorization references to `pii_view`, `pii_export`, `payment_view`, and `payment_edit` from evaluators and predicates. Existing database rows are retained; keep parser acceptance for these legacy strings if the actor repository still returns them, and prove such actors still resolve. Do not let them grant authority or appear as active UI actions.
2. Remove every authorization use of `valid_from`, `valid_to`, and resource `effective_date`. Scope matching uses only current scopes returned by the existing actor repository; historical resource dates never narrow them. Keep business-date validation where it is not an authorization predicate.
3. Keep Supabase session/actor resolution and the existing `auth_subject` mapping unchanged. Keep reason, version, workflow, and action-specific checks that still have business meaning. Read actor/capability/scope state fresh per request so revoke or disable takes effect on the next request.
4. Reuse the existing worker `view` action (`allowed_actions.view` plus the SQL row audience) and `worker_export` route/RPC/audit action. Do not add new `worker_view`/`worker_export` capabilities or repurpose `entry_*` actions.
5. Keep page/navigation logic as a presentation predicate that mirrors the shared action/scope model; never make it the authorization boundary.

### Do not change

- No SQL, migration, grant, RLS, `SECURITY DEFINER`, or RPC ACL.
- No API or worker projection implementation owned by T1-C.
- No role bundles, policy engine, per-screen capabilities, or broad rewrite of auth/session code.
- No production/staging DB access or deployment.

### Tests and handoff

Update only relevant unit tests. Cover: unauthenticated/missing/disabled/ambiguous actors; invalid client/trusted data; actors carrying retained legacy grant rows still resolve but gain no authority from them; generic action allow/deny; current assignment allows a historic resource regardless of its business date; current/non-current/revoked or wrong-scope grants deny; advancing a test clock does not promote a non-current future grant; page and nav predicates agree; no retired token remains in active TypeScript decisions. Do not add an authorization-date boundary test.

Before handing off, run the focused tests for changed modules (the PO’s implementation task authorizes verification), report exact commands/results, list removed checks and retained safeguards, and state the final token audit. Do not edit any non-owned module to resolve conflicts; report the exact interface needed from T1-B/T1-C.

