-- =============================================================================
-- P3-W05A — Actor-scoped reporting + team scope seed.
--
-- Task:    P3-W05A_ACTOR_SCOPED_REPORTING_AND_TEAM_SCOPE
-- Status:  P3-W05A_ACTOR_SCOPED_REPORTING_TEAM_SCOPE_LOCAL_PASS_AWAITING_UX
-- Base:    origin/main@6a81f5637d61bdd66d09c835ba613482609b8ea8
-- Source:  C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md (Release A / 2A)
--
-- Turns the authenticated-but-unscoped Dashboard into actor-scoped reporting
-- at the DB/server boundary. No new capability token; no new role engine.
--
-- AUDIENCE RESOLUTION (locked, priority all > team > own):
--   1. effective `all` scope grant              -> all
--   2. no all, effective `team` scope grant     -> team
--   3. otherwise                                -> own (via verified recruiter link)
-- The actor resolver always synthesizes an `own` scope, so all > team > own
-- is the only correct order.
--
-- SCOPE RULES (locked):
--   * all:  legacy aggregate (business_date < cutoff) + Direct Entry
--           (first_work_date >= cutoff).
--   * team: only Direct Entry whose direct_entries.team_id is in the
--           effective team scope.
--   * own:  only Direct Entry whose direct_entries.recruiter_id equals the
--           verified/effective recruiter link.
--   * Legacy aggregate is NOT authority for team/own (fail-closed excluded).
--
-- ACL (locked):
--   * Every new helper is SECURITY DEFINER with a fixed safe search_path.
--   * service_role EXECUTE only; public/anon/authenticated revoked.
--   * No raw Direct Entry table is exposed to the browser roles.
--
-- This is migration #45 (append-only after #44 W04B).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Audience resolution + actor verification.
--
--    Verifies (p_auth_subject, p_app_user_id) is an enabled app-user pair,
--    then resolves the reporting audience all/team/own from effective
--    scope grants and the verified recruiter link. Returns a sanitized jsonb
--    projection: { audience, label, team_ids, recruiter_id }.
--
--    SECURITY DEFINER + fixed safe search_path.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_resolve_audience(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_found boolean;
  v_team jsonb;
  v_link jsonb;
  v_link_count integer;
begin
  -- Verify the actor pair is an enabled app user. Fail closed (no zero).
  select exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) into v_found;

  if not v_found then
    raise exception 'reporting actor unavailable' using errcode = '42501';
  end if;

  -- 1. effective all scope grant.
  if exists (
    select 1
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'all'
       and g.valid_from <= v_today
       and (g.valid_to is null or v_today < g.valid_to)
  ) then
    return jsonb_build_object(
      'audience', 'all',
      'label', 'Toàn công ty',
      'team_ids', '[]'::jsonb,
      'recruiter_id', null
    );
  end if;

  -- 2. effective team scope grants (active teams only).
  select coalesce(jsonb_agg(
           jsonb_build_object('team_id', t.team_id, 'label', t.display_name)
           order by t.display_name, t.team_id
         ), '[]'::jsonb)
    into v_team
    from public.direct_entry_scope_grants g
    join public.teams t
      on t.team_id = g.team_id
     and t.active
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'team'
     and g.valid_from <= v_today
     and (g.valid_to is null or v_today < g.valid_to);

  if jsonb_array_length(v_team) > 0 then
    return jsonb_build_object(
      'audience', 'team',
      'label', v_team->0->>'label',
      'team_ids', (select coalesce(jsonb_agg(x->'team_id'), '[]'::jsonb)
                     from jsonb_array_elements(v_team) x),
      'recruiter_id', null
    );
  end if;

  -- 3. own via verified/effective recruiter link. Ambiguous links fail closed.
  select count(*) into v_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.valid_from <= v_today
     and (l.valid_to is null or v_today < l.valid_to);

  if v_link_count > 1 then
    raise exception 'reporting actor ambiguous recruiter link' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'recruiter_id', l.recruiter_id,
           'label', r.display_name
         )
    into v_link
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.valid_from <= v_today
     and (l.valid_to is null or v_today < l.valid_to)
   order by l.valid_from desc, l.recruiter_id
   limit 1;

  -- No verified link => own with no recruiter identity => valid empty dashboard.
  return jsonb_build_object(
    'audience', 'own',
    'label', coalesce(v_link->>'label', 'Cá nhân'),
    'team_ids', '[]'::jsonb,
    'recruiter_id', v_link->>'recruiter_id'
  );
end;
$$;

comment on function public.direct_entry_reporting_resolve_audience(uuid, uuid) is
  'P3-W05A: verify an enabled app-user pair and resolve the reporting audience '
  '(all > team > own). Sanitized projection only; no auth subject / app-user UUID '
  'is returned.';

revoke all on function public.direct_entry_reporting_resolve_audience(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_resolve_audience(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 2. Shared authorized-row predicate: eligible Direct Entry entry ids for the
--    resolved audience. Facts and options both filter through this set so the
--    all/team/own rule is expressed exactly once.
--
--    Eligibility (reused from W04A): submission.state='SUBMITTED',
--    deleted_at IS NULL, first_work_date >= cutoff.
--
--    SECURITY DEFINER + fixed safe search_path.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_authorized_entries(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (entry_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_kind text := v_audience->>'audience';
  v_team_ids uuid[];
  v_recruiter_id uuid;
begin
  if v_kind = 'all' then
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.first_work_date >= public.direct_entry_reporting_cutoff();
  elsif v_kind = 'team' then
    v_team_ids := array(
      select jsonb_array_elements_text(v_audience->'team_ids')::uuid
    );
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.first_work_date >= public.direct_entry_reporting_cutoff()
         and e.team_id = any(v_team_ids);
  else
    v_recruiter_id := (v_audience->>'recruiter_id')::uuid;
    if v_recruiter_id is null then
      return;
    end if;
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.first_work_date >= public.direct_entry_reporting_cutoff()
         and e.recruiter_id = v_recruiter_id;
  end if;
end;
$$;

comment on function public.direct_entry_reporting_authorized_entries(uuid, uuid) is
  'P3-W05A: shared authorized-row predicate (eligible Direct Entry entry ids for '
  'the resolved audience). Facts and options both intersect through this set.';

revoke all on function public.direct_entry_reporting_authorized_entries(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_authorized_entries(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 3. Scoped facts. Returns { audience, facts } where facts are ReportingFact
--    shaped rows (Direct Entry +, for `all` only, legacy aggregate) already
--    filtered by audience AND requested filters at the SQL boundary. Ordered
--    deterministically (grain + entry_id/submission_id tie-breaker).
--
--    Requested filters are intersected with the authorized row set; an
--    out-of-scope filter yields an empty fact array, never an error.
--
--    SECURITY DEFINER + fixed safe search_path.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_scoped_facts(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_filters jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_kind text := v_audience->>'audience';
  v_from date;
  v_to date;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_source text;
  v_facts jsonb;
  v_sources jsonb;
  v_latest_runs jsonb;
  v_presence jsonb;
begin
  v_from := nullif(p_filters->>'from', '')::date;
  v_to := nullif(p_filters->>'to', '')::date;
  v_project := nullif(p_filters->>'project', '');
  v_recruiter := nullif(p_filters->>'recruiter', '');
  v_provider := nullif(p_filters->>'provider', '');
  v_employment := nullif(p_filters->>'employment', '');
  v_source := nullif(p_filters->>'source', '');

  select coalesce(jsonb_agg(fact order by
           fact->>'source_id',
           fact->>'business_date',
           fact->>'project_key',
           fact->>'recruiter_key',
           fact->>'provider_type_key',
           fact->>'employment_type_key',
           fact->>'entry_id',
           fact->>'submission_id'), '[]'::jsonb)
    into v_facts
    from (
      -- Direct Entry facts (authorized set, >= cutoff).
      select jsonb_build_object(
          'source_id', f.source_id,
          'business_date', to_char(f.business_date, 'YYYY-MM-DD'),
          'project_key', f.project_key,
          'project_display', f.project_display,
          'recruiter_key', f.recruiter_key,
          'recruiter_display', f.recruiter_display,
          'provider_type_key', f.provider_type_key,
          'provider_type_display', f.provider_type_display,
          'employment_type_key', f.employment_type_key,
          'employment_type_display', f.employment_type_display,
          'recruited_count', f.recruited_count,
          'first_work_date', to_char(f.first_work_date, 'YYYY-MM-DD'),
          'entry_id', f.entry_id,
          'submission_id', f.submission_id,
          'cutoff_date', to_char(f.cutoff_date, 'YYYY-MM-DD')
        ) as fact
        from public.direct_entry_reporting_facts_v01 f
       where f.entry_id in (
           select ae.entry_id
             from public.direct_entry_reporting_authorized_entries(
               p_auth_subject, p_app_user_id
             ) ae
         )
         and (v_kind <> 'all' or v_source is null)  -- source filter is legacy-only; team/own ignore it
         and (v_from is null or f.business_date >= v_from)
         and (v_to is null or f.business_date <= v_to)
         and (v_project is null or f.project_key = v_project)
         and (v_recruiter is null or f.recruiter_key = v_recruiter)
         and (v_provider is null or f.provider_type_key = v_provider)
         and (v_employment is null or f.employment_type_key = v_employment)

      union all

      -- Legacy aggregate facts (only for `all`, < cutoff, active non-test scope).
      select jsonb_build_object(
          'source_id', b.source_id::text,
          'business_date', to_char(b.business_date, 'YYYY-MM-DD'),
          'project_key', b.project_key,
          'project_display', b.project_display,
          'recruiter_key', b.recruiter_key,
          'recruiter_display', b.recruiter_display,
          'provider_type_key', b.provider_type_key,
          'provider_type_display', b.provider_type_display,
          'employment_type_key', b.employment_type_key,
          'employment_type_display', b.employment_type_display,
          'recruited_count', b.recruited_count,
          'first_work_date', null,
          'entry_id', null,
          'submission_id', null,
          'cutoff_date', to_char(public.direct_entry_reporting_cutoff(), 'YYYY-MM-DD')
        ) as fact
        from public.daily_recruitment_breakdown b
       where v_kind = 'all'
         and b.business_date < public.direct_entry_reporting_cutoff()
         and exists (
           select 1
             from public.data_sources ds
            where ds.id = b.source_id
              and ds.active
              and not ds.is_test
         )
         and (v_source is null or b.source_id::text = v_source)
         and (v_from is null or b.business_date >= v_from)
         and (v_to is null or b.business_date <= v_to)
         and (v_project is null or b.project_key = v_project)
         and (v_recruiter is null or b.recruiter_key = v_recruiter)
         and (v_provider is null or b.provider_type_key = v_provider)
         and (v_employment is null or b.employment_type_key = v_employment)
    ) facts;

  -- Source metadata is gated by the SAME DB-resolved audience: only a
  -- DB-confirmed "all" audience receives the global source registry, latest
  -- sync status and source presence. "team"/"own" receive empty metadata
  -- (the Direct Entry synthetic source is added by the server, never here).
  if v_kind = 'all' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ds.id::text,
             'drive_file_id', ds.drive_file_id,
             'file_name', ds.file_name,
             'active', ds.active,
             'is_test', ds.is_test,
             'last_seen_at', ds.last_seen_at::text,
             'last_successful_sync_at', ds.last_successful_sync_at::text
           ) order by ds.id), '[]'::jsonb)
      into v_sources
      from public.data_sources ds
     where ds.active
       and not ds.is_test;

    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', r.source_id::text,
             'status', r.status
           ) order by r.source_id), '[]'::jsonb)
      into v_latest_runs
      from public.reporting_latest_sync_runs_v01 r;

    select coalesce(jsonb_agg(p.source_id::text order by p.source_id), '[]'::jsonb)
      into v_presence
      from public.reporting_sources_with_current_facts_v01 p;
  else
    v_sources := '[]'::jsonb;
    v_latest_runs := '[]'::jsonb;
    v_presence := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'audience', v_audience,
    'facts', v_facts,
    'sources', v_sources,
    'latest_runs', v_latest_runs,
    'presence', v_presence
  );
end;
$$;

comment on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb) is
  'P3-W05A: actor-scoped reporting facts. Filters rows at the SQL boundary; '
  'out-of-scope requested filters yield an empty set without leaking existence.';

revoke all on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  to service_role;

-- -----------------------------------------------------------------------------
-- 4. Direct Entry dimension options generated from the SAME authorized row set
--    as the facts (shared predicate). project/recruiter/provider/employment.
--
--    SECURITY DEFINER + fixed safe search_path.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_de_options_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  dimension text,
  key text,
  display text,
  recruited_count integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  select 'project'::text,
         public.direct_entry_reporting_dim_key(p.display_name),
         p.display_name,
         count(*)::integer
    from public.direct_entries e
    join public.direct_entry_projects p
      on p.project_id = e.project_id
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_dim_key(p.display_name), p.display_name;

  return query
  select 'recruiter'::text,
         public.direct_entry_reporting_recruiter_alias_key(
           e.recruiter_id, e.first_work_date
         ),
         r.display_name,
         count(*)::integer
    from public.direct_entries e
    join public.recruiters r
      on r.recruiter_id = e.recruiter_id
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_recruiter_alias_key(
              e.recruiter_id, e.first_work_date
            ), r.display_name;

  return query
  select 'provider'::text,
         public.direct_entry_reporting_recruiter_provider_key(
           e.recruiter_id, e.first_work_date
         ),
         case e.provider_type
           when 'hrp'    then 'HRP'
           when 'vendor' then 'Vendor'
           else               'Không xác định'
         end,
         count(*)::integer
    from public.direct_entries e
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_recruiter_provider_key(
              e.recruiter_id, e.first_work_date
            ),
            case e.provider_type
              when 'hrp'    then 'HRP'
              when 'vendor' then 'Vendor'
              else               'Không xác định'
            end;

  return query
  select 'employment'::text,
         public.direct_entry_reporting_employment_key(e.labor_type),
         case e.labor_type
           when 'TEMPORARY' then 'Thời vụ'
           when 'PERMANENT' then 'Chính thức'
           else                'Không xác định'
         end,
         count(*)::integer
    from public.direct_entries e
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_employment_key(e.labor_type),
            case e.labor_type
              when 'TEMPORARY' then 'Thời vụ'
              when 'PERMANENT' then 'Chính thức'
              else                'Không xác định'
            end;
end;
$$;

comment on function public.direct_entry_reporting_de_options_scoped(uuid, uuid) is
  'P3-W05A: Direct Entry dimension options from the authorized row set (same '
  'predicate as scoped facts).';

revoke all on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 5. Scoped options. Returns { audience, dimensions, sources }.
--
--    * dimensions: authorized Direct Entry options + (for `all` only) the
--      legacy dimension options view.
--    * sources: active non-test legacy sources (for `all` only).
--
--    SECURITY DEFINER + fixed safe search_path.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_scoped_options(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_kind text := v_audience->>'audience';
  v_dimensions jsonb;
  v_sources jsonb;
begin
  select coalesce(jsonb_agg(opt order by opt->>'dimension', opt->>'key', opt->>'display'), '[]'::jsonb)
    into v_dimensions
    from (
      select jsonb_build_object(
               'dimension', d.dimension,
               'key', d.key,
               'display', d.display,
               'recruited_count', d.recruited_count
             ) as opt
        from public.direct_entry_reporting_de_options_scoped(
               p_auth_subject, p_app_user_id
             ) d

      union all

      select jsonb_build_object(
               'dimension', l.dimension,
               'key', l.key,
               'display', l.display,
               'recruited_count', l.recruited_count
             ) as opt
        from public.reporting_dimension_options_v01 l
       where v_kind = 'all'
    ) opts;

  if v_kind = 'all' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ds.id::text,
             'file_name', ds.file_name
           ) order by ds.file_name, ds.id::text), '[]'::jsonb)
      into v_sources
      from public.data_sources ds
     where ds.active
       and not ds.is_test;
  else
    v_sources := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'audience', v_audience,
    'dimensions', v_dimensions,
    'sources', v_sources
  );
end;
$$;

comment on function public.direct_entry_reporting_scoped_options(uuid, uuid) is
  'P3-W05A: actor-scoped filter options generated from the authorized row set. '
  'No out-of-scope dimension leaks.';

revoke all on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Seed effective team-scope grants for the seven TEAM_LEADER recruiters.
--
--    Source of truth: active HRP recruiters with personnel_position =
--    'TEAM_LEADER'. Each leader must have exactly one verified/effective
--    recruiter link to an enabled app user and exactly one effective active
--    team membership. No UUID / email is hard-coded; no new account or
--    recruiter is created; no `all` scope, no new capability, no entry_team
--    mutation authority is granted.
--
--    Fail closed (whole migration rolls back) on: leader count <> 7 when
--    leaders exist, missing/ambiguous link, missing/multiple team membership,
--    team inactive, or overlapping team-scope grant for a different team.
--
--    Idempotent: re-running never duplicates a grant.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_seed_team_scope_grants()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_leader_count integer;
  v_leader record;
  v_app_user_id uuid;
  v_link_count integer;
  v_team_id uuid;
  v_membership_count integer;
  v_existing_team uuid;
begin
  select count(*) into v_leader_count
    from public.recruiters r
   where r.active
     and r.personnel_position = 'TEAM_LEADER'
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.valid_from <= v_today
          and (m.valid_to is null or v_today < m.valid_to)
     );

  if v_leader_count = 0 then
    -- Fresh / empty DB: nothing to seed. Behavioral fixtures seed leaders
    -- separately and call this function directly.
    return;
  end if;

  if v_leader_count <> 7 then
    raise exception
      'team-scope seed refused: expected 7 active HRP team leaders, found %',
      v_leader_count;
  end if;

  for v_leader in
    select r.recruiter_id
      from public.recruiters r
     where r.active
       and r.personnel_position = 'TEAM_LEADER'
       and exists (
         select 1
           from public.recruiter_provider_memberships m
          where m.recruiter_id = r.recruiter_id
            and m.provider_type = 'hrp'
            and m.valid_from <= v_today
            and (m.valid_to is null or v_today < m.valid_to)
       )
     order by r.recruiter_id
  loop
    -- Exactly one verified/effective recruiter link.
    select count(*) into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = v_leader.recruiter_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to);

    if v_link_count <> 1 then
      raise exception
        'team-scope seed refused: leader % has % verified recruiter links (expected 1)',
        v_leader.recruiter_id, v_link_count;
    end if;

    select l.app_user_id into v_app_user_id
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users u
        on u.app_user_id = l.app_user_id
       and u.enabled
     where l.recruiter_id = v_leader.recruiter_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to);

    if v_app_user_id is null then
      raise exception
        'team-scope seed refused: leader % has no enabled linked app user',
        v_leader.recruiter_id;
    end if;

    -- Exactly one effective active team membership.
    select count(*) into v_membership_count
      from public.recruiter_team_memberships m
      join public.teams t
        on t.team_id = m.team_id
       and t.active
     where m.recruiter_id = v_leader.recruiter_id
       and m.valid_from <= v_today
       and (m.valid_to is null or v_today < m.valid_to);

    if v_membership_count <> 1 then
      raise exception
        'team-scope seed refused: leader % has % effective team memberships (expected 1)',
        v_leader.recruiter_id, v_membership_count;
    end if;

    select m.team_id into v_team_id
      from public.recruiter_team_memberships m
      join public.teams t
        on t.team_id = m.team_id
       and t.active
     where m.recruiter_id = v_leader.recruiter_id
       and m.valid_from <= v_today
       and (m.valid_to is null or v_today < m.valid_to);

    -- Overlap guard: any CURRENT effective team grant for this app user must
    -- target the same team (else refuse). Same team => idempotent skip.
    select g.team_id into v_existing_team
      from public.direct_entry_scope_grants g
     where g.app_user_id = v_app_user_id
       and g.scope_kind = 'team'
       and g.valid_from <= v_today
       and (g.valid_to is null or v_today < g.valid_to)
     limit 1;

    if v_existing_team is not null and v_existing_team <> v_team_id then
      raise exception
        'team-scope seed refused: app user % already has an effective team grant for a different team',
        v_app_user_id;
    end if;

    if v_existing_team is null then
      insert into public.direct_entry_scope_grants (
        app_user_id, scope_kind, team_id, valid_from
      ) values (
        v_app_user_id, 'team', v_team_id, v_today
      );
    end if;
  end loop;
end;
$$;

comment on function public.direct_entry_seed_team_scope_grants() is
  'P3-W05A: seed one effective team-scope grant per TEAM_LEADER recruiter. '
  'Idempotent and fail-closed (no overlap, no new accounts/capabilities).';

revoke all on function public.direct_entry_seed_team_scope_grants()
  from public, anon, authenticated;
grant execute on function public.direct_entry_seed_team_scope_grants()
  to service_role;

-- -----------------------------------------------------------------------------
-- In-migration self-check (structural; data-agnostic).
--
-- Asserts every new helper exists, is SECURITY DEFINER, is EXECUTE-able by
-- service_role and revoked from public/anon/authenticated.
-- -----------------------------------------------------------------------------
do $$
declare
  v_helper text;
  v_proc_secdef boolean;
begin
  for v_helper in
    select unnest(array[
        'public.direct_entry_reporting_resolve_audience(uuid, uuid)',
        'public.direct_entry_reporting_authorized_entries(uuid, uuid)',
        'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)',
        'public.direct_entry_reporting_de_options_scoped(uuid, uuid)',
        'public.direct_entry_reporting_scoped_options(uuid, uuid)',
        'public.direct_entry_seed_team_scope_grants()'
      ])
  loop
    select p.prosecdef into v_proc_secdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.oid = v_helper::regprocedure;

    if v_proc_secdef is null then
      raise exception 'W05A helper % not found in pg_proc', v_helper;
    end if;
    if not v_proc_secdef then
      raise exception 'W05A helper % must be SECURITY DEFINER', v_helper;
    end if;
    if has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W05A helper % must not be EXECUTE-able by anon', v_helper;
    end if;
    if has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W05A helper % must not be EXECUTE-able by authenticated', v_helper;
    end if;
    if not has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W05A helper % must be EXECUTE-able by service_role', v_helper;
    end if;
  end loop;

  raise notice 'P3-W05A migration #45 self-check OK (6 scoped helpers + seed)';
end
$$;

-- -----------------------------------------------------------------------------
-- Apply the team-scope seed at migration time. On a fresh/empty DB (0 leaders)
-- this no-ops; on a Production-shaped DB with 7 leaders it seeds one effective
-- team-scope grant per leader. Any wrong baseline (count <> 7, ambiguous link,
-- missing/multiple membership, inactive team, overlap) raises and rolls the
-- whole migration back.
-- -----------------------------------------------------------------------------
select public.direct_entry_seed_team_scope_grants();
