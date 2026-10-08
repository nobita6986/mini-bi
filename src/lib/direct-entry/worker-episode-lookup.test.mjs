import assert from "node:assert/strict";
import test from "node:test";

import {
  projectWorkerEpisodeLookupPage,
  projectWorkerEpisodeLookupQuery,
} from "./worker-episode-lookup-contract.ts";
import { createWorkerEpisodeLookupRepository } from "./worker-episode-lookup-repository.ts";
import { lookupWorkerEpisodes } from "./worker-episode-lookup-api.ts";
import { createFullProfileRepository } from "./full-profile-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "c1000000-0000-4000-8000-000000000001";

const episode = {
  entry_id: entryId,
  display_name: "Worker One",
  employee_code: "hrp-2026-300001",
  project_id: "proj_a",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  latest_status: "OFF",
};
const worker = {
  display_name: "Worker One",
  employee_code: "hrp-2026-300001",
  episode_count: 1,
  active_episode_exists: false,
  rehire_allowed: true,
  episodes: [episode],
};
const page = {
  match: "national_id",
  project_id: "proj_a",
  page_size: 20,
  offset: 0,
  has_more: false,
  workers: [worker],
  authorization_date: "2026-10-08",
};

function query(params) {
  return projectWorkerEpisodeLookupQuery(
    typeof params === "string" ? new URLSearchParams(params) : new URLSearchParams(params));
}

test("query accepts a name or an exact CCCD and rejects anything else", () => {
  assert.deepEqual(query({ project_id: "proj_a", display_name: "Worker One" }),
    { ok: true, value: { project_id: "proj_a", display_name: "Worker One", national_id: null,
      page_size: 20, offset: 0 } });
  // Separators are dropped and the leading zero survives as text.
  assert.deepEqual(query({ project_id: "proj_a", national_id: "0123 456 78901" }),
    { ok: true, value: { project_id: "proj_a", display_name: null,
      national_id: "012345678901", page_size: 20, offset: 0 } });
  assert.deepEqual(query({ project_id: "proj_a", display_name: "Worker One",
    national_id: "012345678901", page_size: "50", offset: "20" }),
  { ok: true, value: { project_id: "proj_a", display_name: "Worker One",
    national_id: "012345678901", page_size: 50, offset: 20 } });

  for (const params of [
    {},
    { project_id: "proj_a" },
    { display_name: "Worker One" },
    { project_id: "bad project", display_name: "Worker One" },
    { project_id: "proj_a", display_name: "  " },
    { project_id: "proj_a", display_name: "x".repeat(129) },
    { project_id: "proj_a", national_id: "abc" },
    { project_id: "proj_a", national_id: "12345" },
    { project_id: "proj_a", national_id: "0123456789012" },
    { project_id: "proj_a", national_id: "12345678901x" },
    { project_id: "proj_a", display_name: "Worker One", page_size: "0" },
    { project_id: "proj_a", display_name: "Worker One", page_size: "51" },
    { project_id: "proj_a", display_name: "Worker One", offset: "5001" },
    { project_id: "proj_a", display_name: "Worker One", order: "first_work_date" },
    { project_id: "proj_a", display_name: "Worker One", app_user_id: actor.app_user_id },
    { project_id: "proj_a", display_name: "Worker One", auth_subject: actor.auth_subject },
    { project_id: "proj_a", display_name: "Worker One", scope: "all" },
  ]) {
    assert.deepEqual(query(params), { ok: false, code: "WORKER_EPISODE_QUERY_INVALID" },
      JSON.stringify(params));
  }
  assert.deepEqual(query("project_id=proj_a&display_name=A&display_name=B"),
    { ok: false, code: "WORKER_EPISODE_QUERY_INVALID" });
  assert.deepEqual(query("project_id=proj_a&national_id=012345678901"),
    { ok: true, value: { project_id: "proj_a", display_name: null, national_id: "012345678901",
      page_size: 20, offset: 0 } });
});

test("result projection is strict: exact keys, exact types, no coercion", () => {
  const expected = { page_size: 20, offset: 0 };
  assert.deepEqual(projectWorkerEpisodeLookupPage(page, expected), page);
  for (const broken of [
    { ...page, national_id: "012345678901" },
    { ...page, match: "name" },
    { ...page, page_size: 25 },
    { ...page, offset: 20 },
    { ...page, has_more: "false" },
    { ...page, authorization_date: "08/10/2026" },
    (() => { const copy = { ...page }; delete copy.workers; return copy; })(),
    { ...page, workers: [{ ...worker, episodes: [] }] },
    { ...page, workers: [{ ...worker, rehire_allowed: true, active_episode_exists: true }] },
    { ...page, workers: [{ ...worker, episode_count: "1" }] },
    { ...page, workers: [{ ...worker, episodes: [{ ...episode, date_of_birth: "1990-01-01" }] }] },
    { ...page, workers: [{ ...worker, episodes: [{ ...episode, employee_code: "hrp-1" }] }] },
    { ...page, workers: [{ ...worker, episodes: [{ ...episode, latest_status: "MAYBE" }] }] },
  ]) {
    assert.equal(projectWorkerEpisodeLookupPage(broken, expected), null, JSON.stringify(broken));
  }
});

test("repository sends only server actor refs and classifies failures", async () => {
  const calls = [];
  const ok = createWorkerEpisodeLookupRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: page, error: null };
  });
  const result = await ok.lookup({ ...actor, project_id: "proj_a", display_name: "Worker One",
    national_id: null, page_size: 20, offset: 0 });
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "direct_entry_lookup_worker_episodes");
  assert.deepEqual(calls[0].args, {
    p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id,
    p_project_id: "proj_a", p_display_name: "Worker One", p_national_id: null,
    p_page_size: 20, p_offset: 0,
  });

  for (const [code, kind] of [["42501", "denied"], ["22023", "invalid"], ["P0002", "not-found"],
    ["23505", "unavailable"], ["XX000", "unavailable"]]) {
    const failing = createWorkerEpisodeLookupRepository(async () => ({
      data: null, error: { code, message: "raw db message" },
    }));
    const outcome = await failing.lookup({ ...actor, project_id: "proj_a", display_name: "x",
      national_id: null, page_size: 20, offset: 0 });
    assert.deepEqual(outcome, { ok: false, kind }, code);
  }
  const malformed = createWorkerEpisodeLookupRepository(async () => ({ data: { ok: true }, error: null }));
  assert.deepEqual(await malformed.lookup({ ...actor, project_id: "proj_a", display_name: "x",
    national_id: null, page_size: 20, offset: 0 }), { ok: false, kind: "unavailable" });
});

function request(path) {
  return new Request("https://example.test" + path, { method: "GET" });
}

function dependencies(repository = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async lookup(input) {
        calls.push(input);
        return { ok: true, data: page };
      },
      ...repository,
    },
  };
}

test("the API gate runs before the query, the session and the repository", async () => {
  const deps = dependencies();
  const response = await lookupWorkerEpisodes(
    request("/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x"), undefined, deps);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("invalid queries fail before the session; the actor only comes from the session", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/workers/episodes",
    "/api/direct-entry/workers/episodes?project_id=proj_a",
    "/api/direct-entry/workers/episodes?display_name=x",
    "/api/direct-entry/workers/episodes?project_id=proj_a&national_id=abc",
    "/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x&page_size=99",
    "/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x&app_user_id=" + actor.app_user_id,
  ]) {
    const response = await lookupWorkerEpisodes(request(path), "true", deps);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).code, "WORKER_EPISODE_QUERY_INVALID", path);
  }
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);

  const session = dependencies();
  const response = await lookupWorkerEpisodes(
    request("/api/direct-entry/workers/episodes?project_id=proj_a&national_id=012345678901"),
    "true", session);
  assert.equal(response.status, 200);
  assert.deepEqual(session.calls[0], {
    auth_subject: actor.auth_subject, app_user_id: actor.app_user_id, project_id: "proj_a",
    display_name: null, national_id: "012345678901", page_size: 20, offset: 0,
  });
});

test("the API fails closed on session, authority and malformed results", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await lookupWorkerEpisodes(
      request("/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x"), "true", deps);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }

  for (const [kind, status, code] of [["denied", 403, "WORKER_EPISODE_LOOKUP_DENIED"],
    ["not-found", 403, "WORKER_EPISODE_LOOKUP_DENIED"],
    ["invalid", 400, "WORKER_EPISODE_QUERY_INVALID"],
    ["unavailable", 500, "WORKER_EPISODE_LOOKUP_UNAVAILABLE"]]) {
    const deps = dependencies({ async lookup() { return { ok: false, kind }; } });
    const response = await lookupWorkerEpisodes(
      request("/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x"), "true", deps);
    assert.equal(response.status, status, kind);
    assert.equal((await response.json()).code, code, kind);
  }

  const good = await lookupWorkerEpisodes(
    request("/api/direct-entry/workers/episodes?project_id=proj_a&display_name=x"), "true",
    dependencies());
  assert.equal(good.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await good.json(), {
    ok: true, match: "national_id", project_id: "proj_a", page_size: 20, offset: 0,
    has_more: false, workers: [worker], authorization_date: "2026-10-08",
  });
});

// ---------------------------------------------------------------------------
// P2.5-HF-R1 finding 3: the episode guard message never reaches the client.
// ---------------------------------------------------------------------------
test("the rehire refusal is translated into a safe code, never a raw DB message", async () => {
  for (const [dbMessage, expected] of [
    ["worker_active_episode_exists", "WORKER_ACTIVE_EPISODE_EXISTS"],
    ["worker_episode_reopen_forbidden", "WORKER_EPISODE_REOPEN_FORBIDDEN"],
    ["some unmapped guard message", "BATCH_INVALID"],
  ]) {
    const repository = createFullProfileRepository(async () => ({
      data: null, error: { code: "23505", message: dbMessage },
    }));
    const result = await repository.createFullProfileBatch({
      auth_subject: actor.auth_subject, app_user_id: actor.app_user_id,
      payload: { contract_version: "worker-profile/1.0", rows: [] },
      idempotency_key: "00000000-0000-4000-8000-000000000001",
    });
    assert.deepEqual(result, { ok: false, kind: "invalid", code: expected }, dbMessage);
    assert.equal(JSON.stringify(result).includes(dbMessage), false,
      "the raw database message must never be forwarded");
  }
});
