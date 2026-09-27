/**
 * Jev controller (Issues #13, #14, #61): a citywide policy controller behind the
 * same `TrafficController` contract as Fixed and Adaptive.
 *
 * ## Division of labour
 *
 * Jev's opinion arrives as a bounded policy and is translated DETERMINISTICALLY
 * into the only two things a controller may say: "hold" and "advance".
 * Everything legal stays local: min green, max green, yellow, all-red, ring
 * order and every safety constraint are enforced by sim/signals.ts whatever this
 * controller asks for, and Jev can never name a phase, a green time or a lamp
 * state.
 *
 * The starvation rule is Adaptive's own, evaluated FIRST, on UNWEIGHTED waits. A
 * policy — however hostile, however extreme — therefore cannot starve a
 * movement: corridor and region weights scale pressure, never service
 * guarantees.
 *
 * ## The pure-Jev execution contract (Issue #61)
 *
 * A run labelled Jev means ONE thing: a Jev-derived policy controlled 100% of
 * the simulated signal-decision time. This controller therefore has exactly one
 * source of opinion — the policy the runtime accepted — and NO second
 * controller to consult, at any stage of a run:
 *
 *   - NO STARTUP SUBSTITUTION: the run does not begin until the first live
 *     policy is accepted (`start()`). Until then this controller says nothing at
 *     all, and no simulated time passes.
 *   - NO FAILURE SUBSTITUTION: a refresh that fails leaves the last accepted
 *     policy in force, reported as HELD once it is past its freshness window.
 *     Holding a real, previously accepted policy IS Jev control.
 *   - NO EXPIRY SUBSTITUTION: if nothing replaces the policy before its maximum
 *     hold expires, the run is INVALIDATED (`invalidation()`) — the driver stops
 *     it and reports why. It is never continued under anything else.
 *   - NO TRANSPORT-ERROR SUBSTITUTION: a client failure is classified, counted
 *     and reported; it never changes who decides.
 *
 * `createAdaptiveController` is deliberately NOT imported here. There is no code
 * path from this file to an Adaptive decision, and the pure-Jev test suite pins
 * that: an Adaptive module whose constructor and `directives()` fail the test is
 * loaded around a full Jev run, healthy and broken.
 *
 * ## Lifecycle (Issues #14, #61)
 *
 * Everything about when a policy is requested, accepted, held, superseded or
 * expired lives in `jev/runtime.ts`. This file is the thin seam between that
 * runtime and the engine: it feeds the runtime one observation per tick and, in
 * exchange, gets back either a policy in force or the statement that NO policy
 * is in force (the run is waiting to start, or it has lost Jev and must stop).
 * The runtime records how much simulated time each source governed, so a result
 * can never present a held opinion as a fresh one, or ungoverned time as
 * governed.
 *
 * Adaptive remains its own benchmark controller (the deterministic baseline the
 * comparison runs) and is untouched by any of this.
 */
import { phasePressure, starvedPhaseIndex } from "./adaptive";
import { ADAPTIVE_CONSTANTS } from "./adaptive";
import type { TrafficController, TrafficControllerContext } from "./contract";
import type { JevClient } from "@/jev/client";
import type { JevRequestOptions } from "@/jev/request";
import {
  createJevPolicyRuntime,
  isPromiseLike,
  JEV_RUNTIME_DEFAULTS,
  type JevCause,
  type JevCauseCounts,
  type JevEffectivePolicy,
  type JevInvalidation,
  type JevRejection,
  type JevRuntime,
  type JevRuntimeObservation,
  type JevRuntimeStatus,
  type JevStartOutcome,
} from "@/jev/runtime";
import {
  JEV_HINT_MARGIN_SCALE,
  JEV_LIMITS,
  clampWeight,
  neutralJevPolicy,
  type JevIntentEntry,
  type JevPolicy,
} from "@/jev/schema";
import { adapterFromId, type JevAdapter, type JevPolicySource, type JevTrace, type JevTraceEvent, type JevTraceRecordedRun } from "@/jev/trace";
import type { JevServiceGate, JevServiceStatus } from "@/jev/scheduler";
import type { JevRefreshTelemetry } from "@/jev/telemetry";
import type { IntersectionObservation, PhaseObservation } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { SignalDirective, SignalState } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId, RoadId } from "@/sim/types";
import { activeVehicleCount } from "@/sim/traffic";

export const JEV_CONSTANTS = {
  /** Simulated ms between citywide policy requests. */
  REFRESH_MS: JEV_RUNTIME_DEFAULTS.REFRESH_MS,
  /** Pressure below this is "no meaningful demand" (shared with Adaptive). */
  DEMAND_EPSILON: ADAPTIVE_CONSTANTS.DEMAND_EPSILON,
  SWITCH_MARGIN: ADAPTIVE_CONSTANTS.SWITCH_MARGIN,
  AGE_MARGIN_DECAY: ADAPTIVE_CONSTANTS.AGE_MARGIN_DECAY,
  STARVATION_THRESHOLD_MS: ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS,
  STARVATION_MIN_SERVICE_MS: ADAPTIVE_CONSTANTS.STARVATION_MIN_SERVICE_MS,
} as const;

/** Weights resolved from one policy: O(1) lookups per phase, built once. */
export interface JevWeights {
  readonly pressureScale: number;
  readonly marginScale: number;
  readonly corridorWeight: ReadonlyMap<number, number>;
  readonly regionWeight: ReadonlyMap<number, number>;
  /** Coordinated zone intents: id -> {intent, strength}, already bounded. */
  readonly corridorIntent: ReadonlyMap<number, JevIntentEntry>;
  readonly regionIntent: ReadonlyMap<number, JevIntentEntry>;
}

export function resolveJevWeights(policy: JevPolicy): JevWeights {
  return {
    pressureScale: policy.pressureScale,
    marginScale: JEV_HINT_MARGIN_SCALE[policy.hint],
    corridorWeight: new Map(policy.corridorWeights.map((entry) => [entry.id, entry.weight])),
    regionWeight: new Map(policy.regionWeights.map((entry) => [entry.id, entry.weight])),
    corridorIntent: new Map(policy.corridorIntents.map((entry) => [entry.id, entry])),
    regionIntent: new Map(policy.regionIntents.map((entry) => [entry.id, entry])),
  };
}

/**
 * The switch-margin multiplier a COORDINATED zone intent applies at one signal.
 *
 * This is the smallest useful extension of Jev's surface: one bounded entry about
 * a corridor or region moves every intersection that serves it in the same
 * direction, which is exactly the citywide trade-off a local controller cannot
 * represent — Adaptive sees only its own approaches, so it can neither drain a
 * region nor meter one.
 *
 * "drain" pulls the margin down (switch sooner, release the zone); "meter" pushes
 * it up (hold longer, throttle entry). The product of applicable intents is
 * clamped to the declared bounds, so no combination can turn a signal into a
 * different machine: min green, max green, yellow, all-red and starvation
 * protection stay the signal mechanics' business, and a directive is still only
 * hold or advance.
 */
export function zoneMargin(
  intersectionId: IntersectionId,
  phase: PhaseObservation | undefined,
  partition: CityPartition,
  weights: JevWeights,
): number {
  let margin = 1;
  if (phase !== undefined) {
    for (const roadId of phase.roads) {
      for (const corridorId of partition.roadCorridors.get(roadId as RoadId) ?? []) {
        const entry = weights.corridorIntent.get(corridorId);
        if (entry !== undefined) {
          margin *= entry.strength;
        }
      }
    }
  }
  const regionId = partition.intersectionRegion.get(intersectionId);
  if (regionId !== undefined) {
    const entry = weights.regionIntent.get(regionId);
    if (entry !== undefined) {
      margin *= entry.strength;
    }
  }
  return clampWeight(margin, JEV_LIMITS.INTENT_STRENGTH_MIN, JEV_LIMITS.INTENT_STRENGTH_MAX);
}

const NEUTRAL_WEIGHTS = resolveJevWeights(neutralJevPolicy());

/**
 * Effective bounded weight for one phase: the phase's most important corridor
 * weight, clamped to JEV_LIMITS' combined bounds. Pure; exported for tests.
 *
 * This is the PHASE-DIFFERENTIATING part of the policy - the only part that can
 * change which of two competing movements is served. The intersection-common
 * part (the global scale and the signal's region weight) deliberately does NOT
 * live here: multiplying both sides of the advance comparison by it cancels, so
 * it is spent on the margin instead (see jevCommonWeight).
 */
export function jevPhaseWeight(
  phase: PhaseObservation,
  intersectionId: IntersectionId,
  partition: CityPartition,
  weights: JevWeights,
): number {
  let corridor = 1;
  for (const roadId of phase.roads) {
    for (const corridorId of partition.roadCorridors.get(roadId as RoadId) ?? []) {
      const weight = weights.corridorWeight.get(corridorId);
      if (weight !== undefined && weight > corridor) {
        corridor = weight;
      }
    }
  }
  return clampWeight(corridor, JEV_LIMITS.COMBINED_WEIGHT_MIN, JEV_LIMITS.COMBINED_WEIGHT_MAX);
}

/**
 * The intersection-common half of the policy: the global scale times this
 * signal's region weight, bounded the same way. It says "this place is under
 * citywide pressure", which is a statement about the SIGNAL rather than about
 * either movement, so it is applied to the release margin - one-sided, and
 * therefore able to decide. A weight above 1 holds greens longer, below 1
 * releases them sooner. Pure; exported for tests.
 */
export function jevCommonWeight(
  intersectionId: IntersectionId,
  partition: CityPartition,
  weights: JevWeights,
): number {
  const regionId = partition.intersectionRegion.get(intersectionId);
  const region = regionId === undefined ? 1 : weights.regionWeight.get(regionId) ?? 1;
  return clampWeight(
    weights.pressureScale * region,
    JEV_LIMITS.COMBINED_WEIGHT_MIN,
    JEV_LIMITS.COMBINED_WEIGHT_MAX,
  );
}

/**
 * Pure per-signal decision under a resolved policy. Structurally Adaptive's
 * decision — starvation first on unweighted waits, then a ring-successor
 * comparison with age-decayed hysteresis — with weighted pressures and a
 * policy-scaled margin.
 */
export function jevDirective(
  signal: SignalState,
  observation: IntersectionObservation,
  weightOf: (phaseIndex: number) => number,
  marginScale: number,
  commonWeight = 1,
): SignalDirective | undefined {
  if (signal.groups.length < 2) {
    return undefined; // single-axis intersection: nothing to switch to
  }
  if (signal.stage !== "green") {
    return undefined; // clearance stages are mechanics-owned
  }
  const phases = observation.phases;
  // Service guarantee first, on UNWEIGHTED waits: no policy can touch it.
  const current = phases[signal.phaseIndex];
  if (
    current !== undefined &&
    current.maxWaitMs >= JEV_CONSTANTS.STARVATION_THRESHOLD_MS &&
    signal.stageElapsedMs < JEV_CONSTANTS.STARVATION_MIN_SERVICE_MS
  ) {
    return "hold";
  }
  const starved = starvedPhaseIndex(phases, signal.phaseIndex);
  if (starved !== null) {
    return signal.stageElapsedMs >= signal.timing.minGreenMs ? "advance" : undefined;
  }
  if (signal.stageElapsedMs < signal.timing.minGreenMs) {
    return undefined;
  }
  const weighted = (index: number): number => phasePressure(phases[index]) * weightOf(index);
  const currentPressure = weighted(signal.phaseIndex);
  const nextIndex = (signal.phaseIndex + 1) % phases.length;
  const nextPressure = weighted(nextIndex);
  if (currentPressure < JEV_CONSTANTS.DEMAND_EPSILON && nextPressure > JEV_CONSTANTS.DEMAND_EPSILON) {
    return "advance";
  }
  const ageFraction = Math.min(1, signal.stageElapsedMs / signal.timing.maxGreenMs);
  // The citywide part of the policy is spent here rather than on both pressures:
  // `marginScale` carries the global hint, `commonWeight` the global scale and
  // this signal's region weight. Both are one-sided in the comparison below, so
  // unlike a symmetric multiplier they cannot cancel out.
  const margin =
    JEV_CONSTANTS.SWITCH_MARGIN *
    (1 - JEV_CONSTANTS.AGE_MARGIN_DECAY * ageFraction) *
    marginScale *
    commonWeight;
  return nextPressure > currentPressure + margin ? "advance" : "hold";
}

/** Result metadata: which source governed which part of the run. */
export interface JevControllerMeta {
  readonly kind: "jev";
  readonly mode: "live" | "replay";
  /**
   * Which policy source this run used (Issue #38): "mock" for the deterministic
   * stand-in, "gateway" / "schema-service" for the real thing, "replay" for an
   * offline trace, "unconfigured" when no client was ever supplied (a run that
   * cannot start). It is part of the run's own account of itself, so no caller
   * has to remember which adapter it wired.
   */
  readonly adapter: JevAdapter;
  /**
   * For a replay: what the RECORDED run was (its adapter, refusals and
   * ungoverned time). Null when the trace predates #38 — unknown, never "clean".
   */
  readonly recorded: JevTraceRecordedRun | null;
  /** The source in force at the end of the run. */
  readonly source: JevPolicySource;
  /** The startup gate's outcome, or null before it was attempted. */
  readonly start: JevStartOutcome | null;
  readonly liveMs: number;
  readonly replayMs: number;
  /**
   * The part of the governed time a policy covered AFTER its freshness window:
   * the model's opinion still decided the signals, but no fresher one arrived in
   * time. Reported so a held run can never be presented as a freshly-driven one.
   */
  readonly heldMs: number;
  readonly maxHoldMs: number;
  /**
   * Simulated ms NO Jev policy governed: the honest account of time this run did
   * not control. Zero for a run that started under Jev and kept it.
   */
  readonly invalidMs: number;
  /**
   * Simulated ms the Adaptive fallback governed. A HARD ZERO: this controller
   * has no Adaptive path at any stage of a run, so nothing can add to it. It is
   * reported so a finished run can state the zero instead of implying it.
   */
  readonly fallbackMs: number;
  /** Ticks an Adaptive controller decided. A HARD ZERO, for the same reason. */
  readonly adaptiveTicks: number;
  /** Non-null once Jev was lost: the run stopped rather than being substituted. */
  readonly invalidation: JevInvalidation | null;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  readonly traceEvents: number;
  readonly lastRejection: { readonly kind: string; readonly cause: string; readonly detail: string } | null;
  /** The most recently classified cause, or null when nothing has failed. */
  readonly cause: JevCause | null;
  /** How many times each classified cause was seen. */
  readonly causes: JevCauseCounts;
  /** Values clamped to their bounds, and answers dropped below the floor. */
  readonly clamped: number;
  readonly dropped: number;
  /**
   * The per-refresh record: which refreshes went live or were held, WHY each one
   * that did not go live did not, and a bounded list of the most recent windows
   * (see jev/telemetry.ts). This is the run's answer to "where did Jev fail, and
   * why" — inspectable after the fact, with nothing upstream-derived in it.
   */
  readonly telemetry: JevRefreshTelemetry;
  /**
   * What the wall-clock service budget did: requests issued, answers received,
   * refusals by reason, and the spacing successful policies actually landed at.
   * Null for a deterministic run (no gate wired). Counts and durations only, so
   * this can ride in a run's own account of itself without carrying an instant
   * that would make two runs of one scenario differ.
   */
  readonly service: JevServiceStatus | null;
}

export interface JevController extends TrafficController {
  /**
   * Current policy in force, or null when NONE is: the run is waiting for its
   * first policy, or it has lost Jev and been invalidated.
   */
  policy(): JevPolicy | null;
  status(): JevRuntimeStatus;
  meta(): JevControllerMeta;
  /** Accepted policies in replay order — the input to an offline replay. */
  trace(): JevTrace;
  /**
   * THE STARTUP GATE (Issue #61). Obtain the first policy BEFORE any simulated
   * time passes. A driver must not step the engine until this says `ready`; when
   * it says `unable` the run must not start, and nothing may be substituted.
   * Idempotent, and synchronous for a client that answers synchronously.
   */
  start(observation: JevRuntimeObservation): JevStartOutcome | Promise<JevStartOutcome>;
  /** The run's simulated time is over: close the accounting at `atSimMs`. */
  finish(atSimMs: number): void;
  /** The rest of the horizon is simulated back to back: stop asking for policy. */
  beginAcceleratedTail(): void;
  /** Non-null once Jev was lost: the run must stop and report why. */
  invalidation(): JevInvalidation | null;
  /** New scenario: discards the policy, in-flight answers and the trace. */
  reset(next: { scenarioFingerprint: string; trace?: JevTrace | null }): void;
}

export interface JevControllerOptions {
  /** null = unconfigured: the run can never start. */
  readonly client: JevClient | null;
  /**
   * Identifies the scenario this controller serves; guards stale responses and
   * labels the trace. Required on purpose: a placeholder would let a policy
   * accepted for one scenario be applied to another.
   */
  readonly scenarioFingerprint: string;
  readonly refreshMs?: number;
  readonly ttlMs?: number;
  readonly minHoldMs?: number;
  /** How long one policy may keep governing without a replacement. */
  readonly maxHoldMs?: number;
  /** How many times the startup gate may ask for its first policy. */
  readonly startAttempts?: number;
  readonly request?: JevRequestOptions;
  /** "replay" consumes `trace` offline and never touches a client. */
  readonly mode?: "live" | "replay";
  readonly trace?: JevTrace | null;
  readonly onAccepted?: (event: JevTraceEvent) => void;
  readonly onRejected?: (rejection: JevRejection) => void;
  /**
   * Wall-clock service capacity (jev/scheduler.ts), for a LIVE run only: it is
   * what keeps a production run inside the measured upstream allowance. Left
   * unset by every deterministic run (tests, the benchmark matrix, a mock
   * client), which is why adding it changes no existing result.
   */
  readonly serviceGate?: JevServiceGate | null;
  /** The wall clock the gate is read against; injectable for tests. */
  readonly now?: () => number;
}

function countActiveVehicles(traffic: TrafficState): number {
  // Exactly the non-arrived population; O(1) instead of a history sweep.
  return activeVehicleCount(traffic);
}

export function createJevController(options: JevControllerOptions): JevController {
  // Which source this controller's policies come from, decided once from what it
  // was actually wired with — never taken from a caller's label.
  const adapter: JevAdapter =
    options.mode === "replay"
      ? "replay"
      : options.client === null
        ? "unconfigured"
        : (adapterFromId(options.client.id) ?? "schema-service");
  const runtime: JevRuntime = createJevPolicyRuntime({
    client: options.mode === "replay" ? null : options.client,
    scenarioFingerprint: options.scenarioFingerprint,
    refreshMs: options.refreshMs,
    ttlMs: options.ttlMs,
    minHoldMs: options.minHoldMs,
    maxHoldMs: options.maxHoldMs,
    startAttempts: options.startAttempts,
    request: options.request,
    mode: options.mode,
    trace: options.trace,
    onAccepted: options.onAccepted,
    onRejected: options.onRejected,
    serviceGate: options.serviceGate,
    now: options.now,
  });
  let effective: JevEffectivePolicy = {
    source: "waiting",
    policy: null,
    acceptedAtSimMs: null,
    expiresAtSimMs: null,
    generation: null,
    held: false,
  };

  return {
    id: "jev",
    policy: () => effective.policy,
    status: () => runtime.status(),
    trace: () => runtime.trace(),
    reset: (next) => runtime.reset(next),
    start: (observation) => {
      // The gate's answer settles the policy in force, so `policy()` is truthful
      // the moment the run is allowed to begin — not one tick later.
      const outcome = runtime.start(observation);
      const settled = (result: JevStartOutcome): JevStartOutcome => {
        effective = runtime.effective();
        return result;
      };
      return isPromiseLike<JevStartOutcome>(outcome) ? outcome.then(settled) : settled(outcome);
    },
    finish: (atSimMs) => runtime.finish(atSimMs),
    beginAcceleratedTail: () => runtime.beginAcceleratedTail(),
    invalidation: () => runtime.invalidation(),
    meta: () => {
      const status = runtime.status();
      return {
        kind: "jev",
        mode: status.mode,
        adapter,
        recorded: options.trace?.recorded ?? null,
        source: status.source,
        start: status.start,
        liveMs: status.liveMs,
        replayMs: status.replayMs,
        heldMs: status.heldMs,
        maxHoldMs: status.maxHoldMs,
        invalidMs: status.invalidMs,
        fallbackMs: status.fallbackMs,
        adaptiveTicks: status.adaptiveTicks,
        invalidation: status.invalidation,
        refreshes: status.refreshes,
        accepted: status.accepted,
        rejected: status.rejected,
        expiries: status.expiries,
        traceEvents: runtime.trace().events.length,
        lastRejection:
          status.lastRejection === null
            ? null
            : {
                kind: status.lastRejection.kind,
                cause: status.lastRejection.cause,
                detail: status.lastRejection.detail,
              },
        cause: status.lastCause,
        causes: status.causes,
        clamped: status.clamped,
        dropped: status.dropped,
        telemetry: status.refreshTelemetry,
        service: status.service,
      };
    },
    directives(city: City, traffic: TrafficState, context?: TrafficControllerContext) {
      if (!context) {
        return new Map<IntersectionId, SignalDirective>(); // no observations: no opinion
      }
      const frame = context.observations;
      effective = runtime.observe({
        frame,
        partition: context.partition,
        intersections: city.intersections.length,
        activeVehicles: countActiveVehicles(traffic),
      });

      // NO policy in force: this controller has NO opinion at all. It does not
      // consult another controller — there is none to consult — and the run is
      // either waiting for its first policy (no simulated time is passing) or
      // invalidated (the driver stops it). Signals keep their own mechanics.
      if (effective.policy === null) {
        return new Map<IntersectionId, SignalDirective>();
      }

      const weights = resolveJevWeights(effective.policy);
      const directives = new Map<IntersectionId, SignalDirective>();
      for (const [intersectionId, signal] of traffic.signals) {
        const observation = frame.intersections.get(intersectionId);
        if (!observation) {
          continue;
        }
        // The margin a signal uses is the policy's global hint scaled by any
        // coordinated zone intent that applies here: this is where one citywide
        // strategy becomes many local decisions at once.
        const intentMargin = zoneMargin(
          intersectionId,
          observation.phases[signal.phaseIndex],
          context.partition,
          weights,
        );
        const directive = jevDirective(
          signal,
          observation,
          (phaseIndex) =>
            jevPhaseWeight(
              observation.phases[phaseIndex],
              intersectionId,
              context.partition,
              weights,
            ),
          weights.marginScale * intentMargin,
          // The citywide half of the policy: global scale x this signal's
          // region weight, spent on the margin so it cannot cancel.
          jevCommonWeight(intersectionId, context.partition, weights)
        );
        if (directive !== undefined) {
          directives.set(intersectionId, directive);
        }
      }
      return directives;
    },
  };
}

/** Exported for the runtime's tests and for callers that want the neutral base. */
export { NEUTRAL_WEIGHTS };
