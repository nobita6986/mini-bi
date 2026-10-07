-- P3-W07C-R7 — recruiter/team/provider membership is current metadata, not a
-- historical authorization gate tied to a worker's first_work_date.
--
-- Current project authorization remains enforced by the W07B wrapper. Create
-- still requires the selected recruiter to have exactly one active provider
-- and team membership at the current authorization date. A date-only edit
-- preserves the row's stored team/provider, even if the old recruiter is no
-- longer active; changing recruiter resolves the new recruiter's current
-- membership. Current project managers can also read/update DRAFT rows in
-- their assigned project, regardless of the historical row owner or dates;
-- PII/payment/document redaction remains capability-gated. No rows, grants,
-- ACLs, or project assignments are modified.

begin;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_source text;
  v_definition text;
  v_next_source text;
  v_replaced integer;
  v_scope_date constant text := $old_scope$
       and g.valid_from <= v_first_work_date
       and (g.valid_to is null or v_first_work_date < g.valid_to);$old_scope$;
  v_scope_date_current constant text := $new_scope$
       and g.valid_from <= v_auth_date
       and (g.valid_to is null or v_auth_date < g.valid_to);$new_scope$;
  v_membership_date constant text := $old_membership$
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);$old_membership$;
  v_membership_date_current constant text := $new_membership$
       and m.valid_from <= v_auth_date
       and (m.valid_to is null or v_auth_date < m.valid_to);$new_membership$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find full-profile batch RPC';
  end if;

  v_replaced := length(v_source) - length(replace(v_source, v_scope_date, ''));
  if v_replaced <> length(v_scope_date) then
    raise exception 'P3-W07C-R7 expected one exact historical own-scope date predicate';
  end if;
  v_next_source := replace(v_source, v_scope_date, v_scope_date_current);

  v_replaced := length(v_next_source) - length(replace(v_next_source, v_membership_date, ''));
  if v_replaced <> 2 * length(v_membership_date) then
    raise exception 'P3-W07C-R7 expected exact provider/team historical membership predicates';
  end if;
  v_next_source := replace(v_next_source, v_membership_date, v_membership_date_current);

  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct full-profile batch RPC';
  end if;
  execute replace(v_definition, v_source, v_next_source);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or not v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'P3-W07C-R7 changed full-profile batch RPC security boundary';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure;
  v_source text;
  v_definition text;
  v_next text;
  v_replaced integer;
  v_old_count_filter constant text := $old_count$
     and exists (
       select 1
         from public.direct_entry_scope_grants g
         join public.direct_entry_capability_grants c
           on c.app_user_id = g.app_user_id
          and c.capability = case g.scope_kind
            when 'own' then 'entry_own'
            when 'team' then 'entry_team'
            else 'entry_admin'
          end
          and c.valid_from <= public.direct_entry_authorization_date()
          and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
        where g.app_user_id = p_app_user_id
          and g.valid_from <= e.first_work_date
          and (g.valid_to is null or e.first_work_date < g.valid_to)
          and (
            (g.scope_kind = 'own' and e.created_by_user_id = p_app_user_id) or
            (g.scope_kind = 'team' and g.team_id = e.team_id) or
            g.scope_kind = 'all'
          )
     )$old_count$;
  v_new_count_filter constant text := $new_count$
     and public.direct_entry_resolve_draft_scope(
       p_auth_subject, p_app_user_id, e.entry_id
     ) is not null$new_count$;
  v_old_list_filter constant text := $old_list$
       and exists (
         select 1
           from public.direct_entry_scope_grants g
           join public.direct_entry_capability_grants c
             on c.app_user_id = g.app_user_id
            and c.capability = case g.scope_kind
              when 'own' then 'entry_own'
              when 'team' then 'entry_team'
              else 'entry_admin'
            end
            and c.valid_from <= public.direct_entry_authorization_date()
            and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
          where g.app_user_id = p_app_user_id
            and g.valid_from <= e.first_work_date
            and (g.valid_to is null or e.first_work_date < g.valid_to)
            and (
              (g.scope_kind = 'own' and e.created_by_user_id = p_app_user_id) or
              (g.scope_kind = 'team' and g.team_id = e.team_id) or
              g.scope_kind = 'all'
            )
       )$old_list$;
  v_new_list_filter constant text := $new_list$
       and public.direct_entry_resolve_draft_scope(
         p_auth_subject, p_app_user_id, e.entry_id
       ) is not null$new_list$;
  v_old_resolver constant text := $old_resolver$
           public.direct_entry_assert_draft_access(
             p_auth_subject, p_app_user_id, e.created_by_user_id, e.team_id, e.first_work_date
           ) as resolved_scope$old_resolver$;
  v_new_resolver constant text := $new_resolver$
           public.direct_entry_resolve_draft_scope(
             p_auth_subject, p_app_user_id, e.entry_id
           ) as resolved_scope$new_resolver$;
  v_old_result_filter constant text := $old_result_filter$where e.resolved_scope in ('own', 'team', 'all')$old_result_filter$;
  v_new_result_filter constant text := $new_result_filter$where e.resolved_scope in ('own', 'team', 'all', 'project')$new_result_filter$;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find draft-list RPC';
  end if;

  v_replaced := length(v_source) - length(replace(v_source, v_old_count_filter, ''));
  if v_replaced <> length(v_old_count_filter) then
    raise exception 'P3-W07C-R7 expected one exact draft count scope predicate';
  end if;
  v_next := replace(v_source, v_old_count_filter, v_new_count_filter);
  v_replaced := length(v_next) - length(replace(v_next, v_old_list_filter, ''));
  if v_replaced <> length(v_old_list_filter) then
    raise exception 'P3-W07C-R7 expected one exact draft-list scope predicate';
  end if;
  v_next := replace(v_next, v_old_list_filter, v_new_list_filter);
  v_replaced := length(v_next) - length(replace(v_next, v_old_resolver, ''));
  if v_replaced <> length(v_old_resolver) then
    raise exception 'P3-W07C-R7 expected one exact draft-list access projection';
  end if;
  v_next := replace(v_next, v_old_resolver, v_new_resolver);
  v_replaced := length(v_next) - length(replace(v_next, v_old_result_filter, ''));
  if v_replaced <> length(v_old_result_filter) then
    raise exception 'P3-W07C-R7 expected one exact draft-list scope result filter';
  end if;
  v_next := replace(v_next, v_old_result_filter, v_new_result_filter);

  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct draft-list RPC';
  end if;
  execute replace(v_definition, v_source, v_next);

  if not exists (
    select 1 from pg_proc p
     where p.oid = v_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3-W07C-R7 changed draft-list RPC security boundary';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure;
  v_source text;
  v_definition text;
  v_next text;
  v_replaced integer;
  v_old constant text := $old$
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );$old$;
  v_new constant text := $new$
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;$new$;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find draft read projection';
  end if;
  v_replaced := length(v_source) - length(replace(v_source, v_old, ''));
  if v_replaced <> length(v_old) then
    raise exception 'P3-W07C-R7 expected one exact draft-read access call';
  end if;
  v_next := replace(v_source, v_old, v_new);
  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct draft read projection';
  end if;
  execute replace(v_definition, v_source, v_next);

  if not exists (
    select 1 from pg_proc p
     where p.oid = v_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3-W07C-R7 changed draft read projection security boundary';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_entry_signature constant regprocedure :=
    'public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text)'::regprocedure;
  v_draft_signature constant regprocedure :=
    'public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)'::regprocedure;
  v_entry_source text;
  v_entry_definition text;
  v_draft_source text;
  v_draft_definition text;
  v_entry_next text;
  v_draft_next text;
  v_old_entry_date constant text := $old_entry$
     and g.valid_from <= p_effective_date
     and (g.valid_to is null or p_effective_date < g.valid_to)$old_entry$;
  v_new_entry_date constant text := $new_entry$
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)$new_entry$;
  v_old_draft_date constant text := $old_draft$
     and g.valid_from <= p_resource_scope_date
     and (g.valid_to is null or p_resource_scope_date < g.valid_to)$old_draft$;
  v_new_draft_date constant text := $new_draft$
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)$new_draft$;
  v_replaced integer;
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_entry_source from pg_proc p where p.oid = v_entry_signature;
  select p.prosrc into v_draft_source from pg_proc p where p.oid = v_draft_signature;
  if v_entry_source is null or v_draft_source is null then
    raise exception 'P3-W07C-R7 could not find entry-scope authorization helpers';
  end if;

  v_replaced := length(v_entry_source) - length(replace(v_entry_source, v_old_entry_date, ''));
  if v_replaced <> length(v_old_entry_date) then
    raise exception 'P3-W07C-R7 expected one historical entry-scope grant predicate';
  end if;
  v_entry_next := replace(v_entry_source, v_old_entry_date, v_new_entry_date);
  v_replaced := length(v_draft_source) - length(replace(v_draft_source, v_old_draft_date, ''));
  if v_replaced <> length(v_old_draft_date) then
    raise exception 'P3-W07C-R7 expected one historical draft-scope grant predicate';
  end if;
  v_draft_next := replace(v_draft_source, v_old_draft_date, v_new_draft_date);

  v_entry_definition := pg_get_functiondef(v_entry_signature);
  v_replaced := length(v_entry_definition) - length(replace(v_entry_definition, v_entry_source, ''));
  if v_replaced <> length(v_entry_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct entry-scope helper';
  end if;
  execute replace(v_entry_definition, v_entry_source, v_entry_next);

  v_draft_definition := pg_get_functiondef(v_draft_signature);
  v_replaced := length(v_draft_definition) - length(replace(v_draft_definition, v_draft_source, ''));
  if v_replaced <> length(v_draft_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct draft-scope helper';
  end if;
  execute replace(v_draft_definition, v_draft_source, v_draft_next);

  if exists (
    select 1 from pg_proc p
     where p.oid in (v_entry_signature, v_draft_signature)
       and (not p.prosecdef
         or not coalesce(p.proconfig @> array['search_path=pg_catalog, public'], false)
         or has_function_privilege('service_role', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ))
  ) then
    raise exception 'P3-W07C-R7 changed entry-scope helper security boundary';
  end if;
end;
$p3_w07c_r7$;

create function public.direct_entry_resolve_draft_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_target_project_id text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_id uuid;
  v_state text;
  v_scope text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_submission_id := v_entry.submission_id;
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = v_submission_id;

  begin
    v_scope := public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date
    );
  exception when insufficient_privilege then
    v_scope := null;
  end;

  if v_scope is null then
    if v_state <> 'DRAFT'
       or not public.direct_entry_actor_can_access_project(p_app_user_id, v_entry.project_id) then
      return null;
    end if;
    v_scope := 'project';
  end if;

  if p_target_project_id is not null
     and p_target_project_id is distinct from v_entry.project_id
     and not public.direct_entry_actor_can_access_project(p_app_user_id, p_target_project_id) then
    return null;
  end if;
  return v_scope;
end;
$$;

revoke all on function public.direct_entry_resolve_draft_scope(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

do $p3_w07c_r7$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_resolve_draft_scope(uuid,uuid,uuid,text)'::regprocedure
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P3-W07C-R7 draft scope resolver boundary self-check failed';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure := 'public.direct_entry_validate_new_entry()'::regprocedure;
  v_source text;
  v_definition text;
  v_next_source text;
  v_replaced integer;
  v_old_recruiter_check constant text := $old_recruiter$
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = new.recruiter_id and r.active
  ) then
    raise exception 'recruiter is not active' using errcode = '23514';
  end if;$old_recruiter$;
  v_new_recruiter_check constant text := $new_recruiter$
  if (tg_op = 'INSERT' or old.recruiter_id is distinct from new.recruiter_id)
     and not exists (
       select 1 from public.recruiters r
        where r.recruiter_id = new.recruiter_id and r.active
     ) then
    raise exception 'recruiter is not active' using errcode = '23514';
  end if;$new_recruiter$;
  v_old_team_check constant text := $old_team$
  if not exists (
    select 1 from public.teams t
     where t.team_id = new.team_id and t.active
  ) then
    raise exception 'team is not active' using errcode = '23514';
  end if;$old_team$;
  v_new_team_check constant text := $new_team$
  if (tg_op = 'INSERT' or old.team_id is distinct from new.team_id)
     and not exists (
       select 1 from public.teams t where t.team_id = new.team_id and t.active
     ) then
    raise exception 'team is not active' using errcode = '23514';
  end if;$new_team$;
  v_old_membership_check constant text := $old_membership$
  select count(*), min(m.provider_type)
    into v_provider_count, v_provider_type
    from public.recruiter_provider_memberships m
   where m.recruiter_id = new.recruiter_id
     and m.valid_from <= new.first_work_date
     and (m.valid_to is null or new.first_work_date < m.valid_to);
  if v_provider_count <> 1 or v_provider_type <> new.provider_type then
    raise exception 'provider membership missing, ambiguous, or mismatched' using errcode = '23514';
  end if;

  select count(*) into v_team_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = new.recruiter_id
     and m.team_id = new.team_id
     and m.valid_from <= new.first_work_date
     and (m.valid_to is null or new.first_work_date < m.valid_to);
  if v_team_count <> 1 then
    raise exception 'team membership missing or ambiguous' using errcode = '23514';
  end if;$old_membership$;
  v_new_membership_check constant text := $new_membership$
  if tg_op = 'INSERT'
     or old.recruiter_id is distinct from new.recruiter_id
     or old.team_id is distinct from new.team_id
     or old.provider_type is distinct from new.provider_type then
    select count(*), min(m.provider_type)
      into v_provider_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_provider_count <> 1 or v_provider_type <> new.provider_type then
      raise exception 'provider membership missing, ambiguous, or mismatched' using errcode = '23514';
    end if;

    select count(*) into v_team_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.team_id = new.team_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_team_count <> 1 then
      raise exception 'team membership missing or ambiguous' using errcode = '23514';
    end if;
  end if;$new_membership$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find direct-entry identity trigger';
  end if;
  v_replaced := length(v_source) - length(replace(v_source, v_old_recruiter_check, ''));
  if v_replaced <> length(v_old_recruiter_check) then
    raise exception 'P3-W07C-R7 expected one exact active-recruiter check';
  end if;
  v_next_source := replace(v_source, v_old_recruiter_check, v_new_recruiter_check);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old_team_check, ''));
  if v_replaced <> length(v_old_team_check) then
    raise exception 'P3-W07C-R7 expected one exact active-team check';
  end if;
  v_next_source := replace(v_next_source, v_old_team_check, v_new_team_check);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old_membership_check, ''));
  if v_replaced <> length(v_old_membership_check) then
    raise exception 'P3-W07C-R7 expected one exact historical trigger membership block';
  end if;
  v_next_source := replace(v_next_source, v_old_membership_check, v_new_membership_check);

  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct identity trigger';
  end if;
  execute replace(v_definition, v_source, v_next_source);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_proc p where p.oid = v_signature;
  if v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'P3-W07C-R7 changed direct-entry identity trigger security boundary';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_source text;
  v_definition text;
  v_next_source text;
  v_replaced integer;
  v_old constant text := $old$
       and m.valid_from <= (v_row->>'first_work_date')::date
       and (m.valid_to is null or (v_row->>'first_work_date')::date < m.valid_to);$old$;
  v_new constant text := $new$
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);$new$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find generated full-profile RPC implementation';
  end if;
  v_replaced := length(v_source) - length(replace(v_source, v_old, ''));
  if v_replaced <> length(v_old) then
    raise exception 'P3-W07C-R7 expected one exact generated-RPC historical membership predicate';
  end if;
  v_next_source := replace(v_source, v_old, v_new);
  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct generated full-profile RPC';
  end if;
  execute replace(v_definition, v_source, v_next_source);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'P3-W07C-R7 changed generated full-profile RPC security boundary';
  end if;
end;
$p3_w07c_r7$;

do $p3_w07c_r7$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure;
  v_source text;
  v_definition text;
  v_next_source text;
  v_replaced integer;
  v_old constant text := $old$
  if p_patch ? 'recruiter_id' or p_patch ? 'first_work_date' then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  else
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
  end if;$old$;
  v_new constant text := $new$
  if v_new_recruiter_id is distinct from v_entry.recruiter_id then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  else
    -- A date-only edit must not re-resolve or rewrite the recruiter assignment.
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
  end if;$new$;
  v_old_access constant text := $old_access$
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );$old_access$;
  v_new_access constant text := $new_access$
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id,
    coalesce(p_patch->>'project_id', v_entry.project_id)
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;$new_access$;
  v_old_recheck constant text := $old_recheck$
  perform public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_team, v_new_work_date, v_scope
  );$old_recheck$;
  v_new_recheck constant text := $new_recheck$
  if v_scope = 'project' then
    if not public.direct_entry_actor_can_access_project(
      p_app_user_id, coalesce(p_patch->>'project_id', v_entry.project_id)
    ) then
      raise exception 'draft project scope denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_team, v_new_work_date, v_scope
    );
  end if;$new_recheck$;
  v_old_audit_scope constant text := $old_audit_scope$
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end,
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,$old_audit_scope$;
  v_new_audit_scope constant text := $new_audit_scope$
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team'
      when 'project' then 'project_manager' else 'entry_admin' end,
    p_entry_id::text, case when v_scope = 'project' then null else v_scope end,
    case when v_scope = 'team' then v_entry.team_id else null end,$new_audit_scope$;
  v_old_master_check constant text := $old_master$
  if not exists (
    select 1 from public.recruiters r where r.recruiter_id = v_new_recruiter_id and r.active
  ) or not exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = coalesce(p_patch->>'project_id', v_entry.project_id) and p.active
  ) or not exists (
    select 1 from public.teams t where t.team_id = v_team and t.active
  ) then
    raise exception 'inactive draft master' using errcode = '22023';
  end if;$old_master$;
  v_new_master_check constant text := $new_master$
  if (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.recruiters r
         where r.recruiter_id = v_new_recruiter_id and r.active
      )) or not exists (
        select 1 from public.direct_entry_projects p
         where p.project_id = coalesce(p_patch->>'project_id', v_entry.project_id) and p.active
      ) or (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.teams t where t.team_id = v_team and t.active
      )) then
    raise exception 'inactive draft master' using errcode = '22023';
  end if;$new_master$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R7 could not find draft-row update RPC';
  end if;
  v_replaced := length(v_source) - length(replace(v_source, v_old_access, ''));
  if v_replaced <> length(v_old_access) then
    raise exception 'P3-W07C-R7 expected one exact draft-row scope check';
  end if;
  v_next_source := replace(v_source, v_old_access, v_new_access);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old_recheck, ''));
  if v_replaced <> length(v_old_recheck) then
    raise exception 'P3-W07C-R7 expected one exact post-patch draft scope check';
  end if;
  v_next_source := replace(v_next_source, v_old_recheck, v_new_recheck);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old_audit_scope, ''));
  if v_replaced <> length(v_old_audit_scope) then
    raise exception 'P3-W07C-R7 expected one exact draft audit scope projection';
  end if;
  v_next_source := replace(v_next_source, v_old_audit_scope, v_new_audit_scope);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old, ''));
  if v_replaced <> length(v_old) then
    raise exception 'P3-W07C-R7 expected one exact draft membership block';
  end if;
  v_next_source := replace(v_next_source, v_old, v_new);
  v_replaced := length(v_next_source) - length(replace(v_next_source, v_old_master_check, ''));
  if v_replaced <> length(v_old_master_check) then
    raise exception 'P3-W07C-R7 expected one exact draft master-state block';
  end if;
  v_next_source := replace(v_next_source, v_old_master_check, v_new_master_check);
  v_definition := pg_get_functiondef(v_signature);
  v_replaced := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced <> length(v_source) then
    raise exception 'P3-W07C-R7 could not safely reconstruct draft-row update RPC';
  end if;
  execute replace(v_definition, v_source, v_next_source);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or not v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'P3-W07C-R7 changed draft-row update RPC security boundary';
  end if;
end;
$p3_w07c_r7$;

commit;
