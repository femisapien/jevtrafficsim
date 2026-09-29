/**
 * Playback-rate probe: measured multiplier the shipped worker cadence
 * achieves on this machine, and the arithmetic behind it.
 *
 * The worker runs `PLAYBACK_STEPS_PER_TICK` engine steps per real tick and
 * schedules the next tick with `setTimeout(SIM_TICK_MS - tickCost)` so the
 * period stays at SIM_TICK_MS whenever the tick fits inside it (see
 * `scheduleNextTick` in worker/simulation.worker.ts). Without the
 * compensation the period drifts to SIM_TICK_MS + tickCost, which is what
 * measured 6.0-6.4x instead of the designed 8x.
 *
 *   pnpm tsx tools/playback-rate-probe.ts
 *
 * Prints:
 *   - measured wall cost of one real tick (8 engine steps, Metro city);
 *   - the multiplier the naive schedule would produce (cost not subtracted);
 *   - the multiplier the shipped schedule produces (cost subtracted);
 *   - a direct wall-clock run of the compensated schedule for ~10 s, with the
 *     simulated milliseconds advanced per real second.
 *
 * This probe changes nothing in the simulation: it only steps the engine the
 * way the worker does and reads performance.now().
 */
import { performance } from "node:perf_hooks";
import { loadBenchmarkModel } from "@/benchmark/model";
import { CURATED_TRIPS } from "@/cities/chicago-trips";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createEngine, stepEngine } from "@/sim/engine";
import { generateDemand } from "@/sim/demand";
import { PLAYBACK_STEPS_PER_TICK, SIM_TICK_MS } from "@/worker/protocol";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";

const SEED = 42;
const TRAFFIC = "rush-hour" as const;

async function main(): Promise<void> {
  const model = await loadBenchmarkModel();
  const tripId = "millennium-park-to-west-loop";
  const challenge = materializeChallengeTrip(model, tripId, SEED);
  const scenario = buildChallengeScenario({
    tripId,
    trafficLevel: TRAFFIC,
    driver: "tourist",
    seed: SEED,
    durationMs: 600_000,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  const spawns = [
    challenge.spawn,
    ...generateDemand({
      city: model.city,
      level: TRAFFIC,
      seed: world.demandSeed,
      durationMs: 600_000,
    }),
  ];
  const engine = createEngine({
    city: model.city,
    controller: createAdaptiveController(),
    spawns,
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [] },
  });

  // 1) Warm up, then measure one tick = PLAYBACK_STEPS_PER_TICK steps.
  const WARMUP_TICKS = 25;
  const MEASURED_TICKS = 40;
  for (let i = 0; i < WARMUP_TICKS; i += 1) {
    for (let s = 0; s < PLAYBACK_STEPS_PER_TICK; s += 1) stepEngine(engine);
  }
  const started = performance.now();
  for (let i = 0; i < MEASURED_TICKS; i += 1) {
    for (let s = 0; s < PLAYBACK_STEPS_PER_TICK; s += 1) stepEngine(engine);
  }
  const tickCostMs = (performance.now() - started) / MEASURED_TICKS;

  const simMsPerTick = PLAYBACK_STEPS_PER_TICK * SIM_TICK_MS;
  const naiveRate = simMsPerTick / (SIM_TICK_MS + tickCostMs);
  const compensatedRate = simMsPerTick / Math.max(SIM_TICK_MS, tickCostMs);

  console.log(`model       : Metro (scale ${model.scaleIndex})`);
  console.log(`trip        : ${CURATED_TRIPS.find((t) => t.id === tripId)?.label}`);
  console.log(`measured tick cost (${PLAYBACK_STEPS_PER_TICK} steps): ${tickCostMs.toFixed(2)} ms`);
  console.log(`naive schedule rate      : ${naiveRate.toFixed(2)}x  (documented 6.0-6.4x)`);
  console.log(`compensated schedule rate: ${compensatedRate.toFixed(2)}x  (designed 8x)`);

  // 2) Direct evidence: run the compensated schedule for ~10 s of wall time
  //    and count simulated ms advanced per wall second.
  const engine2 = createEngine({
    city: model.city,
    controller: createAdaptiveController(),
    spawns: [
      challenge.spawn,
      ...generateDemand({
        city: model.city,
        level: TRAFFIC,
        seed: world.demandSeed,
        durationMs: 600_000,
      }),
    ],
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [] },
  });
  const wallBudgetMs = 10_000;
  const wall0 = performance.now();
  let simElapsedMs = 0;
  let lastCostMs = 0;
  const run = () =>
    new Promise<void>((resolve) => {
      const tick = (): void => {
        if (performance.now() - wall0 >= wallBudgetMs) {
          resolve();
          return;
        }
        const tickStart = performance.now();
        for (let s = 0; s < PLAYBACK_STEPS_PER_TICK; s += 1) stepEngine(engine2);
        lastCostMs = performance.now() - tickStart;
        simElapsedMs += PLAYBACK_STEPS_PER_TICK * SIM_TICK_MS;
        setTimeout(tick, Math.max(0, SIM_TICK_MS - lastCostMs));
      };
      tick();
    });
  await run();
  const wallElapsedMs = performance.now() - wall0;
  const achievedRate = simElapsedMs / wallElapsedMs;
  console.log(
    `direct paced run: ${(wallElapsedMs / 1000).toFixed(1)} s wall advanced ` +
      `${(simElapsedMs / 1000).toFixed(1)} s simulated = ${achievedRate.toFixed(2)}x`,
  );
  console.log(
    achievedRate >= 7.0
      ? "RESULT: close to the designed 8x (>7x)."
      : "RESULT: below 7x; the compensation alone is not enough on this machine.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});