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
-- returns a raw entry/worker UUID.
--
-- P3.1-HF-R1 extends this same migration (still unmerged and unapplied) with the ONE place
-- where a duplicate is surfaced to the user: the DRAFT -> REVIEW transition.
--   * every save path (create, update, paste, import, full profile, autosave, save draft,
--     rehire) stays completely silent about duplicates: nothing was added there;
--   * public.direct_entry_submission_duplicate_cccd_preflight(auth, app, submission) is a
--     read-only, stable RPC that reports the masked, bounded and deterministic conflict set
--     of that draft plus a fingerprint that is derived from immutable entry ids and the
--     canonical latest employment status only - never from a CCCD, a name or a project;
--   * public.direct_entry_transition_submission_duplicate_cccd_confirmed(...) re-derives the
--     set inside the transition transaction, compares it with the acknowledgement the client
--     echoed back and only then applies DRAFT -> REVIEW. A stale, forged or missing
--     acknowledgement raises before any write, so the submission stays DRAFT with no audit
--     event, no revision, no version bump and no idempotency row;
--   * public.direct_entry_transition_submission keeps its six-argument signature and its
--     behaviour for every other transition (REVIEW -> DRAFT, REVIEW -> SUBMITTED, DRAFT ->
--     DRAFT no-op), but the DRAFT -> REVIEW it performs now refuses while a conflict exists,
--     so no caller, legacy overload or direct RPC call can bypass the acknowledgement.
-- The conflict predicate is the canonical one: latest status of the other episode by
-- version desc, `coalesce(..., 'UNCONFIRMED')`, kept only when it is ON or UNCONFIRMED, so an
-- OFF episode is never reported. Same project, same recruiter, same team, the same submission
-- and the same first work date are all irrelevant: only the canonical CCCD and the immutable
-- entry id decide, the row itself is excluded by entry id, and a soft-deleted or non-canonical
-- national id is never a conflict.

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

-- ---------------------------------------------------------------------------
-- 7. P3.1-HF-R1 - the duplicate-CCCD acknowledgement on DRAFT -> REVIEW.
--
-- 7a. One source of truth for "which existing profiles does this draft conflict with".
--
-- Read-only, stable and internal: it is revoked from every role at the end of this
-- section and only the two public entry points below (both revoked from clients)
-- call it. The fingerprint hashes immutable entry ids plus the canonical latest
-- status only, so it carries no CCCD, no name, no project and no UUID; the
-- projection is masked to the last four digits and bounded to 20 conflicts.
-- ---------------------------------------------------------------------------
do $p3_1_hf_confirmation$
declare
  v_source text;
begin
  create or replace function public.direct_entry_submission_duplicate_cccd_state(
    p_submission_id uuid
  )
  returns jsonb
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $state$
    with draft as (
      select e.entry_id,
             e.first_work_date,
             nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
             public.direct_entry_canonical_national_id(
               e.worker_details->'national_id'->>'value'
             ) as cccd
        from public.direct_entries e
       where e.submission_id = p_submission_id
         and e.deleted_at is null
         and e.worker_details->'national_id'->>'state' = 'provided'
    ),
    conflicting as (
      select d.entry_id as draft_entry_id,
             d.display_name as draft_display_name,
             d.first_work_date as draft_first_work_date,
             o.entry_id as other_entry_id,
             o.first_work_date as other_first_work_date,
             o.project_id as other_project_id,
             public.direct_entry_canonical_national_id(
               o.worker_details->'national_id'->>'value'
             ) as other_cccd,
             coalesce((
               select st.status
                 from public.direct_entry_employment_status_events st
                where st.entry_id = o.entry_id
                order by st.version desc
                limit 1
             ), 'UNCONFIRMED') as latest_status
        from draft d
        join public.direct_entries o
          on o.deleted_at is null
         and o.entry_id <> d.entry_id
         and o.worker_details->'national_id'->>'state' = 'provided'
         and public.direct_entry_canonical_national_id(
               o.worker_details->'national_id'->>'value'
             ) = d.cccd
       where public.direct_entry_is_canonical_national_id(d.cccd)
    ),
    live_conflict as (
      select c.*
        from conflicting c
       where c.latest_status in ('ON', 'UNCONFIRMED')
    ),
    ordered as (
      select c.*,
             left(encode(sha256(convert_to(
               c.draft_entry_id::text || ':' || c.other_entry_id::text, 'UTF8'
             )), 'hex'), 12) as conflict_ref
        from live_conflict c
    )
    select jsonb_build_object(
      'conflict_count', (select count(*)::int from ordered),
      'fingerprint', encode(sha256(convert_to(coalesce((
        select string_agg(
                 o.draft_entry_id::text || '|' || o.other_entry_id::text || '|' || o.latest_status,
                 ','
                 order by o.draft_entry_id, o.other_entry_id, o.latest_status
               )
          from ordered o
      ), ''), 'UTF8')), 'hex'),
      'conflicts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'conflict_ref', i.conflict_ref,
                 'draft_display_name', i.draft_display_name,
                 'project_display', i.project_display,
                 'employment_status', i.latest_status,
                 'cccd_last4', i.cccd_last4
               ) order by i.draft_first_work_date, i.draft_entry_id,
                          i.other_first_work_date, i.other_entry_id)
          from (
            select o.draft_entry_id,
                   o.other_entry_id,
                   o.draft_first_work_date,
                   o.other_first_work_date,
                   o.conflict_ref,
                   o.draft_display_name,
                   o.latest_status,
                   right(o.other_cccd, 4) as cccd_last4,
                   pj.display_name as project_display
              from ordered o
              left join public.direct_entry_projects pj on pj.project_id = o.other_project_id
             order by o.draft_first_work_date, o.draft_entry_id,
                      o.other_first_work_date, o.other_entry_id
             limit 20
          ) i
      ), '[]'::jsonb)
    );
  $state$;
  revoke all on function public.direct_entry_submission_duplicate_cccd_state(uuid)
    from public, anon, authenticated, service_role;
  comment on function public.direct_entry_submission_duplicate_cccd_state(uuid) is
    'P3.1-HF-R1 internal (revoked from every role): the canonical duplicate-CCCD conflict set of one draft submission. Matches on the canonical national id of the draft entries against every other non-deleted provided profile - across projects, recruiters, teams, submissions and episodes - keeping only profiles whose latest employment status event (order by version desc) is ON or UNCONFIRMED, with a missing event falling back to UNCONFIRMED as the canonical storage default; OFF profiles are never reported. The row itself is excluded by immutable entry id, the projection is masked (cccd_last4) and bounded (20 items) and the deterministic fingerprint is built from entry ids and status only.';

  -- -------------------------------------------------------------------------
  -- 7b. The preflight: read-only, bounded, deterministic - it never mutates.
  --
  -- Exactly the authority of the transition it precedes: actor mapping, the
  -- submission creator and one live own scope grant. An unauthorized actor is
  -- refused before the conflict set is read, so a denial can never be mistaken
  -- for "no conflict", and only a DRAFT submission is ever inspected.
  -- -------------------------------------------------------------------------
  create or replace function public.direct_entry_submission_duplicate_cccd_preflight(
    p_auth_subject uuid,
    p_app_user_id uuid,
    p_submission_id uuid
  )
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  as $preflight$
  declare
    v_submission public.direct_entry_submissions%rowtype;
    v_own_scope_count integer;
    v_state jsonb;
  begin
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
    select * into v_submission
      from public.direct_entry_submissions
     where submission_id = p_submission_id;
    if not found then
      raise exception 'submission not found' using errcode = 'P0002';
    end if;
    if v_submission.created_by_user_id <> p_app_user_id then
      raise exception 'submission scope denied' using errcode = '42501';
    end if;
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    if v_submission.state <> 'DRAFT' then
      raise exception 'submission is not a draft' using errcode = '22023';
    end if;

    v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'version', v_submission.version,
      'fingerprint', v_state->'fingerprint',
      'conflict_count', v_state->'conflict_count',
      'conflicts', v_state->'conflicts'
    );
  end;
  $preflight$;
  revoke all on function public.direct_entry_submission_duplicate_cccd_preflight(uuid, uuid, uuid)
    from public, anon, authenticated, service_role;
  grant execute on function public.direct_entry_submission_duplicate_cccd_preflight(uuid, uuid, uuid)
    to service_role;
  comment on function public.direct_entry_submission_duplicate_cccd_preflight(uuid, uuid, uuid) is
    'P3.1-HF-R1 read-only preflight for DRAFT -> REVIEW: same actor/creator/own-scope authority as direct_entry_transition_submission, then the masked conflict set of that draft (last four digits, at most 20 items, deterministic order) plus the authoritative submission version and the acknowledgement fingerprint. It writes nothing: no audit event, no revision, no version bump and no idempotency row.';

  -- -------------------------------------------------------------------------
  -- 7c. The one transition body. Both public entry points delegate to it.
  --
  -- direct_entry_transition_submission (six arguments, signature unchanged)
  -- passes a null acknowledgement, so the DRAFT -> REVIEW it performs raises
  -- 22023 'duplicate cccd acknowledgement required' while a conflict exists: the
  -- legacy signature and every legacy overload are structurally unable to bypass
  -- the acknowledgement. direct_entry_transition_submission_duplicate_cccd_confirmed
  -- passes the values the client echoed back, which are compared against the
  -- conflict set re-derived INSIDE this transaction and after the submission row
  -- lock, so a stale, forged or missing acknowledgement raises before any write.
  -- Everything else - actor mapping, creator, own scope, OCC, no-op guard,
  -- non-empty guard, revision, audit and idempotency - is the body that was
  -- already installed, byte for byte.
  -- -------------------------------------------------------------------------
  create or replace function public.direct_entry_transition_submission_apply(
    p_auth_subject uuid,
    p_app_user_id uuid,
    p_submission_id uuid,
    p_expected_version integer,
    p_target_state text,
    p_idempotency_key text,
    p_ack_fingerprint text,
    p_ack_conflict_count integer
  )
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $apply$
  declare
    v_submission public.direct_entry_submissions%rowtype;
    v_own_scope_count integer;
    v_prior_result jsonb;
    v_result jsonb;
    v_request_hash text;
    v_reason_id uuid;
    v_submission_revision_id uuid;
    v_before jsonb;
    v_state jsonb;
    v_conflict_count integer;
    v_acknowledged boolean := false;
  begin
    if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
      raise exception 'invalid idempotency key' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
    select * into v_submission
      from public.direct_entry_submissions
     where submission_id = p_submission_id
     for update;
    if not found then
      raise exception 'submission not found' using errcode = 'P0002';
    end if;
    if v_submission.created_by_user_id <> p_app_user_id then
      raise exception 'submission scope denied' using errcode = '42501';
    end if;
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_request_hash := encode(
      sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
      'hex'
    );
    v_prior_result := public.direct_entry_idempotency_begin(
      p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
    );
    if v_prior_result is not null then return v_prior_result; end if;
    if p_expected_version is null or p_expected_version <> v_submission.version then
      raise exception 'submission version conflict' using errcode = '40001';
    end if;
    if p_target_state = v_submission.state then
      raise exception 'submission transition cannot be a no-op' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ) then
      raise exception 'submission must contain at least one entry' using errcode = '23514';
    end if;

    -- P3.1-HF-R1: only DRAFT -> REVIEW is gated, and only while a conflict exists.
    -- The conflict set is re-derived here, inside the transition transaction and after
    -- the submission row lock, so the acknowledgement can never be replayed against a
    -- different set. A missing, stale or forged acknowledgement raises 22023 before the
    -- first write: the submission stays DRAFT, the version is untouched, no revision and
    -- no APPLIED audit event are written and the idempotency row of this call is rolled
    -- back with the rest of the transaction.
    if v_submission.state = 'DRAFT' and p_target_state = 'REVIEW' then
      v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
      v_conflict_count := (v_state->>'conflict_count')::int;
      if v_conflict_count > 0 then
        if p_ack_fingerprint is null
           or p_ack_fingerprint <> (v_state->>'fingerprint')
           or p_ack_conflict_count is null
           or p_ack_conflict_count <> v_conflict_count then
          raise exception 'duplicate cccd acknowledgement required' using errcode = '22023';
        end if;
        v_acknowledged := true;
      end if;
    end if;
    v_before := jsonb_build_object(
      'state', v_submission.state, 'version', v_submission.version,
      'submitted_at', v_submission.submitted_at
    );
    update public.direct_entry_submissions
       set state = p_target_state,
           version = version + 1
     where submission_id = p_submission_id;
    -- The acknowledgement is recorded as a short code plus the conflict count and twelve
    -- fingerprint characters only: never a CCCD, a worker name, a project name or the
    -- conflict projection itself.
    v_reason_id := public.direct_entry_reason(
      p_app_user_id,
      case
        when v_acknowledged then
          'Submission state transition (duplicate CCCD acknowledged x'
            || v_conflict_count::text || ' fp=' || left(p_ack_fingerprint, 12) || ')'
        else 'Submission state transition'
      end
    );
    insert into public.direct_entry_submission_revisions (
      submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
    ) values (
      p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
      jsonb_build_object(
        'state', p_target_state, 'version', v_submission.version + 1,
        'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
      )
    ) returning revision_id into v_submission_revision_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
      p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
      v_submission_revision_id,
      array['state', 'version']
    );
    v_result := jsonb_build_object(
      'submission_id', p_submission_id,
      'state', p_target_state,
      'version', v_submission.version + 1
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'submission_transition', p_idempotency_key, v_result
    );
    return v_result;
  end;
  $apply$;
  revoke all on function public.direct_entry_transition_submission_apply(
    uuid, uuid, uuid, integer, text, text, text, integer
  ) from public, anon, authenticated, service_role;
  comment on function public.direct_entry_transition_submission_apply(
    uuid, uuid, uuid, integer, text, text, text, integer
  ) is
    'P3.1-HF-R1 internal (revoked from every role): the single transition body behind both public entry points. It keeps the actor/creator/own-scope authority, OCC, no-op guard, non-empty guard, revision, APPLIED audit and idempotency of the previous body, and adds one rule - DRAFT -> REVIEW is refused with 22023 while the canonical duplicate-CCCD conflict set of the draft is non-empty and the acknowledgement (fingerprint plus count) does not match the set re-derived inside this transaction.';

  -- -------------------------------------------------------------------------
  -- 7d. The two public entry points.
  --
  -- The legacy signature is re-created as a thin wrapper over the body above: same
  -- name, same six arguments, same ACL, so no existing caller changes - while the
  -- DRAFT -> REVIEW it performs now honours the acknowledgement rule, which is why
  -- no legacy caller, overload or direct RPC call can bypass it. The confirmed
  -- entry point only accepts a REVIEW target plus a well-formed acknowledgement and
  -- hands the same body those values.
  -- -------------------------------------------------------------------------
  create or replace function public.direct_entry_transition_submission(
    p_auth_subject uuid,
    p_app_user_id uuid,
    p_submission_id uuid,
    p_expected_version integer,
    p_target_state text,
    p_idempotency_key text
  )
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $legacy$
  begin
    return public.direct_entry_transition_submission_apply(
      p_auth_subject, p_app_user_id, p_submission_id, p_expected_version,
      p_target_state, p_idempotency_key, null, null
    );
  end;
  $legacy$;
  revoke all on function public.direct_entry_transition_submission(
    uuid, uuid, uuid, integer, text, text
  ) from public, anon, authenticated, service_role;
  grant execute on function public.direct_entry_transition_submission(
    uuid, uuid, uuid, integer, text, text
  ) to service_role;

  create or replace function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
    p_auth_subject uuid,
    p_app_user_id uuid,
    p_submission_id uuid,
    p_expected_version integer,
    p_target_state text,
    p_idempotency_key text,
    p_ack_fingerprint text,
    p_ack_conflict_count integer
  )
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $confirmed$
  declare
    v_result jsonb;
  begin
    if p_target_state is distinct from 'REVIEW' then
      raise exception 'duplicate cccd acknowledgement needs the review target'
        using errcode = '22023';
    end if;
    if p_ack_fingerprint is null or p_ack_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'duplicate cccd acknowledgement is malformed' using errcode = '22023';
    end if;
    if p_ack_conflict_count is null or p_ack_conflict_count < 1
       or p_ack_conflict_count > 1000 then
      raise exception 'duplicate cccd acknowledgement is malformed' using errcode = '22023';
    end if;
    v_result := public.direct_entry_transition_submission_apply(
      p_auth_subject, p_app_user_id, p_submission_id, p_expected_version,
      p_target_state, p_idempotency_key, p_ack_fingerprint, p_ack_conflict_count
    );
    return jsonb_build_object('status', 'applied') || v_result;
  end;
  $confirmed$;
  revoke all on function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
    uuid, uuid, uuid, integer, text, text, text, integer
  ) from public, anon, authenticated, service_role;
  grant execute on function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
    uuid, uuid, uuid, integer, text, text, text, integer
  ) to service_role;
  comment on function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
    uuid, uuid, uuid, integer, text, text, text, integer
  ) is
    'P3.1-HF-R1 entry point for a DRAFT -> REVIEW the user acknowledged: REVIEW target only, fingerprint must be 64 lowercase hex characters and the count must be at least one, then the internal body re-derives the conflict set and compares it with the acknowledgement before it writes. Returns {status: applied, submission_id, state, version}. It grants no authority the legacy signature did not grant: actor, creator, own scope, OCC and idempotency all stay enforced by the body.';

  -- -------------------------------------------------------------------------
  -- 7e. Install-time self-check (data free: this migration installs on an empty
  -- database and on production alike).
  -- -------------------------------------------------------------------------
  -- 7e-1. The internal state helper: source of truth, read-only, masked, bounded,
  -- self-exclusion by immutable entry id, and unreachable from every client role.
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_submission_duplicate_cccd_state(uuid)'::regprocedure;
  if v_source is null then
    raise exception 'P3.1-HF-R1 the duplicate conflict state function is missing';
  end if;
  if v_source ~* '(insert into|update public|delete from|for update|advisory_xact_lock|truncate)' then
    raise exception 'P3.1-HF-R1 the duplicate conflict state function is not read-only';
  end if;
  if position('right(' in v_source) = 0
     or position(chr(39) || 'cccd_last4' || chr(39) in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the duplicate conflict set is not masked';
  end if;
  if position(chr(39) || 'entry_id' || chr(39) in v_source) > 0
     or position(chr(39) || 'worker_id' || chr(39) in v_source) > 0 then
    raise exception 'P3.1-HF-R1 the duplicate conflict set projects a raw UUID';
  end if;
  if position('entry_id <> d.entry_id' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the duplicate conflict set does not exclude the row itself';
  end if;
  if position('order by st.version desc' in v_source) = 0
     or position('in (''ON'', ''UNCONFIRMED'')' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the canonical latest-status predicate changed';
  end if;
  if position('), ''UNCONFIRMED'')' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the missing-status fallback is not UNCONFIRMED';
  end if;
  if coalesce((
    select p.provolatile from pg_proc p
     where p.oid = 'public.direct_entry_submission_duplicate_cccd_state(uuid)'::regprocedure
  ), 'v') <> 's' then
    raise exception 'P3.1-HF-R1 the duplicate conflict state function is not STABLE';
  end if;
  if exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_submission_duplicate_cccd_state(uuid)'::regprocedure
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) then
    raise exception 'P3.1-HF-R1 the duplicate conflict state function is reachable from a client role';
  end if;

  -- 7e-2. Both public entry points exist, are definers with a pinned search_path,
  -- and only service_role may call them; the internal body stays unreachable.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)'::regprocedure
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
    raise exception 'P3.1-HF-R1 the duplicate preflight security boundary is wrong';
  end if;
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_transition_submission_duplicate_cccd_confirmed(uuid,uuid,uuid,integer,text,text,text,integer)'::regprocedure
       and p.prosecdef
       and p.provolatile = 'v'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'P3.1-HF-R1 the confirmed transition security boundary is wrong';
  end if;
  if exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)'::regprocedure
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) then
    raise exception 'P3.1-HF-R1 the internal transition body is reachable from a client role';
  end if;

  -- 7e-3. The acknowledgement rule lives in the shared body, and the legacy
  -- six-argument signature cannot apply a transition on its own any more: it only
  -- delegates, so a direct or legacy call to DRAFT -> REVIEW is refused while a
  -- conflict exists.
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)'::regprocedure;
  if v_source is null
     or position('duplicate cccd acknowledgement required' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the acknowledgement refusal is missing from the transition body';
  end if;
  if position('direct_entry_submission_duplicate_cccd_state' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the transition body does not re-derive the conflict set';
  end if;
  if position('v_submission.state = ''DRAFT'' and p_target_state = ''REVIEW''' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the acknowledgement rule does not own DRAFT -> REVIEW only';
  end if;
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)'::regprocedure;
  if v_source is null then
    raise exception 'P3.1-HF-R1 the legacy transition signature disappeared';
  end if;
  if position('direct_entry_transition_submission_apply' in v_source) = 0 then
    raise exception 'P3.1-HF-R1 the legacy signature no longer delegates to the shared body';
  end if;
  if position('update public.direct_entry_submissions' in v_source) > 0
     or position('set state = p_target_state' in v_source) > 0
     or position('direct_entry_idempotency_finish' in v_source) > 0 then
    raise exception 'P3.1-HF-R1 the legacy signature still applies a transition by itself';
  end if;
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)'::regprocedure
       and p.prosecdef
       and p.provolatile = 'v'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'P3.1-HF-R1 the legacy transition security boundary changed';
  end if;

  -- 7e-4. Behaviour, data free: an unmapped actor is refused by the preflight, the
  -- confirmed entry point accepts only the REVIEW target with a well-formed
  -- acknowledgement, and the shared body refuses an unmapped actor before it reads
  -- a submission. Nobody can mistake a denial for "no duplicate".
  begin
    perform public.direct_entry_submission_duplicate_cccd_preflight(
      '00000000-0000-4000-8000-0000000000b1'::uuid,
      '00000000-0000-4000-8000-0000000000b2'::uuid,
      '00000000-0000-4000-8000-0000000000b3'::uuid
    );
    raise exception 'P3.1-HF-R1 the preflight accepted an unmapped actor';
  exception
    when others then
      if position('P3.1-HF-R1' in sqlerrm) > 0 then
        raise;
      end if;
  end;
  begin
    perform public.direct_entry_transition_submission_duplicate_cccd_confirmed(
      '00000000-0000-4000-8000-0000000000b4'::uuid,
      '00000000-0000-4000-8000-0000000000b5'::uuid,
      '00000000-0000-4000-8000-0000000000b6'::uuid,
      1, 'SUBMITTED', 'hf_confirmation_install_check',
      repeat('a', 64), 1
    );
    raise exception 'P3.1-HF-R1 the confirmed entry point accepted a non-review target';
  exception
    when others then
      if position('P3.1-HF-R1' in sqlerrm) > 0 then
        raise;
      end if;
  end;
  begin
    perform public.direct_entry_transition_submission_apply(
      '00000000-0000-4000-8000-0000000000b7'::uuid,
      '00000000-0000-4000-8000-0000000000b8'::uuid,
      '00000000-0000-4000-8000-0000000000b9'::uuid,
      1, 'REVIEW', 'hf_confirmation_install_check_2', null, null
    );
    raise exception 'P3.1-HF-R1 the shared transition body accepted an unmapped actor';
  exception
    when others then
      if position('P3.1-HF-R1' in sqlerrm) > 0 then
        raise;
      end if;
  end;
end;
$p3_1_hf_confirmation$;

-- The duplicate report stays a read surface beside the worker directory: its ACL is
-- fixed above (revoked from public/anon/authenticated, granted to service_role) and
-- the masked projection is the only CCCD information it can emit.
--
-- P3.1-HF-R1 adds one acknowledgement contract to this same migration - the preflight
-- RPC, the confirmed transition RPC and the shared body beside the unchanged legacy
-- signature - and that contract is the only writer-side behaviour this migration
-- touches: every save path stays silent about duplicates.
commit;
