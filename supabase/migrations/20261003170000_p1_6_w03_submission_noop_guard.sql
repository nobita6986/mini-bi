create or replace function public.direct_entry_transition_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_target_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_prior_result jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;
  v_request_hash := encode(
    sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
    'hex'
  );
  v_prior_result := public.direct_entry_idempotency_begin(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
  );
  if v_prior_result is not null then return v_prior_result; end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  if p_target_state = v_submission.state then
    raise exception 'submission transition cannot be a no-op' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;
  v_before := jsonb_build_object(
    'state', v_submission.state, 'version', v_submission.version,
    'submitted_at', v_submission.submitted_at
  );
  update public.direct_entry_submissions
     set state = p_target_state,
         version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Submission state transition');
  insert into public.direct_entry_submission_revisions (
    submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', p_target_state, 'version', v_submission.version + 1,
      'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
    )
  ) returning revision_id into v_submission_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
    p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
    v_submission_revision_id,
    array['state', 'version']
  );
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'state', p_target_state,
    'version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
