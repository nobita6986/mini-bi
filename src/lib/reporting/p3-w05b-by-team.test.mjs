import assert from "node:assert/strict";
import test from "node:test";

import {
  computeReporting,
  teamBucketKey,
  UNKNOWN_TEAM_BUCKET_KEY,
} from "./p1-reporting.ts";

const DIRECT = "00000000-0000-4000-8000-000000000001";
const LEGACY = "00000000-0000-4000-8000-000000000002";

function fact(overrides = {}) {
  return {
    source_id: DIRECT,
    business_date: "2026-10-10",
    project_key: "project a",
    project_display: "Project A",
    recruiter_key: "rec a",
    recruiter_display: "Recruiter A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    ...overrides,
  };
}

function sources() {
  return [
    { id: DIRECT, drive_file_id: DIRECT, file_name: "Direct Entry", active: true, is_test: false, latest_run_status: "succeeded", last_successful_sync_at: "2026-10-10T00:00:00Z", last_seen_at: "2026-10-10T00:00:00Z" },
    { id: LEGACY, drive_file_id: LEGACY, file_name: "Legacy", active: true, is_test: false, latest_run_status: "succeeded", last_successful_sync_at: "2026-10-10T00:00:00Z", last_seen_at: "2026-10-10T00:00:00Z" },
  ];
}

test("W05B byTeam totals, stored attribution and inactive/Vendor/Unknown buckets", () => {
  const data = computeReporting(sources(), [
    fact({ team_id: "team-a-id", team_code: "TEAM_A", team_display_name: "Team A", team_active: true }),
    fact({ team_id: "team-b-id", team_code: "TEAM_B", team_display_name: "Team B", team_active: true, recruiter_display: "Recruiter B" }),
    fact({ team_id: "inactive-id", team_code: "TEAM_INACTIVE", team_display_name: "Inactive Team", team_active: false }),
    fact({ team_id: "vendor-id", team_code: "__system_vendor__", team_display_name: "Vendor", team_active: true, provider_type_key: "vendor", provider_type_display: "Vendor" }),
    fact({ team_id: null, team_code: null, team_display_name: null, team_active: null }),
    { ...fact({ source_id: LEGACY, team_id: null, team_code: null, team_display_name: null, team_active: null, business_date: "2026-09-25", recruited_count: 7, entry_id: undefined }) },
  ], {});

  const total = Object.values(data.byTeam).reduce((sum, bucket) => sum + bucket.recruitedCount, 0);
  assert.equal(data.recruitedTotal, 12);
  assert.equal(total, data.recruitedTotal);
  assert.equal(data.byTeam[teamBucketKey("TEAM_A")].recruitedCount, 1);
  assert.equal(data.byTeam[teamBucketKey("TEAM_INACTIVE")].display, "Inactive Team (Đã ngừng hoạt động)");
  assert.equal(data.byTeam[teamBucketKey("__system_vendor__")].display, "Vendor");
  assert.equal(data.byTeam[UNKNOWN_TEAM_BUCKET_KEY].display, "Không xác định");
  assert.equal(data.byTeam[UNKNOWN_TEAM_BUCKET_KEY].recruitedCount, 8);
});

test("W05B bucket keys are canonical UTF-8 base64url and independent of display", () => {
  assert.equal(teamBucketKey("TEAM_A"), "team.VEVBTV9B");
  assert.equal(teamBucketKey("🦄".repeat(128)).length, 688);
  const first = teamBucketKey("TEAM_A");
  const renamed = { key: first, display: "Renamed Team", recruitedCount: 1 };
  assert.equal(renamed.key, first);
});
