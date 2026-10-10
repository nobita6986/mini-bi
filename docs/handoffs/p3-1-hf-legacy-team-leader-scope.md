# P3.1-HF — Legacy Team Leader scope compatibility

## Status

`P3_1_HF_LEGACY_TEAM_LEADER_SCOPE_LOCAL_PASS_AWAITING_T0_PRODUCTION_APPLY`

## Incident

A catalog operator with the Full Admin capability triple could list candidates
but received a sanitized 403 when replacing a transitioned Team Leader. The
account and candidate were valid; the denial was emitted after authorization.

Migration #71 deliberately preserved each legacy `team` scope row unchanged
while creating the canonical assignment and `team_manager_assign` capability at
the transition date. Its later mutation path nevertheless required the scope,
assignment, and capability to have identical `valid_from` values. Consequently,
every transitioned bundle had an earlier scope prefix and could not be replaced
or revoked.

Production read-only evidence found seven current transitioned bundles and all
seven had this same documented transition shape. No identities or raw database
errors are recorded in this handoff.

## Fix

Migration #76 updates only
`public.direct_entry_apply_team_leader_mutation(...)`:

- the outgoing assignment and exact capability must still share both interval
  boundaries;
- exactly one matching `team` scope must still exist and share the assignment's
  end boundary;
- that scope may start on or before the assignment, so its preserved legacy
  prefix remains valid history;
- an absent, duplicate, expired, or otherwise malformed bundle is a `23514`
  state conflict, not a `42501` authorization denial.

The migration obtains the existing function definition and replaces two exact,
single-occurrence source anchors. Source drift aborts with `55000`. The helper
remains `SECURITY DEFINER`, keeps its pinned `search_path`, and remains
non-executable by `public`, `anon`, `authenticated`, and `service_role`.

No API, UI, authority predicate, grant creation rule, dependency, or earlier
migration changes.

## Regression and mutation evidence

The W01D A1b2 PGlite lane now applies #76 and proves:

1. a transitioned leader whose scope starts earlier can be replaced;
2. a second transitioned leader can be revoked;
3. each operation closes the original covering scope at the requested date;
4. a genuinely malformed bundle still leaves zero residue and returns `23514`.

Two in-memory mutation probes are pinned by
`LEGACY_SCOPE_HOTFIX_MUTATION`:

- `restore-exact-scope-start` restores the faulty equality and must make the
  transition replace/revoke regression fail;
- `misclassify-state-as-denied` restores SQLSTATE `42501` and must make the
  malformed-state taxonomy regression fail.

## Production sequence

After T0 merges and locks the new `main` SHA: apply pending append-only
migrations in ledger order, verify #75 and #76 are recorded, verify the helper
contains the covering-scope predicate and `23514` taxonomy, then perform Owner
UAT through the existing Team Catalog UI. No automated Production mutation is
part of this hotfix.
