/**
 * QUOTA SCOPE AND STARTUP ELIGIBILITY — the two lifecycle bugs, case by case.
 *
 * The measured failure these cases are written against: a gate per CONTROLLER
 * (worker/simulation.worker.ts built one with every Jev controller) resets the
 * window whenever a run is rebuilt, so run B asks as if run A had spent nothing
 * while the upstream still counts A's requests — the 429s the scheduler exists
 * to prevent. And the startup path asked without consulting the gate at all,
 * which was invisible while every controller owned a fresh gate and is a bypass
 * the moment the gate is shared.
 *
 *   1  run A then run B immediately: B inherits the window A spent, waits, and
 *      causes no 429 merely by being built
 *   2  a reset / new scenario resets the SIMULATION, never the service budget
 *   3  destroying and rebuilding a Jev controller in one session does not
 *      replenish the budget
 *   4  a retry-after run A received still suppresses run B's first request
 *   5  a transient-failure backoff survives the run boundary
 *   6  startup under a spent window: it WAITS (no request, no simulated time)
 *      and reports `service-budget` when the bound cannot be met
 *   7  a healthy later run starts normally once the window clears, with no
 *      stale scenario or policy carried over — only quota TIMING persists
 *
 * plus the wiring: every live path in this repository builds its Jev controller
 * with the SESSION's gate, and that gate is one object however many controllers
 * are built.
 *
 * The gate is scaled to WALL MILLISECONDS (60 ms window, 4 requests, 15 ms
 * apart) so a short run exercises a dozen requests without sleeping; the RATIO
 * is the shipped one (60 s / 4), so the shape of the schedule is production's.
 * Nothing here sleeps on the real clock and nothing here is skipped.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createJevController } from "@/controllers/jev";
import { JevClientError, type JevClient } from "@/jev/client";
import {
  createJevPolicyRuntime,
  isPromiseLike,
  type JevRuntime,
  type JevStartOutcome,
} from "@/jev/runtime";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import type { JevServiceGate } from "@/jev/scheduler";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { makeCrossroads } from "./traffic-support";

/* ------------------------------- the Adaptive spy -------------------------- */

/**
 * Every construction of, and every decision asked of, an Adaptive controller in
 * this file is COUNTED. Sharing a gate across runs, and making startup wait for
 * it, must not create a path to an Adaptive decision: the pure-Jev contract is
 * unchanged, and this file re-proves it with the gate shared, refusing and the
 * startup bound exceeded.
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

/** A wall clock a test owns: nothing here sleeps or reads the real time. */
function fakeClock(start = 1_000_000) {
  let value = start;
  return {
    now: (): number => value,
    advance: (ms: number): void => {
      value += ms;
    },
    get value(): number {
      return value;
    },
  };
}

type TestClock = ReturnType<typeof fakeClock>;

/**
 * A sleep the test releases by hand, so "the run is WAITING" is observable
 * rather than inferred: nothing happens until the test says the timer fired.
 */
function manualSleep(clock: TestClock) {
  const requested: number[] = [];
  const resolvers: (() => void)[] = [];
  return {
    requested,
    sleep: (ms: number): Promise<void> => {
      requested.push(ms);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          clock.advance(ms);
          resolve();
        });
      });
    },
    release(): void {
      const next = resolvers.shift();
      if (next === undefined) {
        throw new Error("no pending wait to release");
      }
      next();
    },
    get waiting(): number {
      return resolvers.length;
    },
  };
}

/** The measured 60 s window / 4 requests, scaled to wall milliseconds. */
const SESSION_WINDOW_MS = 60;
const SESSION_MAX_PER_WINDOW = 4;
const SESSION_SPACING_MS = 15;

/** One simulated tick per wall millisecond, as in the scheduler's own suite. */
const WALL_MS_PER_TICK = 1;
const REFRESH_SIM_MS = 100;

/**
 * The SESSION's own gate (jev/service-budget.ts), with a clock this test owns.
 * `vi.resetModules()` gives the module a fresh session, so every case starts
 * from a session that has spent nothing — while the gate under test is the real
 * one the worker and the harness use.
 */
async function freshSessionGate(
  clock: TestClock,
  options: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly windowMs?: number;
    readonly maxPerWindow?: number;
  } = {},
): Promise<JevServiceGate> {
  vi.resetModules();
  const { sessionJevServiceGate } = await import("@/jev/service-budget");
  return sessionJevServiceGate({
    windowMs: options.windowMs ?? SESSION_WINDOW_MS,
    maxPerWindow: options.maxPerWindow ?? SESSION_MAX_PER_WINDOW,
    now: clock.now,
    sleep: options.sleep ?? (async (ms: number) => {
      clock.advance(ms);
    }),
  });
}

/** The measured service, modeled: `limit` requests per trailing window. */
function modeledService(windowMs: number, limit: number) {
  const times: number[] = [];
  const refusals: number[] = [];
  return {
    times,
    refusals,
    /** Would the real service refuse this request? (the measured allowance) */
    ask(at: number): void {
      const inWindow = times.filter((issued) => at - issued < windowMs).length;
      if (inWindow >= limit) {
        refusals.push(at);
      }
      times.push(at);
    },
    /** The most requests that ever sat in one trailing window. */
    worstWindow(): number {
      let worst = 0;
      for (const start of times) {
        worst = Math.max(worst, times.filter((at) => at >= start && at < start + windowMs).length);
      }
      return worst;
    },
  };
}

/**
 * A stand-in that answers with a policy and RECORDS the wall instant of every
 * request against a modeled service. `plan` may throw a bounded client failure
 * on a chosen call, which is how a refusal arrives at the gate.
 */
function recordingClient(options: {
  readonly clock: TestClock;
  readonly calls: number[];
  readonly service?: ReturnType<typeof modeledService>;
  readonly scale?: number;
  readonly plan?: (callIndex: number) => unknown;
}): JevClient {
  let index = 0;
  return {
    id: "mock",
    requestPolicy: () => {
      options.calls.push(options.clock.value);
      options.service?.ask(options.clock.value);
      const planned = options.plan?.(index);
      index += 1;
      if (planned instanceof Error) {
        throw planned;
      }
      return planned ?? policy(options.scale ?? 1.2);
    },
  };
}

function policy(scale = 1.2) {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: scale,
    hint: "neutral" as const,
    corridorWeights: [],
    regionWeights: [],
  };
}

function crossroads(): { engine: EngineState; partition: CityPartition } {
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
    // A Fixed placeholder: these cases drive the RUNTIME directly, and the
    // Adaptive spy above must only ever see a real substitution attempt.
    engine: createEngine({ city: built.city, controller: createFixedController(), spawns: [] }),
    partition: buildCityPartition(built.city),
  };
}

function observation(engine: EngineState, partition: CityPartition) {
  return {
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

function runFor(options: {
  readonly clock: TestClock;
  readonly gate: JevServiceGate | null;
  readonly client: JevClient;
  readonly fingerprint: string;
}): JevRuntime {
  return createJevPolicyRuntime({
    client: options.client,
    scenarioFingerprint: options.fingerprint,
    refreshMs: REFRESH_SIM_MS,
    ttlMs: 1_000,
    // Shorter than one refresh window, so every refresh that the SCHEDULE
    // allows is a new policy: these cases are about quota, and the minimum hold
    // is a different rule with its own suite.
    minHoldMs: 50,
    maxHoldMs: 60_000,
    serviceGate: options.gate,
    now: options.clock.now,
  });
}

/** Drive `ticks` simulated ticks, moving the wall clock with them. */
function drive(
  runtime: JevRuntime,
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
  clock: TestClock,
): void {
  for (let index = 0; index < ticks; index += 1) {
    runtime.observe(observation(engine, partition));
    clock.advance(WALL_MS_PER_TICK);
    stepEngine(engine);
  }
}

/** The startup gate's answer for a client that answers inline and an open gate. */
function startedSync(outcome: JevStartOutcome | Promise<JevStartOutcome>): JevStartOutcome {
  if (isPromiseLike<JevStartOutcome>(outcome)) {
    throw new Error("this client answers inline and the gate is open: start must be synchronous");
  }
  return outcome;
}

/* ---------------------- 1. run A then run B, immediately ------------------- */

describe("1. a second run inherits the window the first one spent", () => {
  it("waits for the real remaining budget and causes no 429", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const service = modeledService(SESSION_WINDOW_MS, 5);
    const { engine, partition } = crossroads();

    // RUN A: a full run's worth of requests, spent at the service's cadence.
    const aCalls: number[] = [];
    const runA = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: aCalls, service, scale: 1.4 }),
      fingerprint: "run-a",
    });
    expect(startedSync(runA.start(observation(engine, partition))).state).toBe("ready");
    drive(runA, engine, partition, 70, clock);
    runA.finish(engine.traffic.timeMs);
    expect(aCalls).toHaveLength(5);
    expect(service.refusals).toEqual([]);
    // A spent its share of the window and the window is still full.
    expect(gate.status().issuedInWindow).toBe(SESSION_MAX_PER_WINDOW);
    expect(gate.eligibility().ok).toBe(false);

    // RUN B, IMMEDIATELY: a brand-new run and a brand-new controller.
    const bCalls: number[] = [];
    const runB = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: bCalls, service, scale: 0.8 }),
      fingerprint: "run-b",
    });
    const builtAt = clock.value;
    const started = await Promise.resolve(runB.start(observation(engine, partition)));
    expect(started.state).toBe("ready");

    // B WAITED. Building a controller spends nothing and restores nothing, so
    // its first request could not be made at the instant it was built.
    expect(bCalls).toHaveLength(1);
    expect(bCalls[0]).toBeGreaterThan(builtAt);
    expect(bCalls[0]).toBeGreaterThanOrEqual(aCalls[0] + SESSION_WINDOW_MS);
    // ...and the service never refused anyone: no 429 was caused by run B
    // merely existing.
    expect(service.refusals).toEqual([]);
    expect(service.worstWindow()).toBeLessThanOrEqual(SESSION_MAX_PER_WINDOW);
    // Each run reports its OWN requests, while the gate keeps the session's.
    expect(runA.status().service?.issued).toBe(5);
    expect(runB.status().service?.issued).toBe(1);
    expect(gate.status().issued).toBe(6);
    expect(runB.status().accepted).toBe(1);
  });
});

/* ------------------- 2. reset / new scenario: state, not quota ------------- */

describe("2. a reset resets the simulation, never the service budget", () => {
  it("keeps the spent window and starts the new run's own account over", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const service = modeledService(SESSION_WINDOW_MS, 5);
    const calls: number[] = [];
    const runtime = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls, service, scale: 1.4 }),
      fingerprint: "scenario-a",
    });
    const { engine, partition } = crossroads();
    expect(startedSync(runtime.start(observation(engine, partition))).state).toBe("ready");
    drive(runtime, engine, partition, 70, clock);
    expect(calls).toHaveLength(5);
    const spent = gate.status();
    expect(spent.issued).toBe(5);
    expect(spent.issuedInWindow).toBe(SESSION_MAX_PER_WINDOW);

    // The user resets / picks a new scenario: a new RUN, the same SESSION.
    runtime.reset({ scenarioFingerprint: "scenario-b" });
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.status().refreshes).toBe(0);
    expect(runtime.status().accepted).toBe(0);
    expect(runtime.trace().events).toEqual([]);
    expect(runtime.trace().scenarioFingerprint).toBe("scenario-b");
    // The SIMULATION's state starts over; the SERVICE's does not.
    expect(gate.status().issued).toBe(5);
    expect(gate.status().issuedInWindow).toBe(SESSION_MAX_PER_WINDOW);

    const before = clock.value;
    const outcome = await Promise.resolve(runtime.start(observation(engine, partition)));
    expect(outcome.state).toBe("ready");
    const afterReset = calls.slice(5);
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0]).toBeGreaterThan(before);
    expect(service.refusals).toEqual([]);
    // The new run's account counts the new run's requests: the reset moved the
    // baseline, not the budget.
    expect(runtime.status().service?.issued).toBe(1);
    expect(runtime.status().accepted).toBe(1);
    expect(gate.status().issued).toBe(6);
  });
});

/* --------------- 3. a rebuilt controller does not mint a window ------------ */

describe("3. rebuilding a Jev controller in one session does not replenish the budget", () => {
  it("leaves the session's window intact and makes the new run wait", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const service = modeledService(SESSION_WINDOW_MS, 5);
    const calls: number[] = [];
    const { engine, partition } = crossroads();
    const controllerOptions = {
      serviceGate: gate,
      now: clock.now,
      refreshMs: REFRESH_SIM_MS,
      ttlMs: 1_000,
      minHoldMs: 50,
      maxHoldMs: 60_000,
    } as const;

    // The first controller: the run the user played.
    const first = createJevController({
      ...controllerOptions,
      client: recordingClient({ clock, calls, service, scale: 1.4 }),
      scenarioFingerprint: "first-run",
    });
    expect(startedSync(first.start(observation(engine, partition))).state).toBe("ready");
    for (let index = 0; index < 70; index += 1) {
      first.directives(engine.city, engine.traffic, {
        observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
        partition,
      });
      clock.advance(WALL_MS_PER_TICK);
      stepEngine(engine);
    }
    first.finish(engine.traffic.timeMs);
    expect(calls).toHaveLength(5);

    // The controller is discarded and a new one is built — a reset, a new
    // scenario, a controller switch: whatever the reason, the UPSTREAM allowance
    // did not come back, so neither does the gate's window.
    const builtAt = clock.value;
    const second = createJevController({
      ...controllerOptions,
      client: recordingClient({ clock, calls, service, scale: 0.8 }),
      scenarioFingerprint: "second-run",
    });
    expect(gate.status().issued).toBe(5);
    expect(gate.status().issuedInWindow).toBe(SESSION_MAX_PER_WINDOW);
    expect(gate.eligibility().ok).toBe(false);

    const outcome = await Promise.resolve(second.start(observation(engine, partition)));
    expect(outcome.state).toBe("ready");
    expect(calls).toHaveLength(6);
    expect(calls[5]).toBeGreaterThan(builtAt);
    expect(service.refusals).toEqual([]);
    // The new controller's own account, and the session's own account.
    expect(second.status().service?.issued).toBe(1);
    expect(second.status().service?.issuedInWindow).toBeLessThanOrEqual(SESSION_MAX_PER_WINDOW);
    expect(gate.status().issued).toBe(6);
    expect(second.status().accepted).toBe(1);
    expect(first.status().accepted).toBe(5);
  });
});

/* ------------------- 4. a retry-after crosses the run boundary ------------- */

describe("4. a retry-after run A received still suppresses run B's first request", () => {
  it("asks nothing before the pause the service named has passed", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const service = modeledService(SESSION_WINDOW_MS, 5);
    const aCalls: number[] = [];
    const { engine, partition } = crossroads();

    // RUN A: its first policy lands, and its first refresh is refused with a
    // pause the service named — the measured shape of a 429.
    const runA = runFor({
      clock,
      gate,
      client: recordingClient({
        clock,
        calls: aCalls,
        service,
        scale: 1.4,
        plan: (index) =>
          index === 1
            ? new JevClientError("rate-limited", "jev gateway responded 429", 40_000)
            : undefined,
      }),
      fingerprint: "run-a",
    });
    expect(startedSync(runA.start(observation(engine, partition))).state).toBe("ready");
    drive(runA, engine, partition, 40, clock);
    runA.finish(engine.traffic.timeMs);
    expect(aCalls).toHaveLength(2); // the startup policy, then the refused refresh
    const pauseEndsAt = aCalls[1] + 40_000;
    expect(gate.status().retryAfterMs).toBe(40_000);
    expect(gate.eligibility()).toMatchObject({ ok: false, reason: "retry-after" });

    // RUN B, in the middle of the pause.
    const bCalls: number[] = [];
    const runB = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: bCalls, service, scale: 0.8 }),
      fingerprint: "run-b",
    });
    const builtAt = clock.value;
    expect(builtAt).toBeLessThan(pauseEndsAt);
    const outcome = await Promise.resolve(runB.start(observation(engine, partition)));
    expect(outcome.state).toBe("ready");
    expect(bCalls).toHaveLength(1);
    // Not one request before the pause expired — the pause belongs to the
    // service, not to the run that received it.
    expect(bCalls[0]).toBeGreaterThanOrEqual(pauseEndsAt);
    expect(bCalls[0]).toBeGreaterThan(builtAt);
    expect(service.refusals).toEqual([]);
    expect(gate.status().retryAfterMs).toBeNull();
  });
});

/* ------------------- 5. a transient backoff survives the boundary ---------- */

describe("5. a transient-failure backoff survives the run boundary", () => {
  it("holds the next run off until the backoff has passed, and no sooner", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const aCalls: number[] = [];
    const { engine, partition } = crossroads();

    // RUN A: two 5xx in a row. The gate backs off (doubling from the cadence),
    // and A ends while that backoff is still in force.
    const runA = runFor({
      clock,
      gate,
      client: recordingClient({
        clock,
        calls: aCalls,
        scale: 1.4,
        plan: (index) =>
          index === 1 || index === 2
            ? new JevClientError("upstream-error", "jev gateway responded 503")
            : undefined,
      }),
      fingerprint: "run-a",
    });
    expect(startedSync(runA.start(observation(engine, partition))).state).toBe("ready");
    drive(runA, engine, partition, 40, clock);
    runA.finish(engine.traffic.timeMs);
    expect(aCalls).toHaveLength(3);
    expect(gate.status().failuresInARow).toBe(2);
    const backoffMs = gate.status().minSpacingMs * 2;
    const lastIssuedAt = aCalls[aCalls.length - 1];

    // RUN B, immediately: the failure streak is the SERVICE's state, and the
    // service has not become healthy because a run ended.
    const bCalls: number[] = [];
    const runB = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: bCalls, scale: 0.8 }),
      fingerprint: "run-b",
    });
    const builtAt = clock.value;
    expect(builtAt).toBeLessThan(lastIssuedAt + backoffMs);
    expect(gate.eligibility().ok).toBe(false);
    // The cadence alone would have allowed a request at lastIssuedAt + spacing;
    // the backoff — the state the run boundary must not clear — holds it off for
    // twice that. (The gate reports the cadence first, because it is checked
    // first; what matters here is that the wait satisfies the LONGER bound.)
    clock.advance(SESSION_SPACING_MS);
    expect(gate.eligibility()).toMatchObject({ ok: false, reason: "backoff" });
    const outcome = await Promise.resolve(runB.start(observation(engine, partition)));
    expect(outcome.state).toBe("ready");
    expect(bCalls).toHaveLength(1);
    expect(bCalls[0]).toBeGreaterThanOrEqual(lastIssuedAt + backoffMs);
    expect(bCalls[0]).toBeGreaterThan(builtAt);
  });
});

/* --------- 6. startup under a spent window: wait, or report unable --------- */

describe("6. startup respects the gate: it waits, or reports the run as unable", () => {
  it("waits inside its bound, asks nothing meanwhile, and advances no simulated time", async () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    const waits = manualSleep(clock);
    const gate = await freshSessionGate(clock, { sleep: waits.sleep });
    const service = modeledService(SESSION_WINDOW_MS, 5);

    // A previous run in this session spent the window.
    const spentAt: number[] = [];
    for (let index = 0; index < SESSION_MAX_PER_WINDOW; index += 1) {
      spentAt.push(clock.value);
      gate.issued(clock.value);
      if (index < SESSION_MAX_PER_WINDOW - 1) {
        clock.advance(SESSION_SPACING_MS);
      }
    }

    const calls: number[] = [];
    const runtime = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls, service, scale: 1.2 }),
      fingerprint: "fresh-run",
    });
    const { engine, partition } = crossroads();
    const started = runtime.start(observation(engine, partition));

    // The gate refused the startup, so the run is WAITING: no request, no
    // simulated time, and no policy in force. Nothing is substituted.
    expect(isPromiseLike(started)).toBe(true);
    expect(calls).toEqual([]);
    expect(gate.status().issued).toBe(SESSION_MAX_PER_WINDOW);
    expect(engine.traffic.timeMs).toBe(0);
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.status().source).toBe("waiting");
    expect(runtime.status().refreshes).toBe(0);
    expect(waits.waiting).toBe(1);
    expect(waits.requested[0]).toBeGreaterThan(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);

    // The timer fires: now the request may be made, and it is.
    waits.release();
    const outcome = await Promise.resolve(started);
    expect(outcome).toEqual({ state: "ready", attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(spentAt[0] + SESSION_WINDOW_MS);
    expect(service.refusals).toEqual([]);
    expect(runtime.status().service?.issued).toBe(1);
    expect(engine.traffic.timeMs).toBe(0); // the driver never stepped: only the START does that
  });

  it("reports the run as unable, with NO request, when the bound cannot be met", async () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    // A previous run in this session was rate-limited with a pause LONGER than
    // the wall time a run may spend waiting to start: the honest answer is that
    // this run cannot begin, not that it begins two minutes late.
    gate.issued(clock.value);
    gate.failed({ cause: "rate-limited", retryAfterMs: 120_000, atEpochMs: clock.value });
    expect(gate.status().retryAfterMs).toBe(120_000);

    const calls: number[] = [];
    const runtime = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls, scale: 1.2 }),
      fingerprint: "too-late",
    });
    const { engine, partition } = crossroads();
    const outcome = await Promise.resolve(runtime.start(observation(engine, partition)));

    expect(outcome.state).toBe("unable");
    if (outcome.state !== "unable") {
      throw new Error("a startup the schedule cannot allow must report the run as unable");
    }
    expect(outcome.reason).toBe("service-budget");
    expect(outcome.detail.length).toBeGreaterThan(0);
    expect(outcome.attempts).toBe(0);
    // NO request was made, no simulated time passed, and no policy is in force.
    expect(calls).toEqual([]);
    expect(engine.traffic.timeMs).toBe(0);
    expect(runtime.status().refreshes).toBe(0);
    expect(runtime.status().service?.issued).toBe(0);
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.status().source).toBe("waiting");
    expect(runtime.trace().events).toEqual([]);
    // ...and nothing took Jev's place.
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
    expect(runtime.status().fallbackMs).toBe(0);
    expect(runtime.status().adaptiveTicks).toBe(0);
  });

  it("reports the run as unable when the service's own window is longer than the bound", async () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    // A service that grants 4 requests per FIVE minutes: the cadence alone is
    // 75 s, longer than a run may wait to start, so a run built right after
    // another one's request cannot begin inside its bound — and it says so
    // instead of asking.
    const gate = await freshSessionGate(clock, { windowMs: 300_000, maxPerWindow: 4 });
    gate.issued(clock.value);

    const calls: number[] = [];
    const runtime = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls, scale: 1.2 }),
      fingerprint: "long-window",
    });
    const { engine, partition } = crossroads();
    const outcome = await Promise.resolve(runtime.start(observation(engine, partition)));
    expect(outcome).toMatchObject({ state: "unable", reason: "service-budget", attempts: 0 });
    expect(calls).toEqual([]);
    expect(engine.traffic.timeMs).toBe(0);
    expect(runtime.status().service?.issued).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

/* ------------- 7. a healthy later run once the window has cleared ---------- */

describe("7. after the window clears, a later run starts normally", () => {
  it("carries no stale scenario or policy over: only quota TIMING persists", async () => {
    const clock = fakeClock();
    const gate = await freshSessionGate(clock);
    const service = modeledService(SESSION_WINDOW_MS, 5);
    const { engine, partition } = crossroads();

    const aCalls: number[] = [];
    const runA = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: aCalls, service, scale: 1.4 }),
      fingerprint: "scenario-a",
    });
    expect(startedSync(runA.start(observation(engine, partition))).state).toBe("ready");
    drive(runA, engine, partition, 70, clock);
    runA.finish(engine.traffic.timeMs);
    expect(runA.status().accepted).toBe(5);

    // The window clears with no requests at all.
    clock.advance(2 * SESSION_WINDOW_MS);
    expect(gate.eligibility().ok).toBe(true);

    const bCalls: number[] = [];
    const runB = runFor({
      clock,
      gate,
      client: recordingClient({ clock, calls: bCalls, service, scale: 0.8 }),
      fingerprint: "scenario-b",
    });
    const started = startedSync(runB.start(observation(engine, partition)));
    expect(started.state).toBe("ready");
    // Asked immediately: there was nothing to wait for.
    expect(bCalls).toEqual([clock.value]);
    // No policy, no trace and no counters crossed the run boundary.
    expect(runB.effective().policy?.pressureScale).toBe(0.8);
    expect(runB.trace().events).toHaveLength(1);
    expect(runB.trace().events.every((event) => event.scenarioFingerprint === "scenario-b")).toBe(true);
    expect(runB.status().accepted).toBe(1);
    expect(runB.status().refreshes).toBe(1);
    expect(runB.status().service?.issued).toBe(1);
    expect(runB.status().liveMs).toBe(0);
    // A's own account is untouched by B's existence...
    expect(runA.status().accepted).toBe(5);
    expect(runA.status().service?.issued).toBe(5);
    // ...while the session's budget still remembers everything it spent.
    expect(gate.status().issued).toBe(6);
    expect(service.refusals).toEqual([]);
    expect(runB.status().fallbackMs).toBe(0);
    expect(runB.status().adaptiveTicks).toBe(0);
  });
});

/* -------------------------------- the wiring ------------------------------- */

describe("every live path builds its Jev controller with the SESSION's gate", () => {
  it("is one object per session, however many controllers are built", async () => {
    vi.resetModules();
    const { sessionJevServiceGate } = await import("@/jev/service-budget");
    const first = sessionJevServiceGate();
    expect(sessionJevServiceGate()).toBe(first);
    // Options are the FIRST call's: a later caller cannot replace the session's
    // gate (and therefore cannot mint a new allowance) by asking differently.
    expect(sessionJevServiceGate({ windowMs: 1, maxPerWindow: 1 })).toBe(first);
  });

  it("wires the worker, the harness and the benchmark to it, not to a fresh gate", () => {
    const read = (relative: string): string =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    const worker = read("../worker/simulation.worker.ts");
    expect(worker).toContain("import { sessionJevServiceGate } from \"@/jev/service-budget\";");
    expect(worker).toContain("serviceGate: sessionJevServiceGate(),");
    // A gate per controller is exactly the bug this file exists for.
    expect(worker).not.toContain("createJevServiceGate");
    // The harness and the benchmark are live paths too: one gate per invocation.
    const harness = read("../scripts/jev-fallback-harness.ts");
    expect(harness).toContain("const sessionGate = isLive ? sessionJevServiceGate() : null;");
    expect(harness).toContain("serviceGate: sessionGate,");
    const benchmark = read("../benchmark/cli.ts");
    expect(benchmark).toContain("serviceGate: live ? sessionJevServiceGate() : null,");
    expect(benchmark).not.toContain("createJevServiceGate");
  });
});
