-- P2.5-W05-R1 - Review capability matrix + create-time worker_details contract (#56).
--
-- Base: feature/p2-5-w05-review-authority@f206639 (post #55).
--
-- FINDING 1 - approval capability matrix (T0 lock):
--   ENTRY_FIELD                        : change_review
--   ENTRY_FIELD with worker_details    : change_review + pii_view
--   PAYMENT                            : change_review + payment_view (NO payment_edit)
--   WORK_STATUS                        : change_review (NO employment_status.apply)
--   DOCUMENT                           : unchanged (change_review + document_view +
--                                        document_upload) and deliberately NOT opened
--                                        to the W05 bundle.
--   The reviewer still needs an effective all scope grant (asserted in #55 before any
--   mutation). payment_edit / employment_status.apply keep their DRAFT direct-write
--   authority (direct_entry_update_payment, direct_entry_apply_employment_status,
--   full-profile batch) and every W04 guard stays in place: nothing here re-opens a
--   direct write on SUBMITTED.
--
-- FINDING 2 - a worker_details proposal must be appliable when it is accepted:
--   direct_entry_w04_worker_details_allowed() now also applies the canonical
--   validator the table check uses (direct_entry_valid_worker_details), so a partial or
--   malformed worker_details is rejected 22023 inside the CREATE validation loop,
--   before the request row, the item rows, the reason, the idempotency record or any
--   audit event exist. The APPLY validator is unchanged and strengthened, never
--   weakened.
--
-- Reuse: the canonical worker_details validator, direct_entry_has_capability, the
-- existing engine (reason/OCC/idempotency/no-self-review/all-or-nothing/immutable
-- audit). No new capability token, no new workflow/RBAC, no dependency.

begin;

-- -----------------------------------------------------------------------------
-- 1. Required capabilities per request (the review matrix).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_change_request_required_capabilities(
  p_request_id uuid
)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select array(
    select distinct required.capability
      from (
        select 'change_review'::text as capability
        union all
        select case
                 when i.target_kind = 'PAYMENT' then 'payment_view'
                 when i.target_kind = 'DOCUMENT' then 'document_view'
                 when i.target_kind = 'ENTRY_FIELD' and (i.proposal ? 'worker_details') then 'pii_view'
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
        union all
        select case
                 when i.target_kind = 'DOCUMENT' then 'document_upload'
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
      ) required
     where required.capability is not null
     order by required.capability
  );
$$;
revoke all on function public.direct_entry_change_request_required_capabilities(uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_change_request_required_capabilities(uuid) is
  'P2.5-W05-R1 review matrix: change_review always; + pii_view for worker_details items; '
  '+ payment_view for PAYMENT; DOCUMENT keeps document_view + document_upload and stays closed '
  'to the W05 reviewer bundle. The apply-side tokens payment_edit and employment_status.apply are '
  'never required to review.';

-- -----------------------------------------------------------------------------
-- 2. worker_details proposals must satisfy the canonical contract at CREATE.
-- -----------------------------------------------------------------------------
-- Same allowlist as P2.5-W04, plus the validator that backs
-- direct_entries_worker_details_check. SECURITY DEFINER + pinned search_path so the
-- validator stays reachable for the granted service_role caller as well.
create or replace function public.direct_entry_w04_worker_details_allowed(p_worker_details jsonb)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_worker_details is not null
     and jsonb_typeof(p_worker_details) = 'object'
     and (p_worker_details - array[
           'display_name','gender','date_of_birth','national_id',
           'national_id_issued_at','national_id_issued_place','address','phone'
         ]) = '{}'::jsonb
     and public.direct_entry_valid_worker_details(p_worker_details);
$$;
revoke all on function public.direct_entry_w04_worker_details_allowed(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_w04_worker_details_allowed(jsonb) to service_role;
comment on function public.direct_entry_w04_worker_details_allowed(jsonb) is
  'P2.5-W04 + W05-R1: an allowed worker_details proposal is one the canonical contract can '
  'apply - permitted keys only AND direct_entry_valid_worker_details() true - so a partial or '
  'malformed proposal is refused at CREATE instead of leaving an unappliable PENDING request.';

-- -----------------------------------------------------------------------------
-- 3. Apply-side defense in depth follows the same matrix.
-- -----------------------------------------------------------------------------
create function public.direct_entry_w05r1_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-W05-R1 invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'P2.5-W05-R1 source function not found: %', p_signature; end if;
  if position(chr(13) || chr(10) in v_source) > 0 then
    v_expected := replace(v_expected, chr(10), chr(13) || chr(10));
    v_replacement := replace(v_replacement, chr(10), chr(13) || chr(10));
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-W05-R1 expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-W05-R1 could not reconstruct function definition: %', p_signature;
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
  ) then raise exception 'P2.5-W05-R1 changed function security boundary: %', p_signature; end if;
end;
$$;
revoke all on function public.direct_entry_w05r1_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

select public.direct_entry_w05r1_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
  -- Policy T0: capability bo sung theo target kind/proposal, kiem truoc khi ghi bat cu thu gi.
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal ? 'worker_details')
       and not public.direct_entry_has_capability(p_app_user_id, 'pii_view') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'PAYMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'payment_view')
            and public.direct_entry_has_capability(p_app_user_id, 'payment_edit')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'WORK_STATUS' then
    if not public.direct_entry_has_capability(p_app_user_id, 'employment_status.apply') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'DOCUMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'document_view')
            and public.direct_entry_has_capability(p_app_user_id, 'document_upload')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;$old$,
  $new$
  -- P2.5-W05-R1 matrix: review needs the capability to SEE the data it decides, never
  -- the apply-side token. The all-scope review lock is asserted by the decision path
  -- (#55) before this helper runs, and DRAFT direct writes keep their own capabilities.
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal ? 'worker_details')
       and not public.direct_entry_has_capability(p_app_user_id, 'pii_view') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'PAYMENT' then
    if not public.direct_entry_has_capability(p_app_user_id, 'payment_view') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'DOCUMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'document_view')
            and public.direct_entry_has_capability(p_app_user_id, 'document_upload')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;$new$,
  1
);

drop function public.direct_entry_w05r1_replace_proc_source(regprocedure,text,text,integer);

-- -----------------------------------------------------------------------------
-- 4. Self-check.
-- -----------------------------------------------------------------------------
do $p2_5_w05_r1$
declare
  v_source text;
  v_complete jsonb := jsonb_build_object(
    'display_name', 'Synthetic W05R1',
    'date_of_birth', jsonb_build_object('state', 'unknown'),
    'national_id', jsonb_build_object('state', 'unknown'),
    'address', jsonb_build_object('state', 'unknown'),
    'phone', jsonb_build_object('state', 'unknown')
  );
begin
  -- 1. The matrix no longer demands the apply-side tokens, and keeps DOCUMENT closed.
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_change_request_required_capabilities(uuid)'::regprocedure;
  if position('pii_view' in v_source) = 0 or position('payment_view' in v_source) = 0 then
    raise exception 'P2.5-W05-R1 matrix lost a view capability';
  end if;
  if position('payment_edit' in v_source) > 0
     or position('employment_status.apply' in v_source) > 0 then
    raise exception 'P2.5-W05-R1 matrix still requires an apply-side token';
  end if;
  if position('document_view' in v_source) = 0 or position('document_upload' in v_source) = 0 then
    raise exception 'P2.5-W05-R1 DOCUMENT policy changed';
  end if;

  -- 2. The apply helper follows the same matrix and keeps DOCUMENT closed.
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  if position('payment_view' in v_source) = 0 or position('pii_view' in v_source) = 0
     or position('document_view' in v_source) = 0
     or position('document_upload' in v_source) = 0 then
    raise exception 'P2.5-W05-R1 apply helper lost a required view capability';
  end if;
  if position('payment_edit' in v_source) > 0
     or position('employment_status.apply' in v_source) > 0 then
    raise exception 'P2.5-W05-R1 apply helper still requires an apply-side token';
  end if;

  -- 3. worker_details is appliable exactly when it is accepted.
  if public.direct_entry_w04_worker_details_allowed(v_complete) is not true then
    raise exception 'P2.5-W05-R1 rejected a canonical worker_details';
  end if;
  if public.direct_entry_w04_worker_details_allowed(
       jsonb_build_object('gender', 'MALE')
     ) is not false then
    raise exception 'P2.5-W05-R1 accepted a partial worker_details';
  end if;
  if public.direct_entry_w04_worker_details_allowed(
       v_complete || jsonb_build_object('nope', 1)
     ) is not false then
    raise exception 'P2.5-W05-R1 accepted an unknown worker_details key';
  end if;
  if public.direct_entry_w04_worker_details_allowed(null) is not false then
    raise exception 'P2.5-W05-R1 accepted a null worker_details';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure;
  if position('direct_entry_w04_worker_details_allowed' in v_source) = 0 then
    raise exception 'P2.5-W05-R1 create path lost the worker_details contract check';
  end if;
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_w04_worker_details_allowed(jsonb)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
  ) then
    raise exception 'P2.5-W05-R1 worker_details guard lost its security boundary';
  end if;

  raise notice 'P2.5-W05-R1 migration self-check OK (review matrix + create-time worker_details contract)';
end
$p2_5_w05_r1$;

commit;
