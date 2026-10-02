-- P1.6-W03 — direct-entry persistence foundation.
-- All tables are deny-by-default. Runtime writes are reserved for SECURITY DEFINER
-- RPCs; no table DML is granted to browser roles or service_role.

create table public.direct_entry_app_users (
  app_user_id uuid primary key default gen_random_uuid(),
  auth_subject uuid not null unique references auth.users(id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.recruiters (
  recruiter_id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now()
);

create table public.teams (
  team_id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(btrim(code)) between 1 and 128),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now()
);

create table public.recruiter_aliases (
  alias_id uuid primary key default gen_random_uuid(),
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  reporting_key text not null check (length(btrim(reporting_key)) between 1 and 200),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (recruiter_id, reporting_key, valid_from)
);

create table public.recruiter_provider_memberships (
  membership_id uuid primary key default gen_random_uuid(),
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  provider_type text not null check (provider_type in ('hrp', 'vendor')),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (recruiter_id, valid_from)
);

create table public.recruiter_team_memberships (
  membership_id uuid primary key default gen_random_uuid(),
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  team_id uuid not null references public.teams(team_id) on delete restrict,
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (recruiter_id, valid_from)
);

create table public.direct_entry_app_user_recruiter_links (
  link_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  verified boolean not null default false,
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (app_user_id, recruiter_id, valid_from)
);

create table public.direct_entry_capability_grants (
  grant_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  capability text not null check (capability in (
    'entry_create', 'entry_own', 'entry_team', 'entry_admin', 'entry_restore',
    'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
    'employment_status.request', 'employment_status.review', 'employment_status.apply',
    'document_upload', 'document_view', 'payment_view', 'payment_edit',
    'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view'
  )),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (app_user_id, capability, valid_from)
);

create table public.direct_entry_scope_grants (
  grant_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  scope_kind text not null check (scope_kind in ('own', 'team', 'all')),
  team_id uuid references public.teams(team_id) on delete restrict,
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  check ((scope_kind = 'team') = (team_id is not null))
);

create unique index direct_entry_scope_grants_start_uidx
  on public.direct_entry_scope_grants (
    app_user_id, scope_kind, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), valid_from
  );

create table public.direct_entry_projects (
  project_id text primary key check (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1)
);

create or replace function public.direct_entry_authorization_date()
returns date
language sql
stable
set search_path = pg_catalog
as $$
  select (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
$$;

create or replace function public.direct_entry_valid_worker_details(p_worker jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_field jsonb;
  v_value jsonb;
  v_state text;
  v_date text;
begin
  if jsonb_typeof(p_worker) <> 'object'
     or p_worker - array['display_name','date_of_birth','national_id','address','phone'] <> '{}'::jsonb
     or not (p_worker ?& array['display_name','date_of_birth','national_id','address','phone'])
     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or length(btrim(p_worker->>'display_name')) not between 1 and 256 then
    return false;
  end if;
  foreach v_key in array array['date_of_birth','national_id','address','phone'] loop
    v_field := p_worker->v_key;
    if jsonb_typeof(v_field) <> 'object'
       or v_field - array['state','value'] <> '{}'::jsonb
       or not (v_field ? 'state') then
      return false;
    end if;
    v_state := v_field->>'state';
    if v_state in ('omitted','unknown','intentionally_blank') then
      if v_field ? 'value' then return false; end if;
      continue;
    end if;
    if v_state <> 'provided' or not (v_field ? 'value') then
      return false;
    end if;
    v_value := v_field->'value';
    if v_key = 'date_of_birth' then
      if jsonb_typeof(v_value) <> 'string' then return false; end if;
      v_date := v_value#>>'{}';
      if v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
      begin
        if to_char(to_date(v_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_date then
          return false;
        end if;
      exception when others then
        return false;
      end;
    elsif jsonb_typeof(v_value) <> 'string' then
      return false;
    elsif v_key = 'national_id' and length(v_value#>>'{}') > 64 then
      return false;
    elsif v_key = 'address' and length(v_value#>>'{}') > 1024 then
      return false;
    elsif v_key = 'phone' and length(v_value#>>'{}') > 64 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table public.direct_entry_banks (
  bank_id text primary key check (bank_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1)
);

create table public.direct_entry_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  state text not null default 'DRAFT' check (state in ('DRAFT', 'REVIEW', 'SUBMITTED')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  check ((state = 'SUBMITTED') = (submitted_at is not null))
);

create table public.direct_entry_candidates (
  candidate_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table public.direct_entries (
  entry_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.direct_entry_submissions(submission_id) on delete restrict,
  candidate_id uuid not null references public.direct_entry_candidates(candidate_id) on delete restrict,
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  project_id text not null references public.direct_entry_projects(project_id) on delete restrict,
  first_work_date date not null,
  employee_code text not null,
  worker_details jsonb not null,
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  team_id uuid not null references public.teams(team_id) on delete restrict,
  provider_type text not null check (provider_type in ('hrp', 'vendor')),
  labor_type text not null check (labor_type in ('TEMPORARY', 'PERMANENT')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (employee_code ~ '^hrp-[0-9]{4}-[0-9]{6}$'),
  check (substring(employee_code from 5 for 4) = to_char(first_work_date, 'YYYY')),
  check (public.direct_entry_valid_worker_details(worker_details)
    and length(worker_details::text) <= 32768),
  unique (employee_code),
  unique (submission_id, entry_id)
);

create table public.direct_entry_payments (
  entry_id uuid primary key references public.direct_entries(entry_id) on delete restrict,
  state text not null check (state in ('omitted', 'unknown', 'intentionally_blank', 'provided')),
  account_number text,
  bank_id text references public.direct_entry_banks(bank_id) on delete restrict,
  account_holder_name text,
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  check (
    (state = 'provided' and
      account_number is not null and length(account_number) between 1 and 64 and
      bank_id is not null and
      account_holder_name is not null and length(btrim(account_holder_name)) between 1 and 256)
    or
    (state <> 'provided' and account_number is null and bank_id is null and account_holder_name is null)
  )
);

create table public.direct_entry_employment_status_events (
  event_id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.direct_entries(entry_id) on delete restrict,
  status text not null check (status in ('UNCONFIRMED', 'ON', 'OFF')),
  effective_date date not null,
  leave_date date,
  leave_reason_text text,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null,
  supersedes_event_id uuid references public.direct_entry_employment_status_events(event_id) on delete restrict,
  applied_at timestamptz not null default now(),
  check (
    (status = 'OFF' and leave_date = effective_date and
      leave_reason_text is not null and length(btrim(leave_reason_text)) between 1 and 4000)
    or
    (status in ('ON', 'UNCONFIRMED') and leave_date is null and leave_reason_text is null)
  ),
  unique (supersedes_event_id),
  unique (entry_id, version)
);

create table public.direct_entry_document_versions (
  document_id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.direct_entry_candidates(candidate_id) on delete restrict,
  document_type text not null check (document_type in ('CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')),
  version integer not null check (version >= 1),
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  storage_key text not null check (storage_key ~ '^p1\.6/[0-9a-f-]{36}/[A-Z_]+/[0-9]+/[0-9a-f-]{36}$'),
  upload_status text not null check (upload_status in
    ('QUEUED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'READY', 'FAILED', 'SUPERSEDED')),
  scan_status text not null check (scan_status in ('PENDING', 'CLEAN', 'REJECTED')),
  attempts integer not null default 0 check (attempts >= 0),
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  supersedes_document_id uuid references public.direct_entry_document_versions(document_id) on delete restrict,
  unique (candidate_id, document_type, idempotency_key),
  unique (candidate_id, document_type, version),
  unique (storage_key)
);

create table public.direct_entry_document_events (
  event_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.direct_entry_document_versions(document_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  idempotency_key text not null default gen_random_uuid()::text
    check (length(idempotency_key) between 1 and 128),
  request_hash text not null default repeat('0', 64)
    check (request_hash ~ '^[a-f0-9]{64}$'),
  upload_status text not null check (upload_status in
    ('QUEUED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'READY', 'FAILED', 'SUPERSEDED')),
  scan_status text not null check (scan_status in ('PENDING', 'CLEAN', 'REJECTED')),
  attempts integer not null check (attempts >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (document_id, version),
  unique (document_id, idempotency_key)
);

create view public.direct_entry_current_documents with (security_invoker = true) as
select document_id, candidate_id, document_type, version, idempotency_key,
       checksum_sha256, size_bytes, mime_type, upload_status, scan_status,
       attempts, created_by_user_id, created_at, supersedes_document_id
  from (
    select eligible_documents.*,
           row_number() over (
             partition by candidate_id, document_type
             order by version desc
           ) as current_rank
      from (
        select d.document_id, d.candidate_id, d.document_type, d.version,
               d.idempotency_key, d.checksum_sha256, d.size_bytes, d.mime_type,
               latest_event.upload_status, latest_event.scan_status,
               latest_event.attempts, d.created_by_user_id, d.created_at,
               d.supersedes_document_id
          from public.direct_entry_document_versions d
          join lateral (
            select e.upload_status, e.scan_status, e.attempts
              from public.direct_entry_document_events e
             where e.document_id = d.document_id
             order by e.version desc
             limit 1
          ) latest_event on true
         where latest_event.upload_status = 'READY'
           and latest_event.scan_status = 'CLEAN'
      ) eligible_documents
  ) current_documents
 where current_rank = 1;

create table public.direct_entry_restricted_reasons (
  reason_id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_text text not null check (length(btrim(reason_text)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table public.direct_entry_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.direct_entries(entry_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (entry_id, version)
);

create table public.direct_entry_submission_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.direct_entry_submissions(submission_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (submission_id, version)
);

create table public.direct_entry_change_requests (
  request_id uuid primary key default gen_random_uuid(),
  proposer_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  state text not null default 'PENDING' check (state in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  version integer not null default 1 check (version >= 1),
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  created_at timestamptz not null default now(),
  decided_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  decided_at timestamptz,
  decision_reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  unique (proposer_user_id, idempotency_key),
  check (
    (state in ('PENDING', 'WITHDRAWN') and decided_by_user_id is null and decided_at is null)
    or
    (state in ('APPROVED', 'REJECTED') and decided_by_user_id is not null and decided_at is not null
      and decision_reason_id is not null)
  )
);

create table public.direct_entry_change_request_items (
  item_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_entry_change_requests(request_id) on delete restrict,
  entry_id uuid not null references public.direct_entries(entry_id) on delete restrict,
  target_kind text not null check (target_kind in ('ENTRY_FIELD', 'PAYMENT', 'WORK_STATUS', 'DOCUMENT')),
  expected_version integer not null check (expected_version >= 1),
  proposal jsonb not null check (jsonb_typeof(proposal) = 'object' and length(proposal::text) <= 32768),
  created_at timestamptz not null default now(),
  unique (request_id, entry_id)
);

create table public.direct_entry_change_request_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_entry_change_requests(request_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (request_id, version)
);

create table public.direct_entry_audit_events (
  event_id uuid primary key default gen_random_uuid(),
  auth_subject uuid,
  app_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  action text not null check (length(action) between 1 and 96),
  capability text,
  resource_ref text,
  scope_kind text check (scope_kind is null or scope_kind in ('own', 'team', 'all')),
  scope_team_id uuid references public.teams(team_id) on delete restrict,
  outcome text not null check (outcome in ('ALLOW', 'DENY', 'APPLIED', 'REJECTED')),
  denial_code text,
  reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  changed_fields text[] not null default '{}',
  revision_id uuid references public.direct_entry_revisions(revision_id) on delete restrict,
  submission_revision_id uuid references public.direct_entry_submission_revisions(revision_id) on delete restrict,
  change_request_revision_id uuid references public.direct_entry_change_request_revisions(revision_id) on delete restrict,
  created_at timestamptz not null default now(),
  check (resource_ref is null or resource_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  check (cardinality(changed_fields) <= 64)
);

create table public.direct_entry_rpc_idempotency (
  idempotency_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  action text not null check (length(action) between 1 and 96),
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz not null default now(),
  unique (app_user_id, action, idempotency_key)
);

alter table public.direct_entry_employment_status_events
  add constraint direct_entry_status_reason_fk
  foreign key (reason_id) references public.direct_entry_restricted_reasons(reason_id) on delete restrict;

create index on public.direct_entry_audit_events (app_user_id, created_at desc);
create index on public.direct_entry_audit_events (resource_ref, created_at desc);
create index on public.direct_entry_revisions (entry_id, version desc);
create index on public.direct_entry_submission_revisions (submission_id, version desc);
create index on public.direct_entry_change_request_revisions (request_id, version desc);
create index on public.direct_entry_document_versions (candidate_id, document_type, version desc);
create index on public.direct_entry_change_request_items (entry_id, request_id);
create index on public.direct_entry_document_events (document_id, created_at desc);
create index on public.direct_entry_rpc_idempotency (created_at);

create or replace function public.direct_entry_guard_effective_interval()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_overlap boolean;
begin
  if tg_table_name = 'recruiter_provider_memberships' then
    v_key := 'provider:' || new.recruiter_id::text;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.recruiter_provider_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(m.valid_from, m.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'recruiter_team_memberships' then
    v_key := 'team-membership:' || new.recruiter_id::text;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(m.valid_from, m.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'direct_entry_scope_grants' then
    v_key := 'scope:' || new.app_user_id::text || ':' || new.scope_kind || ':' ||
      coalesce(new.team_id::text, new.app_user_id::text);
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.direct_entry_scope_grants g
       where g.app_user_id = new.app_user_id
         and g.scope_kind = new.scope_kind
         and g.team_id is not distinct from new.team_id
         and g.grant_id <> coalesce(new.grant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(g.valid_from, g.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'direct_entry_capability_grants' then
    v_key := 'capability:' || new.app_user_id || ':' || new.capability;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = new.app_user_id
         and g.capability = new.capability
         and g.grant_id <> coalesce(new.grant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(g.valid_from, g.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'direct_entry_app_user_recruiter_links' and new.verified then
    v_key := 'recruiter-link:' || new.app_user_id;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = new.app_user_id
         and l.verified
         and l.link_id <> coalesce(new.link_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(l.valid_from, l.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  else
    raise exception 'unsupported interval table: %', tg_table_name using errcode = '22023';
  end if;

  if v_overlap then
    raise exception 'effective interval overlaps an existing grant or membership'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

create trigger direct_entry_provider_membership_no_overlap
  before insert or update of recruiter_id, valid_from, valid_to
  on public.recruiter_provider_memberships
  for each row execute function public.direct_entry_guard_effective_interval();
create trigger direct_entry_team_membership_no_overlap
  before insert or update of recruiter_id, valid_from, valid_to
  on public.recruiter_team_memberships
  for each row execute function public.direct_entry_guard_effective_interval();
create trigger direct_entry_scope_grant_no_overlap
  before insert or update of app_user_id, scope_kind, team_id, valid_from, valid_to
  on public.direct_entry_scope_grants
  for each row execute function public.direct_entry_guard_effective_interval();
create trigger direct_entry_capability_grant_no_overlap
  before insert or update of app_user_id, capability, valid_from, valid_to
  on public.direct_entry_capability_grants
  for each row execute function public.direct_entry_guard_effective_interval();
create trigger direct_entry_recruiter_link_no_overlap
  before insert or update of app_user_id, verified, valid_from, valid_to
  on public.direct_entry_app_user_recruiter_links
  for each row execute function public.direct_entry_guard_effective_interval();

create or replace function public.direct_entry_validate_new_entry()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_provider_count integer;
  v_provider_type text;
  v_team_count integer;
begin
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = new.recruiter_id and r.active
  ) then
    raise exception 'recruiter is not active' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.teams t
     where t.team_id = new.team_id and t.active
  ) then
    raise exception 'team is not active' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = new.project_id and p.active
  ) then
    raise exception 'project is not active' using errcode = '23514';
  end if;

  select count(*), min(m.provider_type)
    into v_provider_count, v_provider_type
    from public.recruiter_provider_memberships m
   where m.recruiter_id = new.recruiter_id
     and m.valid_from <= new.first_work_date
     and (m.valid_to is null or new.first_work_date < m.valid_to);
  if v_provider_count <> 1 or v_provider_type <> new.provider_type then
    raise exception 'provider membership missing, ambiguous, or mismatched' using errcode = '23514';
  end if;

  select count(*) into v_team_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = new.recruiter_id
     and m.team_id = new.team_id
     and m.valid_from <= new.first_work_date
     and (m.valid_to is null or new.first_work_date < m.valid_to);
  if v_team_count <> 1 then
    raise exception 'team membership missing or ambiguous' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger direct_entry_validate_identity
  before insert or update of project_id, first_work_date, recruiter_id, team_id, provider_type
  on public.direct_entries
  for each row execute function public.direct_entry_validate_new_entry();

create or replace function public.direct_entry_validate_payment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.state = 'provided' and not exists (
    select 1 from public.direct_entry_banks b
     where b.bank_id = new.bank_id and b.active
  ) then
    raise exception 'bank is not active' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger direct_entry_payment_active_bank
  before insert or update on public.direct_entry_payments
  for each row execute function public.direct_entry_validate_payment();

create or replace function public.direct_entry_validate_status_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_first_work_date date;
  v_latest public.direct_entry_employment_status_events%rowtype;
  v_previous_status text := 'UNCONFIRMED';
  v_transition_valid boolean;
begin
  select first_work_date into v_first_work_date
    from public.direct_entries where entry_id = new.entry_id;
  if v_first_work_date is null or new.effective_date < v_first_work_date
     then
    raise exception 'status effective date is outside the allowed interval'
      using errcode = '23514';
  end if;
  select * into v_latest from public.direct_entry_employment_status_events e
   where e.entry_id = new.entry_id
     and not exists (
       select 1 from public.direct_entry_employment_status_events replacement
        where replacement.supersedes_event_id = e.event_id
     )
   order by e.version desc limit 1;
  if not found then
    if new.status <> 'UNCONFIRMED' or new.version <> 1
       or new.supersedes_event_id is not null
       or new.effective_date <> v_first_work_date then
      raise exception 'invalid initial employment status' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.supersedes_event_id is null then
    if new.effective_date > public.direct_entry_authorization_date()
       or new.effective_date < v_latest.effective_date then
      raise exception 'status transition date must be current or backdated to latest status'
        using errcode = '23514';
    end if;
    v_transition_valid := case v_latest.status
      when 'UNCONFIRMED' then new.status in ('ON','OFF')
      when 'ON' then new.status = 'OFF'
      when 'OFF' then new.status = 'ON'
      else false
    end;
  else
    if new.supersedes_event_id <> v_latest.event_id
       or new.effective_date <> v_latest.effective_date
       or new.effective_date > public.direct_entry_authorization_date() then
      raise exception 'status correction must supersede latest event' using errcode = '23514';
    end if;
    if new.status = v_latest.status then
      raise exception 'status correction cannot be a no-op' using errcode = '23514';
    end if;
    select e.status into v_previous_status
      from public.direct_entry_employment_status_events e
     where e.entry_id = new.entry_id
       and e.event_id <> v_latest.event_id
       and not exists (
         select 1 from public.direct_entry_employment_status_events replacement
          where replacement.supersedes_event_id = e.event_id
            and replacement.event_id <> v_latest.event_id
       )
     order by e.effective_date desc, e.version desc
     limit 1;
    v_transition_valid := new.status = v_previous_status or case v_previous_status
      when 'UNCONFIRMED' then new.status in ('ON','OFF')
      when 'ON' then new.status = 'OFF'
      when 'OFF' then new.status = 'ON'
      else false
    end;
  end if;
  if not v_transition_valid then
    raise exception 'invalid employment status transition' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger direct_entry_status_date_check
  before insert on public.direct_entry_employment_status_events
  for each row execute function public.direct_entry_validate_status_event();

create or replace function public.direct_entry_reject_immutable_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

create trigger direct_entry_audit_immutable
  before update or delete on public.direct_entry_audit_events
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_revisions_immutable
  before update or delete on public.direct_entry_revisions
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_submission_revisions_immutable
  before update or delete on public.direct_entry_submission_revisions
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_change_request_revisions_immutable
  before update or delete on public.direct_entry_change_request_revisions
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_status_immutable
  before update or delete on public.direct_entry_employment_status_events
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_document_versions_immutable
  before update or delete on public.direct_entry_document_versions
  for each row execute function public.direct_entry_reject_immutable_change();
create trigger direct_entry_document_events_immutable
  before update or delete on public.direct_entry_document_events
  for each row execute function public.direct_entry_reject_immutable_change();

create or replace function public.direct_entry_require_nonempty_submission()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
      from public.direct_entry_submissions s
      join public.direct_entries e on e.submission_id = s.submission_id
     where s.submission_id = new.submission_id
        and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_submissions s
      join public.direct_entries e on e.submission_id = s.submission_id
     where s.submission_id = new.submission_id
       and e.created_by_user_id <> s.created_by_user_id
  ) then
    raise exception 'submission owner must match every entry creator' using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger direct_entry_submission_nonempty
  after insert or update of state on public.direct_entry_submissions
  deferrable initially deferred
  for each row execute function public.direct_entry_require_nonempty_submission();

create or replace function public.direct_entry_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authorization_date date := public.direct_entry_authorization_date();
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = p_capability
       and g.valid_from <= v_authorization_date
       and (g.valid_to is null or v_authorization_date < g.valid_to)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.direct_entry_idempotency_begin(
  p_app_user_id uuid,
  p_action text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_hash text;
  v_result jsonb;
begin
  insert into public.direct_entry_rpc_idempotency
    (app_user_id, action, idempotency_key, request_hash)
  values
    (p_app_user_id, p_action, p_idempotency_key, p_request_hash)
  on conflict (app_user_id, action, idempotency_key) do nothing;

  select request_hash, result into v_hash, v_result
    from public.direct_entry_rpc_idempotency
   where app_user_id = p_app_user_id
     and action = p_action
     and idempotency_key = p_idempotency_key
   for update;

  if v_hash <> p_request_hash then
    raise exception 'idempotency key reused with different input' using errcode = '22023';
  end if;
  return v_result;
end;
$$;

create or replace function public.direct_entry_idempotency_finish(
  p_app_user_id uuid,
  p_action text,
  p_idempotency_key text,
  p_result jsonb
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  update public.direct_entry_rpc_idempotency
     set result = p_result
   where app_user_id = p_app_user_id
     and action = p_action
     and idempotency_key = p_idempotency_key;
  if not found then
    raise exception 'idempotency record missing' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date,
  p_required_scope text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_scope text;
  v_matches integer;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, p_capability
  );
  select count(*), min(g.scope_kind)
    into v_matches, v_scope
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.valid_from <= p_effective_date
     and (g.valid_to is null or p_effective_date < g.valid_to)
     and (
       (g.scope_kind = 'own' and p_entry_owner = p_app_user_id) or
       (g.scope_kind = 'team' and g.team_id = p_team_id) or
       g.scope_kind = 'all'
     )
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches <> 1 then
    raise exception 'resource scope denied' using errcode = '42501';
  end if;
  return v_scope;
end;
$$;

create or replace function public.direct_entry_assert_draft_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_required_scope text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_scope text;
  v_capability text;
  v_matches integer;
begin
  select count(*), min(g.scope_kind)
    into v_matches, v_scope
    from public.direct_entry_scope_grants g
    join public.direct_entry_capability_grants c
      on c.app_user_id = g.app_user_id
     and c.valid_from <= public.direct_entry_authorization_date()
     and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
     and c.capability = case g.scope_kind
       when 'own' then 'entry_own'
       when 'team' then 'entry_team'
       else 'entry_admin'
     end
   where g.app_user_id = p_app_user_id
     and g.valid_from <= p_resource_scope_date
     and (g.valid_to is null or p_resource_scope_date < g.valid_to)
     and (
       (g.scope_kind = 'own' and p_entry_owner = p_app_user_id) or
       (g.scope_kind = 'team' and g.team_id = p_team_id) or
       g.scope_kind = 'all'
     )
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches <> 1 then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  v_capability := case v_scope
    when 'own' then 'entry_own'
    when 'team' then 'entry_team'
    else 'entry_admin'
  end;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, v_capability
  );
  return v_scope;
end;
$$;

create or replace function public.direct_entry_assert_payment_document_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_submission_id uuid,
  p_privileged_capability text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state text;
begin
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = p_submission_id for update;
  if v_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_state = 'DRAFT' then
    if p_privileged_capability = 'document_upload' then
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'document_upload'
      );
    end if;
    return public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, p_entry_owner, p_team_id, p_resource_scope_date
    );
  end if;
  if v_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;
  if p_privileged_capability = 'document_upload' then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit'
    );
  end if;
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, p_privileged_capability,
    p_entry_owner, p_team_id, p_resource_scope_date
  );
end;
$$;

create or replace function public.direct_entry_assert_not_review(
  p_submission_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state text;
begin
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = p_submission_id for update;
  if v_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.direct_entry_reason(
  p_app_user_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reason_id uuid;
begin
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)
  values (p_app_user_id, p_reason)
  returning reason_id into v_reason_id;
  return v_reason_id;
end;
$$;

create or replace function public.direct_entry_entry_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'entry_id', e.entry_id,
    'submission_id', e.submission_id,
    'candidate_id', e.candidate_id,
    'created_by_user_id', e.created_by_user_id,
    'project_id', e.project_id,
    'first_work_date', e.first_work_date,
    'employee_code', e.employee_code,
    'worker_details', e.worker_details,
    'recruiter_id', e.recruiter_id,
    'team_id', e.team_id,
    'provider_type', e.provider_type,
    'labor_type', e.labor_type,
    'version', e.version,
    'deleted_at', e.deleted_at,
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date,
        'leave_date', st.leave_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id order by st.version desc limit 1
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'checksum_sha256', d.checksum_sha256,
        'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status
      ) order by d.document_type, d.version)
        from public.direct_entry_document_versions d
       where d.candidate_id = e.candidate_id
    ), '[]'::jsonb),
    'payment', case when p.entry_id is null then null else jsonb_build_object(
      'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
      'account_holder_name', p.account_holder_name, 'version', p.version
    ) end
  )
  from public.direct_entries e
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  where e.entry_id = p_entry_id
$$;

create or replace function public.direct_entry_write_revision(
  p_entry_id uuid,
  p_app_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_version integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_id uuid;
begin
  insert into public.direct_entry_revisions (
    entry_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_entry_id, p_version, p_app_user_id, p_reason_id, p_before, p_after
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;

create or replace function public.direct_entry_write_change_request_revision(
  p_request_id uuid,
  p_app_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_version integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_id uuid;
begin
  insert into public.direct_entry_change_request_revisions (
    request_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_request_id, p_version, p_app_user_id, p_reason_id, p_before, p_after
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;

create or replace function public.direct_entry_write_submission_revision(
  p_submission_id uuid,
  p_app_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_version integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_id uuid;
begin
  insert into public.direct_entry_submission_revisions (
    submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_submission_id, p_version, p_app_user_id, p_reason_id, p_before, p_after
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;

create or replace function public.direct_entry_payload_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;

create or replace function public.direct_entry_contains_authority(p_payload jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_pair record;
  v_value jsonb;
  v_key text;
begin
  if jsonb_typeof(p_payload) = 'object' then
    for v_pair in select key, value from jsonb_each(p_payload) loop
      v_key := regexp_replace(lower(v_pair.key), '[_-]', '', 'g');
      if v_key in (
        'owneruserid', 'createdbyuserid', 'appuserid', 'actorid', 'authsubject',
        'role', 'capability', 'scope'
      ) or public.direct_entry_contains_authority(v_pair.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_payload) = 'array' then
    for v_value in select value from jsonb_array_elements(p_payload) loop
      if public.direct_entry_contains_authority(v_value) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

create or replace function public.direct_entry_create_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_recruiter_id uuid;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_provider_type text;
  v_team_id uuid;
  v_scope text;
  v_count integer;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_entry_ids jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'invalid batch input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_create'
  );
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'batch_create', p_idempotency_key,
    public.direct_entry_payload_hash(p_rows)
  );
  if v_prior is not null then return v_prior; end if;
  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Initial batch creation');
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if (v_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
       <> '{}'::jsonb then
      raise exception 'unsupported batch field' using errcode = '22023';
    end if;
    v_project_id := v_row->>'project_id';
    v_first_work_date := (v_row->>'first_work_date')::date;
    v_employee_code := v_row->>'employee_code';
    v_worker_details := v_row->'worker_details';
    v_recruiter_id := (v_row->>'recruiter_id')::uuid;
    v_labor_type := v_row->>'labor_type';
    if public.direct_entry_contains_authority(v_worker_details) then
      raise exception 'client authority field forbidden' using errcode = '22023';
    end if;
    if v_project_id is null or v_first_work_date is null or v_employee_code is null
       or jsonb_typeof(v_worker_details) <> 'object'
       or v_recruiter_id is null or v_labor_type not in ('TEMPORARY','PERMANENT') then
      raise exception 'incomplete batch row' using errcode = '22023';
    end if;
    select count(*) into v_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
       and g.valid_from <= v_first_work_date
       and (g.valid_to is null or v_first_work_date < g.valid_to);
    if v_count <> 1 then
      raise exception 'entry creation own scope denied' using errcode = '42501';
    end if;
    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'recruiter provider membership denied' using errcode = '42501';
    end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'recruiter team membership denied' using errcode = '42501';
    end if;
    insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_labor_type
    ) returning entry_id into v_entry_id;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, 'UNCONFIRMED', v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    perform public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create', v_entry_id::text,
      'own', 'APPLIED', v_reason_id, array['entry_created']
    );
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id, 'state', 'DRAFT', 'version', 1, 'entry_ids', v_entry_ids
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_create_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_submission_version integer,
  p_row jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_entry_id uuid;
  v_candidate_id uuid;
  v_recruiter_id uuid;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_team_id uuid;
  v_provider_type text;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_count integer;
  v_scope text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_row) <> 'object'
     or (p_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
        <> '{}'::jsonb then
    raise exception 'invalid draft row input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_create'
  );
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'draft submission scope denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'submission_id', p_submission_id, 'expected_version', p_expected_submission_version,
      'row', p_row
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id
     or v_submission.state <> 'DRAFT' then
    raise exception 'draft submission denied' using errcode = '42501';
  end if;
  if p_expected_submission_version is null or p_expected_submission_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  v_project_id := p_row->>'project_id';
  v_first_work_date := (p_row->>'first_work_date')::date;
  v_employee_code := p_row->>'employee_code';
  v_worker_details := p_row->'worker_details';
  v_recruiter_id := (p_row->>'recruiter_id')::uuid;
  v_labor_type := p_row->>'labor_type';
  if public.direct_entry_contains_authority(v_worker_details) then
    raise exception 'client authority field forbidden' using errcode = '22023';
  end if;
  if v_project_id is null or v_first_work_date is null or v_employee_code is null
     or jsonb_typeof(v_worker_details) <> 'object'
     or v_recruiter_id is null or v_labor_type not in ('TEMPORARY','PERMANENT') then
    raise exception 'incomplete draft row' using errcode = '22023';
  end if;
  select count(*) into v_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
     and g.valid_from <= v_first_work_date
     and (g.valid_to is null or v_first_work_date < g.valid_to);
  if v_count <> 1 then
    raise exception 'entry creation own scope denied' using errcode = '42501';
  end if;
  select count(*), min(m.provider_type) into v_count, v_provider_type
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_recruiter_id and m.valid_from <= v_first_work_date
     and (m.valid_to is null or v_first_work_date < m.valid_to);
  if v_count <> 1 then
    raise exception 'recruiter provider membership denied' using errcode = '42501';
  end if;
  select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_recruiter_id and m.valid_from <= v_first_work_date
     and (m.valid_to is null or v_first_work_date < m.valid_to);
  if v_count <> 1 then
    raise exception 'recruiter team membership denied' using errcode = '42501';
  end if;
  insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
  insert into public.direct_entries (
    submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
    employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
  ) values (
    p_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
    v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_labor_type
  ) returning entry_id into v_entry_id;
  update public.direct_entry_submissions
     set version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row creation');
  insert into public.direct_entry_employment_status_events (
    entry_id, status, effective_date, version, actor_user_id, reason_id
  ) values (
    v_entry_id, 'UNCONFIRMED', v_first_work_date, 1, p_app_user_id, v_reason_id
  );
  perform public.direct_entry_write_revision(
    v_entry_id, p_app_user_id, v_reason_id, null,
    public.direct_entry_entry_snapshot(v_entry_id), 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,'entry_count',
      (select count(*) - 1 from public.direct_entries
        where submission_id=p_submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,'entry_count',
      (select count(*) from public.direct_entries where submission_id=p_submission_id)),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, revision_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_create', 'entry_create',
    v_entry_id::text, 'own', 'APPLIED', v_reason_id,
    (select revision_id from public.direct_entry_revisions where entry_id=v_entry_id and version=1),
    v_submission_revision_id, array['entry_created']
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry_id, 'candidate_id', v_candidate_id,
    'submission_id', p_submission_id, 'version', 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_update_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_patch_fields text[];
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_recruiter_id uuid;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_provider text;
  v_team uuid;
  v_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
        <> '{}'::jsonb then
    raise exception 'invalid draft patch' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_version, 'patch', p_patch
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if v_submission.state <> 'DRAFT' then
    raise exception 'draft submission is not editable' using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_new_recruiter_id := case when p_patch ? 'recruiter_id'
    then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end;
  v_new_work_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  if p_patch ? 'recruiter_id' or p_patch ? 'first_work_date' then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  else
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
  end if;
  perform public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_team, v_new_work_date, v_scope
  );
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details' then p_patch->'worker_details' else worker_details end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team,
    provider_type = v_provider,
    version = version + 1
   where entry_id = p_entry_id;
  update public.direct_entry_submissions set version = version + 1
   where submission_id = v_entry.submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row update');
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_entry.submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    v_submission.version + 1
  );
  select array_agg(key order by key) into v_patch_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id,
    submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_update',
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end,
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, v_submission_revision_id, v_patch_fields
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'version', v_entry.version + 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_delete_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_scope text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_delete', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if v_submission.state <> 'DRAFT' then
    raise exception 'draft submission is not editable' using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  if (select count(*) from public.direct_entries
       where submission_id = v_entry.submission_id and deleted_at is null) <= 1 then
    raise exception 'cannot delete final draft row' using errcode = '23514';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  update public.direct_entries
     set deleted_at = now(), version = version + 1
   where entry_id = p_entry_id;
  update public.direct_entry_submissions set version = version + 1
   where submission_id = v_entry.submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row deletion');
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_entry.submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,
      'entry_count',(select count(*) + 1 from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id,
    submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id,     'draft_row_delete',
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end,
    p_entry_id::text, v_scope, case when v_scope='team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, v_submission_revision_id, array['deleted_at']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'deleted', true, 'version', v_entry.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_delete', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_transition_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_target_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_prior_result jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;
  v_request_hash := encode(
    sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
    'hex'
  );
  v_prior_result := public.direct_entry_idempotency_begin(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
  );
  if v_prior_result is not null then return v_prior_result; end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;
  v_before := jsonb_build_object(
    'state', v_submission.state, 'version', v_submission.version,
    'submitted_at', v_submission.submitted_at
  );
  update public.direct_entry_submissions
     set state = p_target_state,
         version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Submission state transition');
  insert into public.direct_entry_submission_revisions (
    submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', p_target_state, 'version', v_submission.version + 1,
      'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
    )
  ) returning revision_id into v_submission_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
    p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
    v_submission_revision_id,
    array['state', 'version']
  );
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'state', p_target_state,
    'version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

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
       (old.state = 'DRAFT' and new.state = 'REVIEW') or
       (old.state = 'REVIEW' and new.state in ('DRAFT', 'SUBMITTED'))
     ) then
    raise exception 'invalid submission mutation or stale version' using errcode = '40001';
  end if;
  new.submitted_at := case when new.state = 'SUBMITTED' then now() else null end;
  new.updated_at := now();
  return new;
end;
$$;

create trigger direct_entry_submission_transition
  before update on public.direct_entry_submissions
  for each row execute function public.direct_entry_submission_transition_guard();

create or replace function public.direct_entry_entry_version_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.entry_id <> old.entry_id
     or new.submission_id <> old.submission_id
     or new.candidate_id <> old.candidate_id
     or new.created_by_user_id <> old.created_by_user_id
     or new.version <> old.version + 1 then
    raise exception 'invalid entry mutation or stale version' using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger direct_entry_version_guard
  before update on public.direct_entries
  for each row execute function public.direct_entry_entry_version_guard();

create or replace function public.direct_entry_change_request_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.state <> 'PENDING'
     or new.state not in ('APPROVED', 'REJECTED', 'WITHDRAWN')
     or new.version <> old.version + 1
     or new.proposer_user_id <> old.proposer_user_id
     or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash
     or new.reason_id <> old.reason_id then
    raise exception 'invalid change request transition' using errcode = '40001';
  end if;
  return new;
end;
$$;

create trigger direct_entry_change_request_transition
  before update on public.direct_entry_change_requests
  for each row execute function public.direct_entry_change_request_transition_guard();

create or replace function public.direct_entry_create_document_record(
  p_candidate_id uuid,
  p_document_type text,
  p_idempotency_key text,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_mime_type text,
  p_app_user_id uuid
)
returns table(document_id uuid, document_version integer, reused boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.direct_entry_document_versions%rowtype;
  v_document_id uuid := gen_random_uuid();
  v_version integer;
  v_supersedes uuid;
begin
  if p_document_type not in ('CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_checksum_sha256 !~ '^[a-f0-9]{64}$'
     or p_size_bytes not between 1 and 10485760
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'invalid document metadata' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'document:' || p_candidate_id::text || ':' || p_document_type, 0
  ));
  select * into v_existing
    from public.direct_entry_document_versions d
   where d.candidate_id = p_candidate_id and d.document_type = p_document_type
     and d.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.checksum_sha256 <> p_checksum_sha256
       or v_existing.size_bytes <> p_size_bytes or v_existing.mime_type <> p_mime_type then
      raise exception 'document idempotency key reused with different content'
        using errcode = '22023';
    end if;
    return query select v_existing.document_id, v_existing.version, true;
    return;
  end if;
  select coalesce(max(d.version), 0) + 1, (array_agg(d.document_id order by d.version desc))[1]
    into v_version, v_supersedes
    from public.direct_entry_document_versions d
   where d.candidate_id = p_candidate_id and d.document_type = p_document_type;
  insert into public.direct_entry_document_versions (
    document_id, candidate_id, document_type, version, idempotency_key, checksum_sha256,
    size_bytes, mime_type, storage_key, upload_status, scan_status,
    created_by_user_id, supersedes_document_id
  ) values (
    v_document_id, p_candidate_id, p_document_type, v_version, p_idempotency_key,
    p_checksum_sha256, p_size_bytes, p_mime_type,
    'p1.6/' || p_candidate_id::text || '/' || p_document_type || '/' ||
      v_version::text || '/' || v_document_id::text,
    'QUEUED', 'PENDING', p_app_user_id, v_supersedes
  );
  insert into public.direct_entry_document_events (
    document_id, upload_status, scan_status, attempts
  ) values (v_document_id, 'QUEUED', 'PENDING', 0);
  return query select v_document_id, v_version, false;
end;
$$;

create or replace function public.direct_entry_append_document_event(
  p_document_id uuid,
  p_expected_version integer,
  p_upload_status text,
  p_scan_status text,
  p_attempts integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_latest public.direct_entry_document_events%rowtype;
  v_existing public.direct_entry_document_events%rowtype;
  v_hash text;
  v_valid_transition boolean := false;
  v_event_id uuid := gen_random_uuid();
  v_version integer;
  v_result jsonb;
begin
  if p_document_id is null or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_upload_status is null or p_scan_status is null
     or p_upload_status not in ('QUEUED','UPLOADING','QUARANTINED','SCANNING','READY','FAILED','SUPERSEDED')
     or p_scan_status not in ('PENDING','CLEAN','REJECTED')
     or p_attempts is null or p_attempts < 0 then
    raise exception 'invalid document event input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('document-event:' || p_document_id::text, 0));
  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'document_id', p_document_id, 'expected_version', p_expected_version,
    'upload_status', p_upload_status, 'scan_status', p_scan_status,
    'attempts', p_attempts
  ));
  select * into v_existing from public.direct_entry_document_events e
   where e.document_id = p_document_id and e.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> v_hash then
      raise exception 'document event idempotency key reused with different input'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'event_id', v_existing.event_id, 'version', v_existing.version,
      'upload_status', v_existing.upload_status, 'scan_status', v_existing.scan_status,
      'attempts', v_existing.attempts, 'reused', true
    );
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1 for update;
  if not found then
    raise exception 'document event not found' using errcode = 'P0002';
  end if;
  if p_expected_version is null or p_expected_version <> v_latest.version then
    raise exception 'document event version conflict' using errcode = '40001';
  end if;
  if p_attempts < v_latest.attempts then
    raise exception 'document attempts cannot decrease' using errcode = '23514';
  end if;
  if v_latest.upload_status = 'QUEUED' then
    v_valid_transition := p_upload_status in ('UPLOADING','FAILED')
      and p_attempts = v_latest.attempts;
  elsif v_latest.upload_status = 'UPLOADING' then
    v_valid_transition := p_upload_status in ('QUARANTINED','FAILED')
      and p_attempts = v_latest.attempts;
  elsif v_latest.upload_status = 'QUARANTINED' then
    v_valid_transition := p_upload_status in ('SCANNING','FAILED')
      and p_attempts = v_latest.attempts;
  elsif v_latest.upload_status = 'SCANNING' then
    v_valid_transition := p_upload_status in ('READY','FAILED')
      and p_attempts = v_latest.attempts;
  elsif v_latest.upload_status = 'FAILED' then
    v_valid_transition := p_upload_status = 'UPLOADING'
      and p_attempts = v_latest.attempts + 1;
  elsif v_latest.upload_status = 'READY' then
    v_valid_transition := p_upload_status = 'SUPERSEDED'
      and p_attempts = v_latest.attempts
      and p_scan_status = v_latest.scan_status;
  end if;
  if not v_valid_transition
     or (p_upload_status = 'READY' and p_scan_status <> 'CLEAN')
     or (p_upload_status in ('QUEUED','UPLOADING','QUARANTINED','SCANNING')
         and p_scan_status <> 'PENDING')
     or (p_upload_status = 'FAILED' and p_scan_status not in ('PENDING','REJECTED')) then
    raise exception 'invalid document event transition' using errcode = '23514';
  end if;
  if p_upload_status = 'SUPERSEDED'
     and v_latest.upload_status <> 'READY' then
    raise exception 'only a ready document can be superseded' using errcode = '23514';
  end if;
  v_version := v_latest.version + 1;
  insert into public.direct_entry_document_events (
    event_id, document_id, version, idempotency_key, request_hash,
    upload_status, scan_status, attempts
  ) values (
    v_event_id, p_document_id, v_version, p_idempotency_key, v_hash,
    p_upload_status, p_scan_status, p_attempts
  );
  v_result := jsonb_build_object(
    'event_id', v_event_id, 'version', v_version,
    'upload_status', p_upload_status, 'scan_status', p_scan_status,
    'attempts', p_attempts, 'reused', false
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_update_payment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_expected_payment_version integer,
  p_payment jsonb,
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
  v_payment public.direct_entry_payments%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
  v_payment_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_payment) <> 'object'
     or (p_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
    raise exception 'invalid payment input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'payment_edit'
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'payment_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'entry_version', p_expected_entry_version,
      'payment_version', p_expected_payment_version, 'payment', p_payment, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  select * into v_payment from public.direct_entry_payments where entry_id = p_entry_id for update;
  if found then
    if p_expected_payment_version is null or p_expected_payment_version <> v_payment.version then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := v_payment.version + 1;
  else
    if p_expected_payment_version is distinct from 0 then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := 1;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_payments (
    entry_id, state, account_number, bank_id, account_holder_name, version
  ) values (
    p_entry_id, p_payment->>'state', p_payment->>'account_number',
    p_payment->>'bank_id', p_payment->>'account_holder_name', v_payment_version
  )
  on conflict (entry_id) do update set
    state = excluded.state, account_number = excluded.account_number,
    bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
    version = excluded.version, updated_at = now();
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'payment_update', 'payment_edit', p_entry_id::text,
    v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['payment']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'entry_version', v_entry.version + 1,
    'payment_version', v_payment_version
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'payment_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_apply_employment_status(
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
  v_latest public.direct_entry_employment_status_events%rowtype;
  v_scope text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_before jsonb;
  v_after jsonb;
  v_revision_id uuid;
  v_status_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_status not in ('UNCONFIRMED','ON','OFF') then
    raise exception 'invalid employment status input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'employment_status.apply',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  perform public.direct_entry_assert_not_review(v_entry.submission_id);
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'employment_status_apply', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_entry_version,
      'status', p_status, 'effective_date', p_effective_date,
      'leave_reason', p_leave_reason, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  select * into v_latest from public.direct_entry_employment_status_events
   where entry_id = p_entry_id order by version desc limit 1 for update;
  v_status_version := coalesce(v_latest.version, 0) + 1;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_employment_status_events (
    entry_id, status, effective_date, leave_date, leave_reason_text,
    version, actor_user_id, reason_id, supersedes_event_id
  ) values (
    p_entry_id, p_status, p_effective_date,
    case when p_status = 'OFF' then p_effective_date else null end,
    case when p_status = 'OFF' then p_leave_reason else null end,
    v_status_version, p_app_user_id, v_reason_id, null
  );
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'employment_status_apply',
    'employment_status.apply', p_entry_id::text, v_scope,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['employment_status']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'entry_version', v_entry.version + 1,
    'status_version', v_status_version, 'status', p_status
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'employment_status_apply', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_correct_latest_status(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_expected_status_version integer,
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
  v_latest public.direct_entry_employment_status_events%rowtype;
  v_scope text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_before jsonb;
  v_after jsonb;
  v_revision_id uuid;
  v_status_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_status not in ('UNCONFIRMED','ON','OFF') then
    raise exception 'invalid employment status correction' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'employment_status.apply',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  perform public.direct_entry_assert_not_review(v_entry.submission_id);
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'employment_status_correct', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'entry_version', p_expected_entry_version,
      'status_version', p_expected_status_version, 'status', p_status,
      'effective_date', p_effective_date, 'leave_reason', p_leave_reason, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  select * into v_latest from public.direct_entry_employment_status_events
   where entry_id = p_entry_id and not exists (
     select 1 from public.direct_entry_employment_status_events r
      where r.supersedes_event_id = direct_entry_employment_status_events.event_id
   ) order by version desc limit 1 for update;
  if not found or p_expected_status_version is null
     or p_expected_status_version <> v_latest.version then
    raise exception 'status version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_status_version := v_latest.version + 1;
  insert into public.direct_entry_employment_status_events (
    entry_id, status, effective_date, leave_date, leave_reason_text,
    version, actor_user_id, reason_id, supersedes_event_id
  ) values (
    p_entry_id, p_status, p_effective_date,
    case when p_status = 'OFF' then p_effective_date else null end,
    case when p_status = 'OFF' then p_leave_reason else null end,
    v_status_version, p_app_user_id, v_reason_id, v_latest.event_id
  );
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'employment_status_correct',
    'employment_status.apply', p_entry_id::text, v_scope,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['employment_status']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'entry_version', v_entry.version + 1,
    'status_version', v_status_version, 'status', p_status
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'employment_status_correct', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_create_document_metadata(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_document_type text,
  p_idempotency_key text,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_mime_type text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_before jsonb;
  v_after jsonb;
  v_revision_id uuid;
  v_document_id uuid;
  v_document_version integer;
  v_reused boolean;
  v_submission_state text;
  v_upload_status text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );
  select state into v_submission_state from public.direct_entry_submissions
   where submission_id = v_entry.submission_id;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'document_metadata_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_entry_version,
      'document_type', p_document_type, 'key', p_idempotency_key,
      'checksum', p_checksum_sha256, 'size', p_size_bytes,
      'mime', p_mime_type, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select document_id, document_version, reused
    into v_document_id, v_document_version, v_reused
    from public.direct_entry_create_document_record(
      v_entry.candidate_id, p_document_type, p_idempotency_key,
      p_checksum_sha256, p_size_bytes, p_mime_type, p_app_user_id
    );
  if v_reused then
    select e.upload_status into v_upload_status
      from public.direct_entry_document_events e
     where e.document_id = v_document_id order by e.version desc limit 1;
    v_result := jsonb_build_object(
      'document_id', v_document_id, 'version', v_document_version,
      'entry_version', v_entry.version, 'upload_status', v_upload_status, 'reused', true
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'document_metadata_create', p_idempotency_key, v_result
    );
    return v_result;
  end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  if v_submission_state = 'SUBMITTED' and
     (p_reason is null or length(btrim(p_reason)) not between 1 and 4000) then
    raise exception 'reason required for submitted document edit' using errcode = '22023';
  end if;
  v_reason_id := public.direct_entry_reason(
    p_app_user_id, coalesce(p_reason, 'Draft document metadata registered')
  );
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'document_metadata_create', 'document_upload',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['document_metadata']
  );
  v_result := jsonb_build_object(
    'document_id', v_document_id, 'version', v_document_version,
    'entry_version', v_entry.version + 1, 'upload_status', 'QUEUED', 'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_metadata_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_create_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_items jsonb,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_entry public.direct_entries%rowtype;
  v_request_id uuid := gen_random_uuid();
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_scope text;
  v_count integer := 0;
  v_revision_id uuid;
  v_submission_state text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'invalid change request input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_request_create'
  );
  for v_item in select value from jsonb_array_elements(p_items) loop
    if (v_item - array['entry_id','target_kind','expected_version','proposal']) <> '{}'::jsonb
       or jsonb_typeof(v_item->'proposal') <> 'object'
       or public.direct_entry_contains_authority(v_item->'proposal') then
      raise exception 'invalid change request item' using errcode = '22023';
    end if;
    if v_item->>'target_kind' is null
       or v_item->>'target_kind' not in ('ENTRY_FIELD','PAYMENT','WORK_STATUS','DOCUMENT') then
      raise exception 'unsupported change target' using errcode = '22023';
    end if;
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'
          ]) <> '{}'::jsonb)
       or (v_item->>'target_kind' = 'PAYMENT'
          and ((v_item->'proposal') - array[
            'state','account_number','bank_id','account_holder_name'
          ]) <> '{}'::jsonb)
       or (v_item->>'target_kind' = 'WORK_STATUS'
          and ((v_item->'proposal') - array[
            'status','effective_date','leave_reason'
          ]) <> '{}'::jsonb)
       or (v_item->>'target_kind' = 'DOCUMENT'
          and ((v_item->'proposal') - array[
            'document_type','idempotency_key','checksum_sha256','size_bytes','mime_type'
          ]) <> '{}'::jsonb) then
      raise exception 'unsupported change proposal field' using errcode = '22023';
    end if;
    select * into v_entry from public.direct_entries
     where entry_id = (v_item->>'entry_id')::uuid and deleted_at is null;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_request_create',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
    if not exists (
      select 1 from public.direct_entry_submissions s
       where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
    ) then
      raise exception 'change requests require submitted entries' using errcode = '42501';
    end if;
  end loop;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'items', p_items, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_create', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then return v_prior; end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_change_requests (
    request_id, proposer_user_id, idempotency_key, request_hash, reason_id
  ) values (
    v_request_id, p_app_user_id, p_idempotency_key, v_request_hash, v_reason_id
  );
  for v_item in select value from jsonb_array_elements(p_items) loop
    if (v_item - array['entry_id','target_kind','expected_version','proposal']) <> '{}'::jsonb
       or jsonb_typeof(v_item->'proposal') <> 'object' then
      raise exception 'invalid change request item' using errcode = '22023';
    end if;
    select * into v_entry from public.direct_entries
     where entry_id = (v_item->>'entry_id')::uuid and deleted_at is null for update;
    if not found then
      raise exception 'entry not found' using errcode = 'P0002';
    end if;
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_request_create',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
    if (v_item->>'expected_version')::integer is distinct from v_entry.version then
      raise exception 'entry version conflict' using errcode = '40001';
    end if;
    select state into v_submission_state from public.direct_entry_submissions
     where submission_id = v_entry.submission_id;
    if v_submission_state <> 'SUBMITTED' then
      raise exception 'change requests require submitted entries' using errcode = '42501';
    end if;
    if v_item->>'target_kind' is null
       or v_item->>'target_kind' not in ('ENTRY_FIELD','PAYMENT','WORK_STATUS','DOCUMENT') then
      raise exception 'unsupported change target' using errcode = '22023';
    end if;
    insert into public.direct_entry_change_request_items (
      request_id, entry_id, target_kind, expected_version, proposal
    ) values (
      v_request_id, v_entry.entry_id, v_item->>'target_kind',
      v_entry.version, v_item->'proposal'
    );
    v_count := v_count + 1;
  end loop;
  v_revision_id := public.direct_entry_write_change_request_revision(
    v_request_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','PENDING','version',1,'item_count',v_count), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_create', 'change_request_create',
    v_request_id::text, 'APPLIED', v_reason_id, v_revision_id, array['change_request_created']
  );
  v_result := jsonb_build_object('request_id', v_request_id, 'state', 'PENDING', 'items', v_count);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_withdraw_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_prior jsonb;
  v_result jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_request_create'
  );
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found or v_request.proposer_user_id <> p_app_user_id then
    raise exception 'change request scope denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_withdraw', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'request_id', p_request_id, 'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id for update;
  if v_request.state <> 'PENDING' or v_request.version <> p_expected_version then
    raise exception 'change request version conflict' using errcode = '40001';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Change request withdrawn');
  update public.direct_entry_change_requests
     set state = 'WITHDRAWN', version = version + 1
   where request_id = p_request_id;
  v_revision_id := public.direct_entry_write_change_request_revision(
    p_request_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state',v_request.state,'version',v_request.version),
    jsonb_build_object('state','WITHDRAWN','version',v_request.version + 1),
    v_request.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_withdraw',
    'change_request_create', p_request_id::text, 'APPLIED', v_reason_id,
    v_revision_id, array['state','version']
  );
  v_result := jsonb_build_object('request_id', p_request_id, 'state', 'WITHDRAWN',
    'version', v_request.version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_withdraw', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_apply_change_item(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_entry public.direct_entries,
  p_target_kind text,
  p_proposal jsonb,
  p_reason_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_team_id uuid;
  v_provider text;
  v_date date;
  v_recruiter_id uuid;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
    p_entry.team_id, p_entry.first_work_date
  );
  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      p_entry.created_by_user_id, v_team_id, v_date, v_scope
    );
    update public.direct_entries set
      project_id = case when p_proposal ? 'project_id' then p_proposal->>'project_id' else project_id end,
      first_work_date = v_date,
      employee_code = case when p_proposal ? 'employee_code' then p_proposal->>'employee_code' else employee_code end,
      worker_details = case when p_proposal ? 'worker_details' then p_proposal->'worker_details' else worker_details end,
      recruiter_id = v_recruiter_id, team_id = v_team_id, provider_type = v_provider,
      labor_type = case when p_proposal ? 'labor_type' then p_proposal->>'labor_type' else labor_type end,
      version = version + 1
     where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'PAYMENT' then
    if (p_proposal - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
      raise exception 'unsupported payment proposal field' using errcode = '22023';
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, account_holder_name, version
    ) values (
      p_entry.entry_id, p_proposal->>'state', p_proposal->>'account_number',
      p_proposal->>'bank_id', p_proposal->>'account_holder_name', 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'WORK_STATUS' then
    if (p_proposal - array['status','effective_date','leave_reason']) <> '{}'::jsonb then
      raise exception 'unsupported status proposal field' using errcode = '22023';
    end if;
    select * into v_latest from public.direct_entry_employment_status_events
     where entry_id = p_entry.entry_id order by version desc limit 1 for update;
    v_status_version := coalesce(v_latest.version, 0) + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry.entry_id, p_proposal->>'status', (p_proposal->>'effective_date')::date,
      case when p_proposal->>'status' = 'OFF' then (p_proposal->>'effective_date')::date end,
      case when p_proposal->>'status' = 'OFF' then p_proposal->>'leave_reason' end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'DOCUMENT' then
    if (p_proposal - array['document_type','idempotency_key','checksum_sha256','size_bytes','mime_type']) <> '{}'::jsonb then
      raise exception 'unsupported document proposal field' using errcode = '22023';
    end if;
    select document_id into v_document_id
      from public.direct_entry_create_document_record(
        p_entry.candidate_id, p_proposal->>'document_type',
        p_proposal->>'idempotency_key', p_proposal->>'checksum_sha256',
        (p_proposal->>'size_bytes')::bigint, p_proposal->>'mime_type', p_app_user_id
      );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  else
    raise exception 'unsupported change target' using errcode = '22023';
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry.entry_id, p_app_user_id, v_reason_id, v_before, v_after, p_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_approve', 'change_review',
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$$;

create or replace function public.direct_entry_decide_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_item record;
  v_entry public.direct_entries%rowtype;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
begin
  if p_decision not in ('APPROVED','REJECTED')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid change decision input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_review'
  );
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_request.proposer_user_id = p_app_user_id then
    raise exception 'change request proposer cannot review own request' using errcode = '42501';
  end if;
  for v_item in
    select i.entry_id from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end loop;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'request_id', p_request_id, 'version', p_expected_version,
      'decision', p_decision, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id for update;
  if not found or v_request.state <> 'PENDING'
     or v_request.version <> p_expected_version then
    raise exception 'change request version conflict' using errcode = '40001';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if p_decision = 'APPROVED' then
    for v_item in
      select i.* from public.direct_entry_change_request_items i
       where i.request_id = p_request_id order by i.entry_id for update
    loop
      select * into v_entry from public.direct_entries
       where entry_id = v_item.entry_id for update;
      if not found or v_entry.deleted_at is not null
         or v_entry.version <> v_item.expected_version then
        raise exception 'change item version conflict' using errcode = '40001';
      end if;
      perform public.direct_entry_apply_change_item(
        p_auth_subject, p_app_user_id, p_request_id, v_entry,
        v_item.target_kind, v_item.proposal, v_reason_id
      );
    end loop;
  else
    for v_item in
      select i.entry_id from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end loop;
  end if;
  v_revision_id := public.direct_entry_write_change_request_revision(
    p_request_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state',v_request.state,'version',v_request.version),
    jsonb_build_object('state',p_decision,'version',v_request.version + 1),
    v_request.version + 1
  );
  update public.direct_entry_change_requests
     set state = p_decision, version = version + 1,
         decided_by_user_id = p_app_user_id, decided_at = now(),
         decision_reason_id = v_reason_id
   where request_id = p_request_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    'change_review', p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,
    array['state','version']
  );
  v_result := jsonb_build_object(
    'request_id', p_request_id, 'state', p_decision, 'version', v_request.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_approve_change_request(
  p_auth_subject uuid, p_app_user_id uuid, p_request_id uuid,
  p_expected_version integer, p_reason text, p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.direct_entry_decide_change_request(
    p_auth_subject, p_app_user_id, p_request_id,
    p_expected_version, 'APPROVED', p_reason, p_idempotency_key
  )
$$;

create or replace function public.direct_entry_reject_change_request(
  p_auth_subject uuid, p_app_user_id uuid, p_request_id uuid,
  p_expected_version integer, p_reason text, p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.direct_entry_decide_change_request(
    p_auth_subject, p_app_user_id, p_request_id,
    p_expected_version, 'REJECTED', p_reason, p_idempotency_key
  )
$$;

create or replace function public.direct_entry_privileged_edit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
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
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_fields text[];
  v_team uuid;
  v_provider text;
  v_count integer;
  v_target_date date;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb then
    raise exception 'invalid privileged edit input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  perform public.direct_entry_assert_not_review(v_entry.submission_id);
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'version', p_expected_version, 'patch', p_patch, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  select count(*), min(m.provider_type) into v_count, v_provider
    from public.recruiter_provider_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.valid_from <= case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
     and (m.valid_to is null or case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
  if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
  select count(*), (array_agg(m.team_id))[1] into v_count, v_team
    from public.recruiter_team_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.valid_from <= case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
     and (m.valid_to is null or case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
  if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_team, v_target_date, v_scope
  );
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details' then p_patch->'worker_details' else worker_details end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team, provider_type = v_provider, version = version + 1
   where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  select array_agg(key order by key) into v_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'entry_privileged_edit', 'entry_privileged_edit',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_team else null end,
    'APPLIED', v_reason_id, v_revision_id, v_fields
  );
  v_result := jsonb_build_object('entry_id', p_entry_id, 'version', v_entry.version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
  v_account text;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_pii := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'pii_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_payment := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'payment_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  select p.account_number into v_account from public.direct_entry_payments p
   where p.entry_id = p_entry_id;
  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else '{}'::jsonb end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'account_holder_name', p.account_holder_name, 'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) || right(p.account_number, 4) end
      ) end from public.direct_entry_payments p where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object('status', st.status, 'effective_date', st.effective_date,
        'version', st.version)
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id order by st.version desc limit 1
    ),
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status
      ) order by d.document_type,d.version), '[]'::jsonb)
       from public.direct_entry_current_documents d where d.candidate_id = v_entry.candidate_id
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_read_audit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_limit integer default 100
)
returns setof public.direct_entry_audit_events
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
begin
  if p_limit not between 1 and 500 then
    raise exception 'invalid audit page size' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id;
  if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'audit_view',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  return query
    select a.* from public.direct_entry_audit_events a
     where a.resource_ref = p_entry_id::text
     order by a.created_at desc limit p_limit;
end;
$$;

-- RLS is enabled and forced everywhere; runtime access is through narrow RPCs.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'direct_entry_app_users', 'recruiters', 'teams',
    'recruiter_aliases', 'recruiter_provider_memberships',
    'recruiter_team_memberships', 'direct_entry_app_user_recruiter_links',
    'direct_entry_capability_grants', 'direct_entry_scope_grants',
    'direct_entry_projects', 'direct_entry_banks', 'direct_entry_submissions',
    'direct_entry_candidates', 'direct_entries', 'direct_entry_payments',
    'direct_entry_employment_status_events', 'direct_entry_document_versions',
    'direct_entry_document_events',
    'direct_entry_restricted_reasons', 'direct_entry_revisions',
    'direct_entry_submission_revisions',
    'direct_entry_change_request_revisions',
    'direct_entry_change_requests', 'direct_entry_change_request_items',
    'direct_entry_audit_events'
    , 'direct_entry_rpc_idempotency'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;

revoke all on function public.direct_entry_guard_effective_interval() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_validate_new_entry() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_validate_payment() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_validate_status_event() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_reject_immutable_change() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_require_nonempty_submission() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_submission_transition_guard() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_entry_version_guard() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_change_request_transition_guard() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_actor(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_payment_document_access(uuid, uuid, uuid, uuid, date, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_not_review(uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_idempotency_begin(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_idempotency_finish(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_draft_access(uuid, uuid, uuid, uuid, date, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_valid_worker_details(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_document_record(uuid, text, text, text, bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_append_document_event(uuid, integer, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_reason(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_entry_snapshot(uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_write_revision(uuid, uuid, uuid, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_write_change_request_revision(uuid, uuid, uuid, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_write_submission_revision(uuid, uuid, uuid, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_payload_hash(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_contains_authority(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_apply_change_item(uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_decide_change_request(uuid, uuid, uuid, integer, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_batch(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_draft_row(uuid, uuid, uuid, integer, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_delete_draft_row(uuid, uuid, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_transition_submission(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_update_payment(uuid, uuid, uuid, integer, integer, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_apply_employment_status(uuid, uuid, uuid, integer, text, date, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_document_metadata(uuid, uuid, uuid, integer, text, text, text, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_correct_latest_status(uuid, uuid, uuid, integer, integer, text, date, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_change_request(uuid, uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_withdraw_change_request(uuid, uuid, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_approve_change_request(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_reject_change_request(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_read_projection(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_read_audit(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on table public.direct_entry_current_documents from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_transition_submission(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.direct_entry_create_batch(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.direct_entry_create_draft_row(uuid, uuid, uuid, integer, jsonb, text) to service_role;
grant execute on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text) to service_role;
grant execute on function public.direct_entry_delete_draft_row(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.direct_entry_update_payment(uuid, uuid, uuid, integer, integer, jsonb, text, text) to service_role;
grant execute on function public.direct_entry_apply_employment_status(uuid, uuid, uuid, integer, text, date, text, text, text) to service_role;
grant execute on function public.direct_entry_correct_latest_status(uuid, uuid, uuid, integer, integer, text, date, text, text, text) to service_role;
grant execute on function public.direct_entry_create_document_metadata(uuid, uuid, uuid, integer, text, text, text, bigint, text, text) to service_role;
grant execute on function public.direct_entry_append_document_event(uuid, integer, text, text, integer, text) to service_role;
grant execute on function public.direct_entry_create_change_request(uuid, uuid, jsonb, text, text) to service_role;
grant execute on function public.direct_entry_withdraw_change_request(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.direct_entry_approve_change_request(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.direct_entry_reject_change_request(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text) to service_role;
grant execute on function public.direct_entry_read_projection(uuid, uuid, uuid) to service_role;
grant execute on function public.direct_entry_read_audit(uuid, uuid, uuid, integer) to service_role;
