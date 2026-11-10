import assert from "node:assert/strict";
import test from "node:test";

import {
  handleRecruitmentPostContext,
  handleRecruitmentPostCreate,
  handleRecruitmentPostGet,
  handleRecruitmentPostList,
  handleRecruitmentPostListMine,
  handleRecruitmentPostUpdate,
  handleRecruitmentPostWithdraw,
} from "./api.ts";

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
  display_name: "Nguyễn Văn A",
  enabled: true,
};
const BRIEF_ID = "33333333-3333-4333-8333-333333333333";
const PROVINCE_ID = "44444444-4444-4444-8444-444444444444";
const PARK_ID = "55555555-5555-4555-8555-555555555555";
const IDEM_KEY = "66666666-6666-4666-8666-666666666666";
const FILTER_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function makeValidContent() {
  return {
    general: {
      customer_name: "Công ty A",
      investment_origin: null,
      manufacturing_industry: null,
      job_description: "Lắp ráp điện tử",
      environment_types: ["CLEAN_ROOM"],
      work_postures: ["STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Nguyễn Văn Quản Lý",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: null,
      expected_headcount: 30,
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "NONE",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: null,
      other_requirements_text: null,
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: null,
      attendance_bonus_vnd: null,
      attendance_bonus_conditions: null,
      living_allowance_vnd: null,
      living_allowance_conditions: null,
      seniority_allowance_vnd: null,
      seniority_allowance_conditions: null,
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9000000",
      average_income_max_vnd: "12000000",
      salary_payment_schedule: null,
      salary_advance_available: false,
      salary_advance_amount_vnd: null,
      salary_advance_schedule: null,
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: null,
      day_shift_11h_vnd: null,
      night_shift_8h_vnd: null,
      night_shift_11h_vnd: null,
      sunday_day_11h_vnd: null,
      sunday_night_11h_vnd: null,
      holiday_day_11h_vnd: null,
      holiday_night_11h_vnd: null,
      ppe_provided: false,
      ppe_details: null,
      other_benefits: null,
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
    },
  };
}

const SAMPLE_ITEM = {
  brief_id: BRIEF_ID,
  version: 1,
  status: "PUBLISHED",
  project: { project_id: "PROJ_A", display_name: "Dự án A" },
  industrial_park: {
    industrial_park_id: PARK_ID,
    industrial_park_code: "VP_BA_THIEN_1",
    display_name: "KCN Bá Thiện 1",
    active: true,
  },
  province: {
    province_id: PROVINCE_ID,
    province_code: "VINH_PHUC",
    display_name: "Vĩnh Phúc",
  },
  published_at: "2026-11-10T08:00:00.123456Z",
  updated_at: "2026-11-10T08:00:00.123456Z",
  withdrawn_at: null,
  created_by_display_name: "Nguyễn Văn A",
  updated_by_display_name: "Nguyễn Văn A",
  withdrawn_by_display_name: null,
  general: {
    ...makeValidContent().general,
    labor_types: [{ labor_type_key: "CHINH_THUC", display_name: "Chính thức" }],
  },
  candidate: makeValidContent().candidate,
  compensation: makeValidContent().compensation,
  documents: makeValidContent().documents,
  allowed_actions: { can_edit: true, can_withdraw: true },
};
delete SAMPLE_ITEM.general.labor_type_keys;

function makeDeps(
  repoResult,
  sessionResult = { actor: { ok: true, actor: ACTOR }, response_headers: {} },
) {
  const calls = [];
  return {
    calls,
    dependencies: {
      resolveSession: async () => sessionResult,
      repository: {
        getContext: async (input) => {
          calls.push(["getContext", input]);
          return repoResult;
        },
        list: async (input) => {
          calls.push(["list", input]);
          return repoResult;
        },
        listMine: async (input) => {
          calls.push(["listMine", input]);
          return repoResult;
        },
        get: async (input) => {
          calls.push(["get", input]);
          return repoResult;
        },
        create: async (input) => {
          calls.push(["create", input]);
          return repoResult;
        },
        update: async (input) => {
          calls.push(["update", input]);
          return repoResult;
        },
        withdraw: async (input) => {
          calls.push(["withdraw", input]);
          return repoResult;
        },
      },
    },
  };
}

function makeMutationRequest(body, method = "POST", path = "/api/recruitment-posts", extraHeaders = {}) {
  return new Request(`https://app.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      host: "app.test",
      "sec-fetch-site": "same-origin",
      "idempotency-key": IDEM_KEY,
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("feature flag disabled returns 404 NOT_FOUND with private no-store header", async () => {
  const { dependencies } = makeDeps({ ok: true, data: {} });
  const res = await handleRecruitmentPostContext(
    new Request("https://app.test/api/recruitment-posts/context"),
    "false",
    dependencies,
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
});

test("CSRF guard, authority headers, session guard, and body bounds are enforced", async () => {
  const { dependencies } = makeDeps({
    ok: true,
    data: { post: SAMPLE_ITEM, changed: true, replayed: false },
  });

  // Cross-origin -> 403 CSRF_ORIGIN_DENIED
  const csrfRes = await handleRecruitmentPostCreate(
    new Request("https://app.test/api/recruitment-posts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.test",
        host: "app.test",
        "sec-fetch-site": "cross-site",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        project_id: "PROJ_A",
        industrial_park_id: PARK_ID,
        content: makeValidContent(),
      }),
    }),
    "true",
    dependencies,
  );
  assert.equal(csrfRes.status, 403);
  assert.deepEqual(await csrfRes.json(), {
    ok: false,
    code: "CSRF_ORIGIN_DENIED",
  });

  // Disallowed authority header -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const headerRes = await handleRecruitmentPostContext(
    new Request("https://app.test/api/recruitment-posts/context", {
      headers: { "x-app-user-id": ACTOR.app_user_id },
    }),
    "true",
    dependencies,
  );
  assert.equal(headerRes.status, 400);
  assert.deepEqual(await headerRes.json(), {
    ok: false,
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });

  // Unauthenticated -> 401 UNAUTHENTICATED
  const unauthDeps = makeDeps(
    { ok: true, data: {} },
    { actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} },
  );
  const unauthRes = await handleRecruitmentPostContext(
    new Request("https://app.test/api/recruitment-posts/context"),
    "true",
    unauthDeps.dependencies,
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), {
    ok: false,
    code: "UNAUTHENTICATED",
  });

  // Oversized body (> 96 KiB) -> 413 REQUEST_BODY_TOO_LARGE
  const hugeRes = await handleRecruitmentPostCreate(
    makeMutationRequest("x".repeat(97 * 1024)),
    "true",
    dependencies,
  );
  assert.equal(hugeRes.status, 413);
  assert.deepEqual(await hugeRes.json(), {
    ok: false,
    code: "REQUEST_BODY_TOO_LARGE",
  });

  // Missing Idempotency-Key -> 400 RECRUITMENT_POST_IDEMPOTENCY_INVALID
  const noIdemReq = new Request("https://app.test/api/recruitment-posts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      host: "app.test",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContent(),
    }),
  });
  const noIdemRes = await handleRecruitmentPostCreate(
    noIdemReq,
    "true",
    dependencies,
  );
  assert.equal(noIdemRes.status, 400);
  assert.deepEqual(await noIdemRes.json(), {
    ok: false,
    code: "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  });
});

test("create returns 201 when replayed=false and 200 when replayed=true; update and withdraw return 200", async () => {
  const freshDeps = makeDeps({
    ok: true,
    data: { post: SAMPLE_ITEM, changed: true, replayed: false },
  });
  const createRes = await handleRecruitmentPostCreate(
    makeMutationRequest({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContent(),
    }),
    "true",
    freshDeps.dependencies,
  );
  assert.equal(createRes.status, 201);
  const createJson = await createRes.json();
  assert.equal(createJson.ok, true);
  assert.equal(createJson.data.replayed, false);

  const replayDeps = makeDeps({
    ok: true,
    data: { post: SAMPLE_ITEM, changed: true, replayed: true },
  });
  const replayRes = await handleRecruitmentPostCreate(
    makeMutationRequest({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContent(),
    }),
    "true",
    replayDeps.dependencies,
  );
  assert.equal(replayRes.status, 200);
  const replayJson = await replayRes.json();
  assert.equal(replayJson.data.replayed, true);

  const updateDeps = makeDeps({
    ok: true,
    data: { post: { ...SAMPLE_ITEM, version: 2 }, changed: true, replayed: false },
  });
  const updateRes = await handleRecruitmentPostUpdate(
    makeMutationRequest(
      { expected_version: 1, content: makeValidContent() },
      "PATCH",
      `/api/recruitment-posts/${BRIEF_ID}`,
    ),
    BRIEF_ID,
    "true",
    updateDeps.dependencies,
  );
  assert.equal(updateRes.status, 200);

  const withdrawDeps = makeDeps({
    ok: true,
    data: {
      post: { ...SAMPLE_ITEM, version: 3, status: "WITHDRAWN" },
      changed: true,
      replayed: false,
    },
  });
  const withdrawRes = await handleRecruitmentPostWithdraw(
    makeMutationRequest(
      { expected_version: 2 },
      "POST",
      `/api/recruitment-posts/${BRIEF_ID}/withdraw`,
    ),
    BRIEF_ID,
    "true",
    withdrawDeps.dependencies,
  );
  assert.equal(withdrawRes.status, 200);

  const listDeps = makeDeps({
    ok: true,
    data: {
      items: [SAMPLE_ITEM],
      page_size: 10,
      has_more: false,
      next_cursor: null,
      snapshot_token: `S1.1.${FILTER_HASH}`,
    },
  });
  const listRes = await handleRecruitmentPostList(
    new Request("https://app.test/api/recruitment-posts?project_id=PROJ_A"),
    "true",
    listDeps.dependencies,
  );
  assert.equal(listRes.status, 200);

  const getDeps = makeDeps({
    ok: true,
    data: { post: SAMPLE_ITEM },
  });
  const getRes = await handleRecruitmentPostGet(
    new Request(`https://app.test/api/recruitment-posts/${BRIEF_ID}`),
    BRIEF_ID,
    "true",
    getDeps.dependencies,
  );
  assert.equal(getRes.status, 200);
});

test("create enforces manager_name from server-verified actor display_name and ignores client manager_name, while update preserves existing manager_name", async () => {
  const createDeps = makeDeps(
    {
      ok: true,
      data: { post: SAMPLE_ITEM, changed: true, replayed: false },
    },
    {
      actor: {
        ok: true,
        actor: {
          ...ACTOR,
          display_name: "  Phạm Thị Quản Lý Dự Án  ",
        },
      },
      response_headers: {},
    },
  );

  const clientBodyWithSpoofedManager = makeValidContent();
  clientBodyWithSpoofedManager.general.manager_name = "Tên Giả Mạo Từ Client";

  const createRes = await handleRecruitmentPostCreate(
    makeMutationRequest({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: clientBodyWithSpoofedManager,
    }),
    "true",
    createDeps.dependencies,
  );
  assert.equal(createRes.status, 201);
  assert.equal(createDeps.calls.length, 1);
  assert.equal(createDeps.calls[0][0], "create");
  assert.equal(
    createDeps.calls[0][1].payload.general.manager_name,
    "Phạm Thị Quản Lý Dự Án",
  );

  // Missing or blank actor display_name on create fails closed with 403 ACTOR_NOT_AVAILABLE
  const missingDisplayNameDeps = makeDeps(
    {
      ok: true,
      data: { post: SAMPLE_ITEM, changed: true, replayed: false },
    },
    {
      actor: {
        ok: true,
        actor: {
          auth_subject: ACTOR.auth_subject,
          app_user_id: ACTOR.app_user_id,
          display_name: "   ",
          enabled: true,
        },
      },
      response_headers: {},
    },
  );
  const missingNameRes = await handleRecruitmentPostCreate(
    makeMutationRequest({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContent(),
    }),
    "true",
    missingDisplayNameDeps.dependencies,
  );
  assert.equal(missingNameRes.status, 403);
  assert.deepEqual(await missingNameRes.json(), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });
  assert.equal(missingDisplayNameDeps.calls.length, 0);

  // Update by another user (e.g. Full Admin / BOD) or with a tampered client manager_name
  // always preserves the originally saved manager_name from the server
  const storedOriginalPost = {
    ...SAMPLE_ITEM,
    version: 2,
    general: {
      ...SAMPLE_ITEM.general,
      manager_name: "Nguyễn Văn Quản Lý Gốc",
    },
  };
  const adminEditorDeps = makeDeps(
    {
      ok: true,
      data: {
        post: storedOriginalPost,
        changed: true,
        replayed: false,
      },
    },
    {
      actor: {
        ok: true,
        actor: {
          ...ACTOR,
          display_name: "Lê Quản Trị BOD",
        },
      },
      response_headers: {},
    },
  );
  const updateContent = makeValidContent();
  updateContent.general.manager_name = "Tên Giả Mạo Khi Sửa";
  updateContent.general.manager_phone = "0988777666";

  const updateRes = await handleRecruitmentPostUpdate(
    makeMutationRequest(
      { expected_version: 1, content: updateContent },
      "PATCH",
      `/api/recruitment-posts/${BRIEF_ID}`,
    ),
    BRIEF_ID,
    "true",
    adminEditorDeps.dependencies,
  );
  assert.equal(updateRes.status, 200);
  assert.equal(adminEditorDeps.calls.length, 2);
  assert.equal(adminEditorDeps.calls[0][0], "get");
  assert.equal(adminEditorDeps.calls[0][1].brief_id, BRIEF_ID);
  assert.equal(adminEditorDeps.calls[1][0], "update");
  assert.equal(adminEditorDeps.calls[1][1].expected_version, 1);
  assert.equal(
    adminEditorDeps.calls[1][1].payload.general.manager_name,
    "Nguyễn Văn Quản Lý Gốc",
  );
  assert.equal(
    adminEditorDeps.calls[1][1].payload.general.manager_phone,
    "0988777666",
  );
});

test("handleRecruitmentPostListMine enforces feature flag, session, authority guards, query bounds, and returns 200 with private no-store", async () => {
  const listData = {
    items: [
      SAMPLE_ITEM,
      {
        ...SAMPLE_ITEM,
        brief_id: "77777777-7777-4777-8777-777777777777",
        status: "WITHDRAWN",
        withdrawn_at: "2026-11-10T09:00:00.123456Z",
        withdrawn_by_display_name: "Nguyễn Văn A",
        allowed_actions: { can_edit: false, can_withdraw: false },
      },
    ],
    page_size: 15,
    has_more: false,
    next_cursor: null,
    snapshot_token: `S1.1.${FILTER_HASH}`,
  };
  const { calls, dependencies } = makeDeps({ ok: true, data: listData });

  // Feature flag off -> 404
  const offRes = await handleRecruitmentPostListMine(
    new Request("https://app.test/api/recruitment-posts/mine"),
    "false",
    dependencies,
  );
  assert.equal(offRes.status, 404);
  assert.equal(offRes.headers.get("cache-control"), "private, no-store");

  // Unauthenticated -> 401
  const unauthDeps = makeDeps(
    { ok: true, data: listData },
    { actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} },
  );
  const unauthRes = await handleRecruitmentPostListMine(
    new Request("https://app.test/api/recruitment-posts/mine"),
    "true",
    unauthDeps.dependencies,
  );
  assert.equal(unauthRes.status, 401);

  // Disabled account -> 403 ACTOR_NOT_AVAILABLE
  const disabledDeps = makeDeps(
    { ok: true, data: listData },
    {
      actor: { ok: false, reason: "ACCOUNT_UNAVAILABLE" },
      response_headers: {},
    },
  );
  const disabledRes = await handleRecruitmentPostListMine(
    new Request("https://app.test/api/recruitment-posts/mine"),
    "true",
    disabledDeps.dependencies,
  );
  assert.equal(disabledRes.status, 403);
  assert.deepEqual(await disabledRes.json(), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });

  // Forbidden client authority query key -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const spoofQueryRes = await handleRecruitmentPostListMine(
    new Request(
      "https://app.test/api/recruitment-posts/mine?app_user_id=99999999-9999-4999-8999-999999999999",
    ),
    "true",
    dependencies,
  );
  assert.equal(spoofQueryRes.status, 400);
  assert.deepEqual(await spoofQueryRes.json(), {
    ok: false,
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });

  // Forbidden filter query key (e.g. project_id) or page_size=16 -> 400 RECRUITMENT_POST_INPUT_INVALID
  const badQueryRes = await handleRecruitmentPostListMine(
    new Request("https://app.test/api/recruitment-posts/mine?page_size=16"),
    "true",
    dependencies,
  );
  assert.equal(badQueryRes.status, 400);
  assert.deepEqual(await badQueryRes.json(), {
    ok: false,
    code: "RECRUITMENT_POST_INPUT_INVALID",
  });

  // Valid request -> 200 OK with private, no-store and actor resolved from session
  const okRes = await handleRecruitmentPostListMine(
    new Request("https://app.test/api/recruitment-posts/mine?page_size=15"),
    "true",
    dependencies,
  );
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "private, no-store");
  const okJson = await okRes.json();
  assert.equal(okJson.ok, true);
  assert.equal(okJson.data.items.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "listMine",
    {
      auth_subject: ACTOR.auth_subject,
      app_user_id: ACTOR.app_user_id,
      cursor: null,
      snapshot_token: null,
      page_size: 15,
    },
  ]);
});
