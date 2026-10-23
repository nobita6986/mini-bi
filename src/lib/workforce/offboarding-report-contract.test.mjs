import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOffboardingReportExport,
  parseOffboardingReportList,
} from "./offboarding-report-contract.ts";

const item = {
  employee_code: "hrp-2026-000001",
  display_name: "Nguyễn Văn A",
  project_id: "project-a",
  project_display: "Dự án A",
  recruiter_id: "10000000-0000-4000-8000-000000000001",
  recruiter_display: "Người tuyển A",
  off_effective_date: "2026-10-20",
  days_since_off: 4,
  phone: "0912345678",
};

test("offboarding RPC projectors accept the raw Supabase RPC payload and fail closed on API envelopes", () => {
  const list = {
    scope: "all",
    authority: "admin",
    can_export: true,
    authorization_date: "2026-10-24",
    page: 1,
    page_size: 25,
    total: 1,
    has_more: false,
    items: [item],
  };
  assert.deepEqual(parseOffboardingReportList(list), list);
  assert.equal(parseOffboardingReportList({ ok: true, data: list }), null);
  assert.equal(parseOffboardingReportList({ ...list, items: [{ ...item, days_since_off: 2 }] }), null);

  const exported = { authorization_date: "2026-10-24", items: [item] };
  assert.deepEqual(parseOffboardingReportExport(exported), exported);
  assert.equal(parseOffboardingReportExport({ ok: true, data: exported }), null);
});
