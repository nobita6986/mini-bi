-- =============================================================================
-- P0-T1-G1-R1 — Contract reconciliation (phần 1/2): schema + danh mục J/L
--
-- Theo T0 TASK — P0-T1-G1-R1. Forward migration: KHÔNG sửa migration đã áp dụng.
--
-- 1. sync_runs: thêm rows_warned, warning_issues.
-- 2. sync_errors: thêm issue_level (error|warning).
-- 3. daily_recruitment_breakdown: ràng buộc danh mục cho provider_type và
--    employment_type (key + display canonical).
-- 4. Hàm canonical hóa J/L + cập nhật hàm expand breakdown.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. sync_runs
-- -----------------------------------------------------------------------------
alter table public.sync_runs
  add column rows_warned    integer not null default 0,
  add column warning_issues integer not null default 0;

alter table public.sync_runs
  add constraint sync_runs_rows_warned_check
    check (rows_warned >= 0 and rows_warned <= rows_valid),
  add constraint sync_runs_warning_issues_check
    check (warning_issues >= 0 and warning_issues >= rows_warned);

comment on column public.sync_runs.rows_warned is
  'Số source_row_number KHÁC NHAU có ít nhất một issue_level = warning. Luôn <= rows_valid.';
comment on column public.sync_runs.warning_issues is
  'Tổng số dòng row_issues có issue_level = warning. Luôn >= rows_warned.';

-- -----------------------------------------------------------------------------
-- 2. sync_errors
-- -----------------------------------------------------------------------------
alter table public.sync_errors
  add column issue_level text not null default 'error';

alter table public.sync_errors
  add constraint sync_errors_issue_level_check check (issue_level in ('error', 'warning'));

create index sync_errors_run_level_idx on public.sync_errors (run_id, issue_level);

comment on column public.sync_errors.issue_level is
  'error = hàng bị loại; warning = hàng vẫn được tính nhưng có dữ liệu ngoài danh mục.';
comment on table public.sync_errors is
  'Lỗi/cảnh báo mức run hoặc mức hàng nguồn. source_row_number chỉ là locator; '
  'sanitized_reason được RPC sinh cố định, không chứa giá trị nguồn hay dữ liệu ứng viên.';

-- -----------------------------------------------------------------------------
-- 3. Danh mục J/L trên bảng aggregate
--    provider_type  ∈ hrp | vendor | __unknown__ | __invalid__
--    employment_type∈ thời vụ | chính thức | __unknown__ | __invalid__
--    display luôn là giá trị canonical tương ứng.
-- -----------------------------------------------------------------------------
alter table public.daily_recruitment_breakdown
  add constraint daily_recruitment_breakdown_provider_type_catalog_check
    check (provider_type_key in ('hrp', 'vendor', '__unknown__', '__invalid__')),
  add constraint daily_recruitment_breakdown_provider_type_canonical_display_check
    check (provider_type_display = case provider_type_key
                                     when 'hrp' then 'HRP'
                                     when 'vendor' then 'Vendor'
                                     when '__unknown__' then 'Không xác định'
                                     else 'Không hợp lệ'
                                   end),
  add constraint daily_recruitment_breakdown_employment_type_catalog_check
    check (employment_type_key in ('thời vụ', 'chính thức', '__unknown__', '__invalid__')),
  add constraint daily_recruitment_breakdown_employment_type_canonical_display_check
    check (employment_type_display = case employment_type_key
                                       when 'thời vụ' then 'Thời vụ'
                                       when 'chính thức' then 'Chính thức'
                                       when '__unknown__' then 'Không xác định'
                                       else 'Không hợp lệ'
                                     end);

-- -----------------------------------------------------------------------------
-- 4. Canonical hóa J/L
--
--    Quy tắc:
--      - thiếu/rỗng sau chuẩn hóa            => __unknown__ / "Không xác định"
--      - J nằm trong danh mục (không phân biệt hoa/thường, khoảng trắng) => key danh mục
--      - J ngoài danh mục                     => __invalid__ / "Không hợp lệ"
--    Display luôn suy ra TỪ KEY nên key và display không thể lệch nhau.
--    Không suy HRP/Vendor từ người tuyển. Không map alias.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_provider_type_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
           when k is null then '__unknown__'
           when k = 'hrp' then 'hrp'
           when k = 'vendor' then 'vendor'
           else '__invalid__'
         end
    from (select public.recruitment_dimension_key(p_value) as k) s;
$function$;

comment on function public.recruitment_provider_type_key(text) is
  'Danh mục HRP/Vendor. Thiếu/rỗng => __unknown__; ngoài danh mục => __invalid__.';

create or replace function public.recruitment_provider_type_display(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case public.recruitment_provider_type_key(p_value)
           when 'hrp' then 'HRP'
           when 'vendor' then 'Vendor'
           when '__unknown__' then 'Không xác định'
           else 'Không hợp lệ'
         end;
$function$;

create or replace function public.recruitment_employment_type_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
           when k is null then '__unknown__'
           when k = 'thời vụ' then 'thời vụ'
           when k = 'chính thức' then 'chính thức'
           else '__invalid__'
         end
    from (select public.recruitment_dimension_key(p_value) as k) s;
$function$;

comment on function public.recruitment_employment_type_key(text) is
  'Danh mục loại hình lao động. Thiếu/rỗng => __unknown__; ngoài danh mục => __invalid__.';

create or replace function public.recruitment_employment_type_display(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case public.recruitment_employment_type_key(p_value)
           when 'thời vụ' then 'Thời vụ'
           when 'chính thức' then 'Chính thức'
           when '__unknown__' then 'Không xác định'
           else 'Không hợp lệ'
         end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. expand breakdown: dùng canonical J/L; project và recruiter vẫn free text
--    sau chuẩn hóa (không map alias, không bỏ dấu).
-- -----------------------------------------------------------------------------
create or replace function public.expand_daily_recruitment_breakdown_v02(p_breakdown jsonb)
returns table (
  business_date           date,
  project_key             text,
  project_display         text,
  recruiter_key           text,
  recruiter_display       text,
  provider_type_key       text,
  provider_type_display   text,
  employment_type_key     text,
  employment_type_display text,
  recruited_count         integer
)
language sql
immutable
set search_path = ''
as $function$
  select
    (e.value ->> 'business_date')::date,
    coalesce(public.recruitment_dimension_key(e.value ->> 'project'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'project'), 'Không xác định'),
    coalesce(public.recruitment_dimension_key(e.value ->> 'recruiter'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'recruiter'), 'Không xác định'),
    public.recruitment_provider_type_key(e.value ->> 'provider_type'),
    public.recruitment_provider_type_display(e.value ->> 'provider_type'),
    public.recruitment_employment_type_key(e.value ->> 'employment_type'),
    public.recruitment_employment_type_display(e.value ->> 'employment_type'),
    (e.value ->> 'recruited_count')::integer
  from jsonb_array_elements(coalesce(p_breakdown, '[]'::jsonb)) as e(value);
$function$;

comment on function public.expand_daily_recruitment_breakdown_v02(jsonb) is
  'Nội bộ. Chuẩn hóa breakdown payload thành dòng grain; J/L bị canonical hóa theo danh mục.';

revoke all on function public.recruitment_provider_type_key(text) from public, anon, authenticated;
revoke all on function public.recruitment_provider_type_display(text) from public, anon, authenticated;
revoke all on function public.recruitment_employment_type_key(text) from public, anon, authenticated;
revoke all on function public.recruitment_employment_type_display(text) from public, anon, authenticated;

grant execute on function public.recruitment_provider_type_key(text) to service_role;
grant execute on function public.recruitment_provider_type_display(text) to service_role;
grant execute on function public.recruitment_employment_type_key(text) to service_role;
grant execute on function public.recruitment_employment_type_display(text) to service_role;
