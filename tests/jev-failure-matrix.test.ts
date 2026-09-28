/**
 * JEV FAILURE MATRIX — every named upstream and configuration failure, driven
 * through the REAL relay seam, resolving to the honest contract.
 *
 * The layer suites pin each half of this: jev-route.test.ts the server boundary
 * (configuration, status classes, retry-after forwarding, no echoed body),
 * jev-typesafe/gateway tests the transports, jev-quota-scheduler/scope the
 * wall-clock budget, and jev-pure-execution/runtime the lifecycle. What none of
 * them COMPOSES is the production path end to end, in process and deterministic:
 *
 *   controller/runtime -> createRelayJevClient (browser: no credential)
 *     -> POST app/api/jev/policy (the relay: the only place a credential lives)
 *       -> createTypesafeJevClient / createHttpJevClient (server transport)
 *         -> globalThis.fetch (STUBBED: the upstream failure under test)
 *
 * Every failure row asserts, on that composed path:
 *
 *   1. the bounded class crosses route header -> browser client -> run cause,
 *      with 401/403 distinct from 429 and from 5xx;
 *   2. a retry-after the service names survives as a bounded number;
 *   3. the run reports itself UNABLE to start with that cause — never a
 *      substitute, and `fallbackMs`/`adaptiveTicks` stay hard zeros (an Adaptive
 *      module that COUNTS every construction and decision is loaded around the
 *      whole file);
 *   4. NO simulated time was observed at all before the first accepted policy;
 *   5. no upstream body, and no credential, ever reaches the browser — neither
 *      in the relay's response (body or headers) nor in the error the browser
 *      client throws;
 *   6. a configuration failure spends ZERO upstream calls.
 *
 * The remaining describes cover what the layer suites leave uncomposed at the
 * run level: a retry-after honoured while the policy in force keeps governing,
 * a due window deferred instead of stacked while a request is in flight, a
 * stale answer arriving after a reset, a startup that waits for the session
 * service budget and one that reports itself unable, and recovery after a
 * transient failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/jev/policy/route";
import { createFixedController } from "@/controllers/fixed";
import { createJevController, type JevController } from "@/controllers/jev";
import type { TrafficController } from "@/controllers/contract";
import {
  createRelayJevClient,
  JEV_BACKEND_HEADER,
  JEV_REASON_HEADER,
  JEV_RETRY_AFTER_HEADER,
  type JevClient,
} from "@/jev/client";
import {
  JEV_RUNTIME_DEFAULTS,
  createJevPolicyRuntime,
  isPromiseLike,
  type JevCause,
  type JevRejection,
  type JevRuntime,
  type JevStartOutcome,
} from "@/jev/runtime";
import { createJevServiceGate, type JevServiceGate } from "@/jev/scheduler";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { controllerObservation } from "@/worker/challenge-compare";
import { makeCrossroads } from "./traffic-support";

/* ------------------------------- the Adaptive spy -------------------------- */

/**
 * Every construction of, and every decision asked of, an Adaptive controller in
 * this file is COUNTED. The failure matrix must never move either counter: no
 * failure, at any stage of a run, may hand control to a substitute.
 */
const adaptiveCalls = vi.hoisted(() => ({ constructions: 0, decisions: 0 }));

vi.mock("@/controllers/adaptive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/controllers/adaptive")>();
  return {
    ...actual,
    createAdaptiveController: (...args: Parameters<typeof actual.createAdaptiveController>) => {
      adaptiveCalls.constructions += 1;
      const controller = actual.createAdaptiveController(...args);
      return {
        ...controller,
        directives: (...directiveArgs: Parameters<typeof controller.directives>) => {
          adaptiveCalls.decisions += 1;
          return controller.directives(...directiveArgs);
        },
      };
    },
  };
});

/* --------------------------------- fixtures -------------------------------- */

const TYPESAFE_KEY = "typesafe-key-that-must-never-reach-the-browser";
const LEGACY_TOKEN = "legacy-token-that-must-never-reach-the-browser";
/** The upstream's own words: they must never cross the relay boundary. */
const UPSTREAM_PROSE = "upstream said: the credential is revoked";
const TEST_CLIENT_IP = "198.51.100.77";
const RELAY_URL = "https://app.invalid/api/jev/policy";

const ENV_KEYS = [
  "JEV_BACKEND",
  "TYPESAFE_API_KEY",
  "JEV_MODEL",
  "JEV_ENDPOINT",
  "JEV_TOKEN",
  "AI_GATEWAY_API_KEY",
  "JEV_TIMEOUT_MS",
  "JEV_MIN_CONFIDENCE",
  "JEV_GATEWAY_URL",
] as const;

const originalEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

function crossroads(controller: TrafficController): { engine: EngineState; partition: CityPartition } {
  const built = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 120 },
      { angleDeg: 90, length: 120 },
      { angleDeg: 180, length: 120 },
      { angleDeg: 270, length: 120 },
    ],
  });
  return {
    engine: createEngine({ city: built.city, controller, spawns: [] }),
    partition: buildCityPartition(built.city),
  };
}

/** One simulated tick through the controller the engine holds. */
function tick(engine: EngineState, partition: CityPartition): void {
  const controller = engine.controller as Partial<JevController>;
  controller.directives?.(engine.city, engine.traffic, {
    observations: controllerObservation(engine).frame,
    partition,
  });
  stepEngine(engine);
}

async function startedAsync(outcome: JevStartOutcome | Promise<JevStartOutcome>): Promise<JevStartOutcome> {
  return isPromiseLike<JevStartOutcome>(outcome) ? await outcome : outcome;
}

/* ------------------------- the browser relay, in process ------------------- */

interface RelaySeam {
  readonly client: JevClient;
  /** The relay's own responses, exactly as the browser client saw them. */
  readonly relayed: Response[];
  /** Wall instants of the relay calls, when a clock was supplied. */
  readonly walls: number[];
}

/**
 * The browser-side client, wired to the REAL route handler: the fetch it makes
 * is the same POST the deployment serves, so a case exercises the credential
 * boundary, the request validation and the response validation rather than a
 * hand-written stand-in.
 */
function browserRelay(now?: () => number): RelaySeam {
  const relayed: Response[] = [];
  const walls: number[] = [];
  const client = createRelayJevClient({
    url: RELAY_URL,
    fetchImpl: (async (url: string, init: RequestInit) => {
      if (now !== undefined) walls.push(now());
      const headers = new Headers(init.headers as HeadersInit);
      headers.set("x-real-ip", TEST_CLIENT_IP);
      const response = await POST(new Request(String(url), { ...init, headers }));
      relayed.push(response.clone());
      return response;
    }) as unknown as typeof fetch,
  });
  return { client, relayed, walls };
}

/** Stub the transport's upstream. Returns a call counter. */
function stubUpstream(handler: (init: RequestInit, call: number) => Response | Promise<Response>): () => number {
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls += 1;
    return handler(init, calls);
  }) as unknown as typeof fetch;
  return () => calls;
}

/** An upstream answer in the shape the direct TypeSafe API returns. */
function typesafeAnswers(
  init: RequestInit | null,
  confidence: number,
  pressure: "steady" | "assertive" | "urgent" = "assertive",
): Response {
  let questions: Record<string, unknown> = { pressure: {}, hint: {} };
  try {
    const parsed = JSON.parse(String(init?.body ?? "")) as { questions?: Record<string, unknown> };
    if (parsed.questions !== undefined && parsed.questions !== null && typeof parsed.questions === "object") {
      questions = parsed.questions;
    }
  } catch {
    // A test that releases a held answer directly still gets a valid document.
  }
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => {
      const choice = id === "hint" ? "hold-longer" : id === "pressure" ? pressure : "high";
      return [id, { type: "choice", choice, confidence, probabilities: { [choice]: confidence } }];
    }),
  );
  return new Response(
    JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 5 } }),
    { status: 200 },
  );
}

/** A refusal from the upstream, carrying its own words in the body. */
function upstreamRefusal(status: number, headers: Record<string, string> = {}): Response {
  return new Response(UPSTREAM_PROSE, { status, headers });
}

/* ----------------------------- the matrix rows ----------------------------- */

interface FailureRow {
  readonly name: string;
  /** The lane this deployment is configured for. */
  readonly lane: "typesafe" | "schema-service";
  /** What the upstream transport does. */
  readonly upstream: (init: RequestInit, call: number) => Response | Promise<Response>;
  /** The bounded class the whole chain must report. */
  readonly cause: JevCause;
  readonly routeStatus: number;
  /** The pause the relay must forward, when the service named one. */
  readonly retryAfterMs?: number;
  /** Upstream calls the relay may spend: one per startup attempt, or none. */
  readonly upstreamCalls: number;
  /** The backend the relay must name, when a backend was selected. */
  readonly backend?: string;
  /**
   * A configuration failure: the route refuses before any client exists, so
   * the relay spends ZERO upstream calls. Which kind of misconfiguration.
   */
  readonly broken?: "missing-key" | "unknown-backend";
}

const START_ATTEMPTS = JEV_RUNTIME_DEFAULTS.START_ATTEMPTS;

const ROWS: readonly FailureRow[] = [
  {
    name: "401 — the credential was refused",
    lane: "typesafe",
    upstream: () => upstreamRefusal(401),
    cause: "rejected",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "403 — access to the model lapsed",
    lane: "typesafe",
    upstream: () => upstreamRefusal(403),
    cause: "rejected",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "429 — the allowance is spent, with the pause the service named",
    lane: "typesafe",
    upstream: () => upstreamRefusal(429, { "retry-after": "40" }),
    cause: "rate-limited",
    routeStatus: 502,
    retryAfterMs: 40_000,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "500 — the service failed",
    lane: "typesafe",
    upstream: () => upstreamRefusal(500),
    cause: "upstream-error",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "503 — the service is unavailable",
    lane: "typesafe",
    upstream: () => upstreamRefusal(503),
    cause: "upstream-error",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "timeout — the deadline passed before an answer",
    lane: "typesafe",
    upstream: () => {
      const aborted = new Error("The operation was aborted due to timeout");
      aborted.name = "AbortError";
      throw aborted;
    },
    cause: "timeout",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "malformed JSON — an answer that is not a document",
    lane: "typesafe",
    upstream: () => new Response("not json at all", { status: 200 }),
    cause: "unknown",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "malformed policy — a document the schema refuses",
    lane: "schema-service",
    upstream: () =>
      new Response(JSON.stringify({ schemaVersion: 1, hint: "fly" }), { status: 200 }),
    cause: "malformed",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "schema-service",
  },
  {
    name: "unreachable — the request never arrived (direct service lane)",
    lane: "schema-service",
    upstream: () => {
      throw new Error("fetch failed");
    },
    cause: "unreachable",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "schema-service",
  },
  {
    // The model lane's client lets a transport error propagate, and the relay's
    // classifier only recognises its own sentence shapes, so a connection that
    // never arrived lands in the bounded catch-all rather than in `unreachable`
    // (which the direct-service lane above does produce). Still bounded, still
    // closed, still no substitution — recorded here so the difference is a
    // pinned fact rather than an assumption.
    name: "unreachable — the request never arrived (model lane)",
    lane: "typesafe",
    upstream: () => {
      throw new TypeError("fetch failed");
    },
    cause: "unknown",
    routeStatus: 502,
    upstreamCalls: START_ATTEMPTS,
    backend: "typesafe-direct",
  },
  {
    name: "missing TYPESAFE_API_KEY — the selected backend has no credential",
    lane: "typesafe",
    upstream: () => upstreamRefusal(200),
    cause: "not-configured",
    routeStatus: 503,
    upstreamCalls: 0,
    broken: "missing-key",
  },
  {
    name: "unknown JEV_BACKEND — a name this codebase does not recognise",
    lane: "typesafe",
    upstream: () => upstreamRefusal(200),
    cause: "not-configured",
    routeStatus: 503,
    upstreamCalls: 0,
    broken: "unknown-backend",
  },
];

/* --------------------------------- the file -------------------------------- */

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  adaptiveCalls.constructions = 0;
  adaptiveCalls.decisions = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

function configure(row: FailureRow): void {
  delete process.env.JEV_MIN_CONFIDENCE;
  if (row.lane === "schema-service") {
    process.env.JEV_ENDPOINT = "https://jev.invalid/policy";
    process.env.JEV_TOKEN = LEGACY_TOKEN;
    return;
  }
  if (row.broken === "missing-key") {
    // The direct lane is selected but holds no credential. A fully armed
    // gateway lane must not catch the request instead.
    process.env.JEV_BACKEND = "typesafe";
    process.env.JEV_MODEL = "typesafe-ai/jev";
    process.env.AI_GATEWAY_API_KEY = "gateway-key-that-must-never-be-sent";
    return;
  }
  if (row.broken === "unknown-backend") {
    // A backend name this codebase does not recognise fails closed rather than
    // falling through to whichever lane an older variable still selects.
    process.env.JEV_BACKEND = "gateway";
    process.env.JEV_MODEL = "typesafe-ai/jev";
    process.env.AI_GATEWAY_API_KEY = "gateway-key-that-must-never-be-sent";
    return;
  }
  process.env.JEV_BACKEND = "typesafe";
  process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;
}

describe("the upstream failure matrix, through the real relay seam", () => {
  for (const row of ROWS) {
    it(`${row.name}: fails closed with no substitution and no simulated time`, async () => {
      configure(row);
      const upstreamCalls = stubUpstream(row.upstream);
      const seam = browserRelay();
      const rejections: JevRejection[] = [];
      const controller = createJevController({
        client: seam.client,
        scenarioFingerprint: `matrix-${row.cause}-${row.routeStatus}`,
        onRejected: (rejection) => rejections.push(rejection),
      });
      const { engine } = crossroads(controller);

      // The driver's own seam: a run that cannot be governed must not start.
      const outcome = await startedAsync(controller.start(controllerObservation(engine)));
      expect(outcome.state).toBe("unable");
      if (outcome.state !== "unable") {
        throw new Error("a failing first policy must report the run as unable to start");
      }
      expect(outcome.reason).toBe(row.cause);
      expect(outcome.attempts).toBe(START_ATTEMPTS);

      // 4. No simulated time was observed, and no policy governs.
      const status = controller.status();
      expect(engine.traffic.timeMs).toBe(0);
      expect(status.liveMs + status.replayMs + status.invalidMs + status.fallbackMs).toBe(0);
      expect(status.accepted).toBe(0);
      expect(status.source).toBe("waiting");
      expect(controller.policy()).toBeNull();
      expect(controller.trace().events).toHaveLength(0);

      // 3. Never a substitute.
      expect(status.fallbackMs).toBe(0);
      expect(status.adaptiveTicks).toBe(0);
      expect(adaptiveCalls.constructions).toBe(0);
      expect(adaptiveCalls.decisions).toBe(0);

      // 1. The cause is classified, counted and kept.
      expect(status.causes[row.cause]).toBe(START_ATTEMPTS);
      expect(status.lastRejection?.kind).toBe("client-error");
      expect(rejections).toHaveLength(START_ATTEMPTS);

      // 6. A configuration failure never reaches the service at all.
      expect(upstreamCalls()).toBe(row.upstreamCalls);

      // 1+2. What the browser saw: the relay's bounded class and pause.
      expect(seam.relayed).toHaveLength(START_ATTEMPTS);
      for (const response of seam.relayed) {
        expect(response.status).toBe(row.routeStatus);
        expect(response.headers.get(JEV_REASON_HEADER)).toBe(row.cause);
        if (row.retryAfterMs === undefined) {
          expect(response.headers.get(JEV_RETRY_AFTER_HEADER)).toBeNull();
        } else {
          expect(response.headers.get(JEV_RETRY_AFTER_HEADER)).toBe(String(row.retryAfterMs));
        }
        if (row.backend !== undefined) {
          expect(response.headers.get(JEV_BACKEND_HEADER)).toBe(row.backend);
        } else {
          expect(response.headers.get(JEV_BACKEND_HEADER)).toBeNull();
        }
      }

      // 5. No upstream body, and no credential, crosses the boundary: not in
      // the relay's body, not in its headers, not in the error the run kept.
      for (const response of seam.relayed) {
        const text = await response.clone().text();
        expect(text).not.toContain(UPSTREAM_PROSE);
        expect(text).not.toContain("revoked");
        expect(text).not.toContain(TYPESAFE_KEY);
        expect(text).not.toContain(LEGACY_TOKEN);
        for (const [, value] of response.headers) {
          expect(value).not.toContain(TYPESAFE_KEY);
          expect(value).not.toContain(LEGACY_TOKEN);
          expect(value).not.toContain("revoked");
        }
      }
      for (const rejection of rejections) {
        expect(rejection.detail).not.toContain(UPSTREAM_PROSE);
        expect(rejection.detail).not.toContain("revoked");
        expect(rejection.detail).not.toContain(TYPESAFE_KEY);
      }
    });
  }

  it("a healthy answer starts the run under Jev, governed from the first tick", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;
    const upstreamCalls = stubUpstream((init) => typesafeAnswers(init, 0.7));
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-healthy",
    });
    const { engine, partition } = crossroads(controller);

    const outcome = await startedAsync(controller.start(controllerObservation(engine)));
    expect(outcome.state).toBe("ready");
    // The model's own opinion governs — not a default, not a substitute.
    expect(controller.policy()?.pressureScale).toBe(1.25);
    expect(controller.policy()?.hint).toBe("hold-longer");
    expect(upstreamCalls()).toBe(1);

    for (let index = 0; index < 20; index += 1) tick(engine, partition);
    controller.finish(engine.traffic.timeMs);
    const status = controller.status();
    expect(status.invalidMs).toBe(0);
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);

    // The relay's success body carries the policy and nothing else: no upstream
    // field (answers, usage, model) ever reaches the browser.
    const relayed = seam.relayed[0];
    const text = await relayed.clone().text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["clamped", "policy"]);
    expect(text).not.toContain("answers");
    expect(text).not.toContain("input_tokens");
    expect(text).not.toContain("jev-1.13.0");
    expect(text).not.toContain(TYPESAFE_KEY);
    expect(upstreamCalls()).toBe(1);
  });

  it("low-confidence answers are applied as neutral, counted, and still Jev", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;
    stubUpstream((init) => typesafeAnswers(init, 0.1)); // below the 0.25 floor
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-low-confidence",
    });
    const { engine, partition } = crossroads(controller);

    const outcome = await startedAsync(controller.start(controllerObservation(engine)));
    // The response as a whole is valid: noise degrades to no opinion, and the
    // run is still governed by a Jev answer.
    expect(outcome.state).toBe("ready");
    expect(controller.policy()?.pressureScale).toBe(1);
    expect(controller.policy()?.hint).toBe("neutral");

    const dropped = Number(seam.relayed[0].headers.get("x-jev-dropped"));
    expect(dropped).toBeGreaterThan(0);
    expect(controller.status().dropped).toBe(dropped);
    expect(controller.status().clamped).toBe(0);

    for (let index = 0; index < 20; index += 1) tick(engine, partition);
    controller.finish(engine.traffic.timeMs);
    const status = controller.status();
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("a retry-after the service names is honoured by the run", () => {
  it("asks nothing inside the pause, holds the policy, and resumes after it", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let wall = 1_000_000;
    const clock = { now: () => wall, advance: (ms: number) => { wall += ms; } };
    // A gate scaled to wall milliseconds; the SHAPE (window, spacing, share) is
    // the shipped one.
    const gate: JevServiceGate = createJevServiceGate({
      windowMs: 3_000,
      maxPerWindow: 4,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });

    const upstreamCalls = stubUpstream((init, call) => {
      // The startup policy lands; the first refresh is rate-limited with a
      // pause; everything after the pause is healthy again — and ASSERTIVE, so
      // the recovered policy is distinguishable from the startup one.
      if (call === 1) return typesafeAnswers(init, 0.7);
      if (call === 2) return upstreamRefusal(429, { "retry-after": "2" });
      return typesafeAnswers(init, 0.9, "urgent");
    });

    const seam = browserRelay(clock.now);
    const runtime: JevRuntime = createJevPolicyRuntime({
      client: seam.client,
      scenarioFingerprint: "matrix-retry-after",
      refreshMs: 500,
      ttlMs: 1_000,
      minHoldMs: 100,
      maxHoldMs: 60_000,
      serviceGate: gate,
      now: clock.now,
    });
    const { engine, partition } = crossroads(createFixedController());

    const outcome = await startedAsync(runtime.start(observation(engine, partition)));
    expect(outcome.state).toBe("ready");
    expect(runtime.effective().policy?.pressureScale).toBe(1.25);
    expect(upstreamCalls()).toBe(1);

    // Drive until the pause has passed AND its replacement is in force: sim and
    // wall both advance 100 ms per tick, so the 2 s pause spans twenty windows.
    const perTick: { sim: number; calls: number }[] = [];
    for (let index = 0; index < 60; index += 1) {
      runtime.observe(observation(engine, partition));
      perTick.push({ sim: engine.traffic.timeMs, calls: upstreamCalls() });
      clock.advance(100);
      stepEngine(engine);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (runtime.effective().policy?.pressureScale === 1.5) break;
    }

    const callsAt = (sim: number) => perTick.find((entry) => entry.sim === sim)?.calls;
    // Nothing was asked inside the pause: three of its windows, each well past
    // the cadence, still issued no request.
    expect(callsAt(1_500)).toBe(2);
    expect(callsAt(2_000)).toBe(2);
    expect(callsAt(2_500)).toBe(2);
    expect(callsAt(3_000)).toBe(2);

    // The pause the service named crossed the relay as a bounded number, and
    // the request sequence is exactly: startup, the refusal, the recovery —
    // with the recovery no sooner than the pause it was given.
    expect(seam.relayed).toHaveLength(3);
    expect(
      seam.relayed.map((response) => response.headers.get(JEV_RETRY_AFTER_HEADER)),
    ).toEqual([null, "2000", null]);
    expect(seam.walls).toHaveLength(3);
    expect(seam.walls[2] - seam.walls[1]).toBeGreaterThanOrEqual(2_000);

    runtime.finish(engine.traffic.timeMs);
    const status = runtime.status();
    // The policy in force governed the whole pause, reported as HELD.
    expect(status.invalidMs).toBe(0);
    expect(status.invalidation).toBeNull();
    expect(status.heldMs).toBeGreaterThan(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(runtime.effective().policy?.pressureScale).toBe(1.5);
    expect(status.causes["rate-limited"]).toBe(1);
    expect(status.service?.failedByCause["rate-limited"]).toBe(1);
    // The run's own account of the pause: windows the schedule refused.
    expect(status.service?.refusals["retry-after"]).toBeGreaterThanOrEqual(3);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

function observation(engine: EngineState, partition: CityPartition) {
  return {
    frame: controllerObservation(engine).frame,
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

describe("an in-flight request defers the next window instead of stacking", () => {
  it("issues one request per window at most, and counts the deferred ones", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let release: ((response: Response) => void) | null = null;
    const upstreamCalls = stubUpstream((init, call) => {
      if (call === 1) return typesafeAnswers(init, 0.7);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });

    const seam = browserRelay();
    const runtime = createJevPolicyRuntime({
      client: seam.client,
      scenarioFingerprint: "matrix-in-flight",
      refreshMs: 500,
      ttlMs: 1_000,
      minHoldMs: 100,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads(createFixedController());
    expect((await startedAsync(runtime.start(observation(engine, partition)))).state).toBe("ready");

    // Windows at t=500, 1000, 1500, 2000 while the first refresh is in flight.
    for (let index = 0; index < 21; index += 1) {
      runtime.observe(observation(engine, partition));
      stepEngine(engine);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(upstreamCalls()).toBe(2); // the startup policy, and ONE refresh
    expect(runtime.status().inFlight).toBe(true);
    const deferred = runtime.status().refreshTelemetry.recent.filter(
      (event) => event.skipped && event.detail.includes("still in flight"),
    );
    expect(deferred.length).toBeGreaterThanOrEqual(2);

    // The answer finally lands: it is applied, and the run never lost Jev.
    (release as unknown as (response: Response) => void)(typesafeAnswers(null, 0.9, "urgent"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.observe(observation(engine, partition));
    runtime.finish(engine.traffic.timeMs);
    const status = runtime.status();
    expect(status.accepted).toBe(2);
    expect(runtime.effective().policy?.pressureScale).toBe(1.5);
    expect(status.invalidation).toBeNull();
    expect(status.invalidMs).toBe(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
  });
});

describe("a stale answer after a reset can never mutate the new scenario", () => {
  it("refuses it by generation, and the new scenario still starts clean", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let release: ((response: Response) => void) | null = null;
    stubUpstream((init, call) => {
      if (call === 1) return typesafeAnswers(init, 0.7);
      if (call === 2) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return typesafeAnswers(null, 0.9, "urgent");
    });

    const seam = browserRelay();
    const runtime = createJevPolicyRuntime({
      client: seam.client,
      scenarioFingerprint: "matrix-scenario-a",
      refreshMs: 500,
      ttlMs: 1_000,
      minHoldMs: 100,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads(createFixedController());
    expect((await startedAsync(runtime.start(observation(engine, partition)))).state).toBe("ready");
    for (let index = 0; index < 6; index += 1) {
      runtime.observe(observation(engine, partition));
      stepEngine(engine);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(runtime.status().inFlight).toBe(true);

    // The scenario moves while the answer is still on the wire.
    runtime.reset({ scenarioFingerprint: "matrix-scenario-b" });
    (release as unknown as (response: Response) => void)(typesafeAnswers(null, 0.9));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.observe(observation(engine, partition));

    const status = runtime.status();
    expect(status.lastRejection?.kind).toBe("stale-generation");
    expect(status.accepted).toBe(0);
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.trace().events).toHaveLength(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);

    // The new scenario starts on its own answer, with its own identity.
    const restarted = await startedAsync(runtime.start(observation(engine, partition)));
    expect(restarted.state).toBe("ready");
    expect(runtime.status().accepted).toBe(1);
    expect(runtime.trace().scenarioFingerprint).toBe("matrix-scenario-b");
  });
});

describe("startup and the session service budget", () => {
  it("waits inside its bound for a spent window, and simulates nothing meanwhile", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let wall = 1_000_000;
    const clock = { now: () => wall, advance: (ms: number) => { wall += ms; } };
    const gate = createJevServiceGate({
      windowMs: 3_000,
      maxPerWindow: 2,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });
    // Earlier runs in this session spent the window: the startup must wait for
    // the real remaining budget rather than ask into a closed one.
    gate.issued(clock.now());
    gate.issued(clock.now());
    expect(gate.eligibility().reason).toBe("budget");

    const upstreamCalls = stubUpstream((init) => typesafeAnswers(init, 0.7));
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-budget-wait",
      serviceGate: gate,
      now: clock.now,
    });
    const { engine, partition } = crossroads(controller);
    const wallBefore = clock.now();

    const outcome = await startedAsync(controller.start(controllerObservation(engine)));
    expect(outcome.state).toBe("ready");
    // The wait was real, on the wall clock, and inside the startup bound.
    expect(clock.now() - wallBefore).toBeGreaterThanOrEqual(3_000);
    expect(clock.now() - wallBefore).toBeLessThanOrEqual(
      JEV_RUNTIME_DEFAULTS.START_RETRY_WAIT_MS,
    );
    // ONE request, and no simulated time while it waited.
    expect(upstreamCalls()).toBe(1);
    expect(engine.traffic.timeMs).toBe(0);
    expect(controller.status().liveMs).toBe(0);
    expect(controller.status().service?.issued).toBe(1);

    for (let index = 0; index < 20; index += 1) tick(engine, partition);
    controller.finish(engine.traffic.timeMs);
    const status = controller.status();
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });

  it("reports the run as unable to start when the bound cannot be met, with no request", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let wall = 1_000_000;
    const clock = { now: () => wall, advance: (ms: number) => { wall += ms; } };
    const gate = createJevServiceGate({
      windowMs: 3_000,
      maxPerWindow: 2,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });
    // The service named a pause longer than a run may wait to start.
    gate.issued(clock.now());
    gate.failed({
      cause: "rate-limited",
      retryAfterMs: JEV_RUNTIME_DEFAULTS.START_RETRY_WAIT_MS + 60_000,
      atEpochMs: clock.now(),
    });

    const upstreamCalls = stubUpstream((init) => typesafeAnswers(init, 0.7));
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-budget-exhausted",
      serviceGate: gate,
      now: clock.now,
    });
    const { engine } = crossroads(controller);
    const wallBefore = clock.now();

    const outcome = await startedAsync(controller.start(controllerObservation(engine)));
    expect(outcome.state).toBe("unable");
    if (outcome.state !== "unable") {
      throw new Error("a startup the schedule forbids must report the run as unable");
    }
    expect(outcome.reason).toBe("service-budget");
    // No request was made, nothing was slept, and no simulated time passed.
    expect(upstreamCalls()).toBe(0);
    expect(clock.now()).toBe(wallBefore);
    expect(engine.traffic.timeMs).toBe(0);
    const status = controller.status();
    expect(status.refreshes).toBe(0);
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("waiting");
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("beyond the maximum hold, Jev is lost and the run invalidates", () => {
  it("stops with its measurements kept, and is never continued under anything else", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    // One policy, then the service is gone for good.
    const upstreamCalls = stubUpstream((init, call) =>
      call === 1 ? typesafeAnswers(init, 0.7) : upstreamRefusal(503),
    );
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-max-hold",
      refreshMs: 500,
      ttlMs: 1_000,
      minHoldMs: 100,
      maxHoldMs: 3_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await startedAsync(controller.start(controllerObservation(engine)))).state).toBe("ready");
    expect(controller.policy()?.pressureScale).toBe(1.25);

    let ticks = 0;
    while (controller.invalidation() === null && ticks < 80) {
      tick(engine, partition);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ticks += 1;
    }

    const invalidation = controller.invalidation();
    expect(invalidation).not.toBeNull();
    expect(invalidation?.reason).toBe("expired");
    expect(invalidation?.atSimMs).toBeGreaterThan(3_000);
    controller.finish(engine.traffic.timeMs);

    const status = controller.status();
    expect(status.source).toBe("invalidated");
    expect(controller.policy()).toBeNull();
    // The measurements are kept: what Jev governed, and the held part of it.
    expect(status.liveMs).toBeGreaterThan(0);
    expect(status.heldMs).toBeGreaterThan(0);
    expect(status.invalidMs).toBeGreaterThan(0);
    // ...and nothing else took over, at any point.
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
    // The failing service was asked at its windows, never in a burst.
    expect(upstreamCalls()).toBeGreaterThan(1);
    expect(upstreamCalls()).toBeLessThanOrEqual(ticks / 5 + 1);
  });
});

describe("recovery after a transient failure", () => {
  it("keeps the accepted policy governing, then goes fresh again — never substituted", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;

    let wall = 1_000_000;
    const clock = { now: () => wall, advance: (ms: number) => { wall += ms; } };
    // Window 3 s / 4 requests: a 750 ms cadence of wall time, which is 1 500 ms
    // of simulated time at 50 wall ms per 100 simulated ms. The outage therefore
    // spans several simulated seconds before the schedule may ask again.
    const gate = createJevServiceGate({
      windowMs: 3_000,
      maxPerWindow: 4,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });

    stubUpstream((init, call) => {
      if (call === 1) return typesafeAnswers(init, 0.7); // startup: pressureScale 1.25
      if (call === 2) return upstreamRefusal(503); // the outage
      return typesafeAnswers(init, 0.9, "urgent"); // recovery: pressureScale 1.5
    });
    const seam = browserRelay();
    const controller = createJevController({
      client: seam.client,
      scenarioFingerprint: "matrix-recovery",
      serviceGate: gate,
      now: clock.now,
      refreshMs: 500,
      ttlMs: 1_000,
      minHoldMs: 100,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await startedAsync(controller.start(controllerObservation(engine)))).state).toBe("ready");
    expect(controller.policy()?.pressureScale).toBe(1.25);

    let heldDuringOutage: number | null = null;
    for (let index = 0; index < 50; index += 1) {
      tick(engine, partition);
      clock.advance(50);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (engine.traffic.timeMs === 2_000) {
        // Inside the outage, past the freshness window: the accepted policy is
        // still deciding, and reported as held.
        heldDuringOutage = controller.policy()?.pressureScale ?? null;
      }
    }
    controller.finish(engine.traffic.timeMs);

    const status = controller.status();
    // The accepted policy governed the whole outage: held, never lost.
    expect(heldDuringOutage).toBe(1.25);
    expect(status.invalidation).toBeNull();
    expect(status.invalidMs).toBe(0);
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.heldMs).toBeGreaterThan(0);
    expect(status.causes["upstream-error"]).toBe(1);
    // ...and the service came back: the newest policy is in force, fresh.
    expect(controller.policy()?.pressureScale).toBe(1.5);
    expect(status.accepted).toBeGreaterThanOrEqual(2);
    expect(status.source).toBe("live");
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});
