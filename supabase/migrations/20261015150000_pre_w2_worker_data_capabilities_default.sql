-- Make worker PII, payment-view and Excel-export capabilities the default for
-- every mapped application account without changing any scope grant.

lock table public.direct_entry_app_users in share row exclusive mode;

do $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_user record;
  v_capability text;
  v_existing record;
  v_cursor date;
begin
  -- Fill gaps in each account's grant history from today onward. Existing grants
  -- and their recorded boundaries remain unchanged; gaps receive the new default.
  for v_user in
    select u.app_user_id
      from public.direct_entry_app_users u
     order by u.app_user_id
  loop
    foreach v_capability in array array['pii_view', 'payment_view', 'pii_export']::text[]
    loop
      v_cursor := v_today;
      for v_existing in
        select g.valid_from, g.valid_to
          from public.direct_entry_capability_grants g
         where g.app_user_id = v_user.app_user_id
           and g.capability = v_capability
           and (g.valid_to is null or g.valid_to > v_today)
         order by g.valid_from
      loop
        if v_existing.valid_from > v_cursor then
          insert into public.direct_entry_capability_grants
            (app_user_id, capability, valid_from, valid_to)
          values
            (v_user.app_user_id, v_capability, v_cursor, v_existing.valid_from);
          insert into public.direct_entry_audit_events
            (action, capability, resource_ref, outcome, changed_fields)
          values
            ('capability_default_grant', v_capability, v_user.app_user_id::text,
             'APPLIED', array['valid_from', 'valid_to']);
        end if;

        if v_existing.valid_to is null then
          v_cursor := null;
          exit;
        end if;
        if v_existing.valid_to > v_cursor then
          v_cursor := v_existing.valid_to;
        end if;
      end loop;

      if v_cursor is not null then
        insert into public.direct_entry_capability_grants
          (app_user_id, capability, valid_from)
        values (v_user.app_user_id, v_capability, v_cursor);
        insert into public.direct_entry_audit_events
          (action, capability, resource_ref, outcome, changed_fields)
        values
          ('capability_default_grant', v_capability, v_user.app_user_id::text,
           'APPLIED', array['valid_from', 'valid_to']);
      end if;
    end loop;
  end loop;
end;
$$;

-- New accounts created through the existing Full Admin saga receive the same
-- baseline in the account-creation transaction. No scope is created here.
create or replace function public.direct_entry_account_operation_finalize_create(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_intent_token uuid,
  p_created_auth_subject uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
  v_capability text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'intent_id', p_intent_id, 'intent_token', p_intent_token,
    'auth_subject', p_created_auth_subject
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' then
    raise exception 'account operation kind mismatch' using errcode = '22023';
  end if;

  -- Terminal first: APPLIED/FAILED/EXPIRED/BLOCKED/CONFLICT are immutable.
  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    v_prior := jsonb_build_object(
      'intent_id', v_intent.intent_id,
      'intent_state', v_intent.state,
      'account_ref', v_intent.account_ref
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;
  if v_intent.state not in ('IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'account operation is not claimable' using errcode = '22023';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED', resolved_at = now(), updated_at = now()
     where intent_id = p_intent_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
    ) values (
      p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
      p_intent_id::text, 'all', 'REJECTED', 'provenance_mismatch', v_intent.reason_id
    );
    v_prior := jsonb_build_object(
      'intent_id', p_intent_id, 'intent_state', 'BLOCKED', 'account_ref', null
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;

  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name)
  values (p_created_auth_subject, true, v_intent.display_name)
  returning * into v_app_user;

  foreach v_capability in array array['pii_view', 'payment_view', 'pii_export']::text[]
  loop
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from)
    values (
      v_app_user.app_user_id, v_capability,
      public.direct_entry_authorization_date()
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
      v_app_user.app_user_id::text, 'APPLIED', v_reason_id,
      array['valid_from', 'valid_to']
    );
  end loop;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id, v_app_user.version, p_actor_app_user_id, v_action,
    null, jsonb_build_object('display_name', v_app_user.display_name, 'enabled', true), v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_app_user.app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['auth_subject', 'enabled', 'display_name'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED', resolved_at = now(), updated_at = now(),
         auth_subject = p_created_auth_subject,
         account_ref = v_app_user.app_user_id
   where intent_id = p_intent_id;

  v_prior := jsonb_build_object(
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'display_name', v_app_user.display_name,
    'version', v_app_user.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id,
    'intent_state', 'APPLIED'
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$$;
revoke all on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  to service_role;

do $$
declare
  v_source text := pg_get_functiondef(
    'public.direct_entry_account_operation_finalize_create(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure
  );
begin
  if position('pii_view' in v_source) = 0
     or position('payment_view' in v_source) = 0
     or position('pii_export' in v_source) = 0
     or position('direct_entry_scope_grants' in v_source) <> 0
     or position('security definer' in lower(v_source)) = 0 then
    raise exception 'default worker-data capability account-create self-check failed';
  end if;
end;
$$;
