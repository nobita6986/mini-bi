-- P2.5-W05 - Review authority backend (#55).
--
-- Base: origin/main@17ec4b770776b78ef68f73bc59430e0c78192659
--       (P2.5-W02 #51 + W03 #52 + W04 #53 + W06A #54).
--
-- DELTA
--  1. Review authority is capability change_review AND an effective all scope grant.
--     It replaces the own/team/all scope match of C01-R2 for BOTH the reviewer
--     audience (list/detail visibility) and the decision path (approve/reject), so a
--     team/own-scoped actor can no longer read or decide a change request, and no
--     role/email/reporting audience/created_by can substitute for the grants.
--     Read-only Production evidence: exactly one enabled account holds an effective
--     change_review grant and that account already holds an effective all scope
--     grant, so the lock removes no existing reviewer.
--  2. The reviewer bundle is DECLARED here and granted to nobody:
--     change_review + pii_view + payment_view. The apply-side and export tokens
--     (payment_edit, employment_status.apply, document_view, document_upload,
--     entry_privileged_edit, pii_export) stay outside the bundle, so a reviewer can
--     review PII/payment proposals without holding direct-mutation or export power.
--     A T0-designated app_user_id is still required before any grant is written.
--  3. The W03 worker directory now serves allowed_actions.propose_change from the W04
--     server authority (an effective project-manager assignment on the SUBMITTED row)
--     instead of the PROPOSE_PENDING_W04_POLICY placeholder. Migration #52 is not
--     modified; its self-check stays valid for its own apply step.
--
-- Reuse: existing change-request engine, reason/OCC/idempotency/immutable audit,
-- direct_entry_has_capability, the W07B/W02 assignment predicate. No new capability
-- token, no second workflow or RBAC layer, no new dependency.

begin;

-- -----------------------------------------------------------------------------
-- 1. Scope reader: the boolean twin of direct_entry_has_capability.
-- -----------------------------------------------------------------------------
-- Reviewer authority needs the same "effective grant today" semantics the
-- capability reader already uses, so it is expressed once here instead of
-- duplicating the interval predicate in every caller.
create or replace function public.direct_entry_has_scope(
  p_app_user_id uuid,
  p_scope_kind text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_app_user_id is not null
     and p_scope_kind in ('own', 'team', 'all')
     and exists (
           select 1 from public.direct_entry_app_users u
            where u.app_user_id = p_app_user_id and u.enabled
         )
     and exists (
           select 1 from public.direct_entry_scope_grants s
            where s.app_user_id = p_app_user_id
              and s.scope_kind = p_scope_kind
              and s.valid_from <= public.direct_entry_authorization_date()
              and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to)
         );
$$;
revoke all on function public.direct_entry_has_scope(uuid, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_has_scope(uuid, text) is
  'P2.5-W05 internal: true when the enabled app user holds an effective scope grant of the '
  'given kind. Never granted to any role; reviewers are resolved through the W05 all-scope lock.';

-- -----------------------------------------------------------------------------
-- 2. Decision path: approve/reject require change_review + an effective all scope.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_change_request_capabilities(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability text;
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'change_review');
  -- P2.5-W05: review is an all-scope decision. Checked before any idempotency
  -- record or mutation, so a denied review leaves no partial state.
  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'change review requires all scope' using errcode = '42501';
  end if;
  for v_capability in
    select capability
      from unnest(
        public.direct_entry_change_request_required_capabilities(p_request_id)
      ) as required(capability)
  loop
    if not public.direct_entry_has_capability(p_app_user_id, v_capability) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end loop;
end;
$$;
revoke all on function public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid) is
  'P2.5-W04 + W05: review needs change_review, an effective all scope grant, and every per-target '
  'capability the request items require (pii_view / payment_view / payment_edit / '
  'employment_status.apply / document_view + document_upload). Raised before any mutation.';

-- -----------------------------------------------------------------------------
-- 3. Reviewer audience: visibility follows the same authority as the decision.
-- -----------------------------------------------------------------------------
-- The proposer leg is unchanged from P2.5-W04 (#53): assignment-only authority on a
-- SUBMITTED entry. Only the reviewer leg changes, from the C01-R2 own/team/all match
-- to the W05 all-scope lock.
create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid, p_proposer_user_id uuid, p_request_id uuid
) returns text language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_items integer; v_accessible integer; v_is_proposer boolean;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_is_proposer := p_proposer_user_id = p_app_user_id;
  select count(*) into v_items from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then return 'NONE'; end if;
  select count(*) into v_accessible
    from public.direct_entry_change_request_items i
    join public.direct_entries e on e.entry_id = i.entry_id
   where i.request_id = p_request_id
     and case
       when v_is_proposer then
         public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
         and exists (
           select 1 from public.direct_entry_submissions s
            where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
         )
       else
         public.direct_entry_has_capability(p_app_user_id, 'change_review')
         and public.direct_entry_has_scope(p_app_user_id, 'all')
     end;
  if v_accessible <> v_items then return 'NONE'; end if;
  return case when v_is_proposer then 'PROPOSER' else 'REVIEWER' end;
end;
$$;
revoke all on function public.direct_entry_change_request_audience(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_change_request_audience(uuid,uuid,uuid) is
  'P2.5-W05: PROPOSER audience is the effective project-manager assignment (W04); REVIEWER '
  'audience requires change_review plus an effective all scope grant. Team/own scope, a role, '
  'an email, a reporting audience and created_by never make an actor a reviewer.';

-- -----------------------------------------------------------------------------
-- 4. Reviewer bundle: declared, granted to nobody.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reviewer_bundle_capabilities()
returns text[]
language sql
immutable
as $$
  -- change_review   : the decision capability itself;
  -- pii_view        : see worker_details proposals (the engine requires it to decide them);
  -- payment_view    : see payment proposals (masked without it; the engine also
  --                   requires payment_edit to APPLY a payment item, which stays out).
  -- Deliberately absent: payment_edit, employment_status.apply, document_view,
  -- document_upload, entry_privileged_edit, pii_export.
  select array['change_review', 'pii_view', 'payment_view']::text[];
$$;
revoke all on function public.direct_entry_reviewer_bundle_capabilities()
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_reviewer_bundle_capabilities() to service_role;
comment on function public.direct_entry_reviewer_bundle_capabilities() is
  'P2.5-W05 reviewer bundle (capabilities only; the bundle is applied AT all scope). Declared so '
  'an operator seed can use it, never granted to an account by this migration: T0 names the '
  'app_user_id first. Excludes every direct-mutation, apply and export token.';

-- -----------------------------------------------------------------------------
-- 5. W03 directory: serve propose_change from the W04 authority.
-- -----------------------------------------------------------------------------
-- #52 is not modified. The exact fragment is replaced in place with a fail-closed
-- matcher (same tool P2.5-W04 used) so a drifted source aborts the migration rather
-- than silently keeping the placeholder.
create function public.direct_entry_w05_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-W05 invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'P2.5-W05 source function not found: %', p_signature; end if;
  if position(chr(13) || chr(10) in v_source) > 0 then
    v_expected := replace(v_expected, chr(10), chr(13) || chr(10));
    v_replacement := replace(v_replacement, chr(10), chr(13) || chr(10));
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-W05 expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-W05 could not reconstruct function definition: %', p_signature;
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
  ) then raise exception 'P2.5-W05 changed function security boundary: %', p_signature; end if;
end;
$$;
revoke all on function public.direct_entry_w05_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

select public.direct_entry_w05_replace_proc_source(
  'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'::regprocedure,
  $old$
               'allowed_actions', jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 'propose_change', false,
                 'propose_change_code', 'PROPOSE_PENDING_W04_POLICY'
               )$old$,
  $new$
               'allowed_actions', jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 -- P2.5-W05: W04 #53 closed the propose policy, so the directory serves
                 -- the live server authority instead of a placeholder: an effective
                 -- project-manager assignment on this SUBMITTED row. The column
                 -- "is_project_manager" above stays the same predicate.
                 'propose_change',
                   public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
                 'propose_change_code', case
                   when public.direct_entry_actor_is_assigned_project_manager(
                     p_app_user_id, t.project_id
                   ) then null
                   else 'NOT_PROJECT_MANAGER'
                 end
               )$new$,
  1
);

drop function public.direct_entry_w05_replace_proc_source(regprocedure,text,text,integer);

-- -----------------------------------------------------------------------------
-- 6. Self-check.
-- -----------------------------------------------------------------------------
do $p2_5_w05$
declare
  v_source text;
  v_bundle text[];
begin
  -- 1. The decision path and the reviewer audience both carry the all-scope lock.
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid)'::regprocedure;
  if position('direct_entry_has_scope' in v_source) = 0 then
    raise exception 'P2.5-W05 decision path lost the all-scope review lock';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_change_request_audience(uuid,uuid,uuid)'::regprocedure;
  if position('direct_entry_has_scope' in v_source) = 0
     or position('direct_entry_has_entry_access' in v_source) > 0 then
    raise exception 'P2.5-W05 reviewer audience is not the all-scope lock';
  end if;
  if position('direct_entry_actor_is_assigned_project_manager' in v_source) = 0 then
    raise exception 'P2.5-W05 lost the W04 assignment-only proposer audience';
  end if;

  -- 2. The bundle is exactly the declared review set, and nothing else.
  v_bundle := public.direct_entry_reviewer_bundle_capabilities();
  if v_bundle <> array['change_review', 'pii_view', 'payment_view']::text[] then
    raise exception 'P2.5-W05 reviewer bundle changed: %', v_bundle;
  end if;
  if v_bundle && array[
       'payment_edit', 'employment_status.apply', 'document_view', 'document_upload',
       'entry_privileged_edit', 'pii_export'
     ]::text[] then
    raise exception 'P2.5-W05 reviewer bundle must not carry apply/export capabilities';
  end if;

  -- 3. The directory now serves the W04 authority, not the placeholder.
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'::regprocedure;
  if position('PROPOSE_PENDING_W04_POLICY' in v_source) > 0 then
    raise exception 'P2.5-W05 directory still advertises the W04 placeholder';
  end if;
  if position('direct_entry_actor_is_assigned_project_manager' in v_source) = 0 then
    raise exception 'P2.5-W05 directory propose_change is not derived from the assignment';
  end if;

  -- 4. ACL: the scope reader is internal, the bundle reader is service-role only.
  if has_function_privilege('anon', 'public.direct_entry_has_scope(uuid, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_has_scope(uuid, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('service_role', 'public.direct_entry_has_scope(uuid, text)'::regprocedure, 'EXECUTE') then
    raise exception 'P2.5-W05 scope reader must stay revoked from every role';
  end if;
  if not has_function_privilege('service_role', 'public.direct_entry_reviewer_bundle_capabilities()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_reviewer_bundle_capabilities()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_reviewer_bundle_capabilities()'::regprocedure, 'EXECUTE') then
    raise exception 'P2.5-W05 reviewer bundle reader ACL failed';
  end if;

  -- 5. This migration grants nothing to any account.
  raise notice 'P2.5-W05 migration self-check OK (all-scope review authority + declared reviewer bundle)';
end
$p2_5_w05$;

commit;
