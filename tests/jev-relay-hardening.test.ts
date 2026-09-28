/**
 * The relay's security pass, as tests.
 *
 * These are the attack-surface cases the hardening pass is about, kept apart
 * from the boundary suite (jev-route.test.ts) so that what a PUBLIC caller can
 * reach is asserted in one place:
 *
 *   - the platform guard (Vercel Firewall) failing is a REFUSAL, never a silent
 *     removal of the deployment-wide limit (firewall.ts);
 *   - the body ceiling is enforced WHILE the body is read, so a chunked or
 *     length-less request cannot make this code buffer an unbounded body
 *     (body.ts);
 *   - a hostile body costs zero upstream calls: unknown fields, an attempted
 *     `model`/`endpoint`, oversized arrays, absurd numbers;
 *   - nothing from upstream — a status line, an error body, a credential the
 *     upstream echoed back — can reach the caller or a log line;
 *   - the lane and the backend travel as NAMES from closed vocabularies, and
 *     nothing else about a credential ever rides a response;
 *   - the conservative global headers are declared, and the full CSP stays out
 *     until someone can prove it against Next + MapLibre in a browser.
 *
 * The upstream service is stubbed through global fetch: no test reaches the
 * network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_checkRateLimit as checkRateLimit } from "@vercel/firewall";
import { POST } from "@/app/api/jev/policy/route";
import { JEV_BACKENDS, JEV_CLIENT_FAILURES, JEV_RELAY_PATH } from "@/jev/client";
import { JEV_LIMITS, JEV_SCHEMA_VERSION } from "@/jev/schema";
import type { JevPolicyRequest } from "@/jev/schema";
import nextConfig from "@/next.config";

vi.mock("@vercel/firewall", () => ({ unstable_checkRateLimit: vi.fn() }));

const RELAY_URL = "https://app.invalid/api/jev/policy";
/** The schema-speaking lane, so a status can be read off a stubbed fetch. */
const ENDPOINT = "https://jev.invalid/policy";
const TOKEN = "relay-token-that-must-never-appear-anywhere";
/** A credential-shaped string an upstream body could echo back at us. */
const ECHOED_SECRET = "sk-live-echoed-by-an-upstream-error-0000";
/** The deployment-wide guard's id, as production configures it. */
const GUARD_ID = "jev-relay-policy";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  JEV_ENDPOINT: process.env.JEV_ENDPOINT,
  JEV_TOKEN: process.env.JEV_TOKEN,
  JEV_MODEL: process.env.JEV_MODEL,
  JEV_BACKEND: process.env.JEV_BACKEND,
  JEV_RATE_LIMIT_ID: process.env.JEV_RATE_LIMIT_ID,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
};
const originalFetch = globalThis.fetch;

/** A fresh platform identity per test: budgets are per caller, per instance. */
let callerSeed = 0;
function nextCallerIp(): string {
  callerSeed += 1;
  return `198.51.100.${(callerSeed % 200) + 1}`;
}

function request(overrides: Partial<JevPolicyRequest> = {}): JevPolicyRequest {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 5_000,
    windowMs: 5_000,
    city: {
      intersections: 12,
      signalizedIntersections: 8,
      activeVehicles: 40,
      queuedVehicles: 6,
      maxWaitMs: 12_000,
      arrivalRatePerSecond: 1.5,
    },
    corridors: [
      {
        corridorId: 3,
        kind: "arterial",
        intersections: 4,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
      },
    ],
    regions: [
      {
        regionId: 1,
        intersections: 6,
        signalizedIntersections: 4,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
      },
    ],
    hotspots: [
      {
        intersectionId: 2,
        regionId: 1,
        stage: "green",
        phaseIndex: 0,
        phaseCount: 2,
        stageElapsedMs: 4_000,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
        downstreamOccupancyRatio: 0.2,
      },
    ],
    ...overrides,
  };
}

interface PostOptions {
  readonly headers?: Record<string, string>;
  readonly ip?: string;
}

function post(body: unknown, options: PostOptions = {}): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json", ...(options.headers ?? {}) });
  headers.set("x-real-ip", options.ip ?? nextCallerIp());
  return POST(
    new Request(RELAY_URL, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    }),
  );
}

/** One counting upstream stub; every test asserts this count where it matters. */
function stubUpstream(status = 200, bodyText = ""): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      bodyText || JSON.stringify({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.1 }),
      { status },
    );
  }) as unknown as typeof fetch;
  return () => calls;
}

/** Source with comments removed: scans test code, not prose about code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `process.env.NODE_ENV` is typed read-only; a test may drive it deliberately. */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => void (console.error = original) };
}

function configureRelayLane(): void {
  process.env.JEV_ENDPOINT = ENDPOINT;
  process.env.JEV_TOKEN = TOKEN;
  delete process.env.JEV_MODEL;
  delete process.env.JEV_BACKEND;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
}

beforeEach(() => {
  configureRelayLane();
  delete process.env.JEV_RATE_LIMIT_ID;
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(checkRateLimit).mockResolvedValue({ rateLimited: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* The platform guard: a failure is a refusal, never a silent removal         */
/* -------------------------------------------------------------------------- */

describe("platform guard (Vercel Firewall)", () => {
  function productionGuard(): void {
    setNodeEnv("production");
    process.env.JEV_RATE_LIMIT_ID = GUARD_ID;
  }

  /**
   * The relay with a FRESH module graph. The guard's once-per-process log flags
   * live in module state (firewall.ts), so a test that COUNTS log lines must not
   * depend on where it sits in this file: it starts its own process.
   */
  async function freshRelay(): Promise<{
    post: (body: unknown, ip: string) => Promise<Response>;
    sdk: typeof checkRateLimit;
  }> {
    vi.resetModules();
    const sdk = (await import("@vercel/firewall")).unstable_checkRateLimit;
    const route = await import("@/app/api/jev/policy/route");
    return {
      sdk,
      post: (body, ip) =>
        route.POST(
          new Request(RELAY_URL, {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json", "x-real-ip": ip },
          }),
        ),
    };
  }

  it("serves a request the platform counted, exactly as before", async () => {
    productionGuard();
    vi.mocked(checkRateLimit).mockResolvedValue({ rateLimited: false });
    const calls = stubUpstream();

    const response = await post(request());
    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
    // The guard was consulted with the configured id and the platform's own
    // identity — never a caller-supplied header.
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledTimes(1);
    const [id, options] = vi.mocked(checkRateLimit).mock.calls[0];
    expect(id).toBe(GUARD_ID);
    expect(options?.rateLimitKey).toMatch(/^198\.51\.100\./);
  });

  it("refuses 429 when the platform's own rule says the caller is over budget (unchanged)", async () => {
    productionGuard();
    const calls = stubUpstream();
    for (const verdict of [
      { rateLimited: true },
      { rateLimited: true, error: "blocked" as const },
    ]) {
      vi.mocked(checkRateLimit).mockResolvedValue(verdict);
      const response = await post(request());
      expect(response.status, JSON.stringify(verdict)).toBe(429);
      expect(response.headers.get("x-jev-reason")).toBe("rate-limited");
    }
    expect(calls()).toBe(0);
  });

  it("refuses 503, and spends nothing upstream, when the configured rule cannot be found", async () => {
    productionGuard();
    const calls = stubUpstream();
    const { post: freshPost, sdk } = await freshRelay();
    vi.mocked(sdk).mockResolvedValue({ rateLimited: false, error: "not-found" });
    const logs = captureLogs();
    let response: Response;
    try {
      response = await freshPost(request(), "198.51.100.21");
    } finally {
      logs.restore();
    }
    // Before the fix this was a 200 with an upstream call: the Firewall's
    // failure silently removed the deployment-wide guard.
    expect(response.status).toBe(503);
    expect(calls()).toBe(0);
    expect(response.headers.get("x-jev-reason")).toBe("upstream-error");
    // The refusal is bounded: our own sentence, and no platform text, no rule
    // id, no client address.
    const text = await response.text();
    expect(text).not.toContain(GUARD_ID);
    expect(text).not.toContain("not-found");
    expect(text).not.toContain("198.51.100.");
    // Exactly one line, naming the condition — and naming nothing else.
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toContain("[jev-relay]");
    expect(logs.lines[0]).toContain("fail closed");
    expect(logs.lines[0]).not.toContain(GUARD_ID);
    expect(logs.lines[0]).not.toContain("198.51.100.");
    expect(logs.lines[0]).not.toContain(TOKEN);
  });

  it("refuses 503, and spends nothing upstream, when the Firewall lookup throws", async () => {
    productionGuard();
    const calls = stubUpstream();
    const { post: freshPost, sdk } = await freshRelay();
    vi.mocked(sdk).mockRejectedValue(
      new Error(`rate limit api replied 500 at https://platform.invalid/${GUARD_ID} for ${ECHOED_SECRET}`),
    );
    const logs = captureLogs();
    let response: Response;
    try {
      response = await freshPost(request(), "198.51.100.22");
    } finally {
      logs.restore();
    }
    expect(response.status).toBe(503);
    expect(calls()).toBe(0);
    const text = await response.text();
    // Neither the platform's own error text nor the credential-shaped value it
    // carried is repeated anywhere the caller can see.
    expect(text).not.toContain("platform.invalid");
    expect(text).not.toContain(ECHOED_SECRET);
    expect(text).not.toContain(GUARD_ID);
    for (const [, value] of response.headers) {
      expect(value).not.toContain(ECHOED_SECRET);
    }
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).not.toContain(ECHOED_SECRET);
    expect(logs.lines[0]).not.toContain("platform.invalid");
  });

  it("logs each failure condition once per process, not once per request", async () => {
    productionGuard();
    const { post: freshPost, sdk } = await freshRelay();
    stubUpstream();
    const logs = captureLogs();
    try {
      // Two different configured-but-broken conditions, three requests each.
      vi.mocked(sdk).mockResolvedValue({
        rateLimited: false,
        error: "not-found",
      });
      for (const ip of ["198.51.100.31", "198.51.100.32", "198.51.100.33"]) {
        expect((await freshPost(request(), ip)).status).toBe(503);
      }
      vi.mocked(sdk).mockRejectedValue(new Error("guard down"));
      for (const ip of ["198.51.100.34", "198.51.100.35", "198.51.100.36"]) {
        expect((await freshPost(request(), ip)).status).toBe(503);
      }
      // One bounded sentence per condition. A line per request would be a
      // billed resource an attacker could drive at will.
      expect(logs.lines).toHaveLength(2);
      expect(logs.lines.filter((line) => line.includes("no Vercel Firewall rate-limit rule matches it"))).toHaveLength(1);
      expect(logs.lines.filter((line) => line.includes("could not be consulted"))).toHaveLength(1);
    } finally {
      logs.restore();
    }
  });

  it("leaves local development and an unconfigured deployment exactly as they were", async () => {
    const calls = stubUpstream();
    vi.mocked(checkRateLimit).mockRejectedValue(new Error("no platform here"));

    // 1. Local development WITH an id set: the SDK is not consulted at all.
    setNodeEnv("test");
    process.env.JEV_RATE_LIMIT_ID = GUARD_ID;
    expect((await post(request())).status).toBe(200);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();

    // 2. Production with NO id configured: the operator's explicit choice to run
    //    without the platform guard, so a broken/absent rule is irrelevant.
    setNodeEnv("production");
    delete process.env.JEV_RATE_LIMIT_ID;
    expect((await post(request())).status).toBe(200);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();

    // Both requests reached the service: nothing was refused in the cases where
    // the guard is not this deployment's control.
    expect(calls()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The body ceiling: enforced while the body is read                          */
/* -------------------------------------------------------------------------- */

describe("bounded request body", () => {
  /** A stream that can produce far more than the ceiling, metered. */
  function meteredStream(chunkBytes: number): {
    readonly body: ReadableStream<Uint8Array>;
    readonly pulls: () => number;
    readonly cancelled: () => boolean;
  } {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, pulls: () => pulls, cancelled: () => cancelled };
  }

  /**
   * A source with no `content-length` is asked for ONE chunk as soon as its
   * queue is filled — before any reader exists — so "the route read nothing" is
   * at most one pull, and "the route stopped at the ceiling" is the ceiling's
   * chunk count plus that one. Both bounds are about order of magnitude, not
   * about a byte: a route that drained this stream would pull forever.
   */
  const QUEUE_FILL_PULLS = 1;

  function postStream(
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>,
  ): Promise<Response> {
    return POST(
      new Request(RELAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": nextCallerIp(), ...headers },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
  }

  it("serves a valid body inside the ceiling unchanged", async () => {
    const calls = stubUpstream();
    const response = await post(request());
    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("refuses a body that DECLARES itself over the ceiling, without reading it", async () => {
    const calls = stubUpstream();
    const stream = meteredStream(4_096);
    const response = await postStream(stream.body, {
      "content-length": String(JEV_LIMITS.REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
    // The fast path: a caller that says how big it is costs one header read —
    // the source is never read by this route at all.
    expect(stream.pulls()).toBeLessThanOrEqual(QUEUE_FILL_PULLS);
  });

  it("refuses an oversized chunked body, and STOPS reading it", async () => {
    const calls = stubUpstream();
    // 4096 bytes per pull: the stream could produce ~20 MB, so a drain would be
    // visible here as thousands of pulls.
    const stream = meteredStream(4_096);
    const response = await postStream(stream.body, {});
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
    // At most the ceiling plus one chunk was ever read, and the rest was
    // cancelled rather than drained: application memory stays bounded whatever
    // the caller sends and however it frames it.
    const chunksToExceed = Math.floor(JEV_LIMITS.REQUEST_BODY_BYTES / 4_096) + 1;
    const bound = chunksToExceed + QUEUE_FILL_PULLS;
    expect(bound).toBeLessThan(40);
    expect(stream.pulls()).toBeLessThanOrEqual(bound);
    expect(stream.cancelled()).toBe(true);
  });

  it("accepts a body exactly at the ceiling and refuses one byte more", async () => {
    const calls = stubUpstream();
    const json = JSON.stringify(request());
    expect(Buffer.byteLength(json, "utf8")).toBeLessThan(JEV_LIMITS.REQUEST_BODY_BYTES);
    // JSON allows whitespace around the document, so padding with spaces is a
    // body of an exact size that is still valid — the boundary itself, not a
    // shape the schema would refuse.
    const atCeiling = json + " ".repeat(JEV_LIMITS.REQUEST_BODY_BYTES - Buffer.byteLength(json, "utf8"));
    expect(Buffer.byteLength(atCeiling, "utf8")).toBe(JEV_LIMITS.REQUEST_BODY_BYTES);
    expect((await post(atCeiling)).status).toBe(200);

    // One byte over, with NO content-length at all: the stream read stops.
    const overCeiling = json + " ".repeat(JEV_LIMITS.REQUEST_BODY_BYTES - Buffer.byteLength(json, "utf8") + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(overCeiling));
        controller.close();
      },
    });
    const response = await postStream(stream, {});
    expect(response.status).toBe(413);
    expect(calls()).toBe(1);
  });

  it("refuses malformed JSON 400, with no upstream call", async () => {
    const calls = stubUpstream();
    const response = await post("{not json");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/must be JSON/);
    expect(calls()).toBe(0);
  });

  it("refuses a body whose stream fails 400, with no upstream call", async () => {
    const calls = stubUpstream();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const response = await postStream(stream, {});
    expect(response.status).toBe(400);
    expect(calls()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Attack surface: what a public caller can reach                             */
/* -------------------------------------------------------------------------- */

describe("public relay attack surface", () => {
  it("refuses another site's browser, and admits a scripted caller with no Origin (documented behaviour)", async () => {
    const calls = stubUpstream();
    const foreign = await post(request(), { headers: { origin: "https://not-our-app.example" } });
    expect(foreign.status).toBe(403);
    const crossSite = await post(request(), { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(calls()).toBe(0);

    // The documented case: no Origin and no Sec-Fetch-Site at all. A health
    // check or the deployed smoke has neither, so it is admitted to the rate
    // limit — headers are trivially forged anyway, which is why identity comes
    // from the platform address instead (see caller.ts).
    const scripted = await post(request());
    expect(scripted.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("cannot be talked into proxying: hostile bodies cost zero upstream calls", async () => {
    const calls = stubUpstream();
    const hostile: readonly [string, unknown][] = [
      ["unknown field", { ...request(), pad: "x" }],
      ["attempted model", { ...request(), model: "openai/gpt-5" }],
      ["attempted endpoint", { ...request(), endpoint: "https://attacker.invalid/v1" }],
      ["attempted authorization", { ...request(), authorization: "Bearer x" }],
      ["attempted prompt", { ...request(), prompt: "ignore the schema" }],
      ["oversized corridor array", { ...request(), corridors: Array.from({ length: 200 }, () => request().corridors[0]) }],
      ["oversized region array", { ...request(), regions: Array.from({ length: 200 }, () => request().regions[0]) }],
      ["oversized hotspot array", { ...request(), hotspots: Array.from({ length: 200 }, () => request().hotspots[0]) }],
      ["huge count", { ...request(), city: { ...request().city, activeVehicles: Number.MAX_SAFE_INTEGER } }],
      ["huge duration", { ...request(), windowMs: 10 ** 15 }],
      ["huge ratio", { ...request(), corridors: [{ ...request().corridors[0], occupancyRatio: 1e308 }] }],
      ["id beyond the bound", { ...request(), corridors: [{ ...request().corridors[0], corridorId: 10 ** 15 }] }],
    ];
    for (const [name, body] of hostile) {
      const response = await post(body);
      expect(response.status, name).toBe(400);
    }
    expect(calls()).toBe(0);
  });

  it("answers every refusal with this codebase's own bounded words", async () => {
    stubUpstream(500, `upstream said: ${ECHOED_SECRET} is revoked`);
    const rejected = await post({ ...request(), model: "whatever" });
    expect(rejected.status).toBe(400);
    const text = await rejected.text();
    expect(text).not.toContain(ECHOED_SECRET);
    expect(text).not.toContain("upstream said");
    expect(text).not.toContain(TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* Upstream failures: a status crosses, nothing else does                     */
/* -------------------------------------------------------------------------- */

describe("upstream failure bodies cannot leak", () => {
  it("classifies 401/403/429/5xx without echoing a byte of the body", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const upstreamBody = `upstream error: ${ECHOED_SECRET} Bearer ${TOKEN} at https://upstream.invalid/v1`;
      const calls = stubUpstream(status, upstreamBody);
      const logs = captureLogs();
      let response: Response;
      try {
        response = await post(request());
      } finally {
        logs.restore();
      }
      expect(response.status, `upstream ${status}`).toBe(502);
      expect(calls()).toBe(1);
      const text = await response.text();
      expect(text, `upstream ${status}`).not.toContain(ECHOED_SECRET);
      expect(text, `upstream ${status}`).not.toContain(TOKEN);
      expect(text, `upstream ${status}`).not.toContain("upstream error");
      expect(text, `upstream ${status}`).not.toContain("upstream.invalid");
      expect(text, `upstream ${status}`).not.toContain("Bearer");
      for (const [, value] of response.headers) {
        expect(value, `upstream ${status}`).not.toContain(ECHOED_SECRET);
      }
      // The log line is bounded too: a status, this codebase's own class, and
      // the credential LANE as a name.
      expect(logs.lines).toHaveLength(1);
      expect(logs.lines[0]).not.toContain(ECHOED_SECRET);
      expect(logs.lines[0]).not.toContain(TOKEN);
      expect(logs.lines[0]).not.toContain("upstream.invalid");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The secret contract: names cross, credentials never do                     */
/* -------------------------------------------------------------------------- */

describe("secret contract at the relay boundary", () => {
  it("reports only a lane name and a backend name, from their closed vocabularies", async () => {
    stubUpstream();
    const response = await post(request());
    expect(response.status).toBe(200);
    const lane = response.headers.get("x-jev-auth");
    // A NAME from the closed two-value vocabulary, never any part of a token.
    expect(["api-key", "oidc"]).toContain(lane);
    const backend = response.headers.get("x-jev-backend");
    expect(JEV_BACKENDS).toContain(backend);
    expect(backend).toBe("schema-service");
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    for (const [, value] of response.headers) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it("never sends the TypeSafe key, or the gateway key, to the schema service", async () => {
    process.env.JEV_ENDPOINT = ENDPOINT;
    process.env.JEV_TOKEN = TOKEN;
    process.env.TYPESAFE_API_KEY = "typesafe-key-that-must-not-cross-lanes";
    process.env.AI_GATEWAY_API_KEY = "gateway-key-that-must-not-cross-lanes";
    const seen: { url: string; authorization: string | null; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
        body: String(init.body),
      });
      return new Response(JSON.stringify({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const response = await post(request());
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(ENDPOINT);
    // Exactly one credential, the lane's own, and neither of the others rides
    // anywhere near the wire.
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body).not.toContain("typesafe-key-that-must-not-cross-lanes");
    expect(seen[0].body).not.toContain("gateway-key-that-must-not-cross-lanes");
    expect(response.headers.get("x-jev-backend")).toBe("schema-service");
  });

  it("fails closed on an unrecognised backend name rather than falling through a lane", async () => {
    process.env.JEV_BACKEND = "gateway";
    process.env.TYPESAFE_API_KEY = "typesafe-key-that-must-not-cross-lanes";
    const calls = stubUpstream();
    const response = await post(request());
    expect(response.status).toBe(503);
    expect(calls()).toBe(0);
    expect(JEV_CLIENT_FAILURES).toContain(response.headers.get("x-jev-reason"));
  });

  it("keeps the browser-side relay client free of credentials and of this route's secrets", () => {
    // The browser posts to our own path and carries no Authorization header, no
    // token field and no env read: there is nothing to leak because there is
    // nothing held.
    const client = code(readFileSync(path.join(process.cwd(), "jev", "client.ts"), "utf8"));
    expect(client).toContain(JEV_RELAY_PATH);
    expect(client).not.toMatch(/process\.env/);
    expect(client).not.toMatch(/TYPESAFE_API_KEY|JEV_TOKEN|AI_GATEWAY_API_KEY/);
    const relayClient = client.slice(client.indexOf("export function createRelayJevClient"));
    expect(relayClient).not.toMatch(/authorization/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Conservative global headers                                                */
/* -------------------------------------------------------------------------- */

describe("global security headers", () => {
  /** The declared header list, exactly as next.config.ts exports it. */
  async function declaredHeaders(): Promise<Record<string, string>> {
    const rules = await nextConfig.headers?.();
    expect(rules).toBeDefined();
    expect(rules!.length).toBeGreaterThan(0);
    // Every rule must match every path: a matcher that forgets a path silently
    // leaves a surface unstamped, which is how header work usually rots.
    for (const rule of rules!) {
      expect(rule.source).toBe("/:path*");
    }
    return Object.fromEntries(rules!.flatMap((rule) => rule.headers.map((h) => [h.key, h.value])));
  }

  it("declares nosniff, a referrer policy and a permissions policy that disables the three features", async () => {
    const headers = await declaredHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("protects against framing, and ships NO unproven full CSP", async () => {
    const headers = await declaredHeaders();
    // Frame protection is provable and cheap: nothing in this app frames or is
    // framed, so it cannot change what the product does.
    expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    // The deliberate omission, pinned so it cannot be smuggled back in: a full
    // CSP needs a nonce (and therefore dynamic rendering) or 'unsafe-inline'
    // (which permits the very injection a CSP exists to stop), and neither was
    // proven against Next + MapLibre + its blob: workers in a browser.
    expect(headers["Content-Security-Policy"]).not.toMatch(/default-src|script-src|unsafe-inline/);
  });
});
