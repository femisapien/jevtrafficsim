/**
 * Chicago Metro performance guards (Phase 1 §31, rebuilt for Issue #40).
 *
 * The old guard was three things the review correctly called out: 600 ticks (too
 * short for history to accumulate), an absolute per-step budget loose enough to
 * pass while the late run degraded, and no comparison between early and late at
 * all. It could not have caught the bug it was supposed to catch.
 *
 *   Test 1 runs a real 6 000-tick rush hour and checks that it really
 *   accumulated history, stayed invariant-clean, and stayed inside the
 *   machine-scaled cost guards.
 *
 *   Test 2 is the instrument for the invariant itself: pad canonical HISTORY
 *   behind the same live traffic and prove a step does not get slower.
 *
 * ## Why the old growth ratio was retired (measured)
 *
 * The old assertion compared the median step cost of ticks 2 000–3 000 with that
 * of ticks 5 000–6 000 — two windows ~40 s of wall-clock apart — and required
 * `late / mid < 1.5 × (live / midLive)`. Both halves are measured under whatever
 * load the runner happened to be under, and the measurements say the bound was
 * therefore reporting the runner:
 *
 *   - the same code, three CI runs of the same commit range: growth 1.98×, 2.11×
 *     and 2.50× against the 2.42× bound. The failing run's mid window was the
 *     FASTEST of the three (1.36 µs/step/live-vehicle vs 1.53 and 1.67) and its
 *     late window was mid-pack (2.11 vs 1.87 and 2.18): the ratio moved, the code
 *     did not, and its per-live cost was no worse than the green run's;
 *   - this machine, same code, byte-identical simulation (`live=11106 (mid 6880)
 *     arrived=4681` in every run) with CPU load as the only variable: growth
 *     1.49× quiet, 2.09× at load 11, 8.08× at load 51;
 *   - the noise is not small relative to the claim: the history term is ~13% of a
 *     late step, so restoring the pre-#40 history sweeps moves that growth ratio
 *     by about 1% — far inside the runner's own ±25% swing on the same runner.
 *
 * Same-tick variants were measured before landing here, and rejected on their
 * numbers: comparing the late run against a mid-run twin in one epoch (per-live
 * creep) is structurally blind — both arms carry the same history-per-live-vehicle
 * burden to within ~10%, so a restored-history regression moved it by <2%, and its
 * baseline drifted 0.75 → 0.99 with load; and normalising the padded/real step
 * cost at the late fleet (11 106 live) produced a baseline of 1.29–1.83 with a
 * ±15–30% run-to-run spread — bigger than the regression's own signal, because
 * 11 106 live vehicles dominate a step and the padding needed to see the history
 * term at all perturbs the heap.
 *
 * ## What test 2 asserts
 *
 * Two engines of the same scenario, stepped tick for tick, so live traffic and
 * the RNG sequence are identical; one gets extra arrived vehicles in canonical
 * history. Same tick, same fleet, same epoch — a runner whose speed moves moves
 * both arms together, which is why its ratio has been stable to 1.01–1.08× on
 * CI runners whose absolute per-step cost swung 1.7× between runs (6.57 ms vs
 * 3.90 ms, same code).
 *
 * The padding is a microscope: it amplifies a per-arrival cost that is invisible
 * next to live traffic. Two paddings are asserted, the original 8 000 (bound
 * 1.25, unchanged since it was calibrated against the pre-#40 engine's 1.441)
 * and a harder 100 000, because the engine has grown heavier per live vehicle
 * since that calibration and the smaller padding can no longer see a partial
 * reintroduction of the #40 sweeps.
 *
 * ## What is deliberately NOT asserted
 *
 * The old ratio's other half — "cost may not grow faster than the fleet" — has no
 * assertion, with numbers: the arms of any same-epoch pair in this scenario
 * differ by 1.6× in live traffic but carry the same live cost per vehicle to
 * within ~10%, so such a bound trips only on a regression worth roughly +250% of
 * a late step, while the runner crosses it by load alone. The machine-scaled
 * guards below (per-live-vehicle budget, and the two catastrophe tripwires) cover
 * that class instead.
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { checkTrafficInvariants, spawnVehicle, vehicleById } from "@/sim/traffic";
import { chicagoAsset, chicagoModel } from "./chicago-support";

const RUSH = "rush-hour" as const;
const HORIZON_MS = 600_000;
const TICKS = HORIZON_MS / 100;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function liveVehicles(engine: EngineState): number {
  let live = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state !== "arrived") live += 1;
  }
  return live;
}

function rushEngine(seed = 7, withEgo = false): EngineState {
  const model = chicagoModel(4);
  const spawns = productionDemand({ city: model.city, level: RUSH, seed, durationMs: HORIZON_MS });
  if (withEgo) {
    // One protagonist, exactly as the challenge harness spawns it: the ego is a
    // scheduled spawn with a role, routed by the engine.
    spawns.unshift({
      timeMs: 0,
      type: "car",
      origin: 0,
      destination: model.city.intersections.length - 1,
      role: "ego",
    });
  }
  return createEngine({ city: model.city, controller: createAdaptiveController(), spawns });
}

/** Appends `count` arrived vehicles to canonical history only. */
function padHistory(engine: EngineState, count: number): void {
  for (let index = 0; index < count; index += 1) {
    spawnVehicle(engine.city, engine.traffic, {
      // Sequential id, as the allocator requires; a route-less spawn is born
      // arrived, so it lands in canonical history only.
      id: engine.traffic.vehicles.length,
      type: "car",
      origin: 0,
      destination: 0,
      route: [],
      spawnTimeMs: engine.traffic.timeMs,
    });
  }
}

describe("Chicago Metro performance", () => {
  it(
    "keeps late-run step cost inside the machine-scaled guards (6 000-tick rush hour)",
    { timeout: 300_000 },
    () => {
      const engine = rushEngine();
      const windows = {
        mid: [] as number[],
        late: [] as number[],
      };
      const third = Math.floor(TICKS / 3);
      let midLive = 0;
      for (let tick = 0; tick < TICKS; tick += 1) {
        const started = performance.now();
        stepEngine(engine);
        const elapsed = performance.now() - started;
        if (tick >= third && tick < third + 1_000) windows.mid.push(elapsed);
        if (tick === third + 1_000) midLive = liveVehicles(engine);
        if (tick >= TICKS - 1_000) windows.late.push(elapsed);
      }

      const live = liveVehicles(engine);
      const arrived = engine.traffic.vehicles.length - live;
      const midMedian = median(windows.mid);
      const lateMedian = median(windows.late);
      // Reported for comparability with earlier runs. NOT asserted: the two
      // windows are sampled ~40 s apart, so on a shared runner the quotient
      // reports the runner's load rather than the code (file header). The
      // invariant itself is asserted in the lockstep test below.
      const growth = lateMedian / Math.max(1e-6, midMedian);
      const liveMicrosPerStep = ((lateMedian * 1_000) / Math.max(1, live));

      console.log(
        `[metro rush 6000 ticks] mid=${midMedian.toFixed(3)}ms late=${lateMedian.toFixed(3)}ms ` +
          `growth=${growth.toFixed(2)}× live=${live} (mid ${midLive}) arrived=${arrived} ` +
          `${liveMicrosPerStep.toFixed(1)}µs/step/live-vehicle p95=${percentile(windows.late, 0.95).toFixed(3)}ms`,
      );

      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
      // The run really accumulated history: without this the ratios are vacuous.
      expect(arrived).toBeGreaterThan(1_500);
      expect(engine.traffic.vehicles.length).toBeGreaterThan(3_500);
      // Per-live-vehicle work must not creep upwards. This is a budget, not a
      // ratio: it scales with the machine, and it is documented as such. The same
      // code has measured 0.7–0.9 µs locally and 1.9–2.2 µs across CI runs.
      expect(liveMicrosPerStep).toBeLessThan(6);
      // Catastrophe tripwires only: these DO measure the machine. The same code's
      // late median was 20.8 / 23.4 / 24.2 ms and its p95 27.3 / 27.8 / 29.4 ms
      // across three CI runs of the same commit range, and 2× CPU oversubscription
      // on a 12-core workstation produced 22.1 ms late / 64.0 ms p95. They sit ~3×
      // above the slowest observed runner so a busy runner cannot fail the build,
      // while a step orders of magnitude slower than that still does.
      expect(lateMedian).toBeLessThan(75);
      expect(percentile(windows.late, 0.95)).toBeLessThan(150);
    },
  );

  it(
    "does not slow down when thousands of arrived vehicles are added to history",
    { timeout: 120_000 },
    () => {
      // Lockstep control: two engines of the SAME scenario, stepped tick for
      // tick, so the live population and the RNG sequence are identical. One
      // gets extra arrived vehicles in canonical history; the other does not.
      // Any difference in step cost is therefore caused by history alone — which
      // is exactly the invariant, and it needs no absolute threshold.
      const control = rushEngine(11);
      const padded = rushEngine(11);
      const paddedHard = rushEngine(11);
      for (let tick = 0; tick < 400; tick += 1) {
        stepEngine(control);
        stepEngine(padded);
        stepEngine(paddedHard);
      }

      const PADDING = 8_000;
      const PADDING_HARD = 100_000;
      padHistory(padded, PADDING);
      padHistory(paddedHard, PADDING_HARD);

      const controlSamples: number[] = [];
      const paddedSamples: number[] = [];
      const paddedHardSamples: number[] = [];
      for (let tick = 0; tick < 300; tick += 1) {
        const controlStart = performance.now();
        stepEngine(control);
        controlSamples.push(performance.now() - controlStart);
        const paddedStart = performance.now();
        stepEngine(padded);
        paddedSamples.push(performance.now() - paddedStart);
        const hardStart = performance.now();
        stepEngine(paddedHard);
        paddedHardSamples.push(performance.now() - hardStart);
      }

      const controlMedian = median(controlSamples);
      const paddedMedian = median(paddedSamples);
      const paddedHardMedian = median(paddedHardSamples);
      const growth = paddedMedian / Math.max(1e-6, controlMedian);
      const growthHard = paddedHardMedian / Math.max(1e-6, controlMedian);
      console.log(
        `[history invariance] history ${control.traffic.vehicles.length} vs ${padded.traffic.vehicles.length} ` +
          `vs ${paddedHard.traffic.vehicles.length} (live ${padded.traffic.activeVehicles.size} both) ` +
          `median ${controlMedian.toFixed(3)}ms vs ${paddedMedian.toFixed(3)}ms vs ${paddedHardMedian.toFixed(3)}ms ` +
          `growth=${growth.toFixed(2)}× growthHard=${growthHard.toFixed(2)}×`,
      );

      expect(checkTrafficInvariants(padded.city, padded.traffic)).toEqual([]);
      expect(checkTrafficInvariants(paddedHard.city, paddedHard.traffic)).toEqual([]);
      expect(checkTrafficInvariants(control.city, control.traffic)).toEqual([]);
      // The padding is real and enormous: more vehicles than a whole run spawns.
      expect(padded.traffic.vehicles.length - control.traffic.vehicles.length).toBe(PADDING);
      expect(paddedHard.traffic.vehicles.length - control.traffic.vehicles.length).toBe(PADDING_HARD);
      // All three runs are the same scenario at the same simulated time: same
      // live population, so the comparisons are apples to apples.
      expect(padded.traffic.timeMs).toBe(control.traffic.timeMs);
      expect(paddedHard.traffic.timeMs).toBe(control.traffic.timeMs);
      expect(padded.traffic.activeVehicles.size).toBe(control.traffic.activeVehicles.size);
      expect(paddedHard.traffic.activeVehicles.size).toBe(control.traffic.activeVehicles.size);
      // THE invariant: extra arrived vehicles must not make a step slower.
      // Measured on this machine: pre-#40 engine 1.441× (0.761 → 1.096 ms), with
      // the live index 1.133× (0.758 → 0.859 ms). The residual ~0.10 ms is heap
      // and GC pressure from keeping canonical history, which the issue requires
      // keeping. The bound sits between the two — 1.25 — so it fails the old
      // engine and passes the new one without measuring the CI machine.
      expect(growth).toBeLessThan(1.25);
      // The same claim with a microscope 12× stronger, because the engine is
      // heavier per live vehicle than it was when the 1.25 above was calibrated:
      // at 8 000 the padding is only ~3% of a step, so a partial reintroduction of
      // the #40 sweeps lands inside this test's noise band (measured: 1.14×).
      // Measured, 300-tick medians of the same arms:
      //   post-#40 code   1.61–1.67× here, 2.28× on the CI runner
      //   pre-#40 shape   2.87×  (per-tick metrics, approach stats, observations
      //   and arrival accounting all sweeping canonical history again)
      // The gap between those two machines is real and is what sets the bound: a
      // padded arm pays per history ENTRY scanned, and a runner with slower memory
      // pays ~1.9× more of that per step than this workstation does, so a bound
      // tuned only to the local reading (1.66) flaps on CI. 2.6 sits between the
      // CI's healthy 2.28 and the pre-#40 shape's 2.87: ~14% above the slowest
      // healthy reading seen, ~10% below the regression, with the regression
      // deterministic (2.87 ± 5% of run-to-run noise) so it still fails reliably.
      expect(growthHard).toBeLessThan(2.6);
    },
  );

  it("finds the ego in O(1) after a long run, arrived or not", { timeout: 120_000 }, () => {
    const engine = rushEngine(5, true);
    for (let tick = 0; tick < 1_200; tick += 1) {
      stepEngine(engine);
    }
    const egoId = engine.egoVehicleId;
    expect(egoId).not.toBeNull();
    const ego = vehicleById(engine.traffic, egoId);
    expect(ego).not.toBeNull();
    expect(ego!.id).toBe(egoId);
    // Same object as the canonical array position — ids ARE indices.
    expect(engine.traffic.vehicles[egoId!]).toBe(ego);
    // And the lookup is total: an id that was never allocated is simply absent.
    expect(vehicleById(engine.traffic, engine.traffic.vehicles.length + 10)).toBeNull();
    expect(vehicleById(engine.traffic, null)).toBeNull();
    // The live index agrees with a full scan, after thousands of arrivals.
    expect(engine.traffic.activeVehicles.size).toBe(liveVehicles(engine));
    expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
  });

  it("keeps Fixed control comparable to Adaptive on the same demand", () => {
    const model = chicagoModel(4);
    const spawns = productionDemand({ city: model.city, level: RUSH, seed: 7, durationMs: HORIZON_MS });
    for (const controller of [createFixedController(), createAdaptiveController()]) {
      const engine = createEngine({ city: model.city, controller, spawns });
      for (let tick = 0; tick < 300; tick += 1) {
        stepEngine(engine);
      }
      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
    }
  });

  it("imports the expected Metro scale", () => {
    const asset = chicagoAsset(4);
    expect(asset.counts.intersections).toBeGreaterThan(2000);
    expect(asset.counts.roads).toBeGreaterThan(4000);
    expect(asset.counts.bridges).toBeGreaterThan(100);
    expect(asset.counts.signals).toBeGreaterThan(500);
  });
});
