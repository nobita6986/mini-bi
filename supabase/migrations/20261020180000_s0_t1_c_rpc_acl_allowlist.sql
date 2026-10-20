-- S0-T1-C: close Mini BI function EXECUTE grants to an explicit server allowlist.
--
-- The target name families are Mini BI-owned functions in public. This leaves
-- unrelated Supabase/public-schema functions untouched. Function owners and the
-- catalog-bootstrap executor's owner grants are not changed. Trigger and RLS
-- policy definitions are also left intact; trigger execution does not require
-- callers to hold EXECUTE on the trigger function after CREATE TRIGGER.
--
-- Calls from the app use the server-only service client. Actor parameters remain
-- derived from the authenticated server session and are still checked inside
-- each RPC; service_role itself bypasses RLS, so no direct client grant is added.
-- New functions need the separate, creator-scoped default-privilege review.

do $$
declare
  v_proc record;
  v_object_kind text;
begin
  for v_proc in
    select p.oid, p.prokind
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and p.proname ~ '^(direct_entry_|ai_report_|ai_provider_config_|recruitment_|(expand|replace|reject|upsert)_daily_recruitment|record_recruitment_source_failure_|set_updated_at$)'
  loop
    v_object_kind := case when v_proc.prokind = 'p' then 'PROCEDURE' else 'FUNCTION' end;
    execute pg_catalog.format(
      'REVOKE EXECUTE ON %s %s FROM PUBLIC, anon, authenticated, service_role',
      v_object_kind,
      v_proc.oid::pg_catalog.regprocedure
    );
  end loop;
end;
$$;
do $$
declare
  v_signature text;
  v_proc pg_catalog.regprocedure;
  v_allowlist constant text[] := array[
    'public.ai_provider_config_activate(text, integer, text)',
    'public.ai_provider_config_active()',
    'public.ai_provider_config_current(text)',
    'public.ai_provider_config_disable(text, integer, text)',
    'public.ai_provider_config_rejected(text, integer, text, text)',
    'public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text)',
    'public.ai_provider_config_test_result(text, integer, boolean, text, text)',
    'public.ai_provider_config_version(text, integer)',
    'public.ai_report_approve_revision(uuid, integer, text)',
    'public.ai_report_claim(text, integer, integer)',
    'public.ai_report_complete(uuid, uuid, jsonb, jsonb)',
    'public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer)',
    'public.ai_report_fail(uuid, uuid, text, text, timestamptz, text)',
    'public.ai_report_history(text, text, integer)',
    'public.ai_report_mark_stage(uuid, uuid, text)',
    'public.ai_report_policy_context(text, integer)',
    'public.ai_report_record_usage(jsonb)',
    'public.ai_report_recover_stale(integer)',
    'public.ai_report_regenerate(uuid, text, text)',
    'public.ai_report_reject_revision(uuid, integer, text, text)',
    'public.ai_report_review_capability()',
    'public.ai_report_status(uuid)',
    'public.direct_entry_account_operation_begin(uuid, uuid, text, text, text, uuid, text, text)',
    'public.direct_entry_account_operation_claim(uuid, uuid, uuid, uuid)',
    'public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)',
    'public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)',
    'public.direct_entry_account_operation_finish(uuid, uuid, uuid, text, text)',
    'public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer)',
    'public.direct_entry_account_operation_read(uuid, uuid, uuid)',
    'public.direct_entry_account_operation_reclassify(uuid, uuid)',
    'public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)',
    'public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)',
    'public.direct_entry_apply_draft_employment_status(uuid, uuid, uuid, integer, text, date, text, text, text)',
    'public.direct_entry_approve_change_request(uuid, uuid, uuid, integer, text, text)',
    'public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)',
    'public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_cancel_worker_portrait_stage(uuid, uuid, uuid)',
    'public.direct_entry_catalog_bootstrap_plan(uuid, uuid)',
    'public.direct_entry_claim_expired_worker_portrait_stage_cleanup(uuid, integer)',
    'public.direct_entry_claim_submission_object_cleanup(uuid, integer)',
    'public.direct_entry_claim_worker_portrait_stage(uuid, uuid, uuid, text)',
    'public.direct_entry_complete_submission_object_cleanup(uuid, uuid)',
    'public.direct_entry_complete_worker_document_stage(uuid, uuid, uuid, text, uuid, uuid)',
    'public.direct_entry_complete_worker_portrait_stage_cleanup(uuid, uuid)',
    'public.direct_entry_create_batch(uuid, uuid, jsonb, text)',
    'public.direct_entry_create_change_request(uuid, uuid, jsonb, text, text)',
    'public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)',
    'public.direct_entry_create_full_profile_batch_v2(uuid, uuid, text, jsonb, text)',
    'public.direct_entry_create_full_profile_batch_with_portrait_stages(uuid, uuid, text, jsonb, text, uuid[])',
    'public.direct_entry_create_labor_type(uuid, uuid, integer, text, text, integer, text, text)',
    'public.direct_entry_create_personnel(uuid, uuid, integer, text, text, text, date, text, text)',
    'public.direct_entry_create_project(uuid, uuid, text, text, text, text)',
    'public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)',
    'public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text)',
    'public.direct_entry_create_worker_document_stage_idempotent(uuid, uuid, uuid, text, text, bigint, text, text)',
    'public.direct_entry_delete_draft_row(uuid, uuid, uuid, integer, text)',
    'public.direct_entry_delete_draft_submission(uuid, uuid, uuid, integer, text)',
    'public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_disable_app_user(uuid, uuid, uuid, integer, text, text)',
    'public.direct_entry_document_direct_context(uuid, uuid, uuid, uuid, text)',
    'public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer)',
    'public.direct_entry_enable_app_user(uuid, uuid, uuid, integer, text, text)',
    'public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text)',
    'public.direct_entry_finalize_document_direct_upload(uuid, uuid, uuid, uuid, integer, text, text, text, bigint, text)',
    'public.direct_entry_get_app_user_admin(uuid, uuid, uuid)',
    'public.direct_entry_get_labor_type_admin(uuid, uuid, text)',
    'public.direct_entry_get_personnel_admin(uuid, uuid, uuid)',
    'public.direct_entry_get_project_admin(uuid, uuid, text)',
    'public.direct_entry_get_team_admin(uuid, uuid, uuid)',
    'public.direct_entry_get_vendor_admin(uuid, uuid, text)',
    'public.direct_entry_get_worker_document_stage(uuid, uuid, uuid)',
    'public.direct_entry_grant_project_team_scopes_batch(uuid, uuid, uuid, text[], text, text)',
    'public.direct_entry_input_catalog(uuid, uuid, date)',
    'public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)',
    'public.direct_entry_list_change_requests(uuid, uuid, integer, text, text)',
    'public.direct_entry_list_global_change_request_history(uuid, uuid, integer, text, integer)',
    'public.direct_entry_list_labor_types_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_list_own_drafts(uuid, uuid)',
    'public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text)',
    'public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)',
    'public.direct_entry_list_project_manager_candidates(uuid, uuid, text)',
    'public.direct_entry_list_project_team_scopes_admin(uuid, uuid, text, uuid, boolean, integer, integer)',
    'public.direct_entry_list_projects_admin(uuid, uuid, boolean)',
    'public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_leader_history(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_leaders_current(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_leaders_scheduled(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_membership_current(uuid, uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_membership_history(uuid, uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_team_membership_scheduled(uuid, uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_list_teams_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_list_vendors_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)',
    'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)',
    'public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)',
    'public.direct_entry_read_change_request(uuid, uuid, uuid)',
    'public.direct_entry_read_own_submission(uuid, uuid, uuid)',
    'public.direct_entry_read_projection(uuid, uuid, uuid)',
    'public.direct_entry_recover_worker_portrait_stage(uuid, uuid, uuid)',
    'public.direct_entry_reject_change_request(uuid, uuid, uuid, integer, text, text)',
    'public.direct_entry_release_worker_portrait_stage(uuid, uuid, uuid, text)',
    'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)',
    'public.direct_entry_reporting_scoped_options(uuid, uuid)',
    'public.direct_entry_reporting_team_drill_down(uuid, uuid, text, jsonb, text, integer)',
    'public.direct_entry_reserve_document_direct_upload(uuid, uuid, uuid, integer, text, text, bigint, text, text)',
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text)',
    'public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_set_labor_type_active(uuid, uuid, text, boolean, integer, text, text)',
    'public.direct_entry_set_personnel_active(uuid, uuid, uuid, boolean, integer, text, text)',
    'public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)',
    'public.direct_entry_set_team_active(uuid, uuid, uuid, boolean, integer, text, text)',
    'public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)',
    'public.direct_entry_submission_duplicate_cccd_preflight(uuid, uuid, uuid)',
    'public.direct_entry_transition_submission(uuid, uuid, uuid, integer, text, text)',
    'public.direct_entry_transition_submission_duplicate_cccd_confirmed(uuid, uuid, uuid, integer, text, text, text, integer)',
    'public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)',
    'public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_update_labor_type(uuid, uuid, text, integer, text, integer, text, text)',
    'public.direct_entry_update_own_draft_row(uuid, uuid, uuid, integer, jsonb, text)',
    'public.direct_entry_update_payment(uuid, uuid, uuid, integer, integer, jsonb, text, text)',
    'public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)',
    'public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)',
    'public.direct_entry_update_team(uuid, uuid, uuid, integer, text, text, text)',
    'public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text)',
    'public.direct_entry_withdraw_change_request(uuid, uuid, uuid, integer, text)',
    'public.expand_daily_recruitment_breakdown_v02(jsonb)',
    'public.record_recruitment_source_failure_v01(jsonb)',
    'public.recruitment_dimension_display(text)',
    'public.recruitment_dimension_key(text)',
    'public.recruitment_employment_type_display(text)',
    'public.recruitment_employment_type_key(text)',
    'public.recruitment_provider_type_display(text)',
    'public.recruitment_provider_type_key(text)',
    'public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text)',
    'public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb)',
    'public.upsert_daily_recruitment_run_v01(uuid, uuid, text, timestamptz, text, integer, integer, integer, text, text)',
    'public.upsert_daily_recruitment_run_v02(uuid, uuid, text, timestamptz, text, integer, integer, integer, integer, integer, text, text)'
  ];
begin
  foreach v_signature in array v_allowlist loop
    v_proc := pg_catalog.to_regprocedure(v_signature);
    if v_proc is null then
      raise exception 'S0-T1-C allowlist function is missing: %', v_signature;
    end if;
    execute pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_proc);
  end loop;
end;
$$;
