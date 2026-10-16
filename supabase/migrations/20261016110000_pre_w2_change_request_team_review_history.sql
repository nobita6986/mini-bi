-- PRE-W2-HF #105: restore scoped team-leader review and enrich request history cards.
begin;

create or replace function public.direct_entry_team_leader_request_team(p_app_user_id uuid,p_request_id uuid)
returns uuid language sql stable security definer set search_path=pg_catalog,public
as $$
 select (array_agg(e.team_id))[1]
 from public.direct_entry_change_request_items i
 join public.direct_entries e on e.entry_id=i.entry_id
 where i.request_id=p_request_id and e.team_id is not null
   and public.direct_entry_has_capability(p_app_user_id,'team_manager_assign')
   and exists(select 1 from public.direct_entry_scope_grants s
     where s.app_user_id=p_app_user_id and s.scope_kind='team' and s.team_id=e.team_id
       and s.valid_from<=public.direct_entry_authorization_date()
       and (s.valid_to is null or public.direct_entry_authorization_date()<s.valid_to))
   and exists(select 1 from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id=p_app_user_id and a.team_id=e.team_id
       and a.valid_from<=public.direct_entry_authorization_date()
       and (a.valid_to is null or public.direct_entry_authorization_date()<a.valid_to))
 group by i.request_id
 having count(*)=(select count(*) from public.direct_entry_change_request_items x where x.request_id=p_request_id)
    and count(distinct e.team_id)=1;
$$;
revoke all on function public.direct_entry_team_leader_request_team(uuid,uuid) from public,anon,authenticated,service_role;

-- Keep the all-scope reviewer path and add a separate, assignment-bound team-leader path.
do $$
declare v_sig regprocedure := 'public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)'::regprocedure;
begin
 execute $fn$
  create or replace function public.direct_entry_assert_change_request_capabilities(
    p_auth_subject uuid,p_app_user_id uuid,p_request_id uuid
  ) returns void language plpgsql security definer set search_path=pg_catalog,public
  as $body$
  declare v_capability text; v_team_leader_review boolean;
  begin
    v_team_leader_review:=public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null;
    if v_team_leader_review then
      perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'team_manager_assign');
    else
      perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'change_review');
      if not public.direct_entry_has_scope(p_app_user_id,'all') then
        raise exception 'scope denied' using errcode='42501';
      end if;
    end if;
    for v_capability in
      select capability from unnest(public.direct_entry_change_request_required_capabilities(p_request_id)) as required(capability)
       where not (v_team_leader_review and capability='change_review')
    loop
      if not public.direct_entry_has_capability(p_app_user_id,v_capability) then
        raise exception 'capability denied' using errcode='42501';
      end if;
    end loop;
  end;
  $body$;
 $fn$;
end;
$$;

-- The legacy decision RPC also asserted the global reviewer capability and row scope directly.
-- Replace those checks so only the assignment-bound branch may use team_manager_assign.
do $$
declare v_sig regprocedure := 'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::regprocedure;
        v_src text; v_def text; v_next text;
        v_old_actor constant text := E'perform public.direct_entry_assert_actor(\n    p_auth_subject, p_app_user_id, ''change_review''\n  );';
        v_new_actor constant text := E'if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null then\n    perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,''team_manager_assign'');\n  else\n    perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,''change_review'');\n  end if;';
        v_old_access constant text := E'perform public.direct_entry_assert_entry_access(\n      p_auth_subject, p_app_user_id, ''change_review'',\n      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date\n    );';
        v_old_access2 constant text := E'perform public.direct_entry_assert_entry_access(\n        p_auth_subject, p_app_user_id, ''change_review'',\n        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date\n      );';
        v_new_access constant text := E'if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then\n      perform public.direct_entry_assert_entry_access(\n        p_auth_subject, p_app_user_id, ''change_review'',\n        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date\n      );\n    end if;';
begin
 select p.prosrc into v_src from pg_proc p where p.oid=v_sig;
 if v_src is null or position(v_old_actor in v_src)=0 or
    position(v_old_access in v_src)=0 or position(v_old_access2 in v_src)=0 then
   raise exception 'decision source drift';
 end if;
 v_next:=replace(v_src,v_old_actor,v_new_actor);
 v_next:=replace(v_next,v_old_access,v_new_access);
 v_next:=replace(v_next,v_old_access2,v_new_access);
 select pg_get_functiondef(v_sig) into v_def;
 execute replace(v_def,v_src,v_next);
end;
$$;

create or replace function public.direct_entry_change_request_audience(
 p_app_user_id uuid,p_proposer_user_id uuid,p_request_id uuid
) returns text language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_items integer; v_accessible integer; v_is_proposer boolean;
begin
 if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then return 'NONE'; end if;
 v_is_proposer:=p_proposer_user_id=p_app_user_id;
 select count(*) into v_items from public.direct_entry_change_request_items i where i.request_id=p_request_id;
 if v_items<1 then return 'NONE'; end if;
 if v_is_proposer then
   select count(*) into v_accessible from public.direct_entry_change_request_items i
     join public.direct_entries e on e.entry_id=i.entry_id
    where i.request_id=p_request_id
      and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id,e.project_id)
      and exists(select 1 from public.direct_entry_submissions s
        where s.submission_id=e.submission_id and s.state='SUBMITTED');
   if v_accessible=v_items then return 'PROPOSER'; end if;
 else
   if public.direct_entry_has_capability(p_app_user_id,'change_review')
      and public.direct_entry_has_scope(p_app_user_id,'all') then return 'REVIEWER'; end if;
   if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null
      then return 'REVIEWER'; end if;
 end if;
 return 'NONE';
end;
$$;

-- Safe, non-PII list additions: proposer display name and a fixed-label summary from target kinds.
do $$
declare v_sig regprocedure := 'public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)'::regprocedure;
        v_src text; v_def text; v_next text;
        v_old constant text := '''can_decide'', (t.audience = ''REVIEWER'' and t.state = ''PENDING'')';
        v_new text;
begin
 v_new := v_old || ',' || chr(10) || '       ''proposer_display_name'', (select coalesce(nullif(btrim(u.display_name),''''),''Người dùng'') from public.direct_entry_change_requests r join public.direct_entry_app_users u on u.app_user_id=r.proposer_user_id where r.request_id=t.request_id),' || chr(10) ||
   '       ''summary'', (select string_agg(distinct case i.target_kind when ''ENTRY_FIELD'' then ''Thông tin người lao động'' when ''WORKER'' then ''Thông tin người lao động'' when ''PAYMENT'' then ''Thông tin ngân hàng'' when ''WORK_STATUS'' then ''Trạng thái làm việc'' when ''DOCUMENT'' then ''Tài liệu hồ sơ'' else ''Yêu cầu thay đổi'' end, '' · '' order by case i.target_kind when ''ENTRY_FIELD'' then ''Thông tin người lao động'' when ''WORKER'' then ''Thông tin người lao động'' when ''PAYMENT'' then ''Thông tin ngân hàng'' when ''WORK_STATUS'' then ''Trạng thái làm việc'' when ''DOCUMENT'' then ''Tài liệu hồ sơ'' else ''Yêu cầu thay đổi'' end) from public.direct_entry_change_request_items i where i.request_id=t.request_id)';
 select p.prosrc into v_src from pg_proc p where p.oid=v_sig;
 if v_src is null or position(v_old in v_src)=0 then raise exception 'request list source drift'; end if;
 v_next:=replace(v_src,v_old,v_new);
 select pg_get_functiondef(v_sig) into v_def; execute replace(v_def,v_src,v_next);
end;
$$;

commit;

