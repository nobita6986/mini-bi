-- F1 Work Reports: templates, assignments, obligations and append-only submissions.
-- All application access is through the explicit service-role RPC allowlist below.
begin;

alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_capability_check;
alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (capability in (
    'entry_create', 'entry_own', 'entry_team', 'entry_admin', 'entry_restore',
    'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
    'employment_status.request', 'employment_status.review', 'employment_status.apply',
    'document_upload', 'document_view', 'payment_view', 'payment_edit',
    'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
    'catalog_master_manage', 'team_manager_assign',
    'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view'
  ));
comment on constraint direct_entry_capability_grants_capability_check
  on public.direct_entry_capability_grants is
  'F1: canonical DB vocabulary has 27 tokens: 23 existing tokens (including four retired compatibility tokens) plus four active Work Reports tokens.';

create table public.work_report_templates (
  template_id uuid primary key default gen_random_uuid(),
  template_code text not null unique check (template_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  description text check (description is null or length(description) <= 2000),
  default_frequency text not null check (default_frequency in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  current_published_version_id uuid,
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_report_templates_status_code_idx
  on public.work_report_templates (status, template_code);

create table public.work_report_template_versions (
  version_id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  version_no integer not null check (version_no >= 1),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  requires_review boolean not null default false,
  schema_json jsonb not null,
  metric_contract_json jsonb not null,
  schema_checksum text not null check (schema_checksum ~ '^[a-f0-9]{64}$'),
  published_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, version_no),
  check (
    (status = 'DRAFT' and published_at is null and published_by_user_id is null) or
    (status in ('PUBLISHED','ARCHIVED') and published_at is not null and published_by_user_id is not null)
  )
);
create unique index work_report_template_versions_one_draft_idx
  on public.work_report_template_versions (template_id) where status = 'DRAFT';
alter table public.work_report_templates
  add constraint work_report_templates_published_version_fk
  foreign key (current_published_version_id)
  references public.work_report_template_versions(version_id) on delete restrict;

create table public.work_report_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  target_kind text not null check (target_kind in ('USER', 'TEAM', 'USER_SET')),
  target_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  target_team_id uuid references public.teams(team_id) on delete restrict,
  frequency text not null check (frequency in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')),
  is_mandatory boolean not null default true,
  timezone text not null default 'Asia/Ho_Chi_Minh' check (timezone = 'Asia/Ho_Chi_Minh'),
  due_day_offset integer not null default 0 check (due_day_offset between 0 and 31),
  due_time_local time not null default '23:59:59',
  exclude_sundays boolean not null default false,
  effective_from date not null,
  effective_to date check (effective_to is null or effective_to >= effective_from),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'PAUSED', 'REVOKED')),
  is_current boolean not null default true,
  assigned_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_kind = 'USER' and target_user_id is not null and target_team_id is null) or
    (target_kind = 'TEAM' and target_team_id is not null and target_user_id is null) or
    (target_kind = 'USER_SET' and target_user_id is null and target_team_id is null)
  )
);
create unique index work_report_assignments_user_current_idx
  on public.work_report_assignments (template_id, target_user_id)
  where is_current and target_kind = 'USER';
create unique index work_report_assignments_team_current_idx
  on public.work_report_assignments (template_id, target_team_id)
  where is_current and target_kind = 'TEAM';
create index work_report_assignments_template_current_idx
  on public.work_report_assignments (template_id, is_current);
create index work_report_assignments_team_current_lookup_idx
  on public.work_report_assignments (target_team_id, is_current);
create index work_report_assignments_user_current_lookup_idx
  on public.work_report_assignments (target_user_id, is_current);

create table public.work_report_assignment_targets (
  assignment_target_id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.work_report_assignments(assignment_id) on delete cascade,
  target_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (assignment_id, target_user_id)
);
create index work_report_assignment_targets_user_idx
  on public.work_report_assignment_targets (target_user_id, assignment_id);

create table public.work_report_obligations (
  obligation_id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  assignment_id uuid not null references public.work_report_assignments(assignment_id) on delete restrict,
  assignee_app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  snapshot_team_id uuid references public.teams(team_id) on delete restrict,
  snapshot_team_code text,
  snapshot_team_display_name text,
  period_type text not null check (period_type in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')),
  period_key text not null check (length(period_key) between 7 and 32),
  period_start_date date not null,
  period_end_date date not null check (period_end_date >= period_start_date),
  due_at timestamptz not null,
  is_mandatory boolean not null default true,
  obligation_status text not null default 'ACTIVE' check (obligation_status in ('ACTIVE', 'EXEMPTED', 'CANCELLED')),
  reopened_until timestamptz,
  status_changed_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  status_reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, assignee_app_user_id, period_key)
);
create index work_report_obligations_template_period_idx
  on public.work_report_obligations (template_id, period_start_date, period_end_date, obligation_status);
create index work_report_obligations_team_period_idx
  on public.work_report_obligations (snapshot_team_id, period_start_date, obligation_status);
create index work_report_obligations_assignee_due_idx
  on public.work_report_obligations (assignee_app_user_id, obligation_status, due_at desc);

create table public.work_report_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null unique references public.work_report_obligations(obligation_id) on delete restrict,
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  assignee_app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  submitted_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  submitted_team_id uuid references public.teams(team_id) on delete restrict,
  current_revision_id uuid,
  state text not null default 'DRAFT' check (state in ('DRAFT', 'COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED')),
  draft_payload_json jsonb,
  first_submitted_at timestamptz,
  latest_submitted_at timestamptz,
  is_late boolean not null default false,
  has_post_deadline_amendment boolean not null default false,
  reviewed_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  reviewed_at timestamptz,
  review_reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_report_submissions_template_state_idx
  on public.work_report_submissions (template_id, state, latest_submitted_at desc);
create index work_report_submissions_team_state_idx
  on public.work_report_submissions (submitted_team_id, state);
create index work_report_submissions_assignee_state_idx
  on public.work_report_submissions (assignee_app_user_id, state, updated_at desc);

create table public.work_report_submission_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.work_report_submissions(submission_id) on delete restrict,
  obligation_id uuid not null references public.work_report_obligations(obligation_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  revision_no integer not null check (revision_no >= 1),
  payload_json jsonb not null,
  payload_checksum text not null check (payload_checksum ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  amendment_reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (submission_id, revision_no)
);
alter table public.work_report_submissions
  add constraint work_report_submissions_current_revision_fk
  foreign key (current_revision_id)
  references public.work_report_submission_revisions(revision_id) on delete restrict;

create table public.work_report_metric_values (
  metric_value_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.work_report_submissions(submission_id) on delete restrict,
  revision_id uuid not null references public.work_report_submission_revisions(revision_id) on delete restrict,
  obligation_id uuid not null references public.work_report_obligations(obligation_id) on delete restrict,
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  assignee_app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  snapshot_team_id uuid references public.teams(team_id) on delete restrict,
  period_type text not null check (period_type in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')),
  period_key text not null,
  period_start_date date not null,
  period_end_date date not null,
  field_key text not null,
  metric_key text not null,
  compatible_group text not null,
  value_type text not null check (value_type in ('INTEGER', 'DECIMAL', 'BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT')),
  unit text not null,
  numeric_value numeric(18,4),
  boolean_value boolean,
  option_key text,
  is_current_revision boolean not null default true,
  is_provisional boolean not null default false,
  is_final boolean not null default false,
  is_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  check (not (is_final and is_provisional)),
  check (is_eligible = (is_current_revision and (is_final or is_provisional))),
  check (
    (value_type in ('INTEGER', 'DECIMAL') and boolean_value is null and option_key is null) or
    (value_type = 'BOOLEAN' and numeric_value is null and option_key is null) or
    (value_type in ('SINGLE_SELECT', 'MULTI_SELECT') and numeric_value is null and boolean_value is null)
  )
);
create unique index work_report_metric_values_revision_field_option_idx
  on public.work_report_metric_values (revision_id, field_key, coalesce(option_key, ''));
create index work_report_metric_values_agg_idx
  on public.work_report_metric_values (template_id, metric_key, period_start_date, snapshot_team_id, assignee_app_user_id)
  where is_eligible;

create table public.work_report_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  action text not null check (length(btrim(action)) between 1 and 64),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  capability text,
  scope_kind text check (scope_kind is null or scope_kind in ('own', 'team', 'all')),
  scope_team_id uuid references public.teams(team_id) on delete restrict,
  template_id uuid references public.work_report_templates(template_id) on delete restrict,
  obligation_id uuid references public.work_report_obligations(obligation_id) on delete restrict,
  submission_id uuid references public.work_report_submissions(submission_id) on delete restrict,
  outcome text not null check (outcome in ('APPLIED', 'DENIED')),
  reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index work_report_audit_events_actor_created_idx
  on public.work_report_audit_events (actor_user_id, created_at desc);
create index work_report_audit_events_template_created_idx
  on public.work_report_audit_events (template_id, created_at desc);

-- Tracks only capability rows created by the Team Leader lifecycle. It prevents
-- a revoke from closing an independently granted Work Reports capability.
create table public.work_report_team_leader_capability_grants (
  leader_assignment_id uuid not null references public.direct_entry_team_leader_assignments(assignment_id) on delete cascade,
  capability text not null check (capability in ('report_view', 'report_analytics_view', 'report_assign')),
  capability_grant_id uuid not null references public.direct_entry_capability_grants(grant_id) on delete cascade,
  primary key (leader_assignment_id, capability)
);

do $rls$
declare
  v_table text;
begin
  foreach v_table in array array[
    'work_report_templates', 'work_report_template_versions', 'work_report_assignments',
    'work_report_assignment_targets', 'work_report_obligations', 'work_report_submissions',
    'work_report_submission_revisions', 'work_report_metric_values', 'work_report_audit_events',
    'work_report_team_leader_capability_grants'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$rls$;

create or replace function public.work_report_valid_template_schema(p_schema jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_section jsonb;
  v_field jsonb;
  v_option jsonb;
  v_section_keys text[] := array[]::text[];
  v_field_keys text[] := array[]::text[];
  v_option_keys text[];
  v_type text;
  v_validation jsonb;
begin
  if jsonb_typeof(p_schema) <> 'object'
     or p_schema ->> 'version' <> 'work-report-schema/1.0'
     or jsonb_typeof(p_schema -> 'sections') <> 'array'
     or jsonb_array_length(p_schema -> 'sections') = 0
     or (p_schema - array['version', 'sections']) <> '{}'::jsonb then
    return false;
  end if;
  for v_section in select value from jsonb_array_elements(p_schema -> 'sections') loop
    if jsonb_typeof(v_section) <> 'object'
       or (v_section - array['section_key','label','description','sort_order','fields']) <> '{}'::jsonb
       or coalesce(v_section ->> 'section_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or length(btrim(coalesce(v_section ->> 'label', ''))) not between 1 and 256
       or jsonb_typeof(v_section -> 'sort_order') <> 'number'
       or jsonb_typeof(v_section -> 'fields') <> 'array'
       or jsonb_array_length(v_section -> 'fields') = 0
       or (v_section ->> 'section_key') = any(v_section_keys) then
      return false;
    end if;
    v_section_keys := array_append(v_section_keys, v_section ->> 'section_key');
    for v_field in select value from jsonb_array_elements(v_section -> 'fields') loop
      v_type := v_field ->> 'field_type';
      v_validation := v_field -> 'validation';
      if jsonb_typeof(v_field) <> 'object'
         or (v_field - array['field_key','section_key','sort_order','label','description','field_type','required','default_value','validation','options','is_metric','metric_spec','is_dimension']) <> '{}'::jsonb
         or coalesce(v_field ->> 'field_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
         or v_field ->> 'section_key' <> v_section ->> 'section_key'
         or (v_field ->> 'field_key') = any(v_field_keys)
         or v_type not in ('text','textarea','integer','decimal','date','boolean','single_select','multi_select')
         or length(btrim(coalesce(v_field ->> 'label', ''))) not between 1 and 256
         or jsonb_typeof(v_field -> 'sort_order') <> 'number'
         or jsonb_typeof(v_field -> 'required') <> 'boolean'
         or jsonb_typeof(v_field -> 'is_metric') <> 'boolean'
         or jsonb_typeof(v_field -> 'is_dimension') <> 'boolean'
         or jsonb_typeof(v_validation) <> 'object'
         or ((v_field ->> 'is_metric')::boolean <> (jsonb_typeof(v_field -> 'metric_spec') = 'object')) then
        return false;
      end if;
      v_field_keys := array_append(v_field_keys, v_field ->> 'field_key');
      if v_type in ('single_select','multi_select') then
        if jsonb_typeof(v_field -> 'options') <> 'array'
           or jsonb_array_length(v_field -> 'options') not between 1 and 50 then
          return false;
        end if;
        v_option_keys := array[]::text[];
        for v_option in select value from jsonb_array_elements(v_field -> 'options') loop
          if jsonb_typeof(v_option) <> 'object'
             or (v_option - array['option_key','label','active','sort_order']) <> '{}'::jsonb
             or coalesce(v_option ->> 'option_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
             or (v_option ->> 'option_key') = any(v_option_keys)
             or length(btrim(coalesce(v_option ->> 'label', ''))) not between 1 and 256
             or jsonb_typeof(v_option -> 'active') <> 'boolean'
             or jsonb_typeof(v_option -> 'sort_order') <> 'number' then
            return false;
          end if;
          v_option_keys := array_append(v_option_keys, v_option ->> 'option_key');
        end loop;
      elsif jsonb_typeof(v_field -> 'options') <> 'null' then
        return false;
      end if;
      if v_type in ('integer','decimal') and (
        jsonb_typeof(v_validation -> 'min_value') <> 'number'
        or jsonb_typeof(v_validation -> 'max_value') <> 'number'
        or (v_validation ->> 'min_value')::numeric > (v_validation ->> 'max_value')::numeric
        or jsonb_typeof(v_validation -> 'allow_zero') <> 'boolean'
      ) then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function public.work_report_valid_metric_contract(p_schema jsonb, p_contract jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_metric jsonb;
  v_field jsonb;
  v_field_keys text[] := array[]::text[];
  v_metric_keys text[] := array[]::text[];
  v_match_count integer;
begin
  if not public.work_report_valid_template_schema(p_schema)
     or jsonb_typeof(p_contract) <> 'object'
     or p_contract ->> 'version' <> 'work-report-metrics/1.0'
     or jsonb_typeof(p_contract -> 'metrics') <> 'array'
     or (p_contract - array['version','metrics']) <> '{}'::jsonb then
    return false;
  end if;
  if jsonb_array_length(p_contract -> 'metrics') <> (
    select count(*) from jsonb_array_elements(p_schema -> 'sections') s,
      jsonb_array_elements(s -> 'fields') f where (f ->> 'is_metric')::boolean
  ) then return false; end if;
  for v_metric in select value from jsonb_array_elements(p_contract -> 'metrics') loop
    if jsonb_typeof(v_metric) <> 'object'
       or (v_metric - array['field_key','field_type','metric_key','unit','aggregations','null_policy','zero_policy','compatible_group']) <> '{}'::jsonb
       or coalesce(v_metric ->> 'field_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or coalesce(v_metric ->> 'metric_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or coalesce(v_metric ->> 'compatible_group', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or length(btrim(coalesce(v_metric ->> 'unit', ''))) not between 1 and 64
       or jsonb_typeof(v_metric -> 'aggregations') <> 'array'
       or jsonb_array_length(v_metric -> 'aggregations') = 0
       or v_metric ->> 'field_key' = any(v_field_keys)
       or v_metric ->> 'metric_key' = any(v_metric_keys) then
      return false;
    end if;
    select count(*) into v_match_count
      from jsonb_array_elements(p_schema -> 'sections') s,
        jsonb_array_elements(s -> 'fields') f
     where f ->> 'field_key' = v_metric ->> 'field_key'
       and (f ->> 'is_metric')::boolean
       and f ->> 'field_type' = v_metric ->> 'field_type'
       and f -> 'metric_spec' = v_metric - array['field_key','field_type'];
    if v_match_count <> 1 then return false; end if;
    for v_field in select jsonb_array_elements(v_metric -> 'aggregations') loop
      if trim(both '"' from v_field::text) not in (
        'SUM','AVG','MIN','MAX','COUNT_VALID','TRUE_COUNT','TRUE_RATE','COUNT_BY_OPTION'
      ) then return false; end if;
    end loop;
    v_field_keys := array_append(v_field_keys, v_metric ->> 'field_key');
    v_metric_keys := array_append(v_metric_keys, v_metric ->> 'metric_key');
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

alter table public.work_report_template_versions
  add constraint work_report_template_versions_schema_check
  check (public.work_report_valid_template_schema(schema_json));
alter table public.work_report_template_versions
  add constraint work_report_template_versions_metric_check
  check (public.work_report_valid_metric_contract(schema_json, metric_contract_json));

create or replace function public.work_report_valid_submission_payload(
  p_schema jsonb,
  p_payload jsonb,
  p_period_start date,
  p_period_end date,
  p_require_required boolean default true
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $function$
declare
  v_field jsonb;
  v_key text;
  v_type text;
  v_value jsonb;
  v_rule jsonb;
  v_option text;
begin
  if not public.work_report_valid_template_schema(p_schema) or jsonb_typeof(p_payload) <> 'object' then
    return false;
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) k
     where not exists (
       select 1 from jsonb_array_elements(p_schema -> 'sections') s,
         jsonb_array_elements(s -> 'fields') f where f ->> 'field_key' = k
     )
  ) then return false; end if;
  for v_field in select f from jsonb_array_elements(p_schema -> 'sections') s,
    jsonb_array_elements(s -> 'fields') f loop
    v_key := v_field ->> 'field_key';
    v_type := v_field ->> 'field_type';
    v_rule := v_field -> 'validation';
    if not (p_payload ? v_key) or jsonb_typeof(p_payload -> v_key) = 'null' then
      if p_require_required and (v_field ->> 'required')::boolean then return false; end if;
      continue;
    end if;
    v_value := p_payload -> v_key;
    if v_type in ('text','textarea') then
      if jsonb_typeof(v_value) <> 'string'
         or length(v_value #>> '{}') < coalesce((v_rule ->> 'min_length')::int, 0)
         or length(v_value #>> '{}') > coalesce((v_rule ->> 'max_length')::int, case when v_type='text' then 500 else 4000 end) then
        return false;
      end if;
    elsif v_type in ('integer','decimal') then
      if jsonb_typeof(v_value) <> 'number'
         or (v_type = 'integer' and (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric))
         or (v_value #>> '{}')::numeric < (v_rule ->> 'min_value')::numeric
         or (v_value #>> '{}')::numeric > (v_rule ->> 'max_value')::numeric
         or (not (v_rule ->> 'allow_zero')::boolean and (v_value #>> '{}')::numeric = 0) then
        return false;
      end if;
    elsif v_type = 'boolean' then
      if jsonb_typeof(v_value) <> 'boolean' then return false; end if;
    elsif v_type = 'date' then
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
      perform (v_value #>> '{}')::date;
      if v_rule ->> 'min_date_rule' = 'within_period'
         and ((v_value #>> '{}')::date < p_period_start or (v_value #>> '{}')::date > p_period_end) then return false; end if;
      if v_rule ->> 'min_date_rule' = 'not_future'
         and (v_value #>> '{}')::date > (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then return false; end if;
    elsif v_type = 'single_select' then
      if jsonb_typeof(v_value) <> 'string' or not exists (
        select 1 from jsonb_array_elements(v_field -> 'options') o
         where (o ->> 'active')::boolean and o ->> 'option_key' = v_value #>> '{}'
      ) then return false; end if;
    elsif v_type = 'multi_select' then
      if jsonb_typeof(v_value) <> 'array'
         or jsonb_array_length(v_value) < coalesce((v_rule ->> 'min_selected')::int, 0)
         or jsonb_array_length(v_value) > coalesce((v_rule ->> 'max_selected')::int, 50)
         or (select count(*) from jsonb_array_elements_text(v_value)) <>
            (select count(distinct x) from jsonb_array_elements_text(v_value) x)
         or exists (
           select 1 from jsonb_array_elements_text(v_value) x
            where not exists (
              select 1 from jsonb_array_elements(v_field -> 'options') o
               where (o ->> 'active')::boolean and o ->> 'option_key' = x
            )
         ) then return false; end if;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function public.work_report_immutable_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$function$;
create trigger work_report_submission_revisions_immutable
  before update or delete on public.work_report_submission_revisions
  for each row execute function public.work_report_immutable_guard();
create trigger work_report_audit_events_immutable
  before update or delete on public.work_report_audit_events
  for each row execute function public.work_report_immutable_guard();

create or replace function public.work_report_template_history_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'work report template history is immutable' using errcode = '55000';
  end if;
  if old.status in ('PUBLISHED','ARCHIVED') and (
    new.version_no <> old.version_no
    or new.requires_review <> old.requires_review
    or new.schema_json <> old.schema_json
    or new.metric_contract_json <> old.metric_contract_json
    or new.schema_checksum <> old.schema_checksum
  ) then
    raise exception 'published work report version is immutable' using errcode = '55000';
  end if;
  return new;
end;
$function$;
create trigger work_report_template_versions_history_guard
  before update or delete on public.work_report_template_versions
  for each row execute function public.work_report_template_history_guard();
create trigger work_report_templates_no_delete
  before delete on public.work_report_templates
  for each row execute function public.work_report_immutable_guard();

create or replace function public.work_report_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;
  if p_capability is not null and not public.direct_entry_has_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.work_report_current_team(p_app_user_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_team_id uuid;
  v_count integer;
begin
  select count(*)::int, (array_agg(m.team_id))[1] into v_count, v_team_id
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiter_team_memberships m on m.recruiter_id = l.recruiter_id and m.is_current
    join public.teams t on t.team_id = m.team_id and t.active
   where l.app_user_id = p_app_user_id and l.verified and l.is_current;
  if v_count <> 1 then return null; end if;
  return v_team_id;
end;
$function$;

create or replace function public.work_report_assert_scope(
  p_app_user_id uuid,
  p_capability text,
  p_team_id uuid default null,
  p_require_all boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not public.direct_entry_has_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if public.direct_entry_has_scope(p_app_user_id, 'all') then return 'all'; end if;
  if p_require_all then raise exception 'WORK_REPORT_ALL_SCOPE_REQUIRED' using errcode = '42501'; end if;
  if p_team_id is not null and exists (
    select 1 from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id and s.scope_kind = 'team'
       and s.team_id = p_team_id and s.is_current
  ) then return 'team'; end if;
  raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
end;
$function$;

create or replace function public.work_report_period(p_frequency text, p_business_date date)
returns table(period_key text, period_start_date date, period_end_date date)
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_iso_year integer;
  v_iso_week integer;
begin
  if p_frequency = 'DAILY' then
    return query select p_business_date::text, p_business_date, p_business_date;
  elsif p_frequency = 'WEEKLY' then
    v_iso_year := extract(isoyear from p_business_date)::int;
    v_iso_week := extract(week from p_business_date)::int;
    return query select format('%s-W%s', v_iso_year, lpad(v_iso_week::text, 2, '0')),
      date_trunc('week', p_business_date::timestamp)::date,
      (date_trunc('week', p_business_date::timestamp)::date + 6);
  elsif p_frequency = 'MONTHLY' then
    return query select to_char(p_business_date, 'YYYY-MM'),
      date_trunc('month', p_business_date::timestamp)::date,
      (date_trunc('month', p_business_date::timestamp) + interval '1 month - 1 day')::date;
  elsif p_frequency = 'ONCE' then
    return query select 'ONCE-' || p_business_date::text, p_business_date, p_business_date;
  else
    raise exception 'WORK_REPORT_FREQUENCY_INVALID' using errcode = '22023';
  end if;
end;
$function$;

create or replace function public.work_report_due_at(
  p_period_end date,
  p_offset integer,
  p_due_time time,
  p_exclude_sundays boolean
)
returns timestamptz
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_due_date date := p_period_end + p_offset;
begin
  if p_exclude_sundays and extract(isodow from v_due_date) = 7 then v_due_date := v_due_date + 1; end if;
  return (v_due_date + p_due_time) at time zone 'Asia/Ho_Chi_Minh';
end;
$function$;

create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_capability text;
  v_grant_id uuid;
begin
  if new.is_current then
    foreach v_capability in array array['report_view','report_analytics_view','report_assign'] loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id and g.capability = v_capability and g.is_current
      ) then
        select g.grant_id into v_grant_id
          from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and (g.valid_to is null or g.valid_to > g.valid_from)
           and daterange(g.valid_from, g.valid_to, '[)') && daterange(new.valid_from, null, '[)')
         order by g.valid_from desc
         limit 1;
        if v_grant_id is not null then
          update public.direct_entry_capability_grants
             set valid_to = null, is_current = true
           where grant_id = v_grant_id;
        else
          insert into public.direct_entry_capability_grants
            (app_user_id, capability, valid_from, valid_to, is_current)
          values (new.leader_app_user_id, v_capability, new.valid_from, null, true)
          returning grant_id into v_grant_id;
        end if;
        insert into public.work_report_team_leader_capability_grants
          (leader_assignment_id, capability, capability_grant_id)
        values (new.assignment_id, v_capability, v_grant_id)
        on conflict (leader_assignment_id, capability) do update
          set capability_grant_id = excluded.capability_grant_id;
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and old.is_current and not new.is_current then
    if new.valid_to is distinct from old.valid_to and new.valid_to is not null then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
      update public.direct_entry_capability_grants g
         set is_current = false,
             valid_to = greatest(new.valid_to, g.valid_from)
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = old.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.is_current;
    else
      update public.direct_entry_capability_grants g
         set is_current = false
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = old.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.is_current;
    end if;
  end if;
  return new;
end;
$function$;
create trigger work_report_sync_team_leader_capabilities
  after insert or update of is_current on public.direct_entry_team_leader_assignments
  for each row execute function public.work_report_sync_team_leader_capabilities();

-- The trigger function cannot be invoked as a normal function. Backfill through
-- a harmless marker transition so the same code path owns all generated grants.
update public.direct_entry_team_leader_assignments
   set is_current = true
 where is_current;

create or replace function public.work_report_list_templates(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'template_id', t.template_id,
      'template_code', t.template_code,
      'display_name', t.display_name,
      'description', t.description,
      'default_frequency', t.default_frequency,
      'status', t.status,
      'current_published_version_id', t.current_published_version_id,
      'draft_version_id', d.version_id,
      'version', t.version,
      'updated_at', t.updated_at
    ) order by t.template_code)
      from public.work_report_templates t
      left join public.work_report_template_versions d
        on d.template_id = t.template_id and d.status = 'DRAFT'
  ), '[]'::jsonb));
end;
$function$;

create or replace function public.work_report_get_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  select jsonb_build_object(
    'template_id', t.template_id,
    'template_code', t.template_code,
    'display_name', t.display_name,
    'description', t.description,
    'default_frequency', t.default_frequency,
    'status', t.status,
    'current_published_version_id', t.current_published_version_id,
    'version', t.version,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'version_id', v.version_id,
        'version_no', v.version_no,
        'status', v.status,
        'requires_review', v.requires_review,
        'schema_json', v.schema_json,
        'metric_contract_json', v.metric_contract_json,
        'schema_checksum', v.schema_checksum,
        'published_at', v.published_at
      ) order by v.version_no desc)
      from public.work_report_template_versions v where v.template_id = t.template_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_templates t where t.template_id = p_template_id;
  if v_result is null then raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002'; end if;
  return v_result;
end;
$function$;

create or replace function public.work_report_create_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_code text,
  p_display_name text,
  p_description text,
  p_default_frequency text,
  p_schema_json jsonb,
  p_metric_contract_json jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template_id uuid;
  v_version_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  if p_template_code is null or p_template_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
     or length(btrim(coalesce(p_display_name, ''))) not between 1 and 256
     or p_default_frequency not in ('DAILY','WEEKLY','MONTHLY','ONCE')
     or not public.work_report_valid_template_schema(p_schema_json)
     or not public.work_report_valid_metric_contract(p_schema_json, p_metric_contract_json)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_TEMPLATE_INVALID' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_code', p_template_code, 'display_name', p_display_name,
    'description', p_description, 'default_frequency', p_default_frequency,
    'schema_json', p_schema_json, 'metric_contract_json', p_metric_contract_json
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_create', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  insert into public.work_report_templates
    (template_code, display_name, description, default_frequency, created_by_user_id)
  values
    (p_template_code, btrim(p_display_name), nullif(btrim(p_description), ''), p_default_frequency, p_app_user_id)
  returning template_id into v_template_id;
  insert into public.work_report_template_versions
    (template_id, version_no, schema_json, metric_contract_json, schema_checksum)
  values
    (v_template_id, 1, p_schema_json, p_metric_contract_json,
     encode(sha256(convert_to(p_schema_json::text, 'UTF8')), 'hex'))
  returning version_id into v_version_id;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_CREATE', p_app_user_id, 'report_form_manage', 'all', v_template_id, 'APPLIED',
    jsonb_build_object('version_id', v_version_id));
  v_result := jsonb_build_object('template_id', v_template_id, 'draft_version_id', v_version_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_create', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_update_template_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_draft_version_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_description text,
  p_default_frequency text,
  p_schema_json jsonb,
  p_metric_contract_json jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  if p_expected_version is null or p_expected_version < 1
     or length(btrim(coalesce(p_display_name, ''))) not between 1 and 256
     or p_default_frequency not in ('DAILY','WEEKLY','MONTHLY','ONCE')
     or not public.work_report_valid_template_schema(p_schema_json)
     or not public.work_report_valid_metric_contract(p_schema_json, p_metric_contract_json)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_TEMPLATE_INVALID' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id, 'draft_version_id', p_draft_version_id,
    'expected_version', p_expected_version, 'display_name', p_display_name,
    'description', p_description, 'default_frequency', p_default_frequency,
    'schema_json', p_schema_json, 'metric_contract_json', p_metric_contract_json
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_update', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_templates
     set display_name = btrim(p_display_name), description = nullif(btrim(p_description), ''),
         default_frequency = p_default_frequency, version = version + 1, updated_at = now()
   where template_id = p_template_id and version = p_expected_version and status <> 'ARCHIVED';
  if not found then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001'; end if;
  update public.work_report_template_versions
     set schema_json = p_schema_json, metric_contract_json = p_metric_contract_json,
         schema_checksum = encode(sha256(convert_to(p_schema_json::text, 'UTF8')), 'hex'), updated_at = now()
   where version_id = p_draft_version_id and template_id = p_template_id and status = 'DRAFT';
  if not found then raise exception 'WORK_REPORT_DRAFT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_DRAFT_UPDATE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', p_draft_version_id));
  v_result := jsonb_build_object('template_id', p_template_id, 'draft_version_id', p_draft_version_id,
    'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_update', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_clone_template_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_source public.work_report_template_versions%rowtype;
  v_version_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('template_id', p_template_id, 'expected_version', p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_clone', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  select * into v_template from public.work_report_templates where template_id = p_template_id for update;
  if not found then raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_template.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001'; end if;
  if v_template.status = 'ARCHIVED' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_PUBLISHED' using errcode = '22023';
  end if;
  if exists (select 1 from public.work_report_template_versions where template_id=p_template_id and status='DRAFT') then
    raise exception 'WORK_REPORT_DRAFT_EXISTS' using errcode = '23505';
  end if;
  select * into v_source from public.work_report_template_versions
   where version_id = v_template.current_published_version_id;
  insert into public.work_report_template_versions
    (template_id, version_no, schema_json, metric_contract_json, schema_checksum, requires_review)
  values
    (p_template_id, v_source.version_no + 1, v_source.schema_json, v_source.metric_contract_json,
     v_source.schema_checksum, v_source.requires_review)
  returning version_id into v_version_id;
  update public.work_report_templates set version=version+1, updated_at=now() where template_id=p_template_id;
  v_result := jsonb_build_object('template_id', p_template_id, 'draft_version_id', v_version_id,
    'version', p_expected_version + 1);
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_DRAFT_CLONE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', v_version_id));
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_clone', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_publish_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_draft_version_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id, 'draft_version_id', p_draft_version_id, 'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_publish', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  select * into v_template from public.work_report_templates where template_id=p_template_id for update;
  if not found then raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_template.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001'; end if;
  if v_template.status = 'ARCHIVED' then raise exception 'WORK_REPORT_TEMPLATE_ARCHIVED' using errcode = '22023'; end if;
  update public.work_report_template_versions
     set status='ARCHIVED', updated_at=now()
   where version_id=v_template.current_published_version_id and status='PUBLISHED';
  update public.work_report_template_versions
     set status='PUBLISHED', published_by_user_id=p_app_user_id, published_at=now(), updated_at=now()
   where version_id=p_draft_version_id and template_id=p_template_id and status='DRAFT';
  if not found then raise exception 'WORK_REPORT_DRAFT_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.work_report_templates
     set status='ACTIVE', current_published_version_id=p_draft_version_id,
         version=version+1, updated_at=now()
   where template_id=p_template_id;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_PUBLISH', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', p_draft_version_id));
  v_result := jsonb_build_object('template_id', p_template_id, 'published_version_id', p_draft_version_id,
    'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_publish', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_archive_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('template_id',p_template_id,'expected_version',p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_archive', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_templates
     set status='ARCHIVED', version=version+1, updated_at=now()
   where template_id=p_template_id and version=p_expected_version and status <> 'ARCHIVED';
  if not found then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001'; end if;
  update public.work_report_assignments
     set state='REVOKED', is_current=false, version=version+1, updated_at=now()
   where template_id=p_template_id and is_current;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome)
  values ('TEMPLATE_ARCHIVE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED');
  v_result := jsonb_build_object('template_id',p_template_id,'status','ARCHIVED','version',p_expected_version+1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_archive', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_resolve_assignment_user_team(p_app_user_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_team_id uuid := public.work_report_current_team(p_app_user_id);
begin
  if v_team_id is null then raise exception 'WORK_REPORT_ASSIGNEE_TEAM_AMBIGUOUS' using errcode = '42501'; end if;
  return v_team_id;
end;
$function$;

create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_user_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_assign');
  if p_target_kind not in ('USER','TEAM','USER_SET')
     or p_frequency not in ('DAILY','WEEKLY','MONTHLY','ONCE')
     or p_due_day_offset not between 0 and 31
     or p_effective_from is null or (p_effective_to is not null and p_effective_to < p_effective_from)
     or length(coalesce(p_idempotency_key,'')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind='USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind='TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind='USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind='USER_SET' and coalesce(cardinality(p_target_user_ids),0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind='TEAM' then v_scope_team_id := p_target_team_id;
  elsif p_target_kind='USER' then v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;
  if public.direct_entry_has_scope(p_app_user_id,'all') then v_scope := 'all';
  else
    if p_target_kind in ('USER','TEAM') then
      v_scope := public.work_report_assert_scope(p_app_user_id,'report_assign',v_scope_team_id,false);
    else
      if exists (
        select 1 from unnest(p_target_user_ids) x(user_id)
         where not exists (
           select 1 from public.direct_entry_scope_grants s
            where s.app_user_id=p_app_user_id and s.scope_kind='team' and s.is_current
              and s.team_id=public.work_report_current_team(x.user_id)
         )
      ) then raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501'; end if;
      v_scope := 'team';
    end if;
  end if;
  select * into v_template from public.work_report_templates where template_id=p_template_id for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id',p_template_id,'target_kind',p_target_kind,'target_user_id',p_target_user_id,
    'target_team_id',p_target_team_id,'target_user_ids',p_target_user_ids,'frequency',p_frequency,
    'is_mandatory',p_is_mandatory,'due_day_offset',p_due_day_offset,'due_time_local',p_due_time_local,
    'exclude_sundays',p_exclude_sundays,'effective_from',p_effective_from,'effective_to',p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_assignment_create',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  insert into public.work_report_assignments
    (template_id,template_version_id,target_kind,target_user_id,target_team_id,frequency,is_mandatory,
     due_day_offset,due_time_local,exclude_sundays,effective_from,effective_to,assigned_by_user_id)
  values
    (p_template_id,v_template.current_published_version_id,p_target_kind,p_target_user_id,p_target_team_id,p_frequency,
     coalesce(p_is_mandatory,true),p_due_day_offset,p_due_time_local,coalesce(p_exclude_sundays,false),
     p_effective_from,p_effective_to,p_app_user_id)
  returning assignment_id into v_assignment_id;
  if p_target_kind='USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id,target_user_id)
      select v_assignment_id, x from (select distinct unnest(p_target_user_ids) x) q;
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,outcome,metadata_json)
  values ('ASSIGNMENT_CREATE',p_app_user_id,'report_assign',v_scope,
    case when v_scope='team' then v_scope_team_id else null end,p_template_id,'APPLIED',
    jsonb_build_object('assignment_id',v_assignment_id,'target_kind',p_target_kind));
  v_result := jsonb_build_object('assignment_id',v_assignment_id,'version',1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_assignment_create',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_set_assignment_state(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_team_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,'report_assign');
  if p_state not in ('ACTIVE','PAUSED','REVOKED') then raise exception 'WORK_REPORT_ASSIGNMENT_STATE_INVALID' using errcode='22023'; end if;
  select * into v_assignment from public.work_report_assignments where assignment_id=p_assignment_id for update;
  if not found then raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode='P0002'; end if;
  if v_assignment.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_team_id := case v_assignment.target_kind when 'TEAM' then v_assignment.target_team_id
    when 'USER' then public.work_report_resolve_assignment_user_team(v_assignment.target_user_id) else null end;
  if public.direct_entry_has_scope(p_app_user_id,'all') then v_scope := 'all';
  elsif v_assignment.target_kind='USER_SET' then
    if exists (select 1 from public.work_report_assignment_targets x
      where x.assignment_id=p_assignment_id and not exists (
        select 1 from public.direct_entry_scope_grants s where s.app_user_id=p_app_user_id
          and s.scope_kind='team' and s.is_current and s.team_id=public.work_report_current_team(x.target_user_id)
      )) then raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode='42501'; end if;
    v_scope := 'team';
  else v_scope := public.work_report_assert_scope(p_app_user_id,'report_assign',v_team_id,false);
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('assignment_id',p_assignment_id,'expected_version',p_expected_version,'state',p_state));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_assignment_state',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_assignments set state=p_state,is_current=(p_state<>'REVOKED'),version=version+1,updated_at=now()
   where assignment_id=p_assignment_id;
  if p_state='REVOKED' then
    update public.work_report_obligations set obligation_status='CANCELLED',status_changed_by_user_id=p_app_user_id,
      version=version+1,updated_at=now()
     where assignment_id=p_assignment_id and obligation_status='ACTIVE'
       and not exists (select 1 from public.work_report_submissions s where s.obligation_id=work_report_obligations.obligation_id and s.first_submitted_at is not null);
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,outcome,metadata_json)
  values ('ASSIGNMENT_STATE',p_app_user_id,'report_assign',v_scope,case when v_scope='team' then v_team_id end,
    v_assignment.template_id,'APPLIED',jsonb_build_object('assignment_id',p_assignment_id,'state',p_state));
  v_result := jsonb_build_object('assignment_id',p_assignment_id,'state',p_state,'version',p_expected_version+1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_assignment_state',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_ensure_obligations_for_window(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,'report_assign');
  if p_business_date is null then raise exception 'WORK_REPORT_DATE_INVALID' using errcode='22023'; end if;
  with candidate as (
    select a.*, u.app_user_id as assignee_id,
      public.work_report_current_team(u.app_user_id) as team_id
      from public.work_report_assignments a
      cross join lateral (
        select a.target_user_id as app_user_id where a.target_kind='USER'
        union all
        select x.target_user_id from public.work_report_assignment_targets x
          where a.target_kind='USER_SET' and x.assignment_id=a.assignment_id
        union all
        select l.app_user_id
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m on m.recruiter_id=l.recruiter_id and m.is_current
         where a.target_kind='TEAM' and m.team_id=a.target_team_id and l.verified and l.is_current
      ) u
     where a.is_current and a.state='ACTIVE'
       and a.effective_from <= p_business_date and (a.effective_to is null or p_business_date <= a.effective_to)
  ), authorized as (
    select c.* from candidate c
     where public.direct_entry_has_scope(p_app_user_id,'all')
        or exists (select 1 from public.direct_entry_scope_grants s
          where s.app_user_id=p_app_user_id and s.scope_kind='team' and s.team_id=c.team_id and s.is_current)
  ), materialized as (
    select a.*, p.period_key, p.period_start_date, p.period_end_date,
      public.work_report_due_at(p.period_end_date,a.due_day_offset,a.due_time_local,a.exclude_sundays) due_at
      from authorized a cross join lateral public.work_report_period(a.frequency,p_business_date) p
  ), inserted as (
    insert into public.work_report_obligations
      (template_id,template_version_id,assignment_id,assignee_app_user_id,snapshot_team_id,
       snapshot_team_code,snapshot_team_display_name,period_type,period_key,period_start_date,period_end_date,
       due_at,is_mandatory)
    select m.template_id,m.template_version_id,m.assignment_id,m.assignee_id,m.team_id,t.code,t.display_name,
      m.frequency,m.period_key,m.period_start_date,m.period_end_date,m.due_at,m.is_mandatory
      from materialized m left join public.teams t on t.team_id=m.team_id
     where exists (select 1 from public.direct_entry_app_users u where u.app_user_id=m.assignee_id and u.enabled)
    on conflict (template_id,assignee_app_user_id,period_key) do nothing
    returning 1
  ) select count(*)::int into v_inserted from inserted;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,outcome,metadata_json)
  values ('OBLIGATION_MATERIALIZE',p_app_user_id,'report_assign',
    case when public.direct_entry_has_scope(p_app_user_id,'all') then 'all' else 'team' end,'APPLIED',
    jsonb_build_object('business_date',p_business_date,'inserted_count',v_inserted));
  return jsonb_build_object('business_date',p_business_date,'inserted_count',v_inserted);
end;
$function$;

create or replace function public.work_report_change_obligation_status(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_expected_version integer,
  p_action text,
  p_reason text,
  p_reopened_until timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_scope text;
  v_reason_id uuid;
  v_status text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,'report_assign');
  if p_action not in ('EXEMPT','REOPEN') or length(btrim(coalesce(p_reason,''))) not between 1 and 4000 then
    raise exception 'WORK_REPORT_REASON_REQUIRED' using errcode='22023';
  end if;
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_scope := case when public.direct_entry_has_scope(p_app_user_id,'all') then 'all'
    else public.work_report_assert_scope(p_app_user_id,'report_assign',v_obligation.snapshot_team_id,false) end;
  if p_action='REOPEN' and (p_reopened_until is null or p_reopened_until <= now()) then
    raise exception 'WORK_REPORT_REOPEN_WINDOW_INVALID' using errcode='22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'expected_version',p_expected_version,'action',p_action,'reason',p_reason,'reopened_until',p_reopened_until));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_obligation_'||lower(p_action),p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id,btrim(p_reason));
  v_status := case when p_action='EXEMPT' then 'EXEMPTED' else 'ACTIVE' end;
  update public.work_report_obligations set obligation_status=v_status,
    reopened_until=case when p_action='REOPEN' then p_reopened_until else null end,
    status_changed_by_user_id=p_app_user_id,status_reason_id=v_reason_id,version=version+1,updated_at=now()
   where obligation_id=p_obligation_id;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,obligation_id,outcome,reason_id,metadata_json)
  values (p_action,p_app_user_id,'report_assign',v_scope,case when v_scope='team' then v_obligation.snapshot_team_id end,
    v_obligation.template_id,p_obligation_id,'APPLIED',v_reason_id,
    case when p_action='REOPEN' then jsonb_build_object('reopened_until',p_reopened_until) else '{}'::jsonb end);
  v_result := jsonb_build_object('obligation_id',p_obligation_id,'status',v_status,
    'reopened_until',case when p_action='REOPEN' then p_reopened_until end,'version',p_expected_version+1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_obligation_'||lower(p_action),p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_list_my_obligations(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  if p_status is not null and p_status not in ('ACTIVE','EXEMPTED','CANCELLED') then
    raise exception 'WORK_REPORT_STATUS_INVALID' using errcode='22023';
  end if;
  return jsonb_build_object('items',coalesce((
    select jsonb_agg(jsonb_build_object(
      'obligation_id',o.obligation_id,'template_id',o.template_id,'template_version_id',o.template_version_id,
      'template_code',t.template_code,'template_name',t.display_name,'period_type',o.period_type,
      'period_key',o.period_key,'period_start_date',o.period_start_date,'period_end_date',o.period_end_date,
      'due_at',o.due_at,'is_mandatory',o.is_mandatory,'obligation_status',o.obligation_status,
      'reopened_until',o.reopened_until,'version',o.version,'submission_id',s.submission_id,
      'submission_state',coalesce(s.state,'NOT_STARTED'),'submission_version',s.version,
      'schema_json',v.schema_json
    ) order by o.period_start_date desc,t.template_code)
      from public.work_report_obligations o
      join public.work_report_templates t on t.template_id=o.template_id
      join public.work_report_template_versions v on v.version_id=o.template_version_id
      left join public.work_report_submissions s on s.obligation_id=o.obligation_id
     where o.assignee_app_user_id=p_app_user_id and (p_status is null or o.obligation_status=p_status)
  ),'[]'::jsonb));
end;
$function$;

create or replace function public.work_report_get_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id then
    if not public.direct_entry_has_capability(p_app_user_id,'report_view') then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode='42501';
    end if;
    if not public.direct_entry_has_scope(p_app_user_id,'all') then
      perform public.work_report_assert_scope(p_app_user_id,'report_view',v_obligation.snapshot_team_id,false);
    end if;
  end if;
  select jsonb_build_object(
    'obligation',jsonb_build_object('obligation_id',o.obligation_id,'template_id',o.template_id,
      'period_key',o.period_key,'period_start_date',o.period_start_date,'period_end_date',o.period_end_date,
      'due_at',o.due_at,'obligation_status',o.obligation_status,'reopened_until',o.reopened_until,'version',o.version),
    'template',jsonb_build_object('template_code',t.template_code,'display_name',t.display_name,'schema_json',v.schema_json),
    'submission',case when s.submission_id is null then null else jsonb_build_object(
      'submission_id',s.submission_id,'state',s.state,'draft_payload_json',s.draft_payload_json,
      'first_submitted_at',s.first_submitted_at,'latest_submitted_at',s.latest_submitted_at,
      'is_late',s.is_late,'has_post_deadline_amendment',s.has_post_deadline_amendment,
      'current_revision_id',s.current_revision_id,'version',s.version) end,
    'revisions',coalesce((select jsonb_agg(jsonb_build_object('revision_id',r.revision_id,'revision_no',r.revision_no,
      'payload_json',r.payload_json,'created_at',r.created_at) order by r.revision_no desc)
      from public.work_report_submission_revisions r where r.submission_id=s.submission_id),'[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id=o.template_id
    join public.work_report_template_versions v on v.version_id=o.template_version_id
    left join public.work_report_submissions s on s.obligation_id=o.obligation_id
   where o.obligation_id=p_obligation_id;
  return v_result;
end;
$function$;

create or replace function public.work_report_save_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_payload_json jsonb,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_version public.work_report_template_versions%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id or v_obligation.obligation_status <> 'ACTIVE' then
    raise exception 'WORK_REPORT_SUBMISSION_DENIED' using errcode='42501';
  end if;
  if now() > v_obligation.due_at and coalesce(v_obligation.reopened_until < now(),true) then
    raise exception 'WORK_REPORT_DEADLINE_PASSED' using errcode='42501';
  end if;
  select * into v_version from public.work_report_template_versions where version_id=v_obligation.template_version_id;
  if not public.work_report_valid_submission_payload(v_version.schema_json,p_payload_json,
    v_obligation.period_start_date,v_obligation.period_end_date,false) then
    raise exception 'WORK_REPORT_PAYLOAD_INVALID' using errcode='22023';
  end if;
  select * into v_submission from public.work_report_submissions where obligation_id=p_obligation_id for update;
  if found and v_submission.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  if not found and p_expected_version is not null then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'payload_json',p_payload_json,'expected_version',p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_draft_save',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  if v_submission.submission_id is null then
    insert into public.work_report_submissions
      (obligation_id,template_id,template_version_id,assignee_app_user_id,draft_payload_json)
    values (p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,p_app_user_id,p_payload_json)
    returning * into v_submission;
  else
    update public.work_report_submissions set draft_payload_json=p_payload_json,version=version+1,updated_at=now()
     where submission_id=v_submission.submission_id returning * into v_submission;
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,scope_kind,scope_team_id,template_id,obligation_id,submission_id,outcome)
  values ('DRAFT_SAVE',p_app_user_id,'own',v_obligation.snapshot_team_id,v_obligation.template_id,
    p_obligation_id,v_submission.submission_id,'APPLIED');
  v_result := jsonb_build_object('submission_id',v_submission.submission_id,'state',v_submission.state,'version',v_submission.version);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_draft_save',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_submit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_payload_json jsonb,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_template_version public.work_report_template_versions%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_revision_id uuid;
  v_revision_no integer;
  v_state text;
  v_now timestamptz := statement_timestamp();
  v_metric jsonb;
  v_value jsonb;
  v_option text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id or v_obligation.obligation_status <> 'ACTIVE' then
    raise exception 'WORK_REPORT_SUBMISSION_DENIED' using errcode='42501';
  end if;
  if v_now > v_obligation.due_at and coalesce(v_obligation.reopened_until < v_now,true) then
    raise exception 'WORK_REPORT_DEADLINE_PASSED' using errcode='42501';
  end if;
  select * into v_template_version from public.work_report_template_versions where version_id=v_obligation.template_version_id;
  if not public.work_report_valid_submission_payload(v_template_version.schema_json,p_payload_json,
    v_obligation.period_start_date,v_obligation.period_end_date,true) then
    raise exception 'WORK_REPORT_PAYLOAD_INVALID' using errcode='22023';
  end if;
  select * into v_submission from public.work_report_submissions where obligation_id=p_obligation_id for update;
  if found and v_submission.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  if not found and p_expected_version is not null then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'payload_json',p_payload_json,'expected_version',p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_submit',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  if v_submission.submission_id is null then
    insert into public.work_report_submissions
      (obligation_id,template_id,template_version_id,assignee_app_user_id,submitted_by_user_id,
       submitted_team_id,draft_payload_json)
    values (p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,p_app_user_id,p_app_user_id,
      v_obligation.snapshot_team_id,p_payload_json)
    returning * into v_submission;
  end if;
  select coalesce(max(revision_no),0)+1 into v_revision_no
    from public.work_report_submission_revisions where submission_id=v_submission.submission_id;
  insert into public.work_report_submission_revisions
    (submission_id,obligation_id,template_version_id,revision_no,payload_json,payload_checksum,created_by_user_id)
  values (v_submission.submission_id,p_obligation_id,v_obligation.template_version_id,v_revision_no,p_payload_json,
    encode(sha256(convert_to(p_payload_json::text,'UTF8')),'hex'),p_app_user_id)
  returning revision_id into v_revision_id;
  v_state := case when v_template_version.requires_review then 'PENDING_REVIEW' else 'COMPLETED' end;
  update public.work_report_metric_values set is_current_revision=false,is_provisional=false,is_final=false,is_eligible=false
   where submission_id=v_submission.submission_id and is_current_revision;
  for v_metric in select value from jsonb_array_elements(v_template_version.metric_contract_json -> 'metrics') loop
    v_value := p_payload_json -> (v_metric ->> 'field_key');
    if v_value is null or jsonb_typeof(v_value)='null' then continue; end if;
    if v_metric ->> 'field_type' in ('integer','decimal') then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         numeric_value,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group',upper(v_metric->>'field_type'),v_metric->>'unit',(v_value#>>'{}')::numeric,
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='boolean' then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         boolean_value,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group','BOOLEAN',v_metric->>'unit',(v_value#>>'{}')::boolean,
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='single_select' then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         option_key,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group','SINGLE_SELECT',v_metric->>'unit',v_value#>>'{}',
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='multi_select' then
      for v_option in select value from jsonb_array_elements_text(v_value) loop
        insert into public.work_report_metric_values
          (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
           period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
           option_key,is_current_revision,is_provisional,is_final,is_eligible)
        values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
          p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
          v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
          v_metric->>'compatible_group','MULTI_SELECT',v_metric->>'unit',v_option,
          true,v_template_version.requires_review,not v_template_version.requires_review,true);
      end loop;
    end if;
  end loop;
  update public.work_report_submissions set current_revision_id=v_revision_id,state=v_state,draft_payload_json=p_payload_json,
    submitted_by_user_id=p_app_user_id,submitted_team_id=v_obligation.snapshot_team_id,
    first_submitted_at=coalesce(first_submitted_at,v_now),latest_submitted_at=v_now,
    is_late=case when first_submitted_at is null then v_now>v_obligation.due_at else is_late end,
    has_post_deadline_amendment=has_post_deadline_amendment or (first_submitted_at is not null and v_now>v_obligation.due_at),
    version=version+1,updated_at=now()
   where submission_id=v_submission.submission_id returning * into v_submission;
  insert into public.work_report_audit_events
    (action,actor_user_id,scope_kind,scope_team_id,template_id,obligation_id,submission_id,outcome,metadata_json)
  values (case when v_revision_no=1 then 'SUBMIT' else 'RESUBMIT' end,p_app_user_id,'own',v_obligation.snapshot_team_id,
    v_obligation.template_id,p_obligation_id,v_submission.submission_id,'APPLIED',
    jsonb_build_object('revision_id',v_revision_id,'revision_no',v_revision_no,
      'post_deadline_amendment',v_submission.has_post_deadline_amendment));
  v_result := jsonb_build_object('submission_id',v_submission.submission_id,'revision_id',v_revision_id,
    'revision_no',v_revision_no,'state',v_state,'version',v_submission.version);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_submit',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

-- Helpers and trigger functions are private. These RPCs are the complete F1
-- application allowlist; anon/authenticated/PUBLIC never execute them directly.
do $acl$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'work_report_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function.signature);
  end loop;
end;
$acl$;

grant execute on function public.work_report_list_templates(uuid,uuid) to service_role;
grant execute on function public.work_report_get_template(uuid,uuid,uuid) to service_role;
grant execute on function public.work_report_create_template(uuid,uuid,text,text,text,text,jsonb,jsonb,text) to service_role;
grant execute on function public.work_report_update_template_draft(uuid,uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb,text) to service_role;
grant execute on function public.work_report_clone_template_draft(uuid,uuid,uuid,integer,text) to service_role;
grant execute on function public.work_report_publish_template(uuid,uuid,uuid,uuid,integer,text) to service_role;
grant execute on function public.work_report_archive_template(uuid,uuid,uuid,integer,text) to service_role;
grant execute on function public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time,boolean,date,date,text) to service_role;
grant execute on function public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text) to service_role;
grant execute on function public.work_report_ensure_obligations_for_window(uuid,uuid,date) to service_role;
grant execute on function public.work_report_change_obligation_status(uuid,uuid,uuid,integer,text,text,timestamptz,text) to service_role;
grant execute on function public.work_report_list_my_obligations(uuid,uuid,text) to service_role;
grant execute on function public.work_report_get_submission(uuid,uuid,uuid) to service_role;
grant execute on function public.work_report_save_draft(uuid,uuid,uuid,jsonb,integer,text) to service_role;
grant execute on function public.work_report_submit(uuid,uuid,uuid,jsonb,integer,text) to service_role;

commit;
