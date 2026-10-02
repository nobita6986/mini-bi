-- P1.5-W04-R? — Audit append-only ở TẦNG QUYỀN (bổ sung sau migration chính).
--
-- Lý do: Supabase cấp mặc định nhiều quyền cho service_role trên bảng mới trong schema public
-- (bao gồm UPDATE/DELETE/TRUNCATE). Migration chính đã revoke PUBLIC/anon/authenticated và bật RLS,
-- nhưng để "audit append-only" đúng nghĩa cần thu hồi thêm quyền sửa/xoá khỏi service_role.
--
-- ROLLBACK:
--   grant update, delete, truncate on table public.ai_report_audit_events to service_role;
--   grant truncate on table public.ai_report_jobs to service_role;
--   grant truncate on table public.ai_report_revisions to service_role;
--   grant truncate on table public.ai_report_usage to service_role;

-- Audit: chỉ đọc và ghi thêm (không sửa, không xoá, không truncate).
revoke update, delete, truncate on table public.ai_report_audit_events from service_role;
grant select, insert on table public.ai_report_audit_events to service_role;

-- Job/revision/usage: không truncate trong runtime (giữ select/insert/update cho vận hành).
revoke truncate on table public.ai_report_jobs from service_role;
revoke truncate on table public.ai_report_revisions from service_role;
revoke truncate on table public.ai_report_usage from service_role;
