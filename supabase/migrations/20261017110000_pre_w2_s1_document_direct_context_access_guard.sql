-- PRE-W2-S1-R1: reassert private document context authorization after #111.
begin;

do $migration$
declare
  v_signature regprocedure :=
    'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure;
  v_definition text;
  v_repaired text;
  v_branch text;
  v_download_pos integer;
  v_document_view_pos integer;
  v_legacy_pattern text :=
    'v_scope := public[.]direct_entry_resolve_submission_read_scope[(][[:space:]]*' ||
    'p_auth_subject, p_app_user_id, v_entry[.]entry_id[[:space:]]*[)][;][[:space:]]*' ||
    'if v_scope is null then[[:space:]]*' ||
    'v_scope := public[.]direct_entry_assert_entry_access[(][[:space:]]*' ||
    'p_auth_subject, p_app_user_id, ''entry_privileged_edit'',[[:space:]]*' ||
    'v_entry[.]created_by_user_id, v_entry[.]team_id, v_entry[.]first_work_date' ||
    '[[:space:]]*[)][;][[:space:]]*end if;';
  v_guarded text := $guarded$    if p_purpose = 'download' then
      perform public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;$guarded$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if v_definition is null then
    raise exception 'document context function is missing' using errcode = '55000';
  end if;

  v_download_pos := strpos(v_definition, 'if p_purpose = ''download'' then');
  v_document_view_pos := strpos(v_definition, 'g.capability = ''document_view''');
  if v_download_pos = 0 or v_document_view_pos = 0 or v_download_pos > v_document_view_pos then
    v_repaired := regexp_replace(v_definition, v_legacy_pattern, v_guarded);
    if v_repaired = v_definition then
      raise exception 'document context authorization source drift' using errcode = '55000';
    end if;
    execute v_repaired;
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  v_download_pos := strpos(v_definition, 'if p_purpose = ''download'' then');
  v_document_view_pos := strpos(v_definition, 'g.capability = ''document_view''');
  if v_download_pos = 0 or v_document_view_pos = 0 or v_download_pos > v_document_view_pos then
    raise exception 'document context access guard verification failed' using errcode = '55000';
  end if;
  v_branch := substring(v_definition from v_download_pos for v_document_view_pos - v_download_pos);
  if v_branch not like '%direct_entry_assert_draft_access%'
     or v_branch not like '%private preview is portrait-only%'
     or v_branch not like '%direct_entry_resolve_submission_read_scope%'
     or v_branch not like '%entry_privileged_edit%' then
    raise exception 'document context access guard verification failed' using errcode = '55000';
  end if;
end;
$migration$;

commit;
