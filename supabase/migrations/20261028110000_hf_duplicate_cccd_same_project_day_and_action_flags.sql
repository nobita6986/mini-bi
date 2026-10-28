-- =============================================================================
-- HF: Duplicate-CCCD report retains same-(CCCD, project_id, first_work_date)
-- clusters even after one or all rows transition to OFF ("Đã nghỉ"), and aligns
-- per-episode action flags (`can_mark_off`, `can_self_withdraw`) with backend
-- RPC eligibility.
--
-- Business rules:
--   1. Existing live duplicate detection ({ON, UNCONFIRMED}) is preserved.
--   2. Non-deleted, non-voided profiles sharing the same canonical CCCD,
--      `project_id`, and `first_work_date` (count >= 2) remain in the report
--      even when one or all of those rows have `latest_status = 'OFF'`.
--   3. `OFF` profiles that do not belong to a >= 2 same-(CCCD, project_id,
--      first_work_date) cluster stay excluded so legitimate rehires across
--      different days or projects are never confused with duplicate entry.
--   4. Historical same-(CCCD, project_id, first_work_date) groups remain visible
--      until the duplicate row is voided (`voided_at IS NOT NULL`) or soft-deleted
--      (`deleted_at IS NOT NULL`). No automatic status transition, withdrawal,
--      or recruitment fact change occurs.
--   5. `active` and `active_profile_count` still count only `ON` episodes.
--   6. `can_mark_off` requires `l.latest_status = 'ON'` in addition to draft/
--      submitted state and direct-edit authority.
--   7. `can_self_withdraw` requires `l.latest_status = 'ON'` and
--      `pg.active_profile_count >= 2` in addition to creator/capability checks,
--      matching `public.direct_entry_self_withdraw_duplicate_cccd`.
-- =============================================================================
begin;

create function public.direct_entry_hf_same_project_day_replace_proc_source(
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
    raise exception 'HF duplicate CCCD same-project-day invalid source patch specification';
  end if;

  select replace(p.prosrc, chr(13), '')
    into v_source
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if v_source is null then
    raise exception 'HF duplicate CCCD same-project-day source function not found: %', p_signature;
  end if;

  v_expected := replace(v_expected, chr(13), '');
  v_replacement := replace(v_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'HF duplicate CCCD same-project-day expected % source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;

  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_catalog.pg_get_functiondef(p.oid), chr(13), '')
    into v_definition
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'HF duplicate CCCD same-project-day could not reconstruct function definition: %', p_signature;
  end if;

  execute replace(v_definition, v_source, v_next);
end;
$function$;

revoke all on function public.direct_entry_hf_same_project_day_replace_proc_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

select public.direct_entry_hf_same_project_day_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$  live as (
    select c.entry_id,
           c.entry_version,
           c.submission_id,
           c.created_by_user_id,
           c.team_id,
           c.project_id,
           c.employee_code,
           c.first_work_date,
           c.display_name,
           c.cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status
      from canonical c
     -- Null, empty and unknown values, and values whose business length is not 9
     -- or 12, are not duplicates of anything and stay out of the report.
     where public.direct_entry_is_canonical_national_id(c.cccd)
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') in ('ON','UNCONFIRMED')
  ),$old$,
  $new$  statused as (
    select c.entry_id,
           c.entry_version,
           c.submission_id,
           c.created_by_user_id,
           c.team_id,
           c.project_id,
           c.employee_code,
           c.first_work_date,
           c.display_name,
           c.cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status,
           case
             when c.project_id is not null and c.first_work_date is not null then
               count(*) over (
                 partition by c.cccd, c.project_id, c.first_work_date
               )
             else 1
           end as same_project_day_count
      from canonical c
     -- Null, empty and unknown values, and values whose business length is not 9
     -- or 12, are not duplicates of anything and stay out of the report.
     where public.direct_entry_is_canonical_national_id(c.cccd)
  ),
  live as (
    select s.entry_id,
           s.entry_version,
           s.submission_id,
           s.created_by_user_id,
           s.team_id,
           s.project_id,
           s.employee_code,
           s.first_work_date,
           s.display_name,
           s.cccd,
           s.latest_status
      from statused s
     where s.latest_status in ('ON','UNCONFIRMED')
        or s.same_project_day_count >= 2
  ),$new$,
  1
);

select public.direct_entry_hf_same_project_day_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$                                   'can_mark_off', (
                                     coalesce(sub.state, '') in ('DRAFT', 'SUBMITTED')
                                     and public.direct_entry_resolve_direct_edit_authority(
                                       p_auth_subject,
                                       p_app_user_id,
                                       l.created_by_user_id,
                                       l.team_id,
                                       l.project_id,
                                       v_is_full_admin,
                                       v_current_team_leader_team_id
                                     ) is not null
                                   ),
                                   'can_self_withdraw', (
                                     l.created_by_user_id = p_app_user_id
                                     or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                   )$old$,
  $new$                                   'can_mark_off', (
                                     l.latest_status = 'ON'
                                     and coalesce(sub.state, '') in ('DRAFT', 'SUBMITTED')
                                     and public.direct_entry_resolve_direct_edit_authority(
                                       p_auth_subject,
                                       p_app_user_id,
                                       l.created_by_user_id,
                                       l.team_id,
                                       l.project_id,
                                       v_is_full_admin,
                                       v_current_team_leader_team_id
                                     ) is not null
                                   ),
                                   'can_self_withdraw', (
                                     l.latest_status = 'ON'
                                     and pg.active_profile_count >= 2
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                     )
                                   )$new$,
  1
);

drop function public.direct_entry_hf_same_project_day_replace_proc_source(
  regprocedure, text, text, integer
);

do $check$
declare
  v_report text;
begin
  select replace(p.prosrc, chr(13), '') into v_report
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure;
  if v_report is null then
    raise exception 'HF duplicate CCCD same-project-day report function missing';
  end if;

  if position('partition by c.cccd, c.project_id, c.first_work_date' in v_report) = 0
     or position('or s.same_project_day_count >= 2' in v_report) = 0 then
    raise exception 'HF duplicate CCCD same-project-day report lost same-(cccd, project_id, first_work_date) predicate';
  end if;
  if position('s.latest_status in (' || chr(39) || 'ON' || chr(39) || ',' || chr(39) || 'UNCONFIRMED' || chr(39) || ')' in v_report) = 0 then
    raise exception 'HF duplicate CCCD same-project-day report lost live {ON, UNCONFIRMED} predicate';
  end if;
  if position('and pg.active_profile_count >= 2' in v_report) = 0 then
    raise exception 'HF duplicate CCCD same-project-day report lost active counterpart requirement on can_self_withdraw';
  end if;
  if position('cccd_last4' in v_report) = 0 or position('right(' in v_report) = 0 then
    raise exception 'HF duplicate CCCD same-project-day report no longer masks the CCCD';
  end if;
  if v_report ~* '(insert into|update public|delete from|for update|advisory_xact_lock|truncate)' then
    raise exception 'HF duplicate CCCD same-project-day report is not read-only';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not exists (
         select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'HF duplicate CCCD same-project-day report security boundary changed';
  end if;
end;
$check$;

commit;
