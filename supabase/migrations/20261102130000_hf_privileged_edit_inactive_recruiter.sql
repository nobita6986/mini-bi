-- Keep direct edits available when the saved recruiter is no longer active.
-- Re-resolve recruiter membership only when recruiter or first work date changes.

begin;

do $patch_privileged_edit_inactive_recruiter$
declare
  v_signature regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc,
         pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config,
         v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');
  v_old := $old$  select count(*), min(m.provider_type) into v_count, v_provider
    from public.recruiter_provider_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.is_current;
  if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
  if v_provider = 'vendor' then
    v_team := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and m.is_current;
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  end if;
  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;$old$;
  v_new := $new$  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  if (case when p_patch ? 'recruiter_id'
        then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end)
       is distinct from v_entry.recruiter_id
     or v_target_date is distinct from v_entry.first_work_date then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and m.is_current;
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team
        from public.recruiter_team_memberships m
       where m.recruiter_id = case when p_patch ? 'recruiter_id'
              then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
         and m.is_current;
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;
  else
    v_team := v_entry.team_id;
    v_provider := v_entry.provider_type;
  end if;$new$;

  if position(v_old in v_next) = 0 then
    raise exception 'inactive recruiter direct edit source drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  execute replace(
    replace(v_definition, E'\r\n', E'\n'),
    replace(v_source, E'\r\n', E'\n'),
    v_next
  );

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'inactive recruiter patch changed direct edit security metadata' using errcode = '55000';
  end if;

  select p.prosrc into v_next
    from pg_catalog.pg_proc p
   where p.oid = v_signature;
  if position('v_team := v_entry.team_id;' in v_next) = 0
     or position('v_provider := v_entry.provider_type;' in v_next) = 0
     or position('or v_target_date is distinct from v_entry.first_work_date then' in v_next) = 0 then
    raise exception 'inactive recruiter direct edit postcondition failed' using errcode = '55000';
  end if;
end;
$patch_privileged_edit_inactive_recruiter$;

commit;
