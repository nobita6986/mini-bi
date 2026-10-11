# P3.1 hotfix — Phân công tiếp tục và hủy lịch chuyển nhóm

Base: `e9d5f68f61d014ea70482fc059a44985a26e895a`.

## Quy tắc Owner chốt

- Phân công mới tiếp tục cho đến khi có chuyển nhóm hoặc bỏ gán tiếp theo.
- Hủy lịch chuyển chưa có hiệu lực: nhân sự tiếp tục ở nhóm trước đó, không có
  ngày kết thúc, nếu nhóm/nhân sự còn hợp lệ và không xung đột với lịch khác.
- Không xóa lịch sử, không tự sửa hồ sơ thật trong migration, không sửa ngày
  thuộc HRP (đó là dữ liệu nghiệp vụ khác).

## Bằng chứng → nguyên nhân → sửa chữa

| Bằng chứng | Nguyên nhân | Sửa chữa |
|---|---|---|
| #77 dùng `v_open.valid_to` cho dòng mới và snapshot | Phân công mới kế thừa hạn cũ từ lịch đã hủy | #78 tạo phân công mới với `valid_to = null`; overlap guard vẫn bắt lịch tương lai khác |
| #70 cancel chỉ đóng dòng sắp tới | Dòng trước vẫn dừng tại ngày chuyển dù lịch đã hủy | #78 tìm predecessor bằng khoảng liền kề và bằng chứng revision MOVE; khôi phục cùng giao dịch |
| UI dùng `reloadRequired` cho cả lưu thành công và xung đột | Tải lại bình thường cũng hiện cảnh báo vàng và nút tải lại bị khóa | Khi đang tải: một thông báo trung tính; khi dừng/lỗi: cảnh báo và nút thử lại |

## Phạm vi và tái sử dụng

Append migration #78 `20261011110000_p3_1_hf_membership_open_ended_successor.sql`.
#1–#77 giữ nguyên. Reuse RPC move/unassign, recruiter lock/OCC, creation eligibility,
target-team guard, attribution/overlap triggers, idempotency, revision và audit.
Không thêm endpoint, bảng, framework, dependency hoặc quyền mới.

Cancel chỉ khôi phục khi ngày bắt đầu còn ở tương lai và lịch xuất phát từ MOVE.
Lịch ASSIGN độc lập, marker và lịch đã có hiệu lực không tự khôi phục dòng khác.
Chuỗi thay thế cùng ngày tìm predecessor khác marker đã bị đóng bởi MOVE cùng ngày.
Khôi phục đòi hỏi nhân sự HRP đang active và nhóm trước đang active. Không hợp lệ
hoặc trùng lịch: toàn bộ giao dịch bị từ chối, không hủy nửa chừng.

Lịch hữu hạn cũ do #77 tạo cũng hủy được. Dữ liệu cũ không bị tự kéo dài khi
deploy; Owner thao tác qua API có lý do, OCC và audit.

Một lần hủy/khôi phục: một version bump, một revision và một audit. Snapshot
cancellation giữ sáu trường hiện hữu; khi có khôi phục, thêm đối tượng giới hạn
`restored_membership` (cùng sáu trường) vào before/after để ghi đủ dòng thứ hai.
Public mutation/read projection không mở rộng; revision vẫn là bảng bị thu hồi
quyền trực tiếp. `changed_fields` thêm `previous_membership_restored`.

UI hiển thị `Chưa có ngày kết thúc` với null, `Đã hủy lịch` với marker.
Khoá thao tác vẫn giữ đến khi detail và ba danh sách tải đủ; không bỏ OCC.

## Kiểm chứng

Focused DB/API 46/46 và UI 25/25 đã đạt trước release. Bao phủ successor mở,
stale OCC, exact replay, hủy lịch hữu hạn cũ, audit hai dòng, predecessor inactive,
nhân sự inactive, lịch độc lập liền kề, thay thế cùng ngày và overlap zero-residue.
Các migration-count/offset assertions được cập nhật cơ học 77 → 78.
Full canonical `pnpm test`, typegen, typecheck, lint (0 lỗi; 15 cảnh báo có sẵn),
webpack build, docs 6/6, secrets (1.517 file), offline migration validation (78)
và `git diff --check` đều đạt trước apply/deploy.

## Owner UAT sau deploy

1. Refresh trình duyệt; mở đúng hồ sơ có lịch chuyển hữu hạn cũ.
2. Hủy lịch chuyển chưa có hiệu lực, nhập lý do. Xác nhận nhóm trước trở lại
   `Chưa có ngày kết thúc`, lịch bị hủy vẫn trong lịch sử với nhãn `Đã hủy lịch`.
3. Chuyển lại sang nhóm mong muốn tại ngày tương lai. Nhóm cũ kết thúc tại ngày
   chuyển; nhóm mới hiển thị `Chưa có ngày kết thúc`.
4. Khi lưu: thấy một trạng thái đang cập nhật, không cảnh báo vàng kép. Nếu mạng
   lỗi khi tải lại: khoá còn giữ và có nút tải lại, không tự gửi lại mutation.

Chưa thực hiện browser/Owner UAT; không tự hủy/chuyển nhân sự Production.
