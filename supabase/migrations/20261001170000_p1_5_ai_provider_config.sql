-- P1.5-W04A — Provider config store (versioned, encrypted envelope, audit, RLS) + freeze config vào job.
--
-- Phạm vi: CHỈ schema + RPC cho cấu hình provider AI (DEV). KHÔNG chứa secret plaintext, KHÔNG gọi provider.
-- Security:
--   * RLS bật trên mọi bảng mới; revoke PUBLIC/anon/authenticated; chỉ service_role (server boundary).
--   * Envelope là jsonb ĐÃ mã hoá (AES-256-GCM ở application); DB kiểm SHAPE + binding, không giữ plaintext.
--   * Audit append-only (trigger + revoke update/delete/truncate).
--   * Mutation + audit nằm trong CÙNG transaction (một hàm plpgsql).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
--
-- ROLLBACK (chạy tay, thứ tự ngược):
--   drop function if exists public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer);
--   -- (khôi phục bản 16 tham số từ migration 20261001160300)
--   alter table public.ai_report_jobs drop column if exists provider_config_version;
--   alter table public.ai_report_jobs drop column if exists provider_config_id;
--   drop function if exists public.ai_provider_config_active();
--   drop function if exists public.ai_provider_config_version(text, integer);
--   drop function if exists public.ai_provider_config_current(text);
--   drop function if exists public.ai_provider_config_rejected(text, integer, text, text);
--   drop function if exists public.ai_provider_config_disable(text, integer, text);
--   drop function if exists public.ai_provider_config_activate(text, integer, text);
--   drop function if exists public.ai_provider_config_test_result(text, integer, boolean, text, text);
--   drop function if exists public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text);
--   drop function if exists public.ai_provider_config_public_json(public.ai_provider_configs);
--   drop table if exists public.ai_provider_config_audit_events;
--   drop table if exists public.ai_provider_configs;

-- ---------------------------------------------------------------------------
-- 1. Provider config versions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_provider_configs (
  config_id           text not null,
  version             integer not null,
  pilot_scope         text not null default 'pilot',
  provider_profile    text not null,
  api_base_url        text not null,
  sanitized_host      text not null,
  model               text not null,
  envelope            jsonb not null,
  key_fingerprint     text not null,
  status              text not null default 'draft',
  verified_at         timestamptz,
  last_tested_at      timestamptz,
  optimistic_version  integer not null,
  created_by_ref      text not null,
  created_at          timestamptz not null default now(),
  updated_by_ref      text,
  updated_at          timestamptz not null default now(),
  primary key (config_id, version),
  constraint ai_provider_configs_id_check check (config_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  constraint ai_provider_configs_profile_check check (provider_profile ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  constraint ai_provider_configs_scope_check check (pilot_scope = 'pilot'),
  constraint ai_provider_configs_version_check check (version >= 1 and optimistic_version >= 1),
  constraint ai_provider_configs_url_check check (
    api_base_url like 'https://%' and length(api_base_url) between 9 and 2048
    and position('?' in api_base_url) = 0 and position('#' in api_base_url) = 0),
  constraint ai_provider_configs_host_check check (
    length(sanitized_host) between 1 and 255
    and position('/' in sanitized_host) = 0
    and sanitized_host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
  constraint ai_provider_configs_model_check check (
    length(model) between 1 and 256
    and model = btrim(model)
    and model = normalize(model, NFC)
    and model !~ E'[\x01-\x1f\x7f]'),
  constraint ai_provider_configs_fingerprint_check check (key_fingerprint ~ '^[a-f0-9]{16}$'),
  constraint ai_provider_configs_status_check check (
    status in ('draft','test_failed','verified','active','disabled','rotation_required')),
  constraint ai_provider_configs_verified_check check (
    not (status in ('verified','active') and verified_at is null)),
  constraint ai_provider_configs_actor_check check (
    created_by_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'
    and (updated_by_ref is null or updated_by_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')),
  -- Envelope: CHỈ shape + binding; không được chứa khoá plaintext nào.
  constraint ai_provider_configs_envelope_check check (
    jsonb_typeof(envelope) = 'object'
    and length(envelope::text) <= 4000
    and envelope ?& array['envelope_version','algorithm','key_id','iv','ciphertext','authentication_tag','created_at',
                          'config_id','provider_profile','config_version','api_base_url','model']
    and envelope->>'envelope_version' = '2'
    and envelope->>'algorithm' = 'aes-256-gcm'
    and envelope->>'key_id' ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'
    and envelope->>'config_id' = config_id
    and envelope->>'provider_profile' = provider_profile
    and envelope->>'config_version' = version::text
    and envelope->>'api_base_url' = api_base_url
    and envelope->>'model' = model
    and length(envelope->>'iv') between 1 and 64
    and length(envelope->>'ciphertext') between 1 and 4096
    and length(envelope->>'authentication_tag') between 1 and 64
    and not (envelope ?| array['secret','plaintext','api_key','apikey','authorization','password','credential','key'])
  )
);

-- CHỈ MỘT version active cho pilot (ràng buộc cứng ở DB, không chỉ ở application).
create unique index if not exists ai_provider_configs_active_uidx
  on public.ai_provider_configs (pilot_scope)
  where status = 'active';

create index if not exists ai_provider_configs_history_idx
  on public.ai_provider_configs (config_id, version desc);

-- ---------------------------------------------------------------------------
-- 2. Provider config audit (append-only, KHÔNG có cột secret/ciphertext)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_provider_config_audit_events (
  event_id         bigserial primary key,
  config_id        text not null,
  version          integer not null,
  event_type       text not null,
  actor_ref        text not null,
  outcome          text not null,
  reason_code      text not null,
  provider_profile text,
  sanitized_host   text,
  model            text,
  key_fingerprint  text,
  created_at       timestamptz not null default now(),
  constraint ai_provider_config_audit_event_check check (event_type in (
    'config_created','connection_tested','config_activated','credential_rotated',
    'config_disabled','config_mutation_rejected')),
  constraint ai_provider_config_audit_outcome_check check (outcome in ('success','failure')),
  constraint ai_provider_config_audit_reason_check check (reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  constraint ai_provider_config_audit_actor_check check (actor_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  constraint ai_provider_config_audit_version_check check (version >= 0),
  constraint ai_provider_config_audit_model_check check (model is null or length(model) between 1 and 256),
  constraint ai_provider_config_audit_host_check check (sanitized_host is null or length(sanitized_host) between 1 and 255),
  constraint ai_provider_config_audit_fingerprint_check check (key_fingerprint is null or key_fingerprint ~ '^[a-f0-9]{16}$')
);

create index if not exists ai_provider_config_audit_idx
  on public.ai_provider_config_audit_events (config_id, created_at desc);

create or replace function public.ai_provider_config_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_provider_config_audit_events is append-only';
end;
$$;

drop trigger if exists ai_provider_config_audit_no_mutation on public.ai_provider_config_audit_events;
create trigger ai_provider_config_audit_no_mutation
  before update or delete on public.ai_provider_config_audit_events
  for each row execute function public.ai_provider_config_audit_immutable();

-- ---------------------------------------------------------------------------
-- 3. RLS + grants (deny by default; chỉ service_role ở server boundary)
-- ---------------------------------------------------------------------------
alter table public.ai_provider_configs enable row level security;
alter table public.ai_provider_config_audit_events enable row level security;

revoke all on table public.ai_provider_configs from public;
revoke all on table public.ai_provider_configs from anon;
revoke all on table public.ai_provider_configs from authenticated;
revoke all on table public.ai_provider_config_audit_events from public;
revoke all on table public.ai_provider_config_audit_events from anon;
revoke all on table public.ai_provider_config_audit_events from authenticated;

grant select, insert, update on table public.ai_provider_configs to service_role;
revoke delete, truncate on table public.ai_provider_configs from service_role;
grant select, insert on table public.ai_provider_config_audit_events to service_role;
revoke update, delete, truncate on table public.ai_provider_config_audit_events from service_role;
grant usage, select on sequence public.ai_provider_config_audit_events_event_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4. Projection an toàn (KHÔNG envelope, KHÔNG URL đầy đủ)
-- ---------------------------------------------------------------------------
create or replace function public.ai_provider_config_public_json(p_row public.ai_provider_configs)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'config_id', p_row.config_id,
    'provider_profile', p_row.provider_profile,
    'model', p_row.model,
    'version', p_row.version,
    'status', p_row.status,
    'verified_at', p_row.verified_at,
    'last_tested_at', p_row.last_tested_at,
    'updated_at', p_row.updated_at,
    'sanitized_host', p_row.sanitized_host,
    'key_fingerprint', p_row.key_fingerprint,
    'optimistic_version', p_row.optimistic_version
  );
$$;

revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from public;
revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from anon;
revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Save (create / new version) + audit trong CÙNG transaction
-- ---------------------------------------------------------------------------
create or replace function public.ai_provider_config_save(
  p_config_id text,
  p_expected_version integer,
  p_provider_profile text,
  p_api_base_url text,
  p_sanitized_host text,
  p_model text,
  p_envelope jsonb,
  p_key_fingerprint text,
  p_actor_ref text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current integer;
  v_next integer;
  v_row public.ai_provider_configs;
begin
  if p_action not in ('config_created','credential_rotated') then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'action không hợp lệ');
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_provider_config_save:' || coalesce(p_config_id, '')));

  select max(version) into v_current from public.ai_provider_configs where config_id = p_config_id;

  if v_current is null then
    if p_expected_version is not null then
      insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
      values (p_config_id, greatest(coalesce(p_expected_version, 0), 0), 'config_mutation_rejected', p_actor_ref, 'failure', 'version_conflict');
      return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'cấu hình đã thay đổi');
    end if;
    v_next := 1;
  else
    if p_expected_version is distinct from v_current then
      insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
      values (p_config_id, v_current, 'config_mutation_rejected', p_actor_ref, 'failure', 'version_conflict');
      return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'cấu hình đã thay đổi');
    end if;
    v_next := v_current + 1;
  end if;

  insert into public.ai_provider_configs (
    config_id, version, provider_profile, api_base_url, sanitized_host, model,
    envelope, key_fingerprint, status, verified_at, last_tested_at,
    optimistic_version, created_by_ref, created_at, updated_by_ref, updated_at
  ) values (
    p_config_id, v_next, p_provider_profile, p_api_base_url, p_sanitized_host, p_model,
    p_envelope, p_key_fingerprint, 'draft', null, null,
    v_next, p_actor_ref, now(), p_actor_ref, now()
  )
  returning * into v_row;

  insert into public.ai_provider_config_audit_events (
    config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint
  ) values (
    v_row.config_id, v_row.version, p_action, p_actor_ref, 'success', 'ok',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint
  );

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Kết quả kiểm tra kết nối (chỉ Owner bấm mới gọi)
-- ---------------------------------------------------------------------------
create or replace function public.ai_provider_config_test_result(
  p_config_id text,
  p_version integer,
  p_success boolean,
  p_reason_code text,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
  v_outcome text;
begin
  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;

  v_outcome := case when p_success then 'success' else 'failure' end;

  -- Config đang active KHÔNG bị hạ trạng thái bởi một lần test (chỉ ghi nhận thời điểm test).
  if v_row.status = 'active' then
    update public.ai_provider_configs
       set last_tested_at = now(),
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = p_config_id and version = p_version
     returning * into v_row;
  else
    update public.ai_provider_configs
       set status = case when p_success then 'verified' else 'test_failed' end,
           verified_at = case when p_success then now() else null end,
           last_tested_at = now(),
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = p_config_id and version = p_version
     returning * into v_row;
  end if;

  insert into public.ai_provider_config_audit_events (
    config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint
  ) values (
    v_row.config_id, v_row.version, 'connection_tested', p_actor_ref, v_outcome, p_reason_code,
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint
  );

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Activate / Disable (một active cho pilot; version cũ được disable, KHÔNG xoá)
-- ---------------------------------------------------------------------------
create or replace function public.ai_provider_config_activate(
  p_config_id text,
  p_version integer,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
  v_previous public.ai_provider_configs;
begin
  perform pg_advisory_xact_lock(hashtext('ai_provider_config_activate:pilot'));

  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;
  if v_row.status <> 'verified' or v_row.verified_at is null then
    insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
      provider_profile, sanitized_host, model, key_fingerprint)
    values (v_row.config_id, v_row.version, 'config_mutation_rejected', p_actor_ref, 'failure', 'not_verified',
      v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_VERIFIED', 'message', 'cấu hình chưa verified');
  end if;

  for v_previous in
    select * from public.ai_provider_configs
     where pilot_scope = v_row.pilot_scope and status = 'active'
       and not (config_id = p_config_id and version = p_version)
     for update
  loop
    update public.ai_provider_configs
       set status = 'disabled',
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = v_previous.config_id and version = v_previous.version;
    insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
      provider_profile, sanitized_host, model, key_fingerprint)
    values (v_previous.config_id, v_previous.version, 'config_disabled', p_actor_ref, 'success', 'superseded',
      v_previous.provider_profile, v_previous.sanitized_host, v_previous.model, v_previous.key_fingerprint);
  end loop;

  update public.ai_provider_configs
     set status = 'active',
         optimistic_version = optimistic_version + 1,
         updated_by_ref = p_actor_ref,
         updated_at = now()
   where config_id = p_config_id and version = p_version
   returning * into v_row;

  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint)
  values (v_row.config_id, v_row.version, 'config_activated', p_actor_ref, 'success', 'ok',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$$;

create or replace function public.ai_provider_config_disable(
  p_config_id text,
  p_version integer,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
begin
  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;

  update public.ai_provider_configs
     set status = 'disabled',
         optimistic_version = optimistic_version + 1,
         updated_by_ref = p_actor_ref,
         updated_at = now()
   where config_id = p_config_id and version = p_version
   returning * into v_row;

  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint)
  values (v_row.config_id, v_row.version, 'config_disabled', p_actor_ref, 'success', 'owner_disabled',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$$;

-- Audit-only: mutation bị từ chối ở tầng application (vd optimistic conflict phía client).
create or replace function public.ai_provider_config_rejected(
  p_config_id text,
  p_version integer,
  p_actor_ref text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
  values (p_config_id, greatest(coalesce(p_version, 0), 0), 'config_mutation_rejected', p_actor_ref, 'failure', p_reason_code);
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Đọc cho SERVER boundary (trả envelope ⇒ CHỈ service_role, KHÔNG route nào expose)
-- ---------------------------------------------------------------------------
create or replace function public.ai_provider_config_current(p_config_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
begin
  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id
   order by version desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', true, 'config', null);
  end if;
  return jsonb_build_object('ok', true, 'config', to_jsonb(v_row), 'public', public.ai_provider_config_public_json(v_row));
end;
$$;

create or replace function public.ai_provider_config_version(p_config_id text, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
begin
  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version;
  if not found then
    return jsonb_build_object('ok', true, 'config', null);
  end if;
  return jsonb_build_object('ok', true, 'config', to_jsonb(v_row), 'public', public.ai_provider_config_public_json(v_row));
end;
$$;

-- Active config cho ENQUEUE gate: chỉ id/version/profile/model (không envelope).
create or replace function public.ai_provider_config_active()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_provider_configs;
begin
  select * into v_row
    from public.ai_provider_configs
   where status = 'active' and verified_at is not null
   order by version desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_REQUIRED', 'message', 'chưa có cấu hình provider đang active');
  end if;
  return jsonb_build_object(
    'ok', true,
    'config_id', v_row.config_id,
    'version', v_row.version,
    'provider_profile', v_row.provider_profile,
    'model', v_row.model,
    'sanitized_host', v_row.sanitized_host,
    'verified_at', v_row.verified_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants cho RPC (chỉ service_role)
-- ---------------------------------------------------------------------------
revoke all on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) from public;
revoke all on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) from anon;
revoke all on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) from authenticated;
grant execute on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) to service_role;

revoke all on function public.ai_provider_config_test_result(text, integer, boolean, text, text) from public;
revoke all on function public.ai_provider_config_test_result(text, integer, boolean, text, text) from anon;
revoke all on function public.ai_provider_config_test_result(text, integer, boolean, text, text) from authenticated;
grant execute on function public.ai_provider_config_test_result(text, integer, boolean, text, text) to service_role;

revoke all on function public.ai_provider_config_activate(text, integer, text) from public;
revoke all on function public.ai_provider_config_activate(text, integer, text) from anon;
revoke all on function public.ai_provider_config_activate(text, integer, text) from authenticated;
grant execute on function public.ai_provider_config_activate(text, integer, text) to service_role;

revoke all on function public.ai_provider_config_disable(text, integer, text) from public;
revoke all on function public.ai_provider_config_disable(text, integer, text) from anon;
revoke all on function public.ai_provider_config_disable(text, integer, text) from authenticated;
grant execute on function public.ai_provider_config_disable(text, integer, text) to service_role;

revoke all on function public.ai_provider_config_rejected(text, integer, text, text) from public;
revoke all on function public.ai_provider_config_rejected(text, integer, text, text) from anon;
revoke all on function public.ai_provider_config_rejected(text, integer, text, text) from authenticated;
grant execute on function public.ai_provider_config_rejected(text, integer, text, text) to service_role;

revoke all on function public.ai_provider_config_current(text) from public;
revoke all on function public.ai_provider_config_current(text) from anon;
revoke all on function public.ai_provider_config_current(text) from authenticated;
grant execute on function public.ai_provider_config_current(text) to service_role;

revoke all on function public.ai_provider_config_version(text, integer) from public;
revoke all on function public.ai_provider_config_version(text, integer) from anon;
revoke all on function public.ai_provider_config_version(text, integer) from authenticated;
grant execute on function public.ai_provider_config_version(text, integer) to service_role;

revoke all on function public.ai_provider_config_active() from public;
revoke all on function public.ai_provider_config_active() from anon;
revoke all on function public.ai_provider_config_active() from authenticated;
grant execute on function public.ai_provider_config_active() to service_role;

-- ---------------------------------------------------------------------------
-- 10. W04 integration — ĐÓNG BĂNG provider config vào job + enqueue gate
-- ---------------------------------------------------------------------------
alter table public.ai_report_jobs add column if not exists provider_config_id text;
alter table public.ai_report_jobs add column if not exists provider_config_version integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_report_jobs_provider_config_check'
  ) then
    alter table public.ai_report_jobs
      add constraint ai_report_jobs_provider_config_check check (
        (provider_config_id is null and provider_config_version is null)
        or (provider_config_id is not null and provider_config_version is not null
            and provider_config_version >= 1
            and provider_config_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'));
  end if;
end;
$$;

-- Enqueue: bắt buộc có config ACTIVE + VERIFIED, đóng băng id/version vào job.
create or replace function public.ai_report_enqueue(
  p_identity_hash text,
  p_identity_components jsonb,
  p_request jsonb,
  p_actor_ref text,
  p_access_scope_hash text,
  p_snapshot_hash text,
  p_lineage_ref text,
  p_packet jsonb,
  p_packet_hash text,
  p_packet_contract_version text,
  p_output_contract_version text,
  p_prompt_version text,
  p_provider_key text,
  p_model_key text,
  p_adapter_version text,
  p_max_attempts integer,
  p_provider_config_id text,
  p_provider_config_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_revision_id uuid;
  v_revision_job uuid;
  v_config public.ai_provider_configs;
begin
  if p_identity_hash is null or length(p_identity_hash) < 16 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'identity_hash không hợp lệ');
  end if;

  -- W04A (6): job mới CHỈ được enqueue khi có config ACTIVE + VERIFIED, và version đó tồn tại thật.
  if p_provider_config_id is null or p_provider_config_version is null then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_REQUIRED', 'message', 'thiếu provider config đóng băng');
  end if;
  select * into v_config
    from public.ai_provider_configs
   where config_id = p_provider_config_id and version = p_provider_config_version;
  if not found or v_config.status <> 'active' or v_config.verified_at is null then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_REQUIRED', 'message', 'provider config chưa active/verified');
  end if;

  -- 1) Job đang hoạt động cùng identity ⇒ REUSE (+ audit trong cùng transaction).
  select * into v_job
    from public.ai_report_jobs
   where identity_hash = p_identity_hash
     and status in ('requested','queued','computing','ai_generating','validating')
   order by created_at desc
   limit 1;
  if found then
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_job.job_id, 'job_reused', p_actor_ref, null, jsonb_build_object('status', v_job.status));
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id,
                              'provider_config_id', v_job.provider_config_id,
                              'provider_config_version', v_job.provider_config_version);
  end if;

  -- 2) Đã có revision hợp lệ cùng identity ⇒ CACHE HIT (+ audit trong cùng transaction).
  select r.revision_id, r.job_id into v_revision_id, v_revision_job
    from public.ai_report_revisions r
    join public.ai_report_jobs j on j.job_id = r.job_id
   where j.identity_hash = p_identity_hash
     and r.lifecycle_status in ('draft','approved')
   order by r.created_at desc
   limit 1;
  if v_revision_id is not null then
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_revision_job, 'job_cache_hit', p_actor_ref, null, jsonb_build_object('revision_id', v_revision_id));
    return jsonb_build_object('ok', true, 'job_id', v_revision_job, 'status', 'draft',
                              'reused', false, 'cache_hit', true, 'revision_id', v_revision_id,
                              'provider_config_id', null, 'provider_config_version', null);
  end if;

  -- 3) Tạo job mới; unique index partial chặn đua ⇒ reuse job thắng.
  begin
    insert into public.ai_report_jobs (
      identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref,
      packet, packet_hash, packet_contract_version, output_contract_version,
      prompt_version, provider_key, model_key, adapter_version, status, max_attempts,
      provider_config_id, provider_config_version
    ) values (
      p_identity_hash, p_identity_components, p_request, p_actor_ref, p_access_scope_hash, p_snapshot_hash, p_lineage_ref,
      p_packet, p_packet_hash, p_packet_contract_version, p_output_contract_version,
      p_prompt_version, p_provider_key, p_model_key, p_adapter_version, 'queued', greatest(1, least(5, coalesce(p_max_attempts, 3))),
      p_provider_config_id, p_provider_config_version
    )
    returning * into v_job;
  exception when unique_violation then
    select * into v_job
      from public.ai_report_jobs
     where identity_hash = p_identity_hash
       and status in ('requested','queued','computing','ai_generating','validating')
     order by created_at desc
     limit 1;
    if not found then
      raise;
    end if;
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_job.job_id, 'job_reused', p_actor_ref, null, jsonb_build_object('status', v_job.status, 'race', true));
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id,
                              'provider_config_id', v_job.provider_config_id,
                              'provider_config_version', v_job.provider_config_version);
  end;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (v_job.job_id, 'job_enqueued', p_actor_ref, null,
          jsonb_build_object('prompt_version', p_prompt_version, 'provider_key', p_provider_key, 'model_key', p_model_key,
                             'provider_config_id', p_provider_config_id, 'provider_config_version', p_provider_config_version));

  return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                            'reused', false, 'cache_hit', false, 'revision_id', null,
                            'provider_config_id', v_job.provider_config_id,
                            'provider_config_version', v_job.provider_config_version);
end;
$$;

-- Bỏ bản 16 tham số (không đóng băng provider config) để không còn đường enqueue thiếu gate.
drop function if exists public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer);

revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) from public;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) from anon;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) from authenticated;
grant execute on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) to service_role;

comment on table public.ai_provider_configs is
  'P1.5-W04A — version cấu hình provider AI; envelope AES-256-GCM (không plaintext), một version active cho pilot.';
comment on function public.ai_provider_config_active() is
  'P1.5-W04A — config ACTIVE+VERIFIED cho enqueue gate (không trả envelope).';
