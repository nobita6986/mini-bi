-- P3-W07A-R3 / P1.7-H06: use a reserved, non-business team for Vendor rows while
-- keeping the existing NOT NULL team_id model; repair the worker-document
-- projection and allow an assigned project manager to upload on their own DRAFT.
-- No browser role receives direct access to the reserved team or document tables.

begin;

-- A source-preserving helper patches only verified fragments in the current RPC
-- definitions. The security boundary and grants of each target function remain
-- unchanged.
create function public.direct_entry_hf_r8_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text; v_next text; v_count integer;
  v_acl aclitem[];
  v_security_definer boolean;
  v_config text[];
  v_expected text; v_replacement text;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P3-W07A-R3 invalid source patch specification';
  end if;
  select replace(p.prosrc, chr(13), ''), p.proacl, p.prosecdef, p.proconfig
    into v_source, v_acl, v_security_definer, v_config
    from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'P3-W07A-R3 source function not found: %', p_signature;
  end if;
  v_expected := replace(p_expected, chr(13), '');
  v_replacement := replace(p_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P3-W07A-R3 expected % exact source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_get_functiondef(p.oid), chr(13), '') into v_definition
    from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P3-W07A-R3 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);
  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature
       and p.prosecdef is not distinct from v_security_definer
       and p.proconfig is not distinct from v_config
       and p.proacl is not distinct from v_acl
  ) then
    raise exception 'P3-W07A-R3 changed function security boundary: %', p_signature;
  end if;
end;
$$;
revoke all on function public.direct_entry_hf_r8_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- Lazily create the internal team only when the first Vendor entry is written.
-- This keeps legacy catalog bootstrap's "empty target" precondition true on a
-- fresh database while preserving the existing NOT NULL team_id invariant.
create function public.direct_entry_system_vendor_team_id()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_team_id uuid;
begin
  insert into public.teams (code, display_name, active)
  values ('__system_vendor__', 'Vendor', true)
  on conflict (code) do nothing;
  select t.team_id into v_team_id
    from public.teams t
   where t.code = '__system_vendor__'
     and t.display_name = 'Vendor'
     and t.active;
  if v_team_id is null then
    raise exception 'reserved Vendor team is unavailable' using errcode = '55000';
  end if;
  return v_team_id;
end;
$$;
alter function public.direct_entry_system_vendor_team_id() owner to postgres;
revoke all on function public.direct_entry_system_vendor_team_id()
  from public, anon, authenticated, service_role;

do $p3_w07a_r3$
begin
  if exists (
    select 1 from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    where t.code = '__system_vendor__'
  ) or exists (
    select 1 from public.direct_entry_scope_grants g
    join public.teams t on t.team_id = g.team_id
    where g.scope_kind = 'team' and t.code = '__system_vendor__'
  ) then
    raise exception 'P3-W07A-R3 reserved Vendor team already has business membership or scope';
  end if;
end
$p3_w07a_r3$;

-- Prevent the reserved row from becoming a selectable recruiter team or a
-- report audience, including through later administrative provisioning.
create function public.direct_entry_reject_system_vendor_business_team()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.team_id is not null and exists (
    select 1 from public.teams t
     where t.team_id = new.team_id and t.code = '__system_vendor__'
  ) then
    raise exception 'reserved Vendor team is not a business team' using errcode = '23514';
  end if;
  return new;
end;
$$;
alter function public.direct_entry_reject_system_vendor_business_team() owner to postgres;
revoke all on function public.direct_entry_reject_system_vendor_business_team()
  from public, anon, authenticated, service_role;

create trigger direct_entry_no_vendor_recruiter_team_membership
  before insert or update of team_id on public.recruiter_team_memberships
  for each row execute function public.direct_entry_reject_system_vendor_business_team();
create trigger direct_entry_no_vendor_team_scope
  before insert or update of team_id on public.direct_entry_scope_grants
  for each row execute function public.direct_entry_reject_system_vendor_business_team();

-- Internal upload access: ordinary scope grants continue using the existing
-- document_upload + entry-scope policy. A project manager may additionally
-- upload only to their own DRAFT entry in an effectively assigned project.
-- REVIEW remains read-only; SUBMITTED retains the existing privileged-edit,
-- effective-scope, reason, OCC, and audit requirements.
create function public.direct_entry_assert_document_upload_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_scope text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select * into v_entry from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  if v_submission_state = 'DRAFT' then
    begin
      perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
      return public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    exception when insufficient_privilege then
      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(p_app_user_id, v_entry.project_id) then
        return 'project';
      end if;
      raise;
    end;
  end if;
  if v_submission_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_privileged_edit');
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date, null
  );
end;
$$;
alter function public.direct_entry_assert_document_upload_access(uuid,uuid,uuid) owner to postgres;
revoke all on function public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

-- Project is a real resolved read/write scope for an assigned manager, but the
-- legacy audit constraint only allowed own/team/all. Extend only the audit
-- label; this does not create a scope grant or grant any actor new access.
alter table public.direct_entry_audit_events
  drop constraint direct_entry_audit_events_scope_kind_check;
alter table public.direct_entry_audit_events
  add constraint direct_entry_audit_events_scope_kind_check
  check (scope_kind is null or scope_kind in ('own', 'team', 'all', 'project'));

-- Vendor team is derived from provider membership, not a recruiter-team
-- membership. Existing HRP behavior and its exact-one-membership guard remain.
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_auth_date
       and (m.valid_to is null or v_auth_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;$old$,
  $new$
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and m.valid_from <= v_auth_date
         and (m.valid_to is null or v_auth_date < m.valid_to);
      if v_count <> 1 then
        raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
    end if;$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
  $old$
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'recruiter team membership denied' using errcode = '42501';
    end if;$old$,
  $new$
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and m.valid_from <= v_first_work_date
         and (m.valid_to is null or v_first_work_date < m.valid_to);
      if v_count <> 1 then
        raise exception 'recruiter team membership denied' using errcode = '42501';
      end if;
    end if;$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$
  select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_recruiter_id and m.valid_from <= v_first_work_date
     and (m.valid_to is null or v_first_work_date < m.valid_to);
  if v_count <> 1 then
    raise exception 'recruiter team membership denied' using errcode = '42501';
  end if;$old$,
  $new$
  if v_provider_type = 'vendor' then
    v_team_id := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'recruiter team membership denied' using errcode = '42501';
    end if;
  end if;$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;$old$,
  $new$
    if v_provider = 'vendor' then
      v_team := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_new_recruiter_id
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;$old$,
  $new$
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
         and (m.valid_to is null or v_date < m.valid_to);
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure,
  $old$
  select count(*), (array_agg(m.team_id))[1] into v_count, v_team
    from public.recruiter_team_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.valid_from <= case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
     and (m.valid_to is null or case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
  if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;$old$,
  $new$
  if v_provider = 'vendor' then
    v_team := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and m.valid_from <= case when p_patch ? 'first_work_date'
            then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
       and (m.valid_to is null or case when p_patch ? 'first_work_date'
            then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  end if;$new$,
  1
);

-- The INSERT/UPDATE validation trigger is a shared write boundary. Keep its
-- provider-membership check unchanged; only Vendor may use the reserved team.
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_validate_new_entry()'::regprocedure,
  $old$
    select count(*) into v_team_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.team_id = new.team_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_team_count <> 1 then
      raise exception 'team membership missing or ambiguous' using errcode = '23514';
    end if;$old$,
  $new$
    if new.provider_type = 'vendor'
       and new.team_id = public.direct_entry_system_vendor_team_id() then
      null;
    else
      select count(*) into v_team_count
        from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.team_id = new.team_id
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
      if v_team_count <> 1 then
        raise exception 'team membership missing or ambiguous' using errcode = '23514';
      end if;
    end if;$new$,
  1
);

-- Keep Vendor's system team label out of own-draft projections; the API still
-- receives a stable UUID required by the current contract.
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$      'team_display_name', e.team_display_name,$old$,
  $new$      'team_display_name', case when e.provider_type = 'vendor'
        then 'Không áp dụng' else e.team_display_name end,$new$,
  1
);

-- The DB read projection dropped validation_status even though the current-docs
-- view and the browser contract require it. The missing field made the whole
-- detail projection fail closed, which in turn disabled upload actions.
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$        'upload_status', d.upload_status, 'scan_status', d.scan_status$old$,
  $new$        'upload_status', d.upload_status, 'scan_status', d.scan_status,
        'validation_status', d.validation_status$new$,
  1
);

-- Allow only the creator of an effectively assigned DRAFT project row to see
-- sanitized document status metadata, even when their account lacks the global
-- document_view capability. This never returns storage keys, filenames or URLs.
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );$old$,
  $new$
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  ) or (
    v_entry.created_by_user_id = p_app_user_id
    and v_scope = 'project'
    and exists (
      select 1 from public.direct_entry_submissions s
       where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
    )
  );$new$,
  1
);

-- The upload RPCs need the entry_id to apply the narrow project-manager/DRAFT
-- fallback to the exact row (not merely another row in the same submission).
select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_create_document_metadata(uuid,uuid,uuid,integer,text,text,text,bigint,text,text)'::regprocedure,
  $old$
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );$old$,
  $new$
  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_reserve_document_direct_upload(uuid,uuid,uuid,integer,text,text,bigint,text,text)'::regprocedure,
  $old$
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );$old$,
  $new$
  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );$old$,
  $new$
  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );$new$,
  1
);

select public.direct_entry_hf_r8_replace_proc_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$
    perform public.direct_entry_assert_payment_document_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
    );$old$,
  $new$
    perform public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );$new$,
  1
);

-- Runtime contract guard for document validation states, catalogs and reports.
do $p3_w07a_r3$
begin
  if has_function_privilege('anon', 'public.direct_entry_system_vendor_team_id()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_system_vendor_team_id()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.direct_entry_system_vendor_team_id()', 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'P3-W07A-R3 internal helper ACL widened';
  end if;
  if exists (
    select 1 from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    where t.code = '__system_vendor__'
  ) or exists (
    select 1 from public.direct_entry_scope_grants g
    join public.teams t on t.team_id = g.team_id
    where g.scope_kind = 'team' and t.code = '__system_vendor__'
  ) then
    raise exception 'P3-W07A-R3 system Vendor team leaked into business scope';
  end if;
  if exists (
    select 1 from public.direct_entry_reporting_dimension_options_v01
     where dimension = 'team'
  ) then
    raise exception 'P3-W07A-R3 reporting must not add a team business dimension';
  end if;
end
$p3_w07a_r3$;

drop function public.direct_entry_hf_r8_replace_proc_source(regprocedure,text,text,integer);

comment on function public.direct_entry_system_vendor_team_id() is
  'P3-W07A-R3 internal-only team id for Vendor direct-entry rows; excluded from recruiter team memberships and team-scope audiences.';
comment on function public.direct_entry_assert_document_upload_access(uuid,uuid,uuid) is
  'P1.7-H06-R3: project managers may upload only to their own effectively assigned DRAFT rows; REVIEW remains read-only and SUBMITTED retains privileged scope/reason/OCC/audit rules.';

commit;
