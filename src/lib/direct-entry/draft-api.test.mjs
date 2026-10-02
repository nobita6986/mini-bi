import assert from "node:assert/strict";
import test from "node:test";

import { getInputCatalog, getOwnDrafts, patchDraftEntry } from "./draft-api.ts";
import {
  createDirectEntryWriteRepository,
  projectDraftCatalog,
  projectDraftUpdate,
  projectOwnDrafts,
} from "./write-repository.ts";

const actor = {
  auth_subject: "91100000-0000-4000-8000-000000000001",
  app_user_id: "92100000-0000-4000-8000-000000000001",
};
const session = async () => ({ actor: { ok: true, actor }, response_headers: {} });
const catalog = {
  effective_date: "2026-10-15",
  projects: [{ project_id: "project_synthetic_01", display_name: "Synthetic project" }],
  recruiters: [{
    recruiter_id: "93100000-0000-4000-8000-000000000001",
    display_name: "Synthetic recruiter",
    provider_type: "hrp",
    team_id: "94100000-0000-4000-8000-000000000001",
    team_display_name: "Synthetic team",
  }],
};
const draft = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  submission_version: 1,
  entry_id: "a2000000-0000-4000-8000-000000000001",
  entry_version: 1,
  employee_code: "hrp-2026-900001",
  first_work_date: "2026-10-15",
  worker_display_name: "Synthetic Worker",
  project_id: "project_synthetic_01",
  project_display_name: "Synthetic project",
  recruiter_id: catalog.recruiters[0].recruiter_id,
  recruiter_display_name: "Synthetic recruiter",
  provider_type: "hrp",
  team_id: catalog.recruiters[0].team_id,
  team_display_name: "Synthetic team",
  labor_type: "TEMPORARY",
  employment_status: "UNCONFIRMED",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};
const patch = {
  project_id: "project_synthetic_01",
  first_work_date: "2026-10-15",
  employee_code: "hrp-2026-900001",
  worker_details: { display_name: "Synthetic Updated" },
  recruiter_id: catalog.recruiters[0].recruiter_id,
  labor_type: "TEMPORARY",
};

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    resolveSession: session,
    repository: {
      async loadInputCatalog(input) {
        calls.push({ operation: "catalog", input });
        return { ok: true, data: catalog };
      },
      async listOwnDrafts(input) {
        calls.push({ operation: "drafts", input });
        return { ok: true, data: [draft] };
      },
      async updateDraftRow(input) {
        calls.push({ operation: "update", input });
        return {
          ok: true,
          data: { entry_id: input.entry_id, version: 2, submission_version: 2 },
        };
      },
      ...overrides,
    },
  };
}

function patchRequest(body, headers = {}) {
  return new Request("https://example.test/api/direct-entry/entries/a2000000-0000-4000-8000-000000000001", {
    method: "PATCH",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "synthetic-update-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("repository projections strictly reject malformed and unexpected fields", () => {
  assert.deepEqual(projectDraftCatalog(catalog), catalog);
  assert.equal(projectDraftCatalog(catalog, "2026-10-16"), null);
  assert.equal(projectDraftCatalog({
    ...catalog,
    projects: [...catalog.projects, catalog.projects[0]],
  }), null);
  assert.equal(projectDraftCatalog({ ...catalog, email: "private@example.test" }), null);
  assert.equal(projectDraftCatalog({
    ...catalog,
    recruiters: [{ ...catalog.recruiters[0], auth_subject: actor.auth_subject }],
  }), null);
  assert.deepEqual(projectOwnDrafts({ drafts: [draft] }), [draft]);
  assert.equal(projectOwnDrafts({ drafts: [draft, draft] }), null);
  assert.equal(projectOwnDrafts({ drafts: [{ ...draft, payment: { account_number: "x" } }] }), null);
  assert.equal(projectOwnDrafts({ drafts: new Array(501).fill(draft) }), null);
  assert.deepEqual(projectDraftUpdate({
    entry_id: draft.entry_id,
    version: 2,
    submission_version: 2,
  }, draft.entry_id), {
    entry_id: draft.entry_id, version: 2, submission_version: 2,
  });

  test("repository maps catalog, drafts, and update only to their named RPCs and fails closed", async () => {
    const calls = [];
    const repository = createDirectEntryWriteRepository(async (name, args) => {
      calls.push({ name, args });
      if (name === "direct_entry_input_catalog") return { data: catalog, error: null };
      if (name === "direct_entry_list_own_drafts") return { data: { drafts: [draft] }, error: null };
      return {
        data: { entry_id: draft.entry_id, version: 2, submission_version: 2 },
        error: null,
      };
    });
    assert.deepEqual(await repository.loadInputCatalog({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      effective_date: catalog.effective_date,
    }), { ok: true, data: catalog });
    assert.deepEqual(await repository.listOwnDrafts(actor), { ok: true, data: [draft] });
    assert.deepEqual(await repository.updateDraftRow({
      ...actor,
      entry_id: draft.entry_id,
      expected_version: 1,
      patch,
      idempotency_key: "synthetic-update-01",
    }), {
      ok: true,
      data: { entry_id: draft.entry_id, version: 2, submission_version: 2 },
    });
    assert.deepEqual(calls.map(({ name }) => name), [
      "direct_entry_input_catalog",
      "direct_entry_list_own_drafts",
      "direct_entry_update_draft_row",
    ]);
    assert.equal(calls[0].args.p_auth_subject, actor.auth_subject);
    assert.equal(calls[0].args.p_app_user_id, actor.app_user_id);
    assert.equal(calls[0].args.p_effective_date, catalog.effective_date);
    assert.equal(calls[2].args.p_expected_version, 1);
    assert.equal(calls[2].args.p_idempotency_key, "synthetic-update-01");

    const malformed = createDirectEntryWriteRepository(async () => ({ data: null, error: null }));
    assert.deepEqual(await malformed.loadInputCatalog({
      ...actor, effective_date: catalog.effective_date,
    }), { ok: false, kind: "unavailable" });
    assert.deepEqual(await malformed.listOwnDrafts(actor), { ok: false, kind: "unavailable" });
    assert.deepEqual(await malformed.updateDraftRow({
      ...actor,
      entry_id: draft.entry_id,
      expected_version: 1,
      patch,
      idempotency_key: "synthetic-update-02",
    }), { ok: false, kind: "unavailable" });
  });
  assert.equal(projectDraftUpdate({
    entry_id: draft.entry_id, version: 2, submission_version: 2, audit: {},
  }, draft.entry_id), null);
});

test("catalog gate and effective date validation happen before session or RPC", async () => {
  let sessions = 0;
  const dependencies = deps();
  dependencies.resolveSession = async () => { sessions += 1; return session(); };
  assert.equal((await getInputCatalog("2026-10-15", undefined, dependencies)).status, 404);
  assert.equal((await getInputCatalog("2026-02-30", "true", dependencies)).status, 400);
  assert.equal(sessions, 0);
  assert.equal(dependencies.calls.length, 0);
});

test("catalog and own draft routes only forward trusted actor IDs and return private no-store", async () => {
  const dependencies = deps();
  const catalogResponse = await getInputCatalog("2026-10-15", "true", dependencies);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(dependencies.calls[0], {
    operation: "catalog",
    input: { ...actor, effective_date: "2026-10-15" },
  });
  assert.equal(catalogResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(JSON.stringify(await catalogResponse.json()).includes(actor.auth_subject), false);

  const draftsResponse = await getOwnDrafts("true", dependencies);
  assert.equal(draftsResponse.status, 200);
  assert.deepEqual(dependencies.calls[1], { operation: "drafts", input: actor });
  assert.equal(draftsResponse.headers.get("cache-control"), "private, no-store");

  const limited = deps({
    async listOwnDrafts() { return { ok: false, kind: "too-large" }; },
  });
  assert.equal((await getOwnDrafts("true", limited)).status, 413);
});

test("unauthenticated and actor-denied requests are sanitized", async () => {
  const anonymous = deps();
  anonymous.resolveSession = async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
    response_headers: {},
  });
  assert.equal((await getOwnDrafts("true", anonymous)).status, 401);
  const denied = deps({
    async listOwnDrafts() { return { ok: false, kind: "denied", detail: "private db" }; },
  });
  const response = await getOwnDrafts("true", denied);
  assert.equal(response.status, 403);
  assert.equal(JSON.stringify(await response.json()).includes("private db"), false);
});

test("PATCH checks gate, UUID, origin, content type, key and nested authority fields", async () => {
  const dependencies = deps();
  const valid = { expected_version: 1, patch };
  assert.equal((await patchDraftEntry(patchRequest(valid), "bad", "true", dependencies)).status, 400);
  assert.equal((await patchDraftEntry(patchRequest(valid), draft.entry_id, undefined, dependencies)).status, 404);
  assert.equal((await patchDraftEntry(patchRequest(valid, { origin: "https://evil.test" }), draft.entry_id, "true", dependencies)).status, 403);
  assert.equal((await patchDraftEntry(patchRequest(valid, { "content-type": "application/jsonp" }), draft.entry_id, "true", dependencies)).status, 400);
  assert.equal((await patchDraftEntry(patchRequest(valid, { "idempotency-key": "x".repeat(129) }), draft.entry_id, "true", dependencies)).status, 400);
  const injected = patchRequest({
    expected_version: 1,
    patch: { ...patch, worker_details: { display_name: "Synthetic", team_id: actor.app_user_id } },
  });
  assert.equal((await patchDraftEntry(injected, draft.entry_id, "true", dependencies)).status, 400);
  assert.equal(dependencies.calls.length, 0);
});

test("PATCH loads effective-date master data then updates with server actor and expected version", async () => {
  const dependencies = deps();
  const response = await patchDraftEntry(
    patchRequest({ expected_version: 1, patch }),
    draft.entry_id,
    "true",
    dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    entry_id: draft.entry_id,
    entry_version: 2,
    submission_version: 2,
  });
  assert.deepEqual(dependencies.calls.map(({ operation }) => operation), ["catalog", "update"]);
  assert.deepEqual(dependencies.calls[1].input, {
    ...actor,
    entry_id: draft.entry_id,
    expected_version: 1,
    patch,
    idempotency_key: "synthetic-update-01",
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const conflict = deps({
    async updateDraftRow() { return { ok: false, kind: "conflict" }; },
  });
  assert.equal((await patchDraftEntry(
    patchRequest({ expected_version: 1, patch }), draft.entry_id, "true", conflict,
  )).status, 409);
  const invalidMaster = deps();
  invalidMaster.repository.loadInputCatalog = async (input) => {
    invalidMaster.calls.push({ operation: "catalog", input });
    return { ok: true, data: { ...catalog, projects: [] } };
  };
  assert.equal((await patchDraftEntry(
    patchRequest({ expected_version: 1, patch }), draft.entry_id, "true", invalidMaster,
  )).status, 400);
  assert.equal(invalidMaster.calls.length, 1);
});
