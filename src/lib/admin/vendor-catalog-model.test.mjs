import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVendorCreateRequest,
  buildVendorListQuery,
  buildVendorSetActiveRequest,
  buildVendorUpdateRequest,
  classifyVendorMutation,
  projectVendorItem,
  projectVendorListForQuery,
} from "./vendor-catalog-model.ts";

const KEY = "10000000-0000-4000-8000-000000000001";
const vendor = {
  vendor_id: "SUP-01",
  display_name: "Nhà cung cấp A",
  active: true,
  version: 4,
  revision_count: 6,
  recruiter_id: null,
};

test("strict list and item projections retain only contracted vendor fields and query echo", () => {
  const list = projectVendorListForQuery({
    ok: true,
    list: {
      authorization_date: "2026-10-11",
      include_inactive: true,
      search: "SUP",
      page: 1,
      page_size: 25,
      total: 1,
      vendors: [vendor],
    },
  }, { search: "SUP", includeInactive: true, page: 1 });
  assert.equal(list?.vendors[0]?.vendor_id, "SUP-01");
  assert.equal(projectVendorItem({ ok: true, vendor: { ...vendor, unexpected: true } }), null);
  assert.equal(projectVendorListForQuery({
    ok: true,
    list: {
      authorization_date: "2026-10-11", include_inactive: true, search: "else",
      page: 1, page_size: 25, total: 1, vendors: [vendor],
    },
  }, { search: "SUP", includeInactive: true, page: 1 }), null);
});

test("search, inactive filter and pagination use bounded explicit API query", () => {
  const query = buildVendorListQuery({ search: "  ABC ", includeInactive: true, page: 3 });
  assert.equal(query?.toString(), "include_inactive=true&page=3&page_size=25&search=ABC");
  assert.equal(buildVendorListQuery({ search: "x", includeInactive: false, page: 1001 }), null);
});

test("create matches API request contract and keeps create version zero", () => {
  const result = buildVendorCreateRequest({
    vendorId: "SUP-02",
    displayName: "Nhà cung cấp B",
    effectiveDate: "2032-02-29",
    reason: "Tạo mới",
    idempotencyKey: KEY,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.body).sort(), [
    "display_name", "expected_version", "idempotency_key", "reason", "valid_from", "vendor_id",
  ]);
  assert.equal(result.body.expected_version, 0);
  assert.equal(result.body.valid_from, "2032-02-29");
  const withoutReason = buildVendorCreateRequest({ vendorId: "SUP-01", displayName: "Vendor",
    effectiveDate: "2032-02-29", idempotencyKey: KEY });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  const blankReason = buildVendorCreateRequest({ vendorId: "SUP-01", displayName: "Vendor",
    effectiveDate: "2032-02-29", reason: "  ", idempotencyKey: KEY });
  assert.equal(blankReason.ok, true);
  if (blankReason.ok) assert.equal(blankReason.body.reason, null);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2026-02-29",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "__system_vendor__", displayName: "Reserved", effectiveDate: "2026-10-11",
    reason: "x", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2024-02-29",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, true);
});

test("update and set-active send exact expected-version, reason and idempotency fields", () => {
  const update = buildVendorUpdateRequest({
    displayName: "Tên mới", expectedVersion: 4, reason: "Đổi tên", idempotencyKey: KEY,
  });
  const active = buildVendorSetActiveRequest({
    active: false, expectedVersion: 4, reason: "Ngừng", idempotencyKey: KEY,
  });
  assert.equal(update.ok, true);
  assert.equal(active.ok, true);
  const withoutReason = buildVendorUpdateRequest({ displayName: "Tên", expectedVersion: 2,
    idempotencyKey: KEY });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  if (update.ok) {
    assert.deepEqual(Object.keys(update.body).sort(),
      ["display_name", "expected_version", "idempotency_key", "reason"]);
  }
  if (active.ok) {
    assert.deepEqual(Object.keys(active.body).sort(),
      ["active", "expected_version", "idempotency_key", "reason"]);
  }
  assert.equal(buildVendorUpdateRequest({
    displayName: "Tên", expectedVersion: 0, reason: "x", idempotencyKey: KEY,
  }).ok, false);
});

test("mutation results map applied, stale OCC, denied and invalid to sanitized outcomes", () => {
  const applied = {
    ok: true,
    vendor: {
      vendor_id: "SUP-01", display_name: "Nhà cung cấp A", active: true, version: 5,
      revision_id: "revision", recruiter_id: null,
    },
  };
  assert.equal(classifyVendorMutation(200, applied, "update").kind, "applied");
  assert.equal(classifyVendorMutation(409, null, "update").kind, "conflict");
  assert.equal(classifyVendorMutation(403, null, "update").kind, "denied");
  assert.equal(classifyVendorMutation(400, null, "create").kind, "invalid");
});
