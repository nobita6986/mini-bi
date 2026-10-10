# P3.1 hotfix — recruiter alias backfill

- Base: `main@ce00a17a02056b9dc8e8010e1de354df93a98b1a`; append-only migration #73 is `20261009090000_p3_1_hf_recruiter_alias_backfill.sql`.
- Root cause: reporting resolves recruiter dimensions from effective `recruiter_aliases`; canonical recruiters created without an alias were projected as `__unknown__` and displayed as “Không xác định”.
- Repair: backfill missing aliases and rewind same-key late aliases to no later than the earliest stored work date; ambiguous or conflicting alias history fails the migration closed.
- Prevention: an internal trigger on canonical provider-membership creation derives and inserts the matching HRP/Vendor alias in the same transaction. It is revoked from every application role and reused by both Personnel Catalog and importer creation paths.
- Regression: `test:p3-1-hf-recruiter-alias` proves missing/late repair, atomic Personnel Catalog creation/rollback, and importer/raw canonical creation coverage. The pre-hotfix reporting repair lane remains scoped to migrations before #73 so it still reproduces the original defect.
- Scope: no UI/API/dependency change and no personal identifiers in migration diagnostics or test output.
- Gates: focused 3/3, canonical `pnpm test`, offline validation with 73 migrations, type/build/lint/docs/secrets and Production evidence are recorded by T0 before release.

Status: `P3_1_HF_RECRUITER_ALIAS_LOCAL_PASS_AWAITING_T0_RELEASE`
