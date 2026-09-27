/**
 * Jev policy runtime (Issues #14, #61) — the lifecycle of a PURE JEV run.
 *
 * The lifecycle around the adapter/controller seam: one place that owns the
 * accepted policy, its validity in SIMULATED time, the request generation it
 * came from, and the trace of everything a scenario actually used.
 *
 * ## The execution contract this runtime implements
 *
 * A run labelled Jev means ONE thing: a Jev-derived policy controlled 100% of
 * the simulated signal-decision time. There is no Adaptive path here, at any
 * stage of a run — not at startup, not on a failed refresh, not on a transport
 * error, not on expiry. Concretely:
 *
 *   1. STARTUP GATE — no simulated time passes until the first valid live
 *      policy is accepted (`start()`). If it cannot be obtained the run does
 *      not start: the outcome says `unable` and why. Nothing else decides.
 *   2. REFRESH FAILURE — the last accepted policy keeps governing, reported as
 *      HELD once it is past its freshness window. Holding a real, previously
 *      accepted policy IS Jev control, and the run says how much of its time
 *      was held (`heldMs`) so a held run can never read as a freshly-driven one.
 *   3. LOSS OF JEV — if nothing replaces the policy before its maximum hold
 *      expires, the run is INVALIDATED (`invalidation()`): the driver stops it,
 *      keeps the measurements collected so far and reports the truth. It is
 *      never continued under another controller.
 *   4. ACCOUNTING — every simulated interval is attributed to a source, and the
 *      sources add up to the observed span. `fallbackMs` and `adaptiveTicks`
 *      are HARD ZEROS: the fields exist so a finished run can state the zero
 *      rather than leave it implied. `invalidMs` is the honest bucket for time
 *      no Jev policy governed.
 *
 * ## Time
 *
 * Every validity decision is made in simulation time. A policy is accepted at a
 * simulated instant, expires at a simulated instant, and is held for a simulated
 * minimum. Wall-clock time governs exactly two things, and neither of them can
 * change what the simulation does: how long an HTTP request may take before it
 * is abandoned, and WHEN a request may be made at all (`serviceGate`, see
 * jev/scheduler.ts — the upstream allowance is a wall-clock budget and has to be
 * spent as one). That separation is what makes a run replayable — nothing about
 * policy application depends on how fast the machine or the network was.
 *
 * ## Asking at the rate the service actually grants
 *
 * The cadence this runtime used to ask at was a SIMULATED constant (REFRESH_MS),
 * and at the shipped playback that worked out to ~24 requests/minute against a
 * service whose measured allowance is 5 requests per ~60 s window: the live
 * probe answered 10 of 30 requests, and the run was invalidated when the last
 * accepted policy outlived its hold. `serviceGate` is the fix, and it lives
 * outside this file because it is a wall-clock question: the runtime consults it
 * at each due window, and a window it declines is recorded as SKIPPED (a
 * scheduling fact) rather than as a failure. Everything else is unchanged — a
 * declined window makes no request, substitutes nothing, and leaves the policy
 * in force governing, which is exactly what the contract says a refresh that
 * produces nothing does.
 *
 * The gate is ONE object per application session (jev/service-budget.ts), not
 * one per controller: the allowance belongs to the credential, so a rebuilt
 * controller — a reset, a new scenario, the next run — must inherit the window
 * the previous one spent instead of starting from an empty one. `service` in
 * this runtime's status is this run's own requests, taken as the difference from
 * the counters the shared gate already held when the run was built.
 *
 * ## Startup is not an exception to the schedule
 *
 * The first policy is obtained through the SAME gate as every refresh, and the
 * startup path does not get to ask when the schedule says no. `start()` consults
 * the gate before its request; when a request is not allowed yet it waits, up to
 * `START_RETRY_WAIT_MS` of wall time, and re-decides as the state moves. No
 * simulated time passes while it waits (the driver does not step an engine that
 * has not started). If the bound cannot be met the run reports `unable` with the
 * `service-budget` cause and sends NO request — a startup that punched through a
 * spent window would spend it twice and rate-limit the run that follows it.
 *
 * ## The one rule that makes replay exact
 *
 * A policy is IN FORCE from the first tick strictly after the instant it was
 * accepted (`acceptedAtSimMs < nowMs`). Live and replayed runs use the same
 * rule, so both apply a policy to exactly the same ticks — which is why the same
 * scenario can be replayed offline and produce the same result.
 *
 * The run's FIRST policy is the one exception, and it is not really one: it is
 * obtained BEFORE any simulated decision is made (the startup gate), so it
 * governs the run's first tick as well. A trace's first event is that policy, so
 * a replay applies it to the same first tick.
 *
 * ## What a response must survive to be accepted
 *
 *   1. the runtime must not have been reset since its request (generation);
 *   2. it must belong to the CURRENT scenario fingerprint;
 *   3. it must belong to the CURRENT request generation — a newer request
 *      supersedes an older response;
 *   4. it must not arrive inside the minimum-hold window of the policy already
 *      in force (hysteresis: no thrashing);
 *   5. it must parse, be clamped and be bounded, against the ids the request
 *      actually carried (the adapter's own parser).
 *
 * Anything else is a REJECTION: counted, reported, and kept out of the trace. A
 * rejected response never touches the policy in force, and an old response can
 * never mutate a new scenario.
 *
 * ## Holding the last good policy (the tail, and every slow refresh)
 *
 * A policy is FRESH for `ttlMs` after its acceptance and may keep governing for
 * up to `maxHoldMs` (default: four service cadences — see the constant) when
 * nothing has replaced it. Past the freshness window it is reported as HELD, not
 * as fresh: `heldMs` counts the part of the governed time a held policy
 * governed, and the run says so out loud.
 *
 * Why this exists, measured rather than assumed: the app's paced playback lets a
 * remote model answer inside the refresh window, but the run's last stretch is
 * simulated back to back (the ego has arrived; the tail exists so the visible
 * run covers the same window as its baselines) and a back-to-back loop never
 * turns the event loop, so an answer already in flight cannot land. With a
 * one-window TTL that tail was attributed to the Adaptive fallback — measured at
 * 26.7% of a 600 s run (140 s of it in the tail) against a PERFECT model client
 * with zero rejections. That is a report about the drive, not about the model.
 *
 * The rule stays a pure function of simulated time and the accepted events, which
 * is what keeps replay exact: a replayed trace holds and expires exactly where
 * the recorded run did. Nothing here loosens a safety bound — the mechanics own
 * min green, max green, yellow, all-red and starvation, and a held policy goes
 * through the same bounded translation as a fresh one.
 *
 * ## The accelerated tail
 *
 * `beginAcceleratedTail()` is how a driver says "the rest of the horizon is
 * being simulated back to back". No refresh is requested during it: a request
 * issued there could not be answered (the loop never turns the event loop), so
 * asking would only produce an unpaced burst of doomed requests — measured as
 * `rate-limited x18` against a healthy gateway. The last accepted policy keeps
 * governing the tail, reported as HELD, and any request already in flight is
 * retired so a late answer cannot be counted as a policy that governed.
 *
 * ## Why a request failed, and what an answer cost
 *
 * Every rejection carries a bounded `cause` (see `JevCause`) classified from the
 * transport, not from prose, and the status aggregates them (`causes`,
 * `lastCause`). Answers that were APPLIED but imperfect are counted too
 * (`clamped`, `dropped`), because "the model's policy governed the run" and "the
 * model's policy governed the run perfectly" are different claims and the
 * product must be able to tell them apart.
 *
 * ## Where a refresh went wrong, per refresh
 *
 * Totals cannot say WHICH refresh cost the run, so every refresh window is also
 * recorded, one event each, by `jev/telemetry.ts`: its simulated and wall-clock
 * instant, its outcome (live / held), why it was not live in a closed
 * vocabulary, the policy field and bound when a refusal named one, and the
 * simulated time the window itself spent on each source. The status carries the
 * counters plus a bounded recent-events list (`refreshTelemetry`), so a run can
 * be inspected after the fact without keeping a single byte of upstream text.
 * The record is passive: it changes nothing about what a run decides, so live
 * and replayed runs behave exactly as they did.
 */
import type { ObservationFrame } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import {
  JevClientError,
  clientRetryAfterMs,
  isJevClientFailure,
  type JevClient,
  type JevClientFailure,
} from "./client";
import { buildJevPolicyRequest, jevPolicyContext, type JevRequestOptions } from "./request";
import { serviceStatusSince, type JevServiceGate, type JevServiceStatus } from "./scheduler";
import { parseJevPolicy, type JevPolicy, type JevPolicyRequest } from "./schema";
import {
  createJevRefreshTelemetryRecorder,
  refreshDetailForCause,
  type JevRefreshTelemetry,
  type JevRefreshTelemetryRecorder,
} from "./telemetry";
import {
  compareTraceEvents,
  emptyTrace,
  type JevPolicySource,
  type JevTrace,
  type JevTraceEvent,
  type JevTraceSource,
} from "./trace";

export const JEV_RUNTIME_DEFAULTS = {
  /**
   * Simulated ms between refresh WINDOWS — the grid on which the runtime
   * considers asking. It is NOT the rate the service is asked at: every window
   * is additionally subject to the wall-clock service budget (jev/scheduler.ts),
   * which spends the measured upstream allowance evenly. The grid is finer than
   * the budget on purpose, so the schedule is decided by what the service can
   * answer rather than by this constant. At 8x playback a window is 2.5 s of
   * wall time.
   */
  REFRESH_MS: 20_000,
  /**
   * Simulated ms between SUCCESSFUL policies the service can sustainably
   * provide, at the shipped playback. DERIVED, not chosen: the measured
   * upstream allowance is 5 requests per 60 s window, jev/scheduler.ts spends at
   * most 4 of them (one request per 15 s of wall time), and the shipped playback
   * is 8.0x (SIM_TICK_MS x PLAYBACK_STEPS_PER_TICK) — 15 s x 8.0 = 120 s.
   * tests/jev-quota-scheduler.test.ts pins that arithmetic against the playback
   * constants, so this number cannot drift away from the schedule it describes.
   */
  SERVICE_CADENCE_SIM_MS: 120_000,
  /**
   * Simulated ms a policy stays FRESH after acceptance: 1.5 service cadences.
   * One cadence is when its replacement is due; the extra half covers the
   * window grid's own granularity (REFRESH_MS) plus scheduling jitter, so a
   * healthy run is FRESH rather than held and a failed refresh is what turns
   * time HELD — which is the distinction `heldMs` exists to make.
   */
  TTL_MS: 180_000,
  /** Simulated ms a newly accepted policy is held before another may replace it. */
  MIN_HOLD_MS: 5_000,
  /**
   * How many service cadences one accepted policy may keep governing without a
   * replacement, before the run is INVALIDATED. Derived from the schedule this
   * run actually asks on, not from roundness:
   *
   *   one cadence                                  120 s simulated
   *   one transient 5xx (cadence + its 2x backoff)  360 s simulated
   *   two in a row (cadence + backoff + backoff)    480 s simulated
   *
   * Four cadences (480 s = 60 s of wall time at 8x) therefore covers the worst
   * case a healthy-but-unlucky run can produce, and still ends a run whose model
   * has genuinely gone silent. It deliberately does NOT cover an upstream
   * `retry-after` of the largest value ever measured (60 s of wall time = 480 s
   * simulated ON TOP of the cadence): making that fit would mean a maximum hold
   * at the horizon itself, which is exactly the unbounded hold this contract
   * refuses. The scheduler's first duty is to make a retry-after unnecessary by
   * never filling the measured window; a run the provider does refuse is
   * reported invalid rather than kept alive by a hold that can never fire.
   */
  MAX_HOLD_CADENCES: 4,
  /**
   * How many times the STARTUP gate may ask for its first policy before it
   * reports the run as unable to start. Two: one retry for a service that was
   * briefly unavailable — the retry waits the scheduler's own backoff rather
   * than firing immediately — and then the truth, never a different controller.
   */
  START_ATTEMPTS: 2,
  /**
   * Longest wall-clock pause the STARTUP gate will spend waiting for the
   * service to become eligible, measured PER WAIT — before its FIRST request as
   * well as before its retry. One measured window: a service that asks for
   * longer than its own window is not briefly unavailable, and a run must not
   * begin minutes late without saying so. (The gate may make at most
   * `START_ATTEMPTS` requests, so a startup's whole wait is bounded by twice
   * this, and its requests by the two attempts.) A startup that cannot be made
   * inside its bound reports the run as unable (`service-budget`) and sends no
   * request at all; it never asks anyway, because a request the schedule forbids
   * is exactly the request that gets the run — and the next one — rate-limited.
   */
  START_RETRY_WAIT_MS: 60_000,
} as const;

/** One accepted policy may keep governing for this long without a replacement. */
export const JEV_MAX_HOLD_MS =
  JEV_RUNTIME_DEFAULTS.SERVICE_CADENCE_SIM_MS * JEV_RUNTIME_DEFAULTS.MAX_HOLD_CADENCES;

/**
 * Why a run could not start, why an answer was not used, or why Jev was lost. A
 * closed set: every member is either a transport fact or a lifecycle fact, so a
 * label can say WHY without echoing anything a service said.
 *
 * The transport half is owned by `jev/client.ts` (`JevClientFailure`), because
 * that is where statuses are turned into classes.
 */
export type JevCause =
  | JevClientFailure
  /** No client at all: Jev was never wired in. */
  | "unconfigured"
  /** Configured and asking, but no answer has been accepted yet. */
  | "first-policy"
  /** The policy in force outlived even its maximum hold. */
  | "expired"
  /** An answer arrived inside the minimum-hold window and was refused. */
  | "held"
  /** An answer belonged to a superseded request or a scenario that moved. */
  | "superseded"
  /**
   * The STARTUP gate could not obtain its first policy inside its bounded wait:
   * the run's share of the measured service window was not available in time
   * (spent by earlier runs in this session, a cadence that has not passed, a
   * `retry-after` or a backoff longer than a run may wait to start). NO request
   * was made — the schedule forbade one — so this is a scheduling fact about the
   * service, not a transport failure, and it is never counted as a refusal from
   * the service because the service was never asked.
   */
  | "service-budget";

/** Every cause, for validation, counting and label coverage. */
export const JEV_CAUSES = [
  "unconfigured",
  "first-policy",
  "expired",
  "held",
  "superseded",
  "service-budget",
  "timeout",
  "rate-limited",
  "upstream-error",
  "rejected",
  "unreachable",
  "not-configured",
  "malformed",
  "unknown",
] as const satisfies readonly JevCause[];

export type JevRejectionKind =
  | "stale-generation"
  | "stale-fingerprint"
  | "invalidated"
  | "held"
  | "malformed"
  | "client-error";

export interface JevRejection {
  readonly kind: JevRejectionKind;
  /** The classified cause behind the rejection; never upstream prose. */
  readonly cause: JevCause;
  /** Simulated ms the rejection was noticed at. */
  readonly atSimMs: number;
  readonly detail: string;
}

/**
 * The bounded cause of a client failure. A `JevClientError` already carries its
 * class; anything else is classified from the error's own message, which for
 * our clients is always a status line this codebase wrote.
 */
export function clientFailureCause(error: unknown): JevCause {
  if (error instanceof JevClientError) {
    return error.failure;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  const message = error instanceof Error ? error.message : "";
  const status = Number(/responded (\d{3})/.exec(message)?.[1] ?? Number.NaN);
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500) {
    return "upstream-error";
  }
  if (status >= 400) {
    return "rejected";
  }
  return "unknown";
}

/** Per-cause counts: only the causes that actually happened appear. */
export type JevCauseCounts = Readonly<Partial<Record<JevCause, number>>>;

/**
 * The TRANSPORT half of a cause. `JevCause` also carries lifecycle facts
 * (unconfigured, held, superseded, …) which are not service behaviour; the
 * scheduler only ever acts on what the transport said, so anything outside that
 * vocabulary is reported to it as `unknown` rather than silently ignored.
 */
export function transportFailure(cause: JevCause): JevClientFailure {
  return isJevClientFailure(cause) ? cause : "unknown";
}

export interface JevRuntimeOptions {
  /** null = unconfigured: the runtime can never start a run. */
  readonly client: JevClient | null;
  readonly scenarioFingerprint: string;
  readonly refreshMs?: number;
  readonly ttlMs?: number;
  readonly minHoldMs?: number;
  /**
   * How long one accepted policy may keep governing without a replacement.
   * Defaults to `JEV_MAX_HOLD_MS` (the service cadence x `MAX_HOLD_CADENCES`),
   * never to a multiple of `ttlMs` — the schedule is what decides how long a
   * silence is survivable, not the freshness window. Must not be shorter than
   * `ttlMs`: a policy cannot be expected to stop governing before it stops
   * being fresh.
   */
  readonly maxHoldMs?: number;
  /** How many times the startup gate may ask for its first policy. */
  readonly startAttempts?: number;
  readonly request?: JevRequestOptions;
  /** "replay" consumes the supplied trace instead of calling any client. */
  readonly mode?: "live" | "replay";
  readonly trace?: JevTrace | null;
  /**
   * Wall-clock service capacity, or null for "every due window asks". A live run
   * wires the SESSION's gate (`sessionJevServiceGate`, jev/service-budget.ts —
   * one gate per application session, because the upstream allowance belongs to
   * the credential and does not reset when a controller is rebuilt), which is
   * what keeps a production run inside the measured upstream allowance; a
   * deterministic run (a mock client, a benchmark, a test) leaves it null and is
   * byte-identical to what it was before this seam existed. See `observe()` for
   * where it is consulted: it can only SKIP a request, never make one, and it
   * never decides anything about the simulation. `start()` consults it too —
   * startup waits inside its own bound rather than asking when the schedule says
   * no.
   */
  readonly serviceGate?: JevServiceGate | null;
  /**
   * The wall clock, used ONLY for the service gate's instants and for the
   * per-refresh record's correlation timestamps. Injectable so a test can freeze
   * it; nothing about a policy, a directive or a simulated instant reads it.
   */
  readonly now?: () => number;
  /**
   * How many recent refresh events the telemetry keeps (see jev/telemetry.ts).
   * The counters cover every refresh whatever this is; it only bounds the list.
   */
  readonly telemetryEvents?: number;
  readonly onAccepted?: (event: JevTraceEvent) => void;
  readonly onRejected?: (rejection: JevRejection) => void;
}

export interface JevRuntimeObservation {
  readonly frame: ObservationFrame;
  readonly partition: CityPartition;
  readonly intersections: number;
  readonly activeVehicles: number;
}

/**
 * What is in force for this tick. `policy` is null exactly when NO Jev policy
 * governs — either because the run has not started yet (`waiting`) or because
 * the policy in force outlived its maximum hold (`invalidated`). There is no
 * third possibility: this runtime has nothing else to decide with.
 */
export interface JevEffectivePolicy {
  readonly source: JevPolicySource;
  readonly policy: JevPolicy | null;
  readonly acceptedAtSimMs: number | null;
  /** When the policy's FRESHNESS window ends. It may keep governing past it. */
  readonly expiresAtSimMs: number | null;
  readonly generation: number | null;
  /** True when the policy in force is past its freshness window (held). */
  readonly held: boolean;
}

/** The startup gate passed: a live policy was accepted before any time passed. */
export interface JevStartReady {
  readonly state: "ready";
  /** How many requests the gate needed. */
  readonly attempts: number;
}

/**
 * The startup gate failed: the run must NOT start. Nothing is substituted — the
 * reason is the run's whole account of why it could not begin.
 */
export interface JevStartUnable {
  readonly state: "unable";
  /** The classified reason the first policy could not be obtained. */
  readonly reason: JevCause;
  /** This codebase's own bounded sentence; never upstream prose. */
  readonly detail: string;
  readonly attempts: number;
}

export type JevStartOutcome = JevStartReady | JevStartUnable;

/**
 * Jev was LOST: the policy in force outlived its maximum hold and nothing
 * replaced it. The run stops here, with its measurements kept and this reason
 * reported — it is never continued under another controller.
 */
export interface JevInvalidation {
  /** The simulated instant at which the hold expired. */
  readonly atSimMs: number;
  /** Always `expired` today; a closed cause, never upstream prose. */
  readonly reason: JevCause;
  /** The simulated ms a Jev policy governed before Jev was lost. */
  readonly governedMs: number;
}

export interface JevRuntimeStatus {
  readonly mode: "live" | "replay";
  readonly configured: boolean;
  readonly source: JevPolicySource;
  /** The startup gate's outcome, or null before it has been attempted. */
  readonly start: JevStartOutcome | null;
  readonly inFlight: boolean;
  readonly requestGeneration: number;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  /**
   * Simulated time governed by each source. Each interval is attributed to the
   * source that was in force DURING it, so the buckets add up to the simulated
   * time observed so far — the interval after the last observation is closed by
   * `finish(atSimMs)`.
   */
  readonly liveMs: number;
  readonly replayMs: number;
  /**
   * The part of `liveMs + replayMs` a policy governed AFTER its freshness
   * window had passed. A subset, never a fourth bucket: the governed-time sum is
   * unchanged, and this is what keeps "the model's policy governed the run"
   * distinguishable from "it governed it with a fresh opinion".
   */
  readonly heldMs: number;
  /** Simulated ms a policy may keep governing without a replacement. */
  readonly maxHoldMs: number;
  /**
   * Simulated ms NO Jev policy governed: the run's own account of the time it
   * did not control. Zero for a run that started under Jev and kept it.
   */
  readonly invalidMs: number;
  /**
   * Simulated ms the Adaptive fallback governed. A HARD ZERO: this runtime has
   * no Adaptive path at any stage of a run, so nothing can ever add to it. It is
   * reported because "zero fallback time" is part of the execution contract and
   * a finished run must be able to state it, not merely imply it.
   */
  readonly fallbackMs: number;
  /**
   * Ticks an Adaptive controller decided. A HARD ZERO for the same reason: the
   * only decision-maker this runtime can consult is the accepted Jev policy, so
   * no tick of a Jev run can be an Adaptive tick.
   */
  readonly adaptiveTicks: number;
  readonly acceptedAtSimMs: number | null;
  /** When the policy in force stops being fresh (it may keep governing). */
  readonly expiresAtSimMs: number | null;
  /** Non-null once Jev has been lost: the run must stop, not be substituted. */
  readonly invalidation: JevInvalidation | null;
  readonly lastRejection: JevRejection | null;
  /** The most recently classified cause, or null when nothing has failed yet. */
  readonly lastCause: JevCause | null;
  /** How many times each cause was seen. Only causes that happened appear. */
  readonly causes: JevCauseCounts;
  /** Values clamped to their bounds across accepted answers (imperfections). */
  readonly clamped: number;
  /** Answers dropped below the confidence floor across accepted answers. */
  readonly dropped: number;
  /**
   * The per-refresh record: how many refresh windows went live or were held,
   * WHY each one that did not go live did not, and a bounded list of the most
   * recent windows. See jev/telemetry.ts.
   */
  readonly refreshTelemetry: JevRefreshTelemetry;
  /**
   * What the service gate did: requests issued, answers received, refusals by
   * reason, and how far apart successful policies actually landed. Null when no
   * gate is wired (a deterministic run). Counts and durations only — a live
   * run's own account of its service cadence, so a report can quote it instead
   * of asserting it.
   */
  readonly service: JevServiceStatus | null;
  /** Replay events still waiting for their instant. */
  readonly queuedEvents: number;
}

export interface JevRuntime {
  /** One call per tick, before the controller decides its directives. */
  observe(observation: JevRuntimeObservation): JevEffectivePolicy;
  /**
   * THE STARTUP GATE. Obtain the first policy BEFORE any simulated time passes:
   * resolves `ready` once a live policy is accepted, or `unable` (with the
   * classified reason) when it cannot be. A run must not start unless this says
   * `ready`; nothing is substituted when it does not.
   *
   * Synchronous for a client that answers synchronously, a promise for one that
   * does not.
   */
  start(observation: JevRuntimeObservation): JevStartOutcome | Promise<JevStartOutcome>;
  /**
   * The run's simulated time is over. Closes the last interval's accounting at
   * `atSimMs` and retires any request still in flight, so an answer that arrives
   * after the run can never be counted as a policy that governed.
   */
  finish(atSimMs: number): void;
  /**
   * The rest of the horizon is being simulated back to back. No refresh is
   * requested from here on — a request issued now could not be answered, and an
   * unpaced burst of them is exactly what rate-limited the gateway. The last
   * accepted policy governs the tail, reported as HELD.
   */
  beginAcceleratedTail(): void;
  /** Non-null once Jev has been lost: the run must stop. */
  invalidation(): JevInvalidation | null;
  /** New scenario or reset: discards policy, in-flight answers and the trace. */
  reset(next: { scenarioFingerprint: string; trace?: JevTrace | null }): void;
  /** The policy in force for the most recent observation. */
  effective(): JevEffectivePolicy;
  status(): JevRuntimeStatus;
  /** Everything this scenario accepted, in replay order. */
  trace(): JevTrace;
}

/** Pure refresh trigger: coarse, simulated-time driven, never per tick. */
export function refreshDue(nowMs: number, refreshMs: number): boolean {
  return nowMs % refreshMs === 0;
}

/**
 * True when a client answered with a promise instead of a value. A synchronous
 * stand-in answers inline, and a run driven by one must not be forced through
 * the event loop to obtain its policy.
 */
export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

export function createJevPolicyRuntime(options: JevRuntimeOptions): JevRuntime {
  const refreshMs = options.refreshMs ?? JEV_RUNTIME_DEFAULTS.REFRESH_MS;
  const ttlMs = options.ttlMs ?? JEV_RUNTIME_DEFAULTS.TTL_MS;
  const minHoldMs = options.minHoldMs ?? JEV_RUNTIME_DEFAULTS.MIN_HOLD_MS;
  const maxHoldMs = options.maxHoldMs ?? JEV_MAX_HOLD_MS;
  const startAttempts = options.startAttempts ?? JEV_RUNTIME_DEFAULTS.START_ATTEMPTS;
  for (const [name, value] of [
    ["refreshMs", refreshMs],
    ["ttlMs", ttlMs],
    ["minHoldMs", minHoldMs],
    ["maxHoldMs", maxHoldMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be finite and positive, received ${value}`);
    }
  }
  if (maxHoldMs < ttlMs) {
    throw new RangeError(
      `maxHoldMs must not be shorter than ttlMs, received ${maxHoldMs} < ${ttlMs}`,
    );
  }
  if (!Number.isInteger(startAttempts) || startAttempts < 1) {
    throw new RangeError(`startAttempts must be a positive integer, received ${startAttempts}`);
  }

  const mode = options.mode ?? "live";
  const client = options.client;
  const configured = client !== null && mode === "live";
  /**
   * The wall-clock service budget. Null for every deterministic run (and every
   * existing test), which is what keeps this seam from changing a single
   * simulated decision: a gate can only decline to ask.
   *
   * It is SHARED across the runs of one session (jev/service-budget.ts): its
   * window, spacing, retry-after and backoff describe the UPSTREAM allowance,
   * which does not reset when a controller is rebuilt. So the counters that
   * describe it are session-wide, and this run keeps the snapshot they had when
   * it was built — `service` in this runtime's status is the DIFFERENCE, this
   * run's own requests, while the capacity fields stay the service's current
   * state. Nothing else about a run crosses that boundary: the policy, the
   * trace, the fingerprint, the generation and the telemetry are per-run.
   */
  const gate = options.serviceGate ?? null;
  let serviceBaseline: JevServiceStatus | null = gate === null ? null : gate.status();
  /**
   * The run's own service view, FROZEN when the run ends: a finished run's
   * account of its own requests must not grow because a later run in the same
   * session spent more of the shared window.
   */
  let serviceFrozen: JevServiceStatus | null = null;
  /** The wall clock. Read only for the gate and for correlation timestamps. */
  const now = options.now ?? Date.now;
  const clientId = client?.id ?? (mode === "replay" ? "replay" : "none");
  /** The per-refresh record. Passive: it observes, it never decides. */
  const telemetry: JevRefreshTelemetryRecorder = createJevRefreshTelemetryRecorder({
    bound: options.telemetryEvents,
  });

  let fingerprint = options.scenarioFingerprint;
  let generation = 0;
  /** The policy in force, and the record of everything accepted. */
  let accepted: JevTraceEvent | null = null;
  /**
   * True while `accepted` is the run's FIRST policy. That policy was obtained
   * before any simulated decision (the startup gate), so it governs the run's
   * first tick as well; every later policy governs from the tick strictly after
   * its acceptance instant, which is what keeps live and replay identical.
   */
  let acceptedIsStartup = false;
  let recorded: JevTraceEvent[] = [];
  /** Accepted between ticks (live) or waiting for their instant (replay). */
  let pending: JevTraceEvent | null = null;
  let queue: JevTraceEvent[] = [];
  /**
   * The generation that OWNS the single in-flight slot, or null when it is free.
   * Ownership is what stops a superseded request from releasing a newer one's
   * lock when it finally settles: only the owner may clear it.
   */
  let inFlightGeneration: number | null = null;
  /**
   * The simulated instant the last request was issued at. The startup gate asks
   * at the run's first instant, which the refresh cadence is ALSO due at; one
   * window per instant means the cadence must not ask twice.
   */
  let lastRequestAtSimMs: number | null = null;
  let lastObservedMs: number | null = null;
  let lastSource: JevPolicySource = "waiting";
  /** Whether the policy in force during the last interval was past its window. */
  let lastHeld = false;
  let expiredFor: number | null = null;
  /** The startup gate's outcome, once it has been attempted. */
  let startOutcome: JevStartOutcome | null = null;
  /** Set once Jev has been lost: the run must stop. */
  let invalid: JevInvalidation | null = null;
  /** True once the rest of the run is being simulated back to back. */
  let acceleratedTail = false;
  /** True once the run's simulated time is over: no answer may be adopted. */
  let runClosed = false;

  let refreshes = 0;
  let acceptedCount = 0;
  let rejected = 0;
  let expiries = 0;
  let lastRejection: JevRejection | null = null;
  let lastCause: JevCause | null = null;
  const causeCounts = new Map<JevCause, number>();
  let clampedCount = 0;
  let droppedCount = 0;
  let liveMs = 0;
  let replayMs = 0;
  let invalidMs = 0;
  let heldMs = 0;

  const countCause = (cause: JevCause): void => {
    lastCause = cause;
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
  };

  /**
   * True when a policy governs at this instant — possibly past its freshness
   * window (`held`), which is exactly what that word means. Used to decide
   * whether a refresh that produced nothing was covered by an older policy or
   * had nothing behind it at all, so the per-refresh record cannot call a
   * covered window uncovered or the other way round.
   */
  const policyInForceAt = (nowMs: number): boolean =>
    accepted !== null && nowMs <= accepted.simulationTimeMs + maxHoldMs;

  const reject = (
    kind: JevRejectionKind,
    atSimMs: number,
    detail: string,
    cause: JevCause,
    refusalGeneration: number | null = null,
  ): void => {
    rejected += 1;
    countCause(cause);
    lastRejection = { kind, cause, atSimMs, detail };
    telemetry.refuse({
      generation: refusalGeneration,
      kind,
      cause,
      // The record keeps this codebase's OWN sentence. A client error's message
      // is dropped here (the refusals list still carries it for the console):
      // a client is an outside seam, and the record's rule is absolute — no
      // upstream prose, ever. The classified cause is what a report needs.
      detail: kind === "client-error" ? refreshDetailForCause(cause) : detail,
      settledAtEpochMs: now(),
      governing: policyInForceAt(atSimMs),
    });
    options.onRejected?.(lastRejection);
  };

  // A replay runtime starts with the trace it was handed, already validated
  // against this scenario: an offline run must refuse the wrong trace rather
  // than replay another scenario's policies.
  if (mode === "replay" && options.trace !== null && options.trace !== undefined) {
    if (options.trace.scenarioFingerprint !== fingerprint) {
      reject(
        "stale-fingerprint",
        0,
        `trace was recorded for ${options.trace.scenarioFingerprint}, not ${fingerprint}`,
        "superseded",
      );
    } else {
      queue = [...options.trace.events].sort(compareTraceEvents);
    }
  }

  const adopt = (event: JevTraceEvent): void => {
    // The run's first policy is the startup policy: it was obtained before any
    // simulated decision, so it governs the first tick too (see inForceAt).
    acceptedIsStartup = accepted === null && recorded.length === 0;
    accepted = event;
    expiredFor = null;
    recorded.push(event);
    acceptedCount += 1;
    options.onAccepted?.(event);
  };

  /** True once the event's freshness window has passed. Pure. */
  const isStale = (nowMs: number, event: JevTraceEvent): boolean =>
    nowMs - event.simulationTimeMs > ttlMs;

  /**
   * Pure: which event is in force at a simulated instant.
   *
   * In force from its acceptance instant (the run's FIRST policy, obtained
   * before the run began) or from the first tick strictly after it (every later
   * one) until `maxHoldMs`, so a policy keeps governing while its replacement is
   * still being fetched. Past the freshness window it is HELD (reported as
   * such); past the maximum hold NO policy is in force and the run is
   * invalidated — never handed to another controller.
   *
   * Both bounds are simulated time, so a replay holds and expires exactly where
   * the recorded run did.
   */
  const inForceAt = (nowMs: number): JevTraceEvent | null => {
    if (accepted === null) {
      return null;
    }
    const from = acceptedIsStartup ? accepted.simulationTimeMs : accepted.simulationTimeMs + 1;
    if (nowMs < from) {
      return null;
    }
    return nowMs > accepted.simulationTimeMs + maxHoldMs ? null : accepted;
  };

  /**
   * The classification of the time that is NOT governed at this instant, or null
   * while a policy governs. `expired` is the only reason a started run can stop
   * governing: the policy in force outlived its maximum hold.
   */
  const ungovernedReasonAt = (nowMs: number): JevCause | null => {
    if (inForceAt(nowMs) !== null) {
      return null;
    }
    if (accepted === null) {
      // Nothing has ever been accepted: the run is waiting for its first policy
      // (the startup gate), or every attempt so far failed.
      return configured ? lastCause ?? "first-policy" : "unconfigured";
    }
    return "expired";
  };

  /** Attribute one simulated interval to the source that governed it. */
  const accountInterval = (deltaMs: number, source: JevPolicySource, held: boolean): void => {
    const delta = Math.max(0, deltaMs);
    // The same interval is attributed to the refresh window that owned it, so
    // the per-refresh rows add up to the run's own totals.
    telemetry.account({ deltaMs: delta, source, held });
    if (source === "live") {
      liveMs += delta;
      if (held) heldMs += delta;
    } else if (source === "replay") {
      replayMs += delta;
      if (held) heldMs += delta;
    } else {
      // `waiting` and `invalidated`: simulated time NO Jev policy governed.
      // Never fallback time — this runtime has no fallback to attribute it to.
      invalidMs += delta;
    }
  };

  const effectiveAt = (nowMs: number): JevEffectivePolicy => {
    const event = inForceAt(nowMs);
    if (event === null) {
      return {
        source: accepted === null ? "waiting" : "invalidated",
        policy: null,
        acceptedAtSimMs: accepted?.simulationTimeMs ?? null,
        expiresAtSimMs: accepted === null ? null : accepted.simulationTimeMs + ttlMs,
        generation: accepted?.requestGeneration ?? null,
        held: false,
      };
    }
    return {
      // Where the policy is coming FROM for this run: a policy replayed offline
      // governs the city as a replay, whatever it was when it was recorded.
      source: mode === "replay" ? "replay" : "live",
      policy: event.policy,
      acceptedAtSimMs: event.simulationTimeMs,
      expiresAtSimMs: event.simulationTimeMs + ttlMs,
      generation: event.requestGeneration,
      held: isStale(nowMs, event),
    };
  };

  /**
   * A response (or a trace event) that wants to become the policy in force.
   * Every guard here is a reason an answer must NOT be trusted.
   */
  const consider = (
    raw: unknown,
    context: {
      readonly requestGeneration: number;
      readonly requestFingerprint: string;
      readonly acceptedAtSimMs: number;
      readonly requestedAtSimMs: number;
      readonly source: JevTraceSource;
      /** Ids the request carried: a policy may only reference these. */
      readonly corridorIds: readonly number[];
      readonly regionIds: readonly number[];
    },
  ): void => {
    if (runClosed) {
      // The run's simulated time is over. An answer that arrives now cannot
      // govern a single tick, so it is neither adopted nor counted: its refresh
      // window stays unresolved (see jev/telemetry.ts) instead of being guessed
      // into a policy the run never used.
      return;
    }
    if (context.requestGeneration !== generation) {
      reject(
        "stale-generation",
        context.acceptedAtSimMs,
        `generation ${context.requestGeneration} superseded by ${generation}`,
        "superseded",
        context.requestGeneration,
      );
      return;
    }
    if (context.requestFingerprint !== fingerprint) {
      reject(
        "invalidated",
        context.acceptedAtSimMs,
        "the scenario changed under this response",
        "superseded",
        context.requestGeneration,
      );
      return;
    }
    if (accepted !== null && context.acceptedAtSimMs - accepted.simulationTimeMs < minHoldMs) {
      reject(
        "held",
        context.acceptedAtSimMs,
        `policy is held for ${minHoldMs} simulated ms before replacement`,
        "held",
        context.requestGeneration,
      );
      return;
    }
    const parsed = parseJevPolicy(raw, {
      corridorIds: context.corridorIds,
      regionIds: context.regionIds,
    });
    if (!parsed.ok) {
      reject("malformed", context.acceptedAtSimMs, parsed.error, "malformed", context.requestGeneration);
      return;
    }
    // What this answer COST: counted only for an answer the run actually uses,
    // so the imperfection numbers describe the policy that governed.
    const notes = client?.answerNotes?.() ?? null;
    if (notes !== null) {
      clampedCount += notes.clamped;
      droppedCount += notes.dropped;
    }
    const isFirstPolicy = accepted === null && recorded.length === 0;
    const event: JevTraceEvent = {
      scenarioFingerprint: context.requestFingerprint,
      simulationTimeMs: context.acceptedAtSimMs,
      requestedAtSimMs: context.requestedAtSimMs,
      requestGeneration: context.requestGeneration,
      policy: parsed.value.policy,
      source: context.source,
    };
    // This refresh produced the policy in force: the window that asked for it
    // is live, and what the answer cost rides on the same event.
    telemetry.accept({
      generation: context.requestGeneration,
      settledAtEpochMs: now(),
      clamped: notes?.clamped ?? 0,
      dropped: notes?.dropped ?? 0,
    });
    if (!isFirstPolicy && lastObservedMs !== null && event.simulationTimeMs === lastObservedMs) {
      // Resolved inside the current tick: in force from the next one.
      pending = event;
    } else {
      // Either the run's FIRST policy — which governs from its own instant,
      // whether it was obtained by the startup gate or by a synchronous answer
      // inside the very first observation — or an answer that landed between
      // ticks, which the next observation applies anyway.
      adopt(event);
    }
  };

  const startRequest = (observation: JevRuntimeObservation, nowMs: number): void => {
    if (client === null) {
      return;
    }
    const request: JevPolicyRequest = buildJevPolicyRequest(
      {
        frame: observation.frame,
        partition: observation.partition,
        intersections: observation.intersections,
        activeVehicles: observation.activeVehicles,
      },
      options.request,
    );
    const policyContext = jevPolicyContext(request);
    generation += 1;
    const requestGeneration = generation;
    const requestFingerprint = fingerprint;
    refreshes += 1;
    inFlightGeneration = requestGeneration;
    lastRequestAtSimMs = nowMs;
    // The request is issued now, and the wall-clock service budget is told so
    // BEFORE the client is called: a request that never settles still spent a
    // slot in the measured window, and a scheduler that forgot it would spend
    // that slot twice.
    gate?.issued(now());
    // The new refresh window opens here: its wall-clock instant is recorded for
    // correlating a run with logs, and everything else about it stays simulated.
    telemetry.begin({ atEpochMs: now(), atSimMs: nowMs, generation: requestGeneration });
    /** Release the slot only if this request still owns it. */
    const release = (): void => {
      if (inFlightGeneration === requestGeneration) {
        inFlightGeneration = null;
      }
    };
    const settle = (raw: unknown): void => {
      // The service answered, whatever the run then decides to do with the
      // answer: the budget question is settled, so the backoff (if any) is over.
      gate?.succeeded(now());
      consider(raw, {
        requestGeneration,
        requestFingerprint,
        acceptedAtSimMs: lastObservedMs ?? nowMs,
        requestedAtSimMs: nowMs,
        source: "live",
        corridorIds: policyContext.corridorIds,
        regionIds: policyContext.regionIds,
      });
    };
    try {
      const answer = client.requestPolicy(request);
      if (typeof (answer as { then?: unknown } | null)?.then === "function") {
        (answer as Promise<unknown>)
          .then(settle)
          .catch((error: unknown) => {
            // The budget is told about the failure even when the run is over:
            // the request really was made, and a late refusal is still a
            // refusal the next run must not repeat.
            gate?.failed({
              cause: transportFailure(clientFailureCause(error)),
              retryAfterMs: clientRetryAfterMs(error),
              atEpochMs: now(),
            });
            if (runClosed) {
              return; // the run is over: a late failure cannot change its record
            }
            reject(
              "client-error",
              lastObservedMs ?? nowMs,
              error instanceof Error ? error.message : "jev client failed",
              clientFailureCause(error),
              requestGeneration,
            );
          })
          .finally(release);
      } else {
        settle(answer);
        release();
      }
    } catch (error: unknown) {
      gate?.failed({
        cause: transportFailure(clientFailureCause(error)),
        retryAfterMs: clientRetryAfterMs(error),
        atEpochMs: now(),
      });
      reject(
        "client-error",
        nowMs,
        error instanceof Error ? error.message : "jev client failed",
        clientFailureCause(error),
        requestGeneration,
      );
      release();
    }
  };

  /** The honest outcome of a startup the service schedule will not allow. */
  const unableForServiceBudget = (attempt: number): JevStartUnable => ({
    state: "unable",
    reason: "service-budget",
    // The gate's own sentence says WHICH scheduling fact stands in the way
    // (a spent window, the cadence, a retry-after, a backoff), in this
    // codebase's words — never upstream text, and never a request.
    detail: gate === null ? refreshDetailForCause("service-budget") : gate.waitDetail(),
    // Requests actually made. The attempt that found the schedule closed made
    // none, so a run blocked before its first request reports zero — the same
    // number an unconfigured run reports, and for the same reason.
    attempts: Math.max(0, attempt - 1),
  });

  /**
   * ONE startup attempt: consult the service schedule, WAIT inside the startup
   * bound if a request is not allowed yet, and only then ask for the first
   * policy. Returns the honest `unable` when the bound cannot be met.
   *
   * STARTUP IS NOT AN EXCEPTION TO THE SCHEDULE. The gate guards the UPSTREAM
   * allowance, and the upstream does not care that this is the first request of
   * a new run: a startup that punched through a spent window would spend it
   * twice, get 429s, and cost the NEXT run its budget as well. So a run whose
   * first request is not allowed right now waits — up to
   * `START_RETRY_WAIT_MS`, with no simulated time passing, because the driver
   * does not step an engine that has not started — and if the service cannot
   * allow a request inside that bound the run reports itself unable instead of
   * asking anyway.
   */
  const attemptStart = (
    observation: JevRuntimeObservation,
    attempt: number,
  ): JevStartOutcome | Promise<JevStartOutcome> => {
    // The instant the first policy is accepted at. For a fresh run that is 0 —
    // no simulated time has passed. A controller switched in mid-run has no
    // observation history of its own, so the instant is the engine's own clock,
    // which is where its first policy really starts governing.
    const nowMs = lastObservedMs ?? observation.frame.timeMs;
    // The gate IS an observation of the run: from here on, "now" for this
    // controller is the instant it asked at. Without this, a controller switched
    // in mid-run would evaluate its own policy against t=0 — a moment it never
    // saw — and report a perfectly good policy as expired.
    lastObservedMs = nowMs;
    if (client === null) {
      return {
        state: "unable",
        reason: "unconfigured",
        detail: refreshDetailForCause("unconfigured"),
        attempts: 0,
      };
    }
    // Narrowed once: every path below asks with a real client, and the closures
    // that outlive this call keep the same one.
    const policyClient: JevClient = client;
    if (gate !== null) {
      // ONE decision, read once: consulting the gate is a question with a
      // counter behind it, and asking it twice would count one refusal twice.
      const decision = gate.eligibility();
      if (!decision.ok) {
        if (decision.waitMs > JEV_RUNTIME_DEFAULTS.START_RETRY_WAIT_MS) {
          return unableForServiceBudget(attempt);
        }
        return gate
          .waitUntilEligible({ maxWaitMs: JEV_RUNTIME_DEFAULTS.START_RETRY_WAIT_MS })
          .then((eligible) =>
            eligible
              ? issueStartRequest(observation, attempt, nowMs, policyClient)
              : unableForServiceBudget(attempt),
          );
      }
    }
    return issueStartRequest(observation, attempt, nowMs, policyClient);
  };

  /**
   * The request itself: build it, tell the schedule it was issued, hand it to
   * the client, and resolve what came back. Only ever called when the gate says
   * a request may be made at this instant.
   */
  const issueStartRequest = (
    observation: JevRuntimeObservation,
    attempt: number,
    nowMs: number,
    policyClient: JevClient,
  ): JevStartOutcome | Promise<JevStartOutcome> => {
    const request: JevPolicyRequest = buildJevPolicyRequest(
      {
        frame: observation.frame,
        partition: observation.partition,
        intersections: observation.intersections,
        activeVehicles: observation.activeVehicles,
      },
      options.request,
    );
    const policyContext = jevPolicyContext(request);
    generation += 1;
    const requestGeneration = generation;
    const requestFingerprint = fingerprint;
    refreshes += 1;
    inFlightGeneration = requestGeneration;
    lastRequestAtSimMs = nowMs;
    gate?.issued(now());
    telemetry.begin({ atEpochMs: now(), atSimMs: nowMs, generation: requestGeneration });
    const release = (): void => {
      if (inFlightGeneration === requestGeneration) {
        inFlightGeneration = null;
      }
    };
    /** What the gate says after an answer (or a failure) for this attempt. */
    const outcome = (): JevStartOutcome => {
      if (accepted !== null) {
        return { state: "ready", attempts: attempt };
      }
      const reason = lastCause ?? "first-policy";
      return {
        state: "unable",
        reason,
        detail: refreshDetailForCause(reason),
        attempts: attempt,
      };
    };
    /** Retry while the budget allows; otherwise report the truth. */
    const settleOrRetry = (raw?: unknown, error?: unknown): JevStartOutcome | Promise<JevStartOutcome> => {
      if (raw !== undefined || error === undefined) {
        // The gate's startup request was answered, whatever the run then makes
        // of the answer: the budget question is settled and any backoff a
        // previous attempt left behind is over.
        gate?.succeeded(now());
        consider(raw, {
          requestGeneration,
          requestFingerprint,
          acceptedAtSimMs: nowMs,
          requestedAtSimMs: nowMs,
          source: "live",
          corridorIds: policyContext.corridorIds,
          regionIds: policyContext.regionIds,
        });
      } else {
        // The gate is told the same way a mid-run refresh tells it, so a 5xx at
        // startup backs off exactly like a 5xx later instead of firing the
        // retry into the same outage.
        gate?.failed({
          cause: transportFailure(clientFailureCause(error)),
          retryAfterMs: clientRetryAfterMs(error),
          atEpochMs: now(),
        });
        reject(
          "client-error",
          nowMs,
          error instanceof Error ? error.message : "jev client failed",
          clientFailureCause(error),
          requestGeneration,
        );
      }
      if (accepted === null && attempt < startAttempts) {
        if (gate === null) {
          // No gate: unchanged behaviour, and synchronous for a synchronous
          // client. A deterministic run must not be forced through the event
          // loop to obtain its first policy.
          return attemptStart(observation, attempt + 1);
        }
        // The retry waits the scheduler's own backoff or retry-after rather than
        // firing immediately — a startup retry is still a request, and a burst
        // of two is what the budget exists to prevent. A service that asks for
        // longer than a run can wait is reported as unable to start, not as a
        // run that begins late.
        return gate
          .waitUntilEligible({ maxWaitMs: JEV_RUNTIME_DEFAULTS.START_RETRY_WAIT_MS })
          .then((eligible) =>
            eligible ? attemptStart(observation, attempt + 1) : outcome(),
          );
      }
      return outcome();
    };
    try {
      const answer = policyClient.requestPolicy(request);
      if (isPromiseLike(answer)) {
        return answer
          .then((raw) => settleOrRetry(raw))
          .catch((error: unknown) => settleOrRetry(undefined, error))
          .finally(release);
      }
      const result = settleOrRetry(answer);
      release();
      return result;
    } catch (error: unknown) {
      const result = settleOrRetry(undefined, error);
      release();
      return result;
    }
  };

  return {
    observe(observation) {
      const nowMs = observation.frame.timeMs;

      // Account the simulated time the PREVIOUS interval spent in its source,
      // and — separately — how much of it a policy governed past its freshness
      // window. `heldMs` is a SUBSET of the governed time, never a fourth
      // bucket, so the sources still add up to the observed span.
      if (lastObservedMs !== null) {
        accountInterval(nowMs - lastObservedMs, lastSource, lastHeld);
      }
      lastObservedMs = nowMs;

      // A policy's freshness window passing is counted once per policy, whether
      // or not the run keeps holding it: the model failed to be refreshed in
      // time, and that is a fact about the run.
      if (accepted !== null && nowMs > accepted.simulationTimeMs + ttlMs && expiredFor !== accepted.simulationTimeMs) {
        expiredFor = accepted.simulationTimeMs;
        expiries += 1;
      }

      if (mode === "replay") {
        // Every event whose instant the clock has passed, oldest first. The
        // trace's FIRST event is the recorded run's startup policy, so it is in
        // force from this run's first tick — exactly as it was live.
        while (queue.length > 0) {
          const next = queue[0];
          const due =
            accepted === null && recorded.length === 0
              ? next.simulationTimeMs <= nowMs
              : next.simulationTimeMs < nowMs;
          if (!due) {
            break;
          }
          adopt(queue.shift() as JevTraceEvent);
        }
      } else {
        if (pending !== null && pending.simulationTimeMs < nowMs) {
          adopt(pending);
          pending = null;
        }
        // EVERY due refresh window is recorded, including the ones that could
        // not ask: a window skipped because the previous request was still in
        // flight is exactly where a slow model turns into held time, and a run
        // that never asked at all has to be able to say so rather than showing
        // an empty history.
        if (refreshDue(nowMs, refreshMs)) {
          if (!configured) {
            telemetry.skip({
              atEpochMs: now(),
              atSimMs: nowMs,
              governing: policyInForceAt(nowMs),
              reason: "other",
              detail: "no policy client was configured for this run",
            });
          } else if (acceleratedTail) {
            // The rest of the horizon is simulated back to back: a request
            // issued here could not be answered, and asking anyway is an
            // unpaced burst that gets the run rate-limited. The last accepted
            // policy governs this window, reported as held.
            telemetry.skip({
              atEpochMs: now(),
              atSimMs: nowMs,
              governing: policyInForceAt(nowMs),
              reason: "other",
              detail: "the run's accelerated tail holds the last accepted policy; no refresh was requested",
            });
          } else if (inFlightGeneration !== null) {
            telemetry.skip({
              atEpochMs: now(),
              atSimMs: nowMs,
              governing: policyInForceAt(nowMs),
              reason: "gap",
              detail: "the previous request was still in flight when this refresh was due",
            });
          } else if (lastRequestAtSimMs === nowMs) {
            // The startup gate asked at this exact simulated instant. That IS
            // this refresh window, so nothing is asked again and nothing is
            // recorded twice.
          } else if (gate !== null && !gate.eligibility().ok) {
            // The wall-clock service budget declined this window. This is a
            // SCHEDULING fact, not a failure: no request was made, nothing was
            // substituted, and the policy in force keeps governing. The window
            // is recorded with its own reason so the run can say where the
            // service's cadence — rather than a refusal — cost it freshness.
            telemetry.skip({
              atEpochMs: now(),
              atSimMs: nowMs,
              governing: policyInForceAt(nowMs),
              reason: "gap",
              detail: gate.waitDetail(),
            });
          } else {
            startRequest(observation, nowMs);
          }
        }
      }

      const effective = effectiveAt(nowMs);
      lastSource = effective.source;
      lastHeld = effective.held;
      // Jev LOST: the policy in force outlived its maximum hold. The run is
      // invalidated here — it is never continued under another controller — and
      // the reason travels with the run so a driver can stop it and say why.
      if (effective.source === "invalidated" && invalid === null) {
        invalid = {
          atSimMs: nowMs,
          reason: ungovernedReasonAt(nowMs) ?? "expired",
          governedMs: liveMs + replayMs,
        };
      }
      return effective;
    },

    start(observation) {
      if (startOutcome !== null) {
        return startOutcome; // idempotent: the gate is answered once
      }
      if (mode === "replay") {
        const outcome: JevStartOutcome =
          queue.length > 0
            ? { state: "ready", attempts: 0 }
            : {
                state: "unable",
                reason: "first-policy",
                detail: "the trace carries no policy for this scenario",
                attempts: 0,
              };
        startOutcome = outcome;
        return outcome;
      }
      if (client === null) {
        const outcome: JevStartOutcome = {
          state: "unable",
          reason: "unconfigured",
          detail: refreshDetailForCause("unconfigured"),
          attempts: 0,
        };
        startOutcome = outcome;
        return outcome;
      }
      const result = attemptStart(observation, 1);
      if (isPromiseLike<JevStartOutcome>(result)) {
        return result.then((outcome) => {
          startOutcome = outcome;
          return outcome;
        });
      }
      startOutcome = result;
      return result;
    },

    finish(atSimMs) {
      runClosed = true;
      // The run is over: freeze its own view of the shared gate's counters, so
      // what this result reports about its requests cannot change afterwards.
      serviceFrozen = gate === null ? null : serviceStatusSince(gate.status(), serviceBaseline);
      // Whatever was in flight arrived after the run: it can govern nothing, so
      // its refresh window stays unresolved rather than being guessed.
      inFlightGeneration = null;
      // Close the last interval: the engine steps once past the last
      // observation, and that step's decisions belong to the source in force.
      if (lastObservedMs !== null && atSimMs > lastObservedMs) {
        accountInterval(atSimMs - lastObservedMs, lastSource, lastHeld);
        lastObservedMs = atSimMs;
      }
    },

    beginAcceleratedTail() {
      acceleratedTail = true;
    },

    invalidation() {
      return invalid;
    },

    reset(next) {
      // A reset invalidates everything in flight: its responses are stale by
      // generation, so they can never mutate the new scenario.
      generation += 1;
      fingerprint = next.scenarioFingerprint;
      accepted = null;
      acceptedIsStartup = false;
      pending = null;
      expiredFor = null;
      // A reset frees the slot for the new scenario; whatever was in flight is
      // stale by generation and can no longer clear it (see release()).
      inFlightGeneration = null;
      lastRequestAtSimMs = null;
      lastObservedMs = null;
      lastSource = "waiting";
      lastHeld = false;
      recorded = [];
      queue = [];
      refreshes = 0;
      acceptedCount = 0;
      rejected = 0;
      expiries = 0;
      lastRejection = null;
      lastCause = null;
      causeCounts.clear();
      clampedCount = 0;
      droppedCount = 0;
      liveMs = 0;
      replayMs = 0;
      invalidMs = 0;
      heldMs = 0;
      startOutcome = null;
      invalid = null;
      acceleratedTail = false;
      runClosed = false;
      // A reset is a new run: the per-refresh record starts over with it, and so
      // does this run's own view of the service counters. The SERVICE BUDGET
      // itself is NOT reset — it belongs to the session, not to the run, and the
      // upstream allowance does not come back because a scenario did.
      serviceBaseline = gate === null ? null : gate.status();
      serviceFrozen = null;
      telemetry.reset();

      const trace = next.trace ?? null;
      if (mode === "replay") {
        if (trace === null) {
          reject("stale-fingerprint", 0, "replay mode needs a trace", "superseded");
          return;
        }
        if (trace.scenarioFingerprint !== fingerprint) {
          reject(
            "stale-fingerprint",
            0,
            `trace was recorded for ${trace.scenarioFingerprint}, not ${fingerprint}`,
            "superseded",
          );
          return;
        }
        queue = [...trace.events].sort(compareTraceEvents);
      }
    },

    effective() {
      return effectiveAt(lastObservedMs ?? 0);
    },

    status() {
      const nowMs = lastObservedMs ?? 0;
      const causes: Record<string, number> = {};
      for (const cause of JEV_CAUSES) {
        const count = causeCounts.get(cause);
        if (count !== undefined) {
          causes[cause] = count;
        }
      }
      return {
        mode,
        configured,
        source: effectiveAt(nowMs).source,
        start: startOutcome,
        inFlight: inFlightGeneration !== null,
        requestGeneration: generation,
        refreshes,
        accepted: acceptedCount,
        rejected,
        expiries,
        liveMs,
        replayMs,
        heldMs,
        maxHoldMs,
        invalidMs,
        // HARD ZEROS: this runtime has no Adaptive path to attribute time or
        // ticks to, at any stage of a run (see the module doc). Reported so a
        // finished run can state them rather than leave them implied.
        fallbackMs: 0,
        adaptiveTicks: 0,
        acceptedAtSimMs: accepted?.simulationTimeMs ?? null,
        expiresAtSimMs: accepted === null ? null : accepted.simulationTimeMs + ttlMs,
        invalidation: invalid,
        lastRejection,
        lastCause,
        causes,
        clamped: clampedCount,
        dropped: droppedCount,
        refreshTelemetry: telemetry.summary(),
        // The wall-clock service budget's own account: how many requests THIS
        // RUN issued, what came back, and how far apart the successful ones
        // landed. The counters are the difference from what the shared gate
        // already held when this run was built — frozen once the run is over, so
        // a later run cannot change what this one reports. The capacity fields
        // (window occupancy, the next eligible instant, a pause in force) are
        // the service's current state, because the window is shared. Null for a
        // run with no gate (every deterministic run).
        service:
          gate === null
            ? null
            : serviceFrozen ?? serviceStatusSince(gate.status(), serviceBaseline),
        queuedEvents: queue.length,
      };
    },

    trace() {
      return {
        version: emptyTrace(fingerprint, clientId).version,
        controllerId: emptyTrace(fingerprint, clientId).controllerId,
        client: clientId,
        scenarioFingerprint: fingerprint,
        events: [...recorded].sort(compareTraceEvents),
      };
    },
  };
}
