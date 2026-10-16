-- PRE-W2-HF #108: let an assigned team leader apply same-team request items.
begin;

do $$
declare
  v_sig regprocedure := 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  v_src text;
  v_def text;
  v_next text;
  v_old_declare constant text := E'  v_scope text;\n  v_team_id uuid;';
  v_new_declare constant text := E'  v_scope text;\n  v_team_review boolean;\n  v_team_id uuid;';
  v_old_scope constant text := E'  v_scope := public.direct_entry_assert_entry_access(\n    p_auth_subject, p_app_user_id, ''change_review'', p_entry.created_by_user_id,\n    p_entry.team_id, p_entry.first_work_date\n  );';
  v_new_scope constant text := E'  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;\n  if v_team_review then\n    v_scope := ''team'';\n  else\n    v_scope := public.direct_entry_assert_entry_access(\n      p_auth_subject, p_app_user_id, ''change_review'', p_entry.created_by_user_id,\n      p_entry.team_id, p_entry.first_work_date\n    );\n  end if;';
  v_old_second_access constant text := E'    perform public.direct_entry_assert_entry_access(\n      p_auth_subject, p_app_user_id, ''change_review'',\n      p_entry.created_by_user_id, v_team_id, v_date, v_scope\n    );';
  v_new_second_access constant text := E'    if v_team_review then\n      if v_team_id is distinct from p_entry.team_id then\n        raise exception ''entry scope/capability denied'' using errcode = ''42501'';\n      end if;\n    else\n      perform public.direct_entry_assert_entry_access(\n        p_auth_subject, p_app_user_id, ''change_review'',\n        p_entry.created_by_user_id, v_team_id, v_date, v_scope\n      );\n    end if;';
begin
  select p.prosrc into v_src from pg_proc p where p.oid = v_sig;
  if v_src is null
     or position(v_old_declare in v_src) = 0
     or position(v_old_scope in v_src) = 0
     or position(v_old_second_access in v_src) = 0 then
    raise exception 'team-leader apply source drift';
  end if;

  v_next := replace(v_src, v_old_declare, v_new_declare);
  v_next := replace(v_next, v_old_scope, v_new_scope);
  v_next := replace(v_next, v_old_second_access, v_new_second_access);
  select pg_get_functiondef(v_sig) into v_def;
  execute replace(v_def, v_src, v_next);
end;
$$;

revoke all on function public.direct_entry_apply_change_item(
  uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid
) from public, anon, authenticated, service_role;

do $$
declare
  v_sig regprocedure := 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = v_sig;
  if v_src is null
     or position('v_team_review boolean' in v_src) = 0
     or position('direct_entry_team_leader_request_team(p_app_user_id, p_request_id)' in v_src) = 0
     or position('v_team_id is distinct from p_entry.team_id' in v_src) = 0
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_proc p where p.oid = v_sig)
     or has_function_privilege('service_role', v_sig, 'EXECUTE')
     or has_function_privilege('authenticated', v_sig, 'EXECUTE')
     or has_function_privilege('anon', v_sig, 'EXECUTE') then
    raise exception 'team-leader apply boundary not installed';
  end if;
end;
$$;

commit;
