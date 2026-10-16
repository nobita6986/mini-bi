-- PRE-W2-HF-DIRECT-ENTRY-BATCH-WORKFLOW (#103, append-only).
-- Direct-submit DRAFT batches, retain legacy REVIEW handling, and patch drafts partially.

begin;

create function public.pre_w2_hf_replace_proc_source(
  p_signature regprocedure,
  p_old text,
  p_new text,
  p_expected_count integer default 1
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source text;
  v_definition text;
  v_old text := p_old;
  v_new text := p_new;
  v_count integer;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'PRE-W2-HF batch source function missing: %', p_signature
      using errcode = '55000';
  end if;
  if position(E'\r\n' in v_source) > 0 then
    v_old := replace(v_old, E'\n', E'\r\n');
    v_new := replace(v_new, E'\n', E'\r\n');
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_old, ''))) / length(v_old);
  if v_count <> p_expected_count then
    raise exception 'PRE-W2-HF batch source drift: expected %, found % in %',
      p_expected_count, v_count, p_signature using errcode = '55000';
  end if;
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'PRE-W2-HF batch could not reconstruct function definition: %', p_signature
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_source, replace(v_source, v_old, v_new));
end;
$$;
revoke all on function public.pre_w2_hf_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_submission_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.created_by_user_id <> old.created_by_user_id
     or new.version <> old.version + 1
     or old.state = 'SUBMITTED'
     or not (
       (old.state = 'DRAFT' and new.state = 'DRAFT') or
       (old.state = 'DRAFT' and new.state = 'SUBMITTED') or
       (old.state = 'REVIEW' and new.state in ('DRAFT', 'SUBMITTED'))
     ) then
    raise exception 'invalid submission mutation or stale version' using errcode = '40001';
  end if;
  new.submitted_at := case when new.state = 'SUBMITTED' then now() else null end;
  new.updated_at := now();
  return new;
end;
$$;

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)'::regprocedure,
  $old$if v_submission.state = 'DRAFT' and p_target_state = 'REVIEW' then$old$,
  $new$if v_submission.state = 'DRAFT' and p_target_state = 'SUBMITTED' then$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$when 'DRAFT' then jsonb_build_array('REVIEW')$old$,
  $new$when 'DRAFT' then jsonb_build_array('SUBMITTED')$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure,
  $old$when 'DRAFT' then jsonb_build_array('REVIEW')$old$,
  $new$when 'DRAFT' then jsonb_build_array('SUBMITTED')$new$
);

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
as $$
declare
  v_result jsonb;
begin
  if p_target_state is distinct from 'SUBMITTED' then
    raise exception 'duplicate cccd acknowledgement needs the submitted target'
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
$$;
revoke all on function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
  uuid, uuid, uuid, integer, text, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_transition_submission_duplicate_cccd_confirmed(
  uuid, uuid, uuid, integer, text, text, text, integer
) to service_role;

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$'recruiter_id', 'labor_type'$old$,
  $new$'recruiter_id', 'labor_type', 'general_note'$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$where worker_key.key <> 'display_name'$old$,
  $new$where worker_key.key not in (
         'display_name', 'gender', 'date_of_birth', 'national_id',
         'national_id_issued_at', 'national_id_issued_place', 'address', 'phone'
       )$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$if jsonb_typeof(p_patch->'worker_details') <> 'object' then$old$,
  $new$if jsonb_typeof(p_patch->'worker_details') <> 'object'
       or p_patch->'worker_details' = '{}'::jsonb then$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$if jsonb_typeof(p_patch->'worker_details'->'display_name') <> 'string' then$old$,
  $new$if p_patch->'worker_details' ? 'display_name'
       and jsonb_typeof(p_patch->'worker_details'->'display_name') <> 'string' then$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$  if p_patch ? 'worker_details' then$old$,
  $new$  if p_patch ? 'general_note' and jsonb_typeof(p_patch->'general_note') <> 'null'
     and (jsonb_typeof(p_patch->'general_note') <> 'string'
          or length(p_patch->>'general_note') > 4000
          or btrim(p_patch->>'general_note') = '') then
    raise exception 'invalid draft general note' using errcode = '22023';
  end if;
  if p_patch ? 'worker_details' then$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  $old$    recruiter_id = case when p_patch ? 'recruiter_id' then$old$,
  $new$    general_note = case when p_patch ? 'general_note'
      then case when jsonb_typeof(p_patch->'general_note') = 'null'
        then null else p_patch->>'general_note' end
      else general_note end,
    recruiter_id = case when p_patch ? 'recruiter_id' then$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$s.version as submission_version,$old$,
  $new$s.version as submission_version,
           (s.created_by_user_id = p_app_user_id and e.created_by_user_id = p_app_user_id)
             as own_submission,$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$case when v_pii then e.worker_details->>'display_name' else '' end$old$,
  $new$case when v_pii and e.own_submission then e.worker_details->>'display_name' else '' end$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$case when v_pii then jsonb_build_object($old$,
  $new$case when v_pii and e.own_submission then jsonb_build_object($new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'gender', v_pii$old$,
  $new$e.worker_details->'gender', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'date_of_birth', v_pii$old$,
  $new$e.worker_details->'date_of_birth', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'national_id', v_pii$old$,
  $new$e.worker_details->'national_id', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'national_id_issued_at', v_pii$old$,
  $new$e.worker_details->'national_id_issued_at', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'national_id_issued_place', v_pii$old$,
  $new$e.worker_details->'national_id_issued_place', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'address', v_pii$old$,
  $new$e.worker_details->'address', v_pii and e.own_submission$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$e.worker_details->'phone', v_pii$old$,
  $new$e.worker_details->'phone', v_pii and e.own_submission$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when v_pii then jsonb_build_object('state', 'provided', 'value', e.general_note)$old$,
  $new$when v_pii and e.own_submission then jsonb_build_object('state', 'provided', 'value', e.general_note)$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when not v_employment_apply then jsonb_build_object('state', 'omitted')$old$,
  $new$when not v_employment_apply then jsonb_build_object('state', 'omitted')$new$,
  2
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when v_pii then jsonb_build_object('state', 'provided', 'value', status.leave_date)$old$,
  $new$when v_pii and e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_date)$new$
);
select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when v_pii then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)$old$,
  $new$when v_pii and e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)$new$
);

select public.pre_w2_hf_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  $old$when v_payment_view then jsonb_build_object($old$,
  $new$when v_payment_view and e.own_submission then jsonb_build_object($new$,
  3
);

create function public.direct_entry_apply_draft_employment_status(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_status text,
  p_effective_date date,
  p_leave_reason text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
begin
  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id
   for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state <> 'DRAFT' then
    raise exception 'employment status draft edit requires DRAFT' using errcode = '42501';
  end if;
  return public.direct_entry_apply_employment_status(
    p_auth_subject, p_app_user_id, p_entry_id, p_expected_entry_version,
    p_status, p_effective_date, p_leave_reason, p_reason, p_idempotency_key
  );
end;
$$;
revoke all on function public.direct_entry_apply_draft_employment_status(
  uuid, uuid, uuid, integer, text, date, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_apply_draft_employment_status(
  uuid, uuid, uuid, integer, text, date, text, text, text
) to service_role;

comment on function public.direct_entry_apply_draft_employment_status(
  uuid, uuid, uuid, integer, text, date, text, text, text
) is
  'PRE-W2-HF #103: locks the entry and submission, requires DRAFT, then delegates to the existing employment_status.apply capability, OCC, idempotency, revision and audit path.';

comment on function public.direct_entry_submission_transition_guard() is
  'PRE-W2-HF #103: new DRAFT batches transition directly to SUBMITTED; existing REVIEW batches may return to DRAFT or submit.';
comment on function public.direct_entry_transition_submission_apply(
  uuid, uuid, uuid, integer, text, text, text, integer
) is
  'PRE-W2-HF #103: one locked transition body; DRAFT -> SUBMITTED rechecks duplicate CCCD acknowledgement in-transaction and legacy REVIEW transitions retain their existing authority, OCC, audit and idempotency.';
comment on function public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid) is
  'PRE-W2-HF #103 read-only preflight for direct DRAFT -> SUBMITTED: same creator/own-scope authority, masked conflict set, authoritative version, fingerprint and count; writes nothing.';

drop function public.pre_w2_hf_replace_proc_source(regprocedure,text,text,integer);

commit;
