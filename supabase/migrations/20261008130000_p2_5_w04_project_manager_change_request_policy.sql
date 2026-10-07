-- P2.5-W04 — Project-manager change-request policy rebaseline (#53).
--
-- Base:  origin/main@af72b43 (post W02 #51 + W03 #52 + W03-R1).
-- Locks: docs/P2.5.md, W01-R1, W05-R0 T0 policy lock, T0 W04-R1 findings.
--
-- DELTA: proposer audience assignment-only; protected ENTRY_FIELD fields rejected
-- (22023) incl. forged display_name; apply no longer re-derives recruiter/team/
-- provider from first_work_date; FINDING 1 closes direct mutation after SUBMITTED;
-- reason/OCC/idempotency/no-self-review/immutable audit/all-or-nothing unchanged.

begin;

create function public.direct_entry_w04_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-W04 invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'P2.5-W04 source function not found: %', p_signature; end if;
  if position(chr(13) || chr(10) in v_source) > 0 then
    v_expected := replace(v_expected, chr(10), chr(13) || chr(10));
    v_replacement := replace(v_replacement, chr(10), chr(13) || chr(10));
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-W04 expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-W04 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);
  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then raise exception 'P2.5-W04 changed function security boundary: %', p_signature; end if;
end;
$$;
revoke all on function public.direct_entry_w04_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_w04_worker_details_allowed(p_worker_details jsonb)
returns boolean language sql immutable
as $$
  select p_worker_details is not null
     and jsonb_typeof(p_worker_details) = 'object'
     and (p_worker_details - array[
           'display_name','gender','date_of_birth','national_id',
           'national_id_issued_at','national_id_issued_place','address','phone'
         ]) = '{}'::jsonb;
$$;
revoke all on function public.direct_entry_w04_worker_details_allowed(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_w04_worker_details_allowed(jsonb) to service_role;

create or replace function public.direct_entry_w04_assert_display_name_unchanged(
  p_worker_details jsonb, p_stored jsonb
) returns void language plpgsql immutable
as $$
begin
  if p_worker_details is null or jsonb_typeof(p_worker_details) <> 'object' then
    return;
  end if;
  if p_worker_details ? 'display_name'
     and p_worker_details->>'display_name' is distinct from p_stored->>'display_name' then
    raise exception 'display_name is protected and cannot change' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.direct_entry_w04_assert_display_name_unchanged(jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_w04_assert_display_name_unchanged(jsonb,jsonb) to service_role;

create or replace function public.direct_entry_assert_not_review(p_submission_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_state text;
begin
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = p_submission_id for update;
  if v_state is null then raise exception 'submission not found' using errcode = 'P0002'; end if;
  if v_state <> 'DRAFT' then
    raise exception 'non-draft submissions are change-request only' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.direct_entry_assert_not_review(uuid)
  from public, anon, authenticated, service_role;

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)'::regprocedure,
  $old$
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;$old$,
  $new$
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state <> 'DRAFT' then
    raise exception 'non-draft submissions are change-request only' using errcode = '42501';
  end if;$new$,
  1
);

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'
          ]) <> '{}'::jsonb)$old$,
  $new$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'worker_details'
          ]) <> '{}'::jsonb)
       or (v_item->>'target_kind' = 'ENTRY_FIELD'
          and (v_item->'proposal') ? 'worker_details'
          and public.direct_entry_w04_worker_details_allowed(
            v_item->'proposal'->'worker_details'
          ) is not true)$new$,
  1
);

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    perform public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );$old$,
  $new$
    perform public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );
    perform public.direct_entry_w04_assert_display_name_unchanged(
      v_item->'proposal'->'worker_details', v_entry.worker_details
    );$new$,
  1
);

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    v_scope := public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );$old$,
  $new$
    v_scope := public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );
    perform public.direct_entry_w04_assert_display_name_unchanged(
      v_item->'proposal'->'worker_details', v_entry.worker_details
    );$new$,
  1
);

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;$old$,
  $new$
    if (p_proposal - array['worker_details']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    perform public.direct_entry_w04_assert_display_name_unchanged(
      p_proposal->'worker_details', p_entry.worker_details
    );$new$,
  1
);

select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      p_entry.created_by_user_id, v_team_id, v_date, v_scope
    );$old$,
  $new$
    v_recruiter_id := p_entry.recruiter_id;
    v_date := p_entry.first_work_date;
    v_team_id := p_entry.team_id;
    v_provider := p_entry.provider_type;$new$,
  1
);

create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid, p_proposer_user_id uuid, p_request_id uuid
) returns text language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_items integer; v_accessible integer; v_is_proposer boolean;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_is_proposer := p_proposer_user_id = p_app_user_id;
  select count(*) into v_items from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then return 'NONE'; end if;
  select count(*) into v_accessible
    from public.direct_entry_change_request_items i
    join public.direct_entries e on e.entry_id = i.entry_id
   where i.request_id = p_request_id
     and case
       when v_is_proposer then
         public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
         and exists (
           select 1 from public.direct_entry_submissions s
            where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
         )
       else
         public.direct_entry_has_entry_access(
           p_app_user_id, 'change_review', e.created_by_user_id, e.team_id, e.first_work_date
         )
     end;
  if v_accessible <> v_items then return 'NONE'; end if;
  return case when v_is_proposer then 'PROPOSER' else 'REVIEWER' end;
end;
$$;
revoke all on function public.direct_entry_change_request_audience(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_change_request_audience(uuid,uuid,uuid) is
  'P2.5-W04: PROPOSER audience is assignment-only; created_by/team/first_work_date grant no propose authority. REVIEWER unchanged.';

drop function public.direct_entry_w04_replace_proc_source(regprocedure,text,text,integer);

do $p2_5_w04$
declare
  v_source text;
begin
  if public.direct_entry_w04_worker_details_allowed('{"gender":"MALE"}'::jsonb) is not true
     or public.direct_entry_w04_worker_details_allowed('{"display_name":"x","phone":{"state":"unknown"}}'::jsonb) is not true
     or public.direct_entry_w04_worker_details_allowed('{"gender":"MALE","nope":1}'::jsonb) is not false
     or public.direct_entry_w04_worker_details_allowed(null) is not false then
    raise exception 'P2.5-W04 worker_details allowlist self-check failed';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure;
  if position('direct_entry_w04_assert_display_name_unchanged' in v_source) = 0 then
    raise exception 'P2.5-W04 create path lost the display_name guard';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_assert_not_review(uuid)'::regprocedure;
  if position('change-request only' in v_source) = 0 then
    raise exception 'P2.5-W04 assert_not_review is not DRAFT-only';
  end if;
  if has_function_privilege('anon', 'public.direct_entry_w04_worker_details_allowed(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_w04_worker_details_allowed(jsonb)', 'EXECUTE') then
    raise exception 'P2.5-W04 allowlist helper must not be executable by browser roles';
  end if;
  raise notice 'P2.5-W04 migration #53 self-check OK';
end
$p2_5_w04$;

commit;
