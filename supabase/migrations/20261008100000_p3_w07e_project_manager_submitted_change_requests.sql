-- P3-W07E — Project managers may propose changes to submitted workers in
-- their currently assigned projects. Canonical values still change only after
-- an authorized reviewer approves; self-review and reviewer capability gates
-- remain unchanged. Document/file replacement is deliberately out of scope.

begin;

create or replace function public.direct_entry_actor_has_project_assignment(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
     where p_app_user_id is not null
  );
$$;
revoke all on function public.direct_entry_actor_has_project_assignment(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_actor_is_assigned_project_manager(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
     where p_app_user_id is not null
       and p_project_id is not null
       and a.project_id = p_project_id
  );
$$;
revoke all on function public.direct_entry_actor_is_assigned_project_manager(uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_resolve_submission_read_scope(
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
  v_scope text;
  v_entry public.direct_entries%rowtype;
begin
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  if v_scope is not null then
    return v_scope;
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select e.* into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and s.state = 'SUBMITTED';
  if not found or not public.direct_entry_actor_is_assigned_project_manager(
       p_app_user_id, v_entry.project_id
     ) then
    return null;
  end if;
  return 'project';
end;
$$;
revoke all on function public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_resolve_change_request_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_target_kind text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
begin
  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  begin
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_request_create',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  exception when insufficient_privilege then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  end;

  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported' using errcode = '42501';
  end if;
  if not exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) or not public.direct_entry_actor_is_assigned_project_manager(
       p_app_user_id, v_entry.project_id
     ) then
    raise exception 'project change request access denied' using errcode = '42501';
  end if;
  return 'project';
end;
$$;
revoke all on function public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- PostgreSQL preserves CRLF in some historical function prosrc values. This
-- private transaction-scoped helper patches only exact, uniquely matched
-- fragments and rechecks the SECURITY DEFINER/ACL boundary after each patch.
create function public.direct_entry_w07e_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source text;
  v_definition text;
  v_expected text := p_expected;
  v_replacement text := p_replacement;
  v_next text;
  v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P3-W07E invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'P3-W07E source function not found: %', p_signature;
  end if;
  if position(E'\r\n' in v_source) > 0 then
    v_expected := replace(v_expected, E'\n', E'\r\n');
    v_replacement := replace(v_replacement, E'\n', E'\r\n');
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) /
    length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P3-W07E expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(p_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P3-W07E could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);

  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3-W07E changed function security boundary: %', p_signature;
  end if;
end;
$$;
revoke all on function public.direct_entry_w07e_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- The active project assignment is the proposer authority for project-scoped
-- SUBMITTED entries. Existing own/team/all + change_request_create authority
-- remains intact for all other proposers.
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_request_create'
  );$old$,
  $new$
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_request_create',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );$old$,
  $new$
    perform public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_request_create',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );$old$,
  $new$
    v_scope := public.direct_entry_resolve_change_request_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id, v_item->>'target_kind'
    );$new$,
  1
);

-- Submitted entries may be read by their currently assigned project manager
-- for preparing a proposal. PII and banking values are returned in full only
-- in that project-scoped SUBMITTED case; draft redaction is unchanged.
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;$old$,
  $new$
  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  '  v_result := jsonb_build_object(',
  $new$
  if v_scope = 'project' and exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) then
    v_pii := true;
    v_payment := true;
  end if;
  v_result := jsonb_build_object($new$,
  1
);

-- Submission list/detail keeps the existing strict RPC contract plus an
-- explicit project_scoped bit. Project-only items are SUBMITTED, count and
-- return only rows in the actor's currently assigned projects, and cannot be
-- transitioned or used for document operations by the client.
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  '  v_own_scope_count integer;' || E'\n' || '  v_scanned integer;',
  '  v_own_scope_count integer;' || E'\n' ||
  '  v_can_list_own boolean := false;' || E'\n' ||
  '  v_has_project_assignment boolean := false;' || E'\n' ||
  '  v_scanned integer;',
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;$old$,
  $new$
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  v_can_list_own := v_own_scope_count = 1
    and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_list_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$
           s.submitted_at
      from public.direct_entry_submissions s
     where s.created_by_user_id = p_app_user_id
       and (p_state is null or s.state = p_state)$old$,
  $new$
           s.submitted_at,
           not (v_can_list_own and s.created_by_user_id = p_app_user_id) as project_scoped
      from public.direct_entry_submissions s
     where (
             (v_can_list_own and s.created_by_user_id = p_app_user_id)
             or (
               s.state = 'SUBMITTED'
               and v_has_project_assignment
               and exists (
                 select 1 from public.direct_entries e
                  where e.submission_id = s.submission_id
                    and e.deleted_at is null
                    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
               )
             )
           )
       and (p_state is null or s.state = p_state)$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$
               'entry_count', (
                 select count(*)::int from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
               ),$old$,
  $new$
               'entry_count', (
                 select count(*)::int from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
                     and (not t.project_scoped or
                       public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
                ),
                'project_scoped', t.project_scoped,$new$,
  1
);

select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure,
  '  v_own_scope_count integer;' || E'\n' || 'begin',
  '  v_own_scope_count integer;' || E'\n' ||
  '  v_can_read_own boolean := false;' || E'\n' ||
  '  v_has_project_assignment boolean := false;' || E'\n' ||
  '  v_project_scoped boolean := false;' || E'\n' || 'begin',
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;$old$,
  $new$
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  v_can_read_own := v_own_scope_count = 1
    and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_read_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure,
  $old$
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;$old$,
  $new$
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_project_scoped := not (
    v_can_read_own and v_submission.created_by_user_id = p_app_user_id
  );
  if v_project_scoped and (
       v_submission.state <> 'SUBMITTED'
       or not exists (
         select 1 from public.direct_entries e
          where e.submission_id = v_submission.submission_id
            and e.deleted_at is null
            and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       )
     ) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure,
  $old$
      select count(*)::int from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
    ),
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
    ),$old$,
  $new$
      select count(*)::int from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'project_scoped', v_project_scoped,
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),$new$,
  1
);

-- A project manager can see their own request only while the project
-- assignment remains effective. Reviewer audience and target capabilities
-- remain unchanged.
create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid,
  p_proposer_user_id uuid,
  p_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability text;
  v_items integer;
  v_accessible integer;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_capability := case when p_proposer_user_id = p_app_user_id
    then 'change_request_create' else 'change_review' end;
  select count(*) into v_items
    from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then return 'NONE'; end if;
  select count(*) into v_accessible
    from public.direct_entry_change_request_items i
    join public.direct_entries e on e.entry_id = i.entry_id
   where i.request_id = p_request_id
     and (
       public.direct_entry_has_entry_access(
         p_app_user_id, v_capability, e.created_by_user_id, e.team_id, e.first_work_date
       )
       or (
         p_proposer_user_id = p_app_user_id
         and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
         and exists (
           select 1 from public.direct_entry_submissions s
            where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
         )
       )
     );
  if v_accessible <> v_items then return 'NONE'; end if;
  return case when p_proposer_user_id = p_app_user_id then 'PROPOSER' else 'REVIEWER' end;
end;
$$;
revoke all on function public.direct_entry_change_request_audience(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_withdraw_change_request(uuid,uuid,uuid,integer,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_request_create'
  );$old$,
  $new$
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);$new$,
  1
);
select public.direct_entry_w07e_replace_proc_source(
  'public.direct_entry_withdraw_change_request(uuid,uuid,uuid,integer,text)'::regprocedure,
  $old$
  if not found or v_request.proposer_user_id <> p_app_user_id then
    raise exception 'change request scope denied' using errcode = '42501';
  end if;$old$,
  $new$
  if not found or v_request.proposer_user_id <> p_app_user_id
     or public.direct_entry_change_request_audience(
       p_app_user_id, v_request.proposer_user_id, v_request.request_id
     ) <> 'PROPOSER' then
    raise exception 'change request scope denied' using errcode = '42501';
  end if;$new$,
  1
);

drop function public.direct_entry_w07e_replace_proc_source(regprocedure,text,text,integer);

do $p3_w07e$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_actor_has_project_assignment(uuid)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) or not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) or not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) or not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_actor_is_assigned_project_manager(uuid,text)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3-W07E private helper security boundary self-check failed';
  end if;
end;
$p3_w07e$;

commit;
