-- PRE-W2-HF own-draft edit: expose and edit full profile/payment text only for the creator's DRAFT.
begin;

create function public.pre_w2_hf_104_replace_proc_source(
  p_signature regprocedure, p_old text, p_new text, p_expected_count integer default 1
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source text;
  v_definition text;
  v_old text := p_old;
  v_new text := p_new;
  v_count integer;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'PRE-W2-HF #104 function missing' using errcode = '55000'; end if;
  if position(E'\r\n' in v_source) > 0 then
    v_old := replace(v_old, E'\n', E'\r\n');
    v_new := replace(v_new, E'\n', E'\r\n');
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_old, ''))) / length(v_old);
  if v_count <> p_expected_count then
    raise exception 'PRE-W2-HF #104 source drift: expected %, found %', p_expected_count, v_count
      using errcode = '55000';
  end if;
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'PRE-W2-HF #104 could not reconstruct function' using errcode = '55000';
  end if;
  execute replace(v_definition, v_source, replace(v_source, v_old, v_new));
end;
$$;
revoke all on function public.pre_w2_hf_104_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$v_pii and e.own_submission$old$,
  $new$e.own_submission$new$,
  12
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$v_payment_view and e.own_submission$old$,
  $new$e.own_submission$new$,
  3
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when not v_employment_apply then jsonb_build_object('state', 'omitted')$old$,
  $new$when not (v_employment_apply or e.own_submission)
                then jsonb_build_object('state', 'omitted')$new$,
  2
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$'recruiter_id', 'labor_type', 'general_note'$old$,
  $new$'recruiter_id', 'labor_type', 'general_note', 'payment'$new$
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$  if p_patch ? 'worker_details' then$old$,
  $new$  if p_patch ? 'payment' then
    if jsonb_typeof(p_patch->'payment') <> 'object'
       or exists (
         select 1 from jsonb_object_keys(p_patch->'payment') as payment_key(key)
          where payment_key.key not in ('state','account_number','bank_name','account_holder_name')
       )
       or not (p_patch->'payment' ? 'state')
       or (p_patch->'payment' ? 'account_number' and
           jsonb_typeof(p_patch->'payment'->'account_number') not in ('string','null'))
       or (p_patch->'payment' ? 'bank_name' and
           jsonb_typeof(p_patch->'payment'->'bank_name') not in ('string','null'))
       or (p_patch->'payment' ? 'account_holder_name' and
           jsonb_typeof(p_patch->'payment'->'account_holder_name') not in ('string','null'))
       or p_patch->'payment'->>'state' not in ('provided','unknown','intentionally_blank','omitted') then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
    if p_patch->'payment'->>'state' = 'provided' then
      if (p_patch->'payment'->>'account_number' is not null and
          (length(p_patch->'payment'->>'account_number') > 64 or
           p_patch->'payment'->>'account_number' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'bank_name' is not null and
          (length(p_patch->'payment'->>'bank_name') > 256 or
           p_patch->'payment'->>'bank_name' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'account_holder_name' is not null and
          (length(p_patch->'payment'->>'account_holder_name') > 256 or
           p_patch->'payment'->>'account_holder_name' ~ '[[:cntrl:]]')) or
         (nullif(btrim(p_patch->'payment'->>'account_number'), '') is null and
          nullif(btrim(p_patch->'payment'->>'bank_name'), '') is null and
          nullif(btrim(p_patch->'payment'->>'account_holder_name'), '') is null) then
        raise exception 'invalid draft payment text' using errcode = '22023';
      end if;
    elsif coalesce(p_patch->'payment'->'account_number' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'bank_name' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'account_holder_name' <> 'null'::jsonb, false) then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'worker_details' then$new$
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$  update public.direct_entry_submissions set version = version + 1$old$,
  $new$  if p_patch ? 'payment' then
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id, p_patch->'payment'->>'state',
      nullif(p_patch->'payment'->>'account_number', ''), null,
      nullif(p_patch->'payment'->>'bank_name', ''),
      nullif(p_patch->'payment'->>'account_holder_name', ''), 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = null, bank_name = excluded.bank_name,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
  end if;
  update public.direct_entry_submissions set version = version + 1$new$
);

create function public.direct_entry_update_own_draft_row(
  p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid, p_expected_version integer,
  p_patch jsonb, p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
begin
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if not found or v_submission.state <> 'DRAFT' or
     v_entry.created_by_user_id <> p_app_user_id or
     v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'own draft edit denied' using errcode = '42501';
  end if;
  return public.direct_entry_update_draft_row(
    p_auth_subject, p_app_user_id, p_entry_id, p_expected_version, p_patch, p_idempotency_key
  );
end;
$$;
revoke all on function public.direct_entry_update_own_draft_row(uuid,uuid,uuid,integer,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_own_draft_row(uuid,uuid,uuid,integer,jsonb,text)
  to service_role;

select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)'::regprocedure,
  $old$  v_status_version integer;$old$,
  $new$  v_status_version integer;
  v_submission_state text;
  v_submission_creator uuid;
  v_own_draft boolean := false;$new$
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)'::regprocedure,
  $old$v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'employment_status.apply',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );$old$,
  $new$select s.state, s.created_by_user_id into v_submission_state, v_submission_creator
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id for update;
  if v_submission_state = 'DRAFT' and v_entry.created_by_user_id = p_app_user_id
     and v_submission_creator = p_app_user_id then
    v_scope := public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date, 'own'
    );
    v_own_draft := true;
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'employment_status.apply',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;$new$
);
select public.pre_w2_hf_104_replace_proc_source(
  'public.direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)'::regprocedure,
  $old$'employment_status.apply', p_entry_id::text, v_scope,$old$,
  $new$case when v_own_draft then 'entry_own' else 'employment_status.apply' end,
    p_entry_id::text, v_scope,$new$
);

drop function public.pre_w2_hf_104_replace_proc_source(regprocedure,text,text,integer);
commit;
