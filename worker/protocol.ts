/**
 * Worker protocol (Task 11): explicit discriminated unions for the
 * main-thread <-> worker boundary, plus runtime validation so the worker
 * never trusts arbitrary postMessage payloads. Pure module: no DOM calls, no
 * React, no simulation execution — the worker owns all of that.
 */
import type { IncidentKind } from "@/sim/incidents";
import { TRAFFIC_LEVELS } from "@/sim/types";
import { DRIVER_CHOICES, type DriverStrategy } from "@/sim/driver";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type {
  PresentationMetrics,
  PresentationPolicy,
  PresentationSnapshot,
} from "./presentation-snapshot";
import type {
  ChallengeIncidentPlan,
  IncidentCapability,
  ResolvedChallengeIncident,
} from "./challenge-incidents";
import type { ChallengeResult, ComparisonVerdict } from "./challenge-result";
import type { JevRefreshTelemetry } from "@/jev/telemetry";
import type { JevCause } from "@/jev/runtime";

/** Fixed simulation pacing: one 100 ms tick per scheduled worker iteration. */
export const SIM_TICK_MS = 100;

/**
 * Playback compression. The simulation itself is untouched — the engine still
 * advances in its own 100 ms timestep, so speeds, queues and signal timings keep
 * their real proportions — but each real tick runs this many engine steps, so a
 * typical curated trip lands in the 30–60 s the challenge is meant to be
 * watched in.
 */
export const PLAYBACK_STEPS_PER_TICK = 8;

/**
 * The two playback speeds the user may watch a run at (final polish pass):
 * normal, and 3× it. A speed multiplies the engine steps ONE real tick runs —
 * `PLAYBACK_STEPS_PER_TICK × speed` — so it changes how fast the run is
 * watched and nothing about the run: the same steps run in the same order, and
 * no engine or controller decision reads the wall clock. There is no other
 * multiplier anywhere: this is a two-state toggle, not a speed system.
 *
 * What it does change is the WALL-CLOCK rate the same simulated refresh grid
 * asks at, and the service budget (jev/scheduler.ts) is wall-clock paced: at 3×
 * the run reaches its simulator-time refresh windows three times sooner per
 * second of wall time, so the gate may decline more of them and more of the run
 * is HELD policy — reported as held, never hidden by relaxing the budget and
 * never answered by substituting another controller.
 */
export const PLAYBACK_SPEEDS = [1, 3] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * Playback for "Skip to end" (final polish pass): the engine steps ONE real tick
 * runs while the user has asked to finish the run without watching the rest.
 *
 * Not chosen for feel — DERIVED from the bound the run's own policy coverage
 * imposes, because a skipped run must still land in its honest, completed
 * payoff:
 *
 *   one accepted policy may govern   MAX_HOLD_CADENCES x SERVICE_CADENCE_SIM_MS
 *                                    = 4 x 120 s = 480 s of simulated time
 *                                    (jev/runtime.ts, at the shipped playback)
 *   and the wall-clock budget grants at most one request per
 *                                    JEV_SERVICE_MIN_SPACING_MS = 15 s of wall
 *                                    time (jev/scheduler.ts, the measured
 *                                    upstream allowance)
 *
 * so the soonest a replacement policy can arrive is one service spacing of wall
 * time after the last request, and advancing faster than (480 s / 15 s) = 32x
 * real time would outrun the service by construction: the policy in force would
 * expire before its replacement could be accepted, and the run would be
 * INVALIDATED rather than finished. A quarter of that bound is left as margin —
 * a late answer, the refresh grid's own granularity, a tick that overruns —
 * which puts the skip at 24x, three times the normal visible playback.
 *
 * That is also the fastest pace this simulation thread can sustain on current
 * hardware: one engine step of the Metro city costs ~4 ms, so 24 steps per
 * 100 ms tick is already the machine's ceiling (measured 22 s of simulated time
 * per wall second, the same rate "3× speed" reaches). The difference the control
 * makes is not the pace but the omission: the run is finished, and the payoff
 * arrives, without anyone watching the rest of the route — honestly, because the
 * skipped stretch is simulated by exactly the same steps, still asks on the
 * run's own refresh schedule, and reports the time it spent on a HELD policy.
 *
 * tests/run-controls.test.ts pins this arithmetic against the constants it
 * describes, so the pace cannot drift outside the coverage bound.
 */
export const SKIP_STEPS_PER_TICK = 24;

/**
 * Frame cadence: the worker posts exactly ONE presentation frame and one
 * metrics sample per REAL tick, so the renderer's interpolation window is
 * SIM_TICK_MS. This used to be expressed as "every N engine ticks", which
 * silently stopped matching the real interval once a tick could cover several
 * simulated steps — the renderer then ramped its alpha over a window far longer
 * than the frame interval and the whole world stuttered. Cadence lives here,
 * once: SIM_TICK_MS.
/** One centralized live-run horizon: 10 simulated minutes. */
export const LIVE_RUN_HORIZON_MS = 600_000;

/**
 * Controllers the simulation can run.
 *
 * `jev` is the product's primary live run: a citywide policy controller whose
 * opinion comes from an external service through the adapter in `jev/`. Fixed
 * and Adaptive are the deterministic baselines for the SAME scenario, run
 * headlessly beside it (never one at a time in front of the user). Choosing a
 * controller by hand is a developer control: it lives behind `?debug`.
 */
export const CONTROLLER_CHOICES = ["fixed", "adaptive", "jev"] as const;
export type ControllerChoice = (typeof CONTROLLER_CHOICES)[number];

export const CITY_SIZE_CHOICES = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
] as const satisfies readonly CitySize[];

export const TRAFFIC_LEVEL_CHOICES = [
  "light",
  "everyday",
  "rush-hour",
] as const satisfies readonly TrafficLevel[];

export const INCIDENT_CHOICES = [
  "traffic-burst",
  "crash",
  "close-road",
  "bridge-closed",
  "event-release",
] as const satisfies readonly IncidentKind[];

/* ------------------------------ main -> worker ------------------------------ */

export type WorkerCommand =
  | {
      readonly type: "INIT";
      readonly citySize: CitySize;
      readonly trafficLevel: TrafficLevel;
      readonly tripId: CuratedTripId;
      readonly controller: ControllerChoice;
      readonly driver: DriverStrategy;
      readonly seed: number;
      readonly durationMs?: number;
    }
  | { readonly type: "START" }
  | { readonly type: "PAUSE" }
  /**
   * Finish this run at once (final polish pass): the rest of the horizon is
   * simulated back to back through the SAME accelerated tail an arrived run
   * already uses, and the run then completes normally — the arrival/completion
   * frame, the payoff and the baselines all fire exactly as they do for a
   * watched run. The ego may or may not arrive inside that tail; either outcome
   * is reported as it actually happened, and nothing is fabricated.
   */
  | { readonly type: "SKIP_TO_END" }
  /** Watch this run at one of PLAYBACK_SPEEDS. Pacing only — never the world. */
  | { readonly type: "SET_SPEED"; readonly speed: PlaybackSpeed }
  | { readonly type: "RESET"; readonly mode: "same-seed" | "new-seed" }
  | { readonly type: "SET_CONTROLLER"; readonly controller: ControllerChoice }
  /**
   * Change the traffic level of the RUNNING scenario. The trip, its clock, its
   * route and the ego identity are untouched: the new level only adds demand
   * from this moment on, exactly like a real city getting busier.
   */
  | { readonly type: "SET_TRAFFIC"; readonly trafficLevel: TrafficLevel }
  | { readonly type: "INCIDENT"; readonly kind: IncidentKind }
  /**
   * Issue #28: run ONE scenario headlessly under both controllers and return
   * both results. Same world, same driver, same seed, same incident script —
   * only the signals differ. This is the fair comparison, and it is fast
   * because it never posts frames.
   */
  | {
      readonly type: "COMPARE";
      readonly tripId: CuratedTripId;
      readonly trafficLevel: TrafficLevel;
      readonly driver: DriverStrategy;
      readonly seed: number;
      readonly durationMs?: number;
    };

/**
 * Baseline comparison request (Issue #15). The product runs one scenario three
 * ways: the visible Jev run, plus Fixed and Adaptive on the SAME world. The two
 * baselines travel to their own worker with the scenario fields and nothing
 * else — no controller choice, no adapter, no live state.
 */
export type BaselinesCommand = {
  readonly type: "BASELINES";
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly durationMs: number;
};

/* ------------------------------ worker -> main ------------------------------ */

export interface RunConfig {
  readonly citySize: CitySize;
  readonly trafficLevel: TrafficLevel;
  readonly tripId: CuratedTripId;
  readonly controller: ControllerChoice;
  /** Who is driving the ego car. Never part of the scenario or the controller. */
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly durationMs: number;
}

export type WorkerEvent =
  | {
      readonly type: "READY";
    /**
     * The scenario identity of this run. Two runs are comparable only when
     * this matches — it is what the UI shows instead of the raw seed.
     */
    readonly scenarioFingerprint: string;
      readonly config: RunConfig;
      /** Showcase scale (0..4) — the main thread compiles the same geography. */
      readonly scaleIndex: number;
      readonly scaleLabel: string;
      readonly timeMs: number;
      readonly incidentSeed: number;
      /** Fully resolved controller-neutral automatic adversity for this run. */
      readonly incidentPlan: ChallengeIncidentPlan;
      /** Exact resolved adversity available for later controller replay. */
      readonly incidentHistory: readonly ResolvedChallengeIncident[];
      /** Stable serialization input; controller is deliberately absent. */
      readonly incidentFingerprint: string;
    }
  | {
      readonly type: "INCIDENT_RESOLVED";
      readonly kind: IncidentKind;
      readonly queued: boolean;
      readonly label: string;
      readonly incident: ResolvedChallengeIncident | null;
      readonly incidentHistory: readonly ResolvedChallengeIncident[];
      readonly incidentFingerprint: string;
    }
  | { readonly type: "SNAPSHOT"; readonly snapshot: PresentationSnapshot }
  | { readonly type: "METRICS"; readonly metrics: PresentationMetrics }
  | {
      readonly type: "RUN_COMPLETE";
      readonly timeMs: number;
      /** The run's outcome under its controller, tagged for fair comparison. */
      readonly result: ChallengeResult;
      /** Who governed the signals: null when there was no external policy. */
      readonly policy: PresentationPolicy | null;
      /**
       * The per-refresh record (jev/telemetry.ts): which refresh windows went
       * live, were held, or needed the safety net, and why. Null for a
       * controller with no external policy. Diagnostic only — the main thread
       * keeps it behind `?debug`, so no reason vocabulary reaches the DOM.
       */
      readonly telemetry: JevRefreshTelemetry | null;
    }
  | {
      /**
       * A Jev run is waiting for its FIRST policy (Issue #61). Simulated time is
       * NOT advancing: the run has not started, and it will not start until a
       * policy is accepted. The UI shows the wait.
       */
      readonly type: "JEV_STARTING";
      /** True when this wait resumes a run already in progress (a controller switch). */
      readonly resuming: boolean;
    }
  | {
      /** The first policy was accepted: the run is now (or is again) stepping. */
      readonly type: "JEV_READY";
    }
  | {
      /**
       * The run COULD NOT START: no policy was obtained before simulated time
       * would have had to pass. Nothing was simulated and nothing was
       * substituted — this is the whole account of the attempt.
       */
      readonly type: "JEV_UNABLE";
      /** The classified reason, in a closed vocabulary (never upstream prose). */
      readonly reason: JevCause;
      /** This codebase's own bounded sentence. */
      readonly detail: string;
      readonly attempts: number;
    }
  | {
      /**
       * Jev was LOST mid-run: the policy in force outlived its maximum hold and
       * nothing replaced it. The run stopped there — it was never continued
       * under another controller — and this event carries the measurements
       * collected so far, the truthful reason, and the run's own record. It is
       * NOT a completed Jev result and must never be presented as one.
       */
      readonly type: "RUN_INVALIDATED";
      readonly timeMs: number;
      readonly invalidation: { readonly atSimMs: number; readonly reason: JevCause };
      /** The measurements collected before the run stopped (partial, kept). */
      readonly result: ChallengeResult;
      readonly policy: PresentationPolicy | null;
      readonly telemetry: JevRefreshTelemetry | null;
    }
  | {
      readonly type: "COMPARE_RESULT";
      readonly fingerprint: string;
      readonly driver: DriverStrategy;
      readonly tripId: CuratedTripId;
      readonly trafficLevel: TrafficLevel;
      readonly fixed: ChallengeResult;
      readonly adaptive: ChallengeResult;
      readonly verdict: ComparisonVerdict;
      /** Same resolved incident script both runs played. */
      readonly incidentEntries: number;
    }
  | {
      /**
       * Which chaos instruments can actually do something in this world
       * (Issue #39). Posted at the start of a run and whenever the world's
       * capacity for incidents can have changed — never guessed in the UI.
       */
      readonly type: "INCIDENT_CAPABILITIES";
      readonly capabilities: readonly IncidentCapability[];
    }
  | { readonly type: "ERROR"; readonly message: string };

/** What the baseline worker sends back: two results for one fingerprint. */
export type BaselinesEvent =
  | {
      readonly type: "BASELINES_RESULT";
      readonly fingerprint: string;
      readonly driver: DriverStrategy;
      readonly tripId: CuratedTripId;
      readonly trafficLevel: TrafficLevel;
      readonly fixed: ChallengeResult;
      readonly adaptive: ChallengeResult;
      readonly incidentEntries: number;
    }
  | { readonly type: "BASELINES_ERROR"; readonly message: string };

/* -------------------------------- validation -------------------------------- */

function fail(where: string, detail: string): never {
  throw new RangeError(`invalid ${where}: ${detail}`);
}

function readRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("worker command", "expected a plain object");
  }
  return raw as Record<string, unknown>;
}

function readChoice<T extends string>(
  where: string,
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    fail(where, `expected one of ${choices.join(", ")}, received ${String(value)}`);
  }
  return value as T;
}

function readSeed(where: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    fail(where, `seed must be a uint32 integer, received ${String(value)}`);
  }
  return value;
}

/** Validates and narrows one incoming command; throws RangeError on garbage. */
export function parseWorkerCommand(raw: unknown): WorkerCommand {
  const record = readRecord(raw);
  const type = record.type;
  switch (type) {
    case "INIT": {
      const citySize = readChoice("INIT.citySize", record.citySize, CITY_SIZE_CHOICES);
      const trafficLevel = readChoice(
        "INIT.trafficLevel",
        record.trafficLevel,
        TRAFFIC_LEVEL_CHOICES,
      );
      const tripId = readChoice("INIT.tripId", record.tripId, CURATED_TRIP_IDS);
      const controller = readChoice(
        "INIT.controller",
        record.controller,
        CONTROLLER_CHOICES,
      );
      const driver = readChoice("INIT.driver", record.driver ?? "tourist", DRIVER_CHOICES);
      const seed = readSeed("INIT.seed", record.seed);
      let durationMs: number | undefined;
      if (record.durationMs !== undefined) {
        if (
          typeof record.durationMs !== "number" ||
          !Number.isFinite(record.durationMs) ||
          record.durationMs <= 0 ||
          record.durationMs > 24 * 60 * 60 * 1000
        ) {
          fail("INIT.durationMs", `expected a positive finite duration, received ${String(record.durationMs)}`);
        }
        durationMs = record.durationMs;
      }
      return { type, citySize, trafficLevel, tripId, controller, driver, seed, durationMs };
    }
    case "START":
    case "PAUSE":
    case "SKIP_TO_END":
      return { type };
    case "SET_SPEED": {
      const speed = record.speed;
      if (typeof speed !== "number" || !(PLAYBACK_SPEEDS as readonly number[]).includes(speed)) {
        fail(
          "SET_SPEED.speed",
          `expected one of ${PLAYBACK_SPEEDS.join(", ")}, received ${String(speed)}`,
        );
      }
      return { type, speed: speed as PlaybackSpeed };
    }
    case "COMPARE": {
      const tripId = readChoice("COMPARE.tripId", record.tripId, CURATED_TRIP_IDS);
      const trafficLevel = readChoice("COMPARE.trafficLevel", record.trafficLevel, TRAFFIC_LEVEL_CHOICES);
      const driver = readChoice("COMPARE.driver", record.driver, DRIVER_CHOICES);
      const seed = readSeed("COMPARE.seed", record.seed);
      let durationMs: number | undefined;
      if (record.durationMs !== undefined) {
        if (
          typeof record.durationMs !== "number" ||
          !Number.isFinite(record.durationMs) ||
          record.durationMs <= 0 ||
          record.durationMs > 24 * 60 * 60 * 1000
        ) {
          fail("COMPARE.durationMs", `expected a positive finite duration, received ${String(record.durationMs)}`);
        }
        durationMs = record.durationMs;
      }
      return { type, tripId, trafficLevel, driver, seed, durationMs };
    }
    case "RESET": {
      const mode = readChoice("RESET.mode", record.mode, ["same-seed", "new-seed"] as const);
      return { type, mode };
    }
    case "SET_CONTROLLER": {
      const controller = readChoice(
        "SET_CONTROLLER.controller",
        record.controller,
        CONTROLLER_CHOICES,
      );
      return { type, controller };
    }
    case "SET_TRAFFIC": {
      const trafficLevel = readChoice(
        "SET_TRAFFIC.trafficLevel",
        record.trafficLevel,
        TRAFFIC_LEVELS,
      );
      return { type, trafficLevel };
    }
    case "INCIDENT": {
      const kind = readChoice("INCIDENT.kind", record.kind, INCIDENT_CHOICES);
      return { type, kind };
    }
    default:
      fail("worker command", `unknown type ${String(type)}`);
  }
}

/**
 * Validates one baseline request. Same rules as the interactive comparison: the
 * fields must name a real scenario, and the duration is bounded like every other
 * run horizon.
 */
export function parseBaselinesCommand(raw: unknown): BaselinesCommand {
  const record = readRecord(raw);
  if (record.type !== "BASELINES") {
    fail("baselines command", `expected type BASELINES, received ${String(record.type)}`);
  }
  const tripId = readChoice("BASELINES.tripId", record.tripId, CURATED_TRIP_IDS);
  const trafficLevel = readChoice("BASELINES.trafficLevel", record.trafficLevel, TRAFFIC_LEVEL_CHOICES);
  const driver = readChoice("BASELINES.driver", record.driver, DRIVER_CHOICES);
  const seed = readSeed("BASELINES.seed", record.seed);
  let durationMs = LIVE_RUN_HORIZON_MS;
  if (record.durationMs !== undefined) {
    if (
      typeof record.durationMs !== "number" ||
      !Number.isFinite(record.durationMs) ||
      record.durationMs <= 0 ||
      record.durationMs > 24 * 60 * 60 * 1000
    ) {
      fail("BASELINES.durationMs", `expected a positive finite duration, received ${String(record.durationMs)}`);
    }
    durationMs = record.durationMs;
  }
  return { type: "BASELINES", tripId, trafficLevel, driver, seed, durationMs };
}

/** Deterministic next seed for a "new seed" reset: +1 in uint32 space. */
export function nextSeed(seed: number): number {
  return (seed + 1) >>> 0;
}
