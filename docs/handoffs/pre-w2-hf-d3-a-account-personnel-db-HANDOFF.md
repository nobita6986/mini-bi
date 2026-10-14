# Pre-W2-HF-D3-A — Account/Personnel DB foundation

- Base: `origin/main@68a555d` (92 migrations at commit; ledger 91 -> 92).
- Branch: `feature/pre-w2-hf-d3-a-account-personnel-db`.
- Status: **PRE_W2_HF_D3_A_DB_FOUNDATION_LOCAL_PASS_AWAITING_T0_REVIEW** (không apply Production/Vercel/VPS, không UAT).
- Migration: `supabase/migrations/20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql`
  - SHA-256: `27c45208e44699b1fdc7478a66da7378083cfd85d68a3eef30c3906a47b87400`

## Phạm vi

SQL/database foundation + DB tests. Không API/UI, không Supabase Auth call, không cron, không deploy.

## Preflight

- PR #19 đã merge (`68a555d`), contract `docs/handoffs/pre-w2-hf-d3-account-personnel-contract-final.md` hiện diện và đã đọc toàn bộ.
- Ledger `origin/main` = 91 migrations; slot kế tiếp thực tế = **#92** (không collision). `apply-migrations.mjs --offline` xác nhận 92/92, không DB access.

## Migration #92

1. **Intent table** `direct_entry_account_operation_intents`: `intent_token` (provenance marker, không phải secret), `kind` (`CREATE_ACCOUNT`|`RESET_PASSWORD`), `state` (8 trạng thái PENDING/IN_FLIGHT/APPLIED/FAILED/INDETERMINATE/BLOCKED/CONFLICT/EXPIRED), `login_id`/`display_name` (PII, có retention), `account_ref`/`auth_subject` (định danh giả danh), `reason_id`, `idempotency_key`, retention fields. **Không có cột password/hash.** Unique live-login guard (partial unique index trên login_id khi PENDING/IN_FLIGHT).
2. **Login predicate** `direct_entry_is_canonical_login_id(text)` — mirror regex `^[a-z0-9][a-z0-9._-]{0,63}$`.
3. **Revision action extension**: thêm `account_created`, `display_name_update` vào CHECK của `direct_entry_app_user_revisions.action` (không tái dùng nhãn cũ).
4. **Cardinality 1:1 đối xứng**: trigger `direct_entry_recruiter_link_no_overlap_by_recruiter` + hàm guard mới (một recruiter tối đa một verified link). Migration fail-closed nếu dữ liệu hiện hữu vi phạm (chỉ báo, không sửa).
5. **RPCs** (8) + self-check data-free.

## RPC signatures / envelopes (service_role only, SECURITY DEFINER, search_path=pg_catalog,public, revoke mọi role khác)

| RPC | Signature | Envelope |
|---|---|---|
| begin | `direct_entry_account_operation_begin(uuid,uuid,text,text,text,uuid,text,text)` | `{intent_id,intent_token,kind,state}` |
| claim | `direct_entry_account_operation_claim(uuid,uuid,uuid,uuid)` | `{intent_id,intent_token,kind,state,claimed}` |
| read | `direct_entry_account_operation_read(uuid,uuid,uuid)` | `{intent_id,intent_token,kind,state,login_id,display_name,account_ref,auth_subject,created_at,claimed_at,resolved_at}` |
| finish | `direct_entry_account_operation_finish(uuid,uuid,uuid,text,uuid,text)` | `{intent_id,state,resolved_at}` |
| finalize | `direct_entry_account_operation_finalize_create(uuid,uuid,uuid,uuid,uuid,text)` | `{app_user_id,auth_subject,display_name,version,revision_id,intent_id,intent_state}` |
| update name | `direct_entry_account_operation_update_display_name(uuid,uuid,uuid,text,integer,text,text)` | `{app_user_id,version,revision_id,recruiter_id,recruiter_version,recruiter_revision_id}` |
| create personnel | `direct_entry_account_operation_create_personnel(uuid,uuid,uuid,text,text,date,text,text)` | `{recruiter_id,display_name,personnel_code,personnel_position,version,link_id,membership_id,revision_id}` |
| reclassify | `direct_entry_account_operation_reclassify(uuid,uuid)` | `{reclassified,purged,deleted}` |

Ngữ nghĩa khoá:
- `claim` là conditional atomic `PENDING -> IN_FLIGHT`; loser đọc lại state, không gọi Auth.
- `finish` ghi outcome tường minh, **không tự suy INDETERMINATE -> APPLIED**.
- `finalize_create` chỉ tạo app user khi token khớp; token sai -> `BLOCKED` (không bind/xoá), không raise rollback.
- `update_display_name` đồng bộ linked effective recruiter trong cùng transaction; không tìm recruiter theo email/tên, không đụng link lịch sử.
- `create_personnel` tạo recruiter + HRP membership (`vendor_id null`) + verified/effective link atomically; conflict personnel_code -> 23505, không auto-link; `display_name` server-side từ account.
- `reclassify`: PENDING/IN_FLIGHT >15 phút -> EXPIRED/INDETERMINATE; terminal >30 ngày purge PII + tombstone 60 ngày; create INDETERMINATE/BLOCKED/CONFLICT được giữ (không auto-purge).

## Files

- `supabase/migrations/20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql` (mới)
- `scripts/pre-w2-hf-d3-a-account-personnel-db.test.mjs` (mới, 14 test)
- `scripts/pre-w2-hf-d3-a-account-personnel-mutation.mjs` (mới, 5 probe)
- `package.json` (lane `test:pre-w2-hf-d3-a-account-personnel-db`)
- Rebaseline migration pins 91 -> 92 (47 file) + 3 sửa ngữ nghĩa: W03A action vocabulary (8->10), personnel-catalog function count (10->11), vendor-lifecycle git allowlist.

## Tests

DB lane 14 test: lifecycle, idempotent begin, hai create cùng login (chỉ 1 intent), finalize provenance (đúng/sai token), update name linked/unlinked + OCC, create personnel atomic + conflict rollback, disabled/already-linked/unknown account, cardinality 1:1, authority (Full Admin triple only), no password/hash, reclassify retention, self-check ACL/search_path/signature.

## Mutation probes (chạy tay) — 5/5 RED, khôi phục byte-for-byte

1. bỏ Full Admin guard; 2. claim không còn conditional; 3. không đồng bộ recruiter; 4. bỏ guard 1:1; 5. display_name từ browser.

## Gates

- `pnpm test:pre-w2-hf-d3-a-account-personnel-db` 14/14; W03A+worker-export 11/11; vendor-lifecycle+HF-C+HF-D2+report 37/37; personnel-catalog 18/18.
- `apply-migrations.mjs --offline` 92/92 (không DB access).
- `pnpm typecheck` exit 0; `pnpm lint` 0 error / 14 pre-existing warnings; `git diff --check` exit 0.

## Chưa làm / risks

- Không gọi Supabase Admin API (D3-B), không UI/API, không cron (retention qua RPC).
- Không apply migration Production/Vercel/VPS; không chạm DB VPS; không xoá/sửa dữ liệu nghiệp vụ.
- Risk: `auth.users.email` uniqueness (bên Auth) là guard thứ hai cho login trùng; D3-B phải đọc Auth user bằng Admin API để xác minh `app_metadata.account_intent=intent_token` trước khi gọi `finalize_create`.
