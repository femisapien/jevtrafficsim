/**
 * Simulation worker (Task 11): owns ALL simulation state — city generation,
 * demand, controller, engine, incidents, stepping, resets and the bounded
 * presentation frames. The main thread only sends commands and renders.
 *
 * Pacing: a recursive setTimeout chain, ONE fixed simulation step per
 * scheduled iteration. Browser timing APIs are used ONLY to pace execution;
 * no wall-clock value ever enters simulation state or policy. If a tick takes
 * longer than the real-time budget, the run simply advances slower than wall
 * time — ticks are never queued in an unbounded catch-up spiral.
 *
 * Cadence: one presentation frame and one metrics sample per real tick, so the
 * renderer can interpolate between consecutive frames over SIM_TICK_MS.
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { createJevController } from "@/controllers/jev";
import type { TrafficController } from "@/controllers/contract";
import { createRelayJevClient, JEV_RELAY_TIMEOUT_MS } from "@/jev/client";
import { sessionJevServiceGate } from "@/jev/service-budget";
import { CHICAGO_SCALE_LABELS } from "@/cities/chicago";
import { METRO_SCALE_INDEX } from "@/cities/chicago-trips";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  buildChallengeScenario,
  scenarioFingerprint,
  type ChallengeScenario,
} from "@/worker/challenge-scenario";
import { buildChallengeResult } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import type {
  JevCause,
  JevInvalidation,
  JevRuntimeObservation,
  JevStartOutcome,
} from "@/jev/runtime";
import type { JevRefreshTelemetry } from "@/jev/telemetry";
import { fingerprintForRun } from "@/worker/challenge-scenario";
import {
  controllerObservation,
  finishRunController,
  runComparison,
} from "@/worker/challenge-compare";
import type { MaterializedCuratedTrip } from "@/cities/chicago-trips";
import { loadChicagoCity } from "@/cities/chicago-assets";
import type { MapModel } from "@/cities/map-model";
import { productionDemand } from "@/sim/demand-profile";
import { TRAFFIC_LEVELS } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import {
  createEngine,
  queueIncident,
  setEngineController,
  injectSpawns,
  stepEngine,
  type EngineState,
  type ScheduledSpawn,
} from "@/sim/engine";
import {
  buildPresentationMetrics,
  buildPresentationSnapshot,
} from "./presentation-snapshot";
import {
  buildChallengeIncidentPlan,
  challengeIncidentFingerprintInput,
  incidentCapabilities,
  resolveManualChallengeIncident,
  type ChallengeIncidentPlan,
  type ManualChallengeIncidentInput,
  type ResolvedChallengeIncident,
} from "./challenge-incidents";
import { vehicleById } from "@/sim/traffic";
import {
  LIVE_RUN_HORIZON_MS,
  nextSeed,
  parseWorkerCommand,
  PLAYBACK_STEPS_PER_TICK,
  SIM_TICK_MS,
  SKIP_STEPS_PER_TICK,
  type ControllerChoice,
  type PlaybackSpeed,
  type RunConfig,
  type WorkerCommand,
  type WorkerEvent,
} from "./protocol";

/** Minimal worker scope shape: no webworker lib juggling required. */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;

interface WorkerState {
  config: RunConfig | null;
  engine: EngineState | null;
  /** The curated trip this run materialised; null before the first build. */
  trip: MaterializedCuratedTrip | null;
  scaleIndex: number;
  incidentSeed: number;
  running: boolean;
  complete: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  snapshotSequence: number;
  /** Active frozen Chicago presentation model; needed for route-relevant manual targeting. */
  model: MapModel | null;
  /** Controller-neutral automatic challenge plan resolved before the engine starts. */
  incidentPlan: ChallengeIncidentPlan | null;
  /** Exact automatic + manual resolved entries, ready for Issue #28 replay. */
  incidentHistory: ResolvedChallengeIncident[];
  /** Stable sequence for manual resolution streams. */
  manualIncidentSequence: number;
  /** The controller-neutral scenario this run realises (issue #28). */
  scenario: ChallengeScenario | null;
  /** Human-fired incidents during this run; > 0 makes the result non-comparable. */
  manualIncidents: number;
  /** A live command changed the scenario mid-run (see ChallengeResult.modified). */
  modified: boolean;
  /** Guards against overlapping async builds (fast scale switching). */
  buildToken: number;
  /**
   * Jev was LOST during this run (Issue #61): the run stopped with its
   * measurements kept and may not be resumed — only a new run may start.
   */
  invalidated: boolean;
  /**
   * How fast this run is being WATCHED (final polish pass): a multiplier over
   * PLAYBACK_STEPS_PER_TICK — the engine steps one real tick runs. A view
   * setting, so it survives a rebuild the way the scale does: the same run
   * watched 3× faster runs the same steps, in the same order, and produces the
   * same result.
   */
  speed: PlaybackSpeed;
  /**
   * "Skip to end" was asked for and is being honoured (final polish pass): the
   * run is being advanced at SKIP_STEPS_PER_TICK until its horizon, then it
   * completes through the ONE completion sequence. Sticky for the rest of THIS
   * run — a skip is a decision about the run, not a mode — and cleared by the
   * next build, so it can never finish a run nobody asked about.
   */
  skipToEnd: boolean;
  /**
   * A policy controller is waiting for its FIRST policy (the startup gate): no
   * simulated time is passing, so there is nothing to skip and nothing to watch
   * faster. It is what tells a paused run (which CAN be skipped — skipping ends
   * it) from one that has not started at all.
   */
  awaitingPolicy: boolean;
}

const state: WorkerState = {
  config: null,
  engine: null,
  trip: null,
  scaleIndex: 2,
  incidentSeed: 0,
  running: false,
  complete: false,
  timer: null,
  snapshotSequence: 0,
  model: null,
  incidentPlan: null,
  incidentHistory: [],
  manualIncidentSequence: 0,
  scenario: null,
  manualIncidents: 0,
  modified: false,
  buildToken: 0,
  invalidated: false,
  speed: 1,
  skipToEnd: false,
  awaitingPolicy: false,
};

function post(event: WorkerEvent): void {
  scope.postMessage(event);
}

function makeController(choice: ControllerChoice, identity: string) {
  if (choice === "jev") {
    // Browser path: the relay client asks our own route, which is the only
    // place the service credential lives. Nothing secret reaches this worker.
    //
    // The service gate is the wall-clock half of the refresh schedule
    // (jev/scheduler.ts): the upstream allowance is 5 requests per ~60 s window
    // and the app's old cadence asked for ~24/minute, which is what turned two
    // thirds of a production run's refreshes into 429s and invalidated the run
    // when no fresh policy arrived in time. The gate spends 4 of those 5
    // requests, evenly, and honours a `retry-after` our relay forwards.
    //
    // It is the SESSION's gate (jev/service-budget.ts), NOT a new one per
    // controller: the allowance belongs to the credential our relay holds, so a
    // rebuilt controller — a reset, a new scenario, the next run — must inherit
    // the window the previous run spent rather than start from an empty one.
    // One gate per run is what produced "run A spends the window, run B asks
    // anyway, 429s return"; one gate per session is what makes the second run
    // wait for the budget the first one really used.
    return createJevController({
      client: createRelayJevClient({ timeoutMs: JEV_RELAY_TIMEOUT_MS }),
      scenarioFingerprint: identity,
      serviceGate: sessionJevServiceGate(),
    });
  }
  return choice === "adaptive" ? createAdaptiveController() : createFixedController();
}

/**
 * The run-control seam a Jev controller exposes to its DRIVER (Issue #61): the
 * startup gate, the accelerated tail, the run's end, and the invalidation it
 * reports when Jev is lost. Read structurally, so a Fixed or Adaptive run simply
 * has none of it.
 */
interface JevRunControl {
  start(observation: JevRuntimeObservation): JevStartOutcome | Promise<JevStartOutcome>;
  finish(atSimMs: number): void;
  beginAcceleratedTail(): void;
  invalidation(): JevInvalidation | null;
}

/** The Jev run-control seam of the engine's current controller, or null. */
function jevRunControl(engine: EngineState | null): JevRunControl | null {
  const controller = engine?.controller as (TrafficController & Partial<JevRunControl>) | undefined;
  if (!controller || controller.id !== "jev" || typeof controller.invalidation !== "function") {
    return null;
  }
  return controller as TrafficController & JevRunControl;
}

/**
 * Who is really deciding the signals right now.
 *
 * A policy controller knows how much of the run its own policy governed, how
 * much of that was an opinion past its freshness window, and how much time NO
 * Jev policy governed at all. That distinction is the product's, not an
 * implementation detail: a run that did not control its own simulated time may
 * never be presented as pure live Jev. Controllers without an external policy
 * (Fixed, Adaptive) report nothing.
 */
function policyProvenance(): PresentationPolicy | null {
  const controller = state.engine?.controller as
    | {
        meta?: () => PresentationPolicy & {
          kind?: string;
          /** Why Jev is not governing (or did not start): a classified cause. */
          cause?: JevCause | null;
        };
      }
    | undefined;
  if (!controller || typeof controller.meta !== "function") {
    return null;
  }
  try {
    const meta = controller.meta();
    return {
      source: meta.source,
      liveMs: meta.liveMs,
      replayMs: meta.replayMs,
      fallbackMs: meta.fallbackMs,
      // The halves of "the policy governed it": how much of that time was an
      // opinion past its freshness window, how much time nothing governed at
      // all, and what each answer cost. They ride every frame so the label can
      // say what actually happened.
      heldMs: meta.heldMs,
      invalidMs: meta.invalidMs,
      maxHoldMs: meta.maxHoldMs,
      adaptiveTicks: meta.adaptiveTicks,
      accepted: meta.accepted,
      rejected: meta.rejected,
      refreshes: meta.refreshes,
      // `cause` names WHY Jev is not governing, or why it never started: the
      // classified cause, never a bare statement that something went wrong.
      cause: meta.cause ?? null,
      causes: meta.causes,
      clamped: meta.clamped,
      dropped: meta.dropped,
      invalidation: meta.invalidation ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The run's per-refresh record (jev/telemetry.ts): which refresh window went
 * live, was held, or needed the safety net — and why, in a closed vocabulary.
 *
 * Reported BOUNDED: the counters plus at most `JEV_REFRESH_EVENT_BOUND` events,
 * every string of which this codebase wrote. It rides the worker's own messages
 * and is never rendered: the main thread copies it into a `?debug` hook, so no
 * reason vocabulary, policy field or bound can reach a public surface.
 */
function policyTelemetry(): JevRefreshTelemetry | null {
  const controller = state.engine?.controller as
    | { meta?: () => { telemetry?: JevRefreshTelemetry | null } }
    | undefined;
  if (!controller || typeof controller.meta !== "function") {
    return null;
  }
  try {
    return controller.meta().telemetry ?? null;
  } catch {
    return null;
  }
}

/**
 * The input a manual incident click would use RIGHT NOW (Issue #39). Kept in one
 * place so the instrument's availability probe and the click itself cannot
 * drift apart — the probe is literally the same question.
 */
function manualIncidentInput(
  kind: IncidentKind,
  sequence: number,
): ManualChallengeIncidentInput | null {
  const engine = state.engine;
  const model = state.model;
  if (!engine || !model) {
    return null;
  }
  const ego =
    engine.egoVehicleId === null
      ? null
      : vehicleById(engine.traffic, engine.egoVehicleId);
  if (!ego) {
    return null;
  }
  return {
    model,
    city: engine.city,
    kind,
    atMs: engine.traffic.timeMs,
    seed: state.incidentSeed,
    sequence,
    routeRoadIds: ego.route,
    routeIndex: ego.routeIndex,
    egoRoadId: ego.roadId,
    destinationIntersectionId: ego.destination,
  };
}

/**
 * Tell the UI which instruments can do anything in THIS world (Issue #39), so an
 * unusable button is disabled with the reason shown instead of looking live and
 * answering "not available" after a click. Re-posted whenever the world's
 * capacity for chaos can have changed: a new run, or a queued incident.
 */
function postIncidentCapabilities(): void {
  const probe = manualIncidentInput("crash", state.manualIncidentSequence);
  if (probe === null) {
    return;
  }
  const probeContext: Omit<ManualChallengeIncidentInput, "kind"> = {
    model: probe.model,
    city: probe.city,
    atMs: probe.atMs,
    seed: probe.seed,
    sequence: probe.sequence,
    routeRoadIds: probe.routeRoadIds,
    routeIndex: probe.routeIndex,
    egoRoadId: probe.egoRoadId,
    destinationIntersectionId: probe.destinationIntersectionId,
  };
  const engine = state.engine;
  if (engine) {
    capabilitySignature = engine.incidents.records
      .map((record) => `${record.id}:${record.kind}:${record.status}`)
      .join("|");
  }
  post({ type: "INCIDENT_CAPABILITIES", capabilities: incidentCapabilities(probeContext) });
}

/** Signature of the incident set the last capability probe was taken against. */
let capabilitySignature: string | null = null;

/**
 * Re-probe only when the world's incident set actually changed.
 *
 * Cost matters here: one full probe measures ~86 ms on the Metro model (five
 * resolver calls, and the closure kinds run a reachability check), against
 * ~0.6 ms for a simulation tick. Running it every tick would spend the whole
 * frame budget, so it runs when the answer can have changed and not otherwise.
 */
function refreshIncidentCapabilitiesIfStale(): void {
  const engine = state.engine;
  if (!engine) {
    return;
  }
  const signature = engine.incidents.records
    .map((record) => `${record.id}:${record.kind}:${record.status}`)
    .join("|");
  if (signature === capabilitySignature) {
    return;
  }
  capabilitySignature = signature;
  postIncidentCapabilities();
}

function postSnapshot(): void {
  if (!state.engine) {
    return;
  }
  post({
    type: "SNAPSHOT",
    snapshot: buildPresentationSnapshot(
      state.engine,
      state.snapshotSequence,
      state.config?.tripId ?? null,
      policyProvenance(),
      { modified: state.modified, manualIncidents: state.manualIncidents },
    ),
  });
  state.snapshotSequence += 1;
}

/**
 * The authoritative trip completion: the ego car has reached its destination.
 *
 * This is the fact every frame already carries (`trip.completed`) and the one
 * the arrival is built from — never the horizon, which is the experiment's
 * length, not the trip's.
 */
function egoArrived(engine: EngineState): boolean {
  return (
    engine.egoVehicleId !== null &&
    vehicleById(engine.traffic, engine.egoVehicleId)?.state === "arrived"
  );
}

/**
 * Simulate the remainder of the horizon with no pacing.
 *
 * The paced loop exists so a person can WATCH the city. Once the ego has
 * arrived there is nothing left to watch: the rest of the horizon exists only
 * so the visible run covers the same simulated window as its headless baselines
 * (the comparison is only honest when all three runs describe the same one), and
 * the engine never reads the wall clock — pacing only decides WHEN a step runs,
 * never what it produces.
 *
 * Measured on the curated Chicago trips, the ego arrives 152-202 s of simulated
 * time before the 600 s horizon, and the 8× paced loop turned that tail into
 * 19-26 s of wall clock with the car already parked: that was the delay between
 * the arrival and the result. Running those steps back to back produces
 * byte-identical engine state — same steps, same order, same result, same
 * comparison — so only the delay is deleted.
 *
 * "Skip to end" (final polish pass) is the OTHER way a run's end arrives, and it
 * deliberately does not come through here: a skip advances the paced loop at a
 * coverage-safe pace instead (see SKIP_STEPS_PER_TICK), because a stretch longer
 * than one policy's maximum hold cannot be simulated back to back without
 * outrunning the service that governs it. This tail therefore stays what it
 * always was — the arrival's — and stays the only unpaced stretch in the app.
 */
function finishHorizon(engine: EngineState, untilMs: number, control: JevRunControl | null): void {
  while (engine.traffic.timeMs < untilMs) {
    stepEngine(engine);
    // Jev LOST mid-tail: stop immediately. The run is invalidated, and running
    // the rest of the horizon without a policy would be exactly the silent
    // substitution this contract forbids.
    if (control !== null && control.invalidation() !== null) {
      return;
    }
  }
}

function postMetrics(): void {
  if (!state.engine) {
    return;
  }
  post({ type: "METRICS", metrics: buildPresentationMetrics(state.engine) });
  // The automatic script closes roads on its own schedule, so an instrument's
  // availability can change without any click. The signature check is free; the
  // probe itself only runs when the incident set actually moved.
  refreshIncidentCapabilitiesIfStale();
}

function clearTimer(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * Full (re)build from a run config: fresh city, demand, engine, render model.
 *
 * The browser demo runs the frozen Chicago showcase geography (committed
 * artifacts, fetched from the same origin). The procedural generator stays
 * untouched for tests and the headless benchmark (Task 12).
 */
async function buildRun(config: RunConfig): Promise<void> {
  clearTimer();
  state.running = false;
  state.complete = false;
  // The curated challenge IS a trip across real Chicago, and the trips are
  // defined against the Metro graph: every run loads Metro.
  const scaleIndex = METRO_SCALE_INDEX;
  const buildToken = (state.buildToken += 1);
  let model: MapModel;
  try {
    model = await loadChicagoCity(scaleIndex);
  } catch (error) {
    post({
      type: "ERROR",
      message: `failed to load the Chicago map data: ${String((error as Error)?.message ?? error)}`,
    });
    return;
  }
  if (buildToken !== state.buildToken) {
    return; // a newer build superseded this one
  }
  const city = model.city;
  // Background demand is exactly what it always was: the whole city stays alive.
  const background = productionDemand({
    city,
    level: config.trafficLevel,
    seed: config.seed,
    durationMs: config.durationMs,
  });
  // The selected curated trip becomes ONE ordinary car at t=0. Materialisation
  // resolves the trip's anchors to graph nodes through the Issue #23 contract;
  // the vehicle's own route is still A*'s, computed at spawn like everyone
  // else's, so presentation identity never buys it a different road.
  let challenge;
  try {
    challenge = materializeChallengeTrip(model, config.tripId, config.seed);
  } catch (error) {
    post({
      type: "ERROR",
      message: `curated trip ${config.tripId} unavailable: ${String((error as Error)?.message ?? error)}`,
    });
    return;
  }
  const trip = challenge.trip;
  const spawns: ScheduledSpawn[] = [challenge.spawn, ...background];

  // Resolve the ENTIRE automatic challenge before a controller executes.
  // The planner sees only frozen geography + canonical trip + traffic + seed,
  // so Fixed/Adaptive/Jev receive byte-identical adversity.
  const incidentPlan = buildChallengeIncidentPlan(
    model,
    trip,
    config.trafficLevel,
    config.seed,
  );
  // The scenario is everything about the WORLD: trip, traffic, driver, seed,
  // duration. Controller identity is deliberately absent from it.
  const scenario = buildChallengeScenario({
    tripId: config.tripId,
    trafficLevel: config.trafficLevel,
    driver: config.driver,
    seed: config.seed,
    durationMs: config.durationMs,
  });
  const engine = createEngine({
    city,
    // Bound to the real identity of the scenario built just above.
    controller: makeController(config.controller, fingerprintForRun(config)),
    spawns,
    driver: config.driver,
    incidents: {
      seed: incidentPlan.incidentSeed,
      script: [...incidentPlan.entries],
    },
  });
  state.scenario = scenario;
  state.manualIncidents = 0;
  state.modified = false;
  state.config = config;
  state.engine = engine;
  state.trip = trip;
  state.model = model;
  state.scaleIndex = scaleIndex;
  state.incidentSeed = incidentPlan.incidentSeed;
  state.incidentPlan = incidentPlan;
  state.incidentHistory = incidentPlan.entries.map((entry, id) => ({
    id,
    source: "automatic" as const,
    entry,
  }));
  state.manualIncidentSequence = 0;
  state.snapshotSequence = 0;
  state.invalidated = false;
  // A skip asked for on the way out of the previous run must not finish this
  // new one; the SPEED is a viewing preference and survives the rebuild.
  state.skipToEnd = false;
  state.awaitingPolicy = false;
  capabilitySignature = null;
  postIncidentCapabilities();
  post({
    type: "READY",
    config,
    scenarioFingerprint: scenarioFingerprint(
      state.scenario ??
        buildChallengeScenario({
          tripId: config.tripId,
          trafficLevel: config.trafficLevel,
          driver: config.driver,
          seed: config.seed,
          durationMs: config.durationMs,
        }),
    ),
    scaleIndex,
    scaleLabel: CHICAGO_SCALE_LABELS[scaleIndex] ?? "Medium",
    timeMs: engine.traffic.timeMs,
    incidentSeed: incidentPlan.incidentSeed,
    incidentPlan,
    incidentHistory: state.incidentHistory.map((incident) => ({
      ...incident,
      entry: { ...incident.entry },
    })),
    incidentFingerprint: challengeIncidentFingerprintInput(
      incidentPlan,
      state.incidentHistory,
    ),
  });
  postSnapshot();
  postMetrics();
  // Initial state: automatically running (documented behaviour) — but a Jev run
  // first has to pass the startup gate, which may take a moment and may fail.
  await beginRun(buildToken);
}

/**
 * Schedule the next real tick on a FIXED cadence.
 *
 * `setTimeout(runTick, SIM_TICK_MS)` after the work makes every period
 * SIM_TICK_MS + the cost of the tick itself — measured ~125 ms per 800 ms of
 * simulated time on the Metro run, so the designed 8x playback arrived at
 * 6.0-6.4x. Subtracting the tick's own cost holds the period at SIM_TICK_MS
 * whenever the tick fits inside it, and runs back to back (no artificial delay)
 * when it does not. Scheduling only: the engine's steps — and therefore every
 * simulated result — are untouched.
 */
function scheduleNextTick(tickCostMs = 0): void {
  state.timer = setTimeout(runTick, Math.max(0, SIM_TICK_MS - tickCostMs));
}

function start(): void {
  if (!state.engine || state.running || state.complete || state.invalidated) {
    return;
  }
  state.running = true;
  scheduleNextTick();
}

/**
 * THE STARTUP GATE (Issue #61), for a run that has just been built.
 *
 * A live Jev run does not advance a single simulated millisecond until its first
 * policy is accepted: the wait is announced (so the UI can say what it is waiting
 * for), and when no policy can be obtained the run does not start AT ALL — the
 * reason travels to the UI and nothing is substituted for Jev.
 */
async function beginRun(buildToken: number): Promise<void> {
  const engine = state.engine;
  if (engine === null) {
    return;
  }
  const control = jevRunControl(engine);
  if (control !== null) {
    post({ type: "JEV_STARTING", resuming: false });
    // No simulated time passes while this gate is open, so a skip asked for now
    // has nothing to finish: it is refused, not deferred into a fabricated run.
    state.awaitingPolicy = true;
    const started = await control.start(controllerObservation(engine));
    state.awaitingPolicy = false;
    if (buildToken !== state.buildToken) {
      return; // a newer build superseded this run
    }
    if (started.state === "unable") {
      state.running = false;
      post({
        type: "JEV_UNABLE",
        reason: started.reason,
        detail: started.detail,
        attempts: started.attempts,
      });
      return;
    }
    post({ type: "JEV_READY" });
  }
  start();
}

/**
 * Stop a run whose Jev policy was LOST, honestly.
 *
 * The measurements collected so far are kept and published, the truthful reason
 * is reported, and no normal completion is produced: this run is NOT a Jev
 * result and must never be shown as one. Nothing takes Jev's place.
 */
function stopInvalidated(engine: EngineState, config: RunConfig, invalidation: JevInvalidation): void {
  state.running = false;
  state.invalidated = true;
  clearTimer();
  finishRunController(engine);
  postSnapshot();
  postMetrics();
  post({
    type: "RUN_INVALIDATED",
    timeMs: engine.traffic.timeMs,
    invalidation: { atSimMs: invalidation.atSimMs, reason: invalidation.reason },
    result: buildChallengeResult(
      engine,
      state.scenario ?? fallbackScenario(config),
      config.controller,
      state.manualIncidents,
      true,
    ),
    policy: policyProvenance(),
    telemetry: policyTelemetry(),
  });
}

/** The scenario a config describes, rebuilt only if the run never stored one. */
function fallbackScenario(config: RunConfig): ChallengeScenario {
  return buildChallengeScenario({
    tripId: config.tripId,
    trafficLevel: config.trafficLevel,
    driver: config.driver,
    seed: config.seed,
    durationMs: config.durationMs,
  });
}

/**
 * A mid-run switch TO a policy controller waits for that controller's first
 * policy, exactly as a fresh run does. Stepping on without one would be the
 * silent substitution this contract forbids, so the run pauses instead — and if
 * the policy cannot be obtained, the run does not continue.
 */
async function gateSwitchedController(engine: EngineState): Promise<void> {
  const control = jevRunControl(engine);
  if (control === null) {
    return;
  }
  const wasRunning = state.running;
  state.running = false;
  clearTimer();
  post({ type: "JEV_STARTING", resuming: true });
  state.awaitingPolicy = true;
  const started = await control.start(controllerObservation(engine));
  state.awaitingPolicy = false;
  if (state.engine !== engine || state.invalidated) {
    return; // superseded by a newer build, or the run was stopped meanwhile
  }
  if (started.state === "unable") {
    post({
      type: "JEV_UNABLE",
      reason: started.reason,
      detail: started.detail,
      attempts: started.attempts,
    });
    return;
  }
  post({ type: "JEV_READY" });
  if (wasRunning) {
    start();
  }
}

function pause(): void {
  state.running = false;
  clearTimer();
  postSnapshot(); // freeze frame + final metrics for the paused state
  postMetrics();
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.running = false;
  clearTimer();
  // Developer detail in the worker console; the UI gets the message only.
  console.error("[simulation-worker]", error);
  post({ type: "ERROR", message });
}

function runTick(): void {
  state.timer = null;
  const startedAt = performance.now();
  const engine = state.engine;
  const config = state.config;
  if (!engine || !config || !state.running) {
    return;
  }
  try {
    /*
     * How many engine steps this tick runs.
     *
     * "Skip to end" advances the run at SKIP_STEPS_PER_TICK — the fastest pace
     * the run's own policy coverage allows, and not one step faster, because a
     * skipped run still has to be an honest Jev run (see the constant). The
     * run keeps the PACED loop, the same refresh grid and the same wall-clock
     * service budget: the skipped stretch is simulated by exactly the steps a
     * watched run takes, it still asks for a policy whenever the schedule and
     * the gate allow one, and it reports the time it spent on a HELD policy.
     * That is what lets a skip finish a run (and hand over its payoff) instead
     * of outrunning the model into an invalidation. 3× just multiplies the
     * normal playback; nothing else changes.
     */
    const watchedSteps = PLAYBACK_STEPS_PER_TICK * state.speed;
    const stepsPerTick = state.skipToEnd
      ? Math.max(SKIP_STEPS_PER_TICK, watchedSteps)
      : watchedSteps;
    for (let step = 0; step < stepsPerTick; step += 1) {
      stepEngine(engine);
      if (engine.traffic.timeMs >= config.durationMs) {
        break;
      }
    }
    if (!state.skipToEnd && engine.traffic.timeMs < config.durationMs && egoArrived(engine)) {
      // The trip is over. Publish the arrival frame FIRST — the UI must see the
      // car arrived before this thread turns to the tail — then simulate the
      // rest of the horizon back to back instead of pacing it out in real time.
      postSnapshot();
      postMetrics();
      const control = jevRunControl(engine);
      // The tail never turns the event loop, so a refresh requested during it
      // could not be answered — asking anyway is an unpaced burst of doomed
      // requests (measured: `rate-limited x18`). The LAST ACCEPTED policy
      // governs the tail instead, reported as HELD, which is still Jev control
      // and never a gap.
      control?.beginAcceleratedTail();
      finishHorizon(engine, config.durationMs, control);
    }
  } catch (error) {
    handleError(error);
    return;
  }
  // Jev LOST (Issue #61): stop here, keep the measurements, say why. There is
  // no substitution — the run is invalidated, not continued under anything else.
  const invalidation = jevRunControl(engine)?.invalidation() ?? null;
  if (invalidation !== null) {
    stopInvalidated(engine, config, invalidation);
    return;
  }
  // ONE frame per real tick, never one per simulated step. The renderer
  // interpolates between consecutive frames over EXPECTED_FRAME_INTERVAL_MS,
  // so the cadence has to be the real tick — posting per step floods the buffer
  // and makes the interpolation window a fraction of the frame interval, which
  // is exactly what made the car stutter.
  postSnapshot();
  postMetrics();
  if (engine.traffic.timeMs >= config.durationMs) {
    state.running = false;
    state.complete = true;
    // The run's simulated time is over: close its accounting at the final
    // instant, so the numbers the result carries cover the whole window and an
    // answer that arrives later can never be counted as a governing policy.
    finishRunController(engine);
    postSnapshot();
    postMetrics();
    post({
      type: "RUN_COMPLETE",
      timeMs: engine.traffic.timeMs,
      policy: policyProvenance(),
      telemetry: policyTelemetry(),
      result: buildChallengeResult(
        engine,
        state.scenario ?? fallbackScenario(config),
        config.controller,
        state.manualIncidents,
        state.modified,
      ),
    });
    return;
  }
  scheduleNextTick(performance.now() - startedAt);
}

function handleCommand(command: WorkerCommand): void {
  switch (command.type) {
    case "INIT": {
      buildRun({
        citySize: command.citySize,
        trafficLevel: command.trafficLevel,
        tripId: command.tripId,
        controller: command.controller,
        driver: command.driver,
        seed: command.seed,
        durationMs: command.durationMs ?? LIVE_RUN_HORIZON_MS,
      });
      return;
    }
    case "START": {
      if (!state.engine) {
        post({ type: "ERROR", message: "cannot START before INIT" });
        return;
      }
      start();
      return;
    }
    case "PAUSE": {
      pause();
      return;
    }
    case "SKIP_TO_END": {
      if (!state.engine || !state.config || state.complete || state.invalidated) {
        return; // nothing in flight to finish
      }
      if (state.awaitingPolicy) {
        // The startup gate is open: not one simulated millisecond has passed, so
        // there is nothing to skip. The run either starts (and can then be
        // skipped) or reports why it could not.
        return;
      }
      // The run is advanced to its horizon at SKIP_STEPS_PER_TICK through the
      // ordinary paced loop, so the skipped stretch still asks on the run's own
      // refresh schedule and still obeys the wall-clock service budget: the run
      // can therefore COMPLETE (with its payoff) rather than outrun the model
      // and be invalidated. A paused run is finished too: skipping IS the request
      // to end this run, so the clock resumes for it.
      state.skipToEnd = true;
      if (!state.running) {
        start();
      }
      return;
    }
    case "SET_SPEED": {
      // Pacing, and only pacing: the engine reads no wall clock, so the same run
      // watched 3× faster runs the same steps in the same order. Nothing about
      // the world, the scenario or the service budget changes here — the budget
      // is wall-clock paced and will legitimately hold more of a 3× run.
      state.speed = command.speed;
      return;
    }
    case "RESET": {
      if (!state.config) {
        post({ type: "ERROR", message: "cannot RESET before INIT" });
        return;
      }
      const seed = command.mode === "new-seed" ? nextSeed(state.config.seed) : state.config.seed;
      buildRun({ ...state.config, seed });
      return;
    }
    case "SET_CONTROLLER": {
      if (!state.engine || !state.config) {
        post({ type: "ERROR", message: "cannot SET_CONTROLLER before INIT" });
        return;
      }
      if (state.invalidated) {
        // A run that lost Jev was stopped with its measurements kept. Continuing
        // it under another controller would be exactly the substitution the
        // execution contract forbids: a new run is the honest way forward.
        post({
          type: "ERROR",
          message: "this run lost Jev and was stopped — start a new run instead of switching controllers",
        });
        return;
      }
      // In-place switch: traffic, incidents, metrics, seed and simulation time
      // are untouched; policy changes from the next tick. Switching controller
      // mid-run must not change the scenario identity: the new Jev controller is
      // bound to the run that is already in progress.
      const runningConfig = state.config;
      const engine = state.engine;
      // Half the run under one controller and half under another is not a run
      // of either: the result stays visible but is marked non-comparable.
      state.modified = true;
      setEngineController(
        engine,
        makeController(command.controller, fingerprintForRun(runningConfig)),
      );
      state.config = { ...runningConfig, controller: command.controller };
      postSnapshot(); // controller id visible immediately
      // Switching TO Jev mid-run passes the SAME gate as starting one: the run
      // waits for the first policy instead of stepping without one.
      void gateSwitchedController(engine);
      return;
    }
    case "COMPARE": {
      // Headless: one scenario, two controllers, both results. Never touches
      // the live run's state — a comparison cannot disturb the city on screen.
      const model = state.model;
      if (!model) {
        post({ type: "ERROR", message: "cannot COMPARE before the city is loaded" });
        return;
      }
      try {
        const outcome = runComparison(model, {
          tripId: command.tripId,
          trafficLevel: command.trafficLevel,
          driver: command.driver,
          seed: command.seed,
          durationMs: command.durationMs ?? LIVE_RUN_HORIZON_MS,
        });
        post({
          type: "COMPARE_RESULT",
          fingerprint: outcome.fingerprint,
          driver: outcome.driver,
          tripId: outcome.tripId,
          trafficLevel: outcome.trafficLevel,
          fixed: outcome.fixed,
          adaptive: outcome.adaptive,
          verdict: outcome.verdict,
          incidentEntries: outcome.incidentEntries,
        });
      } catch (error) {
        post({ type: "ERROR", message: `comparison failed: ${String((error as Error)?.message ?? error)}` });
      }
      return;
    }
    case "SET_TRAFFIC": {
      const engine = state.engine;
      const config = state.config;
      if (!engine || !config || config.trafficLevel === command.trafficLevel) {
        break;
      }
      // Live change: the run, its clock, its trip and the ego stay exactly as
      // they are. Only NEW demand appears, generated for the new level over the
      // remaining horizon with a seed derived from (run seed, new level, now) —
      // so the same change at the same simulated time always adds the same cars.
      const nowMs = engine.traffic.timeMs;
      const horizonMs = Math.max(0, config.durationMs - nowMs);
      if (horizonMs > 0) {
        const levelIndex = Math.max(0, TRAFFIC_LEVELS.indexOf(command.trafficLevel));
        const derivedSeed = (config.seed + 0x9e37 + levelIndex * 7919 + Math.floor(nowMs / 1000)) >>> 0;
        const extra = productionDemand({
          city: engine.baseCity,
          level: command.trafficLevel,
          seed: derivedSeed,
          durationMs: horizonMs,
        })
          .filter((spawn) => spawn.timeMs > 0)
          .map((spawn) => ({ ...spawn, timeMs: spawn.timeMs + nowMs }));
        injectSpawns(engine, extra);
      }
      state.config = { ...config, trafficLevel: command.trafficLevel };
      // The scenario this run started as is no longer the scenario it is
      // playing, so its outcome cannot sit beside a clean baseline run.
      state.modified = true;
      postSnapshot();
      break;
    }
    case "INCIDENT": {
      const engine = state.engine;
      const model = state.model;
      const plan = state.incidentPlan;
      if (!engine || !model || !plan) {
        post({ type: "ERROR", message: "cannot INCIDENT before INIT" });
        return;
      }

      if (manualIncidentInput(command.kind, state.manualIncidentSequence) === null) {
        post({
          type: "INCIDENT_RESOLVED",
          kind: command.kind,
          queued: false,
          label: "Trip vehicle is not ready yet",
          incident: null,
          incidentHistory: state.incidentHistory.map((incident) => ({
            ...incident,
            entry: { ...incident.entry },
          })),
          incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
        });
        return;
      }

      // Manual chaos is allowed to follow the LIVE route because the human
      // asked for adversity in this exact run. Crucially, we immediately record
      // the concrete target + simulation timestamp so Issue #28 can replay this
      // exact click under another controller.
      // The exact input the applicability probe asked about: same helper, so
      // what the dock showed is what the click does.
      const resolution = resolveManualChallengeIncident(
        manualIncidentInput(command.kind, state.manualIncidentSequence) as ManualChallengeIncidentInput,
      );
      state.manualIncidentSequence += 1;

      if (!resolution.entry) {
        post({
          type: "INCIDENT_RESOLVED",
          kind: command.kind,
          queued: false,
          label: resolution.label,
          incident: null,
          incidentHistory: state.incidentHistory.map((incident) => ({
            ...incident,
            entry: { ...incident.entry },
          })),
          incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
        });
        return;
      }

      const id = queueIncident(engine, resolution.entry);
      const resolved: ResolvedChallengeIncident = {
        id,
        source: "manual",
        entry: resolution.entry,
      };
      state.incidentHistory.push(resolved);
      // A human touched this run: its result is no longer comparable to a clean
      // run of the same scenario.
      state.manualIncidents += 1;
      // A closure takes options away from the next click, so ask again.
      postIncidentCapabilities();
      post({
        type: "INCIDENT_RESOLVED",
        kind: command.kind,
        queued: true,
        label: resolution.label,
        incident: resolved,
        incidentHistory: state.incidentHistory.map((incident) => ({
          ...incident,
          entry: { ...incident.entry },
        })),
        incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
      });
      postSnapshot();
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent) => {
  let command: WorkerCommand;
  try {
    command = parseWorkerCommand(event.data);
  } catch (error) {
    handleError(error);
    return;
  }
  try {
    handleCommand(command);
  } catch (error) {
    handleError(error);
  }
};
