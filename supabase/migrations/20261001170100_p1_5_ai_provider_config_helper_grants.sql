-- P1.5-W04A (bổ sung) — Siết ACL cho hai hàm phụ trợ của provider config.
--
-- Lý do: hàm tạo bằng CREATE OR REPLACE nhận ACL mặc định của PUBLIC (anon/authenticated có EXECUTE).
-- `ai_provider_config_public_json` chỉ là helper projection và `ai_provider_config_audit_immutable`
-- là trigger function — không cần quyền EXECUTE cho bất kỳ role nào ngoài service_role (và owner).
--
-- ROLLBACK:
--   grant execute on function public.ai_provider_config_public_json(public.ai_provider_configs) to public, anon, authenticated;
--   grant execute on function public.ai_provider_config_audit_immutable() to public, anon, authenticated;

revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from public;
revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from anon;
revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from authenticated;
grant execute on function public.ai_provider_config_public_json(public.ai_provider_configs) to service_role;

revoke all on function public.ai_provider_config_audit_immutable() from public;
revoke all on function public.ai_provider_config_audit_immutable() from anon;
revoke all on function public.ai_provider_config_audit_immutable() from authenticated;
grant execute on function public.ai_provider_config_audit_immutable() to service_role;
