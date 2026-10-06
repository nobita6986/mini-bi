import assert from "node:assert/strict";
import test from "node:test";

import { parseDirectEntryCatalogResponse } from "./catalog-response.ts";

const DATE = "2026-10-06";
const HRP = {
  recruiter_id: "11111111-1111-4111-8111-111111111111",
  display_name: "Nguyễn Thế Vinh",
  personnel_code: "vinhnt.td",
  provider_type: "hrp",
  vendor_id: null,
  team_id: "22222222-2222-4222-8222-222222222222",
  team_display_name: "Team 1",
  label: "Nguyễn Thế Vinh · vinht.td · Team 1",
};
const VENDOR = {
  recruiter_id: "33333333-3333-4333-8333-333333333333",
  display_name: "VD AN PHÁT",
  personnel_code: null,
  provider_type: "vendor",
  vendor_id: "anphat.vd",
  team_id: null,
  team_display_name: null,
  label: "VD AN PHÁT",
};
const envelope = {
  ok: true,
  catalog: {
    effective_date: DATE,
    projects: [{ project_id: "Newwing", display_name: "New Wing" }],
    recruiters: [HRP, VENDOR],
    banks: [],
  },
};

test("accepts a mixed HRP/Vendor Production catalog with null Vendor team", () => {
  const result = parseDirectEntryCatalogResponse(envelope, DATE);
  assert.equal(result?.recruiters.length, 2);
  assert.equal(result?.recruiters[1].provider_type, "vendor");
  assert.equal(result?.recruiters[1].team_id, null);
});

test("rejects an HRP row without its required team", () => {
  const broken = structuredClone(envelope);
  broken.catalog.recruiters[0].team_id = null;
  assert.equal(parseDirectEntryCatalogResponse(broken, DATE), null);
});

test("rejects a Vendor row carrying an HRP team", () => {
  const broken = structuredClone(envelope);
  broken.catalog.recruiters[1].team_id = HRP.team_id;
  broken.catalog.recruiters[1].team_display_name = HRP.team_display_name;
  assert.equal(parseDirectEntryCatalogResponse(broken, DATE), null);
});

test("rejects an error envelope or a mismatched effective date", () => {
  assert.equal(parseDirectEntryCatalogResponse({ ...envelope, ok: false }, DATE), null);
  assert.equal(parseDirectEntryCatalogResponse(envelope, "2026-10-07"), null);
});
