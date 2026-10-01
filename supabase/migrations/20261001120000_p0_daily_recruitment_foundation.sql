-- =============================================================================
-- P0-T1-G1 — Foundation cho báo cáo "số người tuyển theo ngày"
-- Contract: daily-recruitment-count/0.1
-- Grain:    data_sources (1 Google Sheet) -> daily_recruitment_counts (source, business_date)
--
-- Áp dụng bằng: pnpm db:migrate   (script bọc mỗi file trong 1 transaction)
-- Không chạy file này trực tiếp trên PROD ngoài quy trình migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: duy trì updated_at
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- data_sources — 1 dòng = 1 Google Sheet nguồn
-- drive_file_id là external stable ID; file_name/sheet_name chỉ để hiển thị/config.
-- -----------------------------------------------------------------------------
create table public.data_sources (
  id                      uuid primary key default gen_random_uuid(),
  drive_file_id           text        not null,
  file_name               text        not null,
  sheet_name              text        not null,
  active                  boolean     not null default true,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz,
  last_successful_sync_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint data_sources_drive_file_id_unique unique (drive_file_id),
  constraint data_sources_drive_file_id_not_blank check (btrim(drive_file_id) <> ''),
  constraint data_sources_file_name_not_blank check (btrim(file_name) <> ''),
  constraint data_sources_sheet_name_not_blank check (btrim(sheet_name) <> '')
);

comment on table public.data_sources is
  'Nguồn dữ liệu (Google Sheet). Khóa ngoài là drive_file_id; không dùng filename hay số hàng.';
comment on column public.data_sources.last_successful_sync_at is
  'Chỉ cập nhật từ run status = succeeded (theo docs/P0.md §8.1).';

create trigger data_sources_set_updated_at
  before update on public.data_sources
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- sync_runs — 1 dòng = 1 lần chạy cho 1 source
-- -----------------------------------------------------------------------------
create table public.sync_runs (
  run_id          uuid primary key,
  source_id       uuid        not null references public.data_sources (id) on delete cascade,
  trigger_type    text        not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text        not null,
  rows_read       integer     not null default 0,
  rows_valid      integer     not null default 0,
  rows_rejected   integer     not null default 0,
  error_code      text,
  sanitized_error text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint sync_runs_trigger_type_check check (trigger_type in ('manual', 'schedule', 'bot')),
  constraint sync_runs_status_check check (status in ('running', 'succeeded', 'partial', 'failed')),
  constraint sync_runs_rows_read_check check (rows_read >= 0),
  constraint sync_runs_rows_valid_check check (rows_valid >= 0),
  constraint sync_runs_rows_rejected_check check (rows_rejected >= 0),
  constraint sync_runs_rows_consistent_check check (rows_valid + rows_rejected <= rows_read),
  constraint sync_runs_finished_at_check check ((status = 'running') = (finished_at is null)),
  constraint sync_runs_error_code_format_check
    check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  constraint sync_runs_sanitized_error_length_check
    check (sanitized_error is null or char_length(sanitized_error) between 1 and 500)
);

comment on table public.sync_runs is
  'Lịch sử chạy sync. sanitized_error không được chứa dữ liệu ứng viên.';

create index sync_runs_source_started_idx on public.sync_runs (source_id, started_at desc);
create index sync_runs_status_idx on public.sync_runs (status);

create trigger sync_runs_set_updated_at
  before update on public.sync_runs
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- daily_recruitment_counts — snapshot hiện hành theo (source, business_date)
-- -----------------------------------------------------------------------------
create table public.daily_recruitment_counts (
  source_id        uuid        not null references public.data_sources (id) on delete cascade,
  business_date    date        not null,
  recruited_count  integer     not null,
  sync_run_id      uuid        not null references public.sync_runs (run_id) on delete cascade,
  snapshot_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint daily_recruitment_counts_pkey primary key (source_id, business_date),
  constraint daily_recruitment_counts_count_check check (recruited_count >= 0)
);

comment on table public.daily_recruitment_counts is
  'Snapshot hiện hành: số người tuyển theo ngày cho từng source. Được thay thế toàn bộ mỗi lần publish.';

create index daily_recruitment_counts_business_date_idx
  on public.daily_recruitment_counts (business_date);
create index daily_recruitment_counts_run_idx
  on public.daily_recruitment_counts (sync_run_id);

create trigger daily_recruitment_counts_set_updated_at
  before update on public.daily_recruitment_counts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- sync_errors — lỗi ở mức run/snapshot (không lưu hồ sơ ứng viên, không lưu raw row)
-- -----------------------------------------------------------------------------
create table public.sync_errors (
  id                 bigint generated always as identity primary key,
  run_id             uuid        not null references public.sync_runs (run_id) on delete cascade,
  source_id          uuid        not null references public.data_sources (id) on delete cascade,
  source_row_number  integer,
  error_code         text        not null,
  sanitized_reason   text        not null,
  created_at         timestamptz not null default now(),
  constraint sync_errors_error_code_format_check check (error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  constraint sync_errors_sanitized_reason_check check (char_length(sanitized_reason) between 1 and 500),
  constraint sync_errors_source_row_number_check check (source_row_number is null or source_row_number > 0)
);

comment on table public.sync_errors is
  'Lỗi mức run/snapshot. source_row_number chỉ là locator tra cứu, không phải khóa và không chứa dữ liệu hàng.';

create index sync_errors_run_idx on public.sync_errors (run_id);
create index sync_errors_source_created_idx on public.sync_errors (source_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Bảo mật: deny toàn bộ truy cập ẩn danh. Chỉ service_role (server-side) được dùng.
-- Không có policy nào cho anon/authenticated => RLS chặn hết.
-- P3 sẽ bổ sung policy theo role BoD/Leader/Staff.
-- -----------------------------------------------------------------------------
alter table public.data_sources            enable row level security;
alter table public.sync_runs               enable row level security;
alter table public.daily_recruitment_counts enable row level security;
alter table public.sync_errors             enable row level security;

revoke all on table public.data_sources             from public, anon, authenticated;
revoke all on table public.sync_runs                from public, anon, authenticated;
revoke all on table public.daily_recruitment_counts from public, anon, authenticated;
revoke all on table public.sync_errors              from public, anon, authenticated;

grant all on table public.data_sources             to service_role;
grant all on table public.sync_runs                to service_role;
grant all on table public.daily_recruitment_counts to service_role;
grant all on table public.sync_errors              to service_role;

grant usage, select on sequence public.sync_errors_id_seq to service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;
