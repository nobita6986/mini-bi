-- =============================================================================
-- Recruitment Posts - Phase 1: Location Catalog Foundation
-- (Administrative Provinces & Industrial Parks)
--
-- Scope:
--   1. Canonical province catalog (`public.administrative_provinces`) and
--      append-only revision history (`public.administrative_province_revisions`).
--   2. Canonical industrial park catalog (`public.industrial_parks`) and
--      append-only revision history (`public.industrial_park_revisions`).
--   3. Server-side Vietnamese name normalization (`normalized_key`) for
--      provinces and industrial parks; `unique (province_id, normalized_key)`
--      prevents duplicate industrial parks within the same province while
--      allowing identical normalized keys across different provinces.
--   4. Full Admin / BOD authority guard (`recruitment_location_assert_admin_or_bod`)
--      using canonical capability + `all` scope grants (zero hardcoded emails).
--   5. Eight `service_role`-only admin RPCs with OCC (`expected_version`),
--      idempotency (`idempotency_key` + payload fingerprint), append-only
--      revisions, and audit events.
--   6. Idempotent seed of the 4 approved provinces and 13 industrial parks.
--   7. Zero factory address, coordinates, radius, attendance branch links, or
--      fixed project links in Phase 1.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Server-side Vietnamese name normalization helpers (internal).
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_location_normalize_key(
  p_display_name text,
  p_kind text default 'INDUSTRIAL_PARK'
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_kind, 'INDUSTRIAL_PARK')));
  v_text text;
  v_from constant text :=
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ'
    || 'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ';
  v_to constant text :=
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
    || 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';
begin
  if p_display_name is null then
    return '';
  end if;

  v_text := pg_catalog.btrim(p_display_name);
  if v_text = '' then
    return '';
  end if;

  begin
    v_text := pg_catalog.normalize(v_text, NFC);
  exception when others then
    null;
  end;

  v_text := pg_catalog.translate(v_text, v_from, v_to);
  v_text := pg_catalog.lower(v_text);
  v_text := pg_catalog.regexp_replace(v_text, '[\u0300-\u036f]+', '', 'g');
  v_text := pg_catalog.translate(v_text, v_from, v_to);
  v_text := pg_catalog.btrim(pg_catalog.regexp_replace(v_text, '[^a-z0-9]+', ' ', 'g'));

  if v_kind = 'INDUSTRIAL_PARK' then
    while v_text ~ '^(khu cong nghiep|kcn)(\s+|$)' loop
      v_text := pg_catalog.btrim(
        pg_catalog.regexp_replace(v_text, '^(khu cong nghiep|kcn)(\s+|$)', '')
      );
    end loop;
  elsif v_kind = 'PROVINCE' then
    while v_text ~ '^(tinh|thanh pho trung uong|thanh pho|tp)(\s+|$)' loop
      v_text := pg_catalog.btrim(
        pg_catalog.regexp_replace(
          v_text,
          '^(tinh|thanh pho trung uong|thanh pho|tp)(\s+|$)',
          ''
        )
      );
    end loop;
  else
    raise exception 'location normalization kind invalid' using errcode = '22023';
  end if;

  return pg_catalog.regexp_replace(v_text, '[^a-z0-9]+', '', 'g');
end;
$function$;

create or replace function public.administrative_province_normalize_key(
  p_display_name text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select public.recruitment_location_normalize_key(p_display_name, 'PROVINCE')
$function$;

create or replace function public.industrial_park_normalize_key(
  p_display_name text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select public.recruitment_location_normalize_key(p_display_name, 'INDUSTRIAL_PARK')
$function$;

-- -----------------------------------------------------------------------------
-- 2. Canonical tables: administrative_provinces, industrial_parks & revisions.
-- -----------------------------------------------------------------------------
create table public.administrative_provinces (
  province_id uuid primary key default gen_random_uuid(),
  province_code text not null unique,
  display_name text not null,
  normalized_key text not null unique,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  constraint administrative_provinces_code_check check (
    province_code = pg_catalog.btrim(province_code)
    and province_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint administrative_provinces_display_name_check check (
    display_name = pg_catalog.btrim(display_name)
    and pg_catalog.char_length(display_name) between 1 and 256
    and display_name !~ '[\x00-\x1F\x7F]'
  ),
  constraint administrative_provinces_normalized_key_check check (
    pg_catalog.char_length(normalized_key) between 1 and 256
    and normalized_key ~ '^[a-z0-9]+$'
    and normalized_key = public.administrative_province_normalize_key(display_name)
  ),
  constraint administrative_provinces_version_check check (version >= 1)
);

create index administrative_provinces_active_display_idx
  on public.administrative_provinces (active, display_name, province_code);

comment on table public.administrative_provinces is
  'Phase 1 canonical province/city catalog for Recruitment Posts. Soft-deactivated via active=false; never physically deleted.';

create table public.administrative_province_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  province_id uuid not null
    references public.administrative_provinces(province_id) on delete restrict,
  version integer not null check (version >= 1),
  action text not null check (action in ('CREATE', 'UPDATE', 'SET_ACTIVE')),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  idempotency_key text not null check (pg_catalog.char_length(idempotency_key) between 1 and 128),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (province_id, version)
);

create index administrative_province_revisions_province_version_idx
  on public.administrative_province_revisions (province_id, version desc);

comment on table public.administrative_province_revisions is
  'Append-only revision history for public.administrative_provinces. Never updated or deleted.';

create table public.industrial_parks (
  industrial_park_id uuid primary key default gen_random_uuid(),
  industrial_park_code text not null unique,
  province_id uuid not null
    references public.administrative_provinces(province_id) on delete restrict,
  display_name text not null,
  normalized_key text not null,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  constraint industrial_parks_code_check check (
    industrial_park_code = pg_catalog.btrim(industrial_park_code)
    and industrial_park_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint industrial_parks_display_name_check check (
    display_name = pg_catalog.btrim(display_name)
    and pg_catalog.char_length(display_name) between 1 and 256
    and display_name !~ '[\x00-\x1F\x7F]'
  ),
  constraint industrial_parks_normalized_key_check check (
    pg_catalog.char_length(normalized_key) between 1 and 256
    and normalized_key ~ '^[a-z0-9]+$'
    and normalized_key = public.industrial_park_normalize_key(display_name)
  ),
  constraint industrial_parks_version_check check (version >= 1),
  constraint industrial_parks_province_normalized_key_uidx unique (province_id, normalized_key)
);

create index industrial_parks_province_active_display_idx
  on public.industrial_parks (province_id, active, display_name, industrial_park_code);

comment on table public.industrial_parks is
  'Phase 1 canonical industrial park catalog for Recruitment Posts. Unique per (province_id, normalized_key); soft-deactivated via active=false; never physically deleted. Contains zero address or coordinate fields.';

create table public.industrial_park_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  industrial_park_id uuid not null
    references public.industrial_parks(industrial_park_id) on delete restrict,
  version integer not null check (version >= 1),
  action text not null check (action in ('CREATE', 'UPDATE', 'SET_ACTIVE')),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  idempotency_key text not null check (pg_catalog.char_length(idempotency_key) between 1 and 128),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (industrial_park_id, version)
);

create index industrial_park_revisions_park_version_idx
  on public.industrial_park_revisions (industrial_park_id, version desc);

comment on table public.industrial_park_revisions is
  'Append-only revision history for public.industrial_parks. Never updated or deleted.';

alter table public.direct_entry_audit_events
  add column administrative_province_revision_id uuid
    references public.administrative_province_revisions(revision_id) on delete restrict,
  add column industrial_park_revision_id uuid
    references public.industrial_park_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 3. Write guards & immutability triggers.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_location_province_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'administrative province cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if new.province_id is distinct from old.province_id
       or new.province_code is distinct from old.province_code then
      raise exception 'province identity and province_code are immutable' using errcode = '55000';
    end if;
  end if;

  if new.display_name is not null then
    new.display_name := pg_catalog.btrim(new.display_name);
  end if;
  new.normalized_key := public.administrative_province_normalize_key(new.display_name);
  if coalesce(new.normalized_key, '') = '' then
    raise exception 'province display name produces empty normalized key' using errcode = '22023';
  end if;

  return new;
end;
$function$;

create trigger administrative_provinces_write_guard
  before insert or update or delete on public.administrative_provinces
  for each row execute function public.recruitment_location_province_write_guard();

create or replace function public.recruitment_location_industrial_park_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'industrial park cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if new.industrial_park_id is distinct from old.industrial_park_id
       or new.industrial_park_code is distinct from old.industrial_park_code then
      raise exception 'industrial park identity and industrial_park_code are immutable'
        using errcode = '55000';
    end if;
  end if;

  if new.display_name is not null then
    new.display_name := pg_catalog.btrim(new.display_name);
  end if;
  new.normalized_key := public.industrial_park_normalize_key(new.display_name);
  if coalesce(new.normalized_key, '') = '' then
    raise exception 'industrial park display name produces empty normalized key'
      using errcode = '22023';
  end if;

  return new;
end;
$function$;

create trigger industrial_parks_write_guard
  before insert or update or delete on public.industrial_parks
  for each row execute function public.recruitment_location_industrial_park_write_guard();

create trigger administrative_province_revisions_immutable
  before update or delete on public.administrative_province_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

create trigger industrial_park_revisions_immutable
  before update or delete on public.industrial_park_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.administrative_provinces enable row level security;
alter table public.administrative_provinces force row level security;
alter table public.administrative_province_revisions enable row level security;
alter table public.administrative_province_revisions force row level security;
alter table public.industrial_parks enable row level security;
alter table public.industrial_parks force row level security;
alter table public.industrial_park_revisions enable row level security;
alter table public.industrial_park_revisions force row level security;

-- -----------------------------------------------------------------------------
-- 4. Authority guard & internal lock / snapshot helpers.
-- -----------------------------------------------------------------------------
-- Full Admin / BOD authority guard:
--   - Requires valid, enabled actor mapping (`direct_entry_assert_actor_mapping`).
--   - Requires effective `all` scope (`direct_entry_has_scope(p_app_user_id, 'all')`).
--   - Accepts:
--       (a) Canonical Full Admin triple (`entry_admin` + `recruiter_master_manage`
--           + `team_master_manage`),
--       (b) Canonical catalog operator (`catalog_master_manage`),
--       (c) Canonical BOD privileged authority (`entry_privileged_edit`), or
--       (d) Canonical BOD/Accounting Reviewer+Admin bundle (`entry_admin` +
--           `change_review` + `pii_view` + `payment_view`).
--   - Zero hardcoded emails; PMs, Team Leaders, and regular BI users are denied
--     with 42501.
create or replace function public.recruitment_location_assert_admin_or_bod(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_full_admin boolean;
  v_bod_reviewer_admin boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'location catalog requires all scope' using errcode = '42501';
  end if;

  v_full_admin :=
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

  if v_full_admin then
    return 'entry_admin';
  end if;

  if public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage') then
    return 'catalog_master_manage';
  end if;

  if public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit') then
    return 'entry_privileged_edit';
  end if;

  v_bod_reviewer_admin :=
    (
      public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
      and public.direct_entry_has_capability(p_app_user_id, 'change_review')
    )
    or public.direct_entry_has_capability(p_app_user_id, 'worker_edit_history_view')
    or (
      public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
      and public.direct_entry_has_capability(p_app_user_id, 'report_view')
    );

  if v_bod_reviewer_admin then
    return case
      when public.direct_entry_has_capability(p_app_user_id, 'entry_admin') then 'entry_admin'
      when public.direct_entry_has_capability(p_app_user_id, 'worker_edit_history_view') then 'worker_edit_history_view'
      else 'report_analytics_view'
    end;
  end if;

  raise exception 'location catalog admin or bod authority denied' using errcode = '42501';
end;
$function$;

create or replace function public.recruitment_location_province_snapshot(
  p_row public.administrative_provinces
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'province_id', p_row.province_id,
    'province_code', p_row.province_code,
    'display_name', p_row.display_name,
    'normalized_key', p_row.normalized_key,
    'active', p_row.active,
    'version', p_row.version
  )
$function$;

create or replace function public.recruitment_location_industrial_park_snapshot(
  p_row public.industrial_parks
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'industrial_park_id', p_row.industrial_park_id,
    'industrial_park_code', p_row.industrial_park_code,
    'province_id', p_row.province_id,
    'display_name', p_row.display_name,
    'normalized_key', p_row.normalized_key,
    'active', p_row.active,
    'version', p_row.version
  )
$function$;

create or replace function public.recruitment_location_lock_province(
  p_province_id uuid,
  p_expected_version integer
)
returns public.administrative_provinces
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.administrative_provinces;
begin
  if p_province_id is null then
    raise exception 'province_id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected province version required' using errcode = '22023';
  end if;

  select p.* into v_row
    from public.administrative_provinces p
   where p.province_id = p_province_id
   for update;

  if not found then
    raise exception 'province not found' using errcode = 'P0002';
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'province version conflict' using errcode = '40001';
  end if;

  return v_row;
end;
$function$;

create or replace function public.recruitment_location_lock_industrial_park(
  p_industrial_park_id uuid,
  p_expected_version integer
)
returns public.industrial_parks
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.industrial_parks;
begin
  if p_industrial_park_id is null then
    raise exception 'industrial_park_id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected industrial park version required' using errcode = '22023';
  end if;

  select ip.* into v_row
    from public.industrial_parks ip
   where ip.industrial_park_id = p_industrial_park_id
   for update;

  if not found then
    raise exception 'industrial park not found' using errcode = 'P0002';
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'industrial park version conflict' using errcode = '40001';
  end if;

  return v_row;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Province Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.administrative_province_list_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_search text;
  v_search_norm text;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 50);
  v_total integer;
  v_provinces jsonb;
begin
  perform public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_search is not null and pg_catalog.char_length(pg_catalog.btrim(p_search)) > 256 then
    raise exception 'province search exceeds maximum length' using errcode = '22023';
  end if;
  v_search := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_norm := case
    when v_search is null then null
    else nullif(public.administrative_province_normalize_key(v_search), '')
  end;

  if v_page < 1 or v_page > 1000 then
    raise exception 'province page invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'province page_size invalid' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.administrative_provinces p
   where (v_include_inactive or p.active)
     and (
       v_search is null
       or p.display_name ilike '%' || v_search || '%'
       or p.province_code ilike '%' || v_search || '%'
       or (v_search_norm is not null and p.normalized_key like '%' || v_search_norm || '%')
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             row_proj.projection
             order by row_proj.display_name asc, row_proj.province_code asc, row_proj.province_id asc
           ),
           '[]'::jsonb
         )
    into v_provinces
    from (
      select pg_catalog.jsonb_build_object(
               'province_id', p.province_id,
               'province_code', p.province_code,
               'display_name', p.display_name,
               'normalized_key', p.normalized_key,
               'active', p.active,
               'version', p.version,
               'industrial_park_count', coalesce(ip_counts.total_count, 0),
               'active_industrial_park_count', coalesce(ip_counts.active_count, 0),
               'revision_count', coalesce(rev_counts.revision_count, 0)
             ) as projection,
             p.display_name,
             p.province_code,
             p.province_id
        from public.administrative_provinces p
        left join lateral (
          select count(*)::int as total_count,
                 count(*) filter (where ip.active)::int as active_count
            from public.industrial_parks ip
           where ip.province_id = p.province_id
        ) ip_counts on true
        left join lateral (
          select count(*)::int as revision_count
            from public.administrative_province_revisions r
           where r.province_id = p.province_id
        ) rev_counts on true
       where (v_include_inactive or p.active)
         and (
           v_search is null
           or p.display_name ilike '%' || v_search || '%'
           or p.province_code ilike '%' || v_search || '%'
           or (v_search_norm is not null and p.normalized_key like '%' || v_search_norm || '%')
         )
       order by p.display_name asc, p.province_code asc, p.province_id asc
       limit v_page_size offset (v_page - 1) * v_page_size
    ) row_proj;

  return pg_catalog.jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'provinces', v_provinces
  );
end;
$function$;

create or replace function public.administrative_province_create_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_province_code text,
  p_display_name text,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_code text;
  v_display text;
  v_normalized_key text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_province public.administrative_provinces;
  v_revision_id uuid;
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;

  v_code := pg_catalog.btrim(coalesce(p_province_code, ''));
  if v_code !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'province_code invalid' using errcode = '22023';
  end if;

  v_display := pg_catalog.btrim(coalesce(p_display_name, ''));
  if pg_catalog.char_length(v_display) not between 1 and 256
     or v_display ~ '[\x00-\x1F\x7F]' then
    raise exception 'province display_name invalid' using errcode = '22023';
  end if;

  v_normalized_key := public.administrative_province_normalize_key(v_display);
  if coalesce(v_normalized_key, '') = ''
     or pg_catalog.char_length(v_normalized_key) > 256 then
    raise exception 'province display_name produces invalid normalized_key' using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'expected_version', 0,
      'province_code', v_code,
      'display_name', v_display
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'administrative_province_create',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.administrative_provinces (
    province_code,
    display_name,
    normalized_key,
    active,
    version,
    created_by_user_id,
    updated_by_user_id
  )
  values (
    v_code,
    v_display,
    v_normalized_key,
    true,
    1,
    p_app_user_id,
    p_app_user_id
  )
  returning * into v_province;

  insert into public.administrative_province_revisions (
    province_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_province.province_id,
    v_province.version,
    'CREATE',
    p_app_user_id,
    v_reason_id,
    null,
    public.recruitment_location_province_snapshot(v_province),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    administrative_province_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'administrative_province_create',
    v_authority,
    v_province.province_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['province_code', 'display_name', 'normalized_key', 'active'],
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'province_id', v_province.province_id,
    'province_code', v_province.province_code,
    'display_name', v_province.display_name,
    'normalized_key', v_province.normalized_key,
    'active', v_province.active,
    'version', v_province.version,
    'revision_id', v_revision_id,
    'created', true
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'administrative_province_create',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

create or replace function public.administrative_province_update_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_province_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_display text;
  v_normalized_key text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_before public.administrative_provinces;
  v_after public.administrative_provinces;
  v_revision_id uuid;
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_province_id is null then
    raise exception 'province_id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected province version required' using errcode = '22023';
  end if;

  v_display := pg_catalog.btrim(coalesce(p_display_name, ''));
  if pg_catalog.char_length(v_display) not between 1 and 256
     or v_display ~ '[\x00-\x1F\x7F]' then
    raise exception 'province display_name invalid' using errcode = '22023';
  end if;

  v_normalized_key := public.administrative_province_normalize_key(v_display);
  if coalesce(v_normalized_key, '') = ''
     or pg_catalog.char_length(v_normalized_key) > 256 then
    raise exception 'province display_name produces invalid normalized_key' using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'province_id', p_province_id,
      'expected_version', p_expected_version,
      'display_name', v_display
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'administrative_province_update',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.recruitment_location_lock_province(p_province_id, p_expected_version);
  if v_before.display_name is not distinct from v_display then
    raise exception 'province update changes nothing' using errcode = '22023';
  end if;

  update public.administrative_provinces
     set display_name = v_display,
         normalized_key = v_normalized_key,
         version = v_before.version + 1,
         updated_at = now(),
         updated_by_user_id = p_app_user_id
   where province_id = p_province_id
  returning * into v_after;

  insert into public.administrative_province_revisions (
    province_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_after.province_id,
    v_after.version,
    'UPDATE',
    p_app_user_id,
    v_reason_id,
    public.recruitment_location_province_snapshot(v_before),
    public.recruitment_location_province_snapshot(v_after),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    administrative_province_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'administrative_province_update',
    v_authority,
    v_after.province_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    case
      when v_before.normalized_key is distinct from v_after.normalized_key
        then array['display_name', 'normalized_key']
      else array['display_name']
    end,
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'province_id', v_after.province_id,
    'province_code', v_after.province_code,
    'display_name', v_after.display_name,
    'normalized_key', v_after.normalized_key,
    'active', v_after.active,
    'version', v_after.version,
    'revision_id', v_revision_id
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'administrative_province_update',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

create or replace function public.administrative_province_set_active_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_province_id uuid,
  p_active boolean,
  p_expected_version integer,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_before public.administrative_provinces;
  v_after public.administrative_provinces;
  v_revision_id uuid;
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_province_id is null then
    raise exception 'province_id required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'province active flag required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected province version required' using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'province_id', p_province_id,
      'active', p_active,
      'expected_version', p_expected_version
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'administrative_province_set_active',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.recruitment_location_lock_province(p_province_id, p_expected_version);
  if v_before.active = p_active then
    raise exception 'province active state is unchanged' using errcode = '22023';
  end if;

  update public.administrative_provinces
     set active = p_active,
         version = v_before.version + 1,
         updated_at = now(),
         updated_by_user_id = p_app_user_id
   where province_id = p_province_id
  returning * into v_after;

  insert into public.administrative_province_revisions (
    province_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_after.province_id,
    v_after.version,
    'SET_ACTIVE',
    p_app_user_id,
    v_reason_id,
    public.recruitment_location_province_snapshot(v_before),
    public.recruitment_location_province_snapshot(v_after),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    administrative_province_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'administrative_province_set_active',
    v_authority,
    v_after.province_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['active'],
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'province_id', v_after.province_id,
    'province_code', v_after.province_code,
    'display_name', v_after.display_name,
    'normalized_key', v_after.normalized_key,
    'active', v_after.active,
    'version', v_after.version,
    'revision_id', v_revision_id
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'administrative_province_set_active',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Industrial Park Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.industrial_park_list_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_province_id uuid default null,
  p_search text default null,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_search text;
  v_search_norm text;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 50);
  v_total integer;
  v_parks jsonb;
begin
  perform public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_search is not null and pg_catalog.char_length(pg_catalog.btrim(p_search)) > 256 then
    raise exception 'industrial park search exceeds maximum length' using errcode = '22023';
  end if;
  v_search := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_norm := case
    when v_search is null then null
    else nullif(public.industrial_park_normalize_key(v_search), '')
  end;

  if v_page < 1 or v_page > 1000 then
    raise exception 'industrial park page invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'industrial park page_size invalid' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.industrial_parks ip
    join public.administrative_provinces p on p.province_id = ip.province_id
   where (p_province_id is null or ip.province_id = p_province_id)
     and (v_include_inactive or ip.active)
     and (
       v_search is null
       or ip.display_name ilike '%' || v_search || '%'
       or ip.industrial_park_code ilike '%' || v_search || '%'
       or p.display_name ilike '%' || v_search || '%'
       or p.province_code ilike '%' || v_search || '%'
       or (v_search_norm is not null and ip.normalized_key like '%' || v_search_norm || '%')
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             row_proj.projection
             order by
               row_proj.province_display_name asc,
               row_proj.display_name asc,
               row_proj.industrial_park_code asc,
               row_proj.industrial_park_id asc
           ),
           '[]'::jsonb
         )
    into v_parks
    from (
      select pg_catalog.jsonb_build_object(
               'industrial_park_id', ip.industrial_park_id,
               'industrial_park_code', ip.industrial_park_code,
               'province_id', ip.province_id,
               'province_code', p.province_code,
               'province_display_name', p.display_name,
               'province_active', p.active,
               'display_name', ip.display_name,
               'normalized_key', ip.normalized_key,
               'active', ip.active,
               'version', ip.version,
               'revision_count', coalesce(rev_counts.revision_count, 0)
             ) as projection,
             p.display_name as province_display_name,
             ip.display_name,
             ip.industrial_park_code,
             ip.industrial_park_id
        from public.industrial_parks ip
        join public.administrative_provinces p on p.province_id = ip.province_id
        left join lateral (
          select count(*)::int as revision_count
            from public.industrial_park_revisions r
           where r.industrial_park_id = ip.industrial_park_id
        ) rev_counts on true
       where (p_province_id is null or ip.province_id = p_province_id)
         and (v_include_inactive or ip.active)
         and (
           v_search is null
           or ip.display_name ilike '%' || v_search || '%'
           or ip.industrial_park_code ilike '%' || v_search || '%'
           or p.display_name ilike '%' || v_search || '%'
           or p.province_code ilike '%' || v_search || '%'
           or (v_search_norm is not null and ip.normalized_key like '%' || v_search_norm || '%')
         )
       order by
         p.display_name asc,
         ip.display_name asc,
         ip.industrial_park_code asc,
         ip.industrial_park_id asc
       limit v_page_size offset (v_page - 1) * v_page_size
    ) row_proj;

  return pg_catalog.jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'province_id', p_province_id,
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'industrial_parks', v_parks
  );
end;
$function$;

create or replace function public.industrial_park_create_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_industrial_park_code text,
  p_province_id uuid,
  p_display_name text,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_code text;
  v_display text;
  v_normalized_key text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_province public.administrative_provinces;
  v_park public.industrial_parks;
  v_revision_id uuid;
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;

  v_code := pg_catalog.btrim(coalesce(p_industrial_park_code, ''));
  if v_code !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'industrial_park_code invalid' using errcode = '22023';
  end if;

  if p_province_id is null then
    raise exception 'province_id required' using errcode = '22023';
  end if;

  v_display := pg_catalog.btrim(coalesce(p_display_name, ''));
  if pg_catalog.char_length(v_display) not between 1 and 256
     or v_display ~ '[\x00-\x1F\x7F]' then
    raise exception 'industrial park display_name invalid' using errcode = '22023';
  end if;

  v_normalized_key := public.industrial_park_normalize_key(v_display);
  if coalesce(v_normalized_key, '') = ''
     or pg_catalog.char_length(v_normalized_key) > 256 then
    raise exception 'industrial park display_name produces invalid normalized_key'
      using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'expected_version', 0,
      'industrial_park_code', v_code,
      'province_id', p_province_id,
      'display_name', v_display
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'industrial_park_create',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select p.* into v_province
    from public.administrative_provinces p
   where p.province_id = p_province_id
   for key share;

  if not found then
    raise exception 'province not found' using errcode = 'P0002';
  end if;

  insert into public.industrial_parks (
    industrial_park_code,
    province_id,
    display_name,
    normalized_key,
    active,
    version,
    created_by_user_id,
    updated_by_user_id
  )
  values (
    v_code,
    p_province_id,
    v_display,
    v_normalized_key,
    true,
    1,
    p_app_user_id,
    p_app_user_id
  )
  returning * into v_park;

  insert into public.industrial_park_revisions (
    industrial_park_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_park.industrial_park_id,
    v_park.version,
    'CREATE',
    p_app_user_id,
    v_reason_id,
    null,
    public.recruitment_location_industrial_park_snapshot(v_park),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    industrial_park_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'industrial_park_create',
    v_authority,
    v_park.industrial_park_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['industrial_park_code', 'province_id', 'display_name', 'normalized_key', 'active'],
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'industrial_park_id', v_park.industrial_park_id,
    'industrial_park_code', v_park.industrial_park_code,
    'province_id', v_park.province_id,
    'province_code', v_province.province_code,
    'province_display_name', v_province.display_name,
    'display_name', v_park.display_name,
    'normalized_key', v_park.normalized_key,
    'active', v_park.active,
    'version', v_park.version,
    'revision_id', v_revision_id,
    'created', true
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'industrial_park_create',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

create or replace function public.industrial_park_update_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_industrial_park_id uuid,
  p_expected_version integer,
  p_province_id uuid default null,
  p_display_name text default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_display_input text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_before public.industrial_parks;
  v_target_province_id uuid;
  v_target_display text;
  v_target_normalized_key text;
  v_province public.administrative_provinces;
  v_after public.industrial_parks;
  v_revision_id uuid;
  v_changed_fields text[] := array[]::text[];
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_industrial_park_id is null then
    raise exception 'industrial_park_id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected industrial park version required' using errcode = '22023';
  end if;

  if p_display_name is not null then
    v_display_input := pg_catalog.btrim(p_display_name);
    if pg_catalog.char_length(v_display_input) not between 1 and 256
       or v_display_input ~ '[\x00-\x1F\x7F]' then
      raise exception 'industrial park display_name invalid' using errcode = '22023';
    end if;
    if coalesce(public.industrial_park_normalize_key(v_display_input), '') = '' then
      raise exception 'industrial park display_name produces invalid normalized_key'
        using errcode = '22023';
    end if;
  end if;

  if p_province_id is null and v_display_input is null then
    raise exception 'industrial park update requires province_id or display_name'
      using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'industrial_park_id', p_industrial_park_id,
      'expected_version', p_expected_version,
      'province_id', p_province_id,
      'display_name', v_display_input
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'industrial_park_update',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.recruitment_location_lock_industrial_park(
    p_industrial_park_id,
    p_expected_version
  );

  v_target_province_id := coalesce(p_province_id, v_before.province_id);
  v_target_display := coalesce(v_display_input, v_before.display_name);
  v_target_normalized_key := public.industrial_park_normalize_key(v_target_display);

  if v_before.province_id = v_target_province_id
     and v_before.display_name is not distinct from v_target_display then
    raise exception 'industrial park update changes nothing' using errcode = '22023';
  end if;

  select p.* into v_province
    from public.administrative_provinces p
   where p.province_id = v_target_province_id
   for key share;

  if not found then
    raise exception 'province not found' using errcode = 'P0002';
  end if;

  update public.industrial_parks
     set province_id = v_target_province_id,
         display_name = v_target_display,
         normalized_key = v_target_normalized_key,
         version = v_before.version + 1,
         updated_at = now(),
         updated_by_user_id = p_app_user_id
   where industrial_park_id = p_industrial_park_id
  returning * into v_after;

  if v_before.province_id is distinct from v_after.province_id then
    v_changed_fields := array_append(v_changed_fields, 'province_id');
  end if;
  if v_before.display_name is distinct from v_after.display_name then
    v_changed_fields := array_append(v_changed_fields, 'display_name');
  end if;
  if v_before.normalized_key is distinct from v_after.normalized_key then
    v_changed_fields := array_append(v_changed_fields, 'normalized_key');
  end if;

  insert into public.industrial_park_revisions (
    industrial_park_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_after.industrial_park_id,
    v_after.version,
    'UPDATE',
    p_app_user_id,
    v_reason_id,
    public.recruitment_location_industrial_park_snapshot(v_before),
    public.recruitment_location_industrial_park_snapshot(v_after),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    industrial_park_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'industrial_park_update',
    v_authority,
    v_after.industrial_park_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    v_changed_fields,
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'industrial_park_id', v_after.industrial_park_id,
    'industrial_park_code', v_after.industrial_park_code,
    'province_id', v_after.province_id,
    'province_code', v_province.province_code,
    'province_display_name', v_province.display_name,
    'display_name', v_after.display_name,
    'normalized_key', v_after.normalized_key,
    'active', v_after.active,
    'version', v_after.version,
    'revision_id', v_revision_id
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'industrial_park_update',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

create or replace function public.industrial_park_set_active_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_industrial_park_id uuid,
  p_active boolean,
  p_expected_version integer,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_idem_key text;
  v_fingerprint text;
  v_prior jsonb;
  v_reason_id uuid;
  v_before public.industrial_parks;
  v_after public.industrial_parks;
  v_province public.administrative_provinces;
  v_revision_id uuid;
  v_result jsonb;
begin
  v_authority := public.recruitment_location_assert_admin_or_bod(p_auth_subject, p_app_user_id);

  if p_industrial_park_id is null then
    raise exception 'industrial_park_id required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'industrial park active flag required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected industrial park version required' using errcode = '22023';
  end if;

  v_idem_key := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  if pg_catalog.char_length(v_idem_key) not between 1 and 128 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'industrial_park_id', p_industrial_park_id,
      'active', p_active,
      'expected_version', p_expected_version
    )
  );

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'industrial_park_set_active',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.recruitment_location_lock_industrial_park(
    p_industrial_park_id,
    p_expected_version
  );

  if v_before.active = p_active then
    raise exception 'industrial park active state is unchanged' using errcode = '22023';
  end if;

  update public.industrial_parks
     set active = p_active,
         version = v_before.version + 1,
         updated_at = now(),
         updated_by_user_id = p_app_user_id
   where industrial_park_id = p_industrial_park_id
  returning * into v_after;

  select p.* into v_province
    from public.administrative_provinces p
   where p.province_id = v_after.province_id;

  insert into public.industrial_park_revisions (
    industrial_park_id,
    version,
    action,
    actor_user_id,
    reason_id,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_after.industrial_park_id,
    v_after.version,
    'SET_ACTIVE',
    p_app_user_id,
    v_reason_id,
    public.recruitment_location_industrial_park_snapshot(v_before),
    public.recruitment_location_industrial_park_snapshot(v_after),
    v_idem_key,
    v_fingerprint
  )
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    industrial_park_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'industrial_park_set_active',
    v_authority,
    v_after.industrial_park_id::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['active'],
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'industrial_park_id', v_after.industrial_park_id,
    'industrial_park_code', v_after.industrial_park_code,
    'province_id', v_after.province_id,
    'province_code', v_province.province_code,
    'province_display_name', v_province.display_name,
    'display_name', v_after.display_name,
    'normalized_key', v_after.normalized_key,
    'active', v_after.active,
    'version', v_after.version,
    'revision_id', v_revision_id
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'industrial_park_set_active',
    v_idem_key,
    v_result
  );

  return v_result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Idempotent canonical seed (4 provinces, 13 industrial parks).
-- -----------------------------------------------------------------------------
insert into public.administrative_provinces (
  province_code,
  display_name,
  normalized_key,
  active,
  version
)
values
  ('VINH_PHUC', 'Vĩnh Phúc', public.administrative_province_normalize_key('Vĩnh Phúc'), true, 1),
  ('PHU_THO', 'Phú Thọ', public.administrative_province_normalize_key('Phú Thọ'), true, 1),
  ('HOA_BINH', 'Hòa Bình', public.administrative_province_normalize_key('Hòa Bình'), true, 1),
  ('BAC_GIANG', 'Bắc Giang', public.administrative_province_normalize_key('Bắc Giang'), true, 1)
on conflict (province_code) do update
  set display_name = excluded.display_name,
      normalized_key = public.administrative_province_normalize_key(excluded.display_name),
      updated_at = now()
where public.administrative_provinces.display_name is distinct from excluded.display_name;

with seed_parks (industrial_park_code, province_code, display_name) as (
  values
    ('VP_BA_THIEN_1', 'VINH_PHUC', 'Bá Thiện 1'),
    ('VP_BA_THIEN_2', 'VINH_PHUC', 'Bá Thiện 2'),
    ('VP_BINH_XUYEN_1', 'VINH_PHUC', 'Bình Xuyên 1'),
    ('VP_BINH_XUYEN_2', 'VINH_PHUC', 'Bình Xuyên 2'),
    ('VP_KHAI_QUANG', 'VINH_PHUC', 'Khai Quang'),
    ('VP_THANG_LONG_3', 'VINH_PHUC', 'Thăng Long 3'),
    ('PT_PHU_HA', 'PHU_THO', 'Phú Hà'),
    ('PT_CAM_KHE', 'PHU_THO', 'Cẩm Khê'),
    ('PT_THUY_VAN', 'PHU_THO', 'Thụy Vân'),
    ('HB_LUONG_SON', 'HOA_BINH', 'Lương Sơn'),
    ('BG_QUANG_CHAU', 'BAC_GIANG', 'Quang Châu'),
    ('BG_DINH_TRAM', 'BAC_GIANG', 'Đình Trám'),
    ('BG_VAN_TRUNG', 'BAC_GIANG', 'Vân Trung')
)
insert into public.industrial_parks (
  industrial_park_code,
  province_id,
  display_name,
  normalized_key,
  active,
  version
)
select sp.industrial_park_code,
       p.province_id,
       sp.display_name,
       public.industrial_park_normalize_key(sp.display_name),
       true,
       1
  from seed_parks sp
  join public.administrative_provinces p on p.province_code = sp.province_code
on conflict (industrial_park_code) do update
  set province_id = excluded.province_id,
      display_name = excluded.display_name,
      normalized_key = public.industrial_park_normalize_key(excluded.display_name),
      updated_at = now()
where public.industrial_parks.province_id is distinct from excluded.province_id
   or public.industrial_parks.display_name is distinct from excluded.display_name;

-- -----------------------------------------------------------------------------
-- 8. Owner alignment & internal helper privilege grants.
-- -----------------------------------------------------------------------------
do $align_recruitment_location_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_rel_owner_oid oid;
  v_proc_owner_oid oid;
  v_tbl text;
  v_fn pg_catalog.regprocedure;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  foreach v_tbl in array array[
    'administrative_provinces',
    'administrative_province_revisions',
    'industrial_parks',
    'industrial_park_revisions'
  ] loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass('public.' || v_tbl);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table public.%I owner to %I', v_tbl, v_base_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::pg_catalog.regprocedure, p.proowner
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (
         p.proname like 'recruitment_location_%'
         or p.proname like 'administrative_province_%'
         or p.proname like 'industrial_park_%'
       )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and (
         p.proname like 'recruitment_location_%'
         or p.proname like 'administrative_province_%'
         or p.proname like 'industrial_park_%'
       )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reason(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_payload_hash(jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_begin(uuid, text, text, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_finish(uuid, text, text, jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reject_immutable_change() to %I',
      v_owner
    );
  end loop;
end;
$align_recruitment_location_owners$;

-- -----------------------------------------------------------------------------
-- 9. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table
  public.administrative_provinces,
  public.administrative_province_revisions,
  public.industrial_parks,
  public.industrial_park_revisions
from public, anon, authenticated, service_role;

revoke all on function
  public.recruitment_location_normalize_key(text, text),
  public.administrative_province_normalize_key(text),
  public.industrial_park_normalize_key(text),
  public.recruitment_location_province_write_guard(),
  public.recruitment_location_industrial_park_write_guard(),
  public.recruitment_location_assert_admin_or_bod(uuid, uuid),
  public.recruitment_location_province_snapshot(public.administrative_provinces),
  public.recruitment_location_industrial_park_snapshot(public.industrial_parks),
  public.recruitment_location_lock_province(uuid, integer),
  public.recruitment_location_lock_industrial_park(uuid, integer)
from public, anon, authenticated, service_role;

revoke all on function
  public.administrative_province_list_admin(uuid, uuid, text, boolean, integer, integer),
  public.administrative_province_create_admin(uuid, uuid, integer, text, text, text, text),
  public.administrative_province_update_admin(uuid, uuid, uuid, integer, text, text, text),
  public.administrative_province_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text),
  public.industrial_park_list_admin(uuid, uuid, uuid, text, boolean, integer, integer),
  public.industrial_park_create_admin(uuid, uuid, integer, text, uuid, text, text, text),
  public.industrial_park_update_admin(uuid, uuid, uuid, integer, uuid, text, text, text),
  public.industrial_park_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.administrative_province_list_admin(uuid, uuid, text, boolean, integer, integer),
  public.administrative_province_create_admin(uuid, uuid, integer, text, text, text, text),
  public.administrative_province_update_admin(uuid, uuid, uuid, integer, text, text, text),
  public.administrative_province_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text),
  public.industrial_park_list_admin(uuid, uuid, uuid, text, boolean, integer, integer),
  public.industrial_park_create_admin(uuid, uuid, integer, text, uuid, text, text, text),
  public.industrial_park_update_admin(uuid, uuid, uuid, integer, uuid, text, text, text),
  public.industrial_park_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text)
to service_role;

-- -----------------------------------------------------------------------------
-- 10. Install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $self_check$
declare
  v_unforced_rls integer;
  v_table_grants integer;
  v_bad_secdef integer;
  v_public_exec integer;
  v_helper_service_exec integer;
  v_service_exec integer;
  v_province_seed_count integer;
  v_park_seed_count integer;
  v_forbidden_cols integer;
begin
  select count(*)::integer
    into v_unforced_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'administrative_provinces',
       'administrative_province_revisions',
       'industrial_parks',
       'industrial_park_revisions'
     )
     and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_unforced_rls <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_RLS_FAILED (% tables)', v_unforced_rls
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in (
       'administrative_provinces',
       'administrative_province_revisions',
       'industrial_parks',
       'industrial_park_revisions'
     )
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_TABLE_GRANTS_FAILED (% grants)', v_table_grants
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_forbidden_cols
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'administrative_provinces',
       'administrative_province_revisions',
       'industrial_parks',
       'industrial_park_revisions'
     )
     and a.attnum > 0
     and not a.attisdropped
     and (
       a.attname like '%address%'
       or a.attname like '%latitude%'
       or a.attname like '%longitude%'
       or a.attname like '%radius%'
       or a.attname like '%coord%'
       or a.attname like '%branch_id%'
       or a.attname like '%project_id%'
     );

  if v_forbidden_cols <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_FORBIDDEN_COLUMNS (% columns)', v_forbidden_cols
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_bad_secdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (
       p.proname like 'recruitment_location_%'
       or p.proname like 'administrative_province_%'
       or p.proname like 'industrial_park_%'
     )
     and (
       not p.prosecdef
       or coalesce(pg_catalog.array_to_string(p.proconfig, ','), '')
          not like '%search_path=pg_catalog, public%'
     );

  if v_bad_secdef <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_SECDEF_FAILED (% functions)', v_bad_secdef
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (
       p.proname like 'recruitment_location_%'
       or p.proname like 'administrative_province_%'
       or p.proname like 'industrial_park_%'
     )
     and (
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_public_exec <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_PUBLIC_EXEC_FAILED (% functions)', v_public_exec
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_helper_service_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (
       p.proname like 'recruitment_location_%'
       or p.proname in (
         'administrative_province_normalize_key',
         'industrial_park_normalize_key'
       )
     )
     and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_helper_service_exec <> 0 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_HELPER_EXEC_FAILED (% helpers)', v_helper_service_exec
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_service_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (
       p.proname like 'administrative_province_%_admin'
       or p.proname like 'industrial_park_%_admin'
     )
     and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_service_exec <> 8 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_SERVICE_EXEC_FAILED (expected 8, got %)', v_service_exec
      using errcode = '55000';
  end if;

  if public.industrial_park_normalize_key('Khai Quang') <> 'khaiquang'
     or public.industrial_park_normalize_key('KHAIQUANG') <> 'khaiquang'
     or public.industrial_park_normalize_key('KCN Khai Quang') <> 'khaiquang'
     or public.industrial_park_normalize_key('Khu công nghiệp Khai-Quang') <> 'khaiquang'
     or public.industrial_park_normalize_key('Thăng Long 3') = public.industrial_park_normalize_key('Thăng Long III') then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_NORMALIZATION_FAILED'
      using errcode = '55000';
  end if;

  select count(*)::integer into v_province_seed_count
    from public.administrative_provinces
   where province_code in ('VINH_PHUC', 'PHU_THO', 'HOA_BINH', 'BAC_GIANG');

  if v_province_seed_count <> 4 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_PROVINCE_SEED_FAILED (got %)', v_province_seed_count
      using errcode = '55000';
  end if;

  select count(*)::integer into v_park_seed_count
    from public.industrial_parks
   where industrial_park_code in (
     'VP_BA_THIEN_1',
     'VP_BA_THIEN_2',
     'VP_BINH_XUYEN_1',
     'VP_BINH_XUYEN_2',
     'VP_KHAI_QUANG',
     'VP_THANG_LONG_3',
     'PT_PHU_HA',
     'PT_CAM_KHE',
     'PT_THUY_VAN',
     'HB_LUONG_SON',
     'BG_QUANG_CHAU',
     'BG_DINH_TRAM',
     'BG_VAN_TRUNG'
   );

  if v_park_seed_count <> 13 then
    raise exception 'RECRUITMENT_LOCATION_SELF_CHECK_PARK_SEED_FAILED (got %)', v_park_seed_count
      using errcode = '55000';
  end if;
end;
$self_check$;

commit;
