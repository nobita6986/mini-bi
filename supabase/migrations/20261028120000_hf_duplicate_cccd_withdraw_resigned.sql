-- Allow an authorized actor to withdraw the OFF episode in an active same-day
-- duplicate cluster, while requiring its ON counterpart to remain intact.
begin;

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
    raise exception 'HF duplicate CCCD withdraw invalid source patch specification';
  end if;

  select replace(p.prosrc, chr(13), '')
    into v_source
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if v_source is null then
    raise exception 'HF duplicate CCCD withdraw source function not found: %', p_signature;
  end if;

  v_expected := replace(v_expected, chr(13), '');
  v_replacement := replace(v_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'HF duplicate CCCD withdraw expected % source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;

  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_catalog.pg_get_functiondef(p.oid), chr(13), '')
    into v_definition
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'HF duplicate CCCD withdraw could not reconstruct function definition: %', p_signature;
  end if;

  execute replace(v_definition, v_source, v_next);
end;
$function$;

revoke all on function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$  if v_target_status <> 'ON' then
    raise exception 'self withdraw target is not an active duplicate' using ERRCODE = 'PT409';
  end if;$old$,
  $new$  if v_target_status not in ('ON', 'OFF')
     or (v_target_status = 'OFF' and
         (v_entry.project_id is null or v_entry.first_work_date is null)) then
    raise exception 'self withdraw target is not a duplicate with a retained active counterpart'
      using errcode = 'PT409';
  end if;$new$,
  1
);

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$     and public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         ) = v_cccd
     and coalesce(($old$,
  $new$     and public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         ) = v_cccd
     and (
       v_target_status <> 'OFF'
       or (e.project_id = v_entry.project_id and e.first_work_date = v_entry.first_work_date)
     )
     and coalesce(($new$,
  1
);

select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$                                   'can_self_withdraw', (
                                     l.latest_status = 'ON'
                                     and pg.active_profile_count >= 2
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                     )
                                   )$old$,
  $new$                                   'can_self_withdraw', (
                                     (
                                       (l.latest_status = 'ON' and pg.active_profile_count >= 2)
                                       or (
                                         l.latest_status = 'OFF'
                                         and exists (
                                           select 1
                                             from statused same_day_active
                                            where same_day_active.entry_id <> l.entry_id
                                              and same_day_active.cccd = l.cccd
                                              and same_day_active.project_id = l.project_id
                                              and same_day_active.first_work_date = l.first_work_date
                                              and same_day_active.latest_status = 'ON'
                                         )
                                       )
                                     )
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                     )
                                   )$new$,
  1
);

drop function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
);

comment on function public.direct_entry_self_withdraw_duplicate_cccd(
  uuid, uuid, uuid, integer, text, text
) is
  'Creator or delegated duplicate-CCCD withdrawal. An OFF episode is eligible only when an ON counterpart with the same canonical CCCD, project, and first-work date remains; active targets retain the existing active-counterpart check. service_role only.';

do $check$
declare
  v_withdraw text;
  v_report text;
begin
  select p.prosrc into v_withdraw
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure;
  select p.prosrc into v_report
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure;

  if v_withdraw is null or v_report is null
     or position('v_target_status not in (' || chr(39) || 'ON' || chr(39) || ', ' || chr(39) || 'OFF' || chr(39) || ')' in v_withdraw) = 0
     or position('e.project_id = v_entry.project_id and e.first_work_date = v_entry.first_work_date' in v_withdraw) = 0
     or position('same_day_active.latest_status = ' || chr(39) || 'ON' || chr(39) in v_report) = 0
     or position('l.latest_status = ' || chr(39) || 'OFF' || chr(39) in v_report) = 0 then
    raise exception 'HF duplicate CCCD resigned-withdraw eligibility drift';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not exists (
         select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'HF duplicate CCCD resigned-withdraw security boundary changed';
  end if;
end;
$check$;

commit;
