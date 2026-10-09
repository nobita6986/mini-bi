# Bàn giao T0-VPS — tách Demo Vercel và Production VPS

## 1. Mục tiêu và ranh giới

T0-VPS là một đầu việc hạ tầng độc lập với T0 sản phẩm hiện tại. T0-VPS chịu trách nhiệm:

1. Chuyển Vercel thành môi trường **Production Demo** tại `https://bi-demo.hrpartner.vn`; giữ nguyên Supabase/config hiện tại, chỉ đổi domain và các URL allowlist bắt buộc đi kèm domain.
2. Dựng môi trường **Production Publish** trên VPS tại tên miền chính xác do Owner cung cấp sau (`bi.hrp...` hiện chưa phải FQDN hoàn chỉnh).
3. Tách Supabase: Production Demo giữ project hiện tại; Production Publish dùng project/database/Auth keys/service-role key mới, độc lập.
4. Production Publish chỉ mang dữ liệu nhân sự HRP/Vendor, tài khoản, phân quyền, danh mục và dự án; không mang 19 hồ sơ người lao động hiện có.
5. Giữ **một codebase/một `main`** cho Vercel và VPS; khác biệt chức năng/cấu hình ứng dụng duy nhất tạm thời là hai Supabase project/DB khác nhau.
6. Đợt đầu, cả Vercel và VPS dùng nguyên đường upload trực tiếp R2 hiện tại; ý tưởng local upload + n8n được hoãn tới sau khi code ổn định.
7. Bàn giao lại runbook đủ để T0 sản phẩm tự deploy và rollback các bản vá tiếp theo trên VPS.

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
  -> R2 production hiện tại (thực tế chỉ dùng test, không có file nghiệp vụ)

<PRODUCTION_FQDN_DO_OWNER_XAC_NHAN>
  -> DNS + TLS
  -> reverse proxy trên VPS
  -> một Next.js Node/Docker instance
  -> Supabase Production Publish mới, độc lập
  -> upload trực tiếp R2 bằng contract/code hiện tại
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

### F2 — Vercel và VPS dùng cùng đường upload R2 hiện tại

Vercel Production Demo và Production Publish đều giữ đường upload hiện tại: browser nhận presigned URL và gửi thẳng lên R2. Vercel chỉ để test nên không dự kiến có file nghiệp vụ; VPS là nơi phát sinh file thật.

Invariant phát hành:

- Vercel và VPS lấy source từ cùng `main`, cùng commit SHA và cùng artifact/source contract.
- Không cherry-pick một storage implementation chỉ vào VPS, không giữ branch VPS dài hạn, không sửa trực tiếp code trên máy chủ.
- Ngoài khác biệt hạ tầng bắt buộc (domain/DNS/TLS và Vercel so với VPS runtime), khác biệt ứng dụng duy nhất là bộ biến Supabase trỏ tới hai project khác nhau.
- R2 account/bucket/credential, feature flags và các cấu hình nghiệp vụ khác phải có cùng effective value. Vercel tự cấp `VERCEL_ENV=production`; VPS đặt cùng giá trị để resolver hiện tại có hành vi tương đương.
- Đợt đầu không triển khai local-spool/n8n; VPS phải cấu hình đúng R2 contract hiện tại và document upload là acceptance bắt buộc.
- `resolveDocumentEnvironment()` hiện chỉ chọn Production khi `VERCEL_ENV=production`; VPS phải đặt biến tương thích này cùng `R2_BUCKET_NAME=hrp-bi-product` cho tới khi có refactor chung trên `main`. Không sửa source chỉ để đổi tên biến ở VPS.
- R2 CORS dùng exact origins cho cả Production Demo và Production Publish, không wildcard; credential chỉ tồn tại server-side.

Nếu Owner mở wave local-upload/n8n sau ổn định, implementation phải được phát triển trên một branch bình thường, review/merge vào `main`, rồi cả hai môi trường cùng deploy code đó. Một storage adapter chung có thể chọn backend bằng cấu hình, nhưng không được tách source.

Wave upload tương lai vẫn phải đáp ứng: thư mục persistent ngoài repo/web root; opaque name; MIME/magic/size validation; atomic write; provider/state/checksum trong DB; quota/free-space alert; authorized download; n8n idempotency/retry/dead-letter/retention; Owner tự kích hoạt workflow. Đây chỉ là deferred contract, không phải acceptance của lần deploy VPS đầu.

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
- Cấp R2 server credentials cho VPS theo quy trình secret, thêm exact CORS origin cho FQDN Publish và giữ origin Demo; không log giá trị. Local upload/n8n vẫn hoãn.
- Lập sanitized env-manifest diff: chỉ các biến Supabase/project-specific được phép khác; platform metadata và domain được ghi riêng, mọi feature flag/R2/business config phải tương đương.
- Chốt Production Demo còn cho phép ghi sau cutover hay chuyển read-only/hạn chế tài khoản.
- Cơ chế deploy mong muốn: Docker Compose hay Node/systemd, sau khi đối chiếu tài nguyên VPS.

## 6. Trình tự thực thi

### Wave VPS-0 — discovery chỉ đọc

1. Xác minh baseline Git, migration checksum, Vercel domains/deployment/env-name inventory và DNS hiện hành.
2. Kiểm kê **tên biến** môi trường, không xuất giá trị; lập allowlist biến được khác giữa hai môi trường. Hiện repo còn thiếu các biến R2 và một số feature flags trong `.env.example`, cần rebaseline tài liệu.
3. Kiểm kê Supabase source: version, extensions, cron/webhook/net jobs, Auth settings, user count, schema/migration ledger và backup availability bằng counts/booleans.
4. Kiểm kê VPS và chốt topology. Không mở port app trực tiếp ra Internet.
5. Viết kế hoạch cutover/rollback theo thời gian và trình Owner duyệt.

### Wave VPS-1 — portability và đóng gói

1. Tạo branch riêng từ baseline main mới nhất do T0 sản phẩm công bố tại lúc bắt đầu.
2. Không làm storage adapter/local upload/n8n trong wave này; dùng nguyên R2 adapter hiện tại và không tạo source delta chỉ dành cho VPS.
3. Tạo gói deploy đã chọn. Image/artifact phải gắn commit SHA; không deploy bằng `git pull` mù.
4. Reverse proxy phải giữ đúng `Host` và `X-Forwarded-Proto=https`, giới hạn request, có timeout phù hợp và không cache response riêng tư.
5. Chạy full source gates; không chạy browser UAT thay Owner.

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
3. Dựng service trên loopback/internal network; reverse proxy terminate TLS. Đặt effective `VERCEL_ENV=production` để dùng đúng R2 contract hiện tại.
4. Có health/status command, restart policy, disk/free-space/log monitoring và backup job.
5. Smoke server/API/auth/R2 config bằng host tạm hoặc override DNS nội bộ; xác minh VPS resolve Production bucket và CORS exact origin. Browser upload/UAT chờ Owner.

### Wave VPS-4 — đổi Vercel thành Production Demo

1. Gắn `bi-demo.hrpartner.vn` vào đúng Vercel project; lấy record chính xác từ `vercel domains inspect`, không hard-code CNAME. Hướng dẫn Vercel: https://vercel.com/docs/domains/set-up-custom-domain
2. Giữ nguyên Supabase hiện tại và các env khác theo quyết định Owner; inventory trước/sau phải chứng minh chỉ domain/URL allowlist liên quan thay đổi.
3. Cấu hình Auth Site URL/redirect URL cho domain Demo mới và cập nhật R2 CORS exact origin cho cả Demo/Publish.
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
- R2 bucket/CORS/config verification và quy trình rotate credential; local upload/n8n được ghi rõ là deferred.
- DNS provider/record/TTL hiện hành và rollback record.
- Artifact hoặc release registry, checksum và retention.
- Known limitations, alert contacts và lần rotate secret kế tiếp.

Sau handback, T0 sản phẩm giữ quyền release ứng dụng; T0-VPS chỉ còn vai trò hạ tầng theo yêu cầu. T0 sản phẩm phải có thể tự deploy/rollback bản vá mà không cần T0-VPS giữ phiên tương tác.

## 7. Acceptance gates

Tất cả phải PASS trước khi đóng bàn giao:

- Source SHA được ghi rõ; build artifact/image bất biến và có checksum.
- Vercel và VPS dùng cùng source commit; không tồn tại VPS-only source delta hoặc code sửa trực tiếp trên server.
- Sanitized env diff chỉ khác Supabase project/URL/keys/DB connection; domain/platform metadata được giải trình riêng; R2/feature flags/business config có cùng effective value.
- `pnpm test`, typecheck, lint, build, docs/secrets, migration offline pass trên commit deploy.
- Supabase Production Demo hiện tại và Production Publish mới có project refs/keys/DB endpoints khác nhau.
- Ledger target khớp source; 0 pending/mismatch sau apply có kiểm soát.
- Auth count/mapping/grants/scopes/project assignments đối chiếu bằng counts, không in danh tính.
- Source vẫn có đúng baseline NLĐ; target có 0 hồ sơ NLĐ/PII/document residue sau khi loại expected 19 roots.
- Đăng nhập/đổi mật khẩu/đăng xuất/session refresh đạt ở đúng environment.
- Vercel và VPS cùng dùng R2 adapter hiện tại; VPS resolve đúng `hrp-bi-product`, presigned upload/download đạt và CORS chỉ cho exact origins.
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
- Có VPS-only branch/source delta, code sửa trực tiếp trên server hoặc hai môi trường không truy vết được về cùng main commit.
- T0-VPS tự triển khai local upload/n8n trong wave đầu dù Owner đã hoãn.
- VPS không resolve đúng Production R2 bucket, thiếu server credential hoặc CORS không khớp exact Production Publish origin.
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

Không triển khai local upload/n8n trong wave dựng VPS đầu tiên. Cả Vercel và VPS
dùng nguyên R2 direct-upload code hiện tại; VPS phải cấu hình Production R2 và exact
CORS origin. Vercel và VPS dùng cùng main/source commit; không tạo branch code VPS
riêng hoặc sửa code trực tiếp trên server. Nếu làm local+n8n sau này, adapter chung
phải merge main rồi mới cấu hình backend khác nhau theo env.

Ngoài domain/DNS/TLS và runtime platform bắt buộc, khác biệt cấu hình ứng dụng duy
nhất tạm thời là Supabase project/URL/keys/DB connection. R2, feature flags và mọi
business config phải có cùng effective value; xuất sanitized env-diff làm evidence.

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
4) chứng minh single-source deployment và kế hoạch cấu hình current R2 upload trên
   VPS; ghi local-upload/n8n là deferred;
5) cutover/rollback timeline;
6) danh sách input/approval cần Owner;
7) handoff ngắn cho T0 sản phẩm để T0 này giữ khả năng deploy/rollback về sau.

Không claim PASS nếu chưa có backup/restore drill, tách DB thật, target worker
residue=0, single-source evidence, Owner UAT và rollback evidence. Không đưa upload
local/n8n vào claim của đợt đầu.
```
