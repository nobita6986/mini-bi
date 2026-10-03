-- R1: draft payment writes follow draft scope; submitted writes remain privileged.
create or replace function public.direct_entry_update_payment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_expected_payment_version integer,
  p_payment jsonb,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_payment public.direct_entry_payments%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_submission_state text;
  v_audit_capability text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
  v_payment_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_payment) <> 'object'
     or (p_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
    raise exception 'invalid payment input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'payment_edit'
  );
  v_audit_capability := case
    when v_submission_state = 'DRAFT' then case v_scope
      when 'own' then 'entry_own'
      when 'team' then 'entry_team'
      else 'entry_admin'
    end
    else 'payment_edit'
  end;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'payment_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'entry_version', p_expected_entry_version,
      'payment_version', p_expected_payment_version, 'payment', p_payment, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  select * into v_payment from public.direct_entry_payments where entry_id = p_entry_id for update;
  if found then
    if p_expected_payment_version is null or p_expected_payment_version <> v_payment.version then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := v_payment.version + 1;
  else
    if p_expected_payment_version is distinct from 0 then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := 1;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_payments (
    entry_id, state, account_number, bank_id, account_holder_name, version
  ) values (
    p_entry_id, p_payment->>'state', p_payment->>'account_number',
    p_payment->>'bank_id', p_payment->>'account_holder_name', v_payment_version
  )
  on conflict (entry_id) do update set
    state = excluded.state, account_number = excluded.account_number,
    bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
    version = excluded.version, updated_at = now();
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'payment_update', v_audit_capability, p_entry_id::text,
    v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['payment']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'entry_version', v_entry.version + 1,
    'payment_version', v_payment_version
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'payment_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_update_payment(uuid, uuid, uuid, integer, integer, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_payment(uuid, uuid, uuid, integer, integer, jsonb, text, text)
  to service_role;
