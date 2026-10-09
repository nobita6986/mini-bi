# Bàn giao T0-VPS — tách Demo Vercel và Production VPS

## 1. Mục tiêu và ranh giới

T0-VPS là một đầu việc hạ tầng độc lập với T0 sản phẩm hiện tại. T0-VPS chịu trách nhiệm:

1. Chuyển Vercel thành môi trường **Production Demo** tại `https://bi-demo.hrpartner.vn`; giữ nguyên Supabase/config hiện tại, chỉ đổi domain và các URL allowlist bắt buộc đi kèm domain.
2. Dựng môi trường **Production Publish** trên VPS tại tên miền chính xác do Owner cung cấp sau (`bi.hrp...` hiện chưa phải FQDN hoàn chỉnh).
3. Tách Supabase: Production Demo giữ project hiện tại; Production Publish dùng project/database/Auth keys/service-role key mới, độc lập.
4. Production Publish chỉ mang dữ liệu nhân sự HRP/Vendor, tài khoản, phân quyền, danh mục và dự án; không mang 19 hồ sơ người lao động hiện có.
5. Production Publish nhận tài liệu vào thư mục riêng trên VPS; n8n sẽ chuyển tiếp lên R2 ở giai đoạn sau.
6. Bàn giao lại runbook đủ để T0 sản phẩm tự deploy và rollback các bản vá tiếp theo trên VPS.

T0-VPS **không** tự thay đổi nghiệp vụ/RBAC, không merge feature ngoài phạm vi portability/deployment, không chạy browser UAT và không quyết định thay Owner về dữ liệu thật. Mọi browser/UAT do Owner trực tiếp thực hiện.

## 2. Baseline đã khóa

| Hạng mục | Baseline |
| --- | --- |
| Source duy nhất | `origin/main@c0d72366212a587f949a56376f71284ed63d1099` |
| Migration source/Production hiện tại | 65 applied, 0 pending, 0 mismatch |
| Migration cuối | `20261009010000_p3_w07a_r3_vendor_hidden_team_and_document_upload.sql` |
| Vercel Production hiện tại | deployment `dpl_56Jwdm834WovEmc2mZpadmv323pB`, source `main@c0d7236`, alias `bi.hrpartner.vn`, READY |
| Framework/runtime | Next.js `16.3.8`, Node server qua `pnpm build` + `pnpm start` |
| Tài liệu nhạy cảm | Cloudflare R2; bucket contract: demo/preview `hrp-bi-preview`, Production `hrp-bi-product` |
| File truy cập VPS | `C:\vps-bi.txt`: 3 dòng gồm IPv4, SSH user và password; tuyệt đối không copy nội dung vào repo/chat/log |

Không log hoặc đưa vào handoff giá trị secret, PII, CCCD, email đăng nhập, database URL, storage key hay private key.

## 3. Kiến trúc đích

```text
bi-demo.hrpartner.vn
  -> Vercel Production Demo
  -> Supabase hiện tại (giữ nguyên theo quyết định Owner)
  -> R2/config hiện tại (giữ nguyên cho tới khi Owner duyệt tách storage)

<PRODUCTION_FQDN_DO_OWNER_XAC_NHAN>
  -> DNS + TLS
  -> reverse proxy trên VPS
  -> một Next.js Node/Docker instance
  -> Supabase Production Publish mới, độc lập
  -> thư mục upload riêng ngoài repo/web root
  -> n8n chuyển file sang R2 sau khi Owner kích hoạt
```

Không đổi DNS Production hiện tại trước khi VPS, Supabase Production Publish mới, backup và rollback đều đạt gate. “Production Demo” không phải sandbox công khai: do giữ database hiện tại, nó vẫn phải được bảo vệ như môi trường chứa dữ liệu thật.

## 4. Findings bắt buộc xử lý

### F1 — ứng dụng self-host được nhưng chưa có gói VPS

Repo đã có `build`/`start` cho Node server, nhưng chưa có Dockerfile, Compose, systemd, nginx/Caddy hay runbook deploy. Next.js hỗ trợ đầy đủ khi chạy Node hoặc Docker và khuyến nghị đặt reverse proxy trước server:

- https://nextjs.org/docs/app/getting-started/deploying
- https://nextjs.org/docs/app/guides/self-hosting

T0-VPS phải chọn **một** mô hình sau khi có thông số VPS:

- Khuyến nghị mặc định cho một VPS: Docker image cố định theo commit SHA + Compose + reverse proxy.
- Phương án nhẹ hơn khi Docker không phù hợp: Node LTS + pnpm + systemd + reverse proxy.

Không dùng static export vì ứng dụng có API routes, session và server runtime.

### F2 — Publish đổi từ browser-to-R2 sang VPS local spool

Vercel Production Demo giữ nguyên đường upload hiện tại: browser nhận presigned URL và gửi thẳng lên R2. Production Publish không dùng đường này; file được gửi tới API trên VPS và ghi vào một thư mục spool riêng, sau đó n8n chuyển sang R2 khi Owner kích hoạt.

Đây là thay đổi application/storage contract, không chỉ cấu hình hạ tầng. T0-VPS phải tạo adapter server-side fail-closed theo deployment tier, giữ nguyên adapter R2 của Vercel và thêm adapter local-spool cho Publish. Không dùng `VERCEL_ENV=production` để giả lập VPS.

Local upload bắt buộc:

- Thư mục nằm ngoài repo, `.next`, `public` và web root; mặc định đề xuất trên Linux là `/var/lib/hrp-bi/uploads`, nhưng T0-VPS chốt theo OS thực tế.
- Chỉ service account ứng dụng và account n8n được đọc/ghi theo least privilege; không public directory listing/static serving.
- Tên file trên đĩa là opaque ID, không dùng tên file gốc/CCCD/tên NLĐ; chống path traversal và symlink escape.
- Giữ validate size/MIME/magic bytes hiện tại; ghi vào temp file, `fsync` khi phù hợp rồi atomic rename trước khi DB đánh dấu `LOCAL_READY`.
- DB lưu provider/state/opaque key/checksum/size; không lưu absolute path ra response hoặc audit log.
- n8n xử lý idempotent theo document version + checksum: `LOCAL_READY -> TRANSFERRING -> R2_READY`; retry không tạo object/version trùng.
- Chỉ xóa local sau khi R2 HEAD/checksum xác nhận và qua retention window; lỗi chuyển giữ file và trạng thái retryable.
- Có disk quota/free-space alert, backup, cleanup cho file temp/orphan và stop-upload threshold trước khi đầy ổ.
- Download trước khi n8n chuyển phải đi qua API có authorization; sau khi `R2_READY` dùng adapter R2. UI không được biết storage backend.

T0-VPS phải viết rõ contract n8n (input directory/manifest, destination bucket/prefix, checksum, retry, dead-letter, retention), nhưng không kích hoạt workflow thay Owner. R2 đích cho Publish cần được chốt trước khi n8n bật; CORS chỉ cần nếu browser tương tác trực tiếp với R2 sau này: https://developers.cloudflare.com/r2/buckets/cors/

### F3 — Supabase project mới làm đổi biên Auth

`direct_entry_app_users.auth_subject` liên kết với Supabase Auth user. Chỉ tạo schema mới rồi tạo lại user thủ công có thể làm đổi UUID và phá mapping quyền.

T0-VPS phải chốt một kế hoạch migration Auth có kiểm chứng. Supabase hỗ trợ clone/restore sang project mới gồm dữ liệu Auth, nhưng API keys, Auth settings, redirect URLs và một số cấu hình vẫn phải cấu hình lại. Khi JWT secret khác, phiên hiện tại hết hiệu lực và người dùng phải đăng nhập lại:

- https://supabase.com/docs/guides/platform/clone-project
- https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects
- https://supabase.com/docs/guides/auth/redirect-urls

Đăng xuất toàn bộ phiên tại thời điểm cutover là hành vi chấp nhận được nếu Owner duyệt trước; không tự sao chép/reuse JWT secret chỉ để tránh đăng nhập lại.

### F4 — Owner đã chốt Production Demo giữ database hiện tại

Production Demo tại Vercel tiếp tục dùng Supabase hiện tại; không clone dữ liệu sang một Demo DB khác. Production Publish dùng Supabase mới. Trình tự:

1. Giữ nguyên Vercel + Supabase hiện tại trong lúc dựng song song.
2. Tạo Supabase Production Publish mới và chuyển dữ liệu/Auth theo kế hoạch đã duyệt.
3. Dựng và xác minh VPS, sau đó cutover domain Publish.
4. Đổi domain của Vercel sang `bi-demo.hrpartner.vn` mà không đổi project Supabase hiện tại.

Sau thời điểm tách, hai database sẽ phân kỳ. T0-VPS phải ghi timestamp/cutover point, không đồng bộ hai chiều và không để thao tác Demo ghi sang database Publish. Owner cần chốt Production Demo có tiếp tục cho phép ghi hay chuyển sang read-only/hạn chế tài khoản; đây là quyết định vận hành, không được tự suy diễn.

Việc Production Publish dùng project riêng phù hợp với hướng dẫn tách môi trường của Supabase: https://supabase.com/docs/guides/deployment/managing-environments

### F5 — Production Publish không mang 19 hồ sơ người lao động

Owner đã chốt: chỉ chuyển dữ liệu nền vận hành như nhân sự HRP/Vendor, tài khoản Auth/app-user, recruiter link, capability/scope, project-manager assignment, team/provider, dự án và các catalog cần thiết. Không chuyển 19 hồ sơ người lao động hiện có.

Nếu dùng clone/restore toàn database để bảo toàn Auth ID, việc loại dữ liệu NLĐ chỉ được thực hiện **trên Supabase Publish đích**, trong một transaction/script có review; tuyệt đối không xóa ở Supabase hiện tại của Vercel. `19` là expected count do Owner cung cấp, không phải lệnh xóa mù.

T0-VPS phải inventory dependency graph bắt đầu từ `direct_entry_candidates` và xử lý toàn bộ dữ liệu phụ thuộc của 19 hồ sơ: submission/entry payload, payment, employment-status events, document metadata/objects, revisions, change requests, restricted reasons, idempotency và audit records có PII hoặc resource reference tương ứng. Không được chỉ xóa 19 root rows rồi để lại PII hoặc orphan.

Gate sau purge trên target:

- source Vercel vẫn giữ nguyên count/checksum;
- target có `0` hồ sơ NLĐ và `0` worker-document metadata/object tham chiếu;
- target giữ đúng counts/mapping của HRP/Vendor accounts, recruiter links, grants/scopes, projects, assignments, teams/providers và catalog đã duyệt;
- mọi FK/invariant/preflight pass; không in PII trong evidence;
- purge script idempotent hoặc fail nếu expected source count không đúng 19.

## 5. Input T0-VPS phải nhận từ Owner

Không tiến hành mutation trước khi có đủ:

- FQDN Production chính xác; `bi.hrp...` chưa đủ để tạo DNS/TLS.
- `C:\vps-bi.txt` đã cung cấp IPv4/SSH user/password; T0-VPS đọc trực tiếp, không echo nội dung. Sau lần vào đầu phải kiểm tra host-key fingerprint, chuyển sang SSH key nếu khả thi và xin Owner duyệt rotate password.
- Nhà cung cấp VPS, OS/version, CPU/RAM/disk, vùng đặt máy vẫn phải inventory read-only từ máy hoặc nhận thêm từ Owner.
- SSH port, chính sách `sudo`, firewall hiện hữu.
- DNS provider và quyền quản trị record; TTL hiện tại của các record liên quan.
- Supabase Production Demo là project hiện tại; cần organization/region/plan cho Production Publish và xác nhận dùng clone/physical backup hay logical migration.
- Owner đã chốt loại 19 hồ sơ NLĐ khỏi target; còn cần T0-VPS lập allowlist bảng/dữ liệu nền được giữ và trình review trước purge.
- RPO/RTO, backup retention và nơi giữ bản backup mã hóa.
- Chốt đường dẫn local upload, dung lượng/quota/retention, backup và service account n8n; chốt R2 đích/prefix cho workflow sau. Owner thao tác secret và tự kích hoạt n8n.
- Chốt Production Demo còn cho phép ghi sau cutover hay chuyển read-only/hạn chế tài khoản.
- Cơ chế deploy mong muốn: Docker Compose hay Node/systemd, sau khi đối chiếu tài nguyên VPS.

## 6. Trình tự thực thi

### Wave VPS-0 — discovery chỉ đọc

1. Xác minh baseline Git, migration checksum, Vercel domains/deployment/env-name inventory và DNS hiện hành.
2. Kiểm kê **tên biến** môi trường, không xuất giá trị; hiện repo còn thiếu các biến R2 và một số feature flags trong `.env.example`, cần rebaseline tài liệu.
3. Kiểm kê Supabase source: version, extensions, cron/webhook/net jobs, Auth settings, user count, schema/migration ledger và backup availability bằng counts/booleans.
4. Kiểm kê VPS và chốt topology. Không mở port app trực tiếp ra Internet.
5. Viết kế hoạch cutover/rollback theo thời gian và trình Owner duyệt.

### Wave VPS-1 — portability và đóng gói

1. Tạo branch riêng từ baseline main mới nhất do T0 sản phẩm công bố tại lúc bắt đầu.
2. Thêm deployment-tier/storage adapter: Vercel giữ R2 direct, VPS dùng local spool; cập nhật `.env.example` chỉ với placeholder.
3. Thêm schema/state machine và API upload/download server-side cần thiết; không trả filesystem path ra client.
4. Tạo gói deploy đã chọn. Image/artifact phải gắn commit SHA; không deploy bằng `git pull` mù.
5. Reverse proxy phải giữ đúng `Host` và `X-Forwarded-Proto=https`, giới hạn request body phù hợp ceiling tài liệu, có timeout phù hợp và không cache response riêng tư.
6. Chạy full source gates; không chạy browser UAT thay Owner.

### Wave VPS-2 — Supabase Production Publish mới

1. Tạo project mới ở region đã duyệt.
2. Tạo backup nguồn có timestamp/checksum và kiểm chứng restore trên target.
3. Chọn clone/restore hoặc logical migration theo plan; kiểm soát external jobs để tránh chạy hai lần.
4. Bảo toàn Auth user IDs hoặc cung cấp mapping có kiểm toán; xác minh `auth_subject` không orphan.
5. Chạy target-only purge đã review: expected 19 hồ sơ NLĐ, toàn bộ dữ liệu phụ thuộc và PII worker-domain về 0; source không đổi.
6. Cấu hình lại Auth Site URL/redirect URLs bằng FQDN Production chính xác; dùng exact production URL.
7. Cấu hình lại API keys và server secrets trên VPS; không copy service-role key giữa projects.
8. Chứng minh ledger đúng source hiện hành, dữ liệu nền allowlist đủ và mọi preflight nghiệp vụ đều xanh.

### Wave VPS-3 — dựng VPS song song

1. Harden OS tối thiểu: cập nhật bảo mật, SSH key-only nếu khả thi, firewall chỉ mở SSH/80/443, time sync, log rotation.
2. Cài runtime/container engine đã chốt; đặt env file ngoài repo, mode/owner tối thiểu.
3. Dựng service trên loopback/internal network; reverse proxy terminate TLS.
4. Mount thư mục upload persistent ngoài release, cấp quyền tối thiểu cho app/n8n; release/rollback không xóa file.
5. Có health/status command, restart policy, disk/free-space/log monitoring và backup job.
6. Smoke server/API/auth/local upload/download bằng host tạm hoặc override DNS nội bộ. Browser UAT chờ Owner.
7. Chuẩn bị n8n transfer contract và dry-run bằng file giả; không kích hoạt workflow Production thay Owner.

### Wave VPS-4 — đổi Vercel thành Production Demo

1. Gắn `bi-demo.hrpartner.vn` vào đúng Vercel project; lấy record chính xác từ `vercel domains inspect`, không hard-code CNAME. Hướng dẫn Vercel: https://vercel.com/docs/domains/set-up-custom-domain
2. Giữ nguyên Supabase hiện tại và các env khác theo quyết định Owner; inventory trước/sau phải chứng minh chỉ domain/URL allowlist liên quan thay đổi.
3. Cấu hình Auth Site URL/redirect URL cho domain Demo mới và cập nhật R2 CORS origin nếu cần.
4. Chứng minh Vercel không kết nối Supabase Production Publish mới.
5. Chỉ Owner thực hiện browser/UAT Demo.

### Wave VPS-5 — Production cutover

1. Freeze ghi trong maintenance window nếu migration dữ liệu yêu cầu.
2. Chụp backup cuối, đồng bộ dữ liệu nền cho phép, chạy target-only worker purge và preflight/read-only reconciliation.
3. Xác minh TLS/health VPS trước bằng host override hoặc tên tạm.
4. Hạ TTL có kiểm soát, đổi DNS Production sang VPS, theo dõi cả old/new endpoint trong thời gian lan truyền.
5. Owner chạy browser/UAT Production; T0-VPS chỉ hỗ trợ log/status không chứa PII.
6. Nếu gate lỗi, rollback DNS và service về deployment/source cũ; không sửa dữ liệu tại chỗ theo kiểu ad-hoc.

### Wave VPS-6 — handback cho T0 sản phẩm

T0-VPS bàn giao các mục dưới đây, không kèm secret value:

- FQDN/IP/SSH alias và host-key fingerprint đã xác minh.
- OS/runtime versions; repo/release path.
- Tên service/container/Compose project và reverse-proxy config path.
- Env file/secret-store path, owner/mode và danh sách tên biến.
- Lệnh deploy theo exact SHA, health/status/log và rollback.
- Quy trình backup/restore và kết quả restore drill gần nhất.
- Supabase project reference **đã che phần nhạy cảm nếu cần**, migration procedure và ledger query.
- Local upload path, mount/owner/mode/quota/free-space threshold, backup/restore và orphan cleanup procedure.
- n8n contract: service account, state transitions, checksum/idempotency, R2 destination, retry/dead-letter/retention; không bàn giao secret value.
- DNS provider/record/TTL hiện hành và rollback record.
- Artifact hoặc release registry, checksum và retention.
- Known limitations, alert contacts và lần rotate secret kế tiếp.

Sau handback, T0 sản phẩm giữ quyền release ứng dụng; T0-VPS chỉ còn vai trò hạ tầng theo yêu cầu. T0 sản phẩm phải có thể tự deploy/rollback bản vá mà không cần T0-VPS giữ phiên tương tác.

## 7. Acceptance gates

Tất cả phải PASS trước khi đóng bàn giao:

- Source SHA được ghi rõ; build artifact/image bất biến và có checksum.
- `pnpm test`, typecheck, lint, build, docs/secrets, migration offline pass trên commit deploy.
- Supabase Production Demo hiện tại và Production Publish mới có project refs/keys/DB endpoints khác nhau.
- Ledger target khớp source; 0 pending/mismatch sau apply có kiểm soát.
- Auth count/mapping/grants/scopes/project assignments đối chiếu bằng counts, không in danh tính.
- Source vẫn có đúng baseline NLĐ; target có 0 hồ sơ NLĐ/PII/document residue sau khi loại expected 19 roots.
- Đăng nhập/đổi mật khẩu/đăng xuất/session refresh đạt ở đúng environment.
- Vercel R2 upload không đổi; VPS local upload/download đạt, opaque path không lộ, restart/redeploy không mất file.
- n8n dry-run chứng minh checksum/idempotency/retry/retention; workflow thật chỉ Owner kích hoạt.
- Production Demo không thể ghi vào Supabase Production Publish; chính sách writable/read-only của Demo được ghi rõ.
- VPS port app không public; HTTPS hợp lệ; reverse proxy truyền đúng scheme/host.
- Restart service không mất cấu hình; reboot VPS tự phục hồi service.
- Backup có checksum và restore drill đạt trên nơi disposable.
- Rollback app và DNS được diễn tập hoặc dry-run có bằng chứng.
- Owner xác nhận browser/UAT riêng cho Demo và Production.

## 8. Stop conditions

T0-VPS dừng và báo Owner/T0 sản phẩm nếu gặp một trong các điều kiện:

- Chưa có FQDN Production chính xác hoặc quyền DNS.
- Chưa có Supabase Production riêng; Vercel và VPS vẫn trỏ cùng project.
- Production Demo và Publish vô tình dùng chung Supabase project/key/DB endpoint.
- Auth migration làm đổi `auth_subject` nhưng chưa có mapping/reconciliation.
- Target purge thấy source count khác 19, còn worker PII/residue, hoặc làm giảm dữ liệu nền ngoài allowlist.
- Chưa có backup đã kiểm chứng hoặc chưa có rollback.
- Thư mục upload nằm trong repo/web root, lộ path/tên thật, thiếu quota/backup hoặc không persistent qua deploy.
- n8n không có checksum/idempotency/state/retry contract hoặc cần T0-VPS tự kích hoạt thay Owner.
- Migration ledger/checksum mismatch.
- Cần in/copy secret qua chat, commit hoặc log.

## 9. Continuity của lộ trình sản phẩm hiện tại

Đầu việc VPS không thay đổi thứ tự lộ trình đang chạy:

1. Chờ báo cáo các lane T1 closure hiện tại.
2. T0 sản phẩm review và chỉ tích hợp source delta cần thiết.
3. Owner tự chạy browser/UAT; không giao T1.
4. T0 sản phẩm khóa combined closure cho P2/P2.5/P3 hiện tại.
5. Chỉ sau closure mới bắt đầu P3.1-C01.

T0-VPS không dùng các branch T1 đang chạy làm base. Mỗi wave hạ tầng phải lấy SHA main mới do T0 sản phẩm công bố.

## 10. Prompt khởi tạo cho T0-VPS

```text
Bạn là T0-VPS, độc lập với T0 sản phẩm. Mục tiêu là đổi Vercel thành Production
Demo tại bi-demo.hrpartner.vn, giữ nguyên Supabase hiện tại, và dựng Production
Publish trên VPS với một Supabase project mới, độc lập.

Production Publish chỉ giữ dữ liệu nền HRP/Vendor/account/quyền/dự án/danh mục;
không mang 19 hồ sơ người lao động. Nếu clone để bảo toàn Auth ID, chỉ purge trên
target bằng script transaction có expected-count=19 và dependency/PII residue checks;
không mutation Supabase Vercel.

VPS nhận tài liệu vào local persistent spool ngoài repo/web root. T0-VPS thiết kế
adapter, state machine và contract n8n idempotent để Owner tự kích hoạt chuyển R2
sau; không tự bật workflow n8n.

Trước hết chỉ thực hiện Wave VPS-0 discovery/read-only theo tài liệu:
docs/handoffs/t0-vps-environment-split-and-production-deployment.md

Baseline tham khảo hiện tại: origin/main@c0d72366212a587f949a56376f71284ed63d1099,
nhưng trước khi làm phải fetch và yêu cầu T0 sản phẩm xác nhận SHA main mới làm base.

Không mutation DNS/Vercel/Supabase/VPS, không deploy, không apply migration và không
in secret/PII/storage key trong Wave VPS-0. Không chạy browser/UAT; Owner tự thực hiện.
Không dùng branch T1 đang chạy. Không tự điền Production FQDN khi Owner mới ghi
"bi.hrp...". File C:\vps-bi.txt chứa IPv4/SSH user/password; đọc trực tiếp nhưng
không echo/copy nội dung. Phải báo rõ input còn thiếu.

Đầu ra Wave VPS-0:
1) inventory counts/booleans và tên cấu hình không có secret;
2) topology được đề xuất theo thông số VPS;
3) kế hoạch migration sang Supabase Production Publish bảo toàn auth_subject và
   target-only purge đúng 19 hồ sơ NLĐ cùng toàn bộ dependent PII;
4) thiết kế local upload spool + adapter + n8n-to-R2 contract;
5) cutover/rollback timeline;
6) danh sách input/approval cần Owner;
7) handoff ngắn cho T0 sản phẩm để T0 này giữ khả năng deploy/rollback về sau.

Không claim PASS nếu chưa có backup/restore drill, tách DB thật, target worker
residue=0, local upload persistence/quota, n8n dry-run, Owner UAT và rollback evidence.
```
