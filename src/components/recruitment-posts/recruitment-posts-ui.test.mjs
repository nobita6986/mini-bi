import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function resolveCandidatePath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
    if (specifier.startsWith("@/")) {
      const target = resolveCandidatePath(path.join(repoRoot, "src", specifier.slice(2)));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return {
        format: "module",
        source: "export default new Proxy({}, { get: (_, prop) => String(prop) });",
        shortCircuit: true,
      };
    }
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      let sourceText = readFileSync(filePath, "utf8");
      if (url.endsWith("/src/components/ui/form-dialog.tsx")) {
        sourceText = sourceText.replace(
          'import { Dialog } from "radix-ui";',
          `import { createElement, Fragment } from "react";
const Dialog = {
  Root: ({ open, children }: any) => (open ? createElement(Fragment, null, children) : null),
  Trigger: ({ children }: any) => createElement(Fragment, null, children),
  Portal: ({ children }: any) => createElement(Fragment, null, children),
  Overlay: (props: any) => createElement("div", props),
  Content: ({ onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...props }: any) =>
    createElement("div", { role: "dialog", ...props }),
  Title: (props: any) => createElement("h2", props),
  Description: (props: any) => createElement("p", props),
  Close: ({ children }: any) => createElement(Fragment, null, children),
};`,
        );
      }
      const transpiled = ts.transpileModule(sourceText, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  RECRUITMENT_POST_UNPROVIDED_LABEL,
  applyRecruitmentPostFirstPageOutcome,
  beginRecruitmentPostContextRequest,
  canRepostWithdrawnRecruitmentPost,
  classifyRecruitmentPostAccessLoss,
  clearRecruitmentPostFeedItemsPreservingContext,
  createCreateRecruitmentPostFormDraftFromItem,
  createEditRecruitmentPostFormDraftFromItem,
  createEmptyRecruitmentPostDataState,
  createEmptyRecruitmentPostFormDraft,
  createLatestRequestTracker,
  exportRecruitmentPostDetailMarkdown,
  mergeUniqueRecruitmentPostItems,
  recruitmentPostContextErrorMessage,
  resolveRecruitmentPostContextOutcome,
  resolveRecruitmentPostCopyFromOutcome,
  resolveRecruitmentPostListOutcome,
  settleRecruitmentPostContextRequest,
  toRecruitmentPostCardViewModel,
  toRecruitmentPostDetailViewModel,
} = await import("@/lib/recruitment-posts/recruitment-post-ui-model");

const { RecruitmentPostCard } = await import(
  "@/components/recruitment-posts/recruitment-post-card"
);
const { RecruitmentPostDetailDialog } = await import(
  "@/components/recruitment-posts/recruitment-post-detail-dialog"
);
const { RecruitmentPostFeedWorkspace } = await import(
  "@/components/recruitment-posts/recruitment-post-feed-workspace"
);
const { RecruitmentPostForm } = await import(
  "@/components/recruitment-posts/recruitment-post-form"
);
const { RecruitmentPostWithdrawDialog } = await import(
  "@/components/recruitment-posts/recruitment-post-withdraw-dialog"
);
const { ProvinceCatalogManager } = await import(
  "@/components/admin/province-catalog-manager"
);
const { IndustrialParkCatalogManager } = await import(
  "@/components/admin/industrial-park-catalog-manager"
);

const PROVINCE_VP_ID = "11111111-1111-4111-8111-111111111111";
const PARK_KHAI_QUANG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARK_INACTIVE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeBriefId(index) {
  const hex = String(index).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

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
    allowed_actions: {
      can_edit: true,
      can_withdraw: true,
    },
    ...overrides,
  };
}

describe("Phase 3 — Recruitment Posts UI & Architecture Gate", () => {
  it("enforces Server Component page & layout guards without leaking Vendor Finance flag", () => {
    const pageSrc = readRel("src/app/recruitment-posts/page.tsx");
    const layoutSrc = readRel("src/app/recruitment-posts/layout.tsx");
    const appShellSrc = readRel("src/components/app-shell/app-shell.tsx");
    const desktopNavSrc = readRel("src/components/app-shell/desktop-nav.tsx");
    const mobileNavSrc = readRel("src/components/app-shell/mobile-nav.tsx");

    assert.match(pageSrc, /export const dynamic = "force-dynamic"/);
    assert.match(pageSrc, /await connection\(\)/);
    assert.match(pageSrc, /resolveActorForRequest\(\)\.catch\(\(\) => null\)/);
    assert.match(pageSrc, /decideRecruitmentPostsPageAccess/);
    assert.match(pageSrc, /notFound\(\)/);
    assert.match(pageSrc, /redirect\("\/login\?next=%2Frecruitment-posts"\)/);
    assert.match(pageSrc, /<AccountUnavailable \/>/);
    assert.match(pageSrc, /<TemporaryUnavailable \/>/);
    assert.match(pageSrc, /parseRecruitmentPostFeedTab\(resolvedSearchParams\?\.tab\)/);
    assert.match(pageSrc, /<RecruitmentPostFeedWorkspace initialTab=\{initialTab\} \/>/);

    assert.match(layoutSrc, /export const dynamic = "force-dynamic"/);
    assert.match(layoutSrc, /<AppShell actor=\{actor\}>\{children\}<\/AppShell>/);

    // Must use dedicated recruitmentPostsEnabled flag, not vendorFinanceEnabled
    assert.match(
      appShellSrc,
      /const recruitmentPostsEnabled = process\.env\.DIRECT_ENTRY_API_ENABLED === "true"/,
    );
    assert.match(
      appShellSrc,
      /\(entry\.id !== "recruitment-posts" \|\| recruitmentPostsEnabled\)/,
    );
    assert.doesNotMatch(
      appShellSrc,
      /entry\.id !== "recruitment-posts" \|\| vendorFinanceEnabled/,
    );

    assert.match(desktopNavSrc, /"recruitment-posts": ClipboardList/);
    assert.match(mobileNavSrc, /"recruitment-posts": ClipboardList/);
  });

  it("renders RecruitmentPostCard with all 10 BOD summary items, export button, and creator display name as manager contact", () => {
    const fullCard = toRecruitmentPostCardViewModel(makeCompleteItem());
    const html = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: fullCard,
        onViewDetail: () => {},
        onExport: () => {},
      }),
    );

    // 10 summary items from Master Plan
    assert.match(html, /Dự án Điện tử ABC/);
    assert.match(html, /Công ty TNHH Linh Kiện Điện Tử ABC/);
    assert.match(html, /Vĩnh Phúc · KCN Khai Quang/);
    assert.match(html, /Lắp ráp bảng mạch, kiểm tra ngoại quan bằng kính hiển vi\./);
    assert.match(html, /Chính thức, Thời vụ/);
    assert.match(html, /150 người/);
    assert.match(html, /Cặp Nam\/Nữ · Độ tuổi: 18 – 38 tuổi/);
    assert.match(html, /LCB:\s*5\.500\.000\s*₫\s*·\s*Thu nhập:\s*9\.500\.000\s*₫\s*–\s*13\.500\.000\s*₫/);
    assert.match(html, /Nguyễn Văn Quản Lý · 0912345678/);
    assert.doesNotMatch(html, /Trần Thị PM/);
    assert.match(html, /Xem chi tiết/);
    assert.match(html, /data-testid="recruitment-post-export"/);
    assert.match(html, /Xuất bản tin/);

    // Exporting state disables button and shows loading label
    const exportingHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: fullCard,
        onViewDetail: () => {},
        onExport: () => {},
        isExporting: true,
      }),
    );
    assert.match(
      exportingHtml,
      /<button[^>]*disabled=""[^>]*data-testid="recruitment-post-export"[^>]*>Đang xuất…<\/button>/,
    );

    // Regression: general.manager_name = "yenlh.td" and created_by_display_name = "Lê Thị Hải Yến"
    const loginManagerCard = toRecruitmentPostCardViewModel(
      makeCompleteItem({
        created_by_display_name: "Lê Thị Hải Yến",
        updated_by_display_name: "Lê Thị Hải Yến",
        general: {
          ...makeCompleteItem().general,
          manager_name: "yenlh.td",
          manager_phone: "0912345678",
        },
      }),
    );
    const loginCardHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: loginManagerCard,
        onViewDetail: () => {},
      }),
    );
    assert.match(loginCardHtml, /Lê Thị Hải Yến · 0912345678/);
    assert.doesNotMatch(loginCardHtml, /yenlh\.td/);

    // Must not render duplicate currency unit or Phase 4 buttons when not allowed
    assert.doesNotMatch(html, /₫\s*đ/);
    assert.doesNotMatch(html, /Tạo phiếu tuyển dụng/);
    assert.doesNotMatch(html, />Sửa</);
    assert.doesNotMatch(html, />Rút tin</);

    // Sparse item fallback + Phase 4 allowedActions rendering
    const sparseCard = toRecruitmentPostCardViewModel(makeSparseItem());
    const sparseHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: sparseCard,
        onViewDetail: () => {},
        onWithdraw: () => {},
      }),
    );
    assert.match(sparseHtml, new RegExp(RECRUITMENT_POST_UNPROVIDED_LABEL));
    assert.match(sparseHtml, />Sửa</);
    assert.match(sparseHtml, />Rút tin</);
  });

  it("renders RecruitmentPostDetailDialog with all 4 BOD sections, 8 shift wages, loading and error states", () => {
    const detailVm = toRecruitmentPostDetailViewModel(
      makeCompleteItem({
        created_by_display_name: "Lê Thị Hải Yến",
        updated_by_display_name: "Lê Thị Hải Yến",
        general: {
          ...makeCompleteItem().general,
          manager_name: "yenlh.td",
          manager_phone: "0912345678",
        },
      }),
    );
    const html = renderToStaticMarkup(
      createElement(RecruitmentPostDetailDialog, {
        open: true,
        onOpenChange: () => {},
        detail: detailVm,
        loading: false,
        error: null,
        onRetry: () => {},
      }),
    );

    // Wide dialog class
    assert.match(html, /sm:w-\[min\(56rem,calc\(100vw-2rem\)\)\]/);

    // 4 BOD sections
    assert.match(html, /1\. Thông tin chung dự án/);
    assert.match(html, /2\. Yêu cầu ứng viên/);
    assert.match(html, /3\. Lương, thưởng và phúc lợi/);
    assert.match(html, /4\. Hồ sơ ứng viên cần chuẩn bị/);

    // Section 1 fields (uses created_by_display_name "Lê Thị Hải Yến" and never "yenlh.td")
    assert.match(html, /Dự án Điện tử ABC/);
    assert.match(html, /Công ty TNHH Linh Kiện Điện Tử ABC/);
    assert.match(html, /Vĩnh Phúc/);
    assert.match(html, /KCN Khai Quang/);
    assert.match(html, /Hàn Quốc/);
    assert.match(html, /Linh kiện điện tử &amp; bán dẫn/);
    assert.match(html, /Phòng sạch, Phòng bán sạch/);
    assert.match(html, /Ngồi, Đứng/);
    assert.match(html, /Hai ca/);
    assert.match(html, /Lê Thị Hải Yến/);
    assert.match(html, /0912345678/);
    assert.doesNotMatch(html, /yenlh\.td/);

    // Section 2 fields
    assert.match(html, /Cặp Nam\/Nữ/);
    assert.match(html, /THCS \(Cấp 2\)/);
    assert.match(html, />Có</);
    assert.match(html, /Có nhận/);
    assert.match(html, /Test bảng chữ cái và phỏng vấn trực tiếp/);

    // Section 3 fields (base salary + bonuses + 8 shift wages formatted via formatVndMinor)
    assert.match(html, /5\.500\.000\s*₫/);
    assert.match(html, /500\.000\s*₫/);
    assert.match(html, /600\.000\s*₫/);
    assert.match(html, /300\.000\s*₫/);
    assert.match(html, /400\.000\s*₫/);
    assert.match(html, /9\.500\.000\s*₫/);
    assert.match(html, /13\.500\.000\s*₫/);
    assert.match(html, /2\.000\.000\s*₫/);
    assert.match(html, /220\.000\s*₫/);
    assert.match(html, /310\.000\s*₫/);
    assert.match(html, /260\.000\s*₫/);
    assert.match(html, /365\.000\s*₫/);
    assert.match(html, /450\.000\s*₫/);
    assert.match(html, /520\.000\s*₫/);
    assert.match(html, /660\.000\s*₫/);
    assert.match(html, /750\.000\s*₫/);
    assert.doesNotMatch(html, /₫\s*đ/);

    // Section 4 fields
    assert.match(html, /CCCD gốc và bản sao/);
    assert.match(html, /Sơ yếu lý lịch có xác nhận/);
    assert.match(html, /Giấy khám sức khỏe trong vòng 6 tháng/);
    assert.match(html, /Ảnh 3x4/);
    assert.match(html, /Bằng cấp hoặc chứng chỉ/);
    assert.match(html, /Sổ BHXH/);
    assert.match(html, /02 bản photo CCCD công chứng và xác nhận cư trú CT07/);

    // Loading state
    const loadingHtml = renderToStaticMarkup(
      createElement(RecruitmentPostDetailDialog, {
        open: true,
        onOpenChange: () => {},
        detail: null,
        loading: true,
        error: null,
        onRetry: () => {},
      }),
    );
    assert.match(loadingHtml, /Đang tải chi tiết tin tuyển dụng/);

    // Error state
    const errorHtml = renderToStaticMarkup(
      createElement(RecruitmentPostDetailDialog, {
        open: true,
        onOpenChange: () => {},
        detail: null,
        loading: false,
        error: "Không thể tải chi tiết tin tuyển dụng.",
        onRetry: () => {},
      }),
    );
    assert.match(errorHtml, /Không thể tải chi tiết tin tuyển dụng\./);
    assert.match(errorHtml, /Thử lại/);
  });

  it("enforces filter accessibility, stale-response protection, and fail-closed 401/403 wiping in RecruitmentPostFeedWorkspace", () => {
    const workspaceSrc = readRel(
      "src/components/recruitment-posts/recruitment-post-feed-workspace.tsx",
    );

    // Accessible filter labels
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-project"/);
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-province"/);
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-park"/);
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-labor-type"/);
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-updated-from"/);
    assert.match(workspaceSrc, /htmlFor="recruitment-posts-filter-updated-to"/);
    assert.match(workspaceSrc, /Xóa bộ lọc/);

    // Synchronized Province/KCN filters
    assert.match(workspaceSrc, /visibleIndustrialParksForFilter/);
    assert.match(workspaceSrc, /applyProvinceFilterChange/);
    assert.match(workspaceSrc, /applyIndustrialParkFilterChange/);

    // Cursor pagination & deduplication
    assert.match(workspaceSrc, /CursorLoadMore/);
    assert.match(workspaceSrc, /mergeUniqueRecruitmentPostItems/);

    // Stale-response protection for context, feed, and detail
    assert.match(workspaceSrc, /getRequestTracker\(contextTrackerRef\)/);
    assert.match(workspaceSrc, /getRequestTracker\(feedTrackerRef\)/);
    assert.match(workspaceSrc, /getRequestTracker\(detailTrackerRef\)/);
    assert.match(workspaceSrc, /if \(!ticket\.isCurrent\(\)\) return/);

    // Fail-closed 401/403 state wiping
    assert.match(workspaceSrc, /classifyRecruitmentPostAccessLoss/);
    assert.match(workspaceSrc, /setDataState\(createEmptyRecruitmentPostDataState\(\)\)/);
    assert.match(workspaceSrc, /<AccessDenied \/>/);
    assert.match(workspaceSrc, /<AccountUnavailable \/>/);

    // Verify runtime state wiping + stale tracker simulation
    const feedTracker = createLatestRequestTracker();
    const detailTracker = createLatestRequestTracker();

    const populatedItem = makeCompleteItem();
    assert.equal(populatedItem.general.manager_phone, "0912345678");

    // Simulate 401/403 during detail or load-more
    for (const status of [401, 403]) {
      const revoked = classifyRecruitmentPostAccessLoss(status, null);
      assert.ok(revoked !== null);
      feedTracker.cancelAll();
      detailTracker.cancelAll();
      const wiped = createEmptyRecruitmentPostDataState();
      assert.deepEqual(wiped.items, []);
      assert.equal(wiped.selectedDetail, null);
      assert.equal(wiped.detailOpen, false);
      assert.equal(wiped.detailBriefId, null);
      assert.equal(wiped.nextCursor, null);
      assert.equal(wiped.snapshotToken, null);
      assert.equal(wiped.hasMore, false);
    }

    // Simulate switching detail A -> B where A finishes late
    const reqA = detailTracker.begin();
    const reqB = detailTracker.begin();
    assert.equal(reqA.signal.aborted, true);
    assert.equal(reqA.isCurrent(), false);
    assert.equal(reqB.isCurrent(), true);

    // Simulate load-more deduplication
    const itemA = makeCompleteItem({ brief_id: makeBriefId(1) });
    const itemB = makeCompleteItem({ brief_id: makeBriefId(2) });
    const merged = mergeUniqueRecruitmentPostItems([itemA], [itemA, itemB]);
    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((i) => i.brief_id),
      [makeBriefId(1), makeBriefId(2)],
    );
  });

  it("renders recognizable context error banner and retry button when context fails (503 or invalid payload) while feed list loads successfully, and preserves banner during retry transition", () => {
    const workspaceSrc = readRel(
      "src/components/recruitment-posts/recruitment-post-feed-workspace.tsx",
    );
    assert.match(
      workspaceSrc,
      /setContextRequestState\(\(prev\) => beginRecruitmentPostContextRequest\(prev\)\)/,
    );
    assert.match(
      workspaceSrc,
      /setContextRequestState\(settleRecruitmentPostContextRequest\(outcome\)\)/,
    );

    const outcome503 = resolveRecruitmentPostContextOutcome({
      status: 503,
      payload: { ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" },
    });
    assert.equal(outcome503.kind, "error");

    const outcomeInvalidJson = resolveRecruitmentPostContextOutcome({
      status: 200,
      payload: { ok: true, data: { corrupted: true } },
    });
    assert.equal(outcomeInvalidJson.kind, "error");
    assert.equal(
      outcomeInvalidJson.message,
      recruitmentPostContextErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
    );

    const feedItem = makeCompleteItem();

    // 1. Initial load begins: contextError is null, so banner does not flash while loading
    const initialContextState = beginRecruitmentPostContextRequest({
      contextLoading: true,
      contextError: null,
    });
    assert.deepEqual(initialContextState, {
      contextLoading: true,
      contextError: null,
    });
    const initialHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          ...initialContextState,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: null,
            items: [feedItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.doesNotMatch(
      initialHtml,
      /data-testid="recruitment-posts-context-error"/,
    );

    // 2. Context request settles with 503 error while feed list succeeded
    const settledAfter503State = settleRecruitmentPostContextOutcomeState(outcome503);
    function settleRecruitmentPostContextOutcomeState(outcome) {
      return settleRecruitmentPostContextRequest(outcome);
    }
    assert.deepEqual(settledAfter503State, {
      contextLoading: false,
      contextError: outcome503.message,
    });

    const htmlWithContextFailureAndLoadedList = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          ...settledAfter503State,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: null,
            items: [feedItem],
            hasMore: false,
          },
        },
      }),
    );

    // Context error banner + retry button must be rendered and recognizable
    assert.match(
      htmlWithContextFailureAndLoadedList,
      /data-testid="recruitment-posts-context-error"/,
    );
    assert.match(
      htmlWithContextFailureAndLoadedList,
      /Không thể tải ngữ cảnh bộ lọc/,
    );
    assert.match(
      htmlWithContextFailureAndLoadedList,
      /Không thể tải danh mục bộ lọc \(Dự án, Tỉnh\/Thành, KCN, Hình thức tuyển dụng\) lúc này\./,
    );
    assert.match(
      htmlWithContextFailureAndLoadedList,
      /data-testid="recruitment-posts-context-retry"/,
    );
    assert.match(htmlWithContextFailureAndLoadedList, /Thử tải lại ngữ cảnh/);

    // At the same time, the loaded recruitment post list must still be visible without feed error
    assert.doesNotMatch(
      htmlWithContextFailureAndLoadedList,
      /data-testid="recruitment-posts-feed-error"/,
    );
    assert.match(
      htmlWithContextFailureAndLoadedList,
      /data-testid="recruitment-posts-list"/,
    );
    assert.match(htmlWithContextFailureAndLoadedList, /Dự án Điện tử ABC/);

    // 3. User clicks "Thử tải lại ngữ cảnh" -> loadContext() calls beginRecruitmentPostContextRequest(settledAfter503State)
    // which MUST preserve contextError while setting contextLoading: true so the banner stays visible and shows "Đang tải lại…"
    const retryInFlightState =
      beginRecruitmentPostContextRequest(settledAfter503State);
    assert.deepEqual(retryInFlightState, {
      contextLoading: true,
      contextError: outcome503.message,
    });

    const retryingHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          ...retryInFlightState,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: null,
            items: [feedItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(
      retryingHtml,
      /data-testid="recruitment-posts-context-error"/,
    );
    assert.match(
      retryingHtml,
      /<button[^>]*disabled=""[^>]*data-testid="recruitment-posts-context-retry">Đang tải lại…<\/button>/,
    );

    // 4. Retry succeeds -> settleRecruitmentPostContextRequest clears contextError and hides the banner
    const outcomeOk = resolveRecruitmentPostContextOutcome({
      status: 200,
      payload: {
        ok: true,
        data: {
          can_create: false,
          managed_projects: [],
          filter_projects: [
            { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
          ],
          provinces: [
            {
              province_id: PROVINCE_VP_ID,
              province_code: "VINH_PHUC",
              display_name: "Vĩnh Phúc",
              active: true,
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
          ],
          labor_types: [
            {
              labor_type_key: "CHINH_THUC",
              display_name: "Chính thức",
              active: true,
            },
          ],
        },
      },
    });
    assert.equal(outcomeOk.kind, "ok");
    const recoveredState = settleRecruitmentPostContextRequest(outcomeOk);
    assert.deepEqual(recoveredState, {
      contextLoading: false,
      contextError: null,
    });

    const recoveredHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          ...recoveredState,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: outcomeOk.context,
            items: [feedItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.doesNotMatch(
      recoveredHtml,
      /data-testid="recruitment-posts-context-error"/,
    );
    assert.match(recoveredHtml, /<option value="PROJ_ABC">Dự án Điện tử ABC<\/option>/);
    assert.match(recoveredHtml, /<option value="CHINH_THUC">Chính thức<\/option>/);
  });

  it("contains zero hard-coded admin/BOD emails across all recruitment-posts modules", () => {
    const filesToCheck = [
      "src/lib/recruitment-posts/recruitment-post-ui-model.ts",
      "src/components/recruitment-posts/recruitment-post-card.tsx",
      "src/components/recruitment-posts/recruitment-post-detail-dialog.tsx",
      "src/components/recruitment-posts/recruitment-post-feed-workspace.tsx",
      "src/components/recruitment-posts/recruitment-post-form.tsx",
      "src/components/recruitment-posts/recruitment-post-withdraw-dialog.tsx",
      "src/app/recruitment-posts/layout.tsx",
      "src/app/recruitment-posts/page.tsx",
      "src/app/recruitment-posts/new/page.tsx",
      "src/app/recruitment-posts/[briefId]/edit/page.tsx",
      "src/lib/admin/location-catalog-model.ts",
      "src/components/admin/province-catalog-manager.tsx",
      "src/components/admin/industrial-park-catalog-manager.tsx",
      "src/app/admin/catalog/provinces/page.tsx",
      "src/app/admin/catalog/industrial-parks/page.tsx",
    ];

    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    for (const relPath of filesToCheck) {
      const content = readRel(relPath);
      assert.doesNotMatch(
        content,
        emailRegex,
        `Unexpected hard-coded email address found in ${relPath}`,
      );
    }
  });

  it("Phase 4: renders 'Tạo phiếu tuyển dụng' in feed only when can_create && managed_projects.length > 0, and renders Sửa/Rút tin on DetailDialog when allowed", () => {
    const sampleContextForPm = {
      can_create: true,
      managed_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      filter_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      provinces: [
        {
          province_id: PROVINCE_VP_ID,
          province_code: "VINH_PHUC",
          display_name: "Vĩnh Phúc",
          active: true,
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
      ],
      labor_types: [
        {
          labor_type_key: "CHINH_THUC",
          display_name: "Chính thức",
          active: true,
        },
      ],
    };

    const pmWorkspaceHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: sampleContextForPm,
            items: [
              makeCompleteItem({
                allowed_actions: { can_edit: true, can_withdraw: true },
              }),
            ],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(pmWorkspaceHtml, /data-testid="recruitment-posts-create-button"/);
    assert.match(pmWorkspaceHtml, /Tạo phiếu tuyển dụng/);
    assert.match(pmWorkspaceHtml, />Sửa</);
    assert.match(pmWorkspaceHtml, />Rút tin</);

    // Admin/BOD who is not a PM (can_create: false, managed_projects: []) must NOT see "Tạo phiếu tuyển dụng"
    const adminNonPmWorkspaceHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: {
              ...sampleContextForPm,
              can_create: false,
              managed_projects: [],
            },
            items: [
              makeCompleteItem({
                allowed_actions: { can_edit: true, can_withdraw: true },
              }),
            ],
            hasMore: false,
          },
        },
      }),
    );
    assert.doesNotMatch(
      adminNonPmWorkspaceHtml,
      /data-testid="recruitment-posts-create-button"/,
    );
    assert.match(adminNonPmWorkspaceHtml, />Sửa</);
    assert.match(adminNonPmWorkspaceHtml, />Rút tin</);

    // Detail dialog with canEdit & canWithdraw
    const editableDetail = toRecruitmentPostDetailViewModel(
      makeCompleteItem({
        allowed_actions: { can_edit: true, can_withdraw: true },
      }),
    );
    const editableDetailHtml = renderToStaticMarkup(
      createElement(RecruitmentPostDetailDialog, {
        open: true,
        onOpenChange: () => {},
        detail: editableDetail,
        loading: false,
        error: null,
        onRetry: () => {},
        onWithdraw: () => {},
      }),
    );
    assert.match(editableDetailHtml, /Sửa tin/);
    assert.match(editableDetailHtml, /Rút tin/);
  });

  it("Phase 4: renders RecruitmentPostForm (Create & Edit), 6-item pre-submit confirmation block, locked Project/KCN in Edit, OCC 409 reload-to-compare, ambiguous retry lock, and 403 read-only preservation", () => {
    const sampleContext = {
      can_create: true,
      managed_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      filter_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      provinces: [
        {
          province_id: PROVINCE_VP_ID,
          province_code: "VINH_PHUC",
          display_name: "Vĩnh Phúc",
          active: true,
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
      ],
      labor_types: [
        {
          labor_type_key: "THOI_VU",
          display_name: "Thời vụ",
          active: true,
        },
        {
          labor_type_key: "CHINH_THUC",
          display_name: "Chính thức",
          active: true,
        },
        {
          labor_type_key: "GIA_CONG",
          display_name: "Gia công",
          active: true,
        },
      ],
    };

    const createDraft = {
      ...createEmptyRecruitmentPostFormDraft("create"),
      projectId: "PROJ_ABC",
      industrialParkId: PARK_KHAI_QUANG_ID,
      customerName: "Công ty ABC",
      jobDescription: "Lắp ráp bo mạch điện tử",
      expectedHeadcount: "120",
      averageIncomeMinVnd: "9500000",
      averageIncomeMaxVnd: "12500000",
      managerName: "Tên Client Cố Tình Gửi",
      managerPhone: "0912345678",
    };

    const createHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Trần Thị PM",
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          draft: createDraft,
        },
      }),
    );

    // 4 BOD sections + NO standalone province input + NO missing KCN helper text + NO KCN search input + Project & KCN on same desktop row + NO manager name input + editable phone + 4 candidate fields in 1 desktop row + gender label "Cặp Nam/Nữ" + 6-item pre-submit confirmation block showing phone only
    assert.match(createHtml, /1\. Thông tin chung dự án/);
    assert.match(createHtml, /2\. Yêu cầu ứng viên/);
    assert.match(createHtml, /3\. Lương, thưởng và phúc lợi/);
    assert.match(createHtml, /4\. Hồ sơ ứng viên cần chuẩn bị/);
    assert.doesNotMatch(
      createHtml,
      /KCN chưa có trong danh mục\. Vui lòng liên hệ Admin\/BOD để bổ sung\./,
    );
    assert.doesNotMatch(
      createHtml,
      /data-testid="recruitment-post-missing-park-help"/,
    );
    assert.doesNotMatch(
      createHtml,
      /data-testid="recruitment-post-derived-province"/,
    );
    assert.doesNotMatch(createHtml, /data-testid="recruitment-post-search-park"/);
    assert.doesNotMatch(createHtml, /Gõ để tìm nhanh KCN/);
    assert.match(
      createHtml,
      /data-testid="recruitment-post-project-park-row"[^>]*class="[^"]*sm:grid-cols-2[^"]*"/,
    );
    assert.match(createHtml, /data-testid="recruitment-post-select-project"/);
    assert.match(createHtml, /data-testid="recruitment-post-select-park"/);

    // Consecutive checkbox cluster (Môi trường làm việc -> Tư thế làm việc -> Hình thức tuyển dụng)
    assert.match(
      createHtml,
      /data-testid="recruitment-post-checkbox-cluster"[^>]*class="[^"]*lg:flex-row[^"]*lg:flex-wrap[^"]*"/,
    );
    assert.match(createHtml, /data-testid="recruitment-post-env-CLEAN_ROOM"/);
    assert.match(createHtml, /data-testid="recruitment-post-env-NORMAL_ROOM"/);
    assert.match(createHtml, /data-testid="recruitment-post-env-SEMI_CLEAN_ROOM"/);
    assert.match(createHtml, /data-testid="recruitment-post-posture-STANDING"/);
    assert.match(createHtml, /data-testid="recruitment-post-posture-SITTING"/);
    assert.match(
      createHtml,
      /data-testid="recruitment-post-labor-type-THOI_VU"/,
    );
    assert.match(
      createHtml,
      /data-testid="recruitment-post-labor-type-CHINH_THUC"/,
    );
    assert.match(
      createHtml,
      /data-testid="recruitment-post-labor-type-GIA_CONG"/,
    );

    // 3-column desktop row immediately after checkbox cluster: Ca làm việc * -> Chi tiết ca / giờ làm việc -> Số điện thoại người phụ trách *
    assert.match(
      createHtml,
      /data-testid="recruitment-post-shift-contact-row"[^>]*class="[^"]*lg:grid-cols-3[^"]*"/,
    );
    const clusterPos = createHtml.indexOf(
      'data-testid="recruitment-post-checkbox-cluster"',
    );
    const envPos = createHtml.indexOf(
      'data-testid="recruitment-post-env-CLEAN_ROOM"',
    );
    const posturePos = createHtml.indexOf(
      'data-testid="recruitment-post-posture-STANDING"',
    );
    const laborPos = createHtml.indexOf(
      'data-testid="recruitment-post-labor-type-THOI_VU"',
    );
    const shiftContactRowPos = createHtml.indexOf(
      'data-testid="recruitment-post-shift-contact-row"',
    );
    const shiftPatternPos = createHtml.indexOf(
      'data-testid="recruitment-post-select-shift-pattern"',
    );
    const shiftDetailsPos = createHtml.indexOf(
      'data-testid="recruitment-post-input-shift-details"',
    );
    const managerPhonePos = createHtml.indexOf(
      'data-testid="recruitment-post-input-manager-phone"',
    );
    const headcountPos = createHtml.indexOf(
      'data-testid="recruitment-post-input-headcount"',
    );

    assert.ok(clusterPos > 0 && envPos > clusterPos);
    assert.ok(posturePos > envPos);
    assert.ok(laborPos > posturePos);
    assert.ok(
      shiftContactRowPos > laborPos,
      "shift-contact row must come immediately after checkbox cluster",
    );
    assert.ok(shiftPatternPos > shiftContactRowPos);
    assert.ok(
      shiftDetailsPos > shiftPatternPos,
      "shift_details must follow shift_pattern",
    );
    assert.ok(
      managerPhonePos > shiftDetailsPos,
      "manager_phone must follow shift_details",
    );
    assert.ok(
      headcountPos > managerPhonePos,
      "expected_headcount must follow the 3-field shift & contact row",
    );

    // Verify shift_details required marker & fieldErrors for laborTypeKeys, shiftDetails, managerPhone remain intact
    const validationCreateHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Trần Thị PM",
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          draft: {
            ...createDraft,
            shiftPattern: "OTHER",
          },
          fieldErrors: {
            laborTypeKeys: "Vui lòng chọn ít nhất một Hình thức tuyển dụng.",
            shiftDetails: "Vui lòng nhập Chi tiết ca / giờ làm việc.",
            managerPhone: "Vui lòng nhập Số điện thoại người phụ trách.",
          },
        },
      }),
    );
    assert.match(
      validationCreateHtml,
      /Vui lòng chọn ít nhất một Hình thức tuyển dụng\./,
    );
    assert.match(
      validationCreateHtml,
      /Vui lòng nhập Chi tiết ca \/ giờ làm việc\./,
    );
    assert.match(
      validationCreateHtml,
      /Vui lòng nhập Số điện thoại người phụ trách\./,
    );

    assert.doesNotMatch(
      createHtml,
      /data-testid="recruitment-post-input-manager-name"/,
    );
    assert.doesNotMatch(createHtml, /Người phụ trách dự án/);
    assert.doesNotMatch(createHtml, /Tên Client Cố Tình Gửi/);
    assert.match(
      createHtml,
      /data-testid="recruitment-post-input-manager-phone"[^>]*value="0912345678"/,
    );
    assert.doesNotMatch(
      createHtml,
      /<input[^>]*data-testid="recruitment-post-input-manager-phone"[^>]*readOnly=""/,
    );
    assert.match(
      createHtml,
      /data-testid="recruitment-post-candidate-core-row"[^>]*class="[^"]*lg:grid-cols-4[^"]*"/,
    );
    assert.match(createHtml, /<option value="ANY"[^>]*>Cặp Nam\/Nữ<\/option>/);
    assert.doesNotMatch(createHtml, /Không giới hạn \(Nam\/Nữ\)/);
    assert.match(createHtml, /data-testid="recruitment-post-pre-submit-summary"/);
    assert.match(createHtml, /1\. Dự án/);
    assert.match(createHtml, /2\. Khu công nghiệp &amp; Tỉnh\/Thành/);
    assert.match(createHtml, /KCN Khai Quang — Vĩnh Phúc/);
    assert.match(createHtml, /3\. Công việc/);
    assert.match(createHtml, /4\. Số lượng dự kiến/);
    assert.match(createHtml, /120 người/);
    assert.match(createHtml, /5\. Thu nhập bình quân dự kiến/);
    assert.match(createHtml, /9\.500\.000\s*₫\s*–\s*12\.500\.000\s*₫/);
    assert.match(createHtml, /6\. Liên hệ người phụ trách/);
    assert.match(createHtml, />0912345678</);
    assert.doesNotMatch(createHtml, /Trần Thị PM · 0912345678/);

    // Single managed project auto-defaults projectId and customerName on initial create render while keeping customerName editable
    const autoDefaultCreateHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Trần Thị PM",
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
        },
      }),
    );
    assert.match(
      autoDefaultCreateHtml,
      /data-testid="recruitment-post-input-customer-name"[^>]*value="Dự án Điện tử ABC"/,
    );
    assert.doesNotMatch(
      autoDefaultCreateHtml,
      /<input[^>]*data-testid="recruitment-post-input-customer-name"[^>]*readOnly=""/,
    );
    assert.doesNotMatch(
      autoDefaultCreateHtml,
      /data-testid="recruitment-post-input-manager-name"/,
    );

    // Edit mode locks Project and Industrial Park, hides manager_name input while keeping manager_phone editable, and renders comparedServerPost with created_by_display_name ("Lê Thị Hải Yến") and never general.manager_name ("yenlh.td")
    const existingPost = makeCompleteItem({
      version: 3,
      created_by_display_name: "Lê Thị Hải Yến",
      updated_by_display_name: "Lê Thị Hải Yến",
      general: {
        ...makeCompleteItem().general,
        manager_name: "yenlh.td",
        manager_phone: "0912345678",
      },
      allowed_actions: { can_edit: true, can_withdraw: true },
    });
    const newerServerPost = makeCompleteItem({
      version: 4,
      created_by_display_name: "Lê Thị Hải Yến",
      updated_by_display_name: "Lê Thị Hải Yến",
      general: {
        ...existingPost.general,
        manager_name: "yenlh.td",
        manager_phone: "0912345678",
        job_description: "Công việc mới cập nhật trên máy chủ v4",
      },
      allowed_actions: { can_edit: true, can_withdraw: true },
    });

    const editStaleHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "edit",
        briefId: existingPost.brief_id,
        actorDisplayName: "Lê Quản Trị BOD",
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          loadedPost: existingPost,
          draft: {
            ...createEditRecruitmentPostFormDraftFromItem(existingPost),
            managerName: "Tên Giả Mạo Khi Sửa",
          },
          staleConflictMessage:
            "Tin tuyển dụng đã thay đổi phiên bản. Vui lòng tải lại dữ liệu mới nhất trước khi thực hiện lại.",
          comparedServerPost: newerServerPost,
        },
      }),
    );

    assert.match(editStaleHtml, /data-testid="recruitment-post-locked-project"/);
    assert.match(editStaleHtml, /data-testid="recruitment-post-derived-province"/);
    assert.match(editStaleHtml, /data-testid="recruitment-post-locked-park"/);
    assert.match(
      editStaleHtml,
      /data-testid="recruitment-post-input-customer-name"[^>]*value="Công ty TNHH Linh Kiện Điện Tử ABC"/,
    );
    assert.doesNotMatch(
      editStaleHtml,
      /data-testid="recruitment-post-input-manager-name"/,
    );
    assert.doesNotMatch(
      editStaleHtml,
      /<input[^>]*data-testid="recruitment-post-input-manager-phone"[^>]*readOnly=""/,
    );
    assert.doesNotMatch(editStaleHtml, /Tên Giả Mạo Khi Sửa/);
    assert.doesNotMatch(editStaleHtml, /Lê Quản Trị BOD/);
    assert.doesNotMatch(editStaleHtml, /yenlh\.td/);
    assert.match(editStaleHtml, /Lê Thị Hải Yến/);
    assert.match(editStaleHtml, /0912345678/);
    assert.match(editStaleHtml, /data-testid="recruitment-post-stale-conflict"/);
    assert.match(editStaleHtml, /Tải bản mới nhất để đối chiếu/);
    assert.match(
      editStaleHtml,
      /data-testid="recruitment-post-compared-server-card"/,
    );
    assert.match(editStaleHtml, /Công việc mới cập nhật trên máy chủ v4/);

    // Ambiguous retry lock + mid-form 403 permission revocation preserving draft in read-only mode
    const revokedAndAmbiguousHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "edit",
        briefId: existingPost.brief_id,
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          loadedPost: existingPost,
          draft: createEditRecruitmentPostFormDraftFromItem(existingPost),
          writePermissionRevokedMessage:
            "Quyền tạo/chỉnh sửa phiếu tuyển dụng trên dự án này vừa bị thu hồi. Nội dung bạn đã nhập vẫn được giữ ở chế độ chỉ đọc để bạn sao chép lưu lại.",
          ambiguousLockMessage:
            "Mất kết nối hoặc chưa xác nhận được kết quả xử lý trên máy chủ.",
          pendingIntent: {
            mode: "edit",
            briefId: existingPost.brief_id,
            idempotencyKey: "idem-test-123",
            requestBody: {
              expected_version: 3,
              content: {
                general: {
                  ...existingPost.general,
                  labor_type_keys: ["CHINH_THUC"],
                },
                candidate: existingPost.candidate,
                compensation: existingPost.compensation,
                documents: existingPost.documents,
              },
            },
          },
        },
      }),
    );

    assert.match(
      revokedAndAmbiguousHtml,
      /data-testid="recruitment-post-permission-revoked-readonly"/,
    );
    assert.match(
      revokedAndAmbiguousHtml,
      /data-testid="recruitment-post-ambiguous-lock"/,
    );
    assert.match(revokedAndAmbiguousHtml, /Gửi lại đúng yêu cầu/);
  });

  it("Phase 4: renders RecruitmentPostWithdrawDialog and Full Admin/BOD Province & Industrial Park Catalog Managers", () => {
    const withdrawHtml = renderToStaticMarkup(
      createElement(RecruitmentPostWithdrawDialog, {
        open: true,
        target: {
          briefId: makeBriefId(1),
          expectedVersion: 2,
          projectName: "Dự án Điện tử ABC",
          industrialParkName: "KCN Khai Quang",
          provinceName: "Vĩnh Phúc",
          jobDescriptionDisplay: "Lắp ráp linh kiện điện tử",
        },
        onOpenChange: () => {},
        onWithdrawn: () => {},
        onAccessRevoked: () => {},
      }),
    );
    assert.match(withdrawHtml, /Xác nhận rút phiếu tuyển dụng/);
    assert.match(withdrawHtml, /data-testid="recruitment-post-withdraw-confirm"/);
    assert.match(withdrawHtml, /Xác nhận rút tin/);

    const provinceManagerHtml = renderToStaticMarkup(
      createElement(ProvinceCatalogManager),
    );
    assert.match(provinceManagerHtml, /data-testid="province-catalog-manager"/);

    const parkManagerHtml = renderToStaticMarkup(
      createElement(IndustrialParkCatalogManager),
    );
    assert.match(
      parkManagerHtml,
      /data-testid="industrial-park-catalog-manager"/,
    );

    const newPageSrc = readRel("src/app/recruitment-posts/new/page.tsx");
    const editPageSrc = readRel(
      "src/app/recruitment-posts/[briefId]/edit/page.tsx",
    );
    const adminProvincesPageSrc = readRel(
      "src/app/admin/catalog/provinces/page.tsx",
    );
    const adminParksPageSrc = readRel(
      "src/app/admin/catalog/industrial-parks/page.tsx",
    );

    assert.match(
      newPageSrc,
      /<RecruitmentPostForm[\s\S]*mode="create"[\s\S]*copyFromBriefId=\{[\s\S]*\}[\s\S]*actorDisplayName=\{actor && actor\.ok \? actor\.actor\.display_name : ""\}\s*\/>/,
    );
    assert.match(
      editPageSrc,
      /<RecruitmentPostForm mode="edit" briefId=\{normalizedBriefId\} \/>/,
    );
    assert.match(
      adminProvincesPageSrc,
      /decideRecruitmentLocationCatalogPageAccess/,
    );
    assert.match(adminProvincesPageSrc, /<ProvinceCatalogManager \/>/);
    assert.match(
      adminParksPageSrc,
      /decideRecruitmentLocationCatalogPageAccess/,
    );
    assert.match(adminParksPageSrc, /<IndustrialParkCatalogManager \/>/);
  });

  it("renders 'Xuất bản tin' button on card, exports Markdown from GET /api/recruitment-posts/[briefId], shows error banner without creating file on failure, and wipes state on 401/403", async () => {
    const postItem = makeCompleteItem({
      brief_id: makeBriefId(88),
      created_by_display_name: "Lê Thị Hải Yến",
      updated_by_display_name: "Lê Thị Hải Yến",
      general: {
        ...makeCompleteItem().general,
        manager_name: "yenlh.td",
        manager_phone: "0912345678",
      },
    });

    // 1. Feed workspace renders "Xuất bản tin" button next to "Xem chi tiết" with responsive flex-wrap actions
    const feedHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            items: [postItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(
      feedHtml,
      /data-testid="recruitment-post-card-actions"[^>]*class="[^"]*flex-wrap[^"]*"/,
    );
    assert.match(feedHtml, /data-testid="recruitment-post-export"/);
    assert.match(feedHtml, /Xuất bản tin/);

    // 2. While exporting, button is disabled and shows "Đang xuất…"
    const exportingHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          exportingBriefId: postItem.brief_id,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            items: [postItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(
      exportingHtml,
      /<button[^>]*disabled=""[^>]*data-testid="recruitment-post-export"[^>]*>Đang xuất…<\/button>/,
    );

    // 3. When detail export fails, workspace renders recognizable error banner + retry button
    const exportErrorHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          exportError: {
            briefId: postItem.brief_id,
            message:
              "Không thể tải dữ liệu tin tuyển dụng lúc này. Vui lòng thử lại.",
          },
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            items: [postItem],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(
      exportErrorHtml,
      /data-testid="recruitment-posts-export-error"/,
    );
    assert.match(exportErrorHtml, /Không thể xuất bản tin tuyển dụng/);
    assert.match(
      exportErrorHtml,
      /data-testid="recruitment-posts-export-retry"/,
    );

    // 4. Clicking export fetches GET /api/recruitment-posts/[briefId] and generates .md with 4 sections + metadata, using created_by_display_name & manager_phone and never manager_name
    const requestedUrls = [];
    const createdFiles = [];
    const okResult = await exportRecruitmentPostDetailMarkdown({
      briefId: postItem.brief_id,
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify({ ok: true, data: { post: postItem } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      onDownload: (file) => {
        createdFiles.push(file);
      },
    });
    assert.deepEqual(requestedUrls, [
      `/api/recruitment-posts/${postItem.brief_id}`,
    ]);
    assert.equal(okResult.kind, "ok");
    assert.equal(createdFiles.length, 1);
    assert.equal(
      createdFiles[0].filename,
      `tin-tuyen-dung-${postItem.brief_id}.md`,
    );
    assert.match(createdFiles[0].content, /## 1\. Thông tin chung dự án/);
    assert.match(createdFiles[0].content, /## 2\. Yêu cầu ứng viên/);
    assert.match(
      createdFiles[0].content,
      /## 3\. Lương, thưởng, phụ cấp và phúc lợi/,
    );
    assert.match(
      createdFiles[0].content,
      /## 4\. Hồ sơ ứng viên cần chuẩn bị/,
    );
    assert.match(
      createdFiles[0].content,
      /## 5\. Thông tin bản tin \(Metadata\)/,
    );
    assert.match(createdFiles[0].content, /Lê Thị Hải Yến · 0912345678/);
    assert.doesNotMatch(createdFiles[0].content, /yenlh\.td/);

    // 5. HTTP/parse error does not create any file
    let createdOn500 = false;
    const errorResult = await exportRecruitmentPostDetailMarkdown({
      briefId: postItem.brief_id,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" }),
          { status: 500 },
        ),
      onDownload: () => {
        createdOn500 = true;
      },
    });
    assert.equal(errorResult.kind, "error");
    assert.equal(createdOn500, false);

    // 6. 401/403 returns access_loss without creating a file, triggering workspace state wipe
    let createdOn403 = false;
    const accessLossResult = await exportRecruitmentPostDetailMarkdown({
      briefId: postItem.brief_id,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ ok: false, code: "RECRUITMENT_POST_ACCESS_DENIED" }),
          { status: 403 },
        ),
      onDownload: () => {
        createdOn403 = true;
      },
    });
    assert.deepEqual(accessLossResult, {
      kind: "access_loss",
      accessLoss: "ACCESS_DENIED",
    });
    assert.equal(createdOn403, false);

    const revokedWorkspaceHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialStateForTest: {
          accessLoss: accessLossResult.accessLoss,
          dataState: createEmptyRecruitmentPostDataState(),
        },
      }),
    );
    assert.doesNotMatch(
      revokedWorkspaceHtml,
      /data-testid="recruitment-posts-list"/,
    );
    assert.doesNotMatch(revokedWorkspaceHtml, /Dự án Điện tử ABC/);
  });

  it("renders 'Tin đang tuyển' and 'Tin của tôi' tabs, 3-card responsive grid, highlighted card header, status badges, and WITHDRAWN 'Đăng lại' actions", () => {
    const publishedPost = makeCompleteItem({
      brief_id: makeBriefId(201),
      status: "PUBLISHED",
      allowed_actions: { can_edit: true, can_withdraw: true },
    });
    const withdrawnPost = makeCompleteItem({
      brief_id: makeBriefId(202),
      status: "WITHDRAWN",
      withdrawn_at: "2026-11-10T11:00:00.000Z",
      withdrawn_by_display_name: "Nguyễn Văn Quản Lý",
      allowed_actions: { can_edit: false, can_withdraw: false },
    });

    // 1. Default "Tin đang tuyển" tab: accessible tablist, 3-column grid, highlighted header, no status badge
    const publishedTabHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "published",
        initialStateForTest: {
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          loadMoreError: "Không thể tải thêm tin lúc này.",
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            items: [publishedPost],
            hasMore: true,
            nextCursor: `C1.42.0123456789abcdef0123456789abcdef.1762684800000000.${publishedPost.brief_id}`,
          },
        },
      }),
    );

    assert.match(publishedTabHtml, /role="tablist"/);
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-posts-tab-published"[^>]*aria-selected="true"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-posts-tab-mine"[^>]*aria-selected="false"/,
    );
    assert.match(publishedTabHtml, /data-testid="recruitment-posts-filter-toolbar"/);
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-posts-list"[^>]*class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"/,
    );
    assert.match(
      publishedTabHtml,
      new RegExp(
        `data-testid="recruitment-post-card-${publishedPost.brief_id}"[^>]*class="[^"]*h-full[^"]*"`,
      ),
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-header"[^>]*data-status="PUBLISHED"/,
    );
    assert.doesNotMatch(
      publishedTabHtml,
      /data-testid="recruitment-post-status-badge-/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-job"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-labor-types"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-headcount"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-candidate"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-compensation"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-contact"/,
    );
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-post-card-footer"/,
    );

    // Verify action button order on PUBLISHED card with canEdit=true & canWithdraw=true:
    // Xem chi tiết -> Xuất bản tin -> Sửa -> Rút tin (and job block immediately follows actions)
    const viewDetailIdx = publishedTabHtml.indexOf(
      `data-testid="recruitment-post-view-detail-${publishedPost.brief_id}"`,
    );
    const exportIdx = publishedTabHtml.indexOf(
      'data-testid="recruitment-post-export"',
    );
    const editIdx = publishedTabHtml.indexOf(
      `data-testid="recruitment-post-edit-${publishedPost.brief_id}"`,
    );
    const withdrawIdx = publishedTabHtml.indexOf(
      `data-testid="recruitment-post-withdraw-${publishedPost.brief_id}"`,
    );
    const jobBlockIdx = publishedTabHtml.indexOf(
      'data-testid="recruitment-post-card-job"',
    );
    assert.ok(viewDetailIdx > 0);
    assert.ok(viewDetailIdx < exportIdx);
    assert.ok(exportIdx < editIdx);
    assert.ok(editIdx < withdrawIdx);
    assert.ok(withdrawIdx < jobBlockIdx);

    // Verify loadMoreError sits outside the 3-column grid container
    assert.match(
      publishedTabHtml,
      /data-testid="recruitment-posts-load-more-error"/,
    );

    const pmContextManagingAbc = {
      can_create: true,
      managed_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      filter_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      provinces: [
        {
          province_id: PROVINCE_VP_ID,
          province_code: "VINH_PHUC",
          display_name: "Vĩnh Phúc",
          active: true,
        },
      ],
      industrial_parks: [
        {
          industrial_park_id: PARK_KHAI_QUANG_ID,
          industrial_park_code: "VP_KHAI_QUANG",
          province_id: PROVINCE_VP_ID,
          display_name: "KCN Khai Quang",
          active: true,
        },
      ],
      labor_types: [
        {
          labor_type_key: "CHINH_THUC",
          display_name: "Chính thức",
          active: true,
        },
      ],
    };

    // 2. "Tin của tôi" tab when PM still manages PROJ_ABC: hides filters, shows status badges ("Đang tuyển" / "Đã rút"),
    // shows "Đăng lại" link on WITHDRAWN card, and never shows "Sửa" or "Rút tin" on WITHDRAWN card
    const mineTabHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "mine",
        initialStateForTest: {
          activeTab: "mine",
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: pmContextManagingAbc,
            items: [publishedPost, withdrawnPost],
            hasMore: false,
          },
        },
      }),
    );

    assert.match(
      mineTabHtml,
      /data-testid="recruitment-posts-tab-mine"[^>]*aria-selected="true"/,
    );
    assert.doesNotMatch(mineTabHtml, /data-testid="recruitment-posts-filter-toolbar"/);
    assert.match(
      mineTabHtml,
      new RegExp(`data-testid="recruitment-post-status-badge-${publishedPost.brief_id}"`),
    );
    assert.match(
      mineTabHtml,
      new RegExp(`data-testid="recruitment-post-status-badge-${withdrawnPost.brief_id}"`),
    );
    assert.match(mineTabHtml, />Đang tuyển</);
    assert.match(mineTabHtml, />Đã rút</);
    assert.match(
      mineTabHtml,
      new RegExp(
        `href="/recruitment-posts/new\\?copy_from=${withdrawnPost.brief_id}"`,
      ),
    );
    assert.match(
      mineTabHtml,
      new RegExp(`data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`),
    );
    assert.match(mineTabHtml, />Đăng lại</);

    // 2b. "Tin của tôi" tab when PM lost management of PROJ_ABC (manages PROJ_XYZ instead) or when context failed to load (context=null):
    // MUST NOT render "Đăng lại" on WITHDRAWN card of PROJ_ABC
    const mineTabUnmanagedProjectHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "mine",
        initialStateForTest: {
          activeTab: "mine",
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: {
              ...pmContextManagingAbc,
              managed_projects: [
                { project_id: "PROJ_XYZ", display_name: "Dự án Cơ khí XYZ" },
              ],
            },
            items: [withdrawnPost],
            hasMore: false,
          },
        },
      }),
    );
    assert.doesNotMatch(
      mineTabUnmanagedProjectHtml,
      new RegExp(`data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`),
    );
    assert.doesNotMatch(mineTabUnmanagedProjectHtml, />Đăng lại</);

    const mineTabContextErrorHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "mine",
        initialStateForTest: {
          activeTab: "mine",
          contextLoading: false,
          contextError: recruitmentPostContextErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
          initialLoading: false,
          feedError: null,
          dataState: {
            ...createEmptyRecruitmentPostDataState(),
            context: null,
            items: [withdrawnPost],
            hasMore: false,
          },
        },
      }),
    );
    assert.match(
      mineTabContextErrorHtml,
      /data-testid="recruitment-posts-context-error"/,
    );
    assert.doesNotMatch(
      mineTabContextErrorHtml,
      new RegExp(`data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`),
    );

    // Render individual WITHDRAWN card in mine tab to verify Sửa & Rút tin are absent while Xem chi tiết, Xuất bản tin, Đăng lại (when canRepost=true) are present
    const withdrawnCardHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: toRecruitmentPostCardViewModel(withdrawnPost),
        showStatusBadge: true,
        canRepost: canRepostWithdrawnRecruitmentPost({
          tab: "mine",
          status: withdrawnPost.status,
          projectId: withdrawnPost.project.project_id,
          managedProjects: pmContextManagingAbc.managed_projects,
        }),
        onViewDetail: () => {},
        onExport: () => {},
        onWithdraw: () => {},
      }),
    );
    assert.match(
      withdrawnCardHtml,
      /data-testid="recruitment-post-card-header"[^>]*data-status="WITHDRAWN"/,
    );
    assert.match(
      withdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-status-badge-${withdrawnPost.brief_id}"`),
    );
    assert.match(withdrawnCardHtml, />Đã rút</);
    assert.match(
      withdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-view-detail-${withdrawnPost.brief_id}"`),
    );
    assert.match(withdrawnCardHtml, /data-testid="recruitment-post-export"/);
    assert.match(
      withdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`),
    );
    assert.doesNotMatch(
      withdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-edit-${withdrawnPost.brief_id}"`),
    );
    assert.doesNotMatch(
      withdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-withdraw-${withdrawnPost.brief_id}"`),
    );

    const withdrawnViewIdx = withdrawnCardHtml.indexOf(
      `data-testid="recruitment-post-view-detail-${withdrawnPost.brief_id}"`,
    );
    const withdrawnExportIdx = withdrawnCardHtml.indexOf(
      'data-testid="recruitment-post-export"',
    );
    const withdrawnRepostIdx = withdrawnCardHtml.indexOf(
      `data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`,
    );
    assert.ok(withdrawnViewIdx > 0);
    assert.ok(withdrawnViewIdx < withdrawnExportIdx);
    assert.ok(withdrawnExportIdx < withdrawnRepostIdx);

    // Long text card: wraps/clamps safely without horizontal overflow
    const longTextItem = makeCompleteItem({
      brief_id: makeBriefId(299),
      project: {
        project_id: "PROJ_LONG",
        display_name: "Dự án Sản Xuất Mô-đun Bán Dẫn Siêu Tích Hợp Thế Hệ Mới Khu Vực Miền Bắc",
      },
      general: {
        ...makeCompleteItem().general,
        customer_name:
          "Công ty TNHH Công Nghệ Cao Và Sản Xuất Linh Kiện Quang Điện Tử Quốc Tế",
        job_description:
          "Vận hành dây chuyền SMT tự động tốc độ cao, kiểm tra chất lượng bo mạch điện tử theo tiêu chuẩn IPC-A-610, phối hợp kỹ thuật viên bảo trì thiết bị phòng sạch.",
      },
    });
    const longTextCardHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: toRecruitmentPostCardViewModel(longTextItem),
        showStatusBadge: true,
        onViewDetail: () => {},
      }),
    );
    assert.match(longTextCardHtml, /line-clamp-3/);
    assert.match(longTextCardHtml, /break-words/);
    assert.match(longTextCardHtml, /tabular-nums/);
    assert.match(longTextCardHtml, /motion-reduce:transition-none/);

    // Default RecruitmentPostCard without explicit canRepost=true is fail-closed (no Đăng lại button)
    const defaultWithdrawnCardHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: toRecruitmentPostCardViewModel(withdrawnPost),
        showStatusBadge: true,
        onViewDetail: () => {},
      }),
    );
    assert.doesNotMatch(
      defaultWithdrawnCardHtml,
      new RegExp(`data-testid="recruitment-post-repost-${withdrawnPost.brief_id}"`),
    );

    // 3. Empty state in "Tin của tôi" tab
    const emptyMineHtml = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "mine",
        initialStateForTest: {
          activeTab: "mine",
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: null,
          dataState: createEmptyRecruitmentPostDataState(),
        },
      }),
    );
    assert.match(emptyMineHtml, /Bạn chưa tạo phiếu tuyển dụng nào\./);
  });

  it("wipes old tab items and detail state when switching tabs and new tab returns 503, preserves valid catalog context, and rejects stale responses from previous tab", () => {
    const workspaceSrc = readRel(
      "src/components/recruitment-posts/recruitment-post-feed-workspace.tsx",
    );
    assert.match(
      workspaceSrc,
      /clearRecruitmentPostFeedItemsPreservingContext/,
    );
    assert.match(
      workspaceSrc,
      /applyRecruitmentPostFirstPageOutcome/,
    );

    const validContext = {
      can_create: true,
      managed_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      filter_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      provinces: [
        {
          province_id: PROVINCE_VP_ID,
          province_code: "VINH_PHUC",
          display_name: "Vĩnh Phúc",
          active: true,
        },
      ],
      industrial_parks: [
        {
          industrial_park_id: PARK_KHAI_QUANG_ID,
          industrial_park_code: "VP_KHAI_QUANG",
          province_id: PROVINCE_VP_ID,
          display_name: "KCN Khai Quang",
          active: true,
        },
      ],
      labor_types: [
        {
          labor_type_key: "CHINH_THUC",
          display_name: "Chính thức",
          active: true,
        },
      ],
    };

    const withdrawnMineCard = makeCompleteItem({
      brief_id: makeBriefId(501),
      status: "WITHDRAWN",
      withdrawn_at: "2026-11-10T10:00:00.000Z",
      withdrawn_by_display_name: "Nguyễn Văn Quản Lý",
      general: {
        ...makeCompleteItem().general,
        customer_name: "Công ty Đã Rút Ở Tab Mine",
      },
      allowed_actions: { can_edit: false, can_withdraw: false },
    });

    const publishedFeedCard = makeCompleteItem({
      brief_id: makeBriefId(502),
      status: "PUBLISHED",
      general: {
        ...makeCompleteItem().general,
        customer_name: "Công ty Công Khai Ở Tab Published",
      },
      allowed_actions: { can_edit: true, can_withdraw: true },
    });

    // Case 1: Had WITHDRAWN card in `mine` -> switch to `published` -> API returns 503:
    // Old WITHDRAWN card and detail state are wiped, catalog context is preserved, feedError is rendered
    const initialMineDataState = {
      ...createEmptyRecruitmentPostDataState(),
      context: validContext,
      items: [withdrawnMineCard],
      selectedDetail: withdrawnMineCard,
      detailOpen: true,
      detailBriefId: withdrawnMineCard.brief_id,
    };
    const clearedForPublished =
      clearRecruitmentPostFeedItemsPreservingContext(initialMineDataState);
    const outcome503 = resolveRecruitmentPostListOutcome({
      status: 503,
      payload: { ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" },
    });
    assert.equal(outcome503.kind, "error");
    const publishedAfter503DataState = applyRecruitmentPostFirstPageOutcome(
      clearedForPublished,
      outcome503,
    );
    assert.deepEqual(publishedAfter503DataState.items, []);
    assert.equal(publishedAfter503DataState.detailOpen, false);
    assert.equal(publishedAfter503DataState.selectedDetail, null);
    assert.equal(publishedAfter503DataState.context, validContext);

    const published503Html = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "published",
        initialStateForTest: {
          activeTab: "published",
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: outcome503.message,
          dataState: publishedAfter503DataState,
        },
      }),
    );
    assert.match(
      published503Html,
      /data-testid="recruitment-posts-tab-published"[^>]*aria-selected="true"/,
    );
    assert.match(
      published503Html,
      /data-testid="recruitment-posts-feed-error"/,
    );
    assert.doesNotMatch(
      published503Html,
      /data-testid="recruitment-posts-list"/,
    );
    assert.doesNotMatch(published503Html, new RegExp(withdrawnMineCard.brief_id));
    assert.doesNotMatch(published503Html, /Công ty Đã Rút Ở Tab Mine/);
    // Catalog context remains intact (filter project option still rendered, no context error banner)
    assert.doesNotMatch(
      published503Html,
      /data-testid="recruitment-posts-context-error"/,
    );
    assert.match(
      published503Html,
      /<option value="PROJ_ABC">Dự án Điện tử ABC<\/option>/,
    );

    // Case 2: Had PUBLISHED card in `published` -> switch to `mine` -> API returns 503:
    // Old PUBLISHED card and detail state are wiped, catalog context is preserved, feedError is rendered
    const initialPublishedDataState = {
      ...createEmptyRecruitmentPostDataState(),
      context: validContext,
      items: [publishedFeedCard],
      selectedDetail: publishedFeedCard,
      detailOpen: true,
      detailBriefId: publishedFeedCard.brief_id,
    };
    const clearedForMine = clearRecruitmentPostFeedItemsPreservingContext(
      initialPublishedDataState,
    );
    const mineAfter503DataState = applyRecruitmentPostFirstPageOutcome(
      clearedForMine,
      outcome503,
    );
    assert.deepEqual(mineAfter503DataState.items, []);
    assert.equal(mineAfter503DataState.detailOpen, false);
    assert.equal(mineAfter503DataState.selectedDetail, null);
    assert.equal(mineAfter503DataState.context, validContext);

    const mine503Html = renderToStaticMarkup(
      createElement(RecruitmentPostFeedWorkspace, {
        initialTab: "mine",
        initialStateForTest: {
          activeTab: "mine",
          contextLoading: false,
          contextError: null,
          initialLoading: false,
          feedError: outcome503.message,
          dataState: mineAfter503DataState,
        },
      }),
    );
    assert.match(
      mine503Html,
      /data-testid="recruitment-posts-tab-mine"[^>]*aria-selected="true"/,
    );
    assert.match(mine503Html, /data-testid="recruitment-posts-feed-error"/);
    assert.doesNotMatch(mine503Html, /data-testid="recruitment-posts-list"/);
    assert.doesNotMatch(mine503Html, new RegExp(publishedFeedCard.brief_id));
    assert.doesNotMatch(mine503Html, /Công ty Công Khai Ở Tab Published/);
    assert.doesNotMatch(
      mine503Html,
      /data-testid="recruitment-posts-context-error"/,
    );

    // Case 3: Stale response from previous tab (`published`) resolving after user switches to `mine` is never committed
    const feedTracker = createLatestRequestTracker();
    const publishedTicket = feedTracker.begin();
    // User switches tab -> handleSelectTab cancels tracker and loadFirstPage("mine") begins a new ticket
    feedTracker.cancelAll();
    const mineTicket = feedTracker.begin();
    assert.equal(publishedTicket.signal.aborted, true);
    assert.equal(publishedTicket.isCurrent(), false);
    assert.equal(mineTicket.isCurrent(), true);

    let committedState = clearRecruitmentPostFeedItemsPreservingContext(
      initialPublishedDataState,
    );
    // Late response from `published` arrives:
    const stalePublishedOutcome = resolveRecruitmentPostListOutcome({
      status: 200,
      payload: {
        ok: true,
        data: {
          items: [publishedFeedCard],
          page_size: 15,
          has_more: false,
          next_cursor: null,
          snapshot_token: "S1.1.0123456789abcdef0123456789abcdef",
        },
      },
    });
    if (publishedTicket.isCurrent()) {
      committedState = applyRecruitmentPostFirstPageOutcome(
        committedState,
        stalePublishedOutcome,
      );
    }
    assert.deepEqual(
      committedState.items,
      [],
      "Stale response from previous tab must not be committed",
    );
  });

  it("renders 'Đăng lại' copy_from flow on RecruitmentPostForm only when actor still manages source project, fails closed on unmanaged project deep-link or context error, and redirects to /recruitment-posts?tab=mine with toast after create", () => {
    const sampleContext = {
      can_create: true,
      managed_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
        { project_id: "PROJ_XYZ", display_name: "Dự án Cơ khí XYZ" },
      ],
      filter_projects: [
        { project_id: "PROJ_ABC", display_name: "Dự án Điện tử ABC" },
      ],
      provinces: [
        {
          province_id: PROVINCE_VP_ID,
          province_code: "VINH_PHUC",
          display_name: "Vĩnh Phúc",
          active: true,
        },
      ],
      industrial_parks: [
        {
          industrial_park_id: PARK_KHAI_QUANG_ID,
          industrial_park_code: "VP_KHAI_QUANG",
          province_id: PROVINCE_VP_ID,
          display_name: "KCN Khai Quang",
          active: true,
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
      ],
    };

    const withdrawnSource = makeCompleteItem({
      brief_id: makeBriefId(301),
      version: 4,
      status: "WITHDRAWN",
      withdrawn_at: "2026-11-10T10:00:00.000Z",
      withdrawn_by_display_name: "Lê Thị Cũ",
      general: {
        ...makeCompleteItem().general,
        manager_name: "old.login",
        manager_phone: "0977888999",
      },
      allowed_actions: { can_edit: false, can_withdraw: false },
    });

    // 1. Valid WITHDRAWN copy_from when PM still manages PROJ_ABC renders repost banner and prefills 4 sections into mode="create" with current actorDisplayName
    const repostDraft = createCreateRecruitmentPostFormDraftFromItem(
      withdrawnSource,
      {
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        context: sampleContext,
      },
    );
    const repostFormHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        copyFromBriefId: withdrawnSource.brief_id,
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          repostSourcePost: withdrawnSource,
          draft: repostDraft,
        },
      }),
    );

    assert.equal(repostDraft.managerName, "Phạm Thị PM Hiện Tại");
    assert.match(repostFormHtml, /data-testid="recruitment-post-repost-banner"/);
    assert.match(repostFormHtml, /Đang tạo tin mới từ một tin đã rút/);
    assert.match(repostFormHtml, /0977888999/);
    assert.doesNotMatch(repostFormHtml, /old\.login/);
    assert.match(
      repostFormHtml,
      /Công ty TNHH Linh Kiện Điện Tử ABC/,
    );

    // 2. Manual deep-link (/recruitment-posts/new?copy_from=<briefId>) when actor no longer manages PROJ_ABC (even if managing PROJ_XYZ):
    // MUST fail-closed: shows error screen, does NOT open copied form allowing project switch, and offers "Tạo tin mới trống"
    const unmanagedContext = {
      ...sampleContext,
      managed_projects: [
        { project_id: "PROJ_XYZ", display_name: "Dự án Cơ khí XYZ" },
      ],
    };
    const deepLinkOutcome = resolveRecruitmentPostCopyFromOutcome({
      status: 200,
      payload: { ok: true, data: { post: withdrawnSource } },
      context: unmanagedContext,
    });
    assert.equal(deepLinkOutcome.kind, "invalid_source");

    const unmanagedDraft = createCreateRecruitmentPostFormDraftFromItem(
      withdrawnSource,
      {
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        context: unmanagedContext,
      },
    );
    const unmanagedHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        copyFromBriefId: withdrawnSource.brief_id,
        initialStateForTest: {
          initialLoading: false,
          context: unmanagedContext,
          repostSourcePost: withdrawnSource,
          draft: unmanagedDraft,
        },
      }),
    );
    assert.match(
      unmanagedHtml,
      /data-testid="recruitment-post-copy-from-error"/,
    );
    assert.match(
      unmanagedHtml,
      /Bạn không còn phụ trách dự án của tin tuyển dụng này nên không còn quyền đăng lại\./,
    );
    assert.match(unmanagedHtml, /href="\/recruitment-posts\?tab=mine"/);
    assert.match(
      unmanagedHtml,
      /data-testid="recruitment-post-copy-from-start-blank"/,
    );
    assert.doesNotMatch(unmanagedHtml, /data-testid="recruitment-post-form"/);
    assert.doesNotMatch(unmanagedHtml, /0977888999/);

    // 2b. Manual deep-link when former PM manages 0 projects (can_create=false):
    // Fails closed with error screen and does NOT offer "Tạo tin mới trống"
    const zeroProjectContext = {
      ...sampleContext,
      can_create: false,
      managed_projects: [],
    };
    const zeroProjectRepostHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        copyFromBriefId: withdrawnSource.brief_id,
        initialStateForTest: {
          initialLoading: false,
          context: zeroProjectContext,
          repostSourcePost: withdrawnSource,
        },
      }),
    );
    assert.match(
      zeroProjectRepostHtml,
      /data-testid="recruitment-post-copy-from-error"/,
    );
    assert.doesNotMatch(
      zeroProjectRepostHtml,
      /data-testid="recruitment-post-copy-from-start-blank"/,
    );
    assert.doesNotMatch(
      zeroProjectRepostHtml,
      /data-testid="recruitment-post-form"/,
    );

    // 2c. Context fails to load (503) on /recruitment-posts/new?copy_from=<briefId>:
    // Fails closed with load-error banner and does NOT open the copied form
    const contextLoadErrorHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        copyFromBriefId: withdrawnSource.brief_id,
        initialStateForTest: {
          initialLoading: false,
          context: null,
          loadError: recruitmentPostContextErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        },
      }),
    );
    assert.match(
      contextLoadErrorHtml,
      /data-testid="recruitment-post-form-load-error"/,
    );
    assert.doesNotMatch(
      contextLoadErrorHtml,
      /data-testid="recruitment-post-form"/,
    );

    // 3. Invalid or PUBLISHED copy_from renders safe error banner and does not prefill form
    const copyErrorHtml = renderToStaticMarkup(
      createElement(RecruitmentPostForm, {
        mode: "create",
        actorDisplayName: "Phạm Thị PM Hiện Tại",
        copyFromBriefId: makeBriefId(302),
        initialStateForTest: {
          initialLoading: false,
          context: sampleContext,
          copyFromError:
            "Chỉ có thể đăng lại từ một tin đã rút. Vui lòng kiểm tra lại tại tab “Tin của tôi”.",
        },
      }),
    );
    assert.match(
      copyErrorHtml,
      /data-testid="recruitment-post-copy-from-error"/,
    );
    assert.match(
      copyErrorHtml,
      /Chỉ có thể đăng lại từ một tin đã rút/,
    );
    assert.match(copyErrorHtml, /href="\/recruitment-posts\?tab=mine"/);
    assert.doesNotMatch(copyErrorHtml, /data-testid="recruitment-post-form"/);

    // 4. Verify RecruitmentPostForm source wires toast ("Đã đăng tin tuyển dụng thành công.") and router.push("/recruitment-posts?tab=mine") on create success, and gates inline saved banner to mode === "edit"
    const formSrc = readRel(
      "src/components/recruitment-posts/recruitment-post-form.tsx",
    );
    assert.match(
      formSrc,
      /notify\.success\(\{\s*title:\s*"Đã đăng tin tuyển dụng thành công\.",?\s*\}\)/,
    );
    assert.match(
      formSrc,
      /buildRecruitmentPostFeedTabHref\("mine"\)/,
    );
    assert.match(formSrc, /\{savedPost && mode === "edit" \? \(/);
  });
});

