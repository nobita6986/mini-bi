-- R1.1: operation reasons are optional; leave_reason_text for OFF remains mandatory.
-- Keep audit, revision, event and idempotency records while storing no placeholder reason.
begin;

alter table public.direct_entry_account_operation_intents
  alter column reason_id drop not null;
alter table public.direct_entry_app_user_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_catalog_bootstrap_runs
  alter column reason_id drop not null;
alter table public.direct_entry_change_request_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_change_requests
  alter column reason_id drop not null;
alter table public.direct_entry_employment_status_events
  alter column reason_id drop not null;
alter table public.direct_entry_labor_type_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_personnel_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_project_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_project_team_scopes
  alter column reason_id drop not null;
alter table public.direct_entry_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_submission_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_team_membership_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_team_revisions
  alter column reason_id drop not null;
alter table public.direct_entry_vendor_revisions
  alter column reason_id drop not null;
alter table public.direct_entries
  alter column void_reason_id drop not null;

alter table public.direct_entry_change_requests
  drop constraint direct_entry_change_requests_check;
alter table public.direct_entry_change_requests
  add constraint direct_entry_change_requests_check check (
    ((state = any (array['PENDING'::text, 'WITHDRAWN'::text]))
      and decided_by_user_id is null and decided_at is null)
    or
    ((state = any (array['APPROVED'::text, 'REJECTED'::text]))
      and decided_by_user_id is not null and decided_at is not null)
  );

alter table public.direct_entry_project_team_scopes
  drop constraint direct_entry_project_team_scopes_revocation_check;
alter table public.direct_entry_project_team_scopes
  add constraint direct_entry_project_team_scopes_revocation_check check (
    ((valid_to is null) and (revoked_at is null) and (revoked_by_user_id is null)
      and (revoke_reason_id is null))
    or
    ((valid_to is not null) and (revoked_at is not null)
      and (revoked_by_user_id is not null))
  );

alter table public.direct_entries
  drop constraint direct_entries_void_metadata_consistent;
alter table public.direct_entries
  add constraint direct_entries_void_metadata_consistent check (
    ((voided_at is null) and (voided_by_user_id is null) and (void_reason_id is null))
    or
    ((voided_at is not null) and (voided_by_user_id is not null))
  );

create or replace function public.direct_entry_reason(
  p_app_user_id uuid, p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_reason text;
  v_reason_id uuid;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(btrim(p_reason), '');
  if v_reason is null then
    return null;
  end if;
  insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)
  values (p_app_user_id, v_reason)
  returning reason_id into v_reason_id;
  return v_reason_id;
end;
$function$;

-- Normalize before idempotency hashing and preserve the existing SQL reason limit.
-- The privileged-edit endpoint has the narrower 1,000 character contract.
do $normalize_optional_reason_inputs$
declare
  v_row record;
  v_source text;
  v_next text;
  v_definition text;
  v_limit integer;
  v_targets integer := 0;
  v_injection text;
begin
  for v_row in
    select p.oid, p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
       and p.prokind = 'f'
       and l.lanname = 'plpgsql'
       and p.proname like 'direct_entry_%'
       and p.proname <> 'direct_entry_reason'
       and p.proargnames @> array['p_reason']::text[]
  loop
    v_targets := v_targets + 1;
    v_source := v_row.prosrc;
    v_next := v_source;
    v_limit := case when v_row.proname = 'direct_entry_privileged_edit' then 1000 else 4000 end;
    v_injection := E'\nbegin\n  if p_reason is not null and length(p_reason) > ' || v_limit || E' then\n'
      || E'    raise exception ''reason exceeds maximum length'' using errcode = ''22023'';\n'
      || E'  end if;\n  p_reason := nullif(btrim(p_reason), '''');\n';

    if position(E'\nbegin\n' in v_next) = 0 then
      raise exception 'optional reason function body drift: %', v_row.proname using errcode = '55000';
    end if;
    v_next := regexp_replace(v_next, E'\nbegin\n', v_injection, '');

    -- Remove legacy null/blank rejection while retaining the maximum-length guard above.
    v_next := regexp_replace(v_next,
      E'if p_reason is null or length\\(btrim\\(p_reason\\)\\) not between 1 and 4000 then[[:space:]]*raise exception ''reason required'' using errcode = ''22023'';[[:space:]]*end if;',
      '', 'g');
    v_next := regexp_replace(v_next,
      E'\n[[:blank:]]*or p_reason is null\n[[:blank:]]*or length\\(btrim\\(p_reason\\)\\) not between 1 and 4000',
      '', 'g');
    v_next := regexp_replace(v_next,
      E'if v_submission_state = ''SUBMITTED'' and[[:space:]]*\\(p_reason is null or length\\(btrim\\(p_reason\\)\\) not between 1 and 4000\\) then[[:space:]]*raise exception ''reason required for submitted document edit'' using errcode = ''22023'';[[:space:]]*end if;',
      '', 'g');

    -- Draft document metadata is an operation, not a user-entered restricted reason.
    v_next := replace(v_next, $old$coalesce(p_reason, 'Draft document metadata registered')$old$, 'p_reason');
    v_next := replace(v_next, $old$coalesce(p_reason, 'Draft document upload reserved')$old$, 'p_reason');

    if v_next ~ 'p_reason is null' then
      raise exception 'unremoved optional reason null guard: %', v_row.proname using errcode = '55000';
    end if;
    v_definition := pg_get_functiondef(v_row.oid);
    execute replace(v_definition, v_source, v_next);
  end loop;

  if v_targets <> 43 then
    raise exception 'optional reason function inventory drift: expected 43, found %', v_targets
      using errcode = '55000';
  end if;
end;
$normalize_optional_reason_inputs$;

-- Calls without a user reason argument were writing server labels into the restricted-reason
-- table. Keep each operation's revision/audit relationship but use a NULL reason reference.
do $remove_server_reason_placeholders$
declare
  v_row record;
  v_next text;
  v_definition text;
begin
  for v_row in
    select p.oid, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname like 'direct_entry_%'
       and p.prosrc like '%public.direct_entry_reason(%'
       and not (coalesce(p.proargnames, array[]::text[]) @> array['p_reason']::text[])
  loop
    v_next := regexp_replace(v_row.prosrc,
      'v_reason_id := public[.]direct_entry_reason[(][^;]*[)];',
      'v_reason_id := null;', 'g');
    if v_next = v_row.prosrc then
      raise exception 'server-authored reason call drift for %', v_row.oid::regprocedure using errcode = '55000';
    end if;
    v_definition := pg_get_functiondef(v_row.oid);
    execute replace(v_definition, v_row.prosrc, v_next);
  end loop;
end;
$remove_server_reason_placeholders$;

-- Record required duplicate-CCCD acknowledgement as structured non-PII revision metadata.
do $preserve_submission_ack_evidence$
declare
  v_sig regprocedure := 'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)'::regprocedure;
  v_source text;
  v_next text;
  v_definition text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid)
    into v_source, v_definition
    from pg_proc p where p.oid = v_sig;
  v_next := v_source;

  v_old := $old$v_reason_id := public.direct_entry_reason(
      p_app_user_id,
      case
        when v_acknowledged then
          'Submission state transition (duplicate CCCD acknowledged x'
            || v_conflict_count::text || ' fp=' || left(p_ack_fingerprint, 12) || ')'
        else 'Submission state transition'
      end
    );$old$;
  v_new := 'v_reason_id := null;';
  if position(v_old in v_next) > 0 then
    v_next := replace(v_next, v_old, v_new);
  elsif position(v_new in v_next) = 0 then
    raise exception 'submission transition server reason drift' using errcode = '55000';
  end if;

  v_old := $old$jsonb_build_object(
        'state', p_target_state, 'version', v_submission.version + 1,
        'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
      )$old$;
  v_new := $new$jsonb_build_object(
        'state', p_target_state, 'version', v_submission.version + 1,
        'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
      ) || case when v_acknowledged then jsonb_build_object(
          'duplicate_cccd_acknowledgement', jsonb_build_object(
            'conflict_count', v_conflict_count,
            'fingerprint_prefix', left(p_ack_fingerprint, 12)
          )
        ) else '{}'::jsonb end$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'submission transition snapshot drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);
  execute replace(v_definition, v_source, v_next);
end;
$preserve_submission_ack_evidence$;

do $assert_optional_reason_contract$
declare
  v_bad_columns integer;
  v_bad_guards integer;
  v_bad_labels integer;
begin
  select count(*)::int into v_bad_columns
    from (values
      ('direct_entry_account_operation_intents','reason_id'),
      ('direct_entry_app_user_revisions','reason_id'),
      ('direct_entry_catalog_bootstrap_runs','reason_id'),
      ('direct_entry_change_request_revisions','reason_id'),
      ('direct_entry_change_requests','reason_id'),
      ('direct_entry_employment_status_events','reason_id'),
      ('direct_entry_labor_type_revisions','reason_id'),
      ('direct_entry_personnel_revisions','reason_id'),
      ('direct_entry_project_revisions','reason_id'),
      ('direct_entry_project_team_scopes','reason_id'),
      ('direct_entry_revisions','reason_id'),
      ('direct_entry_submission_revisions','reason_id'),
      ('direct_entry_team_membership_revisions','reason_id'),
      ('direct_entry_team_revisions','reason_id'),
      ('direct_entry_vendor_revisions','reason_id'),
      ('direct_entries','void_reason_id')
    ) expected(table_name,column_name)
    join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = expected.table_name
     and c.column_name = expected.column_name
   where c.is_nullable <> 'YES';

  select count(*)::int into v_bad_guards
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'direct_entry_%'
     and p.proargnames @> array['p_reason']::text[]
     and p.prosrc ~ 'p_reason is null';

  select count(*)::int into v_bad_labels
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'direct_entry_%'
     and p.prosrc ~ '(Initial batch creation|Draft row creation|Draft row update|Draft row deletion|Draft submission deletion|Initial full-profile batch creation|Submission state transition|Change request withdrawn|Draft document metadata registered|Draft document upload reserved|Direct document upload finalized)';

  if v_bad_columns <> 0 or v_bad_guards <> 0 or v_bad_labels <> 0 then
    raise exception 'optional action reason contract drift (columns %, guards %, labels %)',
      v_bad_columns, v_bad_guards, v_bad_labels using errcode = '55000';
  end if;

  if not has_function_privilege('direct_entry_catalog_bootstrap_executor',
       'public.direct_entry_reason(uuid,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('public', 'public.direct_entry_reason(uuid,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_reason(uuid,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_reason(uuid,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('service_role', 'public.direct_entry_reason(uuid,text)'::regprocedure, 'EXECUTE') then
    raise exception 'restricted reason helper ACL drift' using errcode = '55000';
  end if;
end;
$assert_optional_reason_contract$;

commit;
