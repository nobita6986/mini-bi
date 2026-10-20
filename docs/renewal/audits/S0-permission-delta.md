# S0 permission matrix before and after

All runtime observations are for the Product Owner-designated TEST ref `oyykqfxkyqhxgrfntokl`. Source replay and ephemeral tests are identified separately. No production permissions were changed.

## `public.schema_migrations` after S0-A

| Principal | Before S0-A | After S0-A / final S0 | Basis |
|---|---|---|---|
| Owner `postgres` | SELECT, INSERT, UPDATE, DELETE by ownership | Preserved; raw ACL `{postgres=arwdDxtm/postgres}` | Owner unchanged; verified metadata and migration-runner regression. |
| `PUBLIC` | No direct table ACL entry | No ledger privilege | Explicit REVOKE; verified effective permissions. |
| `anon` | SELECT, INSERT, UPDATE, DELETE | None | All four effective table privileges false after S0-A. |
| `authenticated` | SELECT, INSERT, UPDATE, DELETE | None | All four effective table privileges false after S0-A. |
| `service_role` | SELECT, INSERT, UPDATE, DELETE | None | Runtime table rights false; function EXECUTE is independent. |
| Separate operator role | Not observed/configured | No grant added | The verified migration session and owner are `postgres`; no separate operator was identified. |

S0-A does not transfer ownership, change RLS, or alter ledger rows other than inserting its own migration version/checksum. Runner and ledger checks passed after the ACL change.

## Mini BI RPC EXECUTE ACL after S0-T1-C

| Principal | Before T1-C on TEST | After T1-C on TEST | Source/CI replay after T1-C |
|---|---:|---:|---:|
| Matching routines | 302 (256 SECURITY DEFINER) | 302 | 302 |
| `anon` effective EXECUTE | 273 | 0 | 0 |
| `authenticated` effective EXECUTE | 273 | 0 | 0 |
| `PUBLIC` explicit EXECUTE | 273 | 0 | 0 |
| `service_role` effective EXECUTE | 294 | 140 | 140 |

`service_role` retains the exact reviewed 140-signature allowlist. This removes 154 effective grants on TEST and adds none. Source replay differs in its pre-state because three executor-owned per-object grants existed only on the TEST project. The final migration removes those owner-granted entries through a temporary, non-inheriting SET membership within its transaction; that membership is removed before commit. Function ownership and the pre-existing postgres-to-executor membership are unchanged.

## Other principals and boundaries

- `direct_entry_catalog_bootstrap_executor` remains owner on its three routines. Its projection routine is owner-only; plan/apply are executable by the owner and `service_role` only.
- Function ACL changes do not change trigger or policy behavior. The T1-C regression and guarded apply compare RLS policies, triggers, and default-ACL metadata before and after.
- No default privileges were changed. `postgres` and `supabase_admin` retain their existing schema-specific defaults; cause attribution and any future change remain separate S0-B work.
- The application continues to derive actor identity from the authenticated server session and uses a server-only service client. No client actor authority was added.
- PostgREST schema exposure was not confirmed, so zero database grants is not presented as an end-to-end HTTP reachability test.
