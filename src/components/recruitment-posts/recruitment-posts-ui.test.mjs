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
  beginRecruitmentPostContextRequest,
  classifyRecruitmentPostAccessLoss,
  createEmptyRecruitmentPostDataState,
  createLatestRequestTracker,
  mergeUniqueRecruitmentPostItems,
  recruitmentPostContextErrorMessage,
  resolveRecruitmentPostContextOutcome,
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
    assert.match(pageSrc, /<RecruitmentPostFeedWorkspace \/>/);

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

  it("renders RecruitmentPostCard with all 10 BOD summary items and zero Phase 4 mutation buttons", () => {
    const fullCard = toRecruitmentPostCardViewModel(makeCompleteItem());
    const html = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: fullCard,
        onViewDetail: () => {},
      }),
    );

    // 10 summary items from Master Plan
    assert.match(html, /Dự án Điện tử ABC/);
    assert.match(html, /Công ty TNHH Linh Kiện Điện Tử ABC/);
    assert.match(html, /Vĩnh Phúc · KCN Khai Quang/);
    assert.match(html, /Lắp ráp bảng mạch, kiểm tra ngoại quan bằng kính hiển vi\./);
    assert.match(html, /Chính thức, Thời vụ/);
    assert.match(html, /150 người/);
    assert.match(html, /Không giới hạn \(Nam\/Nữ\) · Độ tuổi: 18 – 38 tuổi/);
    assert.match(html, /LCB:\s*5\.500\.000\s*₫\s*·\s*Thu nhập:\s*9\.500\.000\s*₫\s*–\s*13\.500\.000\s*₫/);
    assert.match(html, /Trần Thị PM · 0912345678/);
    assert.match(html, /Nguyễn Văn Quản Lý/);
    assert.match(html, /Xem chi tiết/);

    // Must not render duplicate currency unit or Phase 4 buttons
    assert.doesNotMatch(html, /₫\s*đ/);
    assert.doesNotMatch(html, /Tạo phiếu tuyển dụng/);
    assert.doesNotMatch(html, />Sửa</);
    assert.doesNotMatch(html, />Rút tin</);

    // Sparse item fallback
    const sparseCard = toRecruitmentPostCardViewModel(makeSparseItem());
    const sparseHtml = renderToStaticMarkup(
      createElement(RecruitmentPostCard, {
        card: sparseCard,
        onViewDetail: () => {},
      }),
    );
    assert.match(sparseHtml, new RegExp(RECRUITMENT_POST_UNPROVIDED_LABEL));
    // Even if backend permissions have can_edit/can_withdraw true, Phase 3 card is read-only
    assert.doesNotMatch(sparseHtml, />Sửa</);
    assert.doesNotMatch(sparseHtml, />Rút tin</);
  });

  it("renders RecruitmentPostDetailDialog with all 4 BOD sections, 8 shift wages, loading and error states", () => {
    const detailVm = toRecruitmentPostDetailViewModel(makeCompleteItem());
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

    // Section 1 fields
    assert.match(html, /Dự án Điện tử ABC/);
    assert.match(html, /Công ty TNHH Linh Kiện Điện Tử ABC/);
    assert.match(html, /Vĩnh Phúc/);
    assert.match(html, /KCN Khai Quang/);
    assert.match(html, /Hàn Quốc/);
    assert.match(html, /Linh kiện điện tử &amp; bán dẫn/);
    assert.match(html, /Phòng sạch, Phòng bán sạch/);
    assert.match(html, /Ngồi, Đứng/);
    assert.match(html, /Hai ca/);
    assert.match(html, /Trần Thị PM/);
    assert.match(html, /0912345678/);

    // Section 2 fields
    assert.match(html, /Không giới hạn \(Nam\/Nữ\)/);
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
      "src/app/recruitment-posts/layout.tsx",
      "src/app/recruitment-posts/page.tsx",
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
});
