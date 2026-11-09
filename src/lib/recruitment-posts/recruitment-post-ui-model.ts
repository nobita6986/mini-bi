import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import {
  decideSessionPageAccess,
  type SessionPageDecision,
} from "../auth/session-page-access.ts";
import {
  createLatestRequestTracker,
  type LatestRequestTicket,
  type LatestRequestTracker,
} from "../salary-advance/salary-advance-ui-model.ts";
import { formatVndMinor } from "../vendor-finance/ui-model.ts";
import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  MAX_RECRUITMENT_POST_PAGE_SIZE,
  RECRUITMENT_POST_CURSOR_PATTERN,
  RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN,
  VND_STRING_PATTERN,
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostItem,
  projectRecruitmentPostList,
  type RecruitmentPostContext,
  type RecruitmentPostEducationRequirement,
  type RecruitmentPostEnvironmentType,
  type RecruitmentPostErrorCode,
  type RecruitmentPostGenderRequirement,
  type RecruitmentPostGetResult,
  type RecruitmentPostIndustrialParkOption,
  type RecruitmentPostItem,
  type RecruitmentPostLaborTypeOption,
  type RecruitmentPostList,
  type RecruitmentPostProjectOption,
  type RecruitmentPostProvinceOption,
  type RecruitmentPostShiftPattern,
  type RecruitmentPostStatus,
  type RecruitmentPostWorkPosture,
} from "./contract.ts";

export {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  MAX_RECRUITMENT_POST_PAGE_SIZE,
  RECRUITMENT_POST_CURSOR_PATTERN,
  RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN,
  createLatestRequestTracker,
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostItem,
  projectRecruitmentPostList,
};

export type {
  LatestRequestTicket,
  LatestRequestTracker,
  RecruitmentPostContext,
  RecruitmentPostEducationRequirement,
  RecruitmentPostEnvironmentType,
  RecruitmentPostErrorCode,
  RecruitmentPostGenderRequirement,
  RecruitmentPostGetResult,
  RecruitmentPostIndustrialParkOption,
  RecruitmentPostItem,
  RecruitmentPostLaborTypeOption,
  RecruitmentPostList,
  RecruitmentPostProjectOption,
  RecruitmentPostProvinceOption,
  RecruitmentPostShiftPattern,
  RecruitmentPostStatus,
  RecruitmentPostWorkPosture,
};

export const RECRUITMENT_POST_UNPROVIDED_LABEL = "Chưa cung cấp";

export const ENVIRONMENT_TYPE_LABELS: Readonly<
  Record<RecruitmentPostEnvironmentType, string>
> = Object.freeze({
  CLEAN_ROOM: "Phòng sạch",
  NORMAL_ROOM: "Phòng thường",
  SEMI_CLEAN_ROOM: "Phòng bán sạch",
});

export const WORK_POSTURE_LABELS: Readonly<
  Record<RecruitmentPostWorkPosture, string>
> = Object.freeze({
  STANDING: "Đứng",
  SITTING: "Ngồi",
});

export const SHIFT_PATTERN_LABELS: Readonly<
  Record<RecruitmentPostShiftPattern, string>
> = Object.freeze({
  DAY_ONLY: "Chuyên ngày",
  TWO_SHIFTS: "Hai ca",
  THREE_SHIFTS: "Ba ca",
  OTHER: "Khác",
});

export const GENDER_REQUIREMENT_LABELS: Readonly<
  Record<RecruitmentPostGenderRequirement, string>
> = Object.freeze({
  FEMALE: "Nữ",
  MALE: "Nam",
  ANY: "Không giới hạn (Nam/Nữ)",
});

export const EDUCATION_REQUIREMENT_LABELS: Readonly<
  Record<RecruitmentPostEducationRequirement, string>
> = Object.freeze({
  SECONDARY: "THCS (Cấp 2)",
  HIGH_SCHOOL: "THPT (Cấp 3)",
  NONE: "Không yêu cầu",
});

export type RecruitmentPostsPageAccessDecision =
  | "NOT_FOUND"
  | SessionPageDecision;

/**
 * Server boundary decision for `/recruitment-posts`.
 * - Checks `DIRECT_ENTRY_API_ENABLED` separately (`"NOT_FOUND"` when not `"true"`).
 * - Delegates session/account state to `decideSessionPageAccess(actor)`.
 */
export function decideRecruitmentPostsPageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
}): RecruitmentPostsPageAccessDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  return decideSessionPageAccess(input.actor);
}

export type RecruitmentPostAllowedActionsViewModel = {
  readonly canEdit: boolean;
  readonly canWithdraw: boolean;
};

export type RecruitmentPostFeedFilterState = {
  readonly projectId: string;
  readonly provinceId: string;
  readonly industrialParkId: string;
  readonly laborTypeKey: string;
  readonly updatedFrom: string;
  readonly updatedTo: string;
};

export const EMPTY_RECRUITMENT_POST_FILTERS: RecruitmentPostFeedFilterState =
  Object.freeze({
    projectId: "",
    provinceId: "",
    industrialParkId: "",
    laborTypeKey: "",
    updatedFrom: "",
    updatedTo: "",
  });

export type RecruitmentPostCardViewModel = {
  readonly briefId: string;
  readonly version: number;
  readonly projectName: string;
  readonly customerNameDisplay: string;
  readonly provinceName: string;
  readonly industrialParkName: string;
  readonly locationDisplay: string;
  readonly jobDescriptionDisplay: string;
  readonly laborTypesDisplay: string;
  readonly expectedHeadcountDisplay: string;
  readonly genderDisplay: string;
  readonly ageRangeDisplay: string;
  readonly genderAndAgeDisplay: string;
  readonly baseSalaryDisplay: string;
  readonly incomeRangeDisplay: string;
  readonly baseSalaryAndIncomeDisplay: string;
  readonly managerNameDisplay: string;
  readonly managerPhoneDisplay: string;
  readonly managerContactDisplay: string;
  readonly createdByDisplayName: string;
  readonly updatedAtDisplay: string;
  readonly createdByAndUpdatedAtDisplay: string;
  readonly allowedActions: RecruitmentPostAllowedActionsViewModel;
};

export type RecruitmentPostDetailViewModel = {
  readonly briefId: string;
  readonly version: number;
  readonly status: RecruitmentPostStatus;
  readonly projectId: string;
  readonly industrialParkId: string;
  readonly createdByDisplayName: string;
  readonly updatedByDisplayName: string;
  readonly publishedAtDisplay: string;
  readonly updatedAtDisplay: string;
  readonly allowedActions: RecruitmentPostAllowedActionsViewModel;
  readonly section1General: {
    readonly projectName: string;
    readonly industrialParkName: string;
    readonly provinceName: string;
    readonly customerNameDisplay: string;
    readonly investmentOriginDisplay: string;
    readonly manufacturingIndustryDisplay: string;
    readonly jobDescriptionDisplay: string;
    readonly environmentTypesDisplay: string;
    readonly workPosturesDisplay: string;
    readonly shiftPatternDisplay: string;
    readonly shiftDetailsDisplay: string;
    readonly managerNameDisplay: string;
    readonly managerPhoneDisplay: string;
    readonly laborTypesDisplay: string;
    readonly supplyScheduleTextDisplay: string;
    readonly expectedHeadcountDisplay: string;
  };
  readonly section2CandidateRequirements: {
    readonly ageFromDisplay: string;
    readonly ageToDisplay: string;
    readonly genderDisplay: string;
    readonly minimumEducationDisplay: string;
    readonly experienceRequiredDisplay: string;
    readonly experienceDetailsDisplay: string;
    readonly acceptsFormerWorkersDisplay: string;
    readonly entryTestFormatDisplay: string;
    readonly otherRequirementsDisplay: string;
  };
  readonly section3CompensationBenefits: {
    readonly baseSalaryVndDisplay: string;
    readonly baseSalaryConditionsDisplay: string;
    readonly attendanceBonusVndDisplay: string;
    readonly attendanceBonusConditionsDisplay: string;
    readonly livingAllowanceVndDisplay: string;
    readonly livingAllowanceConditionsDisplay: string;
    readonly seniorityAllowanceVndDisplay: string;
    readonly seniorityAllowanceConditionsDisplay: string;
    readonly eyesightAllowanceVndDisplay: string;
    readonly eyesightAllowanceConditionsDisplay: string;
    readonly otherAllowanceTextDisplay: string;
    readonly averageIncomeMinVndDisplay: string;
    readonly averageIncomeMaxVndDisplay: string;
    readonly salaryPaymentScheduleDisplay: string;
    readonly salaryAdvanceAvailableDisplay: string;
    readonly salaryAdvanceAmountVndDisplay: string;
    readonly salaryAdvanceScheduleDisplay: string;
    readonly weeklySalaryAvailableDisplay: string;
    readonly weeklySalaryPaymentScheduleDisplay: string;
    readonly dayShift8hVndDisplay: string;
    readonly dayShift11hVndDisplay: string;
    readonly nightShift8hVndDisplay: string;
    readonly nightShift11hVndDisplay: string;
    readonly sundayDay11hVndDisplay: string;
    readonly sundayNight11hVndDisplay: string;
    readonly holidayDay11hVndDisplay: string;
    readonly holidayNight11hVndDisplay: string;
    readonly ppeProvidedDisplay: string;
    readonly ppeDetailsDisplay: string;
    readonly otherBenefitsDisplay: string;
  };
  readonly section4ApplicationDocuments: {
    readonly requireOriginalCccdAndCopy: boolean;
    readonly requireOriginalCccdAndCopyDisplay: string;
    readonly requireCertifiedResume: boolean;
    readonly requireCertifiedResumeDisplay: string;
    readonly requireHealthCertificateWithin6Months: boolean;
    readonly requireHealthCertificateWithin6MonthsDisplay: string;
    readonly requirePhoto3x4: boolean;
    readonly requirePhoto3x4Display: string;
    readonly requireDegreeOrCertificate: boolean;
    readonly requireDegreeOrCertificateDisplay: string;
    readonly requireSocialInsuranceBook: boolean;
    readonly requireSocialInsuranceBookDisplay: string;
    readonly requireOtherDocuments: boolean;
    readonly requireOtherDocumentsDisplay: string;
    readonly otherDocumentsTextDisplay: string;
  };
};

export type RecruitmentPostAccessLossKind =
  | "UNAUTHENTICATED"
  | "ACCESS_DENIED"
  | "ACCOUNT_UNAVAILABLE";

export type RecruitmentPostDataState = {
  readonly context: RecruitmentPostContext | null;
  readonly items: readonly RecruitmentPostItem[];
  readonly selectedDetail: RecruitmentPostItem | null;
  readonly detailOpen: boolean;
  readonly detailBriefId: string | null;
  readonly detailError: string | null;
  readonly nextCursor: string | null;
  readonly snapshotToken: string | null;
  readonly hasMore: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Formats nullable/optional strings with `"Chưa cung cấp"` when empty or null.
 */
export function formatRecruitmentPostText(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : RECRUITMENT_POST_UNPROVIDED_LABEL;
}

/**
 * Formats a canonical integer VND string (`"5500000"`) via `formatVndMinor` (`"5.500.000 ₫"`).
 * Never appends an extra `" đ"` unit. Returns `"Chưa cung cấp"` when null or invalid.
 */
export function formatRecruitmentPostVnd(
  canonicalVnd: string | null | undefined,
): string {
  if (typeof canonicalVnd !== "string") {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const trimmed = canonicalVnd.trim();
  if (!VND_STRING_PATTERN.test(trimmed)) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return formatVndMinor(trimmed);
}

export function formatRecruitmentPostHeadcount(
  headcount: number | null | undefined,
): string {
  if (
    typeof headcount !== "number" ||
    !Number.isInteger(headcount) ||
    headcount < 0
  ) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return `${new Intl.NumberFormat("vi-VN").format(headcount)} người`;
}

export function formatRecruitmentPostAgeBound(
  age: number | null | undefined,
): string {
  if (typeof age !== "number" || !Number.isInteger(age) || age < 15 || age > 70) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return `${age} tuổi`;
}

export function formatRecruitmentPostAgeRange(
  ageMin: number | null | undefined,
  ageMax: number | null | undefined,
): string {
  const hasMin =
    typeof ageMin === "number" &&
    Number.isInteger(ageMin) &&
    ageMin >= 15 &&
    ageMin <= 70;
  const hasMax =
    typeof ageMax === "number" &&
    Number.isInteger(ageMax) &&
    ageMax >= 15 &&
    ageMax <= 70;
  if (hasMin && hasMax) {
    return ageMin === ageMax
      ? `${ageMin} tuổi`
      : `${ageMin} – ${ageMax} tuổi`;
  }
  if (hasMin) {
    return `Từ ${ageMin} tuổi`;
  }
  if (hasMax) {
    return `Đến ${ageMax} tuổi`;
  }
  return RECRUITMENT_POST_UNPROVIDED_LABEL;
}

export function formatRecruitmentPostIncomeRange(
  minVnd: string | null | undefined,
  maxVnd: string | null | undefined,
): string {
  const minFormatted = formatRecruitmentPostVnd(minVnd);
  const maxFormatted = formatRecruitmentPostVnd(maxVnd);
  const hasMin = minFormatted !== RECRUITMENT_POST_UNPROVIDED_LABEL;
  const hasMax = maxFormatted !== RECRUITMENT_POST_UNPROVIDED_LABEL;
  if (hasMin && hasMax) {
    return minFormatted === maxFormatted
      ? minFormatted
      : `${minFormatted} – ${maxFormatted}`;
  }
  if (hasMin) {
    return `Từ ${minFormatted}`;
  }
  if (hasMax) {
    return `Đến ${maxFormatted}`;
  }
  return RECRUITMENT_POST_UNPROVIDED_LABEL;
}

export function formatRecruitmentPostTimestampVi(
  isoUtc: string | null | undefined,
): string {
  if (typeof isoUtc !== "string" || isoUtc.trim().length === 0) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const date = new Date(isoUtc.trim());
  if (Number.isNaN(date.getTime())) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Maps a validated `RecruitmentPostItem` into the compact 10-item summary card view-model
 * defined in Master Plan lines 585–599.
 */
export function toRecruitmentPostCardViewModel(
  item: RecruitmentPostItem,
): RecruitmentPostCardViewModel {
  const projectName = formatRecruitmentPostText(item.project.display_name);
  const customerNameDisplay = formatRecruitmentPostText(
    item.general.customer_name,
  );
  const provinceName = formatRecruitmentPostText(item.province.display_name);
  const industrialParkName = formatRecruitmentPostText(
    item.industrial_park.display_name,
  );
  const locationDisplay = `${provinceName} · ${industrialParkName}`;
  const jobDescriptionDisplay = formatRecruitmentPostText(
    item.general.job_description,
  );
  const laborTypesDisplay =
    item.general.labor_types.length > 0
      ? item.general.labor_types.map((lt) => lt.display_name).join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;
  const expectedHeadcountDisplay = formatRecruitmentPostHeadcount(
    item.general.expected_headcount,
  );
  const genderDisplay =
    GENDER_REQUIREMENT_LABELS[item.candidate.gender_requirement] ??
    RECRUITMENT_POST_UNPROVIDED_LABEL;
  const ageRangeDisplay = formatRecruitmentPostAgeRange(
    item.candidate.age_min,
    item.candidate.age_max,
  );
  const genderAndAgeDisplay = `${genderDisplay} · Độ tuổi: ${ageRangeDisplay}`;
  const baseSalaryDisplay = formatRecruitmentPostVnd(
    item.compensation.base_salary_vnd,
  );
  const incomeRangeDisplay = formatRecruitmentPostIncomeRange(
    item.compensation.average_income_min_vnd,
    item.compensation.average_income_max_vnd,
  );
  const baseSalaryAndIncomeDisplay = `LCB: ${baseSalaryDisplay} · Thu nhập: ${incomeRangeDisplay}`;
  const managerNameDisplay = formatRecruitmentPostText(
    item.general.manager_name,
  );
  const managerPhoneDisplay = formatRecruitmentPostText(
    item.general.manager_phone,
  );
  const managerContactDisplay = `${managerNameDisplay} · ${managerPhoneDisplay}`;
  const createdByDisplayName = formatRecruitmentPostText(
    item.created_by_display_name,
  );
  const updatedAtDisplay = formatRecruitmentPostTimestampVi(item.updated_at);
  const createdByAndUpdatedAtDisplay = `${createdByDisplayName} · ${updatedAtDisplay}`;

  return {
    briefId: item.brief_id,
    version: item.version,
    projectName,
    customerNameDisplay,
    provinceName,
    industrialParkName,
    locationDisplay,
    jobDescriptionDisplay,
    laborTypesDisplay,
    expectedHeadcountDisplay,
    genderDisplay,
    ageRangeDisplay,
    genderAndAgeDisplay,
    baseSalaryDisplay,
    incomeRangeDisplay,
    baseSalaryAndIncomeDisplay,
    managerNameDisplay,
    managerPhoneDisplay,
    managerContactDisplay,
    createdByDisplayName,
    updatedAtDisplay,
    createdByAndUpdatedAtDisplay,
    allowedActions: {
      canEdit: item.allowed_actions.can_edit,
      canWithdraw: item.allowed_actions.can_withdraw,
    },
  };
}

/**
 * Maps a validated `RecruitmentPostItem` into the 4-section BOD detail view-model
 * defined in Master Plan lines 276–383 and 609–619.
 */
export function toRecruitmentPostDetailViewModel(
  item: RecruitmentPostItem,
): RecruitmentPostDetailViewModel {
  const environmentTypesDisplay =
    item.general.environment_types.length > 0
      ? item.general.environment_types
          .map((code) => ENVIRONMENT_TYPE_LABELS[code] ?? code)
          .join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const workPosturesDisplay =
    item.general.work_postures.length > 0
      ? item.general.work_postures
          .map((code) => WORK_POSTURE_LABELS[code] ?? code)
          .join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const shiftPatternDisplay =
    SHIFT_PATTERN_LABELS[item.general.shift_pattern] ??
    RECRUITMENT_POST_UNPROVIDED_LABEL;

  const laborTypesDisplay =
    item.general.labor_types.length > 0
      ? item.general.labor_types.map((lt) => lt.display_name).join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const formatDocRequired = (required: boolean): string =>
    required ? "Có yêu cầu" : "Không";

  return {
    briefId: item.brief_id,
    version: item.version,
    status: item.status,
    projectId: item.project.project_id,
    industrialParkId: item.industrial_park.industrial_park_id,
    createdByDisplayName: formatRecruitmentPostText(
      item.created_by_display_name,
    ),
    updatedByDisplayName: formatRecruitmentPostText(
      item.updated_by_display_name,
    ),
    publishedAtDisplay: formatRecruitmentPostTimestampVi(item.published_at),
    updatedAtDisplay: formatRecruitmentPostTimestampVi(item.updated_at),
    allowedActions: {
      canEdit: item.allowed_actions.can_edit,
      canWithdraw: item.allowed_actions.can_withdraw,
    },
    section1General: {
      projectName: formatRecruitmentPostText(item.project.display_name),
      industrialParkName: formatRecruitmentPostText(
        item.industrial_park.display_name,
      ),
      provinceName: formatRecruitmentPostText(item.province.display_name),
      customerNameDisplay: formatRecruitmentPostText(
        item.general.customer_name,
      ),
      investmentOriginDisplay: formatRecruitmentPostText(
        item.general.investment_origin,
      ),
      manufacturingIndustryDisplay: formatRecruitmentPostText(
        item.general.manufacturing_industry,
      ),
      jobDescriptionDisplay: formatRecruitmentPostText(
        item.general.job_description,
      ),
      environmentTypesDisplay,
      workPosturesDisplay,
      shiftPatternDisplay,
      shiftDetailsDisplay: formatRecruitmentPostText(
        item.general.shift_details,
      ),
      managerNameDisplay: formatRecruitmentPostText(item.general.manager_name),
      managerPhoneDisplay: formatRecruitmentPostText(
        item.general.manager_phone,
      ),
      laborTypesDisplay,
      supplyScheduleTextDisplay: formatRecruitmentPostText(
        item.general.supply_schedule_text,
      ),
      expectedHeadcountDisplay: formatRecruitmentPostHeadcount(
        item.general.expected_headcount,
      ),
    },
    section2CandidateRequirements: {
      ageFromDisplay: formatRecruitmentPostAgeBound(item.candidate.age_min),
      ageToDisplay: formatRecruitmentPostAgeBound(item.candidate.age_max),
      genderDisplay:
        GENDER_REQUIREMENT_LABELS[item.candidate.gender_requirement] ??
        RECRUITMENT_POST_UNPROVIDED_LABEL,
      minimumEducationDisplay:
        EDUCATION_REQUIREMENT_LABELS[item.candidate.education_requirement] ??
        RECRUITMENT_POST_UNPROVIDED_LABEL,
      experienceRequiredDisplay: item.candidate.experience_required
        ? "Có"
        : "Không",
      experienceDetailsDisplay: item.candidate.experience_required
        ? formatRecruitmentPostText(item.candidate.experience_details)
        : "Không yêu cầu kinh nghiệm",
      acceptsFormerWorkersDisplay: item.candidate.accept_former_customer_workers
        ? "Có nhận"
        : "Không nhận",
      entryTestFormatDisplay: formatRecruitmentPostText(
        item.candidate.entry_assessment_text,
      ),
      otherRequirementsDisplay: formatRecruitmentPostText(
        item.candidate.other_requirements_text,
      ),
    },
    section3CompensationBenefits: {
      baseSalaryVndDisplay: formatRecruitmentPostVnd(
        item.compensation.base_salary_vnd,
      ),
      baseSalaryConditionsDisplay: formatRecruitmentPostText(
        item.compensation.base_salary_conditions,
      ),
      attendanceBonusVndDisplay: formatRecruitmentPostVnd(
        item.compensation.attendance_bonus_vnd,
      ),
      attendanceBonusConditionsDisplay: formatRecruitmentPostText(
        item.compensation.attendance_bonus_conditions,
      ),
      livingAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.living_allowance_vnd,
      ),
      livingAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.living_allowance_conditions,
      ),
      seniorityAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.seniority_allowance_vnd,
      ),
      seniorityAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.seniority_allowance_conditions,
      ),
      eyesightAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.eyesight_allowance_vnd,
      ),
      eyesightAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.eyesight_allowance_conditions,
      ),
      otherAllowanceTextDisplay: formatRecruitmentPostText(
        item.compensation.other_allowance_text,
      ),
      averageIncomeMinVndDisplay: formatRecruitmentPostVnd(
        item.compensation.average_income_min_vnd,
      ),
      averageIncomeMaxVndDisplay: formatRecruitmentPostVnd(
        item.compensation.average_income_max_vnd,
      ),
      salaryPaymentScheduleDisplay: formatRecruitmentPostText(
        item.compensation.salary_payment_schedule,
      ),
      salaryAdvanceAvailableDisplay: item.compensation.salary_advance_available
        ? "Có"
        : "Không",
      salaryAdvanceAmountVndDisplay: item.compensation.salary_advance_available
        ? formatRecruitmentPostVnd(item.compensation.salary_advance_amount_vnd)
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      salaryAdvanceScheduleDisplay: item.compensation.salary_advance_available
        ? formatRecruitmentPostText(item.compensation.salary_advance_schedule)
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      weeklySalaryAvailableDisplay: item.compensation.weekly_salary_available
        ? "Có"
        : "Không",
      weeklySalaryPaymentScheduleDisplay: item.compensation
        .weekly_salary_available
        ? formatRecruitmentPostText(
            item.compensation.weekly_salary_payment_schedule,
          )
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      dayShift8hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.day_shift_8h_vnd,
      ),
      dayShift11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.day_shift_11h_vnd,
      ),
      nightShift8hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.night_shift_8h_vnd,
      ),
      nightShift11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.night_shift_11h_vnd,
      ),
      sundayDay11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.sunday_day_11h_vnd,
      ),
      sundayNight11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.sunday_night_11h_vnd,
      ),
      holidayDay11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.holiday_day_11h_vnd,
      ),
      holidayNight11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.holiday_night_11h_vnd,
      ),
      ppeProvidedDisplay: item.compensation.ppe_provided
        ? "Có cấp phát"
        : "Không",
      ppeDetailsDisplay: formatRecruitmentPostText(
        item.compensation.ppe_details,
      ),
      otherBenefitsDisplay: formatRecruitmentPostText(
        item.compensation.other_benefits,
      ),
    },
    section4ApplicationDocuments: {
      requireOriginalCccdAndCopy:
        item.documents.require_original_cccd_and_copy,
      requireOriginalCccdAndCopyDisplay: formatDocRequired(
        item.documents.require_original_cccd_and_copy,
      ),
      requireCertifiedResume: item.documents.require_certified_resume,
      requireCertifiedResumeDisplay: formatDocRequired(
        item.documents.require_certified_resume,
      ),
      requireHealthCertificateWithin6Months:
        item.documents.require_health_certificate_within_6_months,
      requireHealthCertificateWithin6MonthsDisplay: formatDocRequired(
        item.documents.require_health_certificate_within_6_months,
      ),
      requirePhoto3x4: item.documents.require_photo_3x4,
      requirePhoto3x4Display: formatDocRequired(
        item.documents.require_photo_3x4,
      ),
      requireDegreeOrCertificate: item.documents.require_degree_or_certificate,
      requireDegreeOrCertificateDisplay: formatDocRequired(
        item.documents.require_degree_or_certificate,
      ),
      requireSocialInsuranceBook: item.documents.require_social_insurance_book,
      requireSocialInsuranceBookDisplay: formatDocRequired(
        item.documents.require_social_insurance_book,
      ),
      requireOtherDocuments: item.documents.require_other_documents,
      requireOtherDocumentsDisplay: formatDocRequired(
        item.documents.require_other_documents,
      ),
      otherDocumentsTextDisplay: item.documents.require_other_documents
        ? formatRecruitmentPostText(item.documents.other_documents_text)
        : "Không yêu cầu giấy tờ khác",
    },
  };
}

// -----------------------------------------------------------------------------
// Filter synchronization & URL query builders
// -----------------------------------------------------------------------------

export function hasActiveRecruitmentPostFilters(
  filters: RecruitmentPostFeedFilterState,
): boolean {
  return (
    filters.projectId.trim() !== "" ||
    filters.provinceId.trim() !== "" ||
    filters.industrialParkId.trim() !== "" ||
    filters.laborTypeKey.trim() !== "" ||
    filters.updatedFrom.trim() !== "" ||
    filters.updatedTo.trim() !== ""
  );
}

/**
 * Returns active provinces for filter selection.
 */
export function visibleProvincesForFilter(
  provinces: readonly RecruitmentPostProvinceOption[],
): RecruitmentPostProvinceOption[] {
  return provinces.filter((province) => province.active === true);
}

/**
 * Returns active industrial parks for filter selection, restricted to `provinceId`
 * when a province is selected (Master Plan lines 578–581).
 */
export function visibleIndustrialParksForFilter(
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
  provinceId: string,
): RecruitmentPostIndustrialParkOption[] {
  const normalizedProvinceId = provinceId.trim();
  return industrialParks.filter((park) => {
    if (!park.active) return false;
    if (normalizedProvinceId !== "" && park.province_id !== normalizedProvinceId) {
      return false;
    }
    return true;
  });
}

/**
 * Returns active labor types for filter selection.
 */
export function visibleLaborTypesForFilter(
  laborTypes: readonly RecruitmentPostLaborTypeOption[],
): RecruitmentPostLaborTypeOption[] {
  return laborTypes.filter((laborType) => laborType.active === true);
}

/**
 * Applies a Province filter change:
 * - Updates `provinceId`.
 * - Clears `industrialParkId` if it does not belong to the newly selected province
 *   (Master Plan line 580: "Đổi tỉnh làm mất KCN không tương thích").
 */
export function applyProvinceFilterChange(
  current: RecruitmentPostFeedFilterState,
  nextProvinceId: string,
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
): RecruitmentPostFeedFilterState {
  const normalizedProvinceId = nextProvinceId.trim();
  if (normalizedProvinceId === "") {
    return {
      ...current,
      provinceId: "",
    };
  }
  const selectedPark = industrialParks.find(
    (park) =>
      park.active && park.industrial_park_id === current.industrialParkId,
  );
  const keepPark =
    selectedPark !== undefined &&
    selectedPark.province_id === normalizedProvinceId;
  return {
    ...current,
    provinceId: normalizedProvinceId,
    industrialParkId: keepPark ? current.industrialParkId : "",
  };
}

/**
 * Applies an Industrial Park filter change:
 * - Updates `industrialParkId`.
 * - Automatically derives and synchronizes `provinceId` from the selected industrial park
 *   (Master Plan line 579: "Chọn KCN thì tỉnh được suy ra và đồng bộ").
 */
export function applyIndustrialParkFilterChange(
  current: RecruitmentPostFeedFilterState,
  nextIndustrialParkId: string,
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
): RecruitmentPostFeedFilterState {
  const normalizedParkId = nextIndustrialParkId.trim();
  if (normalizedParkId === "") {
    return {
      ...current,
      industrialParkId: "",
    };
  }
  const matchedPark = industrialParks.find(
    (park) => park.active && park.industrial_park_id === normalizedParkId,
  );
  if (!matchedPark) {
    return {
      ...current,
      industrialParkId: "",
    };
  }
  return {
    ...current,
    industrialParkId: matchedPark.industrial_park_id,
    provinceId: matchedPark.province_id,
  };
}

export function validateRecruitmentPostFeedFilters(
  filters: RecruitmentPostFeedFilterState,
): { ok: true } | { ok: false; message: string } {
  const from = filters.updatedFrom.trim();
  const to = filters.updatedTo.trim();
  if (from !== "" && !isRealCalendarDate(from)) {
    return {
      ok: false,
      message: "Ngày bắt đầu cập nhật không hợp lệ.",
    };
  }
  if (to !== "" && !isRealCalendarDate(to)) {
    return {
      ok: false,
      message: "Ngày kết thúc cập nhật không hợp lệ.",
    };
  }
  if (from !== "" && to !== "" && from > to) {
    return {
      ok: false,
      message:
        "Khoảng ngày cập nhật không hợp lệ: 'Từ ngày' không được lớn hơn 'Đến ngày'.",
    };
  }
  return { ok: true };
}

/**
 * Builds the `GET /api/recruitment-posts` URL adhering strictly to `parseListRecruitmentPostsQuery`.
 * - Uses `page_size=10` (`DEFAULT_RECRUITMENT_POST_PAGE_SIZE`).
 * - Includes both `snapshot_token` and `cursor` when loading subsequent batches.
 */
export function buildRecruitmentPostListUrl(
  filters: RecruitmentPostFeedFilterState,
  pagination?: {
    cursor?: string | null;
    snapshotToken?: string | null;
    pageSize?: number;
  },
): string {
  const params = new URLSearchParams();
  const projectId = filters.projectId.trim();
  const provinceId = filters.provinceId.trim();
  const industrialParkId = filters.industrialParkId.trim();
  const laborTypeKey = filters.laborTypeKey.trim();
  const updatedFrom = filters.updatedFrom.trim();
  const updatedTo = filters.updatedTo.trim();

  if (projectId !== "") params.set("project_id", projectId);
  if (provinceId !== "") params.set("province_id", provinceId);
  if (industrialParkId !== "") {
    params.set("industrial_park_id", industrialParkId);
  }
  if (laborTypeKey !== "") params.set("labor_type_key", laborTypeKey);
  if (updatedFrom !== "") params.set("updated_from", updatedFrom);
  if (updatedTo !== "") params.set("updated_to", updatedTo);

  const pageSize = pagination?.pageSize ?? DEFAULT_RECRUITMENT_POST_PAGE_SIZE;
  params.set("page_size", String(pageSize));

  const cursor = pagination?.cursor?.trim() ?? "";
  const snapshotToken = pagination?.snapshotToken?.trim() ?? "";
  if (cursor !== "" && snapshotToken !== "") {
    params.set("snapshot_token", snapshotToken);
    params.set("cursor", cursor);
  }

  return `/api/recruitment-posts?${params.toString()}`;
}

/**
 * Appends a new cursor page of `RecruitmentPostItem`s without duplicating `brief_id`.
 * Never collapses distinct `brief_id`s that share `(project_id, industrial_park_id)`.
 */
export function mergeUniqueRecruitmentPostItems(
  current: readonly RecruitmentPostItem[],
  incoming: readonly RecruitmentPostItem[],
): RecruitmentPostItem[] {
  const result: RecruitmentPostItem[] = [];
  const indexById = new Map<string, number>();

  for (const item of current) {
    indexById.set(item.brief_id, result.length);
    result.push(item);
  }

  for (const item of incoming) {
    const existingIndex = indexById.get(item.brief_id);
    if (existingIndex !== undefined) {
      result[existingIndex] = item;
    } else {
      indexById.set(item.brief_id, result.length);
      result.push(item);
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// API Envelope Parsers & Fail-Closed Access Revocation Handling
// -----------------------------------------------------------------------------

export function extractRecruitmentPostErrorCode(
  payload: unknown,
): string | null {
  if (!isPlainRecord(payload)) return null;
  if (payload.ok !== false) return null;
  return typeof payload.code === "string" && payload.code.trim().length > 0
    ? payload.code.trim()
    : null;
}

export function parseRecruitmentPostContextEnvelope(
  payload: unknown,
): RecruitmentPostContext | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostContext(payload.data);
}

export function parseRecruitmentPostListEnvelope(
  payload: unknown,
): RecruitmentPostList | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostList(payload.data);
}

export function parseRecruitmentPostDetailEnvelope(
  payload: unknown,
): RecruitmentPostGetResult | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostGet(payload.data);
}

export function classifyRecruitmentPostAccessLoss(
  status: number,
  code: string | null,
): RecruitmentPostAccessLossKind | null {
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    if (code === "ACTOR_NOT_AVAILABLE") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "ACCESS_DENIED";
  }
  return null;
}

/**
 * Returns a clean empty state object used when `401` or `403` occurs so all feed items,
 * detail projections, customer names, and manager phone numbers are immediately purged from memory.
 */
export function createEmptyRecruitmentPostDataState(): RecruitmentPostDataState {
  return {
    context: null,
    items: [],
    selectedDetail: null,
    detailOpen: false,
    detailBriefId: null,
    detailError: null,
    nextCursor: null,
    snapshotToken: null,
    hasMore: false,
  };
}

export type RecruitmentPostContextOutcome =
  | {
      readonly kind: "ok";
      readonly context: RecruitmentPostContext;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

export function recruitmentPostContextErrorMessage(
  code: string | null,
): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng.";
    case "RECRUITMENT_POST_ACCESS_DENIED":
      return "Bạn không có quyền truy cập ngữ cảnh bộ lọc tin tuyển dụng.";
    case "RECRUITMENT_POST_UNAVAILABLE":
    default:
      return "Không thể tải danh mục bộ lọc (Dự án, Tỉnh/Thành, KCN, Hình thức tuyển dụng) lúc này. Vui lòng thử tải lại ngữ cảnh.";
  }
}

/**
 * Evaluates the HTTP status + parsed JSON body of `GET /api/recruitment-posts/context`
 * fail-closed so `503` or malformed `200` payloads never fail silently while the feed list renders.
 */
export function resolveRecruitmentPostContextOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
}): RecruitmentPostContextOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status < 200 || input.status >= 300) {
    const resolvedCode = errorCode ?? "RECRUITMENT_POST_UNAVAILABLE";
    return {
      kind: "error",
      code: resolvedCode,
      message: recruitmentPostContextErrorMessage(resolvedCode),
    };
  }

  const parsedContext = parseRecruitmentPostContextEnvelope(input.payload);
  if (!parsedContext) {
    return {
      kind: "error",
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostContextErrorMessage(
        "RECRUITMENT_POST_UNAVAILABLE",
      ),
    };
  }

  return {
    kind: "ok",
    context: parsedContext,
  };
}

export function recruitmentPostErrorMessage(code: string | null): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng.";
    case "RECRUITMENT_POST_ACCESS_DENIED":
      return "Bạn không có quyền thực hiện thao tác này.";
    case "RECRUITMENT_POST_NOT_FOUND":
      return "Tin tuyển dụng không tồn tại hoặc đã bị rút.";
    case "RECRUITMENT_POST_INPUT_INVALID":
    case "RECRUITMENT_POST_CONTENT_INVALID":
      return "Tham số truy vấn không hợp lệ.";
    case "RECRUITMENT_POST_UNAVAILABLE":
    default:
      return "Không thể tải dữ liệu tin tuyển dụng lúc này. Vui lòng thử lại.";
  }
}
