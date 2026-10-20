import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaborTypeCreateRequest,
  buildLaborTypeListQuery,
  buildLaborTypeSetActiveRequest,
  buildLaborTypeUpdateRequest,
  classifyLaborTypeMutation,
  laborTypeListConfirmsKey,
  projectLaborTypeItem,
  projectLaborTypeListForQuery,
} from "./labor-type-catalog-model.ts";

const KEY = "10000000-0000-4000-8000-000000000001";
// Khoa dong tuy y (khong nam trong bat ky bo tu dinh tinh nao) de chung minh
// UI khong gioi han vocabulary: server la nguon khoa duy nhat.
const laborType = {
  labor_type_key: "SEASONAL_2X",
  display_name: "Thời vụ 2X",
  reporting_key: "seasonal_2x",
  sort_order: 10,
  active: true,
  version: 3,
  revision_count: 5,
};

function listPayload(overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-10-11",
      include_inactive: true,
      search: "SEASONAL",
      page: 1,
      page_size: 25,
      total: 1,
      labor_types: [laborType],
      ...overrides,
    },
  };
}

test("strict list and item projections retain only contracted labor-type fields and query echo", () => {
  const list = projectLaborTypeListForQuery(listPayload(), {
    search: "SEASONAL", includeInactive: true, page: 1,
  });
  assert.equal(list?.labor_types[0]?.labor_type_key, "SEASONAL_2X");
  assert.equal(list?.labor_types[0]?.display_name, "Thời vụ 2X");
  assert.equal(projectLaborTypeItem({ ok: true, labor_type: { ...laborType, unexpected: true } }), null);
  assert.equal(projectLaborTypeItem({ ok: true, labor_type: { ...laborType, display_name: "" } }), null);
  assert.equal(projectLaborTypeListForQuery(
    listPayload({ search: "else" }),
    { search: "SEASONAL", includeInactive: true, page: 1 },
  ), null);
  assert.equal(projectLaborTypeListForQuery(
    listPayload({ page_size: 100 }),
    { search: "SEASONAL", includeInactive: true, page: 1 },
  ), null);
});

test("search, inactive filter and pagination use bounded explicit API query", () => {
  const query = buildLaborTypeListQuery({ search: "  ABC ", includeInactive: true, page: 3 });
  assert.equal(query?.toString(), "include_inactive=true&page=3&page_size=25&search=ABC");
  assert.equal(buildLaborTypeListQuery({ search: "x", includeInactive: false, page: 1001 }), null);
  assert.equal(buildLaborTypeListQuery({ search: "x".repeat(257), includeInactive: false, page: 1 }), null);
});

test("create matches API request contract, requires canonical key and version zero", () => {
  const result = buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT",
    displayName: "Ca đêm",
    sortOrder: "20",
    reason: "Tạo mới",
    idempotencyKey: KEY,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.body).sort(), [
    "display_name", "expected_version", "idempotency_key", "labor_type_key", "reason", "sort_order",
  ]);
  assert.equal(result.body.expected_version, 0);
  assert.equal(result.body.sort_order, 20);
  // Khoa khong canonical (chu thuong) bi tu choi tai UI, dung predicate dung chung.
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "night_shift", displayName: "Ca đêm", sortOrder: "20",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "", displayName: "Ca đêm", sortOrder: "20", reason: "x", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "100001",
    reason: "x", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "abc",
    reason: "x", idempotencyKey: KEY,
  }).ok, false);
  const withoutReason = buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "20", idempotencyKey: KEY,
  });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "20",
    reason: "  ", idempotencyKey: KEY,
  }).ok, true);
  const blank = buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "20",
    reason: "  ", idempotencyKey: KEY,
  });
  if (blank.ok) assert.equal(blank.body.reason, null);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "Ca đêm", sortOrder: "20",
    reason: "x".repeat(4001), idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildLaborTypeCreateRequest({
    laborTypeKey: "NIGHT_SHIFT", displayName: "", sortOrder: "20",
    reason: "x", idempotencyKey: KEY,
  }).ok, false);
});

test("update and set-active send exact expected-version, reason and idempotency fields without key or reporting_key", () => {
  const update = buildLaborTypeUpdateRequest({
    displayName: "Tên mới", sortOrder: "30", expectedVersion: 3, reason: "Đổi tên",
    idempotencyKey: KEY,
  });
  const active = buildLaborTypeSetActiveRequest({
    active: false, expectedVersion: 3, reason: "Ngừng", idempotencyKey: KEY,
  });
  assert.equal(update.ok, true);
  assert.equal(active.ok, true);
  if (update.ok) {
    assert.deepEqual(Object.keys(update.body).sort(),
      ["display_name", "expected_version", "idempotency_key", "reason", "sort_order"]);
  }
  if (active.ok) {
    assert.deepEqual(Object.keys(active.body).sort(),
      ["active", "expected_version", "idempotency_key", "reason"]);
  }
  assert.equal(buildLaborTypeUpdateRequest({
    displayName: "Tên", sortOrder: "1", expectedVersion: 0, reason: "x", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildLaborTypeSetActiveRequest({
    active: false, expectedVersion: 0, reason: "x", idempotencyKey: KEY,
  }).ok, false);
});

test("mutation results map applied, stale OCC, denied, not-found and invalid to sanitized outcomes", () => {
  const applied = {
    ok: true,
    labor_type: {
      labor_type_key: "SEASONAL_2X", display_name: "Thời vụ 2X", reporting_key: "seasonal_2x",
      sort_order: 10, active: true, version: 4, revision_id: "revision",
    },
  };
  assert.equal(classifyLaborTypeMutation(200, applied, "update").kind, "applied");
  // create yeu cau created: true (8 key); payload 7 key khong duoc tinh la applied.
  assert.equal(classifyLaborTypeMutation(200, applied, "create").kind, "unavailable");
  assert.equal(classifyLaborTypeMutation(200, { ok: true, labor_type: { ...laborType } }, "update").kind,
    "unavailable");
  assert.equal(classifyLaborTypeMutation(409, null, "update").kind, "conflict");
  assert.equal(classifyLaborTypeMutation(403, null, "update").kind, "denied");
  assert.equal(classifyLaborTypeMutation(401, null, "update").kind, "unauthenticated");
  assert.equal(classifyLaborTypeMutation(404, null, "update").kind, "not-found");
  assert.equal(classifyLaborTypeMutation(400, null, "create").kind, "invalid");
  assert.equal(classifyLaborTypeMutation(500, null, "create").kind, "unavailable");
});

test("create confirmation requires the exact key in an authoritative list reload", () => {
  const list = projectLaborTypeListForQuery(listPayload({ search: "SEASONAL_2X" }), {
    search: "SEASONAL_2X", includeInactive: true, page: 1,
  });
  assert.ok(list);
  assert.equal(laborTypeListConfirmsKey(list, "SEASONAL_2X"), true);
  assert.equal(laborTypeListConfirmsKey(list, "OTHER_KEY"), false);
});
