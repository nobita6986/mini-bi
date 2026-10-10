-- P3.1-HF - a duplicate canonical CMT/CCCD is reported, never blocked.
--
-- Verified defect: the P2.5-HF cohort made one canonical CCCD hold at most one live episode.
-- Importing, correcting or rehiring a legitimate second episode (another project, another
-- episode of the same person, a historical row) failed with a business error even though
-- nothing in the domain forbids it, and no screen could show which profiles are duplicated.
--
-- This migration is append-only. It does NOT edit #58/#59/#60/#61:
--   * the in-batch refusal inside direct_entry_create_full_profile_batch - the body every
--     full-profile path (v1, v2 and the unscoped v2 implementation) delegates to - is
--     replaced by a comment through the same prosrc technique #58 used;
--   * the public.direct_entries trigger direct_entry_active_episode_guard and its function
--     are DROPPED: two live episodes for one canonical CCCD are legitimate;
--   * direct_entry_guard_episode_status_event is re-created without the cross-episode
--     conflict; the append-only rule ("an OFF episode is never reopened without a supersede
--     marker") survives unchanged;
--   * every duplicate-CCCD raiser is gone from the public schema and no unique index on the
--     CCCD expression exists, so the storage layer cannot block a second episode either;
--   * format validation is untouched: 9/12 ASCII digits, leading zero preserved, the
--     canonicalization helpers, the worker_details validator and every TS contract stay
--     byte-stable.
-- It then adds the read-only duplicate report for the three authorized audiences:
--   * Full Admin (entry_admin + recruiter_master_manage + team_master_manage) at effective
--     all scope;
--   * catalog_master_manage (Admin / Accounting) at effective all scope;
--   * entry_privileged_edit (BoD) at effective all scope.
-- The report is masked (last 4 digits only), bounded (page size <= 100), deterministic
-- (stable order) and read-only: it never rewrites, merges or repairs a profile and it never
-- returns a raw entry/worker UUID. The writer-side duplicate contract of every caller
-- (repository, API and UI) is unchanged for every other code.

begin;

do $p3_1_hf$
declare
  v_source text;
begin
  -- ---------------------------------------------------------------------------
  -- 1. The one in-batch refusal on the full-profile write path.
  --
  -- direct_entry_create_full_profile_batch_v2 (and its unscoped H03 implementation)
  -- delegate to this body, so patching it here covers create, import, import v2 and
  -- the legacy batch in one place. #58 already relaxed the cross-episode check in
  -- this same body; this removes the in-batch check it deliberately left behind.
  -- ---------------------------------------------------------------------------
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
      raise exception 'P3.1-HF invalid source patch specification';
    end if;
    select replace(p.prosrc, chr(13), '') into v_source from pg_proc p where p.oid = p_signature;
    if v_source is null then
      raise exception 'P3.1-HF source function not found: %', p_signature;
    end if;
    -- PostgreSQL preserves the producing migration's line endings in prosrc, and a
    -- Windows checkout may materialise this file with CRLF as well. Stripping every
    -- carriage return from both sides makes the fragment match in either case,
    -- exactly like the #61 helper does.
    v_expected := replace(p_expected, chr(13), '');
    v_replacement := replace(p_replacement, chr(13), '');
    v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
    if v_count <> p_expected_count then
      raise exception 'P3.1-HF expected % exact source fragment(s), found % in %, starting with: %',
        p_expected_count, v_count, p_signature, left(v_expected, 96);
    end if;
    v_next := replace(v_source, v_expected, v_replacement);
    select replace(pg_get_functiondef(p.oid), chr(13), '') into v_definition
      from pg_proc p where p.oid = p_signature;
    if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
      raise exception 'P3.1-HF could not reconstruct function definition: %', p_signature;
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
    ) then
      raise exception 'P3.1-HF changed function security boundary: %', p_signature;
    end if;
  end;
  $$;
  revoke all on function public.direct_entry_hf_replace_proc_source(regprocedure,text,text,integer)
    from public, anon, authenticated, service_role;

  perform public.direct_entry_hf_replace_proc_source(
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
    $old$
      if v_national_id = any(v_national_ids) then
        raise exception 'NATIONAL_ID_DUPLICATE' using errcode = '22023';
      end if;
      -- P2.5-HF: a repeated CCCD is a REHIRE, not a duplicate. The row guard on
      -- direct_entries refuses it 23505 unless every earlier episode is OFF; the
      -- in-batch duplicate check above stays.$old$,
    $new$
      -- P3.1-HF: a canonical CCCD repeated inside one batch is a second episode for
      -- the same worker, exactly like a rehire, so this refusal is gone. The
      -- cross-episode refusal #58 relaxed is gone too; only the format validation
      -- above (direct_entry_valid_worker_details) remains on this write path.$new$,
    1
  );

  -- ---------------------------------------------------------------------------
  -- 2. The row guard on public.direct_entries: dropped, never replaced.
  --
  -- direct_entry_guard_active_episode() raised NATIONAL_ID_DUPLICATE (23505) whenever a
  -- non-OFF episode already existed for the canonical CCCD of the row being written, so
  -- create, import, rehire AND the privileged correction of a second episode failed even
  -- after the source patch above. Nothing replaces it: episode identity is entry_id, never
  -- the CCCD, and the report built below is what surfaces a duplicate to the business.
  -- ---------------------------------------------------------------------------
  drop trigger if exists direct_entry_active_episode_guard on public.direct_entries;
  drop function if exists public.direct_entry_guard_active_episode();

  -- ---------------------------------------------------------------------------
  -- 3. The status-event guard keeps only its append-only lifecycle rule.
  --
  -- Same body #59/#60 installed, minus the canonical-CCCD variables, the advisory
  -- lock and the conflict raise. The reopen rule cannot regress into the removed
  -- null shortcut: v_own_latest is now fetched for every non-OFF event.
  -- ---------------------------------------------------------------------------
  create or replace function public.direct_entry_guard_episode_status_event()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $guard$
  declare
    v_own_latest text;
  begin
    if new.status = 'OFF' then
      return new;
    end if;

    select (
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = new.entry_id
              order by st.version desc
              limit 1
           )
      into v_own_latest
      from public.direct_entries e
     where e.entry_id = new.entry_id;

    -- P3.1-HF: the cross-episode canonical-CCCD conflict raise was removed here.
    -- Two live episodes for one canonical CCCD are legitimate, so this
    -- trigger only enforces the append-only rule it always owned: an episode whose latest
    -- event is OFF is never reopened except by a superseding event.
    if v_own_latest = 'OFF' and new.supersedes_event_id is null then
      raise exception 'worker_episode_reopen_forbidden' using errcode = '23505';
    end if;

    return new;
  end;
  $guard$;
  revoke all on function public.direct_entry_guard_episode_status_event()
    from public, anon, authenticated, service_role;
  comment on function public.direct_entry_guard_episode_status_event() is
    'P3.1-HF: append-only lifecycle guard for direct_entry_employment_status_events. A non-OFF event on an entry whose latest event is OFF needs a supersede marker. The cross-episode canonical-CCCD conflict was removed with the duplicate-CCCD hotfix: duplicate canonical CCCDs are reported, never blocked. The message carries no CCCD and no other profile value.';

  -- ---------------------------------------------------------------------------
  -- 4. Who may read the duplicate report: three audiences, all scope, no more.
  --
  -- Same shape as direct_entry_assert_catalog_operator (#P3.1-W01B):
  --   * actor mapping first, so unmapped, mismatched or disabled actors never reach
  --     a capability decision and never see a partial answer;
  --   * the legacy Full Admin bundle (entry_admin + recruiter_master_manage +
  --     team_master_manage) at effective all scope;
  --   * catalog_master_manage (Admin / Accounting) at effective all scope;
  --   * entry_privileged_edit (BoD) at effective all scope.
  -- entry_admin alone, change_review, a leader/PM capability, a role or an email
  -- never open it, and no team/own scope substitutes for 'all'.
  -- ---------------------------------------------------------------------------
  create or replace function public.direct_entry_assert_duplicate_cccd_reader(
    p_auth_subject uuid,
    p_app_user_id uuid
  )
  returns text
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  as $reader$
  declare
    v_today date := public.direct_entry_authorization_date();
    v_full_admin boolean;
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

    v_full_admin :=
      public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
      and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
      and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

    if not v_full_admin
       and not public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage')
       and not public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit') then
      raise exception 'duplicate cccd report denied' using errcode = '42501';
    end if;

    if not exists (
      select 1 from public.direct_entry_scope_grants s
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'all'
         and s.valid_from <= v_today
         and (s.valid_to is null or v_today < s.valid_to)
    ) then
      raise exception 'duplicate cccd report requires all scope' using errcode = '42501';
    end if;

    if v_full_admin then
      return 'entry_admin';
    end if;
    if public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage') then
      return 'catalog_master_manage';
    end if;
    return 'entry_privileged_edit';
  end;
  $reader$;
  revoke all on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid)
    from public, anon, authenticated, service_role;
  comment on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid) is
    'P3.1-HF internal guard for the duplicate-CCCD report: actor mapping + (legacy Full Admin triple OR catalog_master_manage OR entry_privileged_edit) + effective all scope. Returns the authority actually used (entry_admin, catalog_master_manage or entry_privileged_edit) for audit. Revoked from every role; entry_admin@all alone, change_review, leader/PM and every unmapped actor are denied.';

  -- ---------------------------------------------------------------------------
  -- 5. The read-only, masked, bounded duplicate report.
  --
  -- Read-only by construction: one SELECT, no advisory lock, no write, no merge and
  -- no repair. Masking: only the last four digits of the canonical CCCD leave the
  -- database, together with its business length; the entry/worker UUIDs never do.
  -- Bounding: page_size <= 100 and page <= 1000, so the offset stays <= 100,000.
  -- Determinism: groups are ordered by canonical digits and episodes by
  -- first_work_date then entry_id (ordering only - entry_id is never emitted).
  -- Scope of the scan: every non-deleted direct_entries row whose national_id state
  -- is 'provided', across every project, every episode and every historical row.
  -- ---------------------------------------------------------------------------
  create or replace function public.direct_entry_duplicate_cccd_report(
    p_auth_subject uuid,
    p_app_user_id uuid,
    p_page integer default 1,
    p_page_size integer default 25
  )
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  as $report$
  declare
    v_authority text;
    v_page integer := coalesce(p_page, 1);
    v_page_size integer := coalesce(p_page_size, 25);
    v_offset integer;
    v_total_groups integer := 0;
    v_total_entries integer := 0;
    v_rows jsonb;
    v_has_more boolean := false;
    v_groups jsonb;
  begin
    if v_page < 1 or v_page > 1000 then
      raise exception 'duplicate_report_page_invalid' using errcode = '22023';
    end if;
    if v_page_size < 1 or v_page_size > 100 then
      raise exception 'duplicate_report_page_size_invalid' using errcode = '22023';
    end if;
    v_offset := (v_page - 1) * v_page_size;

    -- Authority before any read: an unauthorized actor never receives an empty page
    -- that would otherwise look like "no duplicates".
    v_authority :=
      public.direct_entry_assert_duplicate_cccd_reader(p_auth_subject, p_app_user_id);

    with canonical as (
      select e.entry_id,
             e.project_id,
             e.employee_code,
             e.first_work_date,
             nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
             public.direct_entry_canonical_national_id(
               e.worker_details->'national_id'->>'value'
             ) as cccd
        from public.direct_entries e
       where e.deleted_at is null
         and e.worker_details->'national_id'->>'state' = 'provided'
    ),
    live as (
      select c.entry_id,
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
    ),
    grouped as (
      select l.cccd,
             count(*)::int as profile_count,
             count(distinct l.project_id)::int as project_count,
             count(*) filter (where l.latest_status <> 'OFF')::int as active_profile_count,
             min(l.first_work_date) as earliest_first_work_date,
             max(l.first_work_date) as latest_first_work_date
        from live l
       group by l.cccd
       -- One occurrence is a normal profile; only two or more are a duplicate.
      having count(*) >= 2
    ),
    page_groups as (
      select g.*
        from grouped g
       order by g.cccd
       limit v_page_size + 1
      offset v_offset
    )

    select coalesce((select count(*)::int from grouped), 0),
           coalesce((select sum(g.profile_count)::int from grouped g), 0),
           coalesce((
             select jsonb_agg(gp.row_json order by gp.cccd)
               from (
                 select pg.cccd,
                        jsonb_build_object(
                          'cccd_last4', right(pg.cccd, 4),
                          'cccd_length', length(pg.cccd),
                          'profile_count', pg.profile_count,
                          'project_count', pg.project_count,
                          'active_profile_count', pg.active_profile_count,
                          'first_work_date',
                            pg_catalog.to_char(pg.earliest_first_work_date, 'YYYY-MM-DD'),
                          'latest_first_work_date',
                            pg_catalog.to_char(pg.latest_first_work_date, 'YYYY-MM-DD'),
                          'episodes', coalesce((
                            select jsonb_agg(jsonb_build_object(
                                     'employee_code', l.employee_code,
                                     'display_name', l.display_name,
                                     'project_id', l.project_id,
                                     'project_display', pj.display_name,
                                     'first_work_date',
                                       pg_catalog.to_char(l.first_work_date, 'YYYY-MM-DD'),
                                     'latest_status', l.latest_status,
                                     'active', l.latest_status <> 'OFF'
                                   ) order by l.first_work_date asc, l.entry_id asc)
                              from live l
                              left join public.direct_entry_projects pj
                                on pj.project_id = l.project_id
                             where l.cccd = pg.cccd
                          ), '[]'::jsonb)
                        ) as row_json
                   from page_groups pg
               ) gp
           ), '[]'::jsonb)
      into v_total_groups, v_total_entries, v_rows;

    v_has_more := jsonb_array_length(v_rows) > v_page_size;
    if v_has_more then
      select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
        into v_groups
        from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
       where t.ord <= v_page_size;
    else
      v_groups := v_rows;
    end if;

    return jsonb_build_object(
      'authority', v_authority,
      'authorization_date', public.direct_entry_authorization_date(),
      'page', v_page,
      'page_size', v_page_size,
      'total_groups', v_total_groups,
      'total_entries', v_total_entries,
      'has_more', v_has_more,
      'groups', v_groups
    );
  end;
  $report$;
  revoke all on function public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer)
    from public, anon, authenticated, service_role;
  grant execute on function public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer)
    to service_role;
  comment on function public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer) is
    'P3.1-HF read-only duplicate-CCCD report for Full Admin, catalog_master_manage and entry_privileged_edit at all scope. Groups every canonical CCCD (9 or 12 ASCII digits, legacy formatting normalized) that appears on two or more non-deleted ''provided'' profiles, across projects and episodes, and returns the last four digits only - never a raw CCCD and never an entry/worker UUID. Bounded to page_size <= 100 and page <= 1000, ordered deterministically, and it never writes, merges or repairs a profile.';

  -- ---------------------------------------------------------------------------
  -- 6. Install-time self-check (data free: this migration must install on an empty
  -- database and on production alike).
  -- ---------------------------------------------------------------------------
  -- 6a. The full-profile writer: format validation and the per-row creation
  -- authority survive; no duplicate-CCCD refusal is left on that body.
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  if v_source is null then
    raise exception 'P3.1-HF the full-profile batch body is missing';
  end if;
  if position('NATIONAL_ID_DUPLICATE' in v_source) > 0 then
    raise exception 'P3.1-HF an in-batch duplicate-CCCD refusal survived';
  end if;
  if position('direct_entry_valid_worker_details' in v_source) = 0 then
    raise exception 'P3.1-HF the CCCD format validation was lost';
  end if;
  if position('direct_entry_create_authority' in v_source) = 0 then
    raise exception 'P3.1-HF the per-row creation authority was lost';
  end if;

  -- 6b. The guards: the create-time guard is gone for good, no trigger on
  -- direct_entries can raise a duplicate-CCCD error any more, the status guard keeps
  -- its append-only rule, and no unique CCCD index blocks a second episode.
  if to_regprocedure('public.direct_entry_guard_active_episode()') is not null then
    raise exception 'P3.1-HF the create-time duplicate guard still exists';
  end if;
  if exists (
    select 1 from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.direct_entries'::regclass
       and not t.tgisinternal
       and (p.prosrc like '%NATIONAL_ID_DUPLICATE%'
            or p.prosrc like '%worker_active_episode_exists%')
  ) then
    raise exception 'P3.1-HF a duplicate-CCCD refusal still fires on public.direct_entries';
  end if;
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_guard_episode_status_event()'::regprocedure;
  if v_source is null or position('worker_episode_reopen_forbidden' in v_source) = 0 then
    raise exception 'P3.1-HF the append-only episode reopen rule was lost';
  end if;
  if exists (
    select 1 from pg_index i
     where i.indrelid = 'public.direct_entries'::regclass
       and i.indisunique
       and i.indexprs is not null
       and pg_get_indexdef(i.indexrelid) like '%national_id%'
  ) then
    raise exception 'P3.1-HF a unique CCCD index still blocks a second episode';
  end if;

  -- 6c. The shared canonical rule is byte-stable: digits only, 9 or 12 characters,
  -- leading zero preserved, formatting characters normalized.
  if to_regprocedure('public.direct_entry_canonical_national_id(text)') is null
     or to_regprocedure('public.direct_entry_is_canonical_national_id(text)') is null
     or to_regprocedure('public.direct_entry_national_id_lock_key(text)') is null then
    raise exception 'P3.1-HF a shared canonical-CCCD helper was dropped';
  end if;
  if public.direct_entry_canonical_national_id('012 345 678 901') <> '012345678901'
     or public.direct_entry_canonical_national_id('012.345.678') <> '012345678'
     or public.direct_entry_canonical_national_id('abcd') is not null
     or not public.direct_entry_is_canonical_national_id('012345678901')
     or not public.direct_entry_is_canonical_national_id('012345678')
     or public.direct_entry_is_canonical_national_id('12345678')
     or public.direct_entry_is_canonical_national_id('0123456789012') then
    raise exception 'P3.1-HF the canonical-CCCD rule changed';
  end if;

  -- 6d. The report is read-only, bounded, masked and reachable by service_role only.
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure;
  if v_source is null then
    raise exception 'P3.1-HF the duplicate report function is missing';
  end if;
  if v_source ~* '(insert into|update public|delete from|for update|advisory_xact_lock|truncate)' then
    raise exception 'P3.1-HF the duplicate report is not read-only';
  end if;
  if position('right(' in v_source) = 0
     or position(chr(39) || 'cccd_last4' || chr(39) in v_source) = 0 then
    raise exception 'P3.1-HF the duplicate report does not mask the CCCD';
  end if;
  if position(chr(39) || 'entry_id' || chr(39) in v_source) > 0
     or position(chr(39) || 'worker_id' || chr(39) in v_source) > 0
     or position(chr(39) || 'recruiter_id' || chr(39) in v_source) > 0 then
    raise exception 'P3.1-HF the duplicate report projects a raw UUID';
  end if;
  if position('duplicate_report_page_size_invalid' in v_source) = 0
     or position('duplicate_report_page_invalid' in v_source) = 0 then
    raise exception 'P3.1-HF the duplicate report is not bounded';
  end if;
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3.1-HF the duplicate report security boundary is wrong';
  end if;

  -- 6e. The report refuses an unmapped actor before it reads anything, so an
  -- unauthorized caller can never mistake a denial for "no duplicates".
  begin
    perform public.direct_entry_duplicate_cccd_report(
      '00000000-0000-4000-8000-0000000000a1'::uuid,
      '00000000-0000-4000-8000-0000000000a2'::uuid,
      1,
      25
    );
    raise exception 'P3.1-HF the duplicate report accepted an unmapped actor';
  exception
    when others then
      if position('P3.1-HF' in sqlerrm) > 0 then
        raise;
      end if;
  end;
end;
$p3_1_hf$;

-- The report is a read surface beside the worker directory: its ACL is fixed above
-- (revoked from public/anon/authenticated, granted to service_role) and the masked
-- projection is the only CCCD information it can emit. No writer-side contract, TS
-- type, API route or UI contract is changed by this migration.
commit;
