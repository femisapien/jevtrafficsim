"use client";

/**
 * UI store (Task 11 polish pass): UI state ONLY — onboarding phase,
 * selections, worker status, metrics and a bounded metrics history for the
 * sparkline. Simulation state lives exclusively in the worker; presentation
 * frames live in refs near the map.
 */
import { create } from "zustand";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type {
  PresentationMetrics,
  PresentationPolicy,
  PresentationTripProgress,
} from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";
import type { DriverStrategy } from "@/sim/driver";
import type { ChallengeResult } from "@/worker/challenge-result";
import type { IncidentCapability } from "@/worker/challenge-incidents";
import type { DiscardAction } from "@/components/ui-model";

/**
 * The two deterministic baselines for one scenario (Issue #15), computed off
 * the interactive thread while the visible Jev run plays. They belong to the
 * fingerprint they were built for: results for another scenario are ignored
 * rather than quietly shown beside this run.
 */
export interface BaselineState {
  readonly fixed: ChallengeResult;
  readonly adaptive: ChallengeResult;
  readonly fingerprint: string;
  readonly incidentEntries: number;
}

export type UiPhase = "landing" | "config" | "entering" | "city";

/** Avg-wait samples: 150 worker frames; wall-clock duration varies with tick cost. */
export const METRICS_HISTORY_LIMIT = 150;

export interface UiState {
  phase: UiPhase;
  trafficLevel: TrafficLevel;
  tripId: CuratedTripId;
  controller: ControllerChoice;
  /** Driver behaviour profile (Issue #28) — independent of the controller. */
  driver: DriverStrategy;
  /** Scenario identity of the running world (Issue #28), shown instead of the seed. */
  scenarioFingerprint: string | null;
  /** Fixed and Adaptive baselines for the running scenario, once computed. */
  baselines: BaselineState | null;
  baselinesRunning: boolean;
  /** The visible run's own outcome, published when it finishes. */
  liveResult: ChallengeResult | null;
  /** Who governs the signals (live | replay | waiting | invalidated). */
  policy: PresentationPolicy | null;
  /**
   * A live Jev run is waiting for its FIRST policy (Issue #61): no simulated
   * time is passing, and the run will not start until one is accepted. Distinct
   * from `running`, which means the clock is actually advancing.
   */
  starting: boolean;
  /** Developer controls (?debug) only: controller choice and raw seed. */
  debug: boolean;
  seed: number;
  ready: boolean;
  /**
   * The run on screen is one the user ENTERED (a READY that was applied, not a
   * landing/menu preview). The payoff belongs to that run and to no other: a
   * preview that finishes behind the menu must not throw its result over the
   * setup screen.
   */
  entered: boolean;
  running: boolean;
  runComplete: boolean;
  /** Fingerprint of the world whose run finished; null until one has. */
  completedFingerprint: string | null;
  error: string | null;
  metrics: PresentationMetrics | null;
  metricsHistory: number[];
  /** Trip HUD source: the ego's trip progress from the latest frame. */
  trip: PresentationTripProgress | null;
  egoState: string | null;
  egoSpeedMps: number;
  /** Follow camera: owned by the map, mirrored here for the chrome button. */
  following: boolean;
  config: RunConfig | null;
  scaleLabel: string;
  scenarioOpen: boolean;
  /**
   * The worker's own account of whether this run still describes the scenario it
   * started as (Issue #39), mirrored from presentation frames. `manualIncidents`
   * counts the chaos a human queued; `modified` also covers live setting changes.
   */
  modified: boolean;
  manualIncidents: number;
  /**
   * Which incidents this world can actually run, straight from the worker's own
   * resolver. Null until the first probe lands, or before a run exists.
   */
  incidentCapabilities: readonly IncidentCapability[] | null;
  /** Set once the first comparability-destroying action has been explained. */
  cleanRunWarningShown: boolean;
  /** Why the baselines failed, if they did — the panel owes the user a retry. */
  baselinesFailed: string | null;
  /** A destructive action waiting for the user's explicit acknowledgement. */
  pendingDiscard: DiscardAction | null;
  /** Increments on each demand-surge action so the chip can react. */
  surgeFlash: number;
  surgeVisible: boolean;
  /** Transient line shown above the incident dock ("Crash queued"). */
  feedback: string | null;
  setPhase: (phase: UiPhase) => void;
  /**
   * The scenario fingerprint the camera has already been framed for. A run in
   * flight must not be re-framed by a later READY for the same world (the payoff
   * would be yanked back to the street preset), and a READY that arrives before
   * the press - a prewarm world - must not count as the framing either, which is
   * what a transient phase flag got wrong.
   */
  cameraFramedFor: string | null;
  markCameraFramed: (fingerprint: string) => void;
  setTrafficLevel: (trafficLevel: TrafficLevel) => void;
  setTripId: (tripId: CuratedTripId) => void;
  setController: (controller: ControllerChoice) => void;
  setDriver: (driver: DriverStrategy) => void;
  setScenarioFingerprint: (fingerprint: string | null) => void;
  setBaselines: (baselines: BaselineState | null) => void;
  setBaselinesRunning: (running: boolean) => void;
  setBaselinesFailed: (message: string | null) => void;
  setGovernance: (governance: { modified: boolean; manualIncidents: number }) => void;
  setIncidentCapabilities: (capabilities: readonly IncidentCapability[] | null) => void;
  noteCleanRunWarning: () => void;
  requestDiscard: (action: DiscardAction) => void;
  cancelDiscard: () => void;
  setLiveResult: (result: ChallengeResult | null) => void;
  setPolicy: (policy: PresentationPolicy | null) => void;
  setStarting: (starting: boolean) => void;
  setDebug: (debug: boolean) => void;
  setSeed: (seed: number) => void;
  setScenarioOpen: (open: boolean) => void;
  applyReady: (config: RunConfig, scaleLabel: string, fingerprint?: string) => void;
  setRunning: (running: boolean) => void;
  setRunComplete: (runComplete: boolean) => void;
  setCompletedFingerprint: (fingerprint: string | null) => void;
  setError: (error: string | null) => void;
  setMetrics: (metrics: PresentationMetrics) => void;
  setTripFrame: (frame: {
    trip: PresentationTripProgress | null;
    egoState: string | null;
    egoSpeedMps: number;
  }) => void;
  setFollowing: (following: boolean) => void;
  setFeedback: (feedback: string | null) => void;
  flashSurge: () => void;
  showSurge: () => void;
  hideSurge: () => void;
  resetMetrics: () => void;
}

/**
 * True when a READY describes the run whose outcome is already in the store.
 *
 * Compared on the fields that define the world — trip, traffic level, driver,
 * seed — because those are exactly the ones a scenario change moves. Controller
 * is deliberately excluded: switching controller mid-run is a live switch, not a
 * new scenario.
 */
function sameWorldFinished(state: UiState, fingerprint: string | undefined): boolean {
  return (
    state.runComplete &&
    state.liveResult !== null &&
    state.completedFingerprint !== null &&
    state.completedFingerprint === fingerprint
  );
}

export const useUiStore = create<UiState>()((set) => ({
  phase: "landing",
  cameraFramedFor: null,
  trafficLevel: "everyday",
  tripId: "soldier-field-to-navy-pier",
  /** Jev is the product's visible run; Fixed/Adaptive are the baselines. */
  controller: "jev",
  driver: "tourist",
  scenarioFingerprint: null,
  baselines: null,
  baselinesRunning: false,
  baselinesFailed: null,
  modified: false,
  manualIncidents: 0,
  incidentCapabilities: null,
  cleanRunWarningShown: false,
  pendingDiscard: null,
  liveResult: null,
  policy: null,
  starting: false,
  debug: false,
  seed: 42,
  ready: false,
  entered: false,
  running: false,
  runComplete: false,
  completedFingerprint: null,
  error: null,
  metrics: null,
  metricsHistory: [],
  trip: null,
  egoState: null,
  egoSpeedMps: 0,
  following: true,
  config: null,
  scaleLabel: "Medium",
  scenarioOpen: false,
  surgeFlash: 0,
  surgeVisible: false,
  feedback: null,
  setPhase: (phase) =>
    set({
      phase,
      // Leaving the city puts the camera back in play for the next run, and
      // ends the run the user entered: what plays behind the menu is a preview,
      // and a preview owes nobody a payoff.
      ...(phase === "config" || phase === "landing"
        ? { cameraFramedFor: null, entered: false }
        : {}),
    }),
  setTrafficLevel: (trafficLevel) => set({ trafficLevel }),
  setTripId: (tripId) => set({ tripId }),
  setController: (controller) => set({ controller }),
  setDriver: (driver) => set({ driver }),
  setScenarioFingerprint: (scenarioFingerprint) => set({ scenarioFingerprint }),
  setBaselines: (baselines) => set({ baselines }),
  setBaselinesRunning: (baselinesRunning) => set({ baselinesRunning }),
  setBaselinesFailed: (baselinesFailed) => set({ baselinesFailed }),
  setGovernance: ({ modified, manualIncidents }) => set({ modified, manualIncidents }),
  setIncidentCapabilities: (incidentCapabilities) => set({ incidentCapabilities }),
  noteCleanRunWarning: () => set({ cleanRunWarningShown: true }),
  requestDiscard: (pendingDiscard) => set({ pendingDiscard }),
  cancelDiscard: () => set({ pendingDiscard: null }),
  setLiveResult: (liveResult) => set({ liveResult }),
  setPolicy: (policy) => set({ policy }),
  setStarting: (starting) => set({ starting }),
  setDebug: (debug) => set({ debug }),
  setSeed: (seed) => set({ seed }),
  setScenarioOpen: (scenarioOpen) => set({ scenarioOpen }),
  markCameraFramed: (fingerprint) => set({ cameraFramedFor: fingerprint }),
  applyReady: (config, scaleLabel, fingerprint) =>
    set((state) => ({
      config,
      seed: config.seed,
      controller: config.controller,
      tripId: config.tripId,
      scaleLabel,
      ready: true,
      // This READY was applied, not swallowed as a preview: the run on screen is
      // the one the user entered, and it is the only one that earns a payoff.
      entered: true,
      error: null,
      /**
       * A READY that describes the SAME scenario as the run that just finished
       * must not erase its outcome. A run entered without onboarding (?debug, or
       * the city the app opens on) gets its READY from a prewarm build, and that
       * build can land after RUN_COMPLETE — which used to wipe the completion
       * state and hide the payoff, along with the baselines request that belongs
       * to it. Only a genuinely different scenario invalidates a finished run.
       */
      runComplete: sameWorldFinished(state, fingerprint) ? state.runComplete : false,
      liveResult: sameWorldFinished(state, fingerprint) ? state.liveResult : null,
      running: true,
      // A new run starts gated: the worker says when its first policy arrived.
      starting: false,
      metrics: null,
      metricsHistory: [],
      trip: null,
      egoState: null,
      egoSpeedMps: 0,
      feedback: null,
      surgeVisible: false,
      // A new run invalidates the previous run's provenance; the baselines are
      // dispatched separately and are matched by fingerprint.
      policy: sameWorldFinished(state, fingerprint) ? state.policy : null,
      // A fresh run starts clean: nothing has been modified yet, and the first
      // comparability-destroying action gets its warning back.
      modified: false,
      manualIncidents: 0,
      cleanRunWarningShown: false,
      baselinesFailed: null,
      pendingDiscard: null,
    })),
  setRunning: (running) => set({ running }),
  setRunComplete: (runComplete) => set({ runComplete }),
  setCompletedFingerprint: (completedFingerprint) => set({ completedFingerprint }),
  setError: (error) => set({ error }),
  setMetrics: (metrics) =>
    set((state) => ({
      metrics,
      metricsHistory: [...state.metricsHistory, metrics.averageWaitTimeMs / 1000].slice(
        -METRICS_HISTORY_LIMIT,
      ),
    })),
  setTripFrame: ({ trip, egoState, egoSpeedMps }) => set({ trip, egoState, egoSpeedMps }),
  setFollowing: (following) => set({ following }),
  setFeedback: (feedback) => set({ feedback }),
  flashSurge: () => set((state) => ({ surgeFlash: state.surgeFlash + 1 })),
  showSurge: () => set({ surgeVisible: true }),
  hideSurge: () => set({ surgeVisible: false }),
  resetMetrics: () =>
    set({
      metrics: null,
      metricsHistory: [],
      trip: null,
      egoState: null,
      egoSpeedMps: 0,
      liveResult: null,
      baselinesFailed: null,
    }),
}));
