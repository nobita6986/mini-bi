/**
 * P1.6-W04-S04B-R2C2 - synthetic browser harness helpers.
 *
 * Replays the R2C editor + manager flows against a stub `fetch` so the
 * acceptance script can observe URL / method / headers / body for each
 * scenario. No DB, no R2, no Next.js dev server. The replay is intentionally a
 * faithful copy of the editor's `upload()` so a regression in the editor
 * surfaces as a change in observable behaviour.
 */

function createStubFetch(overrides = {}) {
  const calls = [];
  const fetchStub = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body = null;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof Uint8Array) body = init.body;
    calls.push({ url, method, headers, body });

    if (overrides.reserveFailure?.kind === "network") {
      if (method === "POST" && /\/documents$/.test(url)) throw new TypeError("Failed to fetch");
    }
    if (method === "GET" && /\/api\/direct-entry\/submissions\//.test(url)) {
      return jsonResponse(200, {
        ok: true,
        submission_id: "sub_x",
        state: "SUBMITTED",
        version: 1,
        entry_count: 1,
        created_at: "2026-10-01T00:00:00.000000Z",
        updated_at: "2026-10-01T00:00:00.000000Z",
        submitted_at: "2026-10-01T00:00:00.000000Z",
        allowed_transitions: [],
        entry_ids: ["ent_synthetic_01"],
      });
    }
    if (method === "GET" && /\/api\/direct-entry\/entries\//.test(url)) {
      const body = overrides.entryProjection ?? {
        ok: true,
        entry: { entry_id: "ent_synthetic_01", version: 1, documents: [] },
      };
      return jsonResponse(200, body);
    }
    if (method === "POST" && /\/documents$/.test(url)) {
      if (overrides.reserveStatus === 409) {
        return jsonResponse(409, { ok: false, code: "DOCUMENT_VERSION_CONFLICT" });
      }
      return jsonResponse(201, {
        ok: true,
        document_id: "doc_synthetic_01",
        entry_version: 2,
        upload: {
          method: "PUT",
          url: "https://r2.example/preview/staging/doc_synthetic_01",
          headers: overrides.putHeaders ?? { "Content-Type": "image/jpeg", "Content-Length": "2" },
          expires_at: "2030-01-01T00:05:00Z",
        },
      });
    }
    if (method === "PUT") {
      if (overrides.putStatus) return new Response(null, { status: overrides.putStatus });
      return new Response(null, { status: 200 });
    }
    if (method === "POST" && /\/finalize$/.test(url)) {
      return jsonResponse(200, { ok: true, document_id: "doc_synthetic_01", entry_version: 3 });
    }
    return jsonResponse(200, { ok: true });
  };
  fetchStub.calls = calls;
  return fetchStub;
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Per-test persistent state so retries share idempotency intent.
const editorState = new Map();

function stateKey(file, type, reason) {
  return `${file.name}:${file.size}:${type}:${reason}`;
}

async function simulateEditorUpload(options) {
  const stub = options.stub;
  const fileBytes = new Uint8Array(options.fileBytes ?? [0xff, 0xd0, 0xd1]);
  const file = {
    name: options.fileName ?? "synthetic.jpg",
    type: options.mimeType ?? "image/jpeg",
    size: options.sizeBytes ?? fileBytes.length,
  };
  const documentType = options.documentType ?? "CCCD_FRONT";
  const trimmedReason = options.reason == null ? "" : String(options.reason).trim();
  if (trimmedReason.length < 1) return { state: "error", message: "missing reason" };
  const key = stateKey(file, documentType, trimmedReason);
  let pending = editorState.get(key);
  if (!pending) {
    pending = { key: crypto.randomUUID(), expectedEntryVersion: 1 };
    editorState.set(key, pending);
  }
  try {
    const reserved = await stub(
      `/api/direct-entry/entries/ent_synthetic_01/documents`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Idempotency-Key": pending.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          document_type: documentType,
          expected_entry_version: pending.expectedEntryVersion,
          size_bytes: file.size,
          mime_type: file.type,
          reason: trimmedReason,
        }),
      },
    );
    if (!reserved.ok) {
      if (reserved.status === 409) return { state: "conflict" };
      return { state: "error" };
    }
    const payload = await reserved.json();
    const put = await stub(payload.upload.url, {
      method: "PUT",
      headers: payload.upload.headers,
      body: fileBytes,
    });
    if (!put.ok) return { state: "error" };
    await stub(
      `/api/direct-entry/entries/ent_synthetic_01/documents/${payload.document_id}/finalize`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Idempotency-Key": `${pending.key}:finalize`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expected_entry_version: payload.entry_version }),
      },
    );
    await stub(`/api/direct-entry/entries/ent_synthetic_01`, { method: "GET" });
    return { state: "queued" };
  } catch (cause) {
    return { state: "error", error: cause.message };
  }
}

async function simulateManager(options) {
  const stub = options.stub;
  const detailRes = await stub(`/api/direct-entry/submissions/${options.submissionId ?? "sub_x"}`, { method: "GET" });
  if (!detailRes.ok) return { state: "error" };
  const detail = await detailRes.json();
  if (detail.ok !== true) return { state: "error" };
  const entryIds = detail.entry_ids ?? [];
  for (const entryId of entryIds) {
    const entryRes = await stub(`/api/direct-entry/entries/${entryId}`, { method: "GET" });
    if (!entryRes.ok) return { state: "error" };
    const body = await entryRes.json();
    if (!body || typeof body !== "object" || body.ok !== true) return { state: "error" };
    const entry = body.entry;
    if (!entry || typeof entry !== "object" || typeof entry.entry_id !== "string" ||
        entry.entry_id !== entryId) return { state: "error" };
  }
  return { state: "ready", entries: entryIds };
}

export { createStubFetch, simulateEditorUpload, simulateManager, editorState };