/**
 * Targeted tests cho navigation registry.
 * Style: node:test + pure assertions trên module exports.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// registry.ts là TypeScript — dùng dynamic import để Node loader xử lý
// (đã được khai báo trong scripts.test:main dưới --conditions=react-server
// hoặc node loader sẽ compile .ts trong monorepos cấu hình TS).
// Để chạy độc lập (không qua scripts.test:main), dùng `node --experimental-strip-types`.
const mod = await import("./registry.ts");
const { CURRENT_NAV_ENTRIES, NAV_ENTRIES, entriesForViewport, findEntryByPath } = mod;

test("registry không rỗng và chứa tối thiểu 2 entry 'current' cho Dashboard và Pipeline Check", () => {
  assert.ok(NAV_ENTRIES.length >= 2, "registry phải có ít nhất 2 entry");
  const currentIds = CURRENT_NAV_ENTRIES.map((e) => e.id);
  assert.ok(currentIds.includes("dashboard"), "registry phải có 'dashboard' ở trạng thái current");
  assert.ok(currentIds.includes("pipeline-check"), "registry phải có 'pipeline-check' ở trạng thái current");
});

test("mỗi entry có id ổn định, label, path, icon, status, capability, visibility", () => {
  for (const entry of NAV_ENTRIES) {
    assert.ok(entry.id.length > 0, `entry phải có id hợp lệ (got '${entry.id}')`);
    assert.ok(entry.label.length > 0, `entry '${entry.id}' phải có label`);
    assert.ok(entry.path.startsWith("/"), `entry '${entry.id}' path phải bắt đầu bằng '/'`);
    assert.ok(typeof entry.icon === "function" || typeof entry.icon === "object", `entry '${entry.id}' phải có icon component (function hoặc forwardRef object)`);
    assert.ok(
      entry.status === "current" || entry.status === "planned",
      `entry '${entry.id}' status không hợp lệ: ${entry.status}`
    );
    assert.ok(typeof entry.description === "string" && entry.description.length > 0);
    assert.ok(typeof entry.capability === "string");
    assert.ok(typeof entry.visibility.desktop === "boolean");
    assert.ok(typeof entry.visibility.mobile === "boolean");
  }
});

test("id của các entry là duy nhất", () => {
  const ids = NAV_ENTRIES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `id trùng lặp: ${ids.join(", ")}`);
});

test("path của các entry là duy nhất (tránh collision khi active match)", () => {
  const paths = NAV_ENTRIES.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, `path trùng lặp: ${paths.join(", ")}`);
});

test("CURRENT_NAV_ENTRIES chỉ chứa status = 'current'", () => {
  for (const entry of CURRENT_NAV_ENTRIES) {
    assert.equal(entry.status, "current");
  }
});

test("entriesForViewport('desktop') trả về entry có visibility.desktop = true", () => {
  const desktop = entriesForViewport("desktop");
  assert.ok(desktop.length > 0, "phải có ít nhất 1 entry cho desktop");
  for (const entry of desktop) {
    assert.equal(entry.visibility.desktop, true);
  }
});

test("entriesForViewport('mobile') trả về entry có visibility.mobile = true", () => {
  const mobile = entriesForViewport("mobile");
  assert.ok(mobile.length > 0, "phải có ít nhất 1 entry cho mobile");
  for (const entry of mobile) {
    assert.equal(entry.visibility.mobile, true);
  }
});

test("findEntryByPath trả về entry khớp path", () => {
  const entry = findEntryByPath("/dashboard");
  assert.ok(entry);
  assert.equal(entry?.id, "dashboard");
});

test("findEntryByPath trả về undefined cho path không đăng ký (vd. landing '/')", () => {
  const entry = findEntryByPath("/");
  assert.equal(entry, undefined);
});

test("entry 'planned' tồn tại trong registry nhưng KHÔNG có trong CURRENT_NAV_ENTRIES", () => {
  const planned = NAV_ENTRIES.filter((e) => e.status === "planned");
  assert.ok(planned.length >= 1, "registry nên có entry 'planned' để P1.6/P2/P3 mở rộng");
  const plannedIds = new Set(planned.map((e) => e.id));
  for (const current of CURRENT_NAV_ENTRIES) {
    assert.ok(!plannedIds.has(current.id), `entry '${current.id}' là 'planned' không được nằm trong CURRENT_NAV_ENTRIES`);
  }
});
