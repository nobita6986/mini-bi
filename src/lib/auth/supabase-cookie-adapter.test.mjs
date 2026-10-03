import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseCookieAdapter } from "./supabase-cookie-adapter.ts";

test("SSR getAll/setAll read and write every cookie with options intact", () => {
  const cookies = new Map([["sb-access-token", "old"]]);
  const writes = [];
  const adapter = createSupabaseCookieAdapter({
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    set: (name, value, options) => {
      writes.push({ name, value, options });
      cookies.set(name, value);
    },
  });
  assert.deepEqual(adapter.getAll(), [{ name: "sb-access-token", value: "old" }]);
  adapter.setAll([
    { name: "sb-access-token", value: "new", options: { httpOnly: true, sameSite: "lax", path: "/" } },
    { name: "sb-refresh-token", value: "refresh", options: { httpOnly: true, sameSite: "lax", path: "/" } },
  ], { "cache-control": "no-store" });
  assert.equal(adapter.getAll().length, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.httpOnly, true);
});
