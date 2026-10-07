-- =============================================================================
-- P2.5-W04 - Change-request audience/read/withdraw policy closure (#53).
--
-- Policy T0 da khoa (khong tu thay doi):
--   1. Propose SUBMITTED chi theo project-manager assignment hieu luc
--      (da dong boi #51 o direct_entry_resolve_change_request_scope; migration
--       nay chi xac nhan lai qua self-check, khong mo lai).
--   2. Protected fields KHONG duoc doi o CREATE hoac APPLY:
--      project/employee identity (project_id, employee_code), first_work_date,
--      recruiter_id, labor_type. ENTRY_FIELD change request chi con duoc doi
--      worker_details; mot worker_details voi display_name gia mao (rong/khong
--      hop le) bi tu choi NGAY TAI CREATE va APPLY.
--   3. Payment/status tren SUBMITTED khong duoc sua truc tiep: chi DRAFT duoc
--      ghi truc tiep; SUBMITTED/REVIEW chi doi qua approval engine (canonical).
--      Giua nguyen: reason, OCC, idempotency, no-self-review, immutable audit,
--      all-or-nothing va gioi han DOCUMENT/CCCD.
--
-- Khong doi migration #1-#52. Khong them capability/table. Khong cap EXECUTE
-- cho helper noi bo. Khong deployment nao duoc thuc hien boi migration nay.
-- =============================================================================

begin;

-- Private transaction-scoped source patch helper (same contract as the #50
-- helper): patches only exact, uniquely matched fragments and rechecks the
-- SECURITY DEFINER / ACL boundary after each patch.
create function public.direct_entry_w04_replace_proc_source(
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
    raise exception 'P2.5-W04 invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'P2.5-W04 source function not found: %', p_signature;
  end if;
  if position(E'
' in v_source) > 0 then
    v_expected := replace(v_expected, E'
', E'
');
    v_replacement := replace(v_replacement, E'
', E'
');
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) /
    length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-W04 expected % exact source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-W04 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);

  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'P2.5-W04 changed function security boundary: %', p_signature;
  end if;
end;
$$;
revoke all on function public.direct_entry_w04_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policy 2a: CREATE (propose) - narrow ENTRY_FIELD allowlist to worker_details.
-- ---------------------------------------------------------------------------
select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'
          ]) <> '{}'::jsonb)$old$,
  $new$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'worker_details'
          ]) <> '{}'::jsonb)$new$,
  1
);

-- Reject a forged worker identity (empty/invalid display_name) at CREATE.
select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
      raise exception 'unsupported change proposal field' using errcode = '22023';
    end if;
    select * into v_entry from public.direct_entries
     where entry_id = (v_item->>'entry_id')::uuid and deleted_at is null;$old$,
  $new$
      raise exception 'unsupported change proposal field' using errcode = '22023';
    end if;
    if v_item->>'target_kind' = 'ENTRY_FIELD'
       and v_item->'proposal' ? 'worker_details'
       and not public.direct_entry_valid_worker_details(v_item->'proposal'->'worker_details') then
      raise exception 'forged worker identity rejected' using errcode = '22023';
    end if;
    select * into v_entry from public.direct_entries
     where entry_id = (v_item->>'entry_id')::uuid and deleted_at is null;$new$,
  1
);

-- ---------------------------------------------------------------------------
-- Policy 2b: APPLY - narrow ENTRY_FIELD allowlist to worker_details + validate.
-- ---------------------------------------------------------------------------
select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;$old$,
  $new$
    if (p_proposal - array['worker_details']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    if p_proposal ? 'worker_details'
       and not public.direct_entry_valid_worker_details(p_proposal->'worker_details') then
      raise exception 'forged worker identity rejected' using errcode = '22023';
    end if;$new$,
  1
);

-- ---------------------------------------------------------------------------
-- Policy 3: direct payment write is DRAFT-only; SUBMITTED changes only via the
-- approval engine (direct_entry_apply_change_item).
-- ---------------------------------------------------------------------------
select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)'::regprocedure,
  $old$
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access($old$,
  $new$
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state <> 'DRAFT' then
    raise exception 'payment edits require a draft entry' using errcode = '42501';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access($new$,
  1
);

-- ---------------------------------------------------------------------------
-- Policy 3: direct employment-status write is DRAFT-only.
-- ---------------------------------------------------------------------------
select public.direct_entry_w04_replace_proc_source(
  'public.direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)'::regprocedure,
  $old$
  perform public.direct_entry_assert_not_review(v_entry.submission_id);
  v_prior := public.direct_entry_idempotency_begin($old$,
  $new$
  perform public.direct_entry_assert_not_review(v_entry.submission_id);
  if not exists (
    select 1 from public.direct_entry_submissions s
     where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
  ) then
    raise exception 'employment status edits require a draft entry' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin($new$,
  1
);

drop function public.direct_entry_w04_replace_proc_source(regprocedure,text,text,integer);

-- ---------------------------------------------------------------------------
-- Self-check: the W04 policy must be installed; otherwise fail the migration.
-- ---------------------------------------------------------------------------
do $p2_5_w04$
declare
  v_apply text;
  v_create text;
  v_payment text;
  v_status text;
begin
  select p.prosrc into v_apply from pg_proc p
   where p.oid = 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  select p.prosrc into v_create from pg_proc p
   where p.oid = 'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure;
  select p.prosrc into v_payment from pg_proc p
   where p.oid = 'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)'::regprocedure;
  select p.prosrc into v_status from pg_proc p
   where p.oid = 'public.direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)'::regprocedure;

  if v_apply is null or v_create is null or v_payment is null or v_status is null then
    raise exception 'P2.5-W04 target function missing';
  end if;
  if position('forged worker identity rejected' in v_create) = 0
     or position('forged worker identity rejected' in v_apply) = 0 then
    raise exception 'P2.5-W04 protected-field policy not installed';
  end if;
  if position('payment edits require a draft entry' in v_payment) = 0
     or position('employment status edits require a draft entry' in v_status) = 0 then
    raise exception 'P2.5-W04 direct-write denial not installed';
  end if;
end;
$p2_5_w04$;

commit;
