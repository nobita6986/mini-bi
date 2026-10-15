# BG-P0 — Baseline hiện trạng Blue–Green

> **Trạng thái:** CHƯA ĐÓNG — đã khảo sát GitHub, DNS và repo; chưa có bằng chứng inventory trực tiếp từ hai VPS hoặc truy vấn ledger DB.
> **Ngày khảo sát:** 14/10/2026 (Asia/Bangkok)
> **Phạm vi:** Chỉ khảo sát/đọc. Không deploy, SSH vào VPS, truy vấn DB, chạy migration/restore, đổi DNS/Cloudflare, hoặc sửa GitHub Actions.

## Kết luận điều hành

Owner xác nhận VPS1 đang phục vụ Production với Supabase project `kiamyvfymxdattohfwmt` ở migration #85; Vercel đang dùng DB test `uedvduecuqhaujfwvhkn` ở #91; VPS2 mới cài nền tảng và chờ release. Main hiện có đúng 91 migration file theo inventory repo tại SHA `68a555d359c2fe52436daba4cafba645e29c80d6`, và CI của SHA đó xanh.

Đây là hai project DB khác nhau, vì vậy trạng thái hiện tại **chưa phải Blue–Green dùng chung một Production DB**. VPS2 workflow trên `main` vẫn yêu cầu DB khác VPS1 và build image riêng `-vps2`; không được dùng workflow đó để deploy code Production theo thiết kế Blue–Green. Nếu Production thực sự ở #85, deploy image từ main hiện tại dự kiến sẽ dừng ở migration preflight khi phát hiện migration còn thiếu; deploy thường không tự áp dụng migration.

P0 **chưa thể đánh dấu DONE**: VPS1/VPS2 inventory, runtime project refs, ledger DB trực tiếp, Caddy/TLS/health và worker ownership chưa được xác minh trực tiếp. Owner xác nhận Supabase Pro có backup hằng ngày; thời điểm recovery point thực tế cần được kiểm tra trước một lần apply migration, nhưng backup/R2 restore drill không phải điều kiện để chốt thiết kế Blue–Green P0. Không có restore hoặc thay đổi hệ thống nào trong lượt này.

## Baseline đã ghi nhận

| Hạng mục | Hiện trạng | Nguồn / mức xác minh |
|---|---|---|
| VPS1 | Owner xác nhận đang chạy Production | Owner cung cấp; runtime chưa SSH kiểm tra |
| DB VPS1 / Production | `kiamyvfymxdattohfwmt`, ledger #85 | Owner cung cấp; chưa query trực tiếp |
| DB Vercel / test | `uedvduecuqhaujfwvhkn`, ledger #91 | Owner cung cấp; chưa query trực tiếp |
| VPS2 | Owner xác nhận cài cơ bản, chờ bản Main | Owner cung cấp; Docker/Caddy/container chưa inventory |
| Main Git SHA | `68a555d359c2fe52436daba4cafba645e29c80d6`, commit ngày 14/10/2026 20:47:43 ICT | Đọc từ remote `main` bằng Git, E-002 |
| Main CI | CI success cho SHA trên lúc 20:47:47 ICT | GitHub Actions, E-003 |
| Migration source | 91 file SQL trong `supabase/migrations` ở SHA trên | Đếm từ Git tree, E-002; không thay thế việc đọc ledger DB |
| DNS `bi.hrpartner.vn` | A lookup trả `103.77.209.20` | DNS resolver tại máy khảo sát, E-005; chưa xác minh origin/proxy/TLS |
| DNS `bi.hrpvietnam.vn` | A lookup trả `103.72.57.240`; Owner xác nhận đây là IP VPS2 | DNS resolver + Owner, E-005/E-007; Caddy/TLS/app route vẫn chưa kiểm tra |
| Supabase backup | Owner xác nhận đã nâng Pro và project có backup tự động hằng ngày; R2 mỗi 6 giờ là tùy chọn bổ sung | Owner, E-007; chưa xem timestamp recovery point thực tế hoặc diễn tập restore. Supabase ghi nhận backup hằng ngày và retention Pro 7 ngày trong [Database Backups](https://supabase.com/docs/guides/platform/backups) |

## Luồng Blue–Green 2 VPS đề xuất (chưa triển khai)

Blue–Green ở đây chỉ luân phiên **app servers**; hai VPS Production cùng dùng một Supabase Production DB. DB không được clone/restore hoặc đổi qua lại khi cutover. Mỗi migration tác động ngay tới cả phiên bản cũ lẫn mới đang kết nối DB, vì vậy tương thích ngược là điều kiện bắt buộc để giữ được đường failback.

| Vai trò | Hiện tại | Hostname |
|---|---|---|
| Blue / active | VPS1, đang phục vụ người dùng | `bi.hrpartner.vn` |
| Green / inactive candidate | VPS2, IP được Owner xác nhận là `103.72.57.240` | `bi.hrpvietnam.vn` dùng cho UAT; route/Caddy/TLS chưa xác minh |

Luồng mỗi release:

1. Chờ các hotfix đang làm kết thúc; đóng băng một SHA cụ thể trên `main`, migration inventory/checksum và CI xanh. Không dùng “main mới nhất” thay cho SHA đã được review trong cùng release.
2. Tạo môi trường DB rehearsal độc lập từ Production gần thời điểm release (Supabase Pro [“Restore to a new project”](https://supabase.com/docs/guides/platform/clone-project), nếu project có physical backups); cô lập cron/webhook/extension side effects. Chạy đúng migration và UAT trên bản clone, không dùng Production DB để UAT có ghi dữ liệu.
3. Trên Production chỉ chạy preflight đọc: project ref phải khớp `kiamyvfymxdattohfwmt`, đọc ledger/checksum và liệt kê chính xác migration còn thiếu. Nếu checksum lệch, target sai hoặc có migration ngoài release thì dừng.
4. Migration cần một workflow riêng, manual, có Owner approval, CI xanh, SHA cố định, xác nhận recovery point, kiểm tra project ref fail-closed và concurrency chung với deploy. Apply migration là bước độc lập; workflow deploy app không tự apply SQL. Main tại SHA khảo sát chưa có migration workflow. File `migrate-vps.yml` có trong HEAD của nhánh khảo sát nhưng không có trong remote Main; không được coi là workflow đã có trên Main.
5. Apply migration đã rehearsal vào DB Production. Runner hiện có áp dụng theo thứ tự filename, mỗi file trong transaction riêng và ghi ledger cùng transaction; nếu file giữa chừng lỗi, các file trước đã commit vẫn giữ nguyên. Dừng, kiểm tra ledger và xử lý forward-only; không restore DB để “rollback” một release app.
6. Chỉ sau khi ledger/checksum khớp, build/pin image cùng SHA với cấu hình Production, deploy lên VPS2. Trước cutover, `bi.hrpvietnam.vn` chỉ cho phép smoke/UAT đọc; không chạy thao tác nghiệp vụ ghi lên DB thật. Cấu hình public Supabase hiện được truyền vào build, nên image dùng DB clone và image Production có thể có digest khác dù cùng source SHA.
7. Owner chuyển A record `bi.hrpartner.vn` sang VPS2. Giảm TTL trước cửa sổ cutover; giữ VPS1 phục vụ trong thời gian DNS cache còn hiệu lực và giữ cả hai server chạy. Sau khi ổn định, đổi `bi.hrpvietnam.vn` sang VPS inactive để chuẩn bị release kế tiếp. Với DNS thủ công, chuyển/failback không tức thời do cache resolver.
8. Failback ứng dụng bằng cách trỏ hostname về VPS1 chạy SHA cũ, chỉ khi code cũ tương thích với schema và function behavior mới. Không tự hạ migration hay restore Production DB. Nếu không chứng minh được tương thích ngược, phải chia migration thành expand/contract và có bridge release trước khi chuyển traffic.

Điều kiện kỹ thuật trước lần cutover đầu: cả hai host cần route Caddy/TLS cho hostname mà chúng sẽ nhận sau khi đảo vai; candidate health check phải xác nhận readiness/auth/DB project ref chứ không chỉ HTTP 200 của `/login`; job/worker chạy nền nếu có phải có đúng một owner để tránh chạy kép. Các điều kiện này chưa được kiểm tra live.

## Cập nhật ngày 15/10/2026

- Git `main` hiện ở `ad61abc1b44195d35a4d22280a1af350114802e9` và có 95 migration file trong source tree; CI của SHA này thành công.
- Owner báo đã apply riêng migration #95 lên Vercel staging `myrwlwfddqevstpxlhoh`, ledger/checksum sau apply khớp. Đây là thông tin Owner cung cấp, không phải truy vấn DB trực tiếp trong lần cập nhật này.
- Các mốc VPS1 Production #85 và Vercel test #91 trong baseline phía trên là dữ liệu được ghi nhận ngày 14/10, không được hiểu là ledger hiện tại của staging.

## Findings

### F-001 — DB/schema đang lệch với source Main

- **Mức độ:** high / release no-go cho code có migration dependency
- **Trạng thái:** candidate; dựa trên ledger do Owner cung cấp và source repo đã đọc, chưa query DB
- **Evidence:** E-001, E-002, E-004
- **Finding:** Production được báo ở #85 trong khi Main tại SHA khảo sát có 91 migration file; nếu ledger liên tục đúng như số thứ tự thì dự kiến còn #86–#91, nhưng đây chưa phải kết quả query. Số pending/checksum thực tế phải lấy từ ledger read-only; hotfix còn đang làm có thể khiến target release mới hơn #91.
- **Tác động:** Không được trỏ bản app mới sang Production trước khi kiểm tra thứ tự migration, tương thích code cũ/mới và kế hoạch áp dụng migration được Owner duyệt.
- **Bằng chứng từ code:** `deploy/vps/bi-release` trong Main chạy migration image ở chế độ `--dry-run` và dừng nếu có `PENDING` hoặc `CHECKSUM MISMATCH`; wrapper này không apply migration.

### F-002 — Workflow VPS2 hiện chưa theo mô hình Blue–Green dùng chung Production DB

- **Mức độ:** high / no-go cho deploy VPS2 như Production Green
- **Trạng thái:** validated từ source workflow; runtime variables/secrets vẫn không đọc
- **Evidence:** E-004
- **Finding:** `.github/workflows/deploy-vps2.yml` trên Main dùng `VPS2_NEXT_PUBLIC_SUPABASE_URL`, bắt buộc project VPS2 khác project VPS1 và tạo image tag `-vps2`. Điều này phù hợp hai môi trường DB riêng, nhưng không phù hợp một release/image cùng Supabase Production cho hai origin.
- **Tác động:** VPS2 có thể được build để trỏ DB test khác Production. Trước khi biến VPS2 thành origin Production, phải sửa thiết kế workflow có kiểm tra fail-closed và Owner xác nhận đúng Production project. Không sửa trong P0.

### F-003 — Main không có workflow migration production riêng

- **Mức độ:** high / quy trình migration chưa khép kín trên Main
- **Trạng thái:** validated từ Git tree của Main
- **Evidence:** E-004
- **Finding:** Main chứa `ci.yml`, `db-backup.yml`, `deploy-vps.yml`, `deploy-vps2.yml`; không có `migrate-vps.yml` hay `db-migrate-production.yml`. Có `deploy/vps/bi-migrate` trong repo, nhưng workflow Main hiện không cung cấp bước operator áp dụng migration riêng. `migrate-vps.yml` có trong HEAD của nhánh khảo sát nhưng không có ở remote Main.
- **Tác động:** Không coi mô tả trong README hoặc workflow local là quy trình đã có trên GitHub Main. Cần thiết kế/duyệt migration gate riêng trước release cần schema mới.

### F-004 — Cơ chế deploy Main hiện là in-place, chưa có hai slot Blue/Green

- **Mức độ:** high / chưa đáp ứng rollback bằng traffic switch
- **Trạng thái:** validated từ source Main; trạng thái live chưa kiểm tra
- **Evidence:** E-004
- **Finding:** Compose Main chỉ có service/container `bi-app`. `deploy-production.sh` thay image rồi chạy `docker compose up -d --wait --remove-orphans`; nếu health fail thì wrapper khôi phục digest cũ. Đây là in-place deployment có image rollback, không phải chạy song song hai slot và chuyển router sau khi UAT.
- **Tác động:** Chưa có bằng chứng rằng bản cũ vẫn nhận traffic độc lập sau khi bản mới chạy; không gọi đây là Blue–Green.

### F-005 — Readiness hiện tại chưa xác nhận DB/auth sẵn sàng

- **Mức độ:** medium / cần trước khi dùng làm router health check
- **Trạng thái:** validated từ source Main
- **Evidence:** E-004
- **Finding:** Healthcheck Compose chỉ gọi `/login` và coi mọi status `<500` là khỏe. Trang login trả 200 không chứng minh DB/Auth sẵn sàng. Caddy snippet trong Main chỉ khai báo `bi.hrpartner.vn`, chưa có `bi.hrpvietnam.vn`.
- **Tác động:** Chưa dùng probe hiện tại làm tiêu chí cho phép router chuyển traffic hoặc failover.

### F-006 — Recovery point cần xác nhận trước migration; R2 6 giờ không phải điều kiện Blue–Green

- **Mức độ:** low / preflight cho release cần xác nhận recovery point
- **Trạng thái:** Owner xác nhận Pro + backup tự động hằng ngày; timestamp/khả năng khôi phục chưa kiểm tra
- **Evidence:** E-003, E-004, E-007
- **Finding:** Owner xác nhận Supabase Pro đang tạo backup hằng ngày. Workflow GitHub/R2 mỗi 6 giờ là phương án bổ sung tự chọn, không phải thành phần của Blue–Green. Backup và traffic cutover là hai cơ chế khác nhau; không cần R2 6 giờ để thiết kế luân phiên VPS.
- **Tác động:** Trước khi apply migration, Owner/operator vẫn cần xác nhận recovery point thực tế mới nhất và retention. Backup không thay thế rehearsal; restore Production không phải rollback thông thường vì có thể làm mất giao dịch ghi sau mốc backup. Khả năng restore chưa được diễn tập trong P0.

### F-007 — VPS2 IP đã được Owner xác nhận; app route và TLS vẫn chưa được kiểm tra

- **Mức độ:** medium / UAT hostname cần được khóa và kiểm tra trước khi dùng
- **Trạng thái:** DNS answer validated; Owner xác nhận `103.72.57.240` là VPS2; Caddy, certificate và app health UNVERIFIED
- **Evidence:** E-005, E-007
- **Finding:** `bi.hrpartner.vn` phân giải `103.77.209.20`; `bi.hrpvietnam.vn` phân giải `103.72.57.240` và Owner xác nhận IP thứ hai là VPS2. Chưa xác minh Caddy/TLS/app route trên VPS2. Caddy snippet trong Main chỉ có `bi.hrpartner.vn`; hostname phụ cần route hợp lệ trên VPS2, và cả hai hostname cần được cấu hình trên host inactive sau khi đảo vai.
- **Tác động:** Chưa coi `bi.hrpvietnam.vn` là UAT endpoint sẵn sàng. Trước khi đưa lên Production DB, giới hạn người truy cập và chỉ smoke đọc; không cho UAT nghiệp vụ ghi vào DB thật.

### F-008 — Live inventory chưa hoàn tất vì không có SSH host key đã xác minh

- **Mức độ:** high / P0 chưa thể đóng
- **Trạng thái:** validated về tình trạng truy cập của phiên khảo sát
- **Evidence:** E-006
- **Finding:** `C:\vps-bi.txt` không hiện diện tại đường dẫn được chỉ định. File `C:\vps2-bi.txt` có thông tin nhạy cảm nhưng không có known-hosts pin dùng được tại máy khảo sát; SSH agent không báo identity dùng được. Vì chưa xác minh danh tính host, em không mở phiên SSH và không đọc runtime env.
- **Tác động:** Hostname/OS, Docker/Caddy, image đang chạy, tài nguyên/ổ đĩa, runtime Supabase ref, feature flags và trạng thái n8n trên VPS1/VPS2 đều chưa được xác nhận trực tiếp. Không có secret nào được in vào báo cáo.

### F-009 — Migration command chưa fail-closed theo Production project ref

- **Mức độ:** high / không chạy apply cho tới khi có kiểm tra target bắt buộc
- **Trạng thái:** validated từ source remote Main
- **Evidence:** E-004
- **Finding:** Migration config được đọc từ `/etc/bi/migration.env`; runner ghi log project ref rút gọn nhưng không so sánh với ref Production mong đợi. Wrapper `bi-migrate` thực thi runner ở chế độ apply trước, sau đó mới gọi dry-run. Một lần gọi nhầm `bi-migrate` không phải kiểm tra thử — nó bắt đầu ghi migration ngay.
- **Tác động:** Trước khi có workflow Main dùng đúng SHA, phải có preflight đọc-only, assert ref chính xác `kiamyvfymxdattohfwmt` trước lệnh apply, approval Owner và log rõ danh sách migration/checksum dự kiến. Không chạy wrapper hiện tại như một probe.

## Path đóng BG-P0

### P-001 — Hoàn thiện baseline mà không tác động hệ thống thật

1. Đã ghi nhận dữ kiện Owner cung cấp và khóa scope ở chế độ read-only — E-001.
2. Đã chốt baseline source Main, migration inventory, workflow và CI — E-002, E-003, E-004.
3. Đã quan sát DNS A records — E-005; Owner xác nhận `103.72.57.240` là VPS2 — E-007. App route/origin/TLS vẫn cần inventory.
4. Cần có đường SSH với host key được xác minh cho cả hai VPS, sau đó chỉ chạy inventory lệnh đọc; không đọc/ghi nội dung secret env — E-006.
5. Cần xác minh DB project ref và ledger/checksum bằng phương thức chỉ đọc; không chạy migration trong P0. Recovery point được xác nhận riêng ngay trước lần migration đầu tiên; R2 backup 6 giờ là lựa chọn bổ sung, không phải điều kiện của Blue–Green.
6. Khả năng restore backup chỉ xác nhận trong một drill riêng trên DB cô lập, theo phase và approval phù hợp; không restore lên DB Production.

**Điều kiện đóng P0:** Owner xác nhận inventory live; project refs và ledger được đối chiếu an toàn; xác định active origin, DNS/proxy/Caddy/TLS và worker/job owner; ghi rõ các bất nhất/no-go và chốt luồng traffic Blue–Green. Tới khi đạt các điều kiện đó, P0 giữ trạng thái CHƯA ĐÓNG. Xác nhận recovery point và rehearsal migration là gate của một release tương lai, không phải thao tác trong P0.

## Evidence

### E-001 — Dữ kiện baseline do Owner cung cấp

- **Observed:** 14/10/2026
- **Source:** hội thoại Owner
- **Raw excerpt:** VPS1 Production DB `kiamyvfymxdattohfwmt` ở #85; Vercel test DB `uedvduecuqhaujfwvhkn` ở #91; Main đã merge các hotfix; VPS1 đang phục vụ; VPS2 cài cơ bản; backup Production lên R2 mỗi 6 giờ.
- **Limit:** Chưa đối chiếu trực tiếp bằng SSH, GitHub secret hoặc SQL ledger.
- **Update:** Owner bổ sung trạng thái Supabase Pro/daily backup, xác nhận VPS2 IP và làm rõ R2 6 giờ là tùy chọn — E-007.

### E-002 — Main SHA và migration source inventory

- **Observed:** 14/10/2026 20:47 ICT
- **Source:** Git remote `origin`, ref `main`
- **Repro:** `git ls-remote origin refs/heads/main`; sau khi fetch ref vào `FETCH_HEAD`: `git ls-tree -r --name-only FETCH_HEAD supabase/migrations`
- **Raw excerpt:** Main SHA `68a555d359c2fe52436daba4cafba645e29c80d6`; 91 file `.sql` trong `supabase/migrations`.
- **Limit:** Số file repo không thay thế kết quả truy vấn migration ledger DB.

### E-003 — CI/backup/deploy run history

- **Observed:** 14/10/2026 21:09 ICT
- **Source:** GitHub Actions metadata qua GitHub CLI đã xác thực
- **Repro:** `gh run list --repo nobita6986/mini-bi --workflow "Backup Supabase DB to R2" --limit 12 --json event,conclusion,createdAt,headSha`
- **Raw excerpt:** CI success cho Main SHA lúc 20:47 ICT; các scheduled backup gần nhất trong kết quả đều success; VPS1 có recorded success gần nhất 13/10 00:55 ICT; không có run được liệt kê cho workflow VPS2.
- **Limit:** Run success không chứng minh app/DB nào đang live; secret values và R2 object contents không đọc.

### E-004 — Workflow/deploy source tại Main

- **Observed:** 14/10/2026
- **Source:** Git objects tại SHA `68a555d359c2fe52436daba4cafba645e29c80d6`
- **Repro:** `git ls-tree -r --name-only FETCH_HEAD .github/workflows`; `git show FETCH_HEAD:.github/workflows/deploy-vps2.yml`; `git show FETCH_HEAD:deploy/vps/bi-release`; `git show FETCH_HEAD:deploy/vps/bi-migrate`; `git show FETCH_HEAD:scripts/apply-migrations.mjs`; `git show FETCH_HEAD:deploy/vps/deploy-production.sh`; `git show FETCH_HEAD:deploy/vps/compose.yaml`
- **Raw excerpt:** Main có CI, backup, deploy VPS1, deploy VPS2; không có workflow migration. VPS2 workflow đòi project khác và tag `-vps2`. Deploy wrapper kiểm tra dry-run migration rồi dừng nếu pending/checksum mismatch. Compose có một container `bi-app` và healthcheck `/login` <500.
- **Migration runner detail:** `scripts/apply-migrations.mjs` áp dụng theo thứ tự filename, mỗi file trong transaction riêng và ghi ledger cùng transaction; `deploy/vps/bi-migrate` chạy apply trước rồi mới chạy `--dry-run` hậu kiểm. Vì vậy `bi-migrate` là lệnh ghi ngay, không phải preflight. Runner chỉ in project ref rút gọn, không assert ref kỳ vọng.
- **Limit:** Đây là source Main, không chứng minh file cài trên VPS giống hệt.

### E-005 — DNS A lookup

- **Observed:** 14/10/2026
- **Source:** DNS resolver trên máy khảo sát
- **Repro:** `Resolve-DnsName -Name bi.hrpartner.vn -Type A` và `Resolve-DnsName -Name bi.hrpvietnam.vn -Type A`
- **Raw excerpt:** `bi.hrpartner.vn → 103.77.209.20`; `bi.hrpvietnam.vn → 103.72.57.240`.
- **Limit:** Không tự xác nhận proxy mode, TLS, Caddy hoặc response của ứng dụng; Owner xác nhận IP thứ hai là VPS2 ở E-007.

### E-007 — Owner xác nhận IP VPS2 và trạng thái Supabase Pro backup

- **Observed:** 14/10/2026
- **Source:** hội thoại Owner
- **Raw excerpt:** `103.72.57.240` là IP VPS2; Supabase đã nâng Pro và đang có backup tự động mỗi ngày; backup GitHub/R2 mỗi 6 giờ chỉ là lựa chọn bổ sung.
- **Limit:** Chưa kiểm tra trực tiếp project settings, mốc backup mới nhất, retention, restore, VPS2 route/TLS hay cấu hình runtime. Không thực hiện thay đổi hệ thống.

### E-006 — Điều kiện truy cập live trong phiên khảo sát

- **Observed:** 14/10/2026
- **Source:** kiểm tra cục bộ metadata đường dẫn và SSH known_hosts; không kết nối máy chủ
- **Repro:** `Test-Path C:\vps-bi.txt`; kiểm tra host key pin cho endpoint VPS2 trong `~\.ssh\known_hosts`.
- **Raw excerpt:** File VPS1 không có ở đường dẫn yêu cầu; không có known-hosts pin cho endpoint VPS2; SSH agent không báo identity dùng được.
- **Limit:** Không thử bypass xác minh host key; không SSH/DB.

## Bất biến an toàn

- Không thay đổi VPS1/VPS2, Docker/Caddy/n8n, DNS/Cloudflare, GitHub settings/workflows, Supabase Production/test hoặc R2 trong P0.
- Không áp dụng migration, deploy image, restore dump, tạo project DB, hoặc chạy thử trên Production.
- Working tree ban đầu có thay đổi chưa commit trên nhánh `codex/pre-w2-hf-d3-s0-account-personnel-survey`; đã giữ nguyên. Báo cáo này là file mới, chưa commit/push.
