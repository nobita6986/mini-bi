-- R4-S03: edit informational account metadata through the existing payment authority.
begin;

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
  v_is_account_metadata boolean;
  v_account_number_op text;
  v_bank_name_op text;
  v_account_holder_name_op text;
  v_account_number_value text;
  v_bank_name_value text;
  v_account_holder_name_value text;
  v_payment_state text;
  v_account_number text;
  v_bank_id text;
  v_bank_name text;
  v_account_holder_name text;
  v_trim_chars text := E' \t\n\r' || chr(11) || chr(12) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
    || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
    || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_payment is null or jsonb_typeof(p_payment) <> 'object' then
    raise exception 'invalid payment input' using errcode = '22023';
  end if;

  v_is_account_metadata :=
    p_payment ?& array['account_number','bank_name','account_holder_name']
    and (p_payment - array['account_number','bank_name','account_holder_name']) = '{}'::jsonb;

  if not v_is_account_metadata
     and (p_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
    raise exception 'invalid payment input' using errcode = '22023';
  end if;

  if v_is_account_metadata then
    if jsonb_typeof(p_payment->'account_number') is distinct from 'object'
       or jsonb_typeof(p_payment->'bank_name') is distinct from 'object'
       or jsonb_typeof(p_payment->'account_holder_name') is distinct from 'object' then
      raise exception 'invalid account metadata' using errcode = '22023';
    end if;
    v_account_number_op := p_payment->'account_number'->>'op';
    v_bank_name_op := p_payment->'bank_name'->>'op';
    v_account_holder_name_op := p_payment->'account_holder_name'->>'op';
    if v_account_number_op is null
       or v_bank_name_op is null
       or v_account_holder_name_op is null
       or v_account_number_op not in ('keep','set','clear')
       or v_bank_name_op not in ('keep','set','clear')
       or v_account_holder_name_op not in ('keep','set','clear')
       or not ((p_payment->'account_number') ? 'op')
       or not ((p_payment->'bank_name') ? 'op')
       or not ((p_payment->'account_holder_name') ? 'op')
       or (v_account_number_op in ('keep','clear')
         and ((p_payment->'account_number') - 'op'::text) <> '{}'::jsonb)
       or (v_bank_name_op in ('keep','clear')
         and ((p_payment->'bank_name') - 'op'::text) <> '{}'::jsonb)
       or (v_account_holder_name_op in ('keep','clear')
         and ((p_payment->'account_holder_name') - 'op'::text) <> '{}'::jsonb)
       or (v_account_number_op = 'set'
         and (((p_payment->'account_number') - array['op','value']::text[]) <> '{}'::jsonb
           or not ((p_payment->'account_number') ? 'value')
           or jsonb_typeof(p_payment->'account_number'->'value') is distinct from 'string'))
       or (v_bank_name_op = 'set'
         and (((p_payment->'bank_name') - array['op','value']::text[]) <> '{}'::jsonb
           or not ((p_payment->'bank_name') ? 'value')
           or jsonb_typeof(p_payment->'bank_name'->'value') is distinct from 'string'))
       or (v_account_holder_name_op = 'set'
         and (((p_payment->'account_holder_name') - array['op','value']::text[]) <> '{}'::jsonb
           or not ((p_payment->'account_holder_name') ? 'value')
           or jsonb_typeof(p_payment->'account_holder_name'->'value')
             is distinct from 'string')) then
      raise exception 'invalid account metadata' using errcode = '22023';
    end if;
    if v_account_number_op = 'keep' and v_bank_name_op = 'keep'
       and v_account_holder_name_op = 'keep' then
      raise exception 'account metadata update has no changes' using errcode = '22023';
    end if;
    if v_account_number_op = 'set' then
      v_account_number_value := btrim(
        p_payment->'account_number'->>'value', v_trim_chars
      );
      if length(v_account_number_value) not between 1 and 64
         or v_account_number_value !~ '^[0-9]+$' then
        raise exception 'invalid account metadata' using errcode = '22023';
      end if;
    end if;
    if v_bank_name_op = 'set' then
      v_bank_name_value := btrim(p_payment->'bank_name'->>'value', v_trim_chars);
      if length(v_bank_name_value) not between 1 and 256
         or v_bank_name_value ~ '[[:cntrl:]]' then
        raise exception 'invalid account metadata' using errcode = '22023';
      end if;
    end if;
    if v_account_holder_name_op = 'set' then
      v_account_holder_name_value := btrim(
        p_payment->'account_holder_name'->>'value', v_trim_chars
      );
      if length(v_account_holder_name_value) not between 1 and 256
         or v_account_holder_name_value ~ '[[:cntrl:]]' then
        raise exception 'invalid account metadata' using errcode = '22023';
      end if;
    end if;
  else
    v_payment_state := p_payment->>'state';
    v_account_number := p_payment->>'account_number';
    v_bank_id := p_payment->>'bank_id';
    v_bank_name := null;
    v_account_holder_name := p_payment->>'account_holder_name';
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
  if v_is_account_metadata then
    v_account_number := case v_account_number_op
      when 'keep' then v_payment.account_number
      when 'set' then v_account_number_value
      else null
    end;
    v_bank_name := case v_bank_name_op
      when 'keep' then v_payment.bank_name
      when 'set' then v_bank_name_value
      else null
    end;
    v_account_holder_name := case v_account_holder_name_op
      when 'keep' then v_payment.account_holder_name
      when 'set' then v_account_holder_name_value
      else null
    end;
    v_bank_id := case
      when v_bank_name_op = 'keep' then v_payment.bank_id
      else null
    end;
    v_payment_state := case
      when v_account_number is null and v_bank_name is null
        and v_account_holder_name is null then 'omitted'
      else 'provided'
    end;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_payments (
    entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
  ) values (
    p_entry_id, v_payment_state, v_account_number, v_bank_id, v_bank_name,
    v_account_holder_name, v_payment_version
  )
  on conflict (entry_id) do update set
    state = excluded.state, account_number = excluded.account_number,
    bank_id = excluded.bank_id,
    bank_name = case when v_is_account_metadata then excluded.bank_name
      when excluded.state = 'provided' then public.direct_entry_payments.bank_name
      else excluded.bank_name end,
    account_holder_name = excluded.account_holder_name,
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

commit;
