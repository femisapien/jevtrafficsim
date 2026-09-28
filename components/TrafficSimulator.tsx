"use client";

/**
 * TrafficSimulator (Task 11 polish pass): the single client-side owner of the
 * worker and the product composition.
 *
 * Landing (city seen whole) → configuration → "Enter City" (INIT) → the map
 * sharpens and the camera flies into Central → minimal live chrome fades in
 * behind the flight. The map surface compiles the same deterministic showcase
 * geography the worker simulates; no EngineState ever crosses into React.
 * Presentation frames live in a ref shared with the map's rAF loop.
 */
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { loadChicagoCity } from "@/cities/chicago-assets";
import { METRO_SCALE_INDEX, type CuratedTripId } from "@/cities/chicago-trips";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { useUiStore } from "@/store/ui-store";
import type {
  BaselinesCommand,
  BaselinesEvent,
  ControllerChoice,
  WorkerCommand,
  WorkerEvent,
} from "@/worker/protocol";
import { LIVE_RUN_HORIZON_MS } from "@/worker/protocol";
import { CityMap, type MapHandle } from "./CityMap";
import { createFrameBuffer, pushFrame, setFrameModel, type FrameBuffer } from "./frame-buffer";
import { IncidentBar } from "./IncidentBar";
import { TripHUD } from "./TripHUD";
import { Onboarding } from "./Onboarding";
import { SimChrome } from "./SimChrome";
import {
  CLEAN_RUN_LOST_NOTICE,
  debugMode,
  discardNeedsConfirm,
  nextPlaybackSpeed,
  reviewStateNeedsNoConfirm,
  shouldReaskBaselines,
  runStoppedMessage,
  runUnableMessage,
  type DiscardAction,
} from "./ui-model";

interface JevDebugHook {
  config: unknown;
  incidentPlan: unknown;
  incidentHistory: unknown[];
  incidentFingerprint: string | null;
  /**
   * The finished run's per-refresh record (jev/telemetry.ts), or null while no
   * run has completed. Kept ONLY here, on a `?debug` hook: it is the one place
   * a reason vocabulary ("upstream-5xx", a policy field, a bound) may be read,
   * and it is never rendered into the page.
   */
  telemetry: unknown;
  snapshot: {
    sequence: number;
    timeMs: number;
    egoVehicleId: number | null;
    egoState: string | null;
    tripId: string | null;
    roadTrafficEntries: number;
    routeControls: number;
    controller: string;
    incidents: string[];
    closedRoads: number;
    snapshotBytes: number;
  } | null;
  metrics: unknown;
  error: string | null;
}

let lastByteMeasureAt = -Infinity;

function debugEnabled(): boolean {
  return typeof window !== "undefined" && debugMode(window.location.search);
}

/**
 * The controller a PREVIEW run uses (landing, and the setup screen while the
 * user is still choosing). Previews are not the challenge: they run the
 * deterministic Adaptive controller so an idle visit never spends live model
 * calls. "Enter City" starts the real thing.
 */
function previewController(): ControllerChoice {
  return "adaptive";
}

function updateDebugHook(event: WorkerEvent): void {
  if (!debugEnabled()) {
    return;
  }
  const target = window as unknown as { __jevDebug?: JevDebugHook };
  const store = useUiStore.getState();
  const hook: JevDebugHook =
    target.__jevDebug ?? {
      config: null,
      incidentPlan: null,
      incidentHistory: [],
      incidentFingerprint: null,
      telemetry: null,
      snapshot: null,
      metrics: null,
      error: null,
    };
  switch (event.type) {
    case "READY":
      hook.config = { ...event.config, scaleIndex: event.scaleIndex, scaleLabel: event.scaleLabel };
      hook.incidentPlan = event.incidentPlan;
      hook.incidentHistory = [...event.incidentHistory];
      hook.incidentFingerprint = event.incidentFingerprint;
      hook.snapshot = null;
      // A new run starts with no record of its own yet: the previous run's
      // per-refresh history must not read as this one's.
      hook.telemetry = null;
      hook.error = null;
      break;
    case "INCIDENT_RESOLVED":
      hook.incidentHistory = [...event.incidentHistory];
      hook.incidentFingerprint = event.incidentFingerprint;
      hook.error = null;
      break;
    case "SNAPSHOT": {
      const nowMs = performance.now();
      const measure = hook.snapshot === null || nowMs - lastByteMeasureAt >= 1_000;
      if (measure) {
        lastByteMeasureAt = nowMs;
      }
      hook.snapshot = {
        sequence: event.snapshot.sequence,
        timeMs: event.snapshot.timeMs,
        egoVehicleId: event.snapshot.ego?.id ?? null,
        egoState: event.snapshot.ego?.state ?? null,
        tripId: event.snapshot.trip?.tripId ?? null,
        roadTrafficEntries: event.snapshot.roadTraffic.length,
        routeControls: event.snapshot.routeControls.length,
        controller: event.snapshot.controller,
        incidents: event.snapshot.incidents.map((incident) => `${incident.kind}:${incident.status}`),
        closedRoads: event.snapshot.roadConditions.filter((road) => road.closed).length,
        snapshotBytes: measure
          ? JSON.stringify(event.snapshot).length
          : (hook.snapshot?.snapshotBytes ?? 0),
      };
      break;
    }
    case "METRICS":
      hook.metrics = event.metrics;
      break;
    case "RUN_COMPLETE":
      // The run's per-refresh record: the answer to "where did Jev fail, and
      // why". Kept on the `?debug` hook only — nothing here is rendered.
      hook.telemetry = event.telemetry;
      hook.error = null;
      break;
    case "RUN_INVALIDATED":
      hook.telemetry = event.telemetry;
      hook.error = runStoppedMessage(event.invalidation);
      break;
    case "JEV_UNABLE":
      hook.error = runUnableMessage(event.reason, event.detail);
      break;
    case "JEV_STARTING":
      hook.error = null;
      break;
    case "ERROR":
      hook.error = event.message;
      break;
  }
  if (store.config) {
    const previous = hook.config as { scaleIndex?: number; scaleLabel?: string } | null;
    hook.config = {
      ...store.config,
      controller: store.controller,
      seed: store.seed,
      scaleIndex: previous?.scaleIndex,
      scaleLabel: previous?.scaleLabel,
    };
  }
  target.__jevDebug = hook;
}

export function TrafficSimulator() {
  const framesRef = useRef<FrameBuffer>(createFrameBuffer());
  const workerRef = useRef<Worker | null>(null);
  const baselinesRef = useRef<Worker | null>(null);
  /** The scenario the baselines were last asked for, and when. */
  const baselinesAskedRef = useRef<{ fingerprint: string; request: BaselinesCommand; at: number } | null>(null);
  /** The destructive action awaiting the user's acknowledgement (Issue #39). */
  const pendingRunRef = useRef<(() => void) | null>(null);
  const baselinesReaskedRef = useRef<string | null>(null);
  const mapHandleRef = useRef<MapHandle | null>(null);
  const lastScaleRef = useRef<number | null>(null);
  const phase = useUiStore((state) => state.phase);
  /** True while the landing's background run is the one on screen. */
  const prewarmRef = useRef(false);

  useEffect(() => {
    // Developer controls are opt-in, and the whole chrome reads one flag.
    useUiStore.getState().setDebug(debugEnabled());

    // The baselines live in their own thread: a 600 s headless run takes far
    // longer than real time, and doing it beside the live run would starve the
    // renderer. Same comparison code, separate worker, no second engine.
    const baselines = new Worker(new URL("../worker/baselines.worker.ts", import.meta.url), {
      type: "module",
    });
    baselinesRef.current = baselines;
    baselines.onmessage = (event: MessageEvent) => {
      const data = event.data as BaselinesEvent;
      const store = useUiStore.getState();
      if (data.type === "BASELINES_RESULT") {
        store.setBaselines({
          fixed: data.fixed,
          adaptive: data.adaptive,
          fingerprint: data.fingerprint,
          incidentEntries: data.incidentEntries,
        });
        store.setBaselinesRunning(false);
        return;
      }
      if (data.type === "BASELINES_ERROR") {
        store.setBaselinesRunning(false);
        // The comparison owes the user either the numbers or a way back.
        store.setBaselinesFailed(data.message);
      }
    };
    baselines.onerror = (event) => {
      const store = useUiStore.getState();
      store.setBaselinesRunning(false);
      store.setBaselinesFailed(event.message || "baseline worker crashed");
    };

    const worker = new Worker(new URL("../worker/simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkerEvent;
      updateDebugHook(data);
      const store = useUiStore.getState();
      switch (data.type) {
        case "INCIDENT_CAPABILITIES": {
          // Straight from the worker's own resolver: what this world can run.
          store.setIncidentCapabilities(data.capabilities);
          break;
        }
        case "READY": {
          store.setScenarioFingerprint(data.scenarioFingerprint);
          // The frozen Chicago geography loads asynchronously (same committed
          // bytes the worker compiled); frames only start once it is in place.
          void loadChicagoCity(data.scaleIndex)
            .then((model) => {
              setFrameModel(framesRef.current, model, buildDirectedPathIndexes(model));
            })
            .catch(() => {
              // The map's own Retry control can recover the asset cache. Keep
              // this companion load bounded and handled, never an unhandled
              // rejection that poisons the browser session.
              store.setError("Chicago map data is temporarily unavailable. Retry the map, or reload the page.");
            });
          if (
            prewarmRef.current &&
            (store.phase === "landing" || store.phase === "config")
          ) {
            // Landing/config preview: live traffic behind the UI, no chrome.
            // Phase is part of the guard because a preview build can be
            // superseded by Enter City while Chicago is still loading. In that
            // race, the surviving READY belongs to the live run and must not
            // be swallowed by a stale prewarm flag.
            prewarmRef.current = false;
            break;
          }
          prewarmRef.current = false;
          // Baselines for the scenario that is ACTUALLY running: the READY
          // config is authoritative, so a setup change made mid-build cannot
          // make the comparison describe a different city than the live run.
          const request: BaselinesCommand = {
            type: "BASELINES",
            tripId: data.config.tripId,
            trafficLevel: data.config.trafficLevel,
            driver: data.config.driver,
            seed: data.config.seed,
            durationMs: data.config.durationMs,
          };
          baselinesRef.current?.postMessage(request);
          baselinesAskedRef.current = {
            fingerprint: data.scenarioFingerprint,
            request,
            at: Date.now(),
          };
          store.setBaselines(null);
          store.setBaselinesFailed(null);
          store.setBaselinesRunning(true);
          const entering = store.phase === "entering";
          const scaleChanged = lastScaleRef.current !== null && lastScaleRef.current !== data.scaleIndex;
          lastScaleRef.current = data.scaleIndex;
          store.applyReady(data.config, data.scaleLabel, data.scenarioFingerprint);
          store.setPhase("city");
          // The press owns the transition: the camera flies into Central while
          // the onboarding surface fades away. Framing is tracked by RUN, not by
          // the transient `entering` flag: measured, a prewarm READY arriving
          // after the press claimed that flag, so the real READY saw
          // `entering === false` and the whole trip played at the landing zoom
          // (14.1) instead of the street preset (15.4) whenever any setup control
          // had been touched.
          if (entering || scaleChanged || store.cameraFramedFor !== data.scenarioFingerprint) {
            store.markCameraFramed(data.scenarioFingerprint);
            mapHandleRef.current?.flyToCentral();
          }
          break;
        }
        case "INCIDENT_RESOLVED": {
          store.setFeedback(data.label);
          break;
        }
        case "SNAPSHOT": {
          pushFrame(framesRef.current, data.snapshot, performance.now());
          // Provenance at frame rate: the badge must never lag the run.
          store.setPolicy(data.snapshot.policy);
          // The worker's account of whether this run still matches the scenario
          // it started as (Issue #39) — read, never inferred from clicks.
          store.setGovernance(data.snapshot.governance);
          // Trip HUD source: the ego's own progress, at worker frame cadence.
          store.setTripFrame({
            trip: data.snapshot.trip,
            egoState: data.snapshot.ego?.state ?? null,
            egoSpeedMps: data.snapshot.ego?.speed ?? 0,
          });
          break;
        }
        case "METRICS": {
          store.setMetrics(data.metrics);
          break;
        }
        case "RUN_COMPLETE": {
          store.setRunning(false);
          store.setStarting(false);
          store.setRunComplete(true);
          // Remember WHICH world finished, so a READY for that same world cannot
          // erase the outcome (see applyReady).
          store.setCompletedFingerprint(store.scenarioFingerprint);
          // The payoff needs the same-scenario baselines, and the only place they
          // are normally requested is a READY that belongs to the live run. A run
          // entered without onboarding (or via ?debug) never sees that READY, so
          // the request is (re)issued here when this scenario has not asked yet.
          //
          // Only the run the user ENTERED owes a payoff. A preview that finishes
          // behind the menu earns none, and asking for its baselines would both
          // spend a headless comparison and file the answer under the wrong
          // scenario — the stale config from the last run the user played.
          if (
            store.entered &&
            baselinesAskedRef.current?.fingerprint !== store.scenarioFingerprint
          ) {
            const request: BaselinesCommand = {
              type: "BASELINES",
              tripId: store.config?.tripId ?? store.tripId,
              trafficLevel: store.config?.trafficLevel ?? store.trafficLevel,
              driver: store.config?.driver ?? store.driver,
              seed: store.config?.seed ?? store.seed,
              durationMs: store.config?.durationMs ?? LIVE_RUN_HORIZON_MS,
            };
            baselinesRef.current?.postMessage(request);
            baselinesAskedRef.current = {
              fingerprint: store.scenarioFingerprint ?? "",
              request,
              at: Date.now(),
            };
            store.setBaselines(null);
            store.setBaselinesFailed(null);
            store.setBaselinesRunning(true);
          }
          // The visible run's own outcome: it becomes the Jev column.
          store.setLiveResult(data.result);
          store.setPolicy(data.policy);
          break;
        }
        case "ERROR": {
          store.setError(data.message);
          store.setRunning(false);
          break;
        }
        case "JEV_STARTING": {
          // The run is waiting for its first live policy: no simulated time is
          // passing, and it will not start until one is accepted.
          store.setStarting(true);
          store.setRunning(false);
          break;
        }
        case "JEV_READY": {
          store.setStarting(false);
          store.setRunning(true);
          break;
        }
        case "JEV_UNABLE": {
          // The run could not start. Nothing was simulated and nothing was
          // substituted for Jev — the message is the whole account of it.
          store.setStarting(false);
          store.setRunning(false);
          store.setRunComplete(false);
          store.setLiveResult(null);
          store.setError(runUnableMessage(data.reason, data.detail));
          break;
        }
        case "RUN_INVALIDATED": {
          // Jev was lost and the run stopped. The measurements already on screen
          // stay; what must NOT happen is this reading as a completed Jev result.
          store.setStarting(false);
          store.setRunning(false);
          store.setRunComplete(false);
          store.setLiveResult(null);
          store.setPolicy(data.policy);
          store.setError(runStoppedMessage(data.invalidation));
          break;
        }
      }
    };
    worker.onerror = (event) => {
      const store = useUiStore.getState();
      store.setError(event.message || "simulation worker crashed");
      store.setRunning(false);
    };
    // Prewarm the landing with the default scenario so the city is alive
    // behind the title; Enter City always starts a fresh deterministic run.
    const defaults = useUiStore.getState();
    prewarmRef.current = true;
    worker.postMessage({
      type: "INIT",
      citySize: "large",
      trafficLevel: defaults.trafficLevel,
      tripId: defaults.tripId,
      controller: previewController(),
      driver: defaults.driver,
      seed: defaults.seed,
    } satisfies WorkerCommand);
    return () => {
      worker.terminate();
      baselines.terminate();
      workerRef.current = null;
      baselinesRef.current = null;
    };
  }, []);

  const send = useCallback((command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  const startRun = useCallback(
    (
      overrides: Partial<{
        trafficLevel: TrafficLevel;
        tripId: CuratedTripId;
        controller: ControllerChoice;
        seed: number;
      }> = {},
    ) => {
      const state = useUiStore.getState();
      state.setError(null);
      state.setRunComplete(false);
      send({
        type: "INIT",
        citySize: "large",
        trafficLevel: overrides.trafficLevel ?? state.trafficLevel,
        tripId: overrides.tripId ?? state.tripId,
        controller: overrides.controller ?? state.controller,
        driver: state.driver,
        seed: overrides.seed ?? state.seed,
      });
      // Pacing is a viewing preference, not part of the world: the run being
      // built must be watched at the speed the control shows.
      send({ type: "SET_SPEED", speed: state.speed });
    },
    [send],
  );

  const previewSetup = useCallback(() => {
    // Configuration is a live traffic preview, not a static mock. Mark the
    // next READY as prewarm-only so changing trip/traffic/controller/seed
    // refreshes the city behind the setup panel without entering the challenge.
    prewarmRef.current = true;
    startRun({ controller: previewController() });
  }, [startRun]);

  const enterCity = useCallback(() => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    startRun();
  }, [startRun]);

  const onPause = useCallback(() => {
    send({ type: "PAUSE" });
    useUiStore.getState().setRunning(false);
  }, [send]);

  const onResume = useCallback(() => {
    send({ type: "START" });
    useUiStore.getState().setRunning(true);
  }, [send]);

  /**
   * "Skip to end": finish this run now. The worker advances the same paced run
   * at the fastest pace the run's own policy coverage allows — the same engine
   * steps, the same refresh schedule, the same wall-clock service budget — until
   * its horizon, so the run completes and publishes its payoff exactly as a
   * watched one does. Nothing here fabricates an arrival, relaxes the budget or
   * substitutes a controller; the ego may or may not arrive on the way, and
   * either outcome is reported as it happened.
   */
  const onSkipToEnd = useCallback(() => {
    send({ type: "SKIP_TO_END" });
  }, [send]);

  /**
   * "3× speed": watch the run at 3× the normal playback — more engine steps per
   * real tick, never a different run. The store owns the state so both surfaces
   * show the same thing, and the worker is told every time it changes.
   */
  const onToggleSpeed = useCallback(() => {
    const store = useUiStore.getState();
    const speed = nextPlaybackSpeed(store.speed);
    store.setSpeed(speed);
    send({ type: "SET_SPEED", speed });
  }, [send]);

  const onController = useCallback(
    (controller: ControllerChoice) => {
      // Live switch: no restart, no rebuild.
      useUiStore.getState().setController(controller);
      send({ type: "SET_CONTROLLER", controller });
    },
    [send],
  );

  /**
   * Run an action that would destroy the current run, or ask first.
   *
   * Setup changes before a run stay frictionless; the question is only ever
   * asked when there is something real to lose (a run under way). A run whose
   * trip already arrived is not that: the payoff is on screen, and its two
   * actions — play it again, or back to the menu — are deliberate there, so
   * neither asks a second time. The pending action is kept in a ref and executed
   * only on the user's explicit acknowledgement.
   */
  const guardDiscard = useCallback((action: DiscardAction, run: () => void) => {
    const store = useUiStore.getState();
    const reviewed = reviewStateNeedsNoConfirm({
      arrived: store.trip?.completed === true,
      runComplete: store.runComplete,
    });
    const needsConfirm =
      !reviewed &&
      discardNeedsConfirm({
        started:
          (store.phase === "city" || store.phase === "entering") &&
          (store.trip !== null || store.running),
        runComplete: store.runComplete,
        hasResult: store.liveResult !== null,
      });
    if (!needsConfirm) {
      run();
      return;
    }
    pendingRunRef.current = run;
    store.requestDiscard(action);
  }, []);

  const onConfirmDiscard = useCallback(() => {
    const store = useUiStore.getState();
    const run = pendingRunRef.current;
    pendingRunRef.current = null;
    store.cancelDiscard();
    if (run !== null) run();
  }, []);

  const onCancelDiscard = useCallback(() => {
    pendingRunRef.current = null;
    useUiStore.getState().cancelDiscard();
  }, []);

  const onTripId = useCallback(
    (tripId: CuratedTripId) => {
      guardDiscard("trip", () => {
        const store = useUiStore.getState();
        store.setTripId(tripId);
        startRun({ tripId });
      });
    },
    [guardDiscard, startRun],
  );

  const onTrafficLevel = useCallback(
    (trafficLevel: TrafficLevel) => {
      const store = useUiStore.getState();
      store.setTrafficLevel(trafficLevel);
      // Mid-trip this is a LIVE change: the city gets busier or quieter from
      // this moment on, and the trip keeps its clock, route and ego. Only a
      // change made before the run starts (or an explicit trip change) rebuilds.
      if (store.phase === "city" || store.phase === "entering") {
        send({ type: "SET_TRAFFIC", trafficLevel });
        // A live demand change marks the run modified just as surely as an
        // incident does, so the user hears it once, in the same place.
        if (!store.cleanRunWarningShown) {
          store.noteCleanRunWarning();
          store.setFeedback(CLEAN_RUN_LOST_NOTICE);
        }
        return;
      }
      startRun({ trafficLevel });
    },
    [send, startRun],
  );

  const onDriver = useCallback(
    (driver: DriverStrategy) => {
      guardDiscard("driver", () => {
        const store = useUiStore.getState();
        store.setDriver(driver);
        // The driver defines what the run IS, so this is a fresh run of the same
        // scenario with a different human at the wheel — never a live mutation.
        startRun();
      });
    },
    [guardDiscard, startRun],
  );

  const onSeed = useCallback(
    (seed: number) => {
      guardDiscard("seed", () => {
        useUiStore.getState().setSeed(seed);
        startRun({ seed });
      });
    },
    [guardDiscard, startRun],
  );

  const onRestart = useCallback(() => {
    guardDiscard("restart", () => {
      const store = useUiStore.getState();
      store.setError(null);
      store.setRunComplete(false);
      store.resetMetrics();
      send({ type: "RESET", mode: "same-seed" });
      store.setRunning(true);
      mapHandleRef.current?.flyToCentral();
    });
  }, [guardDiscard, send]);

  /**
   * "New draw" returns to the setup screen.
   *
   * It used to fire a fresh seed and fly straight back into the city, so the
   * button restarted the run instead of letting anyone choose a different trip,
   * level or driver - the opposite of what the label promises. The scenario is
   * still reset (a new seed is drawn on the next press of Enter City); the phase
   * is what changes, so the menu is where the user lands.
   */
  const onNewScenario = useCallback(() => {
    const goToMenu = () => {
      const store = useUiStore.getState();
      store.setError(null);
      store.setRunComplete(false);
      store.resetMetrics();
      // No RESET here. A reset makes the worker post a fresh READY for the world
      // it was just given, and the READY handler flips the phase straight back to
      // "city" - which is how this button kept restarting the run instead of
      // showing the menu. The worker is idle and the next Enter City dispatches
      // the scenario that is chosen there.
      store.setRunning(false);
      store.setPhase("config");
      mapHandleRef.current?.fitCity();
    };
    // A finished run has nothing to discard: the result is on screen because the
    // user just asked to leave it, and a confirmation here turned one deliberate
    // action into two. Only a run still in flight needs the guard.
    if (useUiStore.getState().runComplete) {
      goToMenu();
      return;
    }
    guardDiscard("new-scenario", goToMenu);
  }, [guardDiscard]);

  /**
   * Ask the baseline worker again for the scenario on screen. Deliberately the
   * SAME request that was dispatched at INIT: the baselines are a pure function
   * of the scenario, so a retry cannot invent a comparison that never applied.
   */
  const onRetryBaselines = useCallback(() => {
    const store = useUiStore.getState();
    const asked = baselinesAskedRef.current;
    if (asked === null) {
      return;
    }
    store.setBaselinesFailed(null);
    store.setBaselines(null);
    store.setBaselinesRunning(true);
    baselinesRef.current?.postMessage(asked.request);
    baselinesAskedRef.current = { ...asked, at: Date.now() };
  }, []);


  const onIncident = useCallback(
    (kind: IncidentKind) => {
      send({ type: "INCIDENT", kind });
    },
    [send],
  );

  const onZoomIn = useCallback(() => {
    mapHandleRef.current?.zoomIn();
  }, []);

  const onZoomOut = useCallback(() => {
    mapHandleRef.current?.zoomOut();
  }, []);

  const handleMap = useCallback((handle: MapHandle | null) => {
    mapHandleRef.current = handle;
  }, []);

  // Follow camera: the map owns the state; the chrome only mirrors and toggles it.
  const debug = useUiStore((state) => state.debug);
  const following = useUiStore((state) => state.following);
  const baselines = useUiStore((state) => state.baselines);
  const runComplete = useUiStore((state) => state.runComplete);
  const entered = useUiStore((state) => state.entered);
  const scenarioFingerprint = useUiStore((state) => state.scenarioFingerprint);

  /**
   * Safety net for a lost baselines dispatch: the comparison is the whole
   * payoff, so if the run has finished and the scenario's baselines still are
   * not here, ask once more (bounded — see shouldReaskBaselines). Only for the
   * run the user entered: a preview owes no comparison.
   */
  useEffect(() => {
    if (!runComplete || !entered) {
      return;
    }
    const asked = baselinesAskedRef.current;
    const reask = shouldReaskBaselines({
      runComplete,
      hasBaselines: baselines !== null,
      fingerprint: scenarioFingerprint,
      askedFingerprint: asked?.fingerprint ?? null,
      msSinceAsk: asked === null ? 0 : Date.now() - asked.at,
      alreadyReasked:
        asked !== null && baselinesReaskedRef.current === asked.fingerprint,
    });
    if (!reask || asked === null) {
      return;
    }
    baselinesReaskedRef.current = asked.fingerprint;
    useUiStore.getState().setBaselinesRunning(true);
    baselinesRef.current?.postMessage(asked.request);
  }, [runComplete, baselines, scenarioFingerprint, entered]);
  const onFollow = useCallback(() => {
    mapHandleRef.current?.followEgo();
  }, []);

  const scaleIndex = METRO_SCALE_INDEX; // Metro is the sole public geography.
  const live = phase === "city";

  return (
    <MotionConfig reducedMotion="user">
      <div className="absolute inset-0 overflow-hidden bg-paper text-ink">
        <CityMap scaleIndex={scaleIndex} frames={framesRef} live={live} onHandle={handleMap} />
        {/* The city stays sharp; a warm wash settles the landing, nothing more. */}
        <div
          className={`pointer-events-none absolute inset-0 z-10 bg-paper transition-opacity duration-[900ms] ease-out ${
            live ? "opacity-0" : "opacity-30"
          }`}
          aria-hidden="true"
        />
        <Onboarding onEnterCity={enterCity} onPreviewSetup={previewSetup} debug={debug} />
        <SimChrome
          following={following}
          onFollow={onFollow}
          onPause={onPause}
          onResume={onResume}
          debug={debug}
          onController={onController}
          onTripId={onTripId}
          onTrafficLevel={onTrafficLevel}
          onDriver={onDriver}
          onSeed={onSeed}
          onRestart={onRestart}
          onNewScenario={onNewScenario}
          onRetryBaselines={onRetryBaselines}
          onConfirmDiscard={onConfirmDiscard}
          onCancelDiscard={onCancelDiscard}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onSkipToEnd={onSkipToEnd}
          onToggleSpeed={onToggleSpeed}
        />
        {/*
          Phone: ONE bottom stack — the trip card directly above the incident
          tray, in a flex column that cannot overlap or waste the space between
          them, both clear of the home indicator. Wide: the wrapper dissolves
          (sm:contents) and each panel keeps the corner it always had.
        */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2.5 px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] sm:contents">
          <TripHUD onSkipToEnd={onSkipToEnd} onToggleSpeed={onToggleSpeed} />
          <IncidentBar onIncident={onIncident} />
        </div>
      </div>
    </MotionConfig>
  );
}
