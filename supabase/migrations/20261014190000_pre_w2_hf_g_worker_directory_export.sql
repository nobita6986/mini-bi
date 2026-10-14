-- =============================================================================
-- PRE-W2-HF-G - Full worker-directory export within existing row authority.
--
-- Append-only policy hotfix to PRE-W2-P1/HF-E. Replaces only the existing
-- direct_entry_export_workers function; no schema/table changes, capability grants,
-- or business-row changes.
--
-- Recruited/managed exports retain the DB-verified recruiter-link / effective-PM
-- row boundary and full existing 19-column PII/payment projection, without a
-- separate pii_export/pii_view/payment_view grant. The company-wide all scope
-- retains the previous capability conjunction plus all-scope Admin/BoD/Accounting
-- audience. The client sends no authority; audit and row-cap behavior are retained.
-- =============================================================================

begin;

create or replace function public.direct_entry_export_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text default null,
  p_recruiter_id uuid default null,
  p_employment_status text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $export$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_scope_kind text;
  v_reason_id uuid;
  v_filter_hash text;
  v_total integer;
  v_rows jsonb;
begin
  -- 1. Scope: recruited | managed | all. Every other token fails closed before any read.
  if p_scope is null or p_scope not in ('recruited', 'managed', 'all') then
    raise exception 'worker export scope denied' using errcode = '42501';
  end if;

  -- 2. Company-wide export keeps the existing capability conjunction. For
  --    recruited/managed, the effective row audience below is the authorization
  --    boundary; no separate PII/payment export grant is required.
  if p_scope = 'all' and (
       not public.direct_entry_has_capability(p_app_user_id, 'pii_export')
       or not public.direct_entry_has_capability(p_app_user_id, 'pii_view')
       or not public.direct_entry_has_capability(p_app_user_id, 'payment_view')) then
    raise exception 'worker export capability denied' using errcode = '42501';
  end if;

  -- 3. Row authority: reuse the directory audience guard. For `all` this enforces
  --    the effective all-scope grant AND (entry_admin OR change_review); for
  --    recruited/managed it enforces the verified recruiter link / effective PM
  --    assignment. An unauthorized actor raises 42501 here, before any read.
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_recruiter_ids := case
    when jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  -- 4. Filters: mirror the directory semantics exactly.
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;

  -- 5. Mandatory reason (reuses the restricted-reasons table).
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- 6. One batch query, deterministic order, at most 10,001 candidates.
  with candidates as (
    select e.entry_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.provider_type,
           e.general_note,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           st.status as employment_status,
           st.leave_date,
           st.leave_reason_text,
           pay.account_number,
           pay.bank_name,
           pay.account_holder_name
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status, ev.leave_date, ev.leave_reason_text
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null
       and s.state = 'SUBMITTED'
       and (
         (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'all')
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
  ),
  bounded as (
    select * from candidates
     order by first_work_date desc, entry_id desc
     limit 10001
  )
  select coalesce((select count(*)::int from bounded), 0),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'employee_code', b.employee_code,
             'display_name', b.worker_details->>'display_name',
             'date_of_birth', case
               when b.worker_details->'date_of_birth'->>'state' = 'provided'
               then b.worker_details->'date_of_birth'->>'value' else null end,
             'national_id', case
               when b.worker_details->'national_id'->>'state' = 'provided'
               then b.worker_details->'national_id'->>'value' else null end,
             'phone', case
               when b.worker_details->'phone'->>'state' = 'provided'
               then b.worker_details->'phone'->>'value' else null end,
             'address', case
               when b.worker_details->'address'->>'state' = 'provided'
               then b.worker_details->'address'->>'value' else null end,
             'project_display', b.project_display,
             'first_work_date', pg_catalog.to_char(b.first_work_date, 'YYYY-MM-DD'),
             'labor_type_display', b.labor_type_display,
             'recruiter_display', b.recruiter_display,
             'provider_type', public.recruitment_provider_type_display(b.provider_type),
             'employment_status', b.employment_status,
             'leave_date', case when b.leave_date is null then null
               else pg_catalog.to_char(b.leave_date, 'YYYY-MM-DD') end,
             'leave_reason', b.leave_reason_text,
             'account_number', b.account_number,
             'bank_name', b.bank_name,
             'account_holder_name', b.account_holder_name,
             'payment_note', null,
             'general_note', b.general_note
           ) order by b.first_work_date desc, b.entry_id desc)
           from bounded b
         ), '[]'::jsonb)
    into v_total, v_rows;

  -- 7. Canonical, server-built filter hash (never embeds a raw filter value).
  v_filter_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'scope', p_scope,
    'project_id', p_project_id,
    'recruiter_id', p_recruiter_id,
    'employment_status', p_employment_status
  ));
  -- Raw scope token is never written as scope_kind.
  v_scope_kind := case
    when p_scope = 'recruited' then 'own'
    when p_scope = 'managed' then 'project'
    else 'all'
  end;

  -- 8. Row cap: 10,001 candidates means over the 10,000 limit. Persist the
  --    REJECTED access event, then return the strict non-PII envelope WITHOUT
  --    raising (a raise here would roll the audit back).
  if v_total > 10000 then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, denial_code, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'worker_export', 'pii_export',
      'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
      v_scope_kind, 'REJECTED', 'EXPORT_ROW_LIMIT_EXCEEDED', v_reason_id,
      array[]::text[]
    );
    return jsonb_build_object('status', 'too_many_rows', 'limit', 10000);
  end if;

  -- 9. Success: one immutable ALLOW access event (written once the PII rows are
  --    read; a later XLSX build/download failure does not undo it).
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, denial_code, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'worker_export', 'pii_export',
    'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
    v_scope_kind, 'ALLOW', null, v_reason_id, array[]::text[]
  );

  return jsonb_build_object('status', 'ok', 'rows', v_rows);
end;
$export$;
revoke all on function public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text)
  to service_role;
comment on function public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text) is
  'PRE-W2-HF-G full-PII worker export for recruited/managed rows authorized by the existing '
  'verified recruiter link or effective PM assignment. No export capability grant is required for '
  'those row-scoped audiences. The all scope still requires pii_export AND pii_view AND payment_view '
  'plus effective all scope and entry_admin or change_review (Admin / BoD / Accounting). Every '
  'other scope/token is denied with 42501 before any read. Reads at most 10,001 '
  'eligible SUBMITTED rows in one batch and returns {status:ok, rows:[...]} (<=10,000) or '
  '{status:too_many_rows, limit:10000} (10,001), writing one immutable ALLOW / REJECTED worker_export '
  'access event with scope_kind own|project|all and a non-PII resource_ref. Adds a trailing general_note '
  'column from direct_entries.general_note. service_role only.';

-- -----------------------------------------------------------------------------
-- Self-check (data-free: installs on an empty and a Production-shaped database).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_signature regprocedure :=
    'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure;
  v_count integer;
  v_source text;
  v_secdef boolean;
  v_config text[];
  v_rejected_pos integer;
  v_too_many_pos integer;
  v_after text;
begin
  -- 1. Exactly one function with this signature.
  select count(*)::int into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'direct_entry_export_workers';
  if v_count <> 1 then
    raise exception 'PRE-W2-HF-G expected exactly one export RPC, found %', v_count;
  end if;

  -- 2. SECURITY DEFINER + fixed search_path.
  select p.prosecdef, p.proconfig, replace(p.prosrc, chr(13), '')
    into v_secdef, v_config, v_source
    from pg_proc p where p.oid = v_signature;
  if v_secdef is null or not v_secdef
     or not (v_config @> array['search_path=pg_catalog, public']) then
    raise exception 'PRE-W2-HF-G export RPC must be SECURITY DEFINER with a fixed search_path';
  end if;

  -- 3. ACL: service_role only.
  if has_function_privilege('anon', v_signature, 'EXECUTE')
     or has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception 'PRE-W2-HF-G export RPC ACL self-check failed';
  end if;

  -- 4. Source locks: row audience remains the authority for every scope;
  --    only `all` keeps the capability conjunction; preserve projection, audit,
  --    strict envelope, and the non-raising row-cap path.
  if position('if p_scope = ''all'' and (' in v_source) = 0
     or position('direct_entry_has_capability(p_app_user_id, ''pii_export'')' in v_source) = 0
     or position('direct_entry_has_capability(p_app_user_id, ''pii_view'')' in v_source) = 0
     or position('direct_entry_has_capability(p_app_user_id, ''payment_view'')' in v_source) = 0
     or position('if not public.direct_entry_has_capability' in v_source) > 0 then
    raise exception 'PRE-W2-HF-G capability gate must apply only to all scope';
  end if;
  if position('direct_entry_worker_directory_audience' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the export does not reuse the directory audience guard';
  end if;
  if position('p_scope not in (''recruited'', ''managed'', ''all'')' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the all scope must be in the allowlist';
  end if;
  if position('or (v_scope = ''all'')' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the all candidate branch is missing';
  end if;
  if position('''general_note'', b.general_note' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the general_note projection is missing';
  end if;
  if position('''status'', ''ok''' in v_source) = 0
     or position('''rows''' in v_source) = 0
     or position('''status'', ''too_many_rows''' in v_source) = 0
     or position('''limit'', 10000' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the strict envelope keys are missing';
  end if;
  if position('when p_scope = ''recruited'' then ''own''' in v_source) = 0
     or position('when p_scope = ''managed'' then ''project''' in v_source) = 0
     or position('else ''all''' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the audit scope mapping (own/project/all) is missing';
  end if;
  if position('direct_entry_idempotency' in v_source) > 0
     or position('idempotency' in lower(v_source)) > 0 then
    raise exception 'PRE-W2-HF-G the export must not use idempotency';
  end if;
  if position('changed_fields' in v_source) = 0
     or position('array[]::text[]' in v_source) = 0 then
    raise exception 'PRE-W2-HF-G the export must keep changed_fields empty';
  end if;

  v_rejected_pos := position('EXPORT_ROW_LIMIT_EXCEEDED' in v_source);
  v_too_many_pos := position('''status'', ''too_many_rows''' in v_source);
  if v_rejected_pos = 0 or v_too_many_pos = 0 or v_too_many_pos < v_rejected_pos then
    raise exception 'PRE-W2-HF-G the cap branch does not return too_many_rows after the audit';
  end if;
  -- No raise between the REJECTED audit and the too_many_rows return.
  v_after := substr(v_source, v_rejected_pos, v_too_many_pos - v_rejected_pos);
  if position('raise' in lower(v_after)) > 0 then
    raise exception 'PRE-W2-HF-G the cap branch raises after the audit';
  end if;

  raise notice 'PRE-W2-HF-G migration self-check OK (worker export RPC)';
end;
$check$;

commit;
