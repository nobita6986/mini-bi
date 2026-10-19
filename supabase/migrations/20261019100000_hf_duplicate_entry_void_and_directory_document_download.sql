-- HF: preserve approved duplicate records as auditable voids and align ready-document
-- downloads with the worker-directory read scope without weakening document_view.
begin;

alter table public.direct_entries
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by_user_id uuid references public.direct_entry_app_users(app_user_id)
    on delete restrict,
  add column if not exists void_reason_id uuid references public.direct_entry_restricted_reasons(reason_id)
    on delete restrict;

alter table public.direct_entries
  add constraint direct_entries_void_metadata_consistent check (
    (voided_at is null and voided_by_user_id is null and void_reason_id is null)
    or (voided_at is not null and voided_by_user_id is not null and void_reason_id is not null)
  );

create index direct_entries_active_submitted_not_voided
  on public.direct_entries (submission_id, entry_id)
  where deleted_at is null and voided_at is null;

alter table public.direct_entry_change_request_items
  drop constraint direct_entry_change_request_items_target_kind_check;
alter table public.direct_entry_change_request_items
  add constraint direct_entry_change_request_items_target_kind_check
  check (target_kind in ('ENTRY_FIELD', 'PAYMENT', 'WORK_STATUS', 'DOCUMENT', 'ENTRY_VOID'));

create or replace function public.direct_entry_assert_document_download_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_scope text;
begin
  -- Preserve the original draft guard. Only when it denies a submitted row do we
  -- allow the same bounded scope used by the S1 worker-detail projection.
  begin
    return public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, p_entry_owner, p_team_id, p_resource_scope_date
    );
  exception when insufficient_privilege then
    -- The worker directory currently exposes the ready contract download action.
    -- Keep every other document type on the original draft-only guard.
    if not exists (
      select 1
        from public.direct_entry_document_versions d
        join public.direct_entries e on e.candidate_id = d.candidate_id
       where e.entry_id = p_entry_id
         and d.document_id = p_document_id
         and d.document_type = 'EMPLOYMENT_CONTRACT'
    ) then
      raise exception 'document download scope denied' using errcode = '42501';
    end if;
    v_scope := public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, p_entry_id
    );
    if v_scope is null then
      raise exception 'document download scope denied' using errcode = '42501';
    end if;
    return v_scope;
  end;
end;
$$;

revoke all on function public.direct_entry_assert_document_download_access(
  uuid, uuid, uuid, uuid, uuid, uuid, date
) from public, anon, authenticated, service_role;

do $patch_download$
declare
  v_signature regprocedure :=
    'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure;
  v_definition text;
  v_replaced text;
  v_old constant text := $old$      perform public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );$old$;
  v_new constant text := $new$      perform public.direct_entry_assert_document_download_access(
        p_auth_subject, p_app_user_id, v_entry.entry_id, p_document_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if v_definition is null then
    raise exception 'document context function is missing' using errcode = '55000';
  end if;
  if position('direct_entry_assert_document_download_access' in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0
     or position('if p_purpose = ''download'' then' in v_definition) = 0
     or position('g.capability = ''document_view''' in v_definition) = 0 then
    raise exception 'document context download contract drift' using errcode = '55000';
  end if;
  v_replaced := replace(v_definition, v_old, v_new);
  if v_replaced = v_definition then
    raise exception 'document context download guard patch failed' using errcode = '55000';
  end if;
  execute v_replaced;

  select pg_get_functiondef(v_signature) into v_definition;
  if position('direct_entry_assert_document_download_access' in v_definition) = 0
     or position('g.capability = ''document_view''' in v_definition) = 0 then
    raise exception 'document context download guard verification failed' using errcode = '55000';
  end if;
end;
$patch_download$;

-- Keep a full before/after revision for voiding; never destroy the worker record.
do $patch_snapshot$
declare
  v_signature regprocedure := 'public.direct_entry_entry_snapshot(uuid)'::regprocedure;
  v_definition text;
  v_old constant text := $old$    'deleted_at', e.deleted_at,$old$;
  v_new constant text := $new$    'deleted_at', e.deleted_at,
    'voided_at', e.voided_at,
    'voided_by_user_id', e.voided_by_user_id,
    'void_reason_id', e.void_reason_id,$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('voided_by_user_id' in v_definition) > 0 then return; end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'entry snapshot contract drift' using errcode = '55000';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_snapshot$;

-- Allow the original submitter to request voiding their exact submitted row.
do $patch_void_scope$
declare
  v_signature regprocedure :=
    'public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)'::regprocedure;
  v_definition text;
  v_old constant text := $old$  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported'
      using errcode = '42501';
  end if;$old$;
  v_new constant text := $new$  if p_target_kind = 'ENTRY_VOID' then
    if v_entry.voided_at is not null
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
       )
       or v_entry.created_by_user_id is distinct from p_app_user_id
       or not public.direct_entry_has_capability(p_app_user_id, 'change_request_create') then
      raise exception 'entry void request access denied' using errcode = '42501';
    end if;
    return 'creator';
  end if;
  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported'
      using errcode = '42501';
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('p_target_kind = ''ENTRY_VOID''' in v_definition) > 0 then return; end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'change request scope contract drift' using errcode = '55000';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_void_scope$;

-- Extend the existing atomic request creator. ENTRY_VOID is deliberately one-row-only.
do $patch_void_create$
declare
  v_signature regprocedure :=
    'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure;
  v_definition text;
  v_replaced text;
  v_target_old constant text := $target_old$not in ('ENTRY_FIELD','PAYMENT','WORK_STATUS','DOCUMENT')$target_old$;
  v_target_new constant text := $target_new$not in ('ENTRY_FIELD','PAYMENT','WORK_STATUS','DOCUMENT','ENTRY_VOID')$target_new$;
  v_submission_old constant text := $old$    if v_submission_state <> 'SUBMITTED' then
      raise exception 'change requests require submitted entries' using errcode = '42501';
    end if;$old$;
  v_submission_new constant text := $new$    if v_submission_state <> 'SUBMITTED' then
      raise exception 'change requests require submitted entries' using errcode = '42501';
    end if;
    if v_item->>'target_kind' = 'ENTRY_VOID' and exists (
      select 1
        from public.direct_entry_change_request_items existing_item
        join public.direct_entry_change_requests existing_request
          on existing_request.request_id = existing_item.request_id
       where existing_item.entry_id = v_entry.entry_id
         and existing_item.target_kind = 'ENTRY_VOID'
         and existing_request.state = 'PENDING'
    ) then
      raise exception 'entry void request already pending' using errcode = '40001';
    end if;$new$;
  v_actor_old constant text := $actor_old$  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);$actor_old$;
  v_actor_new constant text := $actor_new$  if exists (select 1 from jsonb_array_elements(p_items) x(value)
       where x.value->>'target_kind' = 'ENTRY_VOID')
     and (jsonb_array_length(p_items) <> 1
       or (p_items->0->>'target_kind') <> 'ENTRY_VOID'
       or (p_items->0->'proposal') is distinct from '{}'::jsonb) then
    raise exception 'entry void request must contain exactly one empty-proposal item'
      using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);$actor_new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ENTRY_VOID' in v_definition) > 0 then return; end if;
  if length(v_definition) - length(replace(v_definition, v_target_old, '')) <> 2 * length(v_target_old)
     or position(v_submission_old in v_definition) = 0
     or position('jsonb_array_length(p_items) not between 1 and 100' in v_definition) = 0 then
    raise exception 'change request create contract drift' using errcode = '55000';
  end if;
  v_replaced := replace(v_definition, v_target_old, v_target_new);
  v_replaced := replace(v_replaced, v_submission_old, v_submission_new);
  -- Add the one-item and empty-proposal invariant directly after generic shape validation.
  if position(v_actor_old in v_replaced) = 0 then
    raise exception 'change request creator guard drift' using errcode = '55000';
  end if;
  v_replaced := replace(v_replaced, v_actor_old, v_actor_new);
  if v_replaced = v_definition then
    raise exception 'change request create patch failed' using errcode = '55000';
  end if;
  execute v_replaced;
end;
$patch_void_create$;

-- Normal BI surfaces treat an approved void as inactive; history remains in the source tables.
do $patch_void_consumers$
declare
  v_signature regprocedure;
  v_definition text;
  v_replaced text;
  v_old constant text := 'where e.deleted_at is null';
  v_new constant text := 'where e.deleted_at is null and e.voided_at is null';
begin
  foreach v_signature in array array[
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
    'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure,
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position('e.voided_at is null' in v_definition) > 0 then continue; end if;
    if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
      raise exception 'void consumer function contract drift: %', v_signature using errcode = '55000';
    end if;
    v_replaced := replace(v_definition, v_old, v_new);
    execute v_replaced;
  end loop;

  select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass, true)
    into v_definition;
  if position('e.voided_at IS NULL' in v_definition) = 0 then
    if length(v_definition) - length(replace(v_definition, 'e.deleted_at IS NULL', ''))
       <> length('e.deleted_at IS NULL') then
      raise exception 'reporting facts view contract drift' using errcode = '55000';
    end if;
    execute 'create or replace view public.direct_entry_reporting_facts_v01 as '
      || replace(v_definition, 'e.deleted_at IS NULL',
                 'e.deleted_at IS NULL AND e.voided_at IS NULL');
  end if;
end;
$patch_void_consumers$;

-- ENTRY_VOID reuses the generic reviewer queue but has its own authorized reviewer set.
do $patch_void_review_policy$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  v_signature := 'public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ENTRY_VOID reviewer policy' in v_definition) = 0 then
    v_old := $old$    v_team_leader_review:=public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null;$old$;
    v_new := $new$    -- ENTRY_VOID reviewer policy: only one exact row; team leader assignment or
    -- explicit all-scope Admin / BoD / Accounting capability is accepted.
    if exists (select 1 from public.direct_entry_change_request_items i
                where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') then
      if (select count(*) from public.direct_entry_change_request_items i
           where i.request_id=p_request_id) <> 1 then
        raise exception 'entry void request must contain one item' using errcode='42501';
      end if;
      if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null then
        perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'team_manager_assign');
        return;
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject,p_app_user_id);
      if not public.direct_entry_has_scope(p_app_user_id,'all')
         or not (
           public.direct_entry_has_capability(p_app_user_id,'entry_admin')
           or public.direct_entry_has_capability(p_app_user_id,'entry_privileged_edit')
           or public.direct_entry_has_capability(p_app_user_id,'change_review')
         ) then
        raise exception 'entry void review scope/capability denied' using errcode='42501';
      end if;
      return;
    end if;
    v_team_leader_review:=public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null;$new$;
    if position(v_old in v_definition) = 0 then
      raise exception 'change request reviewer capability contract drift' using errcode='55000';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  end if;

  v_signature := 'public.direct_entry_change_request_audience(uuid,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ENTRY_VOID audience policy' in v_definition) = 0 then
    v_old := $old$ if v_is_proposer then
   select count(*) into v_accessible from public.direct_entry_change_request_items i
$old$;
    v_new := $new$ if v_is_proposer then
   -- ENTRY_VOID audience policy keeps the original submitter's request visible in history.
   if exists(select 1 from public.direct_entry_change_request_items i
               where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') then
     select count(*) into v_accessible
       from public.direct_entry_change_request_items i
       join public.direct_entries e on e.entry_id=i.entry_id
       join public.direct_entry_submissions s on s.submission_id=e.submission_id
      where i.request_id=p_request_id and i.target_kind='ENTRY_VOID'
        and e.created_by_user_id=p_app_user_id and s.state='SUBMITTED';
     if v_accessible=v_items then return 'PROPOSER'; end if;
   end if;
   select count(*) into v_accessible from public.direct_entry_change_request_items i
$new$;
    if position(v_old in v_definition) = 0 then
      raise exception 'change request audience proposer contract drift' using errcode='55000';
    end if;
    v_definition := replace(v_definition, v_old, v_new);

    v_old := $old$   if public.direct_entry_has_capability(p_app_user_id,'change_review')
      and public.direct_entry_has_scope(p_app_user_id,'all') then return 'REVIEWER'; end if;$old$;
    v_new := $new$   if exists(select 1 from public.direct_entry_change_request_items i
       where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') then
     if public.direct_entry_has_scope(p_app_user_id,'all')
        and (public.direct_entry_has_capability(p_app_user_id,'change_review')
          or public.direct_entry_has_capability(p_app_user_id,'entry_privileged_edit')
          or public.direct_entry_has_capability(p_app_user_id,'entry_admin')) then return 'REVIEWER'; end if;
   elsif public.direct_entry_has_capability(p_app_user_id,'change_review')
      and public.direct_entry_has_scope(p_app_user_id,'all') then return 'REVIEWER'; end if;$new$;
    if position(v_old in v_definition) = 0 then
      raise exception 'change request audience reviewer contract drift' using errcode='55000';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$patch_void_review_policy$;

-- Apply the one-row void through the same revision/audit path as other reviewed changes.
do $patch_void_apply$
declare
  v_signature regprocedure :=
    'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('entry_void_apply_v1' in v_definition) > 0 then return; end if;

  v_old := $old$  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if v_team_review then
    v_scope := 'team';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;$old$;
  v_new := $new$  -- entry_void_apply_v1: keep the void-only reviewer grants separate from other changes.
  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if p_target_kind = 'ENTRY_VOID' then
    if v_team_review then
      perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'team_manager_assign');
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'entry_admin') then
      v_scope := 'all';
      v_review_capability := 'entry_admin';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'entry_privileged_edit') then
      v_scope := 'all';
      v_review_capability := 'entry_privileged_edit';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'change_review') then
      v_scope := 'all';
      v_review_capability := 'change_review';
    else
      raise exception 'entry void review scope/capability denied' using errcode='42501';
    end if;
  elsif v_team_review then
    v_scope := 'team';
    v_review_capability := 'team_manager_assign';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'apply change item reviewer contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  -- Add the mutation branch after the before-snapshot and before ENTRY_FIELD.
  v_old := $old$  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then$old$;
  v_new := $new$  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_VOID' then
    if p_proposal is distinct from '{}'::jsonb
       or p_entry.voided_at is not null
       or (select count(*) from public.direct_entry_change_request_items i
            where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') <> 1
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id=p_entry.submission_id and s.state='SUBMITTED'
       ) then
      raise exception 'entry void target is not active' using errcode='40001';
    end if;
    update public.direct_entries set
      voided_at=now(), voided_by_user_id=p_app_user_id, void_reason_id=v_reason_id,
      version=version+1
     where entry_id=p_entry.entry_id and voided_at is null;
    if not found then
      raise exception 'entry already voided' using errcode='40001';
    end if;
  elsif p_target_kind = 'ENTRY_FIELD' then$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'apply change item target contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$  v_scope text;$old$;
  v_new := $new$  v_scope text;
  v_review_capability text := 'change_review';$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'apply change item declaration contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$    auth_subject, app_user_id, action, capability, resource_ref,$old$;
  v_new := $new$    auth_subject, app_user_id, action, capability, resource_ref,$new$;
  -- Capability is selected from the server-verified branch above.
  v_old := $old$    p_auth_subject, p_app_user_id, 'change_request_approve', 'change_review',$old$;
  v_new := $new$    p_auth_subject, p_app_user_id, 'change_request_approve', v_review_capability,$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'apply change item audit contract drift' using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$patch_void_apply$;

-- The decision RPC enforces the special reviewer policy before any idempotency or mutation.
do $patch_void_decision$
declare
  v_signature regprocedure :=
    'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('entry_void_decision_v1' in v_definition) > 0 then return; end if;

  v_old := $old$  if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null then
    perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'team_manager_assign');
  else
    perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'change_review');
  end if;$old$;
  v_new := $new$  -- entry_void_decision_v1: capability is checked against the exact request below.
  perform public.direct_entry_assert_actor_mapping(p_auth_subject,p_app_user_id);$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision actor guard contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$  perform public.direct_entry_assert_change_request_capabilities(
    p_auth_subject, p_app_user_id, p_request_id
  );$old$;
  v_new := $new$  perform public.direct_entry_assert_change_request_capabilities(
    p_auth_subject, p_app_user_id, p_request_id
  );
  if exists(select 1 from public.direct_entry_change_request_items i
              where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') then
    v_audit_capability := case
      when public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is not null
        then 'team_manager_assign'
      when public.direct_entry_has_capability(p_app_user_id,'entry_admin') then 'entry_admin'
      when public.direct_entry_has_capability(p_app_user_id,'entry_privileged_edit') then 'entry_privileged_edit'
      else 'change_review' end;
  end if;$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision policy location drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$  v_revision_id uuid;$old$;
  v_new := $new$  v_revision_id uuid;
  v_audit_capability text := 'change_review';$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision declaration contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$  for v_item in
    select i.entry_id from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then
      if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
    end if;
  end loop;$old$;
  v_new := $new$  for v_item in
    select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    if v_item.target_kind <> 'ENTRY_VOID'
       and public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
  end loop;$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision read scope contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$  else
    for v_item in
      select i.entry_id from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      if public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
    end loop;
  end if;$old$;
  v_new := $new$  else
    for v_item in
      select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      if v_item.target_kind <> 'ENTRY_VOID'
         and public.direct_entry_team_leader_request_team(p_app_user_id,p_request_id) is null then
        perform public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'change_review',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end loop;
  end if;$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision rejection scope contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$      if not found or v_entry.deleted_at is not null
         or v_entry.version <> v_item.expected_version then$old$;
  v_new := $new$      if not found or v_entry.deleted_at is not null or v_entry.voided_at is not null
         or v_entry.version <> v_item.expected_version then$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision OCC contract drift' using errcode='55000';
  end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    'change_review', p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,$old$;
  v_new := $new$    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    v_audit_capability, p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'change decision audit contract drift' using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$patch_void_decision$;

do $patch_void_summary$
declare
  v_signature regprocedure :=
    'public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)'::regprocedure;
  v_definition text;
  v_replaced text;
  v_old constant text := $old$when 'DOCUMENT' then 'Tài liệu hồ sơ' else 'Yêu cầu thay đổi' end$old$;
  v_new constant text := $new$when 'DOCUMENT' then 'Tài liệu hồ sơ' when 'ENTRY_VOID' then 'Đề nghị hủy hồ sơ trùng' else 'Yêu cầu thay đổi' end$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ENTRY_VOID' in v_definition) > 0 then return; end if;
  if length(v_definition) - length(replace(v_definition, v_old, '')) <> 2 * length(v_old) then
    raise exception 'change request summary contract drift' using errcode='55000';
  end if;
  v_replaced := replace(v_definition,v_old,v_new);
  execute v_replaced;
end;
$patch_void_summary$;

commit;
