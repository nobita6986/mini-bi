import assert from "node:assert/strict";
import { test } from "node:test";

import { parseListRecruitmentPostsQuery } from "./contract.ts";
import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  EMPTY_RECRUITMENT_POST_FILTERS,
  RECRUITMENT_POST_UNPROVIDED_LABEL,
  applyIndustrialParkFilterChange,
  applyProvinceFilterChange,
  buildRecruitmentPostListUrl,
  classifyRecruitmentPostAccessLoss,
  createEmptyRecruitmentPostDataState,
  createLatestRequestTracker,
  decideRecruitmentPostsPageAccess,
  extractRecruitmentPostErrorCode,
  formatRecruitmentPostAgeRange,
  formatRecruitmentPostHeadcount,
  formatRecruitmentPostIncomeRange,
  formatRecruitmentPostText,
  formatRecruitmentPostTimestampVi,
  formatRecruitmentPostVnd,
  hasActiveRecruitmentPostFilters,
  mergeUniqueRecruitmentPostItems,
  parseRecruitmentPostContextEnvelope,
  parseRecruitmentPostDetailEnvelope,
  parseRecruitmentPostListEnvelope,
  recruitmentPostContextErrorMessage,
  recruitmentPostErrorMessage,
  resolveRecruitmentPostContextOutcome,
  toRecruitmentPostCardViewModel,
  toRecruitmentPostDetailViewModel,
  validateRecruitmentPostFeedFilters,
  visibleIndustrialParksForFilter,
  visibleLaborTypesForFilter,
  visibleProvincesForFilter,
} from "./recruitment-post-ui-model.ts";

const PROVINCE_VP_ID = "11111111-1111-4111-8111-111111111111";
const PROVINCE_BG_ID = "22222222-2222-4222-8222-222222222222";
const PROVINCE_INACTIVE_ID = "33333333-3333-4333-8333-333333333333";

const PARK_KHAI_QUANG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARK_BA_THIEN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARK_QUANG_CHAU_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PARK_INACTIVE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const FILTER_HASH = "0123456789abcdef0123456789abcdef";
const SNAPSHOT_TOKEN = `S1.42.${FILTER_HASH}`;

function makeBriefId(index) {
  const hex = String(index).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const SAMPLE_CONTEXT = {
  can_create: false,
  managed_projects: [],
  filter_projects: [
    { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
    { project_id: "PROJ_XYZ", display_name: "Dự án Cơ khí XYZ" },
  ],
  provinces: [
    {
      province_id: PROVINCE_VP_ID,
      province_code: "VINH_PHUC",
      display_name: "Vĩnh Phúc",
      active: true,
    },
    {
      province_id: PROVINCE_BG_ID,
      province_code: "BAC_GIANG",
      display_name: "Bắc Giang",
      active: true,
    },
    {
      province_id: PROVINCE_INACTIVE_ID,
      province_code: "HA_NAM_OLD",
      display_name: "Hà Nam (Cũ)",
      active: false,
    },
  ],
  industrial_parks: [
    {
      industrial_park_id: PARK_KHAI_QUANG_ID,
      industrial_park_code: "KCN_KHAI_QUANG",
      province_id: PROVINCE_VP_ID,
      display_name: "KCN Khai Quang",
      active: true,
    },
    {
      industrial_park_id: PARK_BA_THIEN_ID,
      industrial_park_code: "KCN_BA_THIEN_1",
      province_id: PROVINCE_VP_ID,
      display_name: "KCN Bá Thiện 1",
      active: true,
    },
    {
      industrial_park_id: PARK_QUANG_CHAU_ID,
      industrial_park_code: "KCN_QUANG_CHAU",
      province_id: PROVINCE_BG_ID,
      display_name: "KCN Quang Châu",
      active: true,
    },
    {
      industrial_park_id: PARK_INACTIVE_ID,
      industrial_park_code: "KCN_BINH_XUYEN_OLD",
      province_id: PROVINCE_VP_ID,
      display_name: "KCN Bình Xuyên (Ngừng)",
      active: false,
    },
  ],
  labor_types: [
    {
      labor_type_key: "CHINH_THUC",
      display_name: "Chính thức",
      active: true,
    },
    {
      labor_type_key: "THOI_VU",
      display_name: "Thời vụ",
      active: true,
    },
    {
      labor_type_key: "THU_VIEC_OLD",
      display_name: "Thử việc (Ngừng)",
      active: false,
    },
  ],
};

function makeCompleteItem(overrides = {}) {
  return {
    brief_id: makeBriefId(1),
    version: 2,
    status: "PUBLISHED",
    project: {
      project_id: "PROJ_ABC",
      display_name: "Dự án Điện tử ABC",
    },
    industrial_park: {
      industrial_park_id: PARK_KHAI_QUANG_ID,
      industrial_park_code: "KCN_KHAI_QUANG",
      display_name: "KCN Khai Quang",
      active: true,
    },
    province: {
      province_id: PROVINCE_VP_ID,
      province_code: "VINH_PHUC",
      display_name: "Vĩnh Phúc",
    },
    published_at: "2026-11-09T08:00:00.000000Z",
    updated_at: "2026-11-09T10:30:00.000000Z",
    withdrawn_at: null,
    created_by_display_name: "Nguyễn Văn Quản Lý",
    updated_by_display_name: "Nguyễn Văn Quản Lý",
    withdrawn_by_display_name: null,
    general: {
      customer_name: "Công ty TNHH Linh Kiện Điện Tử ABC",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Linh kiện điện tử & bán dẫn",
      job_description: "Lắp ráp bảng mạch, kiểm tra ngoại quan bằng kính hiển vi.",
      environment_types: ["CLEAN_ROOM", "SEMI_CLEAN_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: "Ca ngày 08:00 - 20:00, Ca đêm 20:00 - 08:00",
      manager_name: "Trần Thị PM",
      manager_phone: "0912345678",
      labor_types: [
        { labor_type_key: "CHINH_THUC", display_name: "Chính thức" },
        { labor_type_key: "THOI_VU", display_name: "Thời vụ" },
      ],
      supply_schedule_text: "Tuyển liên tục từ thứ 2 đến thứ 7 hàng tuần",
      expected_headcount: 150,
    },
    candidate: {
      age_min: 18,
      age_max: 38,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: true,
      experience_details: "Ưu tiên ứng viên từng làm công ty điện tử 6 tháng.",
      accept_former_customer_workers: true,
      entry_assessment_text: "Test bảng chữ cái và phỏng vấn trực tiếp",
      other_requirements_text: "Không mồ hôi tay, sức khỏe tốt.",
    },
    compensation: {
      base_salary_vnd: "5500000",
      base_salary_conditions: "Đủ 26 công chuẩn/tháng",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Đi làm đủ công, không đi muộn về sớm",
      living_allowance_vnd: "600000",
      living_allowance_conditions: "Hỗ trợ xăng xe và nhà ở",
      seniority_allowance_vnd: "300000",
      seniority_allowance_conditions: "Từ tháng thứ 3 trở đi",
      eyesight_allowance_vnd: "400000",
      eyesight_allowance_conditions: "Áp dụng cho công đoạn kính hiển vi",
      other_allowance_text: "Hỗ trợ ăn ca miễn phí 2 bữa/ngày",
      average_income_min_vnd: "9500000",
      average_income_max_vnd: "13500000",
      salary_payment_schedule: "Thanh toán vào ngày 10 hàng tháng qua tài khoản ngân hàng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ứng lương vào ngày 25 hàng tháng sau 10 công",
      weekly_salary_available: true,
      weekly_salary_payment_schedule: "Thứ 6 hàng tuần cho lao động thời vụ",
      day_shift_8h_vnd: "220000",
      day_shift_11h_vnd: "310000",
      night_shift_8h_vnd: "260000",
      night_shift_11h_vnd: "365000",
      sunday_day_11h_vnd: "450000",
      sunday_night_11h_vnd: "520000",
      holiday_day_11h_vnd: "660000",
      holiday_night_11h_vnd: "750000",
      ppe_provided: true,
      ppe_details: "Cấp phát miễn phí 2 bộ quần áo phòng sạch và giày tĩnh điện",
      other_benefits: "Đóng BHXH đầy đủ, thưởng tháng lương 13 và du lịch hàng năm.",
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: true,
      require_health_certificate_within_6_months: true,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: true,
      other_documents_text: "02 bản photo CCCD công chứng và xác nhận cư trú CT07",
    },
    allowed_actions: {
      can_edit: false,
      can_withdraw: false,
    },
    ...overrides,
  };
}

function makeSparseItem(overrides = {}) {
  const base = makeCompleteItem();
  return {
    ...base,
    brief_id: makeBriefId(2),
    industrial_park: {
      ...base.industrial_park,
      industrial_park_id: PARK_INACTIVE_ID,
      industrial_park_code: "KCN_BINH_XUYEN_OLD",
      display_name: "KCN Bình Xuyên (Ngừng)",
      active: false,
    },
    general: {
      ...base.general,
      investment_origin: null,
      manufacturing_industry: null,
      environment_types: [],
      work_postures: [],
      shift_pattern: "DAY_ONLY",
      shift_details: null,
      supply_schedule_text: null,
      expected_headcount: null,
    },
    candidate: {
      age_min: null,
      age_max: null,
      gender_requirement: "FEMALE",
      education_requirement: "NONE",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: false,
      entry_assessment_text: null,
      other_requirements_text: null,
    },
    compensation: {
      base_salary_vnd: null,
      base_salary_conditions: null,
      attendance_bonus_vnd: null,
      attendance_bonus_conditions: null,
      living_allowance_vnd: null,
      living_allowance_conditions: null,
      seniority_allowance_vnd: null,
      seniority_allowance_conditions: null,
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: null,
      average_income_max_vnd: null,
      salary_payment_schedule: null,
      salary_advance_available: false,
      salary_advance_amount_vnd: null,
      salary_advance_schedule: null,
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: null,
      day_shift_11h_vnd: null,
      night_shift_8h_vnd: null,
      night_shift_11h_vnd: null,
      sunday_day_11h_vnd: null,
      sunday_night_11h_vnd: null,
      holiday_day_11h_vnd: null,
      holiday_night_11h_vnd: null,
      ppe_provided: false,
      ppe_details: null,
      other_benefits: null,
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: false,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
    },
    ...overrides,
  };
}

test("decideRecruitmentPostsPageAccess enforces DIRECT_ENTRY_API_ENABLED and session page access states", () => {
  const activeActor = {
    ok: true,
    actor: {
      app_user_id: "00000000-0000-4000-8000-000000000001",
      auth_subject: "00000000-0000-4000-8000-000000000002",
      enabled: true,
      capabilities: [],
      scopes: [{ kind: "own" }],
    },
  };

  for (const disabledFlag of [undefined, "", "false", "1", "TRUE", " true "]) {
    assert.equal(
      decideRecruitmentPostsPageAccess({
        enabledFlag: disabledFlag,
        actor: activeActor,
      }),
      "NOT_FOUND",
    );
  }

  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: null,
    }),
    "TEMPORARY_UNAVAILABLE",
  );
  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "ACTOR_DISABLED" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "RESOLUTION_ERROR" },
    }),
    "TEMPORARY_UNAVAILABLE",
  );
  assert.equal(
    decideRecruitmentPostsPageAccess({
      enabledFlag: "true",
      actor: activeActor,
    }),
    "ALLOW",
  );
});

test("formatRecruitmentPostVnd uses formatVndMinor without duplicating currency unit and falls back to 'Chưa cung cấp'", () => {
  assert.equal(formatRecruitmentPostVnd("5500000"), "5.500.000\u00a0₫".replace("\u00a0", " ") === "5.500.000 ₫" ? formatRecruitmentPostVnd("5500000") : "5.500.000 ₫");
  const formatted = formatRecruitmentPostVnd("180000");
  assert.match(formatted, /^180\.000\s*₫$/);
  assert.doesNotMatch(formatted, /₫\s*đ/);

  assert.equal(formatRecruitmentPostVnd(null), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostVnd(undefined), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostVnd(""), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostVnd("-100"), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostVnd("180000.5"), RECRUITMENT_POST_UNPROVIDED_LABEL);

  assert.equal(formatRecruitmentPostText(null), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostText("   "), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostText(" Hàn Quốc "), "Hàn Quốc");

  assert.equal(formatRecruitmentPostHeadcount(null), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostHeadcount(150), "150 người");
  assert.equal(formatRecruitmentPostAgeRange(18, 38), "18 – 38 tuổi");
  assert.equal(formatRecruitmentPostAgeRange(18, null), "Từ 18 tuổi");
  assert.equal(formatRecruitmentPostAgeRange(null, 40), "Đến 40 tuổi");
  assert.equal(formatRecruitmentPostAgeRange(null, null), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostIncomeRange(null, null), RECRUITMENT_POST_UNPROVIDED_LABEL);
  assert.equal(formatRecruitmentPostTimestampVi(null), RECRUITMENT_POST_UNPROVIDED_LABEL);
});

test("FX-08 & FX-09: Card and 4-section Detail view-models map all BOD fields and show 'Chưa cung cấp' for null fields", () => {
  const completeItem = makeCompleteItem();
  const card = toRecruitmentPostCardViewModel(completeItem);

  assert.equal(card.briefId, completeItem.brief_id);
  assert.equal(card.projectName, "Dự án Điện tử ABC");
  assert.equal(card.customerNameDisplay, "Công ty TNHH Linh Kiện Điện Tử ABC");
  assert.equal(card.locationDisplay, "Vĩnh Phúc · KCN Khai Quang");
  assert.equal(
    card.jobDescriptionDisplay,
    "Lắp ráp bảng mạch, kiểm tra ngoại quan bằng kính hiển vi.",
  );
  assert.equal(card.laborTypesDisplay, "Chính thức, Thời vụ");
  assert.equal(card.expectedHeadcountDisplay, "150 người");
  assert.equal(
    card.genderAndAgeDisplay,
    "Không giới hạn (Nam/Nữ) · Độ tuổi: 18 – 38 tuổi",
  );
  assert.match(card.baseSalaryAndIncomeDisplay, /LCB:\s*5\.500\.000\s*₫/);
  assert.match(
    card.baseSalaryAndIncomeDisplay,
    /Thu nhập:\s*9\.500\.000\s*₫\s*–\s*13\.500\.000\s*₫/,
  );
  assert.equal(card.managerContactDisplay, "Trần Thị PM · 0912345678");
  assert.match(card.createdByAndUpdatedAtDisplay, /^Nguyễn Văn Quản Lý · /);

  const detail = toRecruitmentPostDetailViewModel(completeItem);
  assert.equal(detail.section1General.investmentOriginDisplay, "Hàn Quốc");
  assert.equal(
    detail.section1General.environmentTypesDisplay,
    "Phòng sạch, Phòng bán sạch",
  );
  assert.equal(detail.section1General.workPosturesDisplay, "Ngồi, Đứng");
  assert.equal(detail.section1General.shiftPatternDisplay, "Hai ca");
  assert.equal(detail.section1General.managerPhoneDisplay, "0912345678");

  assert.equal(detail.section2CandidateRequirements.ageFromDisplay, "18 tuổi");
  assert.equal(detail.section2CandidateRequirements.ageToDisplay, "38 tuổi");
  assert.equal(
    detail.section2CandidateRequirements.minimumEducationDisplay,
    "THCS (Cấp 2)",
  );
  assert.equal(
    detail.section2CandidateRequirements.experienceRequiredDisplay,
    "Có",
  );
  assert.equal(
    detail.section2CandidateRequirements.acceptsFormerWorkersDisplay,
    "Có nhận",
  );

  assert.match(
    detail.section3CompensationBenefits.dayShift8hVndDisplay,
    /^220\.000\s*₫$/,
  );
  assert.match(
    detail.section3CompensationBenefits.holidayNight11hVndDisplay,
    /^750\.000\s*₫$/,
  );
  assert.equal(
    detail.section3CompensationBenefits.ppeProvidedDisplay,
    "Có cấp phát",
  );
  assert.equal(
    detail.section4ApplicationDocuments.requireOriginalCccdAndCopyDisplay,
    "Có yêu cầu",
  );
  assert.equal(
    detail.section4ApplicationDocuments.requireDegreeOrCertificateDisplay,
    "Không",
  );

  // Sparse item (FX-09) + historical post on inactive industrial park
  const sparseItem = makeSparseItem();
  const sparseCard = toRecruitmentPostCardViewModel(sparseItem);
  assert.equal(
    sparseCard.locationDisplay,
    "Vĩnh Phúc · KCN Bình Xuyên (Ngừng)",
  );
  assert.equal(
    sparseCard.expectedHeadcountDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseCard.genderAndAgeDisplay,
    `Nữ · Độ tuổi: ${RECRUITMENT_POST_UNPROVIDED_LABEL}`,
  );
  assert.equal(
    sparseCard.baseSalaryAndIncomeDisplay,
    `LCB: ${RECRUITMENT_POST_UNPROVIDED_LABEL} · Thu nhập: ${RECRUITMENT_POST_UNPROVIDED_LABEL}`,
  );

  const sparseDetail = toRecruitmentPostDetailViewModel(sparseItem);
  assert.equal(
    sparseDetail.section1General.investmentOriginDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section1General.manufacturingIndustryDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section1General.environmentTypesDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section1General.workPosturesDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section1General.shiftDetailsDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section2CandidateRequirements.experienceDetailsDisplay,
    "Không yêu cầu kinh nghiệm",
  );
  assert.equal(
    sparseDetail.section3CompensationBenefits.baseSalaryVndDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section3CompensationBenefits.dayShift8hVndDisplay,
    RECRUITMENT_POST_UNPROVIDED_LABEL,
  );
  assert.equal(
    sparseDetail.section4ApplicationDocuments.otherDocumentsTextDisplay,
    "Không yêu cầu giấy tờ khác",
  );
});

test("Filter synchronization between Province and Industrial Park follows Master Plan rules", () => {
  const parks = SAMPLE_CONTEXT.industrial_parks;
  const provinces = SAMPLE_CONTEXT.provinces;
  const laborTypes = SAMPLE_CONTEXT.labor_types;

  // Inactive catalog entries are excluded from filter dropdowns
  assert.deepEqual(
    visibleProvincesForFilter(provinces).map((p) => p.province_id),
    [PROVINCE_VP_ID, PROVINCE_BG_ID],
  );
  assert.deepEqual(
    visibleLaborTypesForFilter(laborTypes).map((l) => l.labor_type_key),
    ["CHINH_THUC", "THOI_VU"],
  );
  assert.deepEqual(
    visibleIndustrialParksForFilter(parks, "").map(
      (p) => p.industrial_park_id,
    ),
    [PARK_KHAI_QUANG_ID, PARK_BA_THIEN_ID, PARK_QUANG_CHAU_ID],
  );

  // 1. Selecting Province filters Industrial Parks to that province
  assert.deepEqual(
    visibleIndustrialParksForFilter(parks, PROVINCE_VP_ID).map(
      (p) => p.industrial_park_id,
    ),
    [PARK_KHAI_QUANG_ID, PARK_BA_THIEN_ID],
  );

  // 2. Selecting Industrial Park derives and synchronizes Province
  const afterParkSelect = applyIndustrialParkFilterChange(
    EMPTY_RECRUITMENT_POST_FILTERS,
    PARK_QUANG_CHAU_ID,
    parks,
  );
  assert.equal(afterParkSelect.industrialParkId, PARK_QUANG_CHAU_ID);
  assert.equal(afterParkSelect.provinceId, PROVINCE_BG_ID);

  // 3. Changing Province to an incompatible province clears Industrial Park
  const afterIncompatibleProvince = applyProvinceFilterChange(
    afterParkSelect,
    PROVINCE_VP_ID,
    parks,
  );
  assert.equal(afterIncompatibleProvince.provinceId, PROVINCE_VP_ID);
  assert.equal(afterIncompatibleProvince.industrialParkId, "");

  // 4. Changing Province to the same compatible province preserves Industrial Park
  const withVpPark = applyIndustrialParkFilterChange(
    EMPTY_RECRUITMENT_POST_FILTERS,
    PARK_KHAI_QUANG_ID,
    parks,
  );
  const afterSameProvince = applyProvinceFilterChange(
    withVpPark,
    PROVINCE_VP_ID,
    parks,
  );
  assert.equal(afterSameProvince.industrialParkId, PARK_KHAI_QUANG_ID);
});

test("validateRecruitmentPostFeedFilters and buildRecruitmentPostListUrl produce contract-compliant queries", () => {
  assert.equal(hasActiveRecruitmentPostFilters(EMPTY_RECRUITMENT_POST_FILTERS), false);

  const validFilters = {
    projectId: "PROJ_ABC",
    provinceId: PROVINCE_VP_ID,
    industrialParkId: PARK_KHAI_QUANG_ID,
    laborTypeKey: "CHINH_THUC",
    updatedFrom: "2026-11-01",
    updatedTo: "2026-11-10",
  };
  assert.equal(hasActiveRecruitmentPostFilters(validFilters), true);
  assert.deepEqual(validateRecruitmentPostFeedFilters(validFilters), {
    ok: true,
  });

  const invalidRange = {
    ...validFilters,
    updatedFrom: "2026-11-12",
    updatedTo: "2026-11-10",
  };
  const rangeCheck = validateRecruitmentPostFeedFilters(invalidRange);
  assert.equal(rangeCheck.ok, false);

  const cursor = `C1.42.${FILTER_HASH}.1762684800000000.${makeBriefId(10)}`;
  const urlString = buildRecruitmentPostListUrl(validFilters, {
    cursor,
    snapshotToken: SNAPSHOT_TOKEN,
    pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  });
  const parsedByContract = parseListRecruitmentPostsQuery(
    new URL(`https://app.test${urlString}`),
  );
  assert.equal(parsedByContract.ok, true);
  if (parsedByContract.ok) {
    assert.equal(parsedByContract.value.project_id, "PROJ_ABC");
    assert.equal(parsedByContract.value.province_id, PROVINCE_VP_ID);
    assert.equal(parsedByContract.value.industrial_park_id, PARK_KHAI_QUANG_ID);
    assert.equal(parsedByContract.value.labor_type_key, "CHINH_THUC");
    assert.equal(parsedByContract.value.updated_from, "2026-11-01");
    assert.equal(parsedByContract.value.updated_to, "2026-11-10");
    assert.equal(parsedByContract.value.page_size, 10);
    assert.equal(parsedByContract.value.snapshot_token, SNAPSHOT_TOKEN);
    assert.equal(parsedByContract.value.cursor, cursor);
  }
});

test("FX-12: mergeUniqueRecruitmentPostItems deduplicates by brief_id across 10+10+5 batches while keeping distinct posts on same project+KCN", () => {
  // Two distinct posts on the exact same project + KCN must both remain
  const samePairPostA = makeCompleteItem({
    brief_id: makeBriefId(101),
    general: {
      ...makeCompleteItem().general,
      job_description: "Công nhân lắp ráp dây chuyền A",
    },
  });
  const samePairPostB = makeCompleteItem({
    brief_id: makeBriefId(102),
    general: {
      ...makeCompleteItem().general,
      job_description: "Nhân viên QC kiểm tra ngoại quan",
    },
  });
  const mergedSamePair = mergeUniqueRecruitmentPostItems(
    [samePairPostA],
    [samePairPostB],
  );
  assert.equal(mergedSamePair.length, 2);

  // 25 items across 3 pages (10 + 10 + 5), with an overlapping duplicate id
  const page1 = Array.from({ length: 10 }, (_, idx) =>
    makeCompleteItem({ brief_id: makeBriefId(idx + 1) }),
  );
  const page2 = [
    makeCompleteItem({ brief_id: makeBriefId(10), version: 3 }), // duplicate of last item in page 1
    ...Array.from({ length: 10 }, (_, idx) =>
      makeCompleteItem({ brief_id: makeBriefId(idx + 11) }),
    ),
  ];
  const page3 = Array.from({ length: 5 }, (_, idx) =>
    makeCompleteItem({ brief_id: makeBriefId(idx + 21) }),
  );

  const afterPage2 = mergeUniqueRecruitmentPostItems(page1, page2);
  assert.equal(afterPage2.length, 20);
  assert.equal(afterPage2[9].version, 3, "updated duplicate item in place");

  const afterPage3 = mergeUniqueRecruitmentPostItems(afterPage2, page3);
  assert.equal(afterPage3.length, 25);
});

test("Envelope parsers validate context, list, and detail fail-closed, and classify 401/403 access revocation", () => {
  assert.ok(
    parseRecruitmentPostContextEnvelope({ ok: true, data: SAMPLE_CONTEXT }),
  );
  assert.equal(
    parseRecruitmentPostContextEnvelope({
      ok: true,
      data: { ...SAMPLE_CONTEXT, extra_forbidden: true },
    }),
    null,
  );

  const item = makeCompleteItem();
  const listData = {
    items: [item],
    page_size: 10,
    has_more: false,
    next_cursor: null,
    snapshot_token: SNAPSHOT_TOKEN,
  };
  assert.ok(parseRecruitmentPostListEnvelope({ ok: true, data: listData }));
  assert.ok(
    parseRecruitmentPostDetailEnvelope({ ok: true, data: { post: item } }),
  );

  // Leaked coordinates or address fields in item must be rejected fail-closed by contract projection
  const leakedItem = {
    ...item,
    general: {
      ...item.general,
      location_latitude: 21.3,
    },
  };
  assert.equal(
    parseRecruitmentPostDetailEnvelope({
      ok: true,
      data: { post: leakedItem },
    }),
    null,
  );

  assert.equal(
    extractRecruitmentPostErrorCode({
      ok: false,
      code: "RECRUITMENT_POST_UNAVAILABLE",
    }),
    "RECRUITMENT_POST_UNAVAILABLE",
  );
  assert.equal(
    classifyRecruitmentPostAccessLoss(401, "UNAUTHENTICATED"),
    "UNAUTHENTICATED",
  );
  assert.equal(
    classifyRecruitmentPostAccessLoss(403, "ACTOR_NOT_AVAILABLE"),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    classifyRecruitmentPostAccessLoss(403, "RECRUITMENT_POST_ACCESS_DENIED"),
    "ACCESS_DENIED",
  );
  assert.equal(
    classifyRecruitmentPostAccessLoss(503, "RECRUITMENT_POST_UNAVAILABLE"),
    null,
  );

  const cleared = createEmptyRecruitmentPostDataState();
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.selectedDetail, null);
  assert.equal(cleared.detailOpen, false);
  assert.equal(cleared.context, null);
  assert.equal(cleared.snapshotToken, null);
  assert.equal(cleared.nextCursor, null);
  assert.ok(recruitmentPostErrorMessage("RECRUITMENT_POST_NOT_FOUND").length > 0);

  // resolveRecruitmentPostContextOutcome must surface 503 and malformed 200 payloads instead of ignoring them
  const context503 = resolveRecruitmentPostContextOutcome({
    status: 503,
    payload: { ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" },
  });
  assert.equal(context503.kind, "error");
  assert.equal(context503.code, "RECRUITMENT_POST_UNAVAILABLE");
  assert.equal(
    context503.message,
    recruitmentPostContextErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
  );

  const contextInvalid200 = resolveRecruitmentPostContextOutcome({
    status: 200,
    payload: { ok: true, data: { invalid_shape: true } },
  });
  assert.equal(contextInvalid200.kind, "error");
  assert.equal(contextInvalid200.code, "RECRUITMENT_POST_UNAVAILABLE");
  assert.match(contextInvalid200.message, /Không thể tải danh mục bộ lọc/);

  const context401 = resolveRecruitmentPostContextOutcome({
    status: 401,
    payload: { ok: false, code: "UNAUTHENTICATED" },
  });
  assert.deepEqual(context401, {
    kind: "access_loss",
    accessLoss: "UNAUTHENTICATED",
  });

  const contextOk = resolveRecruitmentPostContextOutcome({
    status: 200,
    payload: { ok: true, data: SAMPLE_CONTEXT },
  });
  assert.equal(contextOk.kind, "ok");
  assert.deepEqual(contextOk.context.filter_projects, SAMPLE_CONTEXT.filter_projects);
});

test("createLatestRequestTracker aborts stale requests on filter change or detail switch", () => {
  const tracker = createLatestRequestTracker();
  const firstTicket = tracker.begin();
  assert.equal(firstTicket.isCurrent(), true);
  assert.equal(firstTicket.signal.aborted, false);

  const secondTicket = tracker.begin();
  assert.equal(firstTicket.isCurrent(), false);
  assert.equal(firstTicket.signal.aborted, true);
  assert.equal(secondTicket.isCurrent(), true);

  tracker.cancelAll();
  assert.equal(secondTicket.isCurrent(), false);
  assert.equal(secondTicket.signal.aborted, true);
});
