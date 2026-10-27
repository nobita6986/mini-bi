begin;

alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_capability_check;

alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (capability in (
    'entry_create', 'entry_own', 'entry_team', 'entry_admin', 'entry_restore',
    'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
    'employment_status.request', 'employment_status.review', 'employment_status.apply',
    'document_upload', 'document_view', 'payment_view', 'payment_edit',
    'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
    'catalog_master_manage', 'team_manager_assign',
    'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view',
    'report_review', 'report_delegate',
    'vendor_finance_view', 'vendor_finance_record',
    'duplicate_cccd_withdraw'
  ));

comment on constraint direct_entry_capability_grants_capability_check
  on public.direct_entry_capability_grants is
  'HF duplicate CCCD: 32 canonical tokens, including the narrow duplicate_cccd_withdraw action capability.';

create function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_source text;
  v_definition text;
  v_expected text := p_expected;
  v_replacement text := p_replacement;
  v_next text;
  v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'HF duplicate CCCD invalid source patch specification';
  end if;

  select replace(p.prosrc, chr(13), '')
    into v_source
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if v_source is null then
    raise exception 'HF duplicate CCCD source function not found: %', p_signature;
  end if;

  v_expected := replace(v_expected, chr(13), '');
  v_replacement := replace(v_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'HF duplicate CCCD expected % source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;

  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_catalog.pg_get_functiondef(p.oid), chr(13), '')
    into v_definition
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'HF duplicate CCCD could not reconstruct function definition: %', p_signature;
  end if;

  execute replace(v_definition, v_source, v_next);
end;
$function$;

revoke all on function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$if v_entry.created_by_user_id is distinct from p_app_user_id then
    raise exception 'self withdraw requires entry creator' using errcode = '42501';
  end if;$old$,
  $new$if v_entry.created_by_user_id is distinct from p_app_user_id
     and not public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw') then
    raise exception 'self withdraw requires entry creator or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;$new$,
  2
);

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$    'entry_self_withdraw_duplicate_cccd',
    'entry_creator_self_withdraw',
    'own',
    null
  );$old$,
  $new$    'entry_self_withdraw_duplicate_cccd',
    case when v_entry.created_by_user_id = p_app_user_id
      then 'entry_creator_self_withdraw' else 'duplicate_cccd_withdraw' end,
    case when v_entry.created_by_user_id = p_app_user_id then 'own' else 'all' end,
    null
  );$new$,
  1
);

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$'can_self_withdraw', (l.created_by_user_id = p_app_user_id)$old$,
  $new$'can_self_withdraw', (
                                     l.created_by_user_id = p_app_user_id
                                     or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                   )$new$,
  1
);

drop function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
);

do $check$
declare
  v_withdraw text;
  v_report text;
  v_constraint text;
begin
  select replace(p.prosrc, chr(13), '') into v_withdraw
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure;
  select replace(p.prosrc, chr(13), '') into v_report
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure;
  select pg_catalog.pg_get_constraintdef(c.oid) into v_constraint
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.direct_entry_capability_grants'::regclass
     and c.conname = 'direct_entry_capability_grants_capability_check';

  if v_withdraw is null or
     (length(v_withdraw) - length(replace(
       v_withdraw,
       'and not public.direct_entry_has_capability(p_app_user_id, ' || chr(39) ||
         'duplicate_cccd_withdraw' || chr(39) || ') then',
       ''
     ))) / length(
       'and not public.direct_entry_has_capability(p_app_user_id, ' || chr(39) ||
         'duplicate_cccd_withdraw' || chr(39) || ') then'
     ) <> 2 then
    raise exception 'HF duplicate CCCD withdraw capability must guard both pre-lock and post-lock checks';
  end if;
  if position('then ' || chr(39) || 'entry_creator_self_withdraw' || chr(39) ||
              ' else ' || chr(39) || 'duplicate_cccd_withdraw' || chr(39) || ' end' in v_withdraw) = 0 or
     position('then ' || chr(39) || 'own' || chr(39) || ' else ' || chr(39) || 'all' || chr(39) || ' end' in v_withdraw) = 0 then
    raise exception 'HF duplicate CCCD audit must distinguish creator self-withdraw from delegated all-company withdraw';
  end if;
  if position('l.created_by_user_id = p_app_user_id' in v_report) = 0 or
     position('direct_entry_has_capability(p_app_user_id, ' || chr(39) || 'duplicate_cccd_withdraw' || chr(39) || ')' in v_report) = 0 then
    raise exception 'HF duplicate CCCD report action flag lost creator or delegated withdraw checks';
  end if;
  if position('duplicate_cccd_withdraw' in coalesce(v_constraint, '')) = 0 then
    raise exception 'HF duplicate CCCD capability token missing from database constraint';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) or not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'HF duplicate CCCD function security boundary changed';
  end if;
end;
$check$;

commit;
