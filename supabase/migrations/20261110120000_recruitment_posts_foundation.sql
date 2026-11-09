-- =============================================================================
-- Phase 2 — Recruitment Posts Foundation (`recruitment_project_briefs`,
--           `recruitment_project_brief_labor_types`, `recruitment_project_brief_revisions`)
--
-- Scope:
--   1. Create `public.recruitment_project_briefs` with full 4-section schema
--      (General, Candidate Requirements, Compensation & Benefits, Document Requirements),
--      strict column/cross-field CHECK constraints (Q3), and non-unique partial indexes
--      for `PUBLISHED` feed and filter lookups (multiple `PUBLISHED` posts per
--      `(project_id, industrial_park_id)` are allowed; each brief is independent by `brief_id`).
--   2. Create `public.recruitment_project_brief_labor_types` junction table (`>= 1`
--      labor type per brief) referencing `public.direct_entry_labor_types`.
--   3. Create append-only `public.recruitment_project_brief_revisions` with monotonic
--      `revision_seq bigint generated always as identity unique` and `brief_updated_at`
--      for deterministic as-of `S` feed snapshot pagination (including `labor_type_key`
--      and `updated_from` / `updated_to` filters).
--   4. Add `recruitment_post_revision_id` FK column to `public.direct_entry_audit_events`.
--   5. Install write guards, revision immutability trigger, and province-move guard
--      (`recruitment_post_guard_industrial_park_province_move`) on `public.industrial_parks`
--      blocking `province_id` changes (`PT409 INDUSTRIAL_PARK_HAS_PUBLISHED_POSTS`)
--      while an industrial park still has `PUBLISHED` recruitment posts (Must fix 1).
--   6. Define 10 internal `SECURITY DEFINER` helpers (`public.recruitment_post__internal_*`)
--      with `REVOKE ALL ... FROM public, anon, authenticated, service_role` (Must fix 2),
--      and 6 public RPCs (`public.recruitment_post_*`) granted only to `service_role`.
--   7. Align table/function ownership to `public.direct_entries` owner and run
--      fail-closed install-time `$self_check$`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Core tables & indexes.
-- -----------------------------------------------------------------------------
create table public.recruitment_project_briefs (
  brief_id uuid primary key default gen_random_uuid(),
  project_id text not null
    references public.direct_entry_projects(project_id) on update restrict on delete restrict,
  industrial_park_id uuid not null
    references public.industrial_parks(industrial_park_id) on delete restrict,
  status text not null
    constraint recruitment_project_briefs_status_chk
      check (status in ('PUBLISHED', 'WITHDRAWN')),
  version integer not null default 1
    constraint recruitment_project_briefs_version_chk
      check (version >= 1),
  published_at timestamptz not null,
  updated_at timestamptz not null,
  created_by_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  withdrawn_at timestamptz null,
  withdrawn_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,

  -- Section 1: General Information
  customer_name text not null,
  investment_origin text null,
  manufacturing_industry text null,
  job_description text not null,
  environment_types text[] not null default '{}'::text[],
  work_postures text[] not null default '{}'::text[],
  shift_pattern text not null
    constraint recruitment_project_briefs_shift_pattern_chk
      check (shift_pattern in ('DAY_ONLY', 'TWO_SHIFTS', 'THREE_SHIFTS', 'OTHER')),
  shift_details text null,
  manager_name text not null,
  manager_phone text not null,
  supply_schedule_text text null,
  expected_headcount integer null
    constraint recruitment_project_briefs_expected_headcount_chk
      check (expected_headcount is null or (expected_headcount >= 0 and expected_headcount <= 1000000)),

  -- Section 2: Candidate Requirements
  age_min smallint null
    constraint recruitment_project_briefs_age_min_chk
      check (age_min is null or (age_min >= 15 and age_min <= 70)),
  age_max smallint null
    constraint recruitment_project_briefs_age_max_chk
      check (age_max is null or (age_max >= 15 and age_max <= 70)),
  gender_requirement text not null
    constraint recruitment_project_briefs_gender_chk
      check (gender_requirement in ('FEMALE', 'MALE', 'ANY')),
  education_requirement text not null
    constraint recruitment_project_briefs_education_chk
      check (education_requirement in ('SECONDARY', 'HIGH_SCHOOL', 'NONE')),
  experience_required boolean not null,
  experience_details text null,
  accept_former_customer_workers boolean not null,
  entry_assessment_text text null,
  other_requirements_text text null,

  -- Section 3: Compensation & Benefits
  base_salary_vnd bigint null
    constraint recruitment_project_briefs_base_salary_vnd_chk
      check (base_salary_vnd is null or (base_salary_vnd >= 0 and base_salary_vnd <= 9007199254740991)),
  base_salary_conditions text null,
  attendance_bonus_vnd bigint null
    constraint recruitment_project_briefs_attendance_bonus_vnd_chk
      check (attendance_bonus_vnd is null or (attendance_bonus_vnd >= 0 and attendance_bonus_vnd <= 9007199254740991)),
  attendance_bonus_conditions text null,
  living_allowance_vnd bigint null
    constraint recruitment_project_briefs_living_allowance_vnd_chk
      check (living_allowance_vnd is null or (living_allowance_vnd >= 0 and living_allowance_vnd <= 9007199254740991)),
  living_allowance_conditions text null,
  seniority_allowance_vnd bigint null
    constraint recruitment_project_briefs_seniority_allowance_vnd_chk
      check (seniority_allowance_vnd is null or (seniority_allowance_vnd >= 0 and seniority_allowance_vnd <= 9007199254740991)),
  seniority_allowance_conditions text null,
  eyesight_allowance_vnd bigint null
    constraint recruitment_project_briefs_eyesight_allowance_vnd_chk
      check (eyesight_allowance_vnd is null or (eyesight_allowance_vnd >= 0 and eyesight_allowance_vnd <= 9007199254740991)),
  eyesight_allowance_conditions text null,
  other_allowance_text text null,
  average_income_min_vnd bigint null
    constraint recruitment_project_briefs_avg_income_min_vnd_chk
      check (average_income_min_vnd is null or (average_income_min_vnd >= 0 and average_income_min_vnd <= 9007199254740991)),
  average_income_max_vnd bigint null
    constraint recruitment_project_briefs_avg_income_max_vnd_chk
      check (average_income_max_vnd is null or (average_income_max_vnd >= 0 and average_income_max_vnd <= 9007199254740991)),
  salary_payment_schedule text null,
  salary_advance_available boolean not null,
  salary_advance_amount_vnd bigint null
    constraint recruitment_project_briefs_salary_advance_amount_vnd_chk
      check (salary_advance_amount_vnd is null or (salary_advance_amount_vnd >= 0 and salary_advance_amount_vnd <= 9007199254740991)),
  salary_advance_schedule text null,
  weekly_salary_available boolean not null,
  weekly_salary_payment_schedule text null,
  day_shift_8h_vnd bigint null
    constraint recruitment_project_briefs_day_shift_8h_vnd_chk
      check (day_shift_8h_vnd is null or (day_shift_8h_vnd >= 0 and day_shift_8h_vnd <= 9007199254740991)),
  day_shift_11h_vnd bigint null
    constraint recruitment_project_briefs_day_shift_11h_vnd_chk
      check (day_shift_11h_vnd is null or (day_shift_11h_vnd >= 0 and day_shift_11h_vnd <= 9007199254740991)),
  night_shift_8h_vnd bigint null
    constraint recruitment_project_briefs_night_shift_8h_vnd_chk
      check (night_shift_8h_vnd is null or (night_shift_8h_vnd >= 0 and night_shift_8h_vnd <= 9007199254740991)),
  night_shift_11h_vnd bigint null
    constraint recruitment_project_briefs_night_shift_11h_vnd_chk
      check (night_shift_11h_vnd is null or (night_shift_11h_vnd >= 0 and night_shift_11h_vnd <= 9007199254740991)),
  sunday_day_11h_vnd bigint null
    constraint recruitment_project_briefs_sunday_day_11h_vnd_chk
      check (sunday_day_11h_vnd is null or (sunday_day_11h_vnd >= 0 and sunday_day_11h_vnd <= 9007199254740991)),
  sunday_night_11h_vnd bigint null
    constraint recruitment_project_briefs_sunday_night_11h_vnd_chk
      check (sunday_night_11h_vnd is null or (sunday_night_11h_vnd >= 0 and sunday_night_11h_vnd <= 9007199254740991)),
  holiday_day_11h_vnd bigint null
    constraint recruitment_project_briefs_holiday_day_11h_vnd_chk
      check (holiday_day_11h_vnd is null or (holiday_day_11h_vnd >= 0 and holiday_day_11h_vnd <= 9007199254740991)),
  holiday_night_11h_vnd bigint null
    constraint recruitment_project_briefs_holiday_night_11h_vnd_chk
      check (holiday_night_11h_vnd is null or (holiday_night_11h_vnd >= 0 and holiday_night_11h_vnd <= 9007199254740991)),
  ppe_provided boolean not null,
  ppe_details text null,
  other_benefits text null,

  -- Section 4: Document Requirements
  require_original_cccd_and_copy boolean not null,
  require_certified_resume boolean not null,
  require_health_certificate_within_6_months boolean not null,
  require_photo_3x4 boolean not null,
  require_degree_or_certificate boolean not null,
  require_social_insurance_book boolean not null,
  require_other_documents boolean not null,
  other_documents_text text null,

  -- Lifecycle & cross-field constraints
  constraint recruitment_project_briefs_timestamps_chk check (
    published_at >= timestamptz '2000-01-01 00:00:00+00'
    and updated_at >= published_at
  ),
  constraint recruitment_project_briefs_lifecycle_chk check (
    (status = 'PUBLISHED' and withdrawn_at is null and withdrawn_by_app_user_id is null)
    or (status = 'WITHDRAWN' and withdrawn_at is not null and withdrawn_by_app_user_id is not null and withdrawn_at >= published_at)
  ),
  constraint recruitment_project_briefs_customer_name_chk check (
    customer_name = pg_catalog.btrim(customer_name)
    and pg_catalog.char_length(customer_name) between 1 and 256
    and customer_name !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  constraint recruitment_project_briefs_investment_origin_chk check (
    investment_origin is null or (
      investment_origin = pg_catalog.btrim(investment_origin)
      and pg_catalog.char_length(investment_origin) between 1 and 128
      and investment_origin !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  constraint recruitment_project_briefs_manufacturing_industry_chk check (
    manufacturing_industry is null or (
      manufacturing_industry = pg_catalog.btrim(manufacturing_industry)
      and pg_catalog.char_length(manufacturing_industry) between 1 and 256
      and manufacturing_industry !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  constraint recruitment_project_briefs_job_description_chk check (
    job_description = pg_catalog.btrim(job_description)
    and pg_catalog.char_length(job_description) between 1 and 4000
    and job_description !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  constraint recruitment_project_briefs_environment_types_chk check (
    pg_catalog.cardinality(environment_types) <= 3
    and environment_types <@ array['CLEAN_ROOM', 'NORMAL_ROOM', 'SEMI_CLEAN_ROOM']::text[]
  ),
  constraint recruitment_project_briefs_work_postures_chk check (
    pg_catalog.cardinality(work_postures) <= 2
    and work_postures <@ array['STANDING', 'SITTING']::text[]
  ),
  constraint recruitment_project_briefs_shift_details_chk check (
    (shift_details is null or (
      shift_details = pg_catalog.btrim(shift_details)
      and pg_catalog.char_length(shift_details) between 1 and 1000
      and shift_details !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (shift_pattern <> 'OTHER' or shift_details is not null)
  ),
  constraint recruitment_project_briefs_manager_name_chk check (
    manager_name = pg_catalog.btrim(manager_name)
    and pg_catalog.char_length(manager_name) between 1 and 256
    and manager_name !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  constraint recruitment_project_briefs_manager_phone_chk check (
    manager_phone = pg_catalog.btrim(manager_phone)
    and manager_phone ~ '^[0-9+(). -]{6,32}$'
    and pg_catalog.char_length(pg_catalog.regexp_replace(manager_phone, '[^0-9]', '', 'g')) >= 6
  ),
  constraint recruitment_project_briefs_supply_schedule_chk check (
    supply_schedule_text is null or (
      supply_schedule_text = pg_catalog.btrim(supply_schedule_text)
      and pg_catalog.char_length(supply_schedule_text) between 1 and 1000
      and supply_schedule_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  constraint recruitment_project_briefs_age_range_chk check (
    age_min is null or age_max is null or age_max >= age_min
  ),
  constraint recruitment_project_briefs_experience_chk check (
    (experience_required = true and experience_details is not null
      and experience_details = pg_catalog.btrim(experience_details)
      and pg_catalog.char_length(experience_details) between 1 and 1000
      and experience_details !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
    or (experience_required = false and experience_details is null)
  ),
  constraint recruitment_project_briefs_entry_assessment_chk check (
    entry_assessment_text is null or (
      entry_assessment_text = pg_catalog.btrim(entry_assessment_text)
      and pg_catalog.char_length(entry_assessment_text) between 1 and 1000
      and entry_assessment_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  constraint recruitment_project_briefs_other_requirements_chk check (
    other_requirements_text is null or (
      other_requirements_text = pg_catalog.btrim(other_requirements_text)
      and pg_catalog.char_length(other_requirements_text) between 1 and 2000
      and other_requirements_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  constraint recruitment_project_briefs_conditions_text_chk check (
    (base_salary_conditions is null or (
      base_salary_conditions = pg_catalog.btrim(base_salary_conditions)
      and pg_catalog.char_length(base_salary_conditions) between 1 and 1000
      and base_salary_conditions !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (attendance_bonus_conditions is null or (
      attendance_bonus_conditions = pg_catalog.btrim(attendance_bonus_conditions)
      and pg_catalog.char_length(attendance_bonus_conditions) between 1 and 1000
      and attendance_bonus_conditions !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (living_allowance_conditions is null or (
      living_allowance_conditions = pg_catalog.btrim(living_allowance_conditions)
      and pg_catalog.char_length(living_allowance_conditions) between 1 and 1000
      and living_allowance_conditions !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (seniority_allowance_conditions is null or (
      seniority_allowance_conditions = pg_catalog.btrim(seniority_allowance_conditions)
      and pg_catalog.char_length(seniority_allowance_conditions) between 1 and 1000
      and seniority_allowance_conditions !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (eyesight_allowance_conditions is null or (
      eyesight_allowance_conditions = pg_catalog.btrim(eyesight_allowance_conditions)
      and pg_catalog.char_length(eyesight_allowance_conditions) between 1 and 1000
      and eyesight_allowance_conditions !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (other_allowance_text is null or (
      other_allowance_text = pg_catalog.btrim(other_allowance_text)
      and pg_catalog.char_length(other_allowance_text) between 1 and 2000
      and other_allowance_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (ppe_details is null or (
      ppe_details = pg_catalog.btrim(ppe_details)
      and pg_catalog.char_length(ppe_details) between 1 and 1000
      and ppe_details !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (other_benefits is null or (
      other_benefits = pg_catalog.btrim(other_benefits)
      and pg_catalog.char_length(other_benefits) between 1 and 2000
      and other_benefits !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
  ),
  constraint recruitment_project_briefs_avg_income_range_chk check (
    average_income_min_vnd is null
    or average_income_max_vnd is null
    or average_income_max_vnd >= average_income_min_vnd
  ),
  constraint recruitment_project_briefs_schedules_chk check (
    (salary_payment_schedule is null or (
      salary_payment_schedule = pg_catalog.btrim(salary_payment_schedule)
      and pg_catalog.char_length(salary_payment_schedule) between 1 and 500
      and salary_payment_schedule !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (salary_advance_schedule is null or (
      salary_advance_schedule = pg_catalog.btrim(salary_advance_schedule)
      and pg_catalog.char_length(salary_advance_schedule) between 1 and 500
      and salary_advance_schedule !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
    and (weekly_salary_payment_schedule is null or (
      weekly_salary_payment_schedule = pg_catalog.btrim(weekly_salary_payment_schedule)
      and pg_catalog.char_length(weekly_salary_payment_schedule) between 1 and 500
      and weekly_salary_payment_schedule !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ))
  ),
  constraint recruitment_project_briefs_salary_advance_dep_chk check (
    salary_advance_available = true
    or (salary_advance_amount_vnd is null and salary_advance_schedule is null)
  ),
  constraint recruitment_project_briefs_weekly_salary_dep_chk check (
    weekly_salary_available = true
    or weekly_salary_payment_schedule is null
  ),
  constraint recruitment_project_briefs_other_documents_chk check (
    (require_other_documents = true and other_documents_text is not null
      and other_documents_text = pg_catalog.btrim(other_documents_text)
      and pg_catalog.char_length(other_documents_text) between 1 and 1000
      and other_documents_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
    or (require_other_documents = false and other_documents_text is null)
  )
);

create index recruitment_project_briefs_project_published_idx
  on public.recruitment_project_briefs (project_id, brief_id)
  where status = 'PUBLISHED';

create index recruitment_project_briefs_park_published_idx
  on public.recruitment_project_briefs (industrial_park_id, brief_id)
  where status = 'PUBLISHED';

create table public.recruitment_project_brief_labor_types (
  brief_id uuid not null
    references public.recruitment_project_briefs(brief_id) on delete restrict,
  labor_type_key text not null
    references public.direct_entry_labor_types(labor_type_key) on update restrict on delete restrict,
  primary key (brief_id, labor_type_key)
);

create index recruitment_project_brief_labor_types_key_brief_idx
  on public.recruitment_project_brief_labor_types (labor_type_key, brief_id);

create table public.recruitment_project_brief_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  revision_seq bigint generated always as identity unique,
  brief_id uuid not null
    references public.recruitment_project_briefs(brief_id) on delete restrict,
  version integer not null
    constraint recruitment_project_brief_revisions_version_chk
      check (version >= 1),
  action text not null
    constraint recruitment_project_brief_revisions_action_chk
      check (action in ('CREATE', 'UPDATE', 'WITHDRAW')),
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  before_snapshot jsonb null,
  after_snapshot jsonb not null,
  brief_updated_at timestamptz not null,
  idempotency_key text not null
    constraint recruitment_project_brief_revisions_idem_key_chk
      check (pg_catalog.char_length(idempotency_key) between 1 and 128),
  request_fingerprint text not null
    constraint recruitment_project_brief_revisions_fingerprint_chk
      check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (brief_id, version),
  constraint recruitment_project_brief_revisions_create_before_chk
    check ((action = 'CREATE') = (before_snapshot is null)),
  constraint recruitment_project_brief_revisions_create_version_chk
    check ((action = 'CREATE') = (version = 1))
);

create index recruitment_project_brief_revisions_brief_seq_idx
  on public.recruitment_project_brief_revisions (brief_id, revision_seq desc);

alter table public.direct_entry_audit_events
  add column recruitment_post_revision_id uuid
    references public.recruitment_project_brief_revisions(revision_id) on delete restrict;

create index direct_entry_audit_events_recruitment_post_revision_idx
  on public.direct_entry_audit_events (recruitment_post_revision_id)
  where recruitment_post_revision_id is not null;

-- -----------------------------------------------------------------------------
-- 2. RLS & fail-closed table privilege enforcement on Phase 2 tables.
-- -----------------------------------------------------------------------------
alter table public.recruitment_project_briefs enable row level security;
alter table public.recruitment_project_briefs force row level security;
alter table public.recruitment_project_brief_labor_types enable row level security;
alter table public.recruitment_project_brief_labor_types force row level security;
alter table public.recruitment_project_brief_revisions enable row level security;
alter table public.recruitment_project_brief_revisions force row level security;

revoke all on table public.recruitment_project_briefs
  from public, anon, authenticated, service_role;
revoke all on table public.recruitment_project_brief_labor_types
  from public, anon, authenticated, service_role;
revoke all on table public.recruitment_project_brief_revisions
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Internal helpers & write-guard triggers (10 functions).
-- -----------------------------------------------------------------------------

-- Helper 1: Canonical Full Admin / BOD check (delegates to Phase 1 narrowed guard).
create or replace function public.recruitment_post__internal_actor_is_full_admin_or_bod(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    public.recruitment_location_is_admin_or_bod(p_app_user_id),
    false
  )
$function$;

-- Helper 2: Canonical actor display name resolution (Q8: verified recruiter display_name
--           first, then non-UUID app_user display_name, fallback 'Chưa cập nhật tên').
create or replace function public.recruitment_post__internal_actor_label(
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_label text;
begin
  if p_app_user_id is null then
    return null;
  end if;

  select coalesce(
           case
             when linked.display_name is not null
                  and linked.display_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then linked.display_name
             else null
           end,
           case
             when nullif(pg_catalog.btrim(coalesce(u.display_name, '')), '') is not null
                  and pg_catalog.btrim(u.display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then pg_catalog.btrim(u.display_name)
             else null
           end,
           'Chưa cập nhật tên'
         )
    into v_label
    from public.direct_entry_app_users u
    left join lateral (
      select nullif(pg_catalog.btrim(coalesce(r.display_name, '')), '') as display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where u.app_user_id = p_app_user_id;

  return coalesce(v_label, 'Chưa cập nhật tên');
end;
$function$;

-- Helper 3: Canonical 32-hex filter fingerprint for snapshot_token & cursor binding.
create or replace function public.recruitment_post__internal_filter_hash(
  p_project_id text,
  p_province_id uuid,
  p_industrial_park_id uuid,
  p_labor_type_key text,
  p_updated_from date,
  p_updated_to date
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.substr(
    public.direct_entry_payload_hash(
      pg_catalog.jsonb_build_object(
        'project_id', p_project_id,
        'province_id', p_province_id,
        'industrial_park_id', p_industrial_park_id,
        'labor_type_key', p_labor_type_key,
        'updated_from', p_updated_from,
        'updated_to', p_updated_to
      )
    ),
    1,
    32
  )
$function$;

-- Helper 4: Idempotency begin wrapper enforcing strict (actor, action, key, hash)
--           isolation across all 3 recruitment post mutations (Q1, Q5).
create or replace function public.recruitment_post__internal_idempotency_begin(
  p_app_user_id uuid,
  p_action text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_prior jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('recruitment_post:idem:' || p_idempotency_key, 0)
  );

  if exists (
    select 1
      from public.direct_entry_rpc_idempotency i
     where i.idempotency_key = p_idempotency_key
       and i.action in (
         'recruitment_post_create',
         'recruitment_post_update',
         'recruitment_post_withdraw'
       )
       and (
         i.app_user_id <> p_app_user_id
         or i.action <> p_action
         or i.request_hash <> p_request_hash
       )
  ) then
    raise exception 'RECRUITMENT_POST_IDEMPOTENCY_CONFLICT'
      using errcode = 'PT409';
  end if;

  begin
    v_prior := public.direct_entry_idempotency_begin(
      p_app_user_id,
      p_action,
      p_idempotency_key,
      p_request_hash
    );
  exception
    when sqlstate '22023' then
      raise exception 'RECRUITMENT_POST_IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
  end;

  return v_prior;
end;
$function$;

-- Helper 5: Single-source-of-truth structural & business payload normalizer (Q3).
create or replace function public.recruitment_post__internal_normalize_payload(
  p_op text,
  p_payload jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_forbidden_keys constant text[] := array[
    'authsubject',
    'appuser',
    'appuserid',
    'actorid',
    'userid',
    'createdby',
    'createdbyuserid',
    'createdbyappuserid',
    'updatedbyappuserid',
    'withdrawnbyappuserid',
    'owner',
    'owneruserid',
    'actor',
    'role',
    'roles',
    'capability',
    'capabilities',
    'scope',
    'scopes',
    'scopekind',
    'team',
    'teamid',
    'provider',
    'providertype',
    'effectivescope',
    'effectivescopes',
    'selfrecruitersuggestion',
    'allowedworkertabs',
    'authoritysource',
    'departmentid',
    'departmentkey'
  ];
  v_expected_top_keys text[];
  v_expected_general_keys constant text[] := array[
    'customer_name',
    'investment_origin',
    'manufacturing_industry',
    'job_description',
    'environment_types',
    'work_postures',
    'shift_pattern',
    'shift_details',
    'manager_name',
    'manager_phone',
    'labor_type_keys',
    'supply_schedule_text',
    'expected_headcount'
  ];
  v_expected_candidate_keys constant text[] := array[
    'age_min',
    'age_max',
    'gender_requirement',
    'education_requirement',
    'experience_required',
    'experience_details',
    'accept_former_customer_workers',
    'entry_assessment_text',
    'other_requirements_text'
  ];
  v_expected_compensation_keys constant text[] := array[
    'base_salary_vnd',
    'base_salary_conditions',
    'attendance_bonus_vnd',
    'attendance_bonus_conditions',
    'living_allowance_vnd',
    'living_allowance_conditions',
    'seniority_allowance_vnd',
    'seniority_allowance_conditions',
    'eyesight_allowance_vnd',
    'eyesight_allowance_conditions',
    'other_allowance_text',
    'average_income_min_vnd',
    'average_income_max_vnd',
    'salary_payment_schedule',
    'salary_advance_available',
    'salary_advance_amount_vnd',
    'salary_advance_schedule',
    'weekly_salary_available',
    'weekly_salary_payment_schedule',
    'day_shift_8h_vnd',
    'day_shift_11h_vnd',
    'night_shift_8h_vnd',
    'night_shift_11h_vnd',
    'sunday_day_11h_vnd',
    'sunday_night_11h_vnd',
    'holiday_day_11h_vnd',
    'holiday_night_11h_vnd',
    'ppe_provided',
    'ppe_details',
    'other_benefits'
  ];
  v_expected_documents_keys constant text[] := array[
    'require_original_cccd_and_copy',
    'require_certified_resume',
    'require_health_certificate_within_6_months',
    'require_photo_3x4',
    'require_degree_or_certificate',
    'require_social_insurance_book',
    'require_other_documents',
    'other_documents_text'
  ];
  v_vnd_keys constant text[] := array[
    'base_salary_vnd',
    'attendance_bonus_vnd',
    'living_allowance_vnd',
    'seniority_allowance_vnd',
    'eyesight_allowance_vnd',
    'average_income_min_vnd',
    'average_income_max_vnd',
    'salary_advance_amount_vnd',
    'day_shift_8h_vnd',
    'day_shift_11h_vnd',
    'night_shift_8h_vnd',
    'night_shift_11h_vnd',
    'sunday_day_11h_vnd',
    'sunday_night_11h_vnd',
    'holiday_day_11h_vnd',
    'holiday_night_11h_vnd'
  ];
  v_doc_bool_keys constant text[] := array[
    'require_original_cccd_and_copy',
    'require_certified_resume',
    'require_health_certificate_within_6_months',
    'require_photo_3x4',
    'require_degree_or_certificate',
    'require_social_insurance_book',
    'require_other_documents'
  ];
  v_general jsonb;
  v_candidate jsonb;
  v_compensation jsonb;
  v_documents jsonb;
  v_key text;
  v_raw jsonb;
  v_str text;
  v_num numeric;

  v_project_id text := null;
  v_industrial_park_id uuid := null;

  -- Normalized general fields
  v_customer_name text;
  v_investment_origin text;
  v_manufacturing_industry text;
  v_job_description text;
  v_environment_types text[];
  v_work_postures text[];
  v_shift_pattern text;
  v_shift_details text;
  v_manager_name text;
  v_manager_phone text;
  v_labor_type_keys text[];
  v_supply_schedule_text text;
  v_expected_headcount integer;

  -- Normalized candidate fields
  v_age_min smallint;
  v_age_max smallint;
  v_gender_requirement text;
  v_education_requirement text;
  v_experience_required boolean;
  v_experience_details text;
  v_accept_former_customer_workers boolean;
  v_entry_assessment_text text;
  v_other_requirements_text text;

  -- Normalized compensation fields
  v_vnd_map jsonb := '{}'::jsonb;
  v_vnd_bigint bigint;
  v_base_salary_conditions text;
  v_attendance_bonus_conditions text;
  v_living_allowance_conditions text;
  v_seniority_allowance_conditions text;
  v_eyesight_allowance_conditions text;
  v_other_allowance_text text;
  v_salary_payment_schedule text;
  v_salary_advance_available boolean;
  v_salary_advance_schedule text;
  v_weekly_salary_available boolean;
  v_weekly_salary_payment_schedule text;
  v_ppe_provided boolean;
  v_ppe_details text;
  v_other_benefits text;

  -- Normalized documents fields
  v_other_documents_text text;
begin
  if p_op not in ('CREATE', 'UPDATE') then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  -- Check top-level and 1st-level nested keys for client authority fields first
  for v_key in
    select k from pg_catalog.jsonb_object_keys(p_payload) as k
    union all
    select k
      from pg_catalog.jsonb_each(p_payload) as top_kv(top_k, top_v),
           lateral (
             select k2 as k
               from pg_catalog.jsonb_object_keys(
                 case when pg_catalog.jsonb_typeof(top_v) = 'object' then top_v else '{}'::jsonb end
               ) as k2
           ) sub
  loop
    if pg_catalog.lower(pg_catalog.regexp_replace(v_key, '[-_]', '', 'g')) = any(v_forbidden_keys) then
      raise exception 'CLIENT_AUTHORITY_FIELD_FORBIDDEN' using errcode = '22023';
    end if;
  end loop;

  v_expected_top_keys := case
    when p_op = 'CREATE' then array[
      'project_id',
      'industrial_park_id',
      'general',
      'candidate',
      'compensation',
      'documents'
    ]
    else array[
      'general',
      'candidate',
      'compensation',
      'documents'
    ]
  end;

  if exists (
    select 1
      from (
        select k from pg_catalog.jsonb_object_keys(p_payload) as k
        full outer join unnest(v_expected_top_keys) as e(k) using (k)
       where k is null or not (p_payload ? k) or not (k = any(v_expected_top_keys))
      ) diff
  ) then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_op = 'CREATE' then
    if pg_catalog.jsonb_typeof(p_payload->'project_id') <> 'string'
       or pg_catalog.jsonb_typeof(p_payload->'industrial_park_id') <> 'string' then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
    v_project_id := pg_catalog.btrim(p_payload->>'project_id');
    if v_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
    v_str := pg_catalog.lower(pg_catalog.btrim(p_payload->>'industrial_park_id'));
    if v_str !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
    v_industrial_park_id := v_str::uuid;
  end if;

  v_general := p_payload->'general';
  v_candidate := p_payload->'candidate';
  v_compensation := p_payload->'compensation';
  v_documents := p_payload->'documents';

  if pg_catalog.jsonb_typeof(v_general) <> 'object'
     or pg_catalog.jsonb_typeof(v_candidate) <> 'object'
     or pg_catalog.jsonb_typeof(v_compensation) <> 'object'
     or pg_catalog.jsonb_typeof(v_documents) <> 'object' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  -- Exact-key checks on all 4 sections
  if (select count(*) from pg_catalog.jsonb_object_keys(v_general)) <> pg_catalog.cardinality(v_expected_general_keys)
     or exists (select 1 from unnest(v_expected_general_keys) as k where not (v_general ? k)) then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(v_candidate)) <> pg_catalog.cardinality(v_expected_candidate_keys)
     or exists (select 1 from unnest(v_expected_candidate_keys) as k where not (v_candidate ? k)) then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(v_compensation)) <> pg_catalog.cardinality(v_expected_compensation_keys)
     or exists (select 1 from unnest(v_expected_compensation_keys) as k where not (v_compensation ? k)) then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(v_documents)) <> pg_catalog.cardinality(v_expected_documents_keys)
     or exists (select 1 from unnest(v_expected_documents_keys) as k where not (v_documents ? k)) then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  -- Section 1: General
  if pg_catalog.jsonb_typeof(v_general->'customer_name') <> 'string'
     or pg_catalog.jsonb_typeof(v_general->'job_description') <> 'string'
     or pg_catalog.jsonb_typeof(v_general->'shift_pattern') <> 'string'
     or pg_catalog.jsonb_typeof(v_general->'manager_name') <> 'string'
     or pg_catalog.jsonb_typeof(v_general->'manager_phone') <> 'string'
     or pg_catalog.jsonb_typeof(v_general->'investment_origin') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_general->'manufacturing_industry') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_general->'shift_details') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_general->'supply_schedule_text') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_general->'environment_types') <> 'array'
     or pg_catalog.jsonb_typeof(v_general->'work_postures') <> 'array'
     or pg_catalog.jsonb_typeof(v_general->'labor_type_keys') <> 'array' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if exists (select 1 from pg_catalog.jsonb_array_elements(v_general->'environment_types') e where pg_catalog.jsonb_typeof(e) <> 'string')
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_general->'work_postures') e where pg_catalog.jsonb_typeof(e) <> 'string')
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_general->'labor_type_keys') e where pg_catalog.jsonb_typeof(e) <> 'string') then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  v_raw := v_general->'expected_headcount';
  if pg_catalog.jsonb_typeof(v_raw) = 'null' then
    v_expected_headcount := null;
  elsif pg_catalog.jsonb_typeof(v_raw) = 'number' and (v_raw::text) ~ '^-?[0-9]+$' then
    begin
      v_num := (v_raw::text)::numeric;
    exception when others then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end;
    if v_num < 0 or v_num > 1000000 then
      raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
    end if;
    v_expected_headcount := v_num::integer;
  else
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  v_customer_name := pg_catalog.btrim(v_general->>'customer_name');
  if pg_catalog.char_length(v_customer_name) not between 1 and 256
     or v_customer_name ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_investment_origin := nullif(pg_catalog.btrim(coalesce(v_general->>'investment_origin', '')), '');
  if (v_general->>'investment_origin') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_investment_origin is not null and pg_catalog.char_length(v_investment_origin) > 128) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_manufacturing_industry := nullif(pg_catalog.btrim(coalesce(v_general->>'manufacturing_industry', '')), '');
  if (v_general->>'manufacturing_industry') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_manufacturing_industry is not null and pg_catalog.char_length(v_manufacturing_industry) > 256) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_job_description := pg_catalog.btrim(v_general->>'job_description');
  if pg_catalog.char_length(v_job_description) not between 1 and 4000
     or v_job_description ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_general->'environment_types') > 3
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_general->'environment_types') e)
        <> (select count(distinct pg_catalog.btrim(e)) from pg_catalog.jsonb_array_elements_text(v_general->'environment_types') e)
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements_text(v_general->'environment_types') e
        where pg_catalog.btrim(e) not in ('CLEAN_ROOM', 'NORMAL_ROOM', 'SEMI_CLEAN_ROOM')
     ) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.btrim(e) order by pg_catalog.btrim(e) asc), '{}'::text[])
    into v_environment_types
    from pg_catalog.jsonb_array_elements_text(v_general->'environment_types') e;

  if pg_catalog.jsonb_array_length(v_general->'work_postures') > 2
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_general->'work_postures') e)
        <> (select count(distinct pg_catalog.btrim(e)) from pg_catalog.jsonb_array_elements_text(v_general->'work_postures') e)
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements_text(v_general->'work_postures') e
        where pg_catalog.btrim(e) not in ('STANDING', 'SITTING')
     ) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.btrim(e) order by pg_catalog.btrim(e) asc), '{}'::text[])
    into v_work_postures
    from pg_catalog.jsonb_array_elements_text(v_general->'work_postures') e;

  v_shift_pattern := pg_catalog.btrim(v_general->>'shift_pattern');
  if v_shift_pattern not in ('DAY_ONLY', 'TWO_SHIFTS', 'THREE_SHIFTS', 'OTHER') then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_shift_details := nullif(pg_catalog.btrim(coalesce(v_general->>'shift_details', '')), '');
  if (v_general->>'shift_details') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_shift_details is not null and pg_catalog.char_length(v_shift_details) > 1000)
     or (v_shift_pattern = 'OTHER' and v_shift_details is null) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_manager_name := pg_catalog.btrim(v_general->>'manager_name');
  if pg_catalog.char_length(v_manager_name) not between 1 and 256
     or v_manager_name ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_manager_phone := pg_catalog.btrim(v_general->>'manager_phone');
  if v_manager_phone ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or v_manager_phone !~ '^[0-9+(). -]{6,32}$'
     or pg_catalog.char_length(pg_catalog.regexp_replace(v_manager_phone, '[^0-9]', '', 'g')) < 6 then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_general->'labor_type_keys') not between 1 and 64
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_general->'labor_type_keys') e)
        <> (select count(distinct pg_catalog.btrim(e)) from pg_catalog.jsonb_array_elements_text(v_general->'labor_type_keys') e)
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements_text(v_general->'labor_type_keys') e
        where pg_catalog.btrim(e) !~ '^[A-Z][A-Z0-9_]{0,63}$'
     ) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  select pg_catalog.array_agg(pg_catalog.btrim(e) order by pg_catalog.btrim(e) asc)
    into v_labor_type_keys
    from pg_catalog.jsonb_array_elements_text(v_general->'labor_type_keys') e;

  v_supply_schedule_text := nullif(pg_catalog.btrim(coalesce(v_general->>'supply_schedule_text', '')), '');
  if (v_general->>'supply_schedule_text') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_supply_schedule_text is not null and pg_catalog.char_length(v_supply_schedule_text) > 1000) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  -- Section 2: Candidate
  if pg_catalog.jsonb_typeof(v_candidate->'gender_requirement') <> 'string'
     or pg_catalog.jsonb_typeof(v_candidate->'education_requirement') <> 'string'
     or pg_catalog.jsonb_typeof(v_candidate->'experience_required') <> 'boolean'
     or pg_catalog.jsonb_typeof(v_candidate->'accept_former_customer_workers') <> 'boolean'
     or pg_catalog.jsonb_typeof(v_candidate->'experience_details') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_candidate->'entry_assessment_text') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_candidate->'other_requirements_text') not in ('string', 'null') then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  v_raw := v_candidate->'age_min';
  if pg_catalog.jsonb_typeof(v_raw) = 'null' then
    v_age_min := null;
  elsif pg_catalog.jsonb_typeof(v_raw) = 'number' and (v_raw::text) ~ '^-?[0-9]+$' then
    v_num := (v_raw::text)::numeric;
    if v_num < 15 or v_num > 70 then
      raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
    end if;
    v_age_min := v_num::smallint;
  else
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  v_raw := v_candidate->'age_max';
  if pg_catalog.jsonb_typeof(v_raw) = 'null' then
    v_age_max := null;
  elsif pg_catalog.jsonb_typeof(v_raw) = 'number' and (v_raw::text) ~ '^-?[0-9]+$' then
    v_num := (v_raw::text)::numeric;
    if v_num < 15 or v_num > 70 then
      raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
    end if;
    v_age_max := v_num::smallint;
  else
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_age_min is not null and v_age_max is not null and v_age_max < v_age_min then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_gender_requirement := pg_catalog.btrim(v_candidate->>'gender_requirement');
  if v_gender_requirement not in ('FEMALE', 'MALE', 'ANY') then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_education_requirement := pg_catalog.btrim(v_candidate->>'education_requirement');
  if v_education_requirement not in ('SECONDARY', 'HIGH_SCHOOL', 'NONE') then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_experience_required := (v_candidate->'experience_required')::boolean;
  v_experience_details := nullif(pg_catalog.btrim(coalesce(v_candidate->>'experience_details', '')), '');
  if (v_candidate->>'experience_details') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_experience_details is not null and pg_catalog.char_length(v_experience_details) > 1000)
     or (v_experience_required = true and v_experience_details is null)
     or (v_experience_required = false and v_experience_details is not null) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_accept_former_customer_workers := (v_candidate->'accept_former_customer_workers')::boolean;

  v_entry_assessment_text := nullif(pg_catalog.btrim(coalesce(v_candidate->>'entry_assessment_text', '')), '');
  if (v_candidate->>'entry_assessment_text') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_entry_assessment_text is not null and pg_catalog.char_length(v_entry_assessment_text) > 1000) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_other_requirements_text := nullif(pg_catalog.btrim(coalesce(v_candidate->>'other_requirements_text', '')), '');
  if (v_candidate->>'other_requirements_text') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_other_requirements_text is not null and pg_catalog.char_length(v_other_requirements_text) > 2000) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  -- Section 3: Compensation & Benefits
  if pg_catalog.jsonb_typeof(v_compensation->'salary_advance_available') <> 'boolean'
     or pg_catalog.jsonb_typeof(v_compensation->'weekly_salary_available') <> 'boolean'
     or pg_catalog.jsonb_typeof(v_compensation->'ppe_provided') <> 'boolean'
     or pg_catalog.jsonb_typeof(v_compensation->'base_salary_conditions') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'attendance_bonus_conditions') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'living_allowance_conditions') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'seniority_allowance_conditions') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'eyesight_allowance_conditions') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'other_allowance_text') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'salary_payment_schedule') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'salary_advance_schedule') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'weekly_salary_payment_schedule') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'ppe_details') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(v_compensation->'other_benefits') not in ('string', 'null') then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  foreach v_key in array v_vnd_keys loop
    v_raw := v_compensation->v_key;
    if pg_catalog.jsonb_typeof(v_raw) = 'null' then
      v_vnd_map := v_vnd_map || pg_catalog.jsonb_build_object(v_key, null);
    elsif pg_catalog.jsonb_typeof(v_raw) = 'string' then
      v_str := pg_catalog.btrim(v_raw #>> '{}');
      if v_str !~ '^(0|[1-9][0-9]*)$' then
        raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
      end if;
      if pg_catalog.char_length(v_str) > 16 then
        raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
      end if;
      v_vnd_bigint := v_str::bigint;
      if v_vnd_bigint < 0 or v_vnd_bigint > 9007199254740991 then
        raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
      end if;
      v_vnd_map := v_vnd_map || pg_catalog.jsonb_build_object(v_key, v_vnd_bigint);
    else
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
  end loop;

  if (v_vnd_map->>'average_income_min_vnd') is not null
     and (v_vnd_map->>'average_income_max_vnd') is not null
     and (v_vnd_map->>'average_income_max_vnd')::bigint < (v_vnd_map->>'average_income_min_vnd')::bigint then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  v_base_salary_conditions := nullif(pg_catalog.btrim(coalesce(v_compensation->>'base_salary_conditions', '')), '');
  v_attendance_bonus_conditions := nullif(pg_catalog.btrim(coalesce(v_compensation->>'attendance_bonus_conditions', '')), '');
  v_living_allowance_conditions := nullif(pg_catalog.btrim(coalesce(v_compensation->>'living_allowance_conditions', '')), '');
  v_seniority_allowance_conditions := nullif(pg_catalog.btrim(coalesce(v_compensation->>'seniority_allowance_conditions', '')), '');
  v_eyesight_allowance_conditions := nullif(pg_catalog.btrim(coalesce(v_compensation->>'eyesight_allowance_conditions', '')), '');
  v_other_allowance_text := nullif(pg_catalog.btrim(coalesce(v_compensation->>'other_allowance_text', '')), '');
  v_salary_payment_schedule := nullif(pg_catalog.btrim(coalesce(v_compensation->>'salary_payment_schedule', '')), '');
  v_salary_advance_available := (v_compensation->'salary_advance_available')::boolean;
  v_salary_advance_schedule := nullif(pg_catalog.btrim(coalesce(v_compensation->>'salary_advance_schedule', '')), '');
  v_weekly_salary_available := (v_compensation->'weekly_salary_available')::boolean;
  v_weekly_salary_payment_schedule := nullif(pg_catalog.btrim(coalesce(v_compensation->>'weekly_salary_payment_schedule', '')), '');
  v_ppe_provided := (v_compensation->'ppe_provided')::boolean;
  v_ppe_details := nullif(pg_catalog.btrim(coalesce(v_compensation->>'ppe_details', '')), '');
  v_other_benefits := nullif(pg_catalog.btrim(coalesce(v_compensation->>'other_benefits', '')), '');

  if (v_compensation->>'base_salary_conditions') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_base_salary_conditions is not null and pg_catalog.char_length(v_base_salary_conditions) > 1000)
     or (v_compensation->>'attendance_bonus_conditions') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_attendance_bonus_conditions is not null and pg_catalog.char_length(v_attendance_bonus_conditions) > 1000)
     or (v_compensation->>'living_allowance_conditions') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_living_allowance_conditions is not null and pg_catalog.char_length(v_living_allowance_conditions) > 1000)
     or (v_compensation->>'seniority_allowance_conditions') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_seniority_allowance_conditions is not null and pg_catalog.char_length(v_seniority_allowance_conditions) > 1000)
     or (v_compensation->>'eyesight_allowance_conditions') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_eyesight_allowance_conditions is not null and pg_catalog.char_length(v_eyesight_allowance_conditions) > 1000)
     or (v_compensation->>'other_allowance_text') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_other_allowance_text is not null and pg_catalog.char_length(v_other_allowance_text) > 2000)
     or (v_compensation->>'salary_payment_schedule') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_salary_payment_schedule is not null and pg_catalog.char_length(v_salary_payment_schedule) > 500)
     or (v_compensation->>'salary_advance_schedule') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_salary_advance_schedule is not null and pg_catalog.char_length(v_salary_advance_schedule) > 500)
     or (v_compensation->>'weekly_salary_payment_schedule') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_weekly_salary_payment_schedule is not null and pg_catalog.char_length(v_weekly_salary_payment_schedule) > 500)
     or (v_compensation->>'ppe_details') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_ppe_details is not null and pg_catalog.char_length(v_ppe_details) > 1000)
     or (v_compensation->>'other_benefits') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_other_benefits is not null and pg_catalog.char_length(v_other_benefits) > 2000) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  if v_salary_advance_available = false
     and ((v_vnd_map->>'salary_advance_amount_vnd') is not null or v_salary_advance_schedule is not null) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  if v_weekly_salary_available = false and v_weekly_salary_payment_schedule is not null then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  -- Section 4: Documents
  foreach v_key in array v_doc_bool_keys loop
    if pg_catalog.jsonb_typeof(v_documents->v_key) <> 'boolean' then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
  end loop;

  if pg_catalog.jsonb_typeof(v_documents->'other_documents_text') not in ('string', 'null') then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  v_other_documents_text := nullif(pg_catalog.btrim(coalesce(v_documents->>'other_documents_text', '')), '');
  if (v_documents->>'other_documents_text') ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (v_other_documents_text is not null and pg_catalog.char_length(v_other_documents_text) > 1000)
     or ((v_documents->'require_other_documents')::boolean = true and v_other_documents_text is null)
     or ((v_documents->'require_other_documents')::boolean = false and v_other_documents_text is not null) then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'project_id', v_project_id,
    'industrial_park_id', v_industrial_park_id,
    'labor_type_keys', pg_catalog.to_jsonb(v_labor_type_keys),
    'general', pg_catalog.jsonb_build_object(
      'customer_name', v_customer_name,
      'investment_origin', v_investment_origin,
      'manufacturing_industry', v_manufacturing_industry,
      'job_description', v_job_description,
      'environment_types', pg_catalog.to_jsonb(v_environment_types),
      'work_postures', pg_catalog.to_jsonb(v_work_postures),
      'shift_pattern', v_shift_pattern,
      'shift_details', v_shift_details,
      'manager_name', v_manager_name,
      'manager_phone', v_manager_phone,
      'labor_type_keys', pg_catalog.to_jsonb(v_labor_type_keys),
      'supply_schedule_text', v_supply_schedule_text,
      'expected_headcount', v_expected_headcount
    ),
    'candidate', pg_catalog.jsonb_build_object(
      'age_min', v_age_min,
      'age_max', v_age_max,
      'gender_requirement', v_gender_requirement,
      'education_requirement', v_education_requirement,
      'experience_required', v_experience_required,
      'experience_details', v_experience_details,
      'accept_former_customer_workers', v_accept_former_customer_workers,
      'entry_assessment_text', v_entry_assessment_text,
      'other_requirements_text', v_other_requirements_text
    ),
    'compensation', pg_catalog.jsonb_build_object(
      'base_salary_vnd', v_vnd_map->'base_salary_vnd',
      'base_salary_conditions', v_base_salary_conditions,
      'attendance_bonus_vnd', v_vnd_map->'attendance_bonus_vnd',
      'attendance_bonus_conditions', v_attendance_bonus_conditions,
      'living_allowance_vnd', v_vnd_map->'living_allowance_vnd',
      'living_allowance_conditions', v_living_allowance_conditions,
      'seniority_allowance_vnd', v_vnd_map->'seniority_allowance_vnd',
      'seniority_allowance_conditions', v_seniority_allowance_conditions,
      'eyesight_allowance_vnd', v_vnd_map->'eyesight_allowance_vnd',
      'eyesight_allowance_conditions', v_eyesight_allowance_conditions,
      'other_allowance_text', v_other_allowance_text,
      'average_income_min_vnd', v_vnd_map->'average_income_min_vnd',
      'average_income_max_vnd', v_vnd_map->'average_income_max_vnd',
      'salary_payment_schedule', v_salary_payment_schedule,
      'salary_advance_available', v_salary_advance_available,
      'salary_advance_amount_vnd', v_vnd_map->'salary_advance_amount_vnd',
      'salary_advance_schedule', v_salary_advance_schedule,
      'weekly_salary_available', v_weekly_salary_available,
      'weekly_salary_payment_schedule', v_weekly_salary_payment_schedule,
      'day_shift_8h_vnd', v_vnd_map->'day_shift_8h_vnd',
      'day_shift_11h_vnd', v_vnd_map->'day_shift_11h_vnd',
      'night_shift_8h_vnd', v_vnd_map->'night_shift_8h_vnd',
      'night_shift_11h_vnd', v_vnd_map->'night_shift_11h_vnd',
      'sunday_day_11h_vnd', v_vnd_map->'sunday_day_11h_vnd',
      'sunday_night_11h_vnd', v_vnd_map->'sunday_night_11h_vnd',
      'holiday_day_11h_vnd', v_vnd_map->'holiday_day_11h_vnd',
      'holiday_night_11h_vnd', v_vnd_map->'holiday_night_11h_vnd',
      'ppe_provided', v_ppe_provided,
      'ppe_details', v_ppe_details,
      'other_benefits', v_other_benefits
    ),
    'documents', pg_catalog.jsonb_build_object(
      'require_original_cccd_and_copy', (v_documents->'require_original_cccd_and_copy')::boolean,
      'require_certified_resume', (v_documents->'require_certified_resume')::boolean,
      'require_health_certificate_within_6_months', (v_documents->'require_health_certificate_within_6_months')::boolean,
      'require_photo_3x4', (v_documents->'require_photo_3x4')::boolean,
      'require_degree_or_certificate', (v_documents->'require_degree_or_certificate')::boolean,
      'require_social_insurance_book', (v_documents->'require_social_insurance_book')::boolean,
      'require_other_documents', (v_documents->'require_other_documents')::boolean,
      'other_documents_text', v_other_documents_text
    )
  );
end;
$function$;

-- Helper 6: Revision snapshot builder (`after_snapshot` / `before_snapshot`)
--           with sorted `labor_type_keys` for as-of `S` feed membership evaluation.
create or replace function public.recruitment_post__internal_snapshot(
  p_brief public.recruitment_project_briefs,
  p_labor_type_keys text[]
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'brief_id', p_brief.brief_id,
    'project_id', p_brief.project_id,
    'industrial_park_id', p_brief.industrial_park_id,
    'status', p_brief.status,
    'version', p_brief.version,
    'published_at', pg_catalog.to_char(p_brief.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', pg_catalog.to_char(p_brief.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'created_by_app_user_id', p_brief.created_by_app_user_id,
    'updated_by_app_user_id', p_brief.updated_by_app_user_id,
    'withdrawn_at', case
      when p_brief.withdrawn_at is null then null
      else pg_catalog.to_char(p_brief.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    end,
    'withdrawn_by_app_user_id', p_brief.withdrawn_by_app_user_id,
    'labor_type_keys', coalesce(
      (select pg_catalog.jsonb_agg(k order by k asc) from unnest(p_labor_type_keys) as k),
      '[]'::jsonb
    ),
    'general', pg_catalog.jsonb_build_object(
      'customer_name', p_brief.customer_name,
      'investment_origin', p_brief.investment_origin,
      'manufacturing_industry', p_brief.manufacturing_industry,
      'job_description', p_brief.job_description,
      'environment_types', pg_catalog.to_jsonb(p_brief.environment_types),
      'work_postures', pg_catalog.to_jsonb(p_brief.work_postures),
      'shift_pattern', p_brief.shift_pattern,
      'shift_details', p_brief.shift_details,
      'manager_name', p_brief.manager_name,
      'manager_phone', p_brief.manager_phone,
      'supply_schedule_text', p_brief.supply_schedule_text,
      'expected_headcount', p_brief.expected_headcount
    ),
    'candidate', pg_catalog.jsonb_build_object(
      'age_min', p_brief.age_min,
      'age_max', p_brief.age_max,
      'gender_requirement', p_brief.gender_requirement,
      'education_requirement', p_brief.education_requirement,
      'experience_required', p_brief.experience_required,
      'experience_details', p_brief.experience_details,
      'accept_former_customer_workers', p_brief.accept_former_customer_workers,
      'entry_assessment_text', p_brief.entry_assessment_text,
      'other_requirements_text', p_brief.other_requirements_text
    ),
    'compensation', pg_catalog.jsonb_build_object(
      'base_salary_vnd', p_brief.base_salary_vnd::text,
      'base_salary_conditions', p_brief.base_salary_conditions,
      'attendance_bonus_vnd', p_brief.attendance_bonus_vnd::text,
      'attendance_bonus_conditions', p_brief.attendance_bonus_conditions,
      'living_allowance_vnd', p_brief.living_allowance_vnd::text,
      'living_allowance_conditions', p_brief.living_allowance_conditions,
      'seniority_allowance_vnd', p_brief.seniority_allowance_vnd::text,
      'seniority_allowance_conditions', p_brief.seniority_allowance_conditions,
      'eyesight_allowance_vnd', p_brief.eyesight_allowance_vnd::text,
      'eyesight_allowance_conditions', p_brief.eyesight_allowance_conditions,
      'other_allowance_text', p_brief.other_allowance_text,
      'average_income_min_vnd', p_brief.average_income_min_vnd::text,
      'average_income_max_vnd', p_brief.average_income_max_vnd::text,
      'salary_payment_schedule', p_brief.salary_payment_schedule,
      'salary_advance_available', p_brief.salary_advance_available,
      'salary_advance_amount_vnd', p_brief.salary_advance_amount_vnd::text,
      'salary_advance_schedule', p_brief.salary_advance_schedule,
      'weekly_salary_available', p_brief.weekly_salary_available,
      'weekly_salary_payment_schedule', p_brief.weekly_salary_payment_schedule,
      'day_shift_8h_vnd', p_brief.day_shift_8h_vnd::text,
      'day_shift_11h_vnd', p_brief.day_shift_11h_vnd::text,
      'night_shift_8h_vnd', p_brief.night_shift_8h_vnd::text,
      'night_shift_11h_vnd', p_brief.night_shift_11h_vnd::text,
      'sunday_day_11h_vnd', p_brief.sunday_day_11h_vnd::text,
      'sunday_night_11h_vnd', p_brief.sunday_night_11h_vnd::text,
      'holiday_day_11h_vnd', p_brief.holiday_day_11h_vnd::text,
      'holiday_night_11h_vnd', p_brief.holiday_night_11h_vnd::text,
      'ppe_provided', p_brief.ppe_provided,
      'ppe_details', p_brief.ppe_details,
      'other_benefits', p_brief.other_benefits
    ),
    'documents', pg_catalog.jsonb_build_object(
      'require_original_cccd_and_copy', p_brief.require_original_cccd_and_copy,
      'require_certified_resume', p_brief.require_certified_resume,
      'require_health_certificate_within_6_months', p_brief.require_health_certificate_within_6_months,
      'require_photo_3x4', p_brief.require_photo_3x4,
      'require_degree_or_certificate', p_brief.require_degree_or_certificate,
      'require_social_insurance_book', p_brief.require_social_insurance_book,
      'require_other_documents', p_brief.require_other_documents,
      'other_documents_text', p_brief.other_documents_text
    )
  )
$function$;

-- Helper 7: Client-safe ITEM projection (`recruitment_post__internal_projection`)
--           with exact keys, VND strings, and zero sensitive/internal fields (§4.8).
create or replace function public.recruitment_post__internal_projection(
  p_brief public.recruitment_project_briefs,
  p_actor_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_project_name text;
  v_park record;
  v_labor_types jsonb;
  v_can_mutate boolean;
begin
  select p.display_name
    into v_project_name
    from public.direct_entry_projects p
   where p.project_id = p_brief.project_id;

  select ip.industrial_park_id,
         ip.industrial_park_code,
         ip.display_name as park_display_name,
         (ip.active and prov.active) as park_active,
         prov.province_id,
         prov.province_code,
         prov.display_name as province_display_name
    into v_park
    from public.industrial_parks ip
    join public.administrative_provinces prov
      on prov.province_id = ip.province_id
   where ip.industrial_park_id = p_brief.industrial_park_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'labor_type_key', lt.labor_type_key,
               'display_name', lt.display_name
             )
             order by lt.sort_order asc, lt.labor_type_key asc
           ),
           '[]'::jsonb
         )
    into v_labor_types
    from public.recruitment_project_brief_labor_types blt
    join public.direct_entry_labor_types lt
      on lt.labor_type_key = blt.labor_type_key
   where blt.brief_id = p_brief.brief_id;

  v_can_mutate := (
    p_brief.status = 'PUBLISHED'
    and p_actor_app_user_id is not null
    and (
      p_brief.created_by_app_user_id = p_actor_app_user_id
      or public.recruitment_post__internal_actor_is_full_admin_or_bod(p_actor_app_user_id)
    )
  );

  return pg_catalog.jsonb_build_object(
    'brief_id', p_brief.brief_id,
    'version', p_brief.version,
    'status', p_brief.status,
    'project', pg_catalog.jsonb_build_object(
      'project_id', p_brief.project_id,
      'display_name', coalesce(v_project_name, p_brief.project_id)
    ),
    'industrial_park', pg_catalog.jsonb_build_object(
      'industrial_park_id', v_park.industrial_park_id,
      'industrial_park_code', v_park.industrial_park_code,
      'display_name', v_park.park_display_name,
      'active', v_park.park_active
    ),
    'province', pg_catalog.jsonb_build_object(
      'province_id', v_park.province_id,
      'province_code', v_park.province_code,
      'display_name', v_park.province_display_name
    ),
    'published_at', pg_catalog.to_char(p_brief.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', pg_catalog.to_char(p_brief.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'withdrawn_at', case
      when p_brief.withdrawn_at is null then null
      else pg_catalog.to_char(p_brief.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    end,
    'created_by_display_name', public.recruitment_post__internal_actor_label(p_brief.created_by_app_user_id),
    'updated_by_display_name', public.recruitment_post__internal_actor_label(p_brief.updated_by_app_user_id),
    'withdrawn_by_display_name', case
      when p_brief.withdrawn_by_app_user_id is null then null
      else public.recruitment_post__internal_actor_label(p_brief.withdrawn_by_app_user_id)
    end,
    'general', pg_catalog.jsonb_build_object(
      'customer_name', p_brief.customer_name,
      'investment_origin', p_brief.investment_origin,
      'manufacturing_industry', p_brief.manufacturing_industry,
      'job_description', p_brief.job_description,
      'environment_types', pg_catalog.to_jsonb(p_brief.environment_types),
      'work_postures', pg_catalog.to_jsonb(p_brief.work_postures),
      'shift_pattern', p_brief.shift_pattern,
      'shift_details', p_brief.shift_details,
      'manager_name', p_brief.manager_name,
      'manager_phone', p_brief.manager_phone,
      'labor_types', v_labor_types,
      'supply_schedule_text', p_brief.supply_schedule_text,
      'expected_headcount', p_brief.expected_headcount
    ),
    'candidate', pg_catalog.jsonb_build_object(
      'age_min', p_brief.age_min,
      'age_max', p_brief.age_max,
      'gender_requirement', p_brief.gender_requirement,
      'education_requirement', p_brief.education_requirement,
      'experience_required', p_brief.experience_required,
      'experience_details', p_brief.experience_details,
      'accept_former_customer_workers', p_brief.accept_former_customer_workers,
      'entry_assessment_text', p_brief.entry_assessment_text,
      'other_requirements_text', p_brief.other_requirements_text
    ),
    'compensation', pg_catalog.jsonb_build_object(
      'base_salary_vnd', p_brief.base_salary_vnd::text,
      'base_salary_conditions', p_brief.base_salary_conditions,
      'attendance_bonus_vnd', p_brief.attendance_bonus_vnd::text,
      'attendance_bonus_conditions', p_brief.attendance_bonus_conditions,
      'living_allowance_vnd', p_brief.living_allowance_vnd::text,
      'living_allowance_conditions', p_brief.living_allowance_conditions,
      'seniority_allowance_vnd', p_brief.seniority_allowance_vnd::text,
      'seniority_allowance_conditions', p_brief.seniority_allowance_conditions,
      'eyesight_allowance_vnd', p_brief.eyesight_allowance_vnd::text,
      'eyesight_allowance_conditions', p_brief.eyesight_allowance_conditions,
      'other_allowance_text', p_brief.other_allowance_text,
      'average_income_min_vnd', p_brief.average_income_min_vnd::text,
      'average_income_max_vnd', p_brief.average_income_max_vnd::text,
      'salary_payment_schedule', p_brief.salary_payment_schedule,
      'salary_advance_available', p_brief.salary_advance_available,
      'salary_advance_amount_vnd', p_brief.salary_advance_amount_vnd::text,
      'salary_advance_schedule', p_brief.salary_advance_schedule,
      'weekly_salary_available', p_brief.weekly_salary_available,
      'weekly_salary_payment_schedule', p_brief.weekly_salary_payment_schedule,
      'day_shift_8h_vnd', p_brief.day_shift_8h_vnd::text,
      'day_shift_11h_vnd', p_brief.day_shift_11h_vnd::text,
      'night_shift_8h_vnd', p_brief.night_shift_8h_vnd::text,
      'night_shift_11h_vnd', p_brief.night_shift_11h_vnd::text,
      'sunday_day_11h_vnd', p_brief.sunday_day_11h_vnd::text,
      'sunday_night_11h_vnd', p_brief.sunday_night_11h_vnd::text,
      'holiday_day_11h_vnd', p_brief.holiday_day_11h_vnd::text,
      'holiday_night_11h_vnd', p_brief.holiday_night_11h_vnd::text,
      'ppe_provided', p_brief.ppe_provided,
      'ppe_details', p_brief.ppe_details,
      'other_benefits', p_brief.other_benefits
    ),
    'documents', pg_catalog.jsonb_build_object(
      'require_original_cccd_and_copy', p_brief.require_original_cccd_and_copy,
      'require_certified_resume', p_brief.require_certified_resume,
      'require_health_certificate_within_6_months', p_brief.require_health_certificate_within_6_months,
      'require_photo_3x4', p_brief.require_photo_3x4,
      'require_degree_or_certificate', p_brief.require_degree_or_certificate,
      'require_social_insurance_book', p_brief.require_social_insurance_book,
      'require_other_documents', p_brief.require_other_documents,
      'other_documents_text', p_brief.other_documents_text
    ),
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_edit', v_can_mutate,
      'can_withdraw', v_can_mutate
    )
  );
end;
$function$;

-- Helper 8: Write guard trigger function for `recruitment_project_briefs`.
create or replace function public.recruitment_post__internal_briefs_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'recruitment_project_briefs cannot be deleted'
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.current_setting('recruitment_post.write_marker', true), '') <> 'on' then
    raise exception 'direct write to recruitment_project_briefs is forbidden'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'WITHDRAWN' then
      raise exception 'withdrawn recruitment post is immutable'
        using errcode = '55000';
    end if;
    if new.brief_id is distinct from old.brief_id
       or new.project_id is distinct from old.project_id
       or new.industrial_park_id is distinct from old.industrial_park_id
       or new.created_by_app_user_id is distinct from old.created_by_app_user_id
       or new.published_at is distinct from old.published_at then
      raise exception 'recruitment post identity and creation metadata are immutable'
        using errcode = '55000';
    end if;
    if new.version <> old.version + 1 or new.updated_at < old.updated_at then
      raise exception 'recruitment post version must increment by 1 with monotonic updated_at'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$function$;

create trigger recruitment_project_briefs_write_guard
  before insert or update or delete on public.recruitment_project_briefs
  for each row execute function public.recruitment_post__internal_briefs_write_guard();

-- Helper 9: Write guard trigger function for `recruitment_project_brief_labor_types`.
create or replace function public.recruitment_post__internal_brief_labor_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_brief_id uuid;
  v_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'recruitment_project_brief_labor_types cannot be updated in place'
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.current_setting('recruitment_post.write_marker', true), '') <> 'on' then
    raise exception 'direct write to recruitment_project_brief_labor_types is forbidden'
      using errcode = '55000';
  end if;

  v_brief_id := coalesce(new.brief_id, old.brief_id);
  select b.status
    into v_status
    from public.recruitment_project_briefs b
   where b.brief_id = v_brief_id;

  if v_status is distinct from 'PUBLISHED' then
    raise exception 'labor types can only be modified while recruitment post is PUBLISHED'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create trigger recruitment_project_brief_labor_types_write_guard
  before insert or update or delete on public.recruitment_project_brief_labor_types
  for each row execute function public.recruitment_post__internal_brief_labor_write_guard();

create trigger recruitment_project_brief_revisions_immutable
  before update or delete on public.recruitment_project_brief_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

-- Helper 10: Guard blocking `industrial_parks.province_id` moves while the park
--            still has `PUBLISHED` recruitment posts (Must fix 1).
create or replace function public.recruitment_post__internal_guard_park_province_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.province_id is distinct from old.province_id then
    if exists (
      select 1
        from public.recruitment_project_briefs b
       where b.industrial_park_id = old.industrial_park_id
         and b.status = 'PUBLISHED'
    ) then
      raise exception 'INDUSTRIAL_PARK_HAS_PUBLISHED_POSTS'
        using errcode = 'PT409';
    end if;
  end if;
  return new;
end;
$function$;

create trigger recruitment_post_guard_industrial_park_province_move
  before update of province_id on public.industrial_parks
  for each row execute function public.recruitment_post__internal_guard_park_province_change();

-- -----------------------------------------------------------------------------
-- 4. Public RPCs (`service_role` only — 6 functions).
-- -----------------------------------------------------------------------------

-- RPC 1: `recruitment_post_get_context` (Must fix 3, Should fix 5, Q6)
create or replace function public.recruitment_post_get_context(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_managed_projects jsonb;
  v_filter_projects jsonb;
  v_provinces jsonb;
  v_industrial_parks jsonb;
  v_labor_types jsonb;
  v_has_active_park boolean;
  v_has_active_labor_type boolean;
  v_can_create boolean;
begin
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'project_id', p.project_id,
               'display_name', p.display_name
             )
             order by p.display_name asc, p.project_id asc
           ),
           '[]'::jsonb
         )
    into v_managed_projects
    from public.direct_entry_projects p
   where p.active = true
     and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p.project_id);

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'project_id', p.project_id,
               'display_name', p.display_name
             )
             order by p.display_name asc, p.project_id asc
           ),
           '[]'::jsonb
         )
    into v_filter_projects
    from public.direct_entry_projects p
   where p.active = true
      or exists (
        select 1
          from public.recruitment_project_briefs b
         where b.project_id = p.project_id
           and b.status = 'PUBLISHED'
      );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'province_id', prov.province_id,
               'province_code', prov.province_code,
               'display_name', prov.display_name,
               'active', prov.active
             )
             order by prov.display_name asc, prov.province_code asc
           ),
           '[]'::jsonb
         )
    into v_provinces
    from public.administrative_provinces prov
   where prov.active = true
      or exists (
        select 1
          from public.industrial_parks ip
          join public.recruitment_project_briefs b
            on b.industrial_park_id = ip.industrial_park_id
         where ip.province_id = prov.province_id
           and b.status = 'PUBLISHED'
      );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'industrial_park_id', ip.industrial_park_id,
               'industrial_park_code', ip.industrial_park_code,
               'province_id', ip.province_id,
               'display_name', ip.display_name,
               'active', (ip.active and prov.active)
             )
             order by ip.display_name asc, ip.industrial_park_code asc
           ),
           '[]'::jsonb
         )
    into v_industrial_parks
    from public.industrial_parks ip
    join public.administrative_provinces prov
      on prov.province_id = ip.province_id
   where (ip.active = true and prov.active = true)
      or exists (
        select 1
          from public.recruitment_project_briefs b
         where b.industrial_park_id = ip.industrial_park_id
           and b.status = 'PUBLISHED'
      );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'labor_type_key', lt.labor_type_key,
               'display_name', lt.display_name,
               'active', lt.active
             )
             order by lt.sort_order asc, lt.labor_type_key asc
           ),
           '[]'::jsonb
         )
    into v_labor_types
    from public.direct_entry_labor_types lt
   where lt.active = true
      or exists (
        select 1
          from public.recruitment_project_brief_labor_types blt
          join public.recruitment_project_briefs b
            on b.brief_id = blt.brief_id
         where blt.labor_type_key = lt.labor_type_key
           and b.status = 'PUBLISHED'
      );

  select exists (
           select 1
             from public.industrial_parks ip
             join public.administrative_provinces prov
               on prov.province_id = ip.province_id
            where ip.active = true
              and prov.active = true
         )
    into v_has_active_park;

  select exists (
           select 1
             from public.direct_entry_labor_types lt
            where lt.active = true
         )
    into v_has_active_labor_type;

  v_can_create := (
    pg_catalog.jsonb_array_length(v_managed_projects) > 0
    and v_has_active_park
    and v_has_active_labor_type
  );

  return pg_catalog.jsonb_build_object(
    'can_create', v_can_create,
    'managed_projects', v_managed_projects,
    'filter_projects', v_filter_projects,
    'provinces', v_provinces,
    'industrial_parks', v_industrial_parks,
    'labor_types', v_labor_types
  );
end;
$function$;

-- RPC 2: `recruitment_post_list` (as-of `S` snapshot pagination, 18-digit cap, filter binding)
create or replace function public.recruitment_post_list(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_province_id uuid default null,
  p_industrial_park_id uuid default null,
  p_labor_type_key text default null,
  p_updated_from date default null,
  p_updated_to date default null,
  p_cursor text default null,
  p_snapshot_token text default null,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer := coalesce(p_page_size, 10);
  v_project_id text := nullif(pg_catalog.btrim(coalesce(p_project_id, '')), '');
  v_labor_type_key text := nullif(pg_catalog.btrim(coalesce(p_labor_type_key, '')), '');
  v_cursor_raw text := nullif(pg_catalog.btrim(coalesce(p_cursor, '')), '');
  v_token_raw text := nullif(pg_catalog.btrim(coalesce(p_snapshot_token, '')), '');
  v_filter_hash text;
  v_current_max_seq bigint;
  v_snapshot_seq bigint;
  v_token_parts text[];
  v_cursor_parts text[];
  v_cursor_seq bigint;
  v_cursor_micros bigint;
  v_cursor_days integer;
  v_cursor_rem_usec bigint;
  v_cursor_ts timestamptz := null;
  v_cursor_brief_id uuid := null;
  v_rows jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor text := null;
  v_last_micros bigint;
  v_last_brief_id uuid;
  v_rec record;
  v_count integer := 0;
begin
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if v_page_size < 1 or v_page_size > 10 then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_project_id is not null and v_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_labor_type_key is not null and v_labor_type_key !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_updated_from is not null and p_updated_to is not null and p_updated_from > p_updated_to then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_province_id is not null and p_industrial_park_id is not null then
    if exists (
      select 1
        from public.industrial_parks ip
       where ip.industrial_park_id = p_industrial_park_id
         and ip.province_id <> p_province_id
    ) then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
  end if;

  v_filter_hash := public.recruitment_post__internal_filter_hash(
    v_project_id,
    p_province_id,
    p_industrial_park_id,
    v_labor_type_key,
    p_updated_from,
    p_updated_to
  );

  select coalesce(max(r.revision_seq), 0)
    into v_current_max_seq
    from public.recruitment_project_brief_revisions r;

  if v_cursor_raw is not null and v_token_raw is null then
    raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  if v_token_raw is not null then
    v_token_parts := pg_catalog.regexp_match(
      v_token_raw,
      '^S1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})$'
    );
    if v_token_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_snapshot_seq := v_token_parts[1]::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_snapshot_seq > v_current_max_seq or v_token_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  else
    v_snapshot_seq := v_current_max_seq;
  end if;

  if v_cursor_raw is not null then
    v_cursor_parts := pg_catalog.regexp_match(
      v_cursor_raw,
      '^C1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    );
    if v_cursor_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_seq := v_cursor_parts[1]::bigint;
      v_cursor_micros := v_cursor_parts[3]::bigint;
      v_cursor_brief_id := v_cursor_parts[4]::uuid;
      v_cursor_days := (v_cursor_micros / 86400000000)::integer;
      v_cursor_rem_usec := v_cursor_micros % 86400000000;
      v_cursor_ts := timestamptz 'epoch'
        + pg_catalog.make_interval(days => v_cursor_days)
        + (v_cursor_rem_usec * interval '1 microsecond');
    exception
      when numeric_value_out_of_range or datetime_field_overflow then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_cursor_seq <> v_snapshot_seq or v_cursor_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  end if;

  for v_rec in
    select b.brief_id,
           asof.key_updated_at,
           public.recruitment_post__internal_projection(b, p_app_user_id) as item_json
      from public.recruitment_project_briefs b
      join public.industrial_parks ip
        on ip.industrial_park_id = b.industrial_park_id
      cross join lateral (
        select r.revision_seq,
               r.brief_updated_at as key_updated_at,
               r.after_snapshot
          from public.recruitment_project_brief_revisions r
         where r.brief_id = b.brief_id
           and r.revision_seq <= v_snapshot_seq
         order by r.revision_seq desc
         limit 1
      ) asof
     where b.status = 'PUBLISHED'
       and (v_project_id is null or b.project_id = v_project_id)
       and (p_industrial_park_id is null or b.industrial_park_id = p_industrial_park_id)
       and (p_province_id is null or ip.province_id = p_province_id)
       and (
         v_labor_type_key is null
         or pg_catalog.jsonb_exists(asof.after_snapshot->'labor_type_keys', v_labor_type_key)
       )
       and (
         p_updated_from is null
         or asof.key_updated_at >= (p_updated_from::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
       and (
         p_updated_to is null
         or asof.key_updated_at < ((p_updated_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
       and (
         v_cursor_raw is null
         or (asof.key_updated_at, b.brief_id) < (v_cursor_ts, v_cursor_brief_id)
       )
     order by asof.key_updated_at desc, b.brief_id desc
     limit v_page_size + 1
  loop
    v_count := v_count + 1;
    if v_count <= v_page_size then
      v_rows := v_rows || pg_catalog.jsonb_build_array(v_rec.item_json);
      v_last_micros := (extract(epoch from v_rec.key_updated_at) * 1000000)::bigint;
      v_last_brief_id := v_rec.brief_id;
    else
      v_has_more := true;
    end if;
  end loop;

  if v_has_more then
    v_next_cursor := 'C1.'
      || v_snapshot_seq::text
      || '.'
      || v_filter_hash
      || '.'
      || v_last_micros::text
      || '.'
      || v_last_brief_id::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_rows,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'snapshot_token', 'S1.' || v_snapshot_seq::text || '.' || v_filter_hash
  );
end;
$function$;

-- RPC 3: `recruitment_post_get`
create or replace function public.recruitment_post_get(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_brief_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_brief public.recruitment_project_briefs%rowtype;
begin
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if p_brief_id is null then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  select b.*
    into v_brief
    from public.recruitment_project_briefs b
   where b.brief_id = p_brief_id;

  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_brief.status = 'WITHDRAWN'
     and v_brief.created_by_app_user_id <> p_app_user_id
     and not public.recruitment_post__internal_actor_is_full_admin_or_bod(p_app_user_id) then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'post', public.recruitment_post__internal_projection(v_brief, p_app_user_id)
  );
end;
$function$;

-- RPC 4: `recruitment_post_create` (7-step mutation ordering per §6.1)
create or replace function public.recruitment_post_create(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_idem_key text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_idempotency_key, '')));
  v_norm jsonb;
  v_project_id text;
  v_industrial_park_id uuid;
  v_labor_type_keys text[];
  v_fingerprint text;
  v_prior jsonb;
  v_project public.direct_entry_projects%rowtype;
  v_park public.industrial_parks%rowtype;
  v_province public.administrative_provinces%rowtype;
  v_lt_count integer;
  v_lt_inactive_count integer;
  v_now timestamptz;
  v_brief public.recruitment_project_briefs%rowtype;
  v_after_snapshot jsonb;
  v_revision_id uuid;
  v_result jsonb;
begin
  -- Step 1: Structural validation & resolve actor
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if v_idem_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'RECRUITMENT_POST_IDEMPOTENCY_INVALID' using errcode = '22023';
  end if;

  v_norm := public.recruitment_post__internal_normalize_payload('CREATE', p_payload);
  v_project_id := v_norm->>'project_id';
  v_industrial_park_id := (v_norm->>'industrial_park_id')::uuid;
  select pg_catalog.array_agg(e order by e asc)
    into v_labor_type_keys
    from pg_catalog.jsonb_array_elements_text(v_norm->'labor_type_keys') e;

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'op', 'recruitment_post_create',
      'payload', v_norm
    )
  );

  -- Step 2: Claim / Replay Idempotency
  v_prior := public.recruitment_post__internal_idempotency_begin(
    p_app_user_id,
    'recruitment_post_create',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- Step 3: Business authority check (PM of project_id only; Full Admin/BOD not PM is denied)
  if not exists (
    select 1
      from public.direct_entry_projects p
     where p.project_id = v_project_id
  ) then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_project_id) then
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Step 4: Global advisory write lock (serializes revision_seq & prevents deadlock)
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('recruitment_post:write', 0)
  );

  -- Step 5: Lock & read business rows in fixed global order:
  --         (5a) direct_entry_projects -> (5b) industrial_parks -> (5c) administrative_provinces -> (5d) direct_entry_labor_types
  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = v_project_id
     for share;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Re-verify PM assignment under project lock to close TOCTOU with concurrent unassign PM
  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_project_id) then
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  select ip.*
    into v_park
    from public.industrial_parks ip
   where ip.industrial_park_id = v_industrial_park_id
     for share;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  select prov.*
    into v_province
    from public.administrative_provinces prov
   where prov.province_id = v_park.province_id
     for share;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform 1
    from public.direct_entry_labor_types lt
   where lt.labor_type_key = any(v_labor_type_keys)
   order by lt.labor_type_key asc
     for share;

  select count(*)::integer,
         count(*) filter (where not lt.active)::integer
    into v_lt_count, v_lt_inactive_count
    from public.direct_entry_labor_types lt
   where lt.labor_type_key = any(v_labor_type_keys);

  -- Step 6: Validate catalog state (multiple PUBLISHED briefs per project-park are allowed)
  if v_lt_count <> pg_catalog.cardinality(v_labor_type_keys) then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not v_project.active or not v_park.active or not v_province.active or v_lt_inactive_count > 0 then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  -- Step 7: Persist brief, labor_types, revision, audit, and finish idempotency
  perform pg_catalog.set_config('recruitment_post.write_marker', 'on', true);
  v_now := pg_catalog.clock_timestamp();

  insert into public.recruitment_project_briefs (
    project_id,
    industrial_park_id,
    status,
    version,
    published_at,
    updated_at,
    created_by_app_user_id,
    updated_by_app_user_id,
    customer_name,
    investment_origin,
    manufacturing_industry,
    job_description,
    environment_types,
    work_postures,
    shift_pattern,
    shift_details,
    manager_name,
    manager_phone,
    supply_schedule_text,
    expected_headcount,
    age_min,
    age_max,
    gender_requirement,
    education_requirement,
    experience_required,
    experience_details,
    accept_former_customer_workers,
    entry_assessment_text,
    other_requirements_text,
    base_salary_vnd,
    base_salary_conditions,
    attendance_bonus_vnd,
    attendance_bonus_conditions,
    living_allowance_vnd,
    living_allowance_conditions,
    seniority_allowance_vnd,
    seniority_allowance_conditions,
    eyesight_allowance_vnd,
    eyesight_allowance_conditions,
    other_allowance_text,
    average_income_min_vnd,
    average_income_max_vnd,
    salary_payment_schedule,
    salary_advance_available,
    salary_advance_amount_vnd,
    salary_advance_schedule,
    weekly_salary_available,
    weekly_salary_payment_schedule,
    day_shift_8h_vnd,
    day_shift_11h_vnd,
    night_shift_8h_vnd,
    night_shift_11h_vnd,
    sunday_day_11h_vnd,
    sunday_night_11h_vnd,
    holiday_day_11h_vnd,
    holiday_night_11h_vnd,
    ppe_provided,
    ppe_details,
    other_benefits,
    require_original_cccd_and_copy,
    require_certified_resume,
    require_health_certificate_within_6_months,
    require_photo_3x4,
    require_degree_or_certificate,
    require_social_insurance_book,
    require_other_documents,
    other_documents_text
  )
  values (
    v_project_id,
    v_industrial_park_id,
    'PUBLISHED',
    1,
    v_now,
    v_now,
    p_app_user_id,
    p_app_user_id,
    v_norm->'general'->>'customer_name',
    v_norm->'general'->>'investment_origin',
    v_norm->'general'->>'manufacturing_industry',
    v_norm->'general'->>'job_description',
    array(select pg_catalog.jsonb_array_elements_text(v_norm->'general'->'environment_types')),
    array(select pg_catalog.jsonb_array_elements_text(v_norm->'general'->'work_postures')),
    v_norm->'general'->>'shift_pattern',
    v_norm->'general'->>'shift_details',
    v_norm->'general'->>'manager_name',
    v_norm->'general'->>'manager_phone',
    v_norm->'general'->>'supply_schedule_text',
    (v_norm->'general'->>'expected_headcount')::integer,
    (v_norm->'candidate'->>'age_min')::smallint,
    (v_norm->'candidate'->>'age_max')::smallint,
    v_norm->'candidate'->>'gender_requirement',
    v_norm->'candidate'->>'education_requirement',
    (v_norm->'candidate'->'experience_required')::boolean,
    v_norm->'candidate'->>'experience_details',
    (v_norm->'candidate'->'accept_former_customer_workers')::boolean,
    v_norm->'candidate'->>'entry_assessment_text',
    v_norm->'candidate'->>'other_requirements_text',
    (v_norm->'compensation'->>'base_salary_vnd')::bigint,
    v_norm->'compensation'->>'base_salary_conditions',
    (v_norm->'compensation'->>'attendance_bonus_vnd')::bigint,
    v_norm->'compensation'->>'attendance_bonus_conditions',
    (v_norm->'compensation'->>'living_allowance_vnd')::bigint,
    v_norm->'compensation'->>'living_allowance_conditions',
    (v_norm->'compensation'->>'seniority_allowance_vnd')::bigint,
    v_norm->'compensation'->>'seniority_allowance_conditions',
    (v_norm->'compensation'->>'eyesight_allowance_vnd')::bigint,
    v_norm->'compensation'->>'eyesight_allowance_conditions',
    v_norm->'compensation'->>'other_allowance_text',
    (v_norm->'compensation'->>'average_income_min_vnd')::bigint,
    (v_norm->'compensation'->>'average_income_max_vnd')::bigint,
    v_norm->'compensation'->>'salary_payment_schedule',
    (v_norm->'compensation'->'salary_advance_available')::boolean,
    (v_norm->'compensation'->>'salary_advance_amount_vnd')::bigint,
    v_norm->'compensation'->>'salary_advance_schedule',
    (v_norm->'compensation'->'weekly_salary_available')::boolean,
    v_norm->'compensation'->>'weekly_salary_payment_schedule',
    (v_norm->'compensation'->>'day_shift_8h_vnd')::bigint,
    (v_norm->'compensation'->>'day_shift_11h_vnd')::bigint,
    (v_norm->'compensation'->>'night_shift_8h_vnd')::bigint,
    (v_norm->'compensation'->>'night_shift_11h_vnd')::bigint,
    (v_norm->'compensation'->>'sunday_day_11h_vnd')::bigint,
    (v_norm->'compensation'->>'sunday_night_11h_vnd')::bigint,
    (v_norm->'compensation'->>'holiday_day_11h_vnd')::bigint,
    (v_norm->'compensation'->>'holiday_night_11h_vnd')::bigint,
    (v_norm->'compensation'->'ppe_provided')::boolean,
    v_norm->'compensation'->>'ppe_details',
    v_norm->'compensation'->>'other_benefits',
    (v_norm->'documents'->'require_original_cccd_and_copy')::boolean,
    (v_norm->'documents'->'require_certified_resume')::boolean,
    (v_norm->'documents'->'require_health_certificate_within_6_months')::boolean,
    (v_norm->'documents'->'require_photo_3x4')::boolean,
    (v_norm->'documents'->'require_degree_or_certificate')::boolean,
    (v_norm->'documents'->'require_social_insurance_book')::boolean,
    (v_norm->'documents'->'require_other_documents')::boolean,
    v_norm->'documents'->>'other_documents_text'
  )
  returning * into v_brief;

  insert into public.recruitment_project_brief_labor_types (brief_id, labor_type_key)
  select v_brief.brief_id, k
    from unnest(v_labor_type_keys) as k;

  v_after_snapshot := public.recruitment_post__internal_snapshot(v_brief, v_labor_type_keys);

  insert into public.recruitment_project_brief_revisions (
    brief_id,
    version,
    action,
    actor_app_user_id,
    before_snapshot,
    after_snapshot,
    brief_updated_at,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_brief.brief_id,
    1,
    'CREATE',
    p_app_user_id,
    null,
    v_after_snapshot,
    v_brief.updated_at,
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
    changed_fields,
    reason_id,
    recruitment_post_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'recruitment_post_create',
    'recruitment_post_pm',
    v_brief.brief_id::text,
    'own',
    'APPLIED',
    array['create']::text[],
    null,
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'post', public.recruitment_post__internal_projection(v_brief, p_app_user_id),
    'changed', true
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'recruitment_post_create',
    v_idem_key,
    v_result
  );

  return v_result || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;


-- RPC 5: `recruitment_post_update` (7-step mutation ordering per §6.1)
create or replace function public.recruitment_post_update(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_brief_id uuid,
  p_expected_version integer,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_idem_key text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_idempotency_key, '')));
  v_norm jsonb;
  v_labor_type_keys text[];
  v_old_labor_type_keys text[];
  v_fingerprint text;
  v_prior jsonb;
  v_brief public.recruitment_project_briefs%rowtype;
  v_candidate_brief public.recruitment_project_briefs%rowtype;
  v_lt_count integer;
  v_lt_disallowed_inactive_count integer;
  v_before_snapshot jsonb;
  v_candidate_snapshot jsonb;
  v_after_snapshot jsonb;
  v_old_flat jsonb;
  v_new_flat jsonb;
  v_changed_fields text[];
  v_now timestamptz;
  v_revision_id uuid;
  v_is_creator boolean;
  v_result jsonb;
begin
  -- Step 1: Structural validation & resolve actor
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if p_brief_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_idem_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'RECRUITMENT_POST_IDEMPOTENCY_INVALID' using errcode = '22023';
  end if;

  v_norm := public.recruitment_post__internal_normalize_payload('UPDATE', p_payload);
  select pg_catalog.array_agg(e order by e asc)
    into v_labor_type_keys
    from pg_catalog.jsonb_array_elements_text(v_norm->'labor_type_keys') e;

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'op', 'recruitment_post_update',
      'brief_id', p_brief_id,
      'expected_version', p_expected_version,
      'payload', v_norm
    )
  );

  -- Step 2: Claim / Replay Idempotency
  v_prior := public.recruitment_post__internal_idempotency_begin(
    p_app_user_id,
    'recruitment_post_update',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- Step 3: Business authority check before global advisory write lock
  select b.*
    into v_brief
    from public.recruitment_project_briefs b
   where b.brief_id = p_brief_id;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_brief.created_by_app_user_id <> p_app_user_id
     and not public.recruitment_post__internal_actor_is_full_admin_or_bod(p_app_user_id) then
    if v_brief.status = 'WITHDRAWN' then
      raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Step 4: Global advisory write lock
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('recruitment_post:write', 0)
  );

  -- Step 5: Lock & read business rows in fixed global order:
  --         (5d) direct_entry_labor_types -> (5e) recruitment_project_briefs
  perform 1
    from public.direct_entry_labor_types lt
   where lt.labor_type_key = any(v_labor_type_keys)
   order by lt.labor_type_key asc
     for share;

  select b.*
    into v_brief
    from public.recruitment_project_briefs b
   where b.brief_id = p_brief_id
     for update;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_is_creator := (v_brief.created_by_app_user_id = p_app_user_id);
  if not v_is_creator
     and not public.recruitment_post__internal_actor_is_full_admin_or_bod(p_app_user_id) then
    if v_brief.status = 'WITHDRAWN' then
      raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Step 6: Validate OCC expected_version, status, and labor_type catalog rules
  if v_brief.version <> p_expected_version then
    raise exception 'RECRUITMENT_POST_STALE' using errcode = 'PT409';
  end if;

  if v_brief.status = 'WITHDRAWN' then
    raise exception 'RECRUITMENT_POST_ALREADY_WITHDRAWN' using errcode = 'PT409';
  end if;

  select coalesce(pg_catalog.array_agg(blt.labor_type_key order by blt.labor_type_key asc), '{}'::text[])
    into v_old_labor_type_keys
    from public.recruitment_project_brief_labor_types blt
   where blt.brief_id = v_brief.brief_id;

  select count(*)::integer,
         count(*) filter (
           where not lt.active
             and not (lt.labor_type_key = any(v_old_labor_type_keys))
         )::integer
    into v_lt_count, v_lt_disallowed_inactive_count
    from public.direct_entry_labor_types lt
   where lt.labor_type_key = any(v_labor_type_keys);

  if v_lt_count <> pg_catalog.cardinality(v_labor_type_keys) then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_lt_disallowed_inactive_count > 0 then
    raise exception 'RECRUITMENT_POST_CONTENT_INVALID' using errcode = '22023';
  end if;

  -- Step 7: Diff against current snapshot; handle no-op vs applied mutation
  v_before_snapshot := public.recruitment_post__internal_snapshot(v_brief, v_old_labor_type_keys);

  v_candidate_brief := v_brief;
  v_candidate_brief.customer_name := v_norm->'general'->>'customer_name';
  v_candidate_brief.investment_origin := v_norm->'general'->>'investment_origin';
  v_candidate_brief.manufacturing_industry := v_norm->'general'->>'manufacturing_industry';
  v_candidate_brief.job_description := v_norm->'general'->>'job_description';
  v_candidate_brief.environment_types := array(select pg_catalog.jsonb_array_elements_text(v_norm->'general'->'environment_types'));
  v_candidate_brief.work_postures := array(select pg_catalog.jsonb_array_elements_text(v_norm->'general'->'work_postures'));
  v_candidate_brief.shift_pattern := v_norm->'general'->>'shift_pattern';
  v_candidate_brief.shift_details := v_norm->'general'->>'shift_details';
  v_candidate_brief.manager_name := v_norm->'general'->>'manager_name';
  v_candidate_brief.manager_phone := v_norm->'general'->>'manager_phone';
  v_candidate_brief.supply_schedule_text := v_norm->'general'->>'supply_schedule_text';
  v_candidate_brief.expected_headcount := (v_norm->'general'->>'expected_headcount')::integer;
  v_candidate_brief.age_min := (v_norm->'candidate'->>'age_min')::smallint;
  v_candidate_brief.age_max := (v_norm->'candidate'->>'age_max')::smallint;
  v_candidate_brief.gender_requirement := v_norm->'candidate'->>'gender_requirement';
  v_candidate_brief.education_requirement := v_norm->'candidate'->>'education_requirement';
  v_candidate_brief.experience_required := (v_norm->'candidate'->'experience_required')::boolean;
  v_candidate_brief.experience_details := v_norm->'candidate'->>'experience_details';
  v_candidate_brief.accept_former_customer_workers := (v_norm->'candidate'->'accept_former_customer_workers')::boolean;
  v_candidate_brief.entry_assessment_text := v_norm->'candidate'->>'entry_assessment_text';
  v_candidate_brief.other_requirements_text := v_norm->'candidate'->>'other_requirements_text';
  v_candidate_brief.base_salary_vnd := (v_norm->'compensation'->>'base_salary_vnd')::bigint;
  v_candidate_brief.base_salary_conditions := v_norm->'compensation'->>'base_salary_conditions';
  v_candidate_brief.attendance_bonus_vnd := (v_norm->'compensation'->>'attendance_bonus_vnd')::bigint;
  v_candidate_brief.attendance_bonus_conditions := v_norm->'compensation'->>'attendance_bonus_conditions';
  v_candidate_brief.living_allowance_vnd := (v_norm->'compensation'->>'living_allowance_vnd')::bigint;
  v_candidate_brief.living_allowance_conditions := v_norm->'compensation'->>'living_allowance_conditions';
  v_candidate_brief.seniority_allowance_vnd := (v_norm->'compensation'->>'seniority_allowance_vnd')::bigint;
  v_candidate_brief.seniority_allowance_conditions := v_norm->'compensation'->>'seniority_allowance_conditions';
  v_candidate_brief.eyesight_allowance_vnd := (v_norm->'compensation'->>'eyesight_allowance_vnd')::bigint;
  v_candidate_brief.eyesight_allowance_conditions := v_norm->'compensation'->>'eyesight_allowance_conditions';
  v_candidate_brief.other_allowance_text := v_norm->'compensation'->>'other_allowance_text';
  v_candidate_brief.average_income_min_vnd := (v_norm->'compensation'->>'average_income_min_vnd')::bigint;
  v_candidate_brief.average_income_max_vnd := (v_norm->'compensation'->>'average_income_max_vnd')::bigint;
  v_candidate_brief.salary_payment_schedule := v_norm->'compensation'->>'salary_payment_schedule';
  v_candidate_brief.salary_advance_available := (v_norm->'compensation'->'salary_advance_available')::boolean;
  v_candidate_brief.salary_advance_amount_vnd := (v_norm->'compensation'->>'salary_advance_amount_vnd')::bigint;
  v_candidate_brief.salary_advance_schedule := v_norm->'compensation'->>'salary_advance_schedule';
  v_candidate_brief.weekly_salary_available := (v_norm->'compensation'->'weekly_salary_available')::boolean;
  v_candidate_brief.weekly_salary_payment_schedule := v_norm->'compensation'->>'weekly_salary_payment_schedule';
  v_candidate_brief.day_shift_8h_vnd := (v_norm->'compensation'->>'day_shift_8h_vnd')::bigint;
  v_candidate_brief.day_shift_11h_vnd := (v_norm->'compensation'->>'day_shift_11h_vnd')::bigint;
  v_candidate_brief.night_shift_8h_vnd := (v_norm->'compensation'->>'night_shift_8h_vnd')::bigint;
  v_candidate_brief.night_shift_11h_vnd := (v_norm->'compensation'->>'night_shift_11h_vnd')::bigint;
  v_candidate_brief.sunday_day_11h_vnd := (v_norm->'compensation'->>'sunday_day_11h_vnd')::bigint;
  v_candidate_brief.sunday_night_11h_vnd := (v_norm->'compensation'->>'sunday_night_11h_vnd')::bigint;
  v_candidate_brief.holiday_day_11h_vnd := (v_norm->'compensation'->>'holiday_day_11h_vnd')::bigint;
  v_candidate_brief.holiday_night_11h_vnd := (v_norm->'compensation'->>'holiday_night_11h_vnd')::bigint;
  v_candidate_brief.ppe_provided := (v_norm->'compensation'->'ppe_provided')::boolean;
  v_candidate_brief.ppe_details := v_norm->'compensation'->>'ppe_details';
  v_candidate_brief.other_benefits := v_norm->'compensation'->>'other_benefits';
  v_candidate_brief.require_original_cccd_and_copy := (v_norm->'documents'->'require_original_cccd_and_copy')::boolean;
  v_candidate_brief.require_certified_resume := (v_norm->'documents'->'require_certified_resume')::boolean;
  v_candidate_brief.require_health_certificate_within_6_months := (v_norm->'documents'->'require_health_certificate_within_6_months')::boolean;
  v_candidate_brief.require_photo_3x4 := (v_norm->'documents'->'require_photo_3x4')::boolean;
  v_candidate_brief.require_degree_or_certificate := (v_norm->'documents'->'require_degree_or_certificate')::boolean;
  v_candidate_brief.require_social_insurance_book := (v_norm->'documents'->'require_social_insurance_book')::boolean;
  v_candidate_brief.require_other_documents := (v_norm->'documents'->'require_other_documents')::boolean;
  v_candidate_brief.other_documents_text := v_norm->'documents'->>'other_documents_text';

  v_candidate_snapshot := public.recruitment_post__internal_snapshot(v_candidate_brief, v_labor_type_keys);

  v_old_flat := (v_before_snapshot->'general')
    || (v_before_snapshot->'candidate')
    || (v_before_snapshot->'compensation')
    || (v_before_snapshot->'documents')
    || pg_catalog.jsonb_build_object('labor_type_keys', v_before_snapshot->'labor_type_keys');

  v_new_flat := (v_candidate_snapshot->'general')
    || (v_candidate_snapshot->'candidate')
    || (v_candidate_snapshot->'compensation')
    || (v_candidate_snapshot->'documents')
    || pg_catalog.jsonb_build_object('labor_type_keys', v_candidate_snapshot->'labor_type_keys');

  select coalesce(pg_catalog.array_agg(n.k order by n.k asc), '{}'::text[])
    into v_changed_fields
    from pg_catalog.jsonb_each(v_new_flat) as n(k, v)
    join pg_catalog.jsonb_each(v_old_flat) as o(k, v)
      on o.k = n.k
   where n.v is distinct from o.v;

  if pg_catalog.cardinality(v_changed_fields) = 0 then
    v_result := pg_catalog.jsonb_build_object(
      'post', public.recruitment_post__internal_projection(v_brief, p_app_user_id),
      'changed', false
    );

    perform public.direct_entry_idempotency_finish(
      p_app_user_id,
      'recruitment_post_update',
      v_idem_key,
      v_result
    );

    return v_result || pg_catalog.jsonb_build_object('replayed', false);
  end if;

  perform pg_catalog.set_config('recruitment_post.write_marker', 'on', true);
  v_now := greatest(pg_catalog.clock_timestamp(), v_brief.updated_at + interval '1 microsecond');

  update public.recruitment_project_briefs
     set version = v_brief.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id,
         customer_name = v_candidate_brief.customer_name,
         investment_origin = v_candidate_brief.investment_origin,
         manufacturing_industry = v_candidate_brief.manufacturing_industry,
         job_description = v_candidate_brief.job_description,
         environment_types = v_candidate_brief.environment_types,
         work_postures = v_candidate_brief.work_postures,
         shift_pattern = v_candidate_brief.shift_pattern,
         shift_details = v_candidate_brief.shift_details,
         manager_name = v_candidate_brief.manager_name,
         manager_phone = v_candidate_brief.manager_phone,
         supply_schedule_text = v_candidate_brief.supply_schedule_text,
         expected_headcount = v_candidate_brief.expected_headcount,
         age_min = v_candidate_brief.age_min,
         age_max = v_candidate_brief.age_max,
         gender_requirement = v_candidate_brief.gender_requirement,
         education_requirement = v_candidate_brief.education_requirement,
         experience_required = v_candidate_brief.experience_required,
         experience_details = v_candidate_brief.experience_details,
         accept_former_customer_workers = v_candidate_brief.accept_former_customer_workers,
         entry_assessment_text = v_candidate_brief.entry_assessment_text,
         other_requirements_text = v_candidate_brief.other_requirements_text,
         base_salary_vnd = v_candidate_brief.base_salary_vnd,
         base_salary_conditions = v_candidate_brief.base_salary_conditions,
         attendance_bonus_vnd = v_candidate_brief.attendance_bonus_vnd,
         attendance_bonus_conditions = v_candidate_brief.attendance_bonus_conditions,
         living_allowance_vnd = v_candidate_brief.living_allowance_vnd,
         living_allowance_conditions = v_candidate_brief.living_allowance_conditions,
         seniority_allowance_vnd = v_candidate_brief.seniority_allowance_vnd,
         seniority_allowance_conditions = v_candidate_brief.seniority_allowance_conditions,
         eyesight_allowance_vnd = v_candidate_brief.eyesight_allowance_vnd,
         eyesight_allowance_conditions = v_candidate_brief.eyesight_allowance_conditions,
         other_allowance_text = v_candidate_brief.other_allowance_text,
         average_income_min_vnd = v_candidate_brief.average_income_min_vnd,
         average_income_max_vnd = v_candidate_brief.average_income_max_vnd,
         salary_payment_schedule = v_candidate_brief.salary_payment_schedule,
         salary_advance_available = v_candidate_brief.salary_advance_available,
         salary_advance_amount_vnd = v_candidate_brief.salary_advance_amount_vnd,
         salary_advance_schedule = v_candidate_brief.salary_advance_schedule,
         weekly_salary_available = v_candidate_brief.weekly_salary_available,
         weekly_salary_payment_schedule = v_candidate_brief.weekly_salary_payment_schedule,
         day_shift_8h_vnd = v_candidate_brief.day_shift_8h_vnd,
         day_shift_11h_vnd = v_candidate_brief.day_shift_11h_vnd,
         night_shift_8h_vnd = v_candidate_brief.night_shift_8h_vnd,
         night_shift_11h_vnd = v_candidate_brief.night_shift_11h_vnd,
         sunday_day_11h_vnd = v_candidate_brief.sunday_day_11h_vnd,
         sunday_night_11h_vnd = v_candidate_brief.sunday_night_11h_vnd,
         holiday_day_11h_vnd = v_candidate_brief.holiday_day_11h_vnd,
         holiday_night_11h_vnd = v_candidate_brief.holiday_night_11h_vnd,
         ppe_provided = v_candidate_brief.ppe_provided,
         ppe_details = v_candidate_brief.ppe_details,
         other_benefits = v_candidate_brief.other_benefits,
         require_original_cccd_and_copy = v_candidate_brief.require_original_cccd_and_copy,
         require_certified_resume = v_candidate_brief.require_certified_resume,
         require_health_certificate_within_6_months = v_candidate_brief.require_health_certificate_within_6_months,
         require_photo_3x4 = v_candidate_brief.require_photo_3x4,
         require_degree_or_certificate = v_candidate_brief.require_degree_or_certificate,
         require_social_insurance_book = v_candidate_brief.require_social_insurance_book,
         require_other_documents = v_candidate_brief.require_other_documents,
         other_documents_text = v_candidate_brief.other_documents_text
   where brief_id = p_brief_id
   returning * into v_brief;

  if v_labor_type_keys is distinct from v_old_labor_type_keys then
    delete from public.recruitment_project_brief_labor_types
     where brief_id = v_brief.brief_id
       and not (labor_type_key = any(v_labor_type_keys));

    insert into public.recruitment_project_brief_labor_types (brief_id, labor_type_key)
    select v_brief.brief_id, k
      from unnest(v_labor_type_keys) as k
    on conflict (brief_id, labor_type_key) do nothing;
  end if;

  v_after_snapshot := public.recruitment_post__internal_snapshot(v_brief, v_labor_type_keys);

  insert into public.recruitment_project_brief_revisions (
    brief_id,
    version,
    action,
    actor_app_user_id,
    before_snapshot,
    after_snapshot,
    brief_updated_at,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_brief.brief_id,
    v_brief.version,
    'UPDATE',
    p_app_user_id,
    v_before_snapshot,
    v_after_snapshot,
    v_brief.updated_at,
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
    changed_fields,
    reason_id,
    recruitment_post_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'recruitment_post_update',
    case when v_is_creator then 'recruitment_post_creator' else 'recruitment_post_admin' end,
    v_brief.brief_id::text,
    case when v_is_creator then 'own' else 'all' end,
    'APPLIED',
    v_changed_fields,
    null,
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'post', public.recruitment_post__internal_projection(v_brief, p_app_user_id),
    'changed', true
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'recruitment_post_update',
    v_idem_key,
    v_result
  );

  return v_result || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- RPC 6: `recruitment_post_withdraw` (7-step mutation ordering per §6.1)
create or replace function public.recruitment_post_withdraw(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_brief_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_idem_key text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_idempotency_key, '')));
  v_fingerprint text;
  v_prior jsonb;
  v_brief public.recruitment_project_briefs%rowtype;
  v_labor_type_keys text[];
  v_before_snapshot jsonb;
  v_after_snapshot jsonb;
  v_now timestamptz;
  v_revision_id uuid;
  v_is_creator boolean;
  v_result jsonb;
begin
  -- Step 1: Structural validation & resolve actor
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if p_brief_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_idem_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'RECRUITMENT_POST_IDEMPOTENCY_INVALID' using errcode = '22023';
  end if;

  v_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'op', 'recruitment_post_withdraw',
      'brief_id', p_brief_id,
      'expected_version', p_expected_version
    )
  );

  -- Step 2: Claim / Replay Idempotency
  v_prior := public.recruitment_post__internal_idempotency_begin(
    p_app_user_id,
    'recruitment_post_withdraw',
    v_idem_key,
    v_fingerprint
  );
  if v_prior is not null then
    return v_prior || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- Step 3: Business authority check before global advisory write lock
  select b.*
    into v_brief
    from public.recruitment_project_briefs b
   where b.brief_id = p_brief_id;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_brief.created_by_app_user_id <> p_app_user_id
     and not public.recruitment_post__internal_actor_is_full_admin_or_bod(p_app_user_id) then
    if v_brief.status = 'WITHDRAWN' then
      raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Step 4: Global advisory write lock
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('recruitment_post:write', 0)
  );

  -- Step 5: Lock & read business row in fixed global order: (5e) recruitment_project_briefs
  select b.*
    into v_brief
    from public.recruitment_project_briefs b
   where b.brief_id = p_brief_id
     for update;
  if not found then
    raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_is_creator := (v_brief.created_by_app_user_id = p_app_user_id);
  if not v_is_creator
     and not public.recruitment_post__internal_actor_is_full_admin_or_bod(p_app_user_id) then
    if v_brief.status = 'WITHDRAWN' then
      raise exception 'RECRUITMENT_POST_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Step 6: Validate OCC expected_version & status
  if v_brief.version <> p_expected_version then
    raise exception 'RECRUITMENT_POST_STALE' using errcode = 'PT409';
  end if;

  if v_brief.status = 'WITHDRAWN' then
    raise exception 'RECRUITMENT_POST_ALREADY_WITHDRAWN' using errcode = 'PT409';
  end if;

  -- Step 7: Persist withdraw, revision, audit, and finish idempotency
  select coalesce(pg_catalog.array_agg(blt.labor_type_key order by blt.labor_type_key asc), '{}'::text[])
    into v_labor_type_keys
    from public.recruitment_project_brief_labor_types blt
   where blt.brief_id = v_brief.brief_id;

  v_before_snapshot := public.recruitment_post__internal_snapshot(v_brief, v_labor_type_keys);

  perform pg_catalog.set_config('recruitment_post.write_marker', 'on', true);
  v_now := greatest(pg_catalog.clock_timestamp(), v_brief.updated_at + interval '1 microsecond');

  update public.recruitment_project_briefs
     set status = 'WITHDRAWN',
         version = v_brief.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id,
         withdrawn_at = v_now,
         withdrawn_by_app_user_id = p_app_user_id
   where brief_id = p_brief_id
   returning * into v_brief;

  v_after_snapshot := public.recruitment_post__internal_snapshot(v_brief, v_labor_type_keys);

  insert into public.recruitment_project_brief_revisions (
    brief_id,
    version,
    action,
    actor_app_user_id,
    before_snapshot,
    after_snapshot,
    brief_updated_at,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_brief.brief_id,
    v_brief.version,
    'WITHDRAW',
    p_app_user_id,
    v_before_snapshot,
    v_after_snapshot,
    v_brief.updated_at,
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
    changed_fields,
    reason_id,
    recruitment_post_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'recruitment_post_withdraw',
    case when v_is_creator then 'recruitment_post_creator' else 'recruitment_post_admin' end,
    v_brief.brief_id::text,
    case when v_is_creator then 'own' else 'all' end,
    'APPLIED',
    array['status', 'withdrawn_at', 'withdrawn_by_app_user_id']::text[],
    null,
    v_revision_id
  );

  v_result := pg_catalog.jsonb_build_object(
    'post', public.recruitment_post__internal_projection(v_brief, p_app_user_id),
    'changed', true
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'recruitment_post_withdraw',
    v_idem_key,
    v_result
  );

  return v_result || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Align function owners with table owner (`public.recruitment_project_briefs`)
--    and apply fail-closed ACL (Must fix 2):
--    - All 10 internal helpers: REVOKE ALL FROM public, anon, authenticated, service_role
--    - All 6 public RPCs: REVOKE ALL FROM public, anon, authenticated, service_role;
--                         GRANT EXECUTE TO service_role
-- -----------------------------------------------------------------------------
do $align_recruitment_post_owners$
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

  if v_base_owner is null then
    raise exception 'Owner resolution failed for public.direct_entries'
      using errcode = '55000';
  end if;

  foreach v_tbl in array array[
    'recruitment_project_briefs',
    'recruitment_project_brief_labor_types',
    'recruitment_project_brief_revisions'
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

  foreach v_fn in array array[
    'public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_actor_label(uuid)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_idempotency_begin(uuid,text,text,text)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_filter_hash(text,uuid,uuid,text,date,date)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_normalize_payload(text,jsonb)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_snapshot(public.recruitment_project_briefs,text[])'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_projection(public.recruitment_project_briefs,uuid)'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_briefs_write_guard()'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_brief_labor_write_guard()'::pg_catalog.regprocedure,
    'public.recruitment_post__internal_guard_park_province_change()'::pg_catalog.regprocedure,
    'public.recruitment_post_get_context(uuid,uuid)'::pg_catalog.regprocedure,
    'public.recruitment_post_list(uuid,uuid,text,uuid,uuid,text,date,date,text,text,integer)'::pg_catalog.regprocedure,
    'public.recruitment_post_get(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.recruitment_post_create(uuid,uuid,jsonb,text)'::pg_catalog.regprocedure,
    'public.recruitment_post_update(uuid,uuid,uuid,integer,jsonb,text)'::pg_catalog.regprocedure,
    'public.recruitment_post_withdraw(uuid,uuid,uuid,integer,text)'::pg_catalog.regprocedure
  ] loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_fn;

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
       and p.proname like 'recruitment_post%'
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
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid, text) to %I',
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
    execute pg_catalog.format(
      'grant execute on function public.recruitment_location_is_admin_or_bod(uuid) to %I',
      v_owner
    );
  end loop;
end
$align_recruitment_post_owners$;

-- Internal helpers (10): completely uncallable via PostgREST even with service_role key
revoke all on function public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_actor_label(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_idempotency_begin(uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_filter_hash(text, uuid, uuid, text, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_normalize_payload(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_snapshot(public.recruitment_project_briefs, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_projection(public.recruitment_project_briefs, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_briefs_write_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_brief_labor_write_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post__internal_guard_park_province_change()
  from public, anon, authenticated, service_role;

-- Public RPCs (6): revoke from all, then grant execute only to service_role
revoke all on function public.recruitment_post_get_context(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_get(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_create(uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_update(uuid, uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_withdraw(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;

grant execute on function public.recruitment_post_get_context(uuid, uuid)
  to service_role;
grant execute on function public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
  to service_role;
grant execute on function public.recruitment_post_get(uuid, uuid, uuid)
  to service_role;
grant execute on function public.recruitment_post_create(uuid, uuid, jsonb, text)
  to service_role;
grant execute on function public.recruitment_post_update(uuid, uuid, uuid, integer, jsonb, text)
  to service_role;
grant execute on function public.recruitment_post_withdraw(uuid, uuid, uuid, integer, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Self-check block verifying tables, RLS, non-unique project-published index,
--    triggers, SECDEF search_path, owner FORCE RLS bypass capability, and
--    fail-closed ACL for both the 6 public RPCs and 10 internal helpers.
-- -----------------------------------------------------------------------------
do $self_check$
declare
  v_rls_count integer;
  v_table_grants integer;
  v_policy_count integer;
  v_non_bypass_table_owners integer;
  v_idx_count integer;
  v_proj_idx_is_unique boolean;
  v_trig_count integer;
  v_public_rpc text;
  v_internal_fn text;
  v_fn_oid oid;
  v_fn_owner_oid oid;
  v_prosecdef boolean;
  v_proconfig text[];
  v_owner_bypasses_rls boolean;
  v_public_rpc_list constant text[] := array[
    'public.recruitment_post_get_context(uuid,uuid)',
    'public.recruitment_post_list(uuid,uuid,text,uuid,uuid,text,date,date,text,text,integer)',
    'public.recruitment_post_get(uuid,uuid,uuid)',
    'public.recruitment_post_create(uuid,uuid,jsonb,text)',
    'public.recruitment_post_update(uuid,uuid,uuid,integer,jsonb,text)',
    'public.recruitment_post_withdraw(uuid,uuid,uuid,integer,text)'
  ];
  v_internal_fn_list constant text[] := array[
    'public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)',
    'public.recruitment_post__internal_actor_label(uuid)',
    'public.recruitment_post__internal_idempotency_begin(uuid,text,text,text)',
    'public.recruitment_post__internal_filter_hash(text,uuid,uuid,text,date,date)',
    'public.recruitment_post__internal_normalize_payload(text,jsonb)',
    'public.recruitment_post__internal_snapshot(public.recruitment_project_briefs,text[])',
    'public.recruitment_post__internal_projection(public.recruitment_project_briefs,uuid)',
    'public.recruitment_post__internal_briefs_write_guard()',
    'public.recruitment_post__internal_brief_labor_write_guard()',
    'public.recruitment_post__internal_guard_park_province_change()'
  ];
begin
  select count(*)
    into v_rls_count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n
      on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'recruitment_project_briefs',
       'recruitment_project_brief_labor_types',
       'recruitment_project_brief_revisions'
     )
     and c.relrowsecurity = true
     and c.relforcerowsecurity = true;

  if v_rls_count <> 3 then
    raise exception 'Self-check failed: expected RLS + FORCE RLS on all 3 recruitment_project_brief* tables, got %', v_rls_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_policy_count
    from pg_catalog.pg_policy pol
    join pg_catalog.pg_class c on c.oid = pol.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'recruitment_project_briefs',
       'recruitment_project_brief_labor_types',
       'recruitment_project_brief_revisions'
     );

  if v_policy_count <> 0 then
    raise exception 'Self-check failed: expected 0 permissive RLS policies on recruitment_project_brief* tables, got %', v_policy_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in (
       'recruitment_project_briefs',
       'recruitment_project_brief_labor_types',
       'recruitment_project_brief_revisions'
     )
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'Self-check failed: expected 0 table grants on recruitment_project_brief* tables for runtime roles, got %', v_table_grants
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_non_bypass_table_owners
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where n.nspname = 'public'
     and c.relname in (
       'recruitment_project_briefs',
       'recruitment_project_brief_labor_types',
       'recruitment_project_brief_revisions'
     )
     and not (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false));

  if v_non_bypass_table_owners <> 0 then
    raise exception 'Self-check failed: owner of recruitment_project_brief* tables must bypass FORCE RLS (% tables failed)', v_non_bypass_table_owners
      using errcode = '55000';
  end if;

  select count(*)
    into v_idx_count
    from pg_catalog.pg_indexes i
   where i.schemaname = 'public'
     and i.indexname in (
       'recruitment_project_briefs_project_published_idx',
       'recruitment_project_briefs_park_published_idx',
       'recruitment_project_brief_labor_types_pkey',
       'recruitment_project_brief_labor_types_key_brief_idx',
       'recruitment_project_brief_revisions_brief_id_version_key',
       'recruitment_project_brief_revisions_revision_seq_key',
       'recruitment_project_brief_revisions_brief_seq_idx',
       'direct_entry_audit_events_recruitment_post_revision_idx'
     );

  if v_idx_count <> 8 then
    raise exception 'Self-check failed: expected 8 recruitment post indexes, got %', v_idx_count
      using errcode = '55000';
  end if;

  select ix.indisunique
    into v_proj_idx_is_unique
    from pg_catalog.pg_index ix
    join pg_catalog.pg_class c on c.oid = ix.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'recruitment_project_briefs_project_published_idx';

  if v_proj_idx_is_unique is distinct from false then
    raise exception 'Self-check failed: recruitment_project_briefs_project_published_idx must be non-unique'
      using errcode = '55000';
  end if;

  select count(*)
    into v_trig_count
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c
      on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n
      on n.oid = c.relnamespace
   where not t.tgisinternal
     and n.nspname = 'public'
     and t.tgname in (
       'recruitment_project_briefs_write_guard',
       'recruitment_project_brief_labor_types_write_guard',
       'recruitment_project_brief_revisions_immutable',
       'recruitment_post_guard_industrial_park_province_move'
     );

  if v_trig_count <> 4 then
    raise exception 'Self-check failed: expected 4 triggers, got %', v_trig_count
      using errcode = '55000';
  end if;

  foreach v_public_rpc in array v_public_rpc_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_public_rpc);
    if v_fn_oid is null then
      raise exception 'Self-check failed: missing public RPC %', v_public_rpc
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'Self-check failed: RPC % must be SECURITY DEFINER with search_path=pg_catalog, public', v_public_rpc
        using errcode = '55000';
    end if;

    if not coalesce(v_owner_bypasses_rls, false)
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_briefs'::pg_catalog.regclass, 'SELECT, INSERT, UPDATE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_labor_types'::pg_catalog.regclass, 'SELECT, INSERT, DELETE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_revisions'::pg_catalog.regclass, 'SELECT, INSERT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.industrial_parks'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.administrative_provinces'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_function_privilege(v_fn_owner_oid, v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: owner of RPC % must bypass FORCE RLS and hold required table privileges', v_public_rpc
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: unexpected ACL on public RPC %', v_public_rpc
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array v_internal_fn_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_internal_fn);
    if v_fn_oid is null then
      raise exception 'Self-check failed: missing internal helper %', v_internal_fn
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'Self-check failed: internal helper % must be SECURITY DEFINER with search_path=pg_catalog, public', v_internal_fn
        using errcode = '55000';
    end if;

    if not coalesce(v_owner_bypasses_rls, false)
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_briefs'::pg_catalog.regclass, 'SELECT, INSERT, UPDATE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_labor_types'::pg_catalog.regclass, 'SELECT, INSERT, DELETE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_revisions'::pg_catalog.regclass, 'SELECT, INSERT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.industrial_parks'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.administrative_provinces'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_function_privilege(v_fn_owner_oid, v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: owner of internal helper % must bypass FORCE RLS and hold required table privileges', v_internal_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: internal helper % must have EXECUTE revoked from public, anon, authenticated, and service_role', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;
end
$self_check$;

commit;
