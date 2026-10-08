-- P2.5-HF - Worker create authority by project assignment + CCCD rehire (#58).
--
-- Base: origin/main@8b01b67db08c68ccaeb9b369593159c9d9a0668a (ledger 57, initial
-- employment status ON).
--
-- ROOT CAUSE (verified on this base): direct_entry_create_full_profile_batch,
-- ..._v2, direct_entry_create_batch and direct_entry_create_draft_row each demanded
-- the GLOBAL capabilities entry_create + submission_create (and an own scope grant)
-- before any per-project decision, so an assigned project manager could not create a
-- full profile and the API surfaced ACTOR_DENIED.
--
-- FINDING 1 - creation authority is per ROW and per PROJECT:
--   * an effective project-manager assignment on the row's project authorizes the
--     create (one project may have several managers; every effective assignment is
--     equal);
--   * the legacy bundle (entry_create + submission_create + a personal own scope)
--     keeps working exactly as before for Admin/Owner;
--   * one unauthorized row fails the whole batch before any write (zero residue);
--   * created_by / recruiter_id / team membership / first_work_date never grant it,
--     and no global capability is handed to a manager;
--   * bank text is profile data for an assigned manager at creation, while recording
--     a departure (explicit OFF) still requires employment_status.apply for everyone.
--
-- FINDING 2 - CCCD rehire: every working period is a NEW entry with a server-generated
-- employee_code and entry_id; history is never edited, restored or merged. A repeated
-- normalized CCCD is refused 23505 unless every earlier episode of that CCCD has OFF
-- as its latest status; ON / UNCONFIRMED / missing status fail closed, and the guard
-- serializes per CCCD so two concurrent creates cannot both pass. The old
-- "one direct_entries row per CCCD forever" unique index is replaced by that rule.
--
-- FINDING 3 - narrow rehire lookup: direct_entry_lookup_worker_episodes returns only
-- display_name, employee_code, project, first_work_date and latest status for episodes
-- matching a name AND CCCD. It exposes no CCCD, DOB, address, phone, bank or document
-- data, and only a manager of the target project (or an entry_admin@all actor) may call
-- it. It is not a worker directory and grants no extra read authority.
--
-- Reuse: direct_entry_project_assignment_effective (W02), direct_entry_has_capability,
-- direct_entry_assert_actor_mapping, direct_entry_valid_worker_details, the existing
-- reason/OCC/idempotency/audit engine and the #57 initial ON default. No new capability
-- token, no second RBAC/workflow, no dependency.

begin;

-- -----------------------------------------------------------------------------
-- 1. Per-row creation authority.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_create_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_first_work_date date default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_date date := coalesce(p_first_work_date, public.direct_entry_authorization_date());
  v_own_scope integer;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  -- P2.5: the project manager of THIS project. Several managers may hold it.
  if p_project_id is not null
     and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'manager';
  end if;

  -- Legacy/Admin path: unchanged global bundle plus the personal own scope.
  if public.direct_entry_has_capability(p_app_user_id, 'entry_create')
     and public.direct_entry_has_capability(p_app_user_id, 'submission_create') then
    select count(*)::int into v_own_scope
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
       and g.valid_from <= v_date
       and (g.valid_to is null or v_date < g.valid_to);
    if v_own_scope = 1 then
      return 'legacy';
    end if;
    raise exception 'entry creation own scope denied' using errcode = '42501';
  end if;

  raise exception 'worker create authority denied' using errcode = '42501';
end;
$$;
revoke all on function public.direct_entry_create_authority(uuid, uuid, text, date)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_create_authority(uuid, uuid, text, date) is
  'P2.5-HF internal creation authority: returns manager for an effective project-manager '
  'assignment on the given project, legacy for entry_create + submission_create + one '
  'effective own scope grant, and raises 42501 otherwise. created_by, recruiter, team and '
  'first_work_date never authorize a create.';

-- -----------------------------------------------------------------------------
-- 2. Source patches for the four create paths.
-- -----------------------------------------------------------------------------
create function public.direct_entry_hf_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-HF invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'P2.5-HF source function not found: %', p_signature; end if;
  if position(chr(13) || chr(10) in v_source) > 0 then
    v_expected := replace(v_expected, chr(10), chr(13) || chr(10));
    v_replacement := replace(v_replacement, chr(10), chr(13) || chr(10));
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-HF expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-HF could not reconstruct function definition: %', p_signature;
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
  ) then raise exception 'P2.5-HF changed function security boundary: %', p_signature; end if;
end;
$$;
revoke all on function public.direct_entry_hf_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- 2a. Full-profile batch (worker-profile/1.0): per-row authority before any write.
select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_create');
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'submission_create');
  if v_has_payment then$old$,
  $new$
  -- P2.5-HF: creation authority is per ROW and per PROJECT. The guard below calls the
  -- authority for every row, so one unauthorized project fails the whole batch before
  -- the idempotency record, the submission or any entry exists.
  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';
  if v_has_payment and v_count > 0 then$new$,
  1
);

select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
    if v_row ? 'employment' and v_row->'employment' ? 'initial_status' then
      v_has_status := true;
    end if;$old$,
  $new$
    -- P2.5-HF: ON is the creation default (#57), so only an explicit departure needs
    -- the privileged employment_status.apply capability.
    if coalesce(v_row->'employment'->>'initial_status', '') = 'OFF' then
      v_has_status := true;
    end if;$new$,
  1
);

select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
    select count(*) into v_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
       and g.valid_from <= v_auth_date
       and (g.valid_to is null or v_auth_date < g.valid_to);
    if v_count <> 1 then
      raise exception 'entry creation own scope denied' using errcode = '42501';
    end if;$old$,
  $new$
    -- P2.5-HF: the creation authority (project assignment, or the legacy bundle with
    -- its own scope) was already enforced once for the whole batch above.$new$,
  1
);

select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
      if exists (
        select 1 from public.direct_entries e
         where btrim(e.worker_details->'national_id'->>'value') = btrim(v_national_id)
           and e.worker_details->'national_id'->>'state' = 'provided'
      ) then
        raise exception 'NATIONAL_ID_DUPLICATE' using errcode = '23505';
      end if;$old$,
  $new$
      -- P2.5-HF: a repeated CCCD is a REHIRE, not a duplicate. The row guard on
      -- direct_entries refuses it 23505 unless every earlier episode is OFF; the
      -- in-batch duplicate check above stays.$new$,
  1
);

-- 2b. Full-profile batch v2 implementation (worker-profile/1.1, server employee codes).
-- The public ..._v2 wrapper keeps its own W07B project scope gate
-- (direct_entry_actor_can_access_project, which already accepts an effective project
-- manager); the global capabilities sit in this unscoped implementation.
select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_create');
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'submission_create');$old$,
  $new$
  -- P2.5-HF: same per-row project authority as the inner batch, evaluated before the
  -- idempotency record and before any employee-code counter is consumed.
  select count(*)::int into v_membership_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           (e.value->>'first_work_date')::date
         ) <> 'manager';$new$,
  1
);

-- 2c. Legacy batch (v1).
select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_create'
  );
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );$old$,
  $new$
  -- P2.5-HF: per-row project authority, before the idempotency record and the
  -- submission insert.
  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';$new$,
  1
);

select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
  $old$
    select count(*) into v_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
       and g.valid_from <= v_first_work_date
       and (g.valid_to is null or v_first_work_date < g.valid_to);
    if v_count <> 1 then
      raise exception 'entry creation own scope denied' using errcode = '42501';
    end if;$old$,
  $new$
    -- P2.5-HF: enforced once by the per-row authority guard before this batch ran.$new$,
  1
);

-- 2d. Quick-add draft row.
select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_create'
  );
  select * into v_submission$old$,
  $new$
  select * into v_submission$new$,
  1
);

select public.direct_entry_hf_replace_proc_source(
  'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$
  select count(*) into v_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
     and g.valid_from <= v_first_work_date
     and (g.valid_to is null or v_first_work_date < g.valid_to);
  if v_count <> 1 then
    raise exception 'entry creation own scope denied' using errcode = '42501';
  end if;$old$,
  $new$
  -- P2.5-HF: the row's project decides the creation authority for this row.
  perform public.direct_entry_create_authority(
    p_auth_subject, p_app_user_id, v_project_id, v_first_work_date
  );$new$,
  1
);

drop function public.direct_entry_hf_replace_proc_source(regprocedure,text,text,integer);

-- -----------------------------------------------------------------------------
-- 3. CCCD episode guard: one ACTIVE episode per normalized CCCD.
-- -----------------------------------------------------------------------------
drop index if exists public.direct_entries_worker_national_id_uidx;

create or replace function public.direct_entry_guard_active_episode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cccd text;
  v_conflict boolean;
begin
  if new.worker_details->'national_id'->>'state' is distinct from 'provided' then
    return new;
  end if;
  v_cccd := nullif(btrim(coalesce(new.worker_details->'national_id'->>'value', '')), '');
  if v_cccd is null then
    return new;
  end if;
  -- Serialize per normalized CCCD so two concurrent creates cannot both pass the check.
  perform pg_advisory_xact_lock(hashtextextended('worker-episode:' || v_cccd, 0));
  select exists (
    select 1
      from public.direct_entries e
     where e.entry_id <> new.entry_id
       and e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and btrim(e.worker_details->'national_id'->>'value') = v_cccd
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') <> 'OFF'
  ) into v_conflict;
  if v_conflict then
    raise exception 'worker_active_episode_exists' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_guard_active_episode()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_guard_active_episode() is
  'P2.5-HF: a normalized CCCD may hold at most one episode whose latest status is not OFF. '
  'A rehire is allowed only when every earlier episode is OFF; ON, UNCONFIRMED and missing '
  'status fail closed with 23505 worker_active_episode_exists. The message never carries the '
  'CCCD or any other profile value.';

create trigger direct_entry_active_episode_guard
  before insert or update of worker_details on public.direct_entries
  for each row execute function public.direct_entry_guard_active_episode();

-- -----------------------------------------------------------------------------
-- 4. Narrow rehire lookup.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_lookup_worker_episodes(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_display_name text,
  p_national_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cccd text := nullif(btrim(coalesce(p_national_id, '')), '');
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_episodes jsonb;
  v_active boolean;
  v_actor_is_manager boolean;
begin
  if p_project_id is null or v_cccd is null or v_name is null then
    raise exception 'worker lookup requires project, name and national id'
      using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_actor_is_manager := public.direct_entry_actor_is_assigned_project_manager(
    p_app_user_id, p_project_id
  );
  if not v_actor_is_manager then
    -- Any other caller must be an explicit all-scope administrator.
    perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  end if;

  select coalesce(jsonb_agg(episode.row_json order by episode.first_work_date desc,
           episode.entry_id desc), '[]'::jsonb)
    into v_episodes
    from (
      select e.entry_id,
             e.first_work_date,
             jsonb_build_object(
               'entry_id', e.entry_id,
               'display_name', e.worker_details->>'display_name',
               'employee_code', e.employee_code,
               'project_id', e.project_id,
               'project_display', p.display_name,
               'first_work_date', pg_catalog.to_char(e.first_work_date, 'YYYY-MM-DD'),
               'latest_status', coalesce(st.status, 'UNCONFIRMED')
             ) as row_json
        from public.direct_entries e
        join public.direct_entry_projects p on p.project_id = e.project_id
        left join lateral (
          select ev.status
            from public.direct_entry_employment_status_events ev
           where ev.entry_id = e.entry_id
           order by ev.version desc
           limit 1
        ) st on true
       where e.deleted_at is null
         and e.worker_details->'national_id'->>'state' = 'provided'
         and btrim(e.worker_details->'national_id'->>'value') = v_cccd
         and lower(btrim(e.worker_details->>'display_name')) = lower(v_name)
       order by e.first_work_date desc, e.entry_id desc
       limit 50
    ) episode;

  select exists (
    select 1 from jsonb_array_elements(v_episodes) as ep(value)
     where ep.value->>'latest_status' <> 'OFF'
  ) into v_active;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
    'episode_count', jsonb_array_length(v_episodes),
    'active_episode_exists', v_active,
    'rehire_allowed', not v_active,
    'episodes', v_episodes
  );
end;
$$;
revoke all on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text)
  to service_role;
comment on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text) is
  'P2.5-HF narrow rehire lookup: episodes matching a normalized CCCD AND display name, '
  'returning only employee_code, project, first_work_date and latest status. No CCCD, DOB, '
  'address, phone, bank or document data is returned, and only an effective project manager '
  'of the target project or an all-scope administrator may call it.';

-- -----------------------------------------------------------------------------
-- 5. Self-check.
-- -----------------------------------------------------------------------------
do $p2_5_hf$
declare
  v_source text;
  v_signature text;
begin
  for v_signature in
    select unnest(array[
      'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)',
      'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)',
      'public.direct_entry_create_batch(uuid,uuid,jsonb,text)',
      'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'
    ])
  loop
    select p.prosrc into v_source from pg_proc p where p.oid = v_signature::regprocedure;
    if position('direct_entry_create_authority' in v_source) = 0 then
      raise exception 'P2.5-HF % lost the project creation authority', v_signature;
    end if;
    if position('direct_entry_assert_actor(p_auth_subject, p_app_user_id, ''entry_create'')' in v_source) > 0
       or position('direct_entry_assert_actor(p_auth_subject, p_app_user_id, ''submission_create'')' in v_source) > 0 then
      raise exception 'P2.5-HF % still demands the global create capabilities', v_signature;
    end if;
  end loop;

  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  if position('NATIONAL_ID_DUPLICATE'' using errcode = ''23505''' in v_source) > 0 then
    raise exception 'P2.5-HF rehire is still blocked by the duplicate check';
  end if;
  if position('entry creation own scope denied' in v_source) > 0 then
    raise exception 'P2.5-HF legacy own-scope rule is duplicated inside the batch';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_guard_active_episode()'::regprocedure;
  if position('worker_active_episode_exists' in v_source) = 0
     or position(chr(39) || 'UNCONFIRMED' || chr(39) in v_source) = 0 then
    raise exception 'P2.5-HF episode guard is not fail-closed';
  end if;
  if exists (
    select 1 from pg_indexes i
     where i.schemaname = 'public' and i.indexname = 'direct_entries_worker_national_id_uidx'
  ) then
    raise exception 'P2.5-HF the one-row-per-CCCD index still blocks rehire';
  end if;
  -- The public v2 wrapper must keep its W07B project scope gate, which already
  -- accepts an effective project manager.
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)'::regprocedure;
  if position('direct_entry_actor_can_access_project' in v_source) = 0 then
    raise exception 'P2.5-HF the v2 wrapper lost its project scope gate';
  end if;
  if not has_function_privilege('service_role',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text)', 'EXECUTE') then
    raise exception 'P2.5-HF lookup ACL self-check failed';
  end if;

  raise notice 'P2.5-HF migration self-check OK (project create authority + CCCD rehire guard)';
end
$p2_5_hf$;

commit;
