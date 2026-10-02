import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { SecurityError } from "./errors.ts";
import {
  assertResolvedAddresses,
  isPublicAddress,
  normalizeHostname,
  validateProviderUrl,
} from "./provider-url-policy.ts";
import {
  buildPinnedRequestOptions,
  collectResponse,
  createPinnedLookup,
  safeOutboundRequest,
} from "./safe-outbound.ts";

const policy = {
  environment: "production",
  allowedHosts: ["api.provider.example", "second.provider.example", "xn--bcher-kva.example"],
};
const publicV4 = "8.8.8.8";
const publicV6 = "2001:4860:4860::8888";
const localDevPolicy = {
  environment: "development",
  nodeEnv: "development",
  allowDevLocalHttp: true,
  allowedPorts: [3000],
};

function result(statusCode = 200, headers = {}, body = "ok") {
  return { statusCode, headers, body: Buffer.from(body) };
}

test("URL normalization lowercases hosts, strips trailing dots, and applies exact IDNA allowlist", () => {
  assert.equal(normalizeHostname("API.PROVIDER.EXAMPLE..."), "api.provider.example");
  assert.equal(validateProviderUrl("https://API.PROVIDER.EXAMPLE./v1", policy).sanitizedHost, "api.provider.example");
  assert.equal(validateProviderUrl("https://bücher.example/v1", policy).url.hostname, "xn--bcher-kva.example");
  assert.throws(() => validateProviderUrl("https://evilapi.provider.example/v1", policy), {
    code: "URL_REJECTED",
  });
  assert.throws(() => validateProviderUrl("https://api.provider.example.evil.test/", policy), {
    code: "URL_REJECTED",
  });
});

test("provider allowlist comes from AI_PROVIDER_ALLOWED_HOSTS when not injected", () => {
  const previous = process.env.AI_PROVIDER_ALLOWED_HOSTS;
  process.env.AI_PROVIDER_ALLOWED_HOSTS = "api.provider.example, second.provider.example";
  try {
    assert.equal(validateProviderUrl("https://second.provider.example/v1", {
      environment: "production",
    }).sanitizedHost, "second.provider.example");
    assert.throws(() => validateProviderUrl("https://evilsecond.provider.example/", {
      environment: "production",
    }), { code: "URL_REJECTED" });
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_HOSTS;
    else process.env.AI_PROVIDER_ALLOWED_HOSTS = previous;
  }
});

test("production rejects unsafe scheme, local/IP/metadata, credentials, fragment, query, and ports", () => {
  const rejected = [
    "http://api.provider.example/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/",
    "https://user:pass@api.provider.example/",
    "https://@api.provider.example/",
    "https://api.provider.example/#fragment",
    "https://api.provider.example/#",
    "https://api.provider.example/?token=synthetic",
    "https://api.provider.example/?",
    "https://api.provider.example:8443/",
  ];
  for (const url of rejected) {
    assert.throws(() => validateProviderUrl(url, policy), { code: "URL_REJECTED" }, url);
  }
});

test("WHATWG-normalized decimal, hexadecimal, and octal IPv4 literals cannot bypass IP checks", () => {
  for (const host of ["2130706433", "0x7f000001", "0177.0.0.1"]) {
    assert.throws(() => validateProviderUrl(`https://${host}/`, policy), {
      code: "URL_REJECTED",
    });
  }
});

test("development HTTP override is explicit, local-only, and never inherited by preview/production", () => {
  const local = validateProviderUrl("http://localhost:3000/test", localDevPolicy);
  assert.equal(local.allowDevPrivateAddresses, true);
  assert.throws(() => validateProviderUrl("http://localhost:3000/", {
    ...localDevPolicy,
    allowDevLocalHttp: false,
  }), { code: "URL_REJECTED" });
  assert.throws(() => validateProviderUrl("http://localhost:3000/", {
    ...localDevPolicy,
    environment: "preview",
  }), { code: "URL_REJECTED" });
  assert.throws(() => validateProviderUrl("http://api.provider.example:3000/", localDevPolicy), {
    code: "URL_REJECTED",
  });
  assert.throws(() => validateProviderUrl("http://localhost:8080/", localDevPolicy), {
    code: "URL_REJECTED",
  });
});

test("IP policy blocks private, loopback, link-local, reserved, metadata, mapped and non-global IPv6", () => {
  const blocked = [
    "0.1.2.3", "10.0.0.1", "100.100.100.200", "127.0.0.1",
    "169.254.169.254", "172.20.0.1", "192.168.1.1", "198.18.0.1",
    "224.0.0.1", "240.0.0.1", "168.63.129.16", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1",
    "ff02::1", "2001:db8::1", "2002::1", "::ffff:192.168.1.1",
    "::ffff:8.8.8.8",
  ];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress(publicV4), true);
  assert.equal(isPublicAddress(publicV6), true);
});

test("all DNS answers are inspected and mixed public/private answers reject", () => {
  assertResolvedAddresses("api.provider.example", [publicV4, publicV6]);
  assert.throws(() => assertResolvedAddresses("api.provider.example", ["10.1.2.3"]), {
    code: "DNS_REJECTED",
  });
  assert.throws(() => assertResolvedAddresses("api.provider.example", [publicV4, "192.168.1.5"]), {
    code: "DNS_REJECTED",
  });
  assert.throws(() => assertResolvedAddresses("api.provider.example", []), {
    code: "DNS_REJECTED",
  });
  assertResolvedAddresses("localhost", ["127.0.0.1", "::1"], true);
  assert.throws(() => assertResolvedAddresses("localhost", ["169.254.169.254"], true), {
    code: "DNS_REJECTED",
  });
});

test("outbound transport receives only DNS-validated pinned addresses on each attempt", async () => {
  let resolutionCount = 0;
  const calls = [];
  const response = await safeOutboundRequest("https://api.provider.example/v1", {
    url_policy: policy,
    resolve: async () => {
      resolutionCount += 1;
      return [publicV4, publicV6];
    },
    request: async (input) => {
      calls.push(input);
      return result(200, {}, "synthetic response");
    },
    headers: { Authorization: "synthetic bearer", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.body.toString(), "synthetic response");
  assert.equal(resolutionCount, 1);
  assert.deepEqual(calls[0].addresses, [publicV4, publicV6]);
  assert.equal(calls[0].url.hostname, "api.provider.example");
  assert.equal(calls[0].headers.Authorization, "synthetic bearer");
});

test("custom Node lookup is pinned to approved IPv4/IPv6 results", async () => {
  const lookup = createPinnedLookup([publicV4, publicV6]);
  const all = await new Promise((resolve, reject) => {
    lookup("api.provider.example", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [
    { address: publicV4, family: 4 },
    { address: publicV6, family: 6 },
  ]);
  const one = await new Promise((resolve, reject) => {
    lookup("api.provider.example", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(one, { address: publicV4, family: 4 });
  assert.throws(() => createPinnedLookup([]), { code: "DNS_REJECTED" });
});

test("HTTPS uses original hostname for SNI/certificate verification and Host header", () => {
  const options = buildPinnedRequestOptions({
    url: new URL("https://api.provider.example:443/v1"),
    addresses: [publicV4],
    method: "POST",
    headers: { Authorization: "synthetic bearer" },
    body: "{}",
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    signal: new AbortController().signal,
  });
  assert.equal(options.hostname, "api.provider.example");
  assert.equal(options.servername, "api.provider.example");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.host, "api.provider.example");
  assert.equal(options.port, 443);
  assert.equal(typeof options.lookup, "function");
});

test("DNS rebinding between redirects is re-resolved and blocked before second connection", async () => {
  let resolutionCount = 0;
  let connectionCount = 0;
  await assert.rejects(safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    followRedirects: true,
    resolve: async () => {
      resolutionCount += 1;
      return resolutionCount === 1 ? [publicV4] : ["10.0.0.8"];
    },
    request: async () => {
      connectionCount += 1;
      return result(302, { location: "https://second.provider.example/next" });
    },
  }), { code: "DNS_REJECTED" });
  assert.equal(resolutionCount, 2);
  assert.equal(connectionCount, 1);
});

test("same-origin redirects preserve auth; cross-origin redirects strip all sensitive headers", async () => {
  const requests = [];
  const response = await safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    resolve: async () => [publicV4],
    request: async (input) => {
      requests.push(input);
      if (requests.length === 1) return result(302, { location: "/same" });
      if (requests.length === 2) return result(307, { location: "https://second.provider.example/end" });
      return result(200);
    },
    followRedirects: true,
    headers: {
      Authorization: "synthetic bearer",
      "x-api-key": "synthetic header",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].headers.Authorization, "synthetic bearer");
  assert.equal(requests[2].headers.Authorization, undefined);
  assert.equal(requests[2].headers["x-api-key"], undefined);
  assert.equal(requests[2].headers["content-type"], undefined);
  assert.equal(requests[2].method, "GET");
  assert.equal(requests[2].url.hostname, "second.provider.example");
});

test("redirects to blocked targets, loops, and excessive chains fail closed", async () => {
  let calls = 0;
  await assert.rejects(safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    followRedirects: true,
    resolve: async () => [publicV4],
    request: async () => {
      calls += 1;
      return result(302, { location: "http://127.0.0.1/private" });
    },
  }), { code: "URL_REJECTED" });
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    followRedirects: true,
    resolve: async () => [publicV4],
    request: async ({ url }) => {
      calls += 1;
      return result(302, { location: url.pathname });
    },
    maxRedirects: 2,
  }), { code: "REDIRECT_REJECTED" });
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    followRedirects: true,
    resolve: async () => [publicV4],
    request: async ({ url }) => {
      calls += 1;
      return result(302, { location: `${url.pathname}/next` });
    },
    maxRedirects: 1,
  }), { code: "REDIRECT_REJECTED" });
  assert.equal(calls, 2);
});

test("redirects are not followed implicitly", async () => {
  let calls = 0;
  await assert.rejects(safeOutboundRequest("https://api.provider.example/start", {
    url_policy: policy,
    resolve: async () => [publicV4],
    request: async () => {
      calls += 1;
      return result(302, { location: "https://second.provider.example/" });
    },
  }), { code: "REDIRECT_REJECTED" });
  assert.equal(calls, 1);
});

test("timeout, oversized response, and malformed caller headers return sanitized errors", async () => {
  await assert.rejects(safeOutboundRequest("https://api.provider.example/", {
    url_policy: policy,
    timeoutMs: 15,
    resolve: async () => new Promise(() => {}),
    request: async () => result(),
  }), { code: "TIMEOUT" });

  await assert.rejects(safeOutboundRequest("https://api.provider.example/", {
    url_policy: policy,
    maxResponseBytes: 4,
    resolve: async () => [publicV4],
    request: async () => result(200, {}, "too large"),
  }), { code: "RESPONSE_TOO_LARGE" });

  const stream = new PassThrough();
  stream.headers = {};
  const fakeRequest = { destroy() {} };
  const bounded = collectResponse(stream, 4, fakeRequest);
  stream.write("12345");
  await assert.rejects(bounded, { code: "RESPONSE_TOO_LARGE" });
  stream.end();

  await assert.rejects(safeOutboundRequest("https://api.provider.example/", {
    url_policy: policy,
    headers: { Host: "attacker.example" },
  }), { code: "INVALID_INPUT" });

  const secret = "query-secret-synthetic";
  const error = new SecurityError("OUTBOUND_FAILED");
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(error.toJSON(), {
    code: "OUTBOUND_FAILED",
    message: "Yêu cầu tới provider thất bại.",
  });

  const rawDetails = "private-address?token=synthetic-secret";
  await assert.rejects(safeOutboundRequest("https://api.provider.example/", {
    url_policy: policy,
    resolve: async () => [publicV4],
    request: async () => { throw new Error(rawDetails); },
  }), (caught) => {
    assert.equal(caught.code, "OUTBOUND_FAILED");
    assert.equal(JSON.stringify(caught).includes(rawDetails), false);
    return true;
  });
});

test("query strings are rejected so sanitized URL diagnostics cannot expose credentials", () => {
  assert.throws(() => validateProviderUrl(
    "https://api.provider.example/?token=synthetic-secret",
    policy,
  ), { code: "URL_REJECTED" });
  const error = new SecurityError("URL_REJECTED");
  assert.equal(JSON.stringify(error).includes("synthetic-secret"), false);
});
