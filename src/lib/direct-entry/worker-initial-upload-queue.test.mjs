import assert from "node:assert/strict";
import test from "node:test";

import { mapSavedWorkerInitialUploads } from "./worker-initial-upload-queue.ts";

test("partial save maps only submitted client rows to their server entry IDs", () => {
  const validA = { contract: "file-a" };
  const invalidB = { contract: "must-stay-staged" };
  const validC = { cccdFront: "file-c" };
  const mapped = mapSavedWorkerInitialUploads({
    clientRowIds: ["row-a", "row-c"],
    entryIds: ["entry-a", "entry-c"],
    uploadsByClientRowId: new Map([
      ["row-a", validA],
      ["row-b", invalidB],
      ["row-c", validC],
    ]),
  });

  assert.ok(mapped);
  assert.equal(mapped.size, 2);
  assert.equal(mapped.get("entry-a"), validA);
  assert.equal(mapped.get("entry-c"), validC);
  assert.equal(mapped.has("entry-b"), false);
});

test("mismatched, duplicate, or empty IDs fail closed rather than misbinding files", () => {
  const uploads = new Map([["row-a", { contract: "file-a" }]]);
  assert.equal(mapSavedWorkerInitialUploads({
    clientRowIds: ["row-a"], entryIds: [], uploadsByClientRowId: uploads,
  }), null);
  assert.equal(mapSavedWorkerInitialUploads({
    clientRowIds: ["row-a", "row-a"], entryIds: ["entry-a", "entry-b"], uploadsByClientRowId: uploads,
  }), null);
  assert.equal(mapSavedWorkerInitialUploads({
    clientRowIds: ["row-a"], entryIds: [""], uploadsByClientRowId: uploads,
  }), null);
});
