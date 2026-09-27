/**
 * Product flow (Issue #15): the public experience is ONE experiment.
 *
 *   same Chicago scenario · same trip · same driver · different city intelligence
 *
 * What is pinned here:
 *   1. the public setup asks for trip, traffic, driver and a fresh scenario —
 *      not for a controller, and not for a raw seed (both are ?debug controls)
 *   2. the visible run is Jev, and the Fixed/Adaptive baselines describe the
 *      SAME world: one fingerprint, one demand, one incident script
 *   3. the public label names the controller — one name, Jev — and a run that
 *      never had a policy does not get to call itself Jev
 *   4. a run a human touched is not shown beside clean baseline results
 *   5. the baseline worker's request cannot smuggle in a controller
 *   6. result metadata stays consistent with the run it describes
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { demandProfileFor } from "@/sim/demand-profile";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController } from "@/controllers/jev";
import { createEngine, stepEngine } from "@/sim/engine";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition } from "@/sim/regions";
import type { JevClient } from "@/jev/client";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { useUiStore } from "@/store/ui-store";
import {
  BASELINES_REGRACE_MS,
  COMPARISON_COLUMNS,
  comparisonRows,
  debugMode,
  policyLabel,
  shouldReaskBaselines,
} from "@/components/ui-model";
import { buildScenarioRun } from "@/worker/challenge-compare";
import {
  buildChallengeScenario,
  fingerprintForRun,
  resolveScenarioWorld,
  scenarioFingerprint,
} from "@/worker/challenge-scenario";
import { comparisonVerdictAll, type ChallengeResult } from "@/worker/challenge-result";
import { buildPresentationSnapshot, ungovernedShare, type PresentationPolicy } from "@/worker/presentation-snapshot";
import { LIVE_RUN_HORIZON_MS, parseBaselinesCommand } from "@/worker/protocol";
import { productionDemand } from "@/sim/demand-profile";
import { buildChallengeIncidentPlan } from "@/worker/challenge-incidents";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { chicagoModel } from "./chicago-support";
import { makeCrossroads } from "./traffic-support";

const SCENARIO = {
  tripId: "soldier-field-to-navy-pier",
  trafficLevel: "everyday",
  driver: "tourist",
  seed: 42,
  durationMs: LIVE_RUN_HORIZON_MS,
} as const;

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/* ------------------------------------------------- 1. the public setup --- */

describe("the public setup", () => {
  it("asks three questions and one redraw: trip, traffic, driver, new scenario", () => {
    const onboarding = source("components/Onboarding.tsx");
    for (const field of ["Trip", "Traffic", "Driver", "New scenario"]) {
      expect(onboarding).toContain(field);
    }
    // Inside the component, the seed and the controller render only after the
    // debug block opens: a visitor cannot reach either.
    const card = onboarding.slice(onboarding.indexOf("export function Onboarding({"));
    const debugBlock = card.indexOf("{debug && (");
    expect(debugBlock).toBeGreaterThan(-1);
    const publicCard = card.slice(0, debugBlock);
    expect(publicCard).not.toContain("DebugSeedField");
    expect(publicCard).not.toContain("CONTROLLER_OPTIONS");
    expect(card.slice(debugBlock)).toContain("CONTROLLER_OPTIONS");
  });

  it("hides the developer controls unless ?debug is asked for", () => {
    expect(debugMode("")).toBe(false);
    expect(debugMode("?trip=x")).toBe(false);
    expect(debugMode("?nodebug")).toBe(false);
    expect(debugMode("?debug=0")).toBe(false);
    expect(debugMode("?debug")).toBe(true);
    expect(debugMode("?a=1&debug=1")).toBe(true);
  });

  it("does not put a controller picker in the public live chrome", () => {
    const chrome = source("components/SimChrome.tsx");
    const chromeDebug = chrome.indexOf("props.debug &&");
    expect(chromeDebug).toBeGreaterThan(-1);
    expect(chrome.indexOf("CONTROLLER_OPTIONS", chromeDebug)).toBeGreaterThan(chromeDebug);
    // The live scenario popover keeps its seed field behind the debug prop too.
    expect(chrome).toContain("{debug && (\n          <SeedField");
    // The old wording promised a new city when the geography never changes; the
    // payoff's way back to the setup screen is a word everyone already knows.
    expect(chrome).not.toContain("New city");
    expect(chrome).not.toContain("New draw");
    expect(chrome).toMatch(/>\s*Menu\s*</);
    // The old Fixed-vs-Adaptive-only label is gone from the payoff panel.
    expect(source("components/ComparisonPanel.tsx")).not.toContain("Fixed vs Adaptive");
  });

  it("makes Jev the visible run", () => {
    const state = useUiStore.getState();
    expect(state.controller).toBe("jev");
    // A preview must not spend live model calls; the challenge must use Jev.
    const simulator = source("components/TrafficSimulator.tsx");
    expect(simulator).toContain('function previewController(): ControllerChoice {\n  return "adaptive";');
    expect(simulator).toContain("controller: previewController(),");
    expect(simulator).toContain("const enterCity = useCallback(() => {");
    expect(simulator).toContain("startRun();");
  });
});

/* ------------------------------------- 2. same scenario, three runs --- */

describe("Fixed, Adaptive and Jev run the same world", () => {
  it("share one fingerprint across the live run and the baselines", () => {
    const live = fingerprintForRun(SCENARIO); // what the worker binds Jev to
    const baselines = scenarioFingerprint(
      buildChallengeScenario({
        tripId: SCENARIO.tripId,
        trafficLevel: SCENARIO.trafficLevel,
        driver: SCENARIO.driver,
        seed: SCENARIO.seed,
        durationMs: SCENARIO.durationMs,
      }),
    );
    expect(baselines).toBe(live);
    // Change any axis of the experiment and the identity moves with it.
    expect(fingerprintForRun({ ...SCENARIO, seed: 43 })).not.toBe(live);
    expect(fingerprintForRun({ ...SCENARIO, trafficLevel: "rush-hour" })).not.toBe(live);
    expect(fingerprintForRun({ ...SCENARIO, driver: "local" })).not.toBe(live);
    expect(fingerprintForRun({ ...SCENARIO, tripId: "river-north-to-navy-pier" })).not.toBe(live);
  });

  it("hand every controller byte-identical demand and adversity", () => {
    const model = chicagoModel(4);
    const scenario = buildChallengeScenario({ ...SCENARIO });
    const challenge = materializeChallengeTrip(model, SCENARIO.tripId, SCENARIO.seed);
    const world = resolveScenarioWorld(model, challenge.trip, scenario);

    // What the LIVE run builds (worker/simulation.worker.ts buildRun) — the
    // production demand profile, which is the only profile any of these paths
    // may use.
    const liveSpawns = [
      challenge.spawn,
      ...productionDemand({
        city: model.city,
        level: SCENARIO.trafficLevel,
        seed: SCENARIO.seed,
        durationMs: SCENARIO.durationMs,
      }),
    ];
    expect(scenario.demandProfile).toBe(demandProfileFor(SCENARIO.trafficLevel).label);
    const liveIncidents = buildChallengeIncidentPlan(
      model,
      challenge.trip,
      SCENARIO.trafficLevel,
      SCENARIO.seed,
    );

    // What the BASELINE worker builds (the same seam the benchmark uses).
    const run = buildScenarioRun(model, { ...SCENARIO });

    expect(run.fingerprint).toBe(fingerprintForRun(SCENARIO));
    expect(run.spawns).toEqual(liveSpawns);
    expect(run.incidents.script).toEqual(liveIncidents.entries);
    expect(run.incidents.seed).toBe(liveIncidents.incidentSeed);
    expect(run.demandSeed).toBe(SCENARIO.seed);
    expect(world.incidentPlan.entries).toEqual(liveIncidents.entries);
  });

  it("keeps a controller out of the baseline request entirely", () => {
    const command = parseBaselinesCommand({
      type: "BASELINES",
      ...SCENARIO,
    });
    expect(Object.keys(command).sort()).toEqual([
      "driver",
      "durationMs",
      "seed",
      "trafficLevel",
      "tripId",
      "type",
    ]);
    // A caller cannot ask for a controller, a Jev adapter or a different horizon.
    expect(parseBaselinesCommand({ type: "BASELINES", ...SCENARIO }).durationMs).toBe(
      LIVE_RUN_HORIZON_MS,
    );
    expect(() => parseBaselinesCommand({ type: "BASELINES", ...SCENARIO, durationMs: -1 })).toThrow(
      RangeError,
    );
    expect(() => parseBaselinesCommand({ type: "BASELINES", ...SCENARIO, seed: -3 })).toThrow(
      RangeError,
    );
    expect(() => parseBaselinesCommand({ type: "BASELINES", ...SCENARIO, tripId: "nowhere" })).toThrow(
      RangeError,
    );
    expect(() => parseBaselinesCommand({ type: "COMPARE", ...SCENARIO })).toThrow(RangeError);
  });

  it("renames the third column for whoever actually governed", () => {
    const cleanRun: PresentationPolicy = {
      source: "live",
      liveMs: 600_000,
      replayMs: 0,
      fallbackMs: 0,
      accepted: 118,
      rejected: 2,
      refreshes: 120,
    };
    const onFallback: PresentationPolicy = { ...cleanRun, fallbackMs: 120_000, accepted: 3 };
    const noPolicy: PresentationPolicy = {
      source: "waiting",
      liveMs: 0,
      replayMs: 0,
      fallbackMs: 0,
      accepted: 0,
      rejected: 0,
      refreshes: 1,
      cause: "first-policy",
    };
    const invalidated: PresentationPolicy = {
      ...cleanRun,
      source: "invalidated",
      liveMs: 420_000,
      invalidMs: 180_000,
      invalidation: { atSimMs: 420_000, reason: "expired" },
      cause: "expired",
    };
    expect(policyLabel("jev", null)?.text).toBe("Checking Jev");
    expect(policyLabel("jev", cleanRun)?.text).toBe("Jev");
    // The contract forbids fallback time; the label still names the controller,
    // and the run's own record is what states the violation (fallbackMs, and
    // the release gate that refuses such a run).
    expect(policyLabel("jev", onFallback)?.text).toBe("Jev");
    expect(policyLabel("jev", noPolicy)?.text).toBe("Waiting for Jev");
    expect(policyLabel("jev", invalidated)?.text).toBe("Jev · run invalidated");
    expect(policyLabel("jev", { ...cleanRun, source: "replay", liveMs: 0, replayMs: 595_000 })?.text).toBe(
      "Replay",
    );
    expect(policyLabel("fixed", null)?.text).toBe("Fixed");
    expect(policyLabel("adaptive", null)?.text).toBe("Adaptive");
    expect(COMPARISON_COLUMNS).toEqual(["Fixed", "Adaptive", "Jev"]);
  });
});

/* ---------------- 3. ungoverned time stays in the run's record ------------ */

describe("ungoverned time stays in the run's record, not on the public label", () => {
  it("keeps every ungoverned share in the record and the label unqualified", () => {
    const at = (invalidMs: number): PresentationPolicy => ({
      source: "live",
      liveMs: 600_000 - invalidMs,
      replayMs: 0,
      fallbackMs: 0,
      invalidMs,
      accepted: 100,
      rejected: 1,
      refreshes: 101,
    });
    // A sub-percent share and half the run carry the same public name; the
    // record is what tells them apart, to the millisecond.
    expect(policyLabel("jev", at(100))?.text).toBe("Jev");
    expect(policyLabel("jev", at(0))?.text).toBe("Jev");
    expect(policyLabel("jev", at(300_000))?.text).toBe("Jev");
    expect(policyLabel("jev", at(300_000))?.detail).not.toContain("%");
    expect(ungovernedShare(at(100))).toBeCloseTo(100 / 600_000, 9);
    expect(ungovernedShare(at(300_000))).toBeCloseTo(0.5, 6);
    // A run that never had a live answer is not a Jev run at all: it is either
    // still waiting for its first policy, or invalidated.
    expect(policyLabel("jev", { ...at(600_000), accepted: 0, source: "waiting" })?.text).toBe(
      "Waiting for Jev",
    );
    expect(
      policyLabel("jev", {
        ...at(600_000),
        accepted: 1,
        liveMs: 0,
        source: "invalidated",
        invalidation: { atSimMs: 0, reason: "expired" },
      })?.text,
    ).toBe("Jev · run invalidated");
  });

  it("carries the provenance on every frame and on the final result", () => {
    const built = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 120 },
        { angleDeg: 90, length: 120 },
        { angleDeg: 180, length: 120 },
        { angleDeg: 270, length: 120 },
      ],
    });
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.2 }),
    };
    const controller = createJevController({ client, scenarioFingerprint: fingerprintForRun(SCENARIO), refreshMs: 500 });
    const engine = createEngine({ city: built.city, controller, spawns: [] });
    const partition = buildCityPartition(built.city);
    // The startup gate: the run begins under the accepted policy, so no
    // simulated instant is ever ungoverned.
    const started = controller.start({
      frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
      partition,
      intersections: engine.city.intersections.length,
      activeVehicles: engine.traffic.vehicles.length,
    });
    expect(typeof started === "object" && "state" in started && started.state).toBe("ready");
    for (let tick = 0; tick < 20; tick += 1) {
      controller.directives(engine.city, engine.traffic, {
        observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
        partition,
      });
      stepEngine(engine);
    }
    // Exactly the shape the presentation layer publishes.
    const meta = controller.meta();
    const policy: PresentationPolicy = {
      source: meta.source,
      liveMs: meta.liveMs,
      replayMs: meta.replayMs,
      fallbackMs: meta.fallbackMs,
      invalidMs: meta.invalidMs,
      heldMs: meta.heldMs,
      maxHoldMs: meta.maxHoldMs,
      adaptiveTicks: meta.adaptiveTicks,
      accepted: meta.accepted,
      rejected: meta.rejected,
      refreshes: meta.refreshes,
      cause: meta.cause,
      causes: meta.causes,
      clamped: meta.clamped,
      dropped: meta.dropped,
      invalidation: meta.invalidation,
    };
    const snapshot = buildPresentationSnapshot(engine, 0, SCENARIO.tripId, policy);
    expect(snapshot.policy).toEqual(policy);
    expect(["live", "replay", "waiting", "invalidated"]).toContain(snapshot.policy?.source);
    for (const value of [policy.liveMs, policy.replayMs, policy.fallbackMs, policy.invalidMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(policy.accepted).toBeGreaterThan(0);
    // The gate means the run starts under Jev: no fallback time, no Adaptive
    // tick, no ungoverned instant — and the label may say plain Jev.
    expect(policy.fallbackMs).toBe(0);
    expect(policy.adaptiveTicks).toBe(0);
    expect(policy.invalidMs).toBe(0);
    expect(policyLabel("jev", policy)?.text).toBe("Jev");
    // A controller with no external policy reports nothing at all.
    const plain = createEngine({ city: built.city, controller: createAdaptiveController(), spawns: [] });
    expect(buildPresentationSnapshot(plain, 0, SCENARIO.tripId).policy).toBeNull();
  });
});

/* --------------------------------------- 4. a touched run is marked --- */

describe("a run a human changed is not shown beside clean baselines", () => {
  function result(overrides: Partial<ChallengeResult> = {}): ChallengeResult {
    return {
      fingerprint: "abc12345",
      controller: "jev",
      driver: "tourist",
      manualIncidents: 0,
      modified: false,
      simulatedMs: LIVE_RUN_HORIZON_MS,
      trip: {
        completed: true,
        tripTimeMs: 300_000,
        stoppedMs: 40_000,
        distanceM: 4_896,
        averageSpeedMps: 16,
        rerouteCount: 0,
      },
      city: {
        averageWaitMs: 90_000,
        p95WaitMs: 261_000,
        completedTrips: 1_084,
        throughputPerMinute: 108.4,
        gridlockRatio: 0.36,
        activeVehicles: 900,
      },
      ...overrides,
    };
  }
  const fixed = result({ controller: "fixed", fingerprint: "same0001" });
  const adaptive = result({ controller: "adaptive", fingerprint: "same0001" });
  const jev = result({ fingerprint: "same0001" });

  it("compares three clean runs of one scenario", () => {
    expect(comparisonVerdictAll([fixed, adaptive, jev])).toEqual({ comparable: true });
    const rows = comparisonRows(fixed, adaptive, jev);
    expect(rows.map((row) => row.label)).toContain("Arrived");
    expect(rows.map((row) => row.label)).toContain("Throughput");
  });

  it("refuses a run touched by hand, in any of the three columns", () => {
    expect(comparisonVerdictAll([fixed, adaptive, result({ fingerprint: "same0001", manualIncidents: 1 })]))
      .toEqual({ comparable: false, reason: "a run was changed by hand" });
    expect(comparisonVerdictAll([fixed, adaptive, result({ fingerprint: "same0001", modified: true })]))
      .toEqual({ comparable: false, reason: "the scenario changed mid-run" });
    // A different scenario is a different experiment, not a comparison.
    expect(comparisonVerdictAll([fixed, adaptive, result({ fingerprint: "other000", })])).toEqual({
      comparable: false,
      reason: "different scenarios",
    });
  });

  it("keeps the worker's result metadata tied to the run it describes", () => {
    const worker = source("worker/simulation.worker.ts");
    // The final result and every frame carry the same provenance, taken from
    // the controller's own meta() — never a guess assembled in the UI.
    expect(worker).toContain("policy: policyProvenance(),");
    expect(worker).toContain("policyProvenance(),\n      { modified: state.modified, manualIncidents: state.manualIncidents },");
    expect(worker).toContain("});\n  state.snapshotSequence += 1;");
    expect(worker).toContain("function policyProvenance(): PresentationPolicy | null {");
    // The controller id in the frames is the engine's own.
    expect(source("worker/presentation-snapshot.ts")).toContain("controller: engine.controller.id,");
  });

  it("marks the run modified when a live command changes it", () => {
    const worker = source("worker/simulation.worker.ts");
    // Both mid-run mutations set the flag, and it reaches the result.
    expect(worker.match(/state\.modified = true;/g)).toHaveLength(2);
    expect(worker).toContain("state.manualIncidents,\n        state.modified,");
    expect(worker).toContain("state.modified = false;");
  });
});

/* ------------------------------------------ 5. the payoff never strands --- */

describe("the payoff does not depend on one delivery of the baselines", () => {
  const base = {
    runComplete: true,
    hasBaselines: false,
    fingerprint: "abc12345",
    askedFingerprint: "abc12345",
    msSinceAsk: BASELINES_REGRACE_MS + 1,
    alreadyReasked: false,
  };

  it("asks once more only when the run is over and the answer never came", () => {
    expect(shouldReaskBaselines(base)).toBe(true);
    // Still running: the baselines may simply not be needed yet.
    expect(shouldReaskBaselines({ ...base, runComplete: false })).toBe(false);
    // They arrived: nothing to do.
    expect(shouldReaskBaselines({ ...base, hasBaselines: true })).toBe(false);
    // Too soon to conclude anything is wrong.
    expect(shouldReaskBaselines({ ...base, msSinceAsk: BASELINES_REGRACE_MS - 1 })).toBe(false);
    // Exactly at the grace period the answer is due.
    expect(shouldReaskBaselines({ ...base, msSinceAsk: BASELINES_REGRACE_MS })).toBe(true);
    // Never re-ask the same scenario twice, and never ask for another one.
    expect(shouldReaskBaselines({ ...base, alreadyReasked: true })).toBe(false);
    expect(shouldReaskBaselines({ ...base, askedFingerprint: "other000" })).toBe(false);
    expect(shouldReaskBaselines({ ...base, fingerprint: null })).toBe(false);
  });

  it("is wired: READY records what was asked, and the payoff re-asks once", () => {
    const simulator = source("components/TrafficSimulator.tsx");
    expect(simulator).toContain("baselinesAskedRef.current = {");
    expect(simulator).toContain("baselinesReaskedRef.current === asked.fingerprint");
    expect(simulator).toContain("baselinesRef.current?.postMessage(asked.request);");
    expect(simulator).toContain("shouldReaskBaselines({");
  });
});
