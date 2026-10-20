# S0-B — separate default-privileges and RPC ACL plan

S0-B is a separate reviewable change. It is not included in the S0-A migration.

## Verified cause and limits

On the PO-authorized TEST ref, current/session role is `postgres`. Schema-specific `pg_default_acl` rows exist for both `postgres` and `supabase_admin`; they grant direct function EXECUTE, table DML, and sequence privileges to runtime roles. No database-wide `pg_default_acl` rows were observed. Existing Mini BI functions also have broad effective EXECUTE grants (counts in `S0-baseline-runtime-acl.md`).

This confirms broad defaults and live grants, but it does not prove which deployment path created every object or why the staging snapshot differed. Do not make a global change to `postgres` or `supabase_admin` based only on the current catalog.

PostgreSQL applies defaults for the role that actually creates each object; role membership does not substitute for that creator. Per-schema default privileges are additive to global defaults, so a schema-level REVOKE cannot remove a global grant. In particular, the built-in PUBLIC EXECUTE grant on new functions requires a global creator-default change to remove for future functions, or an explicit per-function REVOKE. See [PostgreSQL ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html).

## Minimal proposed sequence

1. **Inventory before DDL.** On the independently confirmed production and staging refs, compare read-only catalog metadata: migration session/current role, object owner, `pg_default_acl` by creator/schema/object type, per-object ACL, effective ACL, exposed PostgREST schemas, and migration ledger. Record each `SECURITY DEFINER` function's owner, pinned search path, callers, and actor checks. Do not read business rows or invoke RPCs.
2. **Narrow only the verified Mini BI RPCs.** Build a reviewed allowlist from server repositories and API routes. For internal RPCs, explicitly REVOKE EXECUTE from `PUBLIC`, `anon`, and `authenticated`; GRANT only the role used by the server API (currently `service_role`) when that caller is confirmed. Preserve explicitly enumerated browser/API RPCs after tracing their auth and data scopes. Avoid `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public`: that can break unrelated Supabase and application services.
3. **Preserve actor binding.** Server APIs must continue resolving `auth_subject` and `app_user_id` from the authenticated server session, then pass those values to RPCs. Never accept an actor UUID as authority from the request body. Existing examples include `src/lib/direct-entry/draft-api.ts` and `src/lib/direct-entry/submission-delete-api.ts`; their route/API tests should remain in the regression set.
4. **Handle future defaults only after creator attribution.** Prefer explicit per-object `REVOKE` and narrow `GRANT` statements in each new Mini BI migration, plus a CI check that rejects newly created internal RPCs lacking the explicit ACL contract. If a dedicated Mini BI creator role is already used, set defaults for that role only after verifying its scope. If production objects are created as shared `postgres` in the shared `public` schema, changing that role's global defaults is not low risk: it affects future functions across schemas, while schema-scoped defaults do not remove built-in PUBLIC EXECUTE. Make that a separately approved design decision instead of hiding it in S0-A.
5. **PostgREST exposure.** Verify exposed schemas and object privileges as metadata. An exposed schema makes an object addressable through the Data API, but PostgreSQL ACLs still decide whether a role can invoke it. Do not expose internal-only functions just to call them from an RLS policy; schema-qualified policy calls do not require the function to be exposed to PostgREST. The S0-T1-C test also replays later source migrations after the ACL migration and fails if a Mini BI routine becomes executable by `PUBLIC`, `anon`, or `authenticated`. This is a CI guard, not a database default change. See [Supabase database functions](https://supabase.com/docs/guides/database/functions) and [Supabase RLS guidance](https://supabase.com/docs/guides/database/row-level-security).

## Required tests before S0-B merge

- Table-driven EXECUTE allow/deny checks for each RPC and each of `PUBLIC`, `anon`, `authenticated`, `service_role`.
- Tests that internal RPCs are not in the permitted PostgREST/RPC allowlist and that approved client RPCs remain available.
- API tests proving actor identity comes from the server session even if request payload includes a forged actor field.
- Migration/default-ACL tests using the actual migration creator role on ephemeral PostgreSQL, followed by metadata-only staging verification.
- Re-run the full CI matrix and review any non-Mini-BI Supabase function or table affected before rollout.

## Decision needed before S0-B

Confirm the intended Mini BI migration creator role and whether it may safely receive global function-default changes. If not, keep the global defaults unchanged and enforce object-level ACLs in Mini BI migrations until an isolated creator role is justified.


## Server boundary evidence

The server-only service-role path is implemented in `src/lib/supabase/server.ts` (`createServiceSupabaseClient`) and guarded/documented by `src/lib/env.ts` (`SUPABASE_SECRET_KEY` is server-only). Representative Direct Entry repositories use their local `serviceRoleRpc()` factory, including `src/lib/direct-entry/submission-delete-repository.ts` and `src/lib/direct-entry/worker-directory-repository.ts`. The server APIs resolve actor identity from the authenticated session before calling those repositories; see `src/lib/direct-entry/submission-delete-api.ts` and its `submission-delete-api.test.mjs` test, which asserts the session actor is the only actor sent to the repository.

## S0 closeout observation

S0-T1-C was applied without changing any default privileges. A fresh TEST metadata check found no `pg_default_acl` row for `direct_entry_catalog_bootstrap_executor`; the three broad ACLs were per-object grants whose historical creation path remains unknown. The native PostgreSQL test and CI replay later migrations and fail if Mini BI routines receive PUBLIC/anon/authenticated EXECUTE or service-role access outside the explicit allowlist. This is a temporary object-level guard, not creator-default hardening. Production metadata was not queried in this TEST-only execution. Keep any creator-default change in a separately scoped PR after the actual object-creating role and cross-Supabase impact are reviewed.
