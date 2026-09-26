/**
 * QUOTA-AWARE REFRESH SCHEDULING — the live 429 fix, case by case.
 *
 * The measured starting point these tests are written against (one controlled
 * live probe, `/tmp/jev-relay-probe-021825/`): 30 refreshes at the app's
 * simulated cadence, 10 accepted, 20 rejected — 19 of them the upstream rate
 * limit — and the run INVALIDATED at 483.5 s of simulated time because 35 s of
 * wall time went by with no successful refresh. Our own firewall and instance
 * limiter refused nothing, and are not touched by any of this.
 *
 *   A  the scheduler never exceeds the measured service window (and a modeled
 *      5-request service never refuses it)
 *   B  an explicit retry-after suppresses every request until it has passed
 *   C  a successful answer clears the transient-failure backoff
 *   D  a transient 5xx produces backoff, never a retry burst
 *   E  the policy in force keeps governing during a backoff (held, never lost)
 *   F  heldMs tracks the time a stalled run spent past its freshness window
 *   G  max hold still invalidates a run whose service genuinely disappears
 *   H  the accelerated tail asks for nothing, whatever the wall clock says
 *   I  a recorded run replays to the same policy instants (determinism)
 *   J  no gate, refusal or outage can reach an Adaptive decision — and a STARTUP
 *      the gate does not allow reports the run as unable without asking, while a
 *      run whose refresh windows are all declined stays 100% Jev on its first
 *      policy
 *
 * plus the arithmetic that ties the scheduler's wall-clock cadence to the
 * simulated TTL / max-hold constants, so they cannot drift apart again.
 */
import { describe, expect, it, vi } from "vitest";
import { createJevController } from "@/controllers/jev";
import { createFixedController } from "@/controllers/fixed";
import {
  JevClientError,
  clientRetryAfterMs,
  createRelayJevClient,
  retryAfterMsFromHeaders,
  type JevClient,
} from "@/jev/client";
import {
  JEV_RUNTIME_DEFAULTS,
  JEV_MAX_HOLD_MS,
  createJevPolicyRuntime,
  isPromiseLike,
  type JevRuntime,
  type JevStartOutcome,
} from "@/jev/runtime";
import {
  JEV_SERVICE_BUDGET,
  JEV_SERVICE_MAX_BACKOFF_MS,
  JEV_SERVICE_MAX_PER_WINDOW,
  JEV_SERVICE_MIN_SPACING_MS,
  boundedRetryAfterMs,
  createJevServiceGate,
  serviceBackoffMs,
  type JevServiceGate,
} from "@/jev/scheduler";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { PLAYBACK_STEPS_PER_TICK, SIM_TICK_MS } from "@/worker/protocol";
import { makeCrossroads } from "./traffic-support";

/* ------------------------------- the Adaptive spy -------------------------- */

/**
 * Every construction of, and every decision asked of, an Adaptive controller in
 * this file is COUNTED. The scheduling seam is new; the guarantee that it can
 * never reach an Adaptive controller is not, and this file re-proves it with the
 * gate wired, refusing, and the service failing.
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

/** A gate whose waits advance the same clock, so a test never sleeps. */
function gatedClock(start = 1_000_000) {
  const clock = fakeClock(start);
  const gate = createJevServiceGate({
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
  });
  return { clock, gate };
}

/**
 * A gate scaled to WALL MILLISECONDS, so a short simulated run exercises a
 * dozen refreshes. The shipped numbers are pinned in the arithmetic section
 * below; this only makes the runtime-level cases quick. The RATIO is the
 * shipped one (60 s window, 4 requests, 15 s apart), so the runtime sees the
 * same shape of schedule it sees in production.
 */
const SMALL_WINDOW_MS = 60;
const SMALL_MIN_SPACING_MS = 15;

function smallGate(clock: ReturnType<typeof fakeClock>, wallMsPerWindow = SMALL_WINDOW_MS) {
  return createJevServiceGate({
    windowMs: wallMsPerWindow,
    maxPerWindow: 4,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
  });
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

function policy(scale = 1.2) {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: scale,
    hint: "neutral" as const,
    corridorWeights: [],
    regionWeights: [],
  };
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

/* --------------------- A. the measured window is respected ----------------- */

describe("A. the scheduler never spends more of the window than the service grants", () => {
  it("asks a modeled 5-per-60 s service for an hour without a single refusal", () => {
    const { clock, gate } = gatedClock();
    const service = modeledService(JEV_SERVICE_BUDGET.WINDOW_MS, JEV_SERVICE_BUDGET.WINDOW_LIMIT);
    const end = clock.value + 3_600_000;
    while (clock.value < end) {
      // A run that asks the moment it is allowed to, which is the most any run
      // can ask for.
      if (gate.eligibility().ok) {
        service.ask(clock.value);
        gate.issued(clock.value);
      }
      clock.advance(1_000);
    }

    expect(service.refusals).toEqual([]);
    expect(service.worstWindow()).toBeLessThanOrEqual(JEV_SERVICE_MAX_PER_WINDOW);
    expect(service.worstWindow()).toBeLessThanOrEqual(JEV_SERVICE_BUDGET.WINDOW_LIMIT);
    // ...and it is a cadence, not a starved trickle: 4 requests per 60 s.
    expect(service.times.length).toBe(240);
    expect(service.times.length / 60).toBe(JEV_SERVICE_MAX_PER_WINDOW);
  });

  it("leaves the advertised allowance a request of headroom by construction", () => {
    expect(JEV_SERVICE_MAX_PER_WINDOW).toBeLessThan(JEV_SERVICE_BUDGET.WINDOW_LIMIT);
    expect(JEV_SERVICE_MAX_PER_WINDOW * JEV_SERVICE_MIN_SPACING_MS).toBe(
      JEV_SERVICE_BUDGET.WINDOW_MS,
    );
  });
});

/* ------------------------- B. retry-after is respected --------------------- */

describe("B. an explicit retry-after suppresses requests until it has passed", () => {
  it("asks nothing at all inside the pause, and resumes the moment it expires", () => {
    const { clock, gate } = gatedClock();
    gate.issued(clock.value);
    gate.failed({ cause: "rate-limited", retryAfterMs: 40_000, atEpochMs: clock.value });

    let askedInsidePause = 0;
    for (let elapsed = 0; elapsed < 39_000; elapsed += 1_000) {
      clock.advance(1_000);
      const decision = gate.eligibility();
      if (decision.ok) {
        askedInsidePause += 1;
      } else {
        expect(decision.reason).toBe("retry-after");
      }
    }
    expect(askedInsidePause).toBe(0);

    clock.advance(1_000); // 40 s have now passed
    expect(gate.eligibility().ok).toBe(true);
    expect(gate.status().retryAfterMs).toBeNull();
  });

  it("bounds what a service may ask for, and ignores junk", () => {
    expect(boundedRetryAfterMs(40_000)).toBe(40_000);
    expect(boundedRetryAfterMs(-1)).toBeNull();
    expect(boundedRetryAfterMs(Number.NaN)).toBeNull();
    expect(boundedRetryAfterMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(boundedRetryAfterMs(60 * 60_000)).toBe(JEV_SERVICE_BUDGET.MAX_RETRY_AFTER_MS);
  });
});

/* ---------------------- C. success clears the backoff state ---------------- */

describe("C. a successful answer clears the transient-failure backoff", () => {
  it("lets the next request through at the cadence again, not at the backoff", () => {
    const { clock, gate } = gatedClock();
    const start = clock.value;

    gate.issued(start);
    clock.advance(JEV_SERVICE_MIN_SPACING_MS);
    gate.issued(clock.value); // cadence satisfied, no failures yet
    gate.failed({ cause: "upstream-error", retryAfterMs: null, atEpochMs: clock.value });
    expect(gate.status().failuresInARow).toBe(1);

    // One failure's backoff IS the cadence, so the cadence alone still governs
    // here: the failure changed nothing yet, which is the point of starting the
    // backoff at the cadence rather than below it.
    clock.advance(JEV_SERVICE_MIN_SPACING_MS);
    expect(gate.eligibility().ok).toBe(true);

    // A second failure doubles it, and now the backoff is the binding bound: the
    // cadence is satisfied and a request is still refused.
    gate.issued(clock.value);
    gate.failed({ cause: "upstream-error", retryAfterMs: null, atEpochMs: clock.value });
    clock.advance(JEV_SERVICE_MIN_SPACING_MS);
    expect(gate.eligibility().ok).toBe(false);
    expect(gate.eligibility().reason).toBe("backoff");

    // The service answers: the state the backoff guarded against is over.
    gate.succeeded(clock.value);
    expect(gate.status().failuresInARow).toBe(0);
    expect(gate.eligibility().ok).toBe(true);
  });

  it("backs off on a doubling schedule, capped, and only for transient causes", () => {
    const spacing = JEV_SERVICE_MIN_SPACING_MS;
    const cap = spacing * 2;
    expect(serviceBackoffMs(0, spacing, cap)).toBe(0);
    expect(serviceBackoffMs(1, spacing, cap)).toBe(spacing);
    expect(serviceBackoffMs(2, spacing, cap)).toBe(cap);
    expect(serviceBackoffMs(9, spacing, cap)).toBe(cap);
  });
});

/* --------------------------- D. no retry burst ----------------------------- */

describe("D. a transient 5xx produces backoff, never a retry burst", () => {
  it("asks at most a handful of times across a two-minute outage", () => {
    const { clock, gate } = gatedClock();
    const attempts: number[] = [];
    const end = clock.value + 120_000;
    while (clock.value < end) {
      if (gate.eligibility().ok) {
        attempts.push(clock.value);
        gate.issued(clock.value);
        // The service is down for the whole two minutes.
        gate.failed({ cause: "upstream-error", retryAfterMs: null, atEpochMs: clock.value });
      }
      clock.advance(1_000);
    }

    // A burst would be dozens of attempts; the schedule is 5 in two minutes.
    expect(attempts.length).toBe(5);
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    expect(gaps[0]).toBe(JEV_SERVICE_MIN_SPACING_MS);
    for (const gap of gaps.slice(1)) {
      expect(gap).toBe(JEV_SERVICE_MAX_BACKOFF_MS);
    }
  });

  it("does not back off for an answer that arrived but could not be read", () => {
    const { clock, gate } = gatedClock();
    gate.issued(clock.value);
    gate.failed({ cause: "malformed", retryAfterMs: null, atEpochMs: clock.value });
    // The service answered; only the run could not use it. No backoff.
    expect(gate.status().failuresInARow).toBe(0);
    clock.advance(JEV_SERVICE_MIN_SPACING_MS);
    expect(gate.eligibility().ok).toBe(true);
  });
});

/* ------------------- E/F/G. the runtime under a real gate ------------------ */

/**
 * The runtime-level shape: 100 ms simulated per tick, 1 ms of wall time per
 * tick (so 15 wall ms of service cadence is 1 500 simulated ms), which lets a
 * 600-tick run exercise four refreshes without sleeping.
 */
const WALL_MS_PER_TICK = 1;

function gatedRuntime(options: {
  client: JevClient;
  gate: JevServiceGate;
  clock: ReturnType<typeof fakeClock>;
  maxHoldMs?: number;
  ttlMs?: number;
  refreshMs?: number;
}): JevRuntime {
  return createJevPolicyRuntime({
    client: options.client,
    scenarioFingerprint: "quota-scheduler",
    refreshMs: options.refreshMs ?? 100,
    ttlMs: options.ttlMs ?? 1_000,
    maxHoldMs: options.maxHoldMs ?? 20_000,
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
  clock: ReturnType<typeof fakeClock>,
  onTick?: (index: number) => void,
): void {
  for (let index = 0; index < ticks; index += 1) {
    runtime.observe(observation(engine, partition));
    onTick?.(index);
    clock.advance(WALL_MS_PER_TICK);
    stepEngine(engine);
  }
}

describe("E. the policy in force keeps governing while the service backs off", () => {
  it("holds the accepted policy through a transient outage, and asks no burst", () => {
    const clock = fakeClock();
    const gate = smallGate(clock);
    let answers = 0;
    let successes = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        answers += 1;
        // The first policy lands; the next two attempts fail; then the service
        // recovers. Exactly the shape a 5xx pair makes in production.
        if (answers === 1) {
          successes += 1;
          return policy(1.4);
        }
        if (answers <= 3) {
          throw new JevClientError("upstream-error", "jev gateway responded 503");
        }
        successes += 1;
        return policy(1.5);
      },
    };
    const runtime = gatedRuntime({ client, gate, clock });
    const { engine, partition } = crossroads();
    const started = runtime.start(observation(engine, partition));
    if (isPromiseLike<JevStartOutcome>(started)) {
      throw new Error("this client answers inline: the gate must be synchronous");
    }
    expect(started.state).toBe("ready");
    expect(runtime.effective().policy?.pressureScale).toBe(1.4);

    let duringOutage: number | null = null;
    drive(runtime, engine, partition, 120, clock, (index) => {
      if (index === 20) {
        duringOutage = runtime.effective().policy?.pressureScale ?? null;
      }
    });
    runtime.finish(12_000);

    const status = runtime.status();
    // The old policy governed the whole outage: never lost, never substituted.
    expect(duringOutage).toBe(1.4);
    expect(status.invalidation).toBeNull();
    expect(status.invalidMs).toBe(0);
    expect(status.liveMs).toBe(12_000);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    // Held, and reported as held: part of that time had no fresh opinion.
    expect(status.heldMs).toBeGreaterThan(0);
    // The outage cost exactly the two failed attempts, and the requests are the
    // service's cadence — never one per 100 ms window.
    expect(status.service?.issued).toBe(status.refreshes);
    expect(status.service?.failedByCause["upstream-error"]).toBe(2);
    expect(status.causes["upstream-error"]).toBe(2);
    const wallElapsed = 120 * WALL_MS_PER_TICK;
    expect(status.refreshes).toBeLessThanOrEqual(
      Math.floor(wallElapsed / SMALL_MIN_SPACING_MS) + 1,
    );
    // The recovery landed as a fresh policy. Answers that arrived inside the
    // minimum-hold window are refused and COUNTED — never silently applied, and
    // never turned into a second policy the run did not really get.
    expect(runtime.effective().policy?.pressureScale).toBe(1.5);
    expect(status.service?.answered).toBe(successes);
    expect(status.accepted).toBeGreaterThanOrEqual(2);
    expect(status.accepted + (status.causes["held"] ?? 0)).toBe(successes);
  });
});

describe("F. heldMs tracks the time a stalled run spent past its window", () => {
  it("grows with the simulated time the service leaves uncovered", () => {
    const measure = (ticks: number) => {
      const clock = fakeClock();
      const gate = smallGate(clock);
      const client: JevClient = {
        id: "mock",
        // One policy, then the service is silent for good: the run holds it.
        requestPolicy: () => (++answers === 1 ? policy(1.2) : Promise.reject(
          new JevClientError("timeout", "jev relay request timed out"),
        )),
      };
      let answers = 0;
      const runtime = gatedRuntime({ client, gate, clock, maxHoldMs: 60_000 });
      const { engine, partition } = crossroads();
      const started = runtime.start(observation(engine, partition));
      if (isPromiseLike<JevStartOutcome>(started)) {
        throw new Error("the first policy must answer inline here");
      }
      drive(runtime, engine, partition, ticks, clock);
      runtime.finish(ticks * SIM_TICK_MS);
      return runtime.status();
    };

    const shorter = measure(120);
    const longer = measure(200);
    expect(shorter.heldMs).toBeGreaterThan(0);
    // The extra simulated time is exactly what the extra ticks covered.
    expect(longer.heldMs - shorter.heldMs).toBe((200 - 120) * SIM_TICK_MS);
    expect(longer.liveMs).toBe(200 * SIM_TICK_MS);
    expect(longer.invalidMs).toBe(0);
  });
});

describe("G. max hold still invalidates a run whose service disappears", () => {
  it("stops the run, keeps the measurements, and never substitutes", () => {
    const clock = fakeClock();
    const gate = smallGate(clock);
    let answers = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        answers += 1;
        return answers === 1
          ? policy(1.3)
          : Promise.reject(new JevClientError("timeout", "jev relay request timed out"));
      },
    };
    const runtime = gatedRuntime({ client, gate, clock, maxHoldMs: 3_000 });
    const { engine, partition } = crossroads();
    expect((runtime.start(observation(engine, partition)) as JevStartOutcome).state).toBe("ready");

    // Drive until the invalidation is reported — the driver's stop condition.
    let ticks = 0;
    while (runtime.invalidation() === null && ticks < 400) {
      runtime.observe(observation(engine, partition));
      clock.advance(WALL_MS_PER_TICK);
      stepEngine(engine);
      ticks += 1;
    }
    const invalidation = runtime.invalidation();
    expect(invalidation).not.toBeNull();
    expect(invalidation?.reason).toBe("expired");
    runtime.finish(engine.traffic.timeMs);
    const status = runtime.status();
    expect(status.source).toBe("invalidated");
    expect(status.invalidMs).toBeGreaterThan(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

/* ------------------------------ H. the tail -------------------------------- */

describe("H. the accelerated tail asks for nothing, whatever the wall clock says", () => {
  it("sends no request during a back-to-back tail, and holds the last policy", () => {
    const clock = fakeClock();
    const gate = smallGate(clock, 10);
    let requests = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        requests += 1;
        return policy(1.2);
      },
    };
    const runtime = gatedRuntime({ client, gate, clock, maxHoldMs: 600_000 });
    const { engine, partition } = crossroads();
    expect((runtime.start(observation(engine, partition)) as JevStartOutcome).state).toBe("ready");
    drive(runtime, engine, partition, 40, clock);
    const beforeTail = requests;
    const timeBeforeTail = engine.traffic.timeMs;

    runtime.beginAcceleratedTail();
    // The tail runs back to back: no wall time passes at all, and the wall
    // clock is left where it is — a burst here is exactly what used to
    // rate-limit the gateway, and no gate can permit one.
    for (let index = 0; index < 600; index += 1) {
      runtime.observe(observation(engine, partition));
      stepEngine(engine);
    }
    runtime.finish(engine.traffic.timeMs);

    const status = runtime.status();
    expect(requests).toBe(beforeTail);
    expect(engine.traffic.timeMs - timeBeforeTail).toBeGreaterThan(1_000);
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(status.invalidation).toBeNull();
    expect(status.heldMs).toBeGreaterThan(engine.traffic.timeMs - timeBeforeTail - 1_000);
    const tailWindows = status.refreshTelemetry.recent.filter(
      (event) => event.atSimMs >= timeBeforeTail && event.skipped,
    );
    expect(tailWindows.length).toBeGreaterThan(0);
    expect(tailWindows.every((event) => event.outcome === "held")).toBe(true);
  });
});

/* ------------------------------ I. determinism ----------------------------- */

describe("I. a gated live run replays to the same policy instants", () => {
  it("applies the recorded policies to the same ticks, offline and with no gate", () => {
    const clock = fakeClock();
    const gate = smallGate(clock);
    const client: JevClient = { id: "mock", requestPolicy: () => policy(1.35) };
    const live = gatedRuntime({ client, gate, clock, maxHoldMs: 60_000 });
    const { engine, partition } = crossroads();
    expect((live.start(observation(engine, partition)) as JevStartOutcome).state).toBe("ready");
    const livePolicies: string[] = [];
    drive(live, engine, partition, 200, clock, () => {
      livePolicies.push(JSON.stringify(live.effective().policy));
    });
    live.finish(engine.traffic.timeMs);
    const trace = live.trace();

    // The recorded run asked at the service cadence, not once per window.
    expect(trace.events.length).toBeGreaterThan(1);
    expect(trace.events.length).toBeLessThan(10);

    const replayClock = fakeClock();
    const replay = createJevPolicyRuntime({
      client: null,
      mode: "replay",
      trace,
      scenarioFingerprint: "quota-scheduler",
      refreshMs: 100,
      ttlMs: 1_000,
      maxHoldMs: 20_000,
      // A gate is deliberately NOT wired: a replay consumes recorded instants
      // and makes no request at all.
      now: replayClock.now,
    });
    const replayEngine = crossroads().engine;
    const replayPartition = buildCityPartition(replayEngine.city);
    expect(replay.start(observation(replayEngine, replayPartition))).toMatchObject({
      state: "ready",
    });
    const replayedPolicies: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      replay.observe(observation(replayEngine, replayPartition));
      replayedPolicies.push(JSON.stringify(replay.effective().policy));
      replayClock.advance(WALL_MS_PER_TICK);
      stepEngine(replayEngine);
    }
    replay.finish(replayEngine.traffic.timeMs);

    expect(replayedPolicies).toEqual(livePolicies);
    expect(replay.status().replayMs).toBe(live.status().liveMs);
    expect(replay.status().invalidMs).toBe(0);
    expect(replay.status().accepted).toBe(live.status().accepted);
    expect(replay.status().service).toBeNull();
    expect(replay.status().refreshes).toBe(0);
  });
});

/* -------------------------------- J. no Adaptive --------------------------- */

describe("J. no gate, refusal or outage can reach an Adaptive decision", () => {
  it("never constructs or consults an Adaptive controller with the gate wired", () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    const gate = smallGate(clock);
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          throw new JevClientError("rate-limited", "jev gateway responded 429", 30_000);
        },
      },
      scenarioFingerprint: "no-adaptive",
      serviceGate: gate,
      now: clock.now,
      refreshMs: 100,
      ttlMs: 1_000,
      maxHoldMs: 5_000,
    });
    const { engine, partition } = crossroads();
    const started = controller.start(observation(engine, partition));
    // A refused first policy means the run does not start — and nothing takes
    // Jev's place. The gate waits its backoff rather than retrying at once.
    return Promise.resolve(started).then((outcome) => {
      expect(outcome.state).toBe("unable");
      if (outcome.state !== "unable") {
        throw new Error("a refused first policy must report the run as unable to start");
      }
      expect(outcome.reason).toBe("rate-limited");
      for (let index = 0; index < 10; index += 1) {
        controller.directives(engine.city, engine.traffic, {
          observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
          partition,
        });
        stepEngine(engine);
      }
      const status = controller.status();
      expect(status.fallbackMs).toBe(0);
      expect(status.adaptiveTicks).toBe(0);
      expect(status.invalidMs).toBeGreaterThanOrEqual(0);
      expect(adaptiveCalls.constructions).toBe(0);
      expect(adaptiveCalls.decisions).toBe(0);
    });
  });

  it("keeps a gated run 100% Jev on its first policy when every window is refused", () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    // A gate that allows the STARTUP request and then refuses every window: a
    // declined refresh is a SCHEDULING fact, not a failure, and a run whose
    // refreshes are all declined is still 100% Jev — governed by the one policy
    // it did accept. (The startup request is the only one it may make.)
    let issuedCount = 0;
    const refusing: JevServiceGate = {
      eligibility: () =>
        issuedCount === 0
          ? { ok: true, reason: null, waitMs: 0 }
          : { ok: false, reason: "budget", waitMs: 1_000 },
      waitDetail: () => "the service budget for this window is spent",
      issued: () => {
        issuedCount += 1;
      },
      succeeded: () => {},
      failed: () => {},
      waitUntilEligible: async () => false,
      status: () => ({
        issued: issuedCount,
        answered: issuedCount,
        failedByCause: {},
        refusals: { budget: 1 },
        issuedInWindow: issuedCount,
        allowedInWindow: JEV_SERVICE_MAX_PER_WINDOW,
        minSpacingMs: JEV_SERVICE_MIN_SPACING_MS,
        failuresInARow: 0,
        nextEligibleInMs: 1_000,
        successSpacingP50Ms: null,
        successSpacingMaxMs: null,
        retryAfterMs: null,
      }),
    };
    let requests = 0;
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          requests += 1;
          return policy(1.1);
        },
      },
      scenarioFingerprint: "refusing-gate",
      serviceGate: refusing,
      now: clock.now,
      refreshMs: 100,
      ttlMs: 1_000,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads();
    expect((controller.start(observation(engine, partition)) as JevStartOutcome).state).toBe("ready");
    for (let index = 0; index < 200; index += 1) {
      controller.directives(engine.city, engine.traffic, {
        observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
        partition,
      });
      clock.advance(WALL_MS_PER_TICK);
      stepEngine(engine);
    }
    controller.finish(engine.traffic.timeMs);

    const status = controller.status();
    expect(requests).toBe(1); // the startup policy, and nothing else
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(status.invalidation).toBeNull();
    expect(status.heldMs).toBeGreaterThan(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });

  it("refuses to start a run whose first request the gate does not allow", () => {
    adaptiveCalls.constructions = 0;
    adaptiveCalls.decisions = 0;
    const clock = fakeClock();
    // The gate is closed for the STARTUP too. The run must NOT ask anyway: a
    // startup that punched through a spent window would spend it twice and
    // rate-limit the run after it. It reports itself unable, sends no request,
    // and nothing takes Jev's place.
    const closed: JevServiceGate = {
      eligibility: () => ({ ok: false, reason: "budget", waitMs: 1_000 }),
      waitDetail: () => "the service budget for this window is spent",
      issued: () => {},
      succeeded: () => {},
      failed: () => {},
      waitUntilEligible: async () => false,
      status: () => ({
        issued: 0,
        answered: 0,
        failedByCause: {},
        refusals: { budget: 1 },
        issuedInWindow: JEV_SERVICE_MAX_PER_WINDOW,
        allowedInWindow: JEV_SERVICE_MAX_PER_WINDOW,
        minSpacingMs: JEV_SERVICE_MIN_SPACING_MS,
        failuresInARow: 0,
        nextEligibleInMs: 1_000,
        successSpacingP50Ms: null,
        successSpacingMaxMs: null,
        retryAfterMs: null,
      }),
    };
    let requests = 0;
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          requests += 1;
          return policy(1.1);
        },
      },
      scenarioFingerprint: "closed-gate",
      serviceGate: closed,
      now: clock.now,
      refreshMs: 100,
      ttlMs: 1_000,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads();
    return Promise.resolve(controller.start(observation(engine, partition))).then((outcome) => {
      expect(outcome.state).toBe("unable");
      if (outcome.state !== "unable") {
        throw new Error("a startup the gate does not allow must report the run as unable");
      }
      expect(outcome.reason).toBe("service-budget");
      // No request was made, and no simulated time passed.
      expect(outcome.attempts).toBe(0);
      expect(requests).toBe(0);
      expect(engine.traffic.timeMs).toBe(0);
      const status = controller.status();
      expect(status.refreshes).toBe(0);
      expect(status.fallbackMs).toBe(0);
      expect(status.adaptiveTicks).toBe(0);
      expect(status.source).toBe("waiting");
      expect(adaptiveCalls.constructions).toBe(0);
      expect(adaptiveCalls.decisions).toBe(0);
    });
  });
});

/* --------------- the wait, re-decided, inside one wall-clock bound ---------- */

describe("a wait re-decides after every refusal, inside one bound", () => {
  it("waits a retry-after and then the backoff behind it, within the bound", async () => {
    const { clock, gate } = gatedClock();
    const start = clock.value;
    // One transient failure (a backoff of one cadence) and a retry-after that
    // expires BEFORE it: a single sleep would report "not eligible" at the
    // moment the retry-after passed, while the backoff was still in force.
    gate.issued(start);
    gate.failed({ cause: "upstream-error", retryAfterMs: null, atEpochMs: start });
    gate.failed({ cause: "rate-limited", retryAfterMs: 5_000, atEpochMs: start });

    expect(await gate.waitUntilEligible({ maxWaitMs: 60_000 })).toBe(true);
    // The wait covered BOTH bounds: the pause, and the cadence behind it.
    expect(clock.value).toBeGreaterThanOrEqual(start + JEV_SERVICE_MIN_SPACING_MS);
    expect(gate.eligibility().ok).toBe(true);
  });

  it("refuses a wait longer than the bound without waiting at all", async () => {
    const { clock, gate } = gatedClock();
    const start = clock.value;
    gate.issued(start);
    gate.failed({ cause: "rate-limited", retryAfterMs: 30_000, atEpochMs: start });

    expect(await gate.waitUntilEligible({ maxWaitMs: 10_000 })).toBe(false);
    expect(clock.value).toBe(start); // nothing was slept
    expect(gate.eligibility().reason).toBe("retry-after");
  });
});

/* --------------------- the arithmetic that ties it together ---------------- */

describe("the schedule, the freshness window and the max hold agree", () => {
  it("derives the simulated cadence from the measured allowance and the playback", () => {
    const playback = (SIM_TICK_MS * PLAYBACK_STEPS_PER_TICK) / SIM_TICK_MS;
    expect(playback).toBe(8);
    // 60 s window / 4 requests = 15 s of wall time, x 8 = 120 s simulated.
    expect(JEV_SERVICE_BUDGET.WINDOW_MS / JEV_SERVICE_MAX_PER_WINDOW).toBe(
      JEV_SERVICE_MIN_SPACING_MS,
    );
    expect(JEV_SERVICE_MIN_SPACING_MS * playback).toBe(
      JEV_RUNTIME_DEFAULTS.SERVICE_CADENCE_SIM_MS,
    );
  });

  it("keeps TTL above one cadence and max hold above the worst transient stall", () => {
    const cadence = JEV_RUNTIME_DEFAULTS.SERVICE_CADENCE_SIM_MS;
    expect(JEV_RUNTIME_DEFAULTS.TTL_MS).toBeGreaterThan(cadence);
    expect(JEV_RUNTIME_DEFAULTS.TTL_MS).toBeLessThan(cadence * 2);
    // cadence + a 2x backoff, then one more, is what a bad-but-survivable run
    // costs; the max hold has to cover it or the schedule invalidates itself.
    const worstSurvivable = cadence + cadence * 2;
    expect(JEV_MAX_HOLD_MS).toBeGreaterThan(worstSurvivable);
    expect(JEV_MAX_HOLD_MS).toBe(cadence * JEV_RUNTIME_DEFAULTS.MAX_HOLD_CADENCES);
    // ...and it is still a bound: a silent service ends the run.
    expect(JEV_MAX_HOLD_MS).toBeLessThan(JEV_RUNTIME_DEFAULTS.SERVICE_CADENCE_SIM_MS * 6);
  });
});

/* ------------------- the pause, from the wire to the scheduler ------------- */

describe("the pause a service asked for reaches the scheduler, bounded", () => {
  it("reads it from each header a service can say it in, and ignores junk", () => {
    const read = (headers: Record<string, string>) => retryAfterMsFromHeaders(new Headers(headers));
    // The measured 429: `retry-after` in delta-seconds.
    expect(read({ "retry-after": "40" })).toBe(40_000);
    expect(read({ "retry-after": "27" })).toBe(27_000);
    // Our relay's own forwarding header, in milliseconds.
    expect(read({ "x-jev-retry-after-ms": "40000" })).toBe(40_000);
    // The gateway's reset header, when `retry-after` is all it says.
    expect(read({ "x-ratelimit-reset-requests": "40s" })).toBe(40_000);
    // A `retry-after` that is an HTTP-date is not a duration: no guessing.
    expect(read({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeNull();
    expect(read({ "retry-after": "-5" })).toBeNull();
    expect(read({ "retry-after": "soon" })).toBeNull();
    expect(read({})).toBeNull();
    // A service cannot ask for an hour of a 75-second run.
    expect(read({ "retry-after": "3600" })).toBe(JEV_SERVICE_BUDGET.MAX_RETRY_AFTER_MS);
  });

  it("travels with the failure the browser client throws", async () => {
    const client = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "jev service request failed" }), {
          status: 502,
          headers: {
            "x-jev-reason": "rate-limited",
            "x-jev-retry-after-ms": "40000",
          },
        })) as unknown as typeof fetch,
    });
    const attempt = client.requestPolicy({} as never) as Promise<unknown>;
    const error = await attempt.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).failure).toBe("rate-limited");
    expect(clientRetryAfterMs(error)).toBe(40_000);
    // A failure with no pause says so rather than inventing one.
    expect(clientRetryAfterMs(new Error("plain"))).toBeNull();
  });
});
