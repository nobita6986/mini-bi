/**
 * P1.6-I04C3-R3A - Render entry cho harness SSR (duoc driver copy vao thu muc build).
 *
 * File nay import CHINH component that cua branch (da duoc tsc bien dich) va render bang
 * react-dom/server. Ket qua la markup THAT cua component, khong phai mockup.
 * Du lieu dua vao la GIA hoan toan (synthetic).
 *
 * In ra stdout mot tai lieu HTML tu chua (CSS module + bien CSS cua app).
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WorkerProfilePastePanel,
  WORKER_PROFILE_DIALOG_DESCRIPTION,
  WORKER_PROFILE_DIALOG_TITLE,
} from "./components/direct-entry/direct-entry-worker-profile-paste-dialog.js";
import { buildWorkerProfilePreview, createPasteCatalogResolver }
  from "./lib/direct-entry/worker-profile-preview.js";

const styles = new Proxy({}, { get: (target, key) => String(key) });
const REFERENCE_DATE = "2026-10-16";

// --- Du lieu GIA (synthetic) ---
const CATALOG = {
  "2026-10-15": {
    projects: [{ id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" }],
    recruiters: [{ id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1" }],
    banks: [{ id: "33333333-3333-4333-8333-333333333333", label: "Ngân hàng Giả" }],
  },
  "2026-11-01": {
    projects: [{ id: "11111111-1111-4111-8111-111111111112", label: "Dự án Giả Nam" }],
    recruiters: [{ id: "22222222-2222-4222-8222-222222222223", label: "Tuyển Dụng Giả 2" }],
    banks: [],
  },
};

const HEADERS = ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
  "Loại hình LĐ", "Giới tính", "DOB", "CMT/CCCD", "Ngày cấp", "Nơi cấp", "Địa chỉ hiện tại",
  "Số điện thoại", "Ghi chú", "Tình trạng làm việc hiện tại", "STK", "Tên ngân hàng",
  "Tên chủ tài khoản"];

function tsv(rows) {
  return [HEADERS.join("\t"), ...rows.map((row) =>
    HEADERS.map((header) => row[header] ?? "").join("\t"))].join("\n");
}

const VALID_ROWS = [
  { "Mã NLĐ": "hrp-2026-000101", "Dự án": "Dự án Giả Bắc", "Ngày bắt đầu làm việc": "2026-10-15",
    "Họ và tên": "Nguyễn Văn Giả A", "Tên NV Tuyển dụng": "Tuyển Dụng Giả 1",
    "Loại hình LĐ": "Thời vụ", "Giới tính": "Nam", DOB: "1990-05-20",
    "CMT/CCCD": "012345678901", "Ngày cấp": "2020-06-01", "Nơi cấp": "Cục Cảnh sát Giả",
    "Địa chỉ hiện tại": "Số 1 Đường Giả", "Số điện thoại": "0900000001",
    "Ghi chú": "Ghi chú giả", "Tình trạng làm việc hiện tại": "Đang làm",
    STK: "000123456789", "Tên ngân hàng": "Ngân hàng Giả",
    "Tên chủ tài khoản": "NGUYEN VAN GIA A" },
  { "Mã NLĐ": "hrp-2026-000102", "Dự án": "Dự án Giả Bắc", "Ngày bắt đầu làm việc": "2026-10-15",
    "Họ và tên": "Nguyễn Thị Giả B", "Tên NV Tuyển dụng": "Tuyển Dụng Giả 1",
    "Loại hình LĐ": "Toàn thời gian", "Giới tính": "Nữ", DOB: "1995-12-01",
    "CMT/CCCD": "012345678", "Số điện thoại": "0900000002" },
  { "Mã NLĐ": "hrp-2026-000103", "Dự án": "Dự án Giả Bắc", "Ngày bắt đầu làm việc": "2026-10-15",
    "Họ và tên": "Nguyễn Văn Giả C", "Tên NV Tuyển dụng": "Tuyển Dụng Giả 1",
    "Loại hình LĐ": "Thời vụ", DOB: "1988-02-02" },
];

// Trang thai hon hop theo yeu cau: 1 dong hop le, 1 dong thieu catalog, 1 dong loi CCCD/ngay.
const MIXED_ROWS = [
  VALID_ROWS[0],
  { ...VALID_ROWS[1], "Dự án": "Dự án Không Có Trong Danh Mục",
    "Tên NV Tuyển dụng": "Tuyển Dụng Không Có" },
  { ...VALID_ROWS[2], "CMT/CCCD": "12345", "Ngày bắt đầu làm việc": "31/02/2026" },
];

function buildPreview(rows) {
  const resolver = createPasteCatalogResolver((date) => CATALOG[date] ?? null);
  const text = tsv(rows);
  return { preview: buildWorkerProfilePreview({ text, referenceDate: REFERENCE_DATE, resolver }),
    text };
}

function renderDocument({ preview, text }, expandedRows) {
  const panel = h(WorkerProfilePastePanel, {
    text,
    preview,
    columnsHelpOpen: false,
    expandedRows,
    catalogPending: false,
    closeSlot: h("button", { type: "button", className: styles.secondaryButton }, "Đóng"),
    onTextChange: () => undefined,
    onToggleColumnsHelp: () => undefined,
    onToggleRow: () => undefined,
  });
  const markup = renderToStaticMarkup(
    h("div", { className: styles.page },
      h("div", { className: styles.drawerOverlay },
        h("div", { className: styles.profilePasteDialog, role: "dialog", "aria-modal": "true",
          "aria-labelledby": "worker-profile-paste-heading" },
          h("h2", { id: "worker-profile-paste-heading", className: styles.drawerTitle },
            WORKER_PROFILE_DIALOG_TITLE),
          h("p", { className: styles.drawerDescription }, WORKER_PROFILE_DIALOG_DESCRIPTION),
          panel))));
  const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
  const globals = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  return "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<link rel=\"icon\" href=\"data:,\"><title>R3A preview</title>"
    + "<style>" + globals + "\n" + css + "</style></head><body>" + markup + "</body></html>";
}

const variants = {
  valid: renderDocument(buildPreview(VALID_ROWS), [2]),
  mixed: renderDocument(buildPreview(MIXED_ROWS), [3]),
};

process.stdout.write(JSON.stringify(variants));
