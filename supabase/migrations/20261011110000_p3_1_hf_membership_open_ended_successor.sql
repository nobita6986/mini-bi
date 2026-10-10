begin;

-- A new move is a new open-ended assignment, not an inherited planned expiry.
-- Existing intervals are untouched until an authorized, audited user mutation.
do $migration$
declare
  v_signature regprocedure := 'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::regprocedure;
  v_source text := pg_get_functiondef(v_signature);
  v_before text[] := array[
    'values (p_recruiter_id, p_team_id, p_valid_from, v_open.valid_to)',
    'p_recruiter_id, p_team_id, p_valid_from, v_open.valid_to, v_subject.version + 1, ''MOVE'''
  ];
  v_after text[] := array[
    'values (p_recruiter_id, p_team_id, p_valid_from, null)',
    'p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, ''MOVE'''
  ];
begin
  for i in 1..array_length(v_before, 1) loop
    if length(v_source) - length(replace(v_source, v_before[i], '')) <> length(v_before[i]) then
      raise exception 'open-ended membership move source drift' using errcode = '55000';
    end if;
    v_source := replace(v_source, v_before[i], v_after[i]);
  end loop;
  execute v_source;

  -- Make finite schedules written by #77 cancellable too.
  v_signature := 'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::regprocedure;
  v_source := pg_get_functiondef(v_signature);
  v_before := array['     and m.valid_to is null'];
  if length(v_source) - length(replace(v_source, v_before[1], '')) <> length(v_before[1]) then
    raise exception 'finite membership close source drift' using errcode = '55000';
  end if;
  v_source := replace(v_source, v_before[1], '     and (m.valid_to is null or (
       m.valid_from <= p_valid_to and p_valid_to < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
     ))');
  v_before := array[
    '  v_open public.recruiter_team_memberships;',
    '  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_to, null) then',
    '  v_changed := array[''valid_to''];',
    'v_subject.version, v_change
      ),',
    'v_subject.version + 1, v_change
      )'
  ];
  v_after := array[
    '  v_open public.recruiter_team_memberships;
  v_previous public.recruiter_team_memberships;
  v_origin public.direct_entry_team_membership_revisions;
  v_restore boolean := false;',
    '  -- Restore only a predecessor closed by the audited MOVE chain at this date.
  -- Cancelling a standalone ASSIGN or an already-effective interval stays close-only.
  if p_valid_to = v_open.valid_from
     and public.direct_entry_authorization_date() < v_open.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_membership_revisions r
     where r.recruiter_id = p_recruiter_id
       and r.after_snapshot->>''team_id'' = v_open.team_id::text
       and r.after_snapshot->>''valid_from'' = v_open.valid_from::text
     order by r.version desc limit 1;
    if v_origin.after_snapshot->>''change'' = ''MOVE'' then
      select m.* into v_previous
        from public.recruiter_team_memberships m
       where m.recruiter_id = p_recruiter_id
         and m.valid_to = v_open.valid_from and m.valid_from < m.valid_to
         and exists (
           select 1 from public.direct_entry_team_membership_revisions r
            where r.recruiter_id = p_recruiter_id and r.version <= v_origin.version
              and r.after_snapshot->>''change'' = ''MOVE''
              and r.after_snapshot->>''valid_from'' = v_open.valid_from::text
              and r.before_snapshot->>''team_id'' = m.team_id::text
              and r.before_snapshot->>''valid_from'' = m.valid_from::text
         );
      if found then
        -- Restoration is not a pure revocation: enforce the creation guards too.
        perform public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
        perform public.direct_entry_assert_membership_target_team(v_previous.team_id);
        v_restore := true;
      end if;
    end if;
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_to,
    case when v_restore then v_previous.team_id else null end) then',
    '  if v_restore then
    update public.recruiter_team_memberships set valid_to = null
     where membership_id = v_previous.membership_id;
  end if;
  v_changed := array[''valid_to''];
  if v_restore then
    v_changed := array_append(v_changed, ''previous_membership_restored'');
  end if;',
    'v_subject.version, v_change
      ) || case when v_restore then jsonb_build_object(''restored_membership'',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, v_previous.valid_to, v_subject.version, ''CANCEL''))
        else ''{}''::jsonb end,',
    'v_subject.version + 1, v_change
      ) || case when v_restore then jsonb_build_object(''restored_membership'',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, null, v_subject.version + 1, ''CANCEL''))
        else ''{}''::jsonb end'
  ];
  for i in 1..array_length(v_before, 1) loop
    if length(v_source) - length(replace(v_source, v_before[i], '')) <> length(v_before[i]) then
      raise exception 'membership cancellation restore source drift' using errcode = '55000';
    end if;
    v_source := replace(v_source, v_before[i], v_after[i]);
  end loop;
  execute v_source;

  foreach v_signature in array array[
    'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::regprocedure,
    'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::regprocedure
  ] loop
    if not exists (select 1 from pg_proc where oid = v_signature and prosecdef
      and proconfig @> array['search_path=pg_catalog, public']::text[])
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('public', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'membership mutation security drift' using errcode = '55000';
    end if;
  end loop;
end;
$migration$;

commit;
