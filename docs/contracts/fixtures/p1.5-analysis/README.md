# P1.5 golden fixtures — `analysis-packet/0.1` + `business-analysis/0.1`

Dữ liệu **hoàn toàn giả danh** (Project A/B…, recruiter_02, team_01). Không chứa dữ liệu thật, PII ứng viên,
tên file/Drive ID hay secret. Fixture chỉ dùng để test strict schema + luật nghiệp vụ của contract.

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `cases/` | **12** golden case. Mỗi file: `{ case_id, title, packet, expected, allowed_analysis, forbidden_analysis, forbidden_expected_code }` |
| `invalid-packets/` | **30** packet sai. Mỗi file: `{ case_id, description, expect_code, context_case, packet }` |
| `invalid-analysis/` | **25** output sai. Mỗi file: `{ case_id, description, expect_code, context_case, analysis }` |
| `valid/` | 1 packet hợp lệ + 1 output hợp lệ (positive path) |

## Cách test dùng fixture

1. `validateAnalysisPacket(case.packet)` phải `ok`.
2. Context cho output dựng từ packet đã validate:
   `{ periodRef, evidenceIds, subjectRefs, evidence, insufficientKeys, teamAvailability, allowedDates }`.
   `insufficientKeys` = các sufficiency key có `status = "not_met"` (phải khớp `expected.insufficient_keys`);
   `teamAvailability` = `packet.team_mapping.availability`;
   `allowedDates` = period start/end + comparable start/end + series period_start/period_end (R2).
3. `validateBusinessAnalysis(case.allowed_analysis, context)` phải `ok` — đây là “finding được phép”.
4. `validateBusinessAnalysis(case.forbidden_analysis, context)` phải fail đúng `forbidden_expected_code` — “finding bị cấm”.
5. Với `invalid-*/`: validator phải trả đúng `expect_code`.

## 12 golden case

| Case | Tình huống | Điều được phép / bị cấm |
|---|---|---|
| c01 | Tổng tăng, một team đóng góp phần lớn delta | Cho phép trend/driver; cấm gọi team khác là “kém hiệu quả” |
| c02 | Tổng giảm nhưng một recruiter vẫn tăng | Cho phép strength; cấm kết luận năng lực cá nhân |
| c03 | Không đủ baseline (2 kỳ) | Cho phép trend mức low; cấm confidence high |
| c04 | Period-to-date | Chỉ so cùng số ngày đã trôi qua; cấm so với toàn kỳ hoàn tất |
| c05 | Source partial/failed | Cho phép data_quality/risk; kết luận phải kèm limitation |
| c06 | Unknown/invalid tăng | Cấm đưa unknown/invalid vào mẫu số HRP/Vendor |
| c07 | Team dimension thiếu | Cấm finding trỏ team ngoài scope |
| c08 | Total/baseline = 0 | Cấm claim phần trăm khi mẫu số 0 |
| c09 | Vendor share 100% nhưng mẫu 1 người | Cấm gọi là rủi ro phụ thuộc khi baseline chưa đạt |
| c10 | Vendor share cao, volume lớn | Cho phép risk **kèm** limitation; cấm risk không limitation |
| c11 | Project có provider unknown/invalid | Share chỉ trên known_total; cấm tính unknown vào HRP/Vendor |
| c12 | Nhãn dimension giống prompt injection | Packet chỉ chứa opaque ref; cấm nội dung injection trong packet/report |

## R1 hardening (đã áp dụng trong fixture)

- `period_ref` chuyển sang `week:YYYY-Www` / `month:YYYY-MM` / `quarter:YYYY-Qn` / `custom:YYYY-MM-DD/YYYY-MM-DD`
  (format `period_*` cũ đã bỏ); mọi evidence `period_ref` khớp kỳ hiện tại.
- `stability` có `formula` + `formula_version` (`cv-population/1.0`) và `cv/volatility` được tính lại theo band đã khóa.
- `team_mapping` được thêm vào mọi packet (c01/c02 `available` với coverage 1; các case còn lại `unavailable`).
- `executive_evidence_refs` được thêm vào mọi output (allowed + forbidden).
- `findings = []` hợp lệ khi có limitation; **không** còn ngưỡng tối thiểu 3 finding.
- 8 invalid packet mới: period type/range mismatch, comparable khác loại kỳ, stability/volatility sai, team mapping sai.
- 8 invalid analysis mới: thiếu ref executive, ref executive treo, số executive/limitation không ground,
  findings rỗng không limitation, cross-unit %, count 1 ground “100 người”, percent lệch representation.

## R2 hardening (đã áp dụng trong fixture)

- `team_mapping` chuyển sang semantics **fact-weighted**: `mapped_recruited_count` / `unmapped_recruited_count` /
  `ambiguous_recruited_count` (đơn vị = số người, `sum(recruited_count)`) + `coverage_ratio` + `teams_in_scope`.
  Ba count cộng lại = `totals.current`; `coverage_ratio = mapped / totals.current` (null khi current = 0).
- 8 invalid packet mới cho team (sum, coverage derivation, ambiguous rỗng/có subject, scope count, unavailable có count,
  partial thiếu subject) và 1 cho stability âm.
- 3 invalid analysis mới cho date grounding (finding / executive / overall_limitations).
- `stability.mean/stddev/cv` bắt buộc `>= 0` khi khác null.

## Invariants toán học được test

- `sum(project_total) = totals.current` (cùng filter).
- `project_total = hrp + vendor + unknown + invalid`.
- `known_total = hrp + vendor`; `hrp_share + vendor_share = 1` khi `known_total > 0`, ngược lại cả hai `null`.
- `known_coverage = known_total / project_total`.
- `totals.delta = current - comparable`; PTD bắt buộc `comparable.elapsed_days = period.elapsed_days`.
