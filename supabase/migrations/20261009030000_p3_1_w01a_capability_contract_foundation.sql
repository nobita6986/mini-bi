-- P3.1-W01A - capability contract foundation (append-only migration #67).
--
-- Extends the canonical capability vocabulary of public.direct_entry_capability_grants from 21 to
-- 23 tokens with exactly the two narrow tokens locked by T0 in docs/P3.1.md and the C01 catalog
-- policy survey:
--   * catalog_master_manage - business-catalog operator authority for Admin and Accounting, valid
--     only at effective 'all' scope. It never implies entry_admin, recruiter_master_manage,
--     team_master_manage, account enable/disable, capability/scope grant management or
--     app-user <-> recruiter link management.
--   * team_manager_assign   - team-leader authority for project-manager assign/unassign, valid
--     only at effective 'team' scope for the leader's own team. It never implies project master
--     data administration and is never derived from a role name or personnel_position.
--
-- The CHECK is replaced explicitly: the 21 existing tokens are preserved verbatim, so every
-- existing grant row stays valid and no data is rewritten. Unknown tokens are still rejected with
-- SQLSTATE 23514. This migration grants NO capability to any account, seeds nothing, creates no
-- helper and no guard, and registers no runtime predicate: P3.1-W01B/W01C/W02 own the RPCs, API
-- and UI that will consume these tokens.

begin;

alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_capability_check;

alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (capability in (
    'entry_create',
    'entry_own',
    'entry_team',
    'entry_admin',
    'entry_restore',
    'submission_create',
    'change_request_create',
    'change_review',
    'entry_privileged_edit',
    'employment_status.request',
    'employment_status.review',
    'employment_status.apply',
    'document_upload',
    'document_view',
    'payment_view',
    'payment_edit',
    'recruiter_master_manage',
    'team_master_manage',
    'pii_view',
    'pii_export',
    'audit_view',
    'catalog_master_manage',
    'team_manager_assign'
  ));

comment on constraint direct_entry_capability_grants_capability_check
  on public.direct_entry_capability_grants is
  'P3.1-W01A: the single canonical capability vocabulary (23 tokens). catalog_master_manage is '
  'valid only at effective all scope and team_manager_assign only at effective team scope; both '
  'are declared by the direct-entry-auth/1.3 contract.';

commit;
