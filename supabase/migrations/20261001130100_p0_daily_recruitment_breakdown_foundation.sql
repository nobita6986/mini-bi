-- =============================================================================
-- P0 — Nền dữ liệu cho contract daily-recruitment-breakdown/0.2
--
-- Grain: source_id + business_date + project + recruiter + provider_type
--        + employment_type = recruited_count
--
-- KHÔNG lưu dữ liệu cá nhân ứng viên. Bảng này chỉ chứa giá trị tổng hợp của
-- các trường phân loại. Không có cột họ tên / ngày sinh / CCCD / địa chỉ /
-- số điện thoại / ghi chú ứng viên.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Chuẩn hóa chuỗi phân loại.
--
-- Quy ước (xem docs/contracts/daily-recruitment-breakdown-v0.2.md §5):
--   1. Chuẩn hóa Unicode NFC.
--   2. Trim khoảng trắng đầu/cuối.
--   3. Gộp mọi chuỗi khoảng trắng liên tiếp (space/tab/newline) thành một space.
--   4. Key gộp nhóm thêm bước lowercase; display giữ nguyên chữ hoa/thường.
--   5. Thiếu/rỗng (sau bước 1-3) => NULL ở đây; RPC quy về "Không xác định".
--
-- Không suy luận, không sửa tên, không dùng AI, không bỏ dấu, không map alias.
-- Hàm IMMUTABLE để dùng được trong CHECK constraint.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_dimension_display(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then null
    when btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g')) = '' then null
    else btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g'))
  end;
$function$;

comment on function public.recruitment_dimension_display(text) is
  'Chuẩn hóa display: NFC + trim + gộp khoảng trắng; giữ nguyên chữ hoa/thường. Rỗng => NULL.';

create or replace function public.recruitment_dimension_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then null
    when btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g')) = '' then null
    else lower(btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g')))
  end;
$function$;

comment on function public.recruitment_dimension_key(text) is
  'Khóa gộp nhóm: như display nhưng lowercase. Rỗng => NULL. Không bỏ dấu, không map alias.';

-- -----------------------------------------------------------------------------
-- Bảng aggregate
-- -----------------------------------------------------------------------------
create table public.daily_recruitment_breakdown (
  source_id                uuid        not null references public.data_sources (id) on delete cascade,
  business_date            date        not null,
  project_key              text        not null,
  project_display          text        not null,
  recruiter_key            text        not null,
  recruiter_display        text        not null,
  provider_type_key        text        not null,
  provider_type_display    text        not null,
  employment_type_key      text        not null,
  employment_type_display  text        not null,
  recruited_count          integer     not null,
  sync_run_id              uuid        not null references public.sync_runs (run_id) on delete cascade,
  snapshot_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint daily_recruitment_breakdown_pkey primary key (
    source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key
  ),
  constraint daily_recruitment_breakdown_count_check check (recruited_count >= 0),
  constraint daily_recruitment_breakdown_project_key_check
    check (project_key = public.recruitment_dimension_key(project_key) and char_length(project_key) between 1 and 200),
  constraint daily_recruitment_breakdown_recruiter_key_check
    check (recruiter_key = public.recruitment_dimension_key(recruiter_key) and char_length(recruiter_key) between 1 and 200),
  constraint daily_recruitment_breakdown_provider_type_key_check
    check (provider_type_key = public.recruitment_dimension_key(provider_type_key) and char_length(provider_type_key) between 1 and 200),
  constraint daily_recruitment_breakdown_employment_type_key_check
    check (employment_type_key = public.recruitment_dimension_key(employment_type_key) and char_length(employment_type_key) between 1 and 200),
  constraint daily_recruitment_breakdown_project_display_check
    check (char_length(project_display) between 1 and 200),
  constraint daily_recruitment_breakdown_recruiter_display_check
    check (char_length(recruiter_display) between 1 and 200),
  constraint daily_recruitment_breakdown_provider_type_display_check
    check (char_length(provider_type_display) between 1 and 200),
  constraint daily_recruitment_breakdown_employment_type_display_check
    check (char_length(employment_type_display) between 1 and 200)
);

comment on table public.daily_recruitment_breakdown is
  'Snapshot hiện hành: số người tuyển theo ngày và 4 chiều phân loại, cho từng source. '
  'Không chứa dữ liệu cá nhân ứng viên. Mỗi lần publish thay thế toàn bộ source.';

-- Lọc theo khoảng ngày trên nhiều source. Index theo từng chiều phân loại sẽ được
-- thêm ở P2 sau khi đo volume thật (docs/master-plan.md: tối ưu theo quy mô đo được).
create index daily_recruitment_breakdown_business_date_idx
  on public.daily_recruitment_breakdown (business_date);

create trigger daily_recruitment_breakdown_set_updated_at
  before update on public.daily_recruitment_breakdown
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Bảo mật: deny toàn bộ truy cập ẩn danh (giống các bảng P0 khác).
-- -----------------------------------------------------------------------------
alter table public.daily_recruitment_breakdown enable row level security;

revoke all on table public.daily_recruitment_breakdown from public, anon, authenticated;
grant all on table public.daily_recruitment_breakdown to service_role;
