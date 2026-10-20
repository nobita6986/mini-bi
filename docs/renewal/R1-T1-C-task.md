# T1-C — Worker API, Projections, and Export

**Status:** Ready for implementation under the locked shared contract and file ownership. S0-C1 is a TEST cutover gate, not a coding gate.  
**Baseline to use:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af`.

## Prompt

You are T1-C for Mini BI R1. Implement only the worker API, detail/list projections, worker UI, and export surfaces described by `docs/renewal/R1-authorization-contract.md`. Start from the newly approved `main` commit in a dedicated branch. Coordinate RPC signatures with T1-B; do not edit SQL migrations or central auth contract files owned by T1-A.

### Own

- Worker directory/detail/export API, contracts, repositories, projections, UI models/components, and their tests.
- Payment/full-profile API/UI paths only where they enforce the retired `payment_view`, `payment_edit`, or `pii_view` authorization tokens.
- `direct-entry-live.tsx` and change-request reviewer projections/components only for these field gates/redaction branches.

### Change

1. Remove field-specific PII/payment gating and redaction based on the four retired tokens. After the existing worker `view` action + current row scope succeeds, project the authorized profile’s fields consistently, including identity and payment details.
2. Keep worker detail, list, and export tied to server-resolved actor/current row audience. Do not trust client actor IDs, role/capability claims, or trusted scope.
3. Reuse existing `direct_entry_list_workers` and `direct_entry_export_workers` repositories/RPCs and their `view` / `worker_export` actions. Do not add `worker_view`/`worker_export` capability tokens. The existing all-scope export still requires current all scope plus `entry_admin` or `change_review`; no company-wide export is granted by default.
4. Keep payment writes inside the existing enclosing action, scope, workflow/status, validation, revision/OCC and audit checks. Removing `payment_edit` must not create a new write path.
5. Keep document/object-context and storage checks independent of profile-field visibility.
6. Preserve export reason, immutable audit, 10,000-row limit, strict envelope, safe/no-store response headers, output validation and formula-injection protection. Filters never widen the row set. Updated clients must ignore legacy `view_pii`/`view_payment` output keys; if retained for compatibility, those keys are inert echoes of `view`.
7. Remove every authorization-time use of grant/assignment `valid_from`/`valid_to` and record effective dates. Preserve business effective dates in worker profiles, status, reports, and audit where they are domain data.

### Do not change

- No central actor resolver/capability contract, SQL migration, table grant, RLS, `SECURITY DEFINER`, RPC ACL, or production DB access.
- No fallback from a denied API to client-side filtering or direct table reads.
- No document permission removal, workflow relaxation, role bundles, policy engine, or extra abstractions.

### Regression and handoff

Cover directory/detail/export consistency for own/team/project/all and recruited/managed/all audiences; historic rows with current scope regardless of date; non-current/future/revoked scope; a non-current row stays non-current after the test clock advances; cross-resource documents still denied; payment edit still needs the enclosing action/workflow; strict request allowlist rejects actor/scope fields; export audit/reason, row limit, safe XLSX and formula injection; malformed/error RPC response fails closed and leaks no PII in error/logs. Run focused tests, record exact commands/results, summarize every retired gate and retained guard, and list any T1-B signature dependency. Do not modify out-of-scope files to resolve integration issues.

