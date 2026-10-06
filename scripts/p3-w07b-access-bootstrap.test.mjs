import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_IDS,
  EXTRA_ACCOUNT_IDS,
  HRP_ACCOUNT_IDS,
  PROJECT_MANAGER_BY_ID,
} from "./p3-w07b-access-bootstrap.mjs";

test("W07B bootstrap locks the exact account and assignment sets", () => {
  assert.equal(HRP_ACCOUNT_IDS.length, 52);
  assert.deepEqual(EXTRA_ACCOUNT_IDS, ["lienvu", "ngant.hr"]);
  assert.equal(ACCOUNT_IDS.length, 54);
  assert.equal(new Set(ACCOUNT_IDS).size, 54);
  assert.ok(ACCOUNT_IDS.every((id) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)));

  assert.equal(Object.keys(PROJECT_MANAGER_BY_ID).length, 66);
  assert.equal(PROJECT_MANAGER_BY_ID.Ability, "ngocva.td");
  assert.equal(PROJECT_MANAGER_BY_ID.TKDT, "chivv.td");
  assert.equal(PROJECT_MANAGER_BY_ID.Glitter, "nhieunt.td");
  assert.equal(PROJECT_MANAGER_BY_ID.Optrontech, "vietnt.td");
  assert.equal(PROJECT_MANAGER_BY_ID.JFS, "toannv.td");
  assert.equal(Object.hasOwn(PROJECT_MANAGER_BY_ID, "AP"), false);
  assert.equal(Object.hasOwn(PROJECT_MANAGER_BY_ID, "TSCO"), false);
  assert.ok(Object.values(PROJECT_MANAGER_BY_ID).every((id) => HRP_ACCOUNT_IDS.includes(id)));
});
