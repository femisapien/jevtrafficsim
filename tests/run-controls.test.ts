/**
 * The run's two controls (final polish pass): "Skip to end" and "3× speed".
 *
 * What is pinned here is the honesty of both, not their pixels:
 *
 *   1. PACING IS NOT THE RUN. A drive finished early, and a drive watched 3×
 *      faster, run the SAME engine steps in the SAME order as the normal one —
 *      proven against the same scenario, so the result a skipped or accelerated
 *      run reports is the result its own steps produced. Nothing about how fast
 *      someone watched can reach the payoff.
 *   2. SKIP TO END IS NOT AN ARRIVAL. The worker's skip rides the tail that the
 *      arrival tail already uses, and finishes through the ONE completion
 *      sequence — so the arrival/completion frame, the baselines request and the
 *      payoff fire exactly as they do for a watched run, and an ego that never
 *      arrives is reported as never having arrived.
 *   3. NEITHER IS A MODE. No new modification of the run (comparability flags
 *      untouched), no substitution (the service budget is unchanged and no
 *      Adaptive path is added anywhere), and nothing is offered before the
 *      startup gate has passed, where there is nothing to skip.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  comparisonVerdictAll,
  type ChallengeResult,
} from "@/worker/challenge-result";
import {
  JEV_SERVICE_MAX_PER_WINDOW,
  JEV_SERVICE_MIN_SPACING_MS,
} from "@/jev/scheduler";
import { JEV_RUNTIME_DEFAULTS } from "@/jev/runtime";
import { SIMULATION_TIMESTEP_MS } from "@/sim/config";
import {
  buildChallengeScenario,
  fingerprintForRun,
} from "@/worker/challenge-scenario";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildChallengeResult } from "@/worker/challenge-result";
import { loadBenchmarkModel } from "@/benchmark/model";
import {
  LIVE_RUN_HORIZON_MS,
  PLAYBACK_SPEEDS,
  PLAYBACK_STEPS_PER_TICK,
  SIM_TICK_MS,
  SKIP_STEPS_PER_TICK,
  type PlaybackSpeed,
} from "@/worker/protocol";
import {
  RUN_STOPPED_TITLE,
  SKIP_TO_END_LABEL,
  SPEED_LABEL,
  comparisonRows,
  nextPlaybackSpeed,
  runControlsVisible,
  waitingPanelState,
} from "@/components/ui-model";

const TRIP_ID = "soldier-field-to-navy-pier" as const;
const SEED = 42;
const TRAFFIC = "everyday" as const;

/** The worker's own composition of a run, minus the presentation and incidents. */
function scenarioDrive(): {
  step: () => void;
  engine: EngineState;
  result: () => ChallengeResult;
} {
  const model = loadBenchmarkModel();
  const challenge = materializeChallengeTrip(model, TRIP_ID, SEED);
  const background = productionDemand({
    city: model.city,
    level: TRAFFIC,
    seed: SEED,
    durationMs: LIVE_RUN_HORIZON_MS,
  });
  const engine = createEngine({
    city: model.city,
    controller: createFixedController(),
    spawns: [challenge.spawn, ...background],
    driver: "tourist",
  });
  const scenario = buildChallengeScenario({
    tripId: TRIP_ID,
    trafficLevel: TRAFFIC,
    driver: "tourist",
    seed: SEED,
    durationMs: LIVE_RUN_HORIZON_MS,
  });
  return {
    engine,
    step: () => stepEngine(engine),
    result: () => buildChallengeResult(engine, scenario, "fixed", 0, false),
  };
}

/** Everything about the world that a step can move. */
function stateSignature(engine: EngineState): string {
  return JSON.stringify({
    timeMs: engine.traffic.timeMs,
    ego: engine.egoVehicleId,
    vehicles: engine.traffic.vehicles,
    signals: [...engine.traffic.signals.entries()],
    occupancy: [...engine.traffic.occupancy.entries()],
    arrived: engine.traffic.arrivedQueue.length,
  });
}

/* ------------------------------------- 1. pacing is not the run ------------ */

describe("how fast a run is watched cannot change what it produces", () => {
  /**
   * The same number of engine steps, grouped the three ways this app groups
   * them: one step at a time (nothing), the normal playback
   * (PLAYBACK_STEPS_PER_TICK), 3× that (the speed control), and the whole
   * remaining horizon back to back (skip / arrival tail).
   */
  it("produces an identical world for 1, 8, 24 and unpaced steps per tick", () => {
    const TOTAL_STEPS = 1_500; // 150 s of simulated time
    const drive = (stepsPerTick: number): { signature: string; result: ChallengeResult } => {
      const { engine, step, result } = scenarioDrive();
      let done = 0;
      while (done < TOTAL_STEPS) {
        for (let index = 0; index < stepsPerTick && done < TOTAL_STEPS; index += 1) {
          step();
          done += 1;
        }
      }
      return { signature: stateSignature(engine), result: result() };
    };

    const paced = drive(PLAYBACK_STEPS_PER_TICK);
    const fast = drive(PLAYBACK_STEPS_PER_TICK * PLAYBACK_SPEEDS[1]);
    const single = drive(1);
    const unpaced = drive(TOTAL_STEPS);

    expect(fast.signature).toBe(paced.signature);
    expect(single.signature).toBe(paced.signature);
    expect(unpaced.signature).toBe(paced.signature);
    // ...and the payoff the run publishes is the same object either way: the
    // numbers are fields of the world the steps produced, never of the pacing.
    expect(fast.result).toEqual(paced.result);
    expect(unpaced.result).toEqual(paced.result);
    // A run watched faster is not a different experiment: same fingerprint, so
    // its baselines are still the same scenario's.
    expect(paced.result.fingerprint).toBe(fingerprintForRun({
      tripId: TRIP_ID,
      trafficLevel: TRAFFIC,
      driver: "tourist",
      seed: SEED,
      durationMs: LIVE_RUN_HORIZON_MS,
    }));
  });

  it("keeps the measured service budget exactly as it was", () => {
    // The speed control moves the wall-clock rate the same simulated refresh
    // grid asks at, so a faster run may be HELD more. What it may never do is
    // buy more requests: the budget below is the measured allowance, unchanged.
    expect(JEV_SERVICE_MAX_PER_WINDOW).toBe(4);
    expect(JEV_SERVICE_MIN_SPACING_MS).toBe(15_000);
  });
});

/* --------------------------------- 2. the two controls' rules -------------- */

describe("skip to end and 3× speed", () => {
  it("are offered only while a run is under way and can still honour them", () => {
    const running = {
      started: true,
      starting: false,
      failed: false,
      arrived: false,
      runComplete: false,
    };
    expect(runControlsVisible(running)).toBe(true);
    // Nothing to skip or speed up before the first policy: no simulated time is
    // passing while the startup gate is open.
    expect(runControlsVisible({ ...running, starting: true })).toBe(false);
    // A run that could not start, or that was stopped, is over.
    expect(runControlsVisible({ ...running, failed: true })).toBe(false);
    // Once the trip has arrived the rest of the horizon is the run's OWN tail,
    // and a parked car has no speed to watch.
    expect(runControlsVisible({ ...running, arrived: true })).toBe(false);
    expect(runControlsVisible({ ...running, runComplete: true })).toBe(false);
    // A preview with no frame yet has nothing to control.
    expect(runControlsVisible({ ...running, started: false })).toBe(false);
  });

  it("names them in words a visitor already knows", () => {
    expect(SKIP_TO_END_LABEL).toBe("Skip to end");
    expect(SPEED_LABEL).toBe("3× speed");
  });

  it("toggles between exactly two speeds, and never leaves them", () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([1, 3]);
    let speed: PlaybackSpeed = PLAYBACK_SPEEDS[0];
    for (let press = 0; press < 6; press += 1) {
      speed = nextPlaybackSpeed(speed);
      expect(PLAYBACK_SPEEDS).toContain(speed);
    }
    expect(nextPlaybackSpeed(PLAYBACK_SPEEDS[0])).toBe(PLAYBACK_SPEEDS[1]);
    expect(nextPlaybackSpeed(PLAYBACK_SPEEDS[1])).toBe(PLAYBACK_SPEEDS[0]);
  });

  it("never lets a run that stopped read as one that is finishing", () => {
    // The payoff panel is up from the arrival, so a run stopped in its last
    // stretch ("skip to end" that outran its policy's maximum hold, or any
    // other loss of Jev) must say so instead of promising a comparison that can
    // never come.
    expect(waitingPanelState({ error: null })).toBe("finishing");
    expect(
      waitingPanelState({ error: "Jev was lost at 8m 0s (…), so the run stopped there." }),
    ).toBe("stopped");
    expect(RUN_STOPPED_TITLE).toBe("Run stopped");
    const chrome = readFileSync(new URL("../components/SimChrome.tsx", import.meta.url), "utf8");
    expect(chrome).toContain("waitingPanelState({ error })");
    expect(chrome).toContain("{RUN_STOPPED_TITLE}");
    // And a stopped run is shown no comparison skeleton: there is no table
    // coming.
    expect(chrome).toContain('(panel === "waiting" && waiting === "finishing") || panel === "computing"');
  });

  it("prints a run that never arrived as never having arrived", () => {
    // A skip can leave the ego short of its destination (the horizon is the
    // experiment's length, not the trip's), and the payoff must not invent a
    // trip time for it.
    const fixed = resultStub("fixed", { completed: true, tripTimeMs: 300_000 });
    const adaptive = resultStub("adaptive", { completed: true, tripTimeMs: 320_000 });
    const skipped = resultStub("jev", { completed: false });
    const rows = comparisonRows(fixed, adaptive, skipped);
    const byLabel = (label: string) => rows.find((row) => row.label === label);
    expect(byLabel("Arrived")?.jev).toBe("No");
    expect(byLabel("Trip time")?.jev).toBe("—");
    expect(byLabel("Arrived")?.fixed).toBe("Yes");
    // And such a run is a complete result of its own scenario, not a failure of
    // the experiment: it compares against its baselines like any other.
    expect(comparisonVerdictAll([fixed, adaptive, skipped])).toEqual({ comparable: true });
  });
});

/* --------------------------------- 3. the wiring --------------------------- */

function workerSource(): string {
  return readFileSync(new URL("../worker/simulation.worker.ts", import.meta.url), "utf8");
}

function resultStub(
  controller: ChallengeResult["controller"],
  trip: { completed: boolean; tripTimeMs?: number },
): ChallengeResult {
  return {
    fingerprint: "same0001",
    controller,
    driver: "tourist",
    manualIncidents: 0,
    modified: false,
    simulatedMs: LIVE_RUN_HORIZON_MS,
    trip: {
      completed: trip.completed,
      tripTimeMs: trip.tripTimeMs ?? 0,
      stoppedMs: 0,
      distanceM: 0,
      averageSpeedMps: 0,
      rerouteCount: 0,
    },
    city: {
      averageWaitMs: 0,
      p95WaitMs: 0,
      completedTrips: 0,
      throughputPerMinute: 0,
      gridlockRatio: 0,
      activeVehicles: 0,
    },
  };
}

describe("the worker's half of both controls", () => {
  it("wires a skip through the paced loop, inside the coverage bound", () => {
    const worker = workerSource();
    // The skip raises the pace of the ORDINARY loop (same refresh grid, same
    // service budget, same completion sequence) rather than jumping into the
    // unpaced tail: that is what lets a skipped run finish instead of outrunning
    // the model.
    expect(worker).toContain("const watchedSteps = PLAYBACK_STEPS_PER_TICK * state.speed;");
    expect(worker).toContain("? Math.max(SKIP_STEPS_PER_TICK, watchedSteps)");
    expect(worker).toContain(
      "if (!state.skipToEnd && engine.traffic.timeMs < config.durationMs && egoArrived(engine)) {",
    );
    // The arrival tail is untouched, and there is still exactly ONE completion.
    expect(worker).toContain("control?.beginAcceleratedTail();");
    expect(worker).toContain("finishHorizon(engine, config.durationMs, control);");
    expect(worker.match(/type: "RUN_COMPLETE"/g)).toHaveLength(1);
    // 3× is more engine steps per real tick — the same steps, the same order.
    expect(worker).toContain("PLAYBACK_STEPS_PER_TICK * state.speed");
  });

  it("keeps the skip's pace inside the run's own coverage bound", () => {
    // The arithmetic the constant is derived from, pinned against the constants
    // it describes: one accepted policy may govern MAX_HOLD_CADENCES service
    // cadences of simulated time, and the wall-clock budget grants at most one
    // request per service spacing — so a pace above
    // (cadences x cadence) / spacing would expire the policy in force before its
    // replacement could be accepted, and a skipped run would be invalidated
    // instead of finished.
    const maxHoldSimMs = JEV_RUNTIME_DEFAULTS.SERVICE_CADENCE_SIM_MS * JEV_RUNTIME_DEFAULTS.MAX_HOLD_CADENCES;
    expect(maxHoldSimMs).toBe(480_000);
    const coverageBound = maxHoldSimMs / JEV_SERVICE_MIN_SPACING_MS;
    expect(coverageBound).toBe(32);
    // Simulated time the skip advances per service spacing of wall time.
    const simulatedPerSpacing = (SKIP_STEPS_PER_TICK * SIMULATION_TIMESTEP_MS * JEV_SERVICE_MIN_SPACING_MS) / SIM_TICK_MS;
    expect(SKIP_STEPS_PER_TICK).toBeGreaterThan(PLAYBACK_STEPS_PER_TICK);
    expect(simulatedPerSpacing).toBeLessThanOrEqual(maxHoldSimMs);
    // A quarter of the bound is left as margin for a late answer or a tick that
    // overruns; anything at or above the bound itself would race the service.
    expect(SKIP_STEPS_PER_TICK).toBeLessThanOrEqual(coverageBound * 0.75);
  });

  it("refuses a skip while the startup gate is open, and fabricates nothing", () => {
    const worker = workerSource();
    // The gate has its own flag, and a skip asked for during it does nothing:
    // no simulated millisecond has passed, so there is no run to finish.
    expect(worker).toMatch(/case "SKIP_TO_END"[\s\S]{0,400}?if \(state\.awaitingPolicy\) \{/);
    // Neither control can modify the run, and neither touches the service gate:
    // a run watched faster spends the same wall-clock budget, so it may simply
    // be HELD more — reported as held, never hidden.
    for (const command of ["SKIP_TO_END", "SET_SPEED"]) {
      const body = worker.slice(
        worker.indexOf(`case "${command}"`),
        worker.indexOf('case "', worker.indexOf(`case "${command}"`) + 10),
      );
      expect(body).not.toContain("state.modified = true");
      expect(body).not.toContain("serviceGate");
      expect(body).not.toContain("createAdaptiveController");
      expect(body).not.toContain("beginAcceleratedTail");
    }
    // Neither control is wired into the policy runtime or the wall-clock
    // scheduler: the pure-Jev path and the measured budget are untouched.
    for (const file of ["../jev/runtime.ts", "../jev/scheduler.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain("SKIP_TO_END");
      expect(source).not.toContain("skipToEnd");
    }
  });
});
