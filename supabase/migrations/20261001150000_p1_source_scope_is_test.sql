-- =============================================================================
-- P1-T1-W02 — Source scope: cô lập fixture khỏi reporting scope BoD
--
-- Reporting scope = data_sources.active = true AND data_sources.is_test = false.
-- Không sửa semantics RPC/contract ingestion v0.2. Idempotent (IF NOT EXISTS + UPDATE no-op).
-- =============================================================================

alter table public.data_sources
  add column if not exists is_test boolean not null default false;

comment on column public.data_sources.is_test is
  'true = source fixture/test. Bị loại khỏi reporting scope BoD (active=true AND is_test=false). '
  'Source mới do RPC phát hiện mặc định false.';

-- Đánh dấu chính xác hai fixture đã khóa (KHÔNG dùng pattern rộng để tránh đánh nhầm source thật).
update public.data_sources
   set is_test = true
 where drive_file_id in ('P0FIXTURE_DRIVE_FILE_A', 'P0FIXTURE_DRIVE_FILE_B');

-- Index cho reporting scope.
create index if not exists data_sources_reporting_scope_idx
  on public.data_sources (active, is_test);
