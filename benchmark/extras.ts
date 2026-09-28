/**
 * Benchmark extras: the engine metrics the benchmark document does not carry.
 *
 * `benchmark/cli.ts` records what a `ChallengeResult` carries — the trip and the
 * city, plus a Jev run's provenance. Three numbers the release matrix asks for
 * live in the engine's own metrics accumulator and are surfaced by no artifact:
 *
 *   signalPhaseChanges        stage/group transitions across all signals — how
 *                             much a controller actually re-timed a city. This
 *                             is the only controller-side number a Fixed or
 *                             Adaptive run has (neither exposes a status()), and
 *                             it is comparable across all three controllers;
 *   maxApproachWaitMs         the run's peak CONTINUOUS queue wait on any single
 *                             approach (the PRD §11.4 starvation watch, and the
 *                             policy input Adaptive and Jev both consume);
 *   averageRoadOccupancy /    occupancy units per directed road per tick
 *   maxRoadOccupancy          (saturation) and the peak on any single road
 *                             (spillback pressure), both from sim/metrics.ts.
 *
 * It also records what `scripts/route-completion-report.ts` calls a STUCK road —
 * a road whose queue head has been continuously blocked for `--stuck-wait` ms —
 * and the ego's final position for a trip that did not arrive, so an unfinished
 * route is reported as the place it stopped, never as a missing row.
 *
 * Nothing here changes the simulation, and there is no second simulation path:
 * the world comes from `buildScenarioRun` (the seam the app, the benchmark and
 * the fallback harness all share), the controller is built exactly as
 * `benchmark/cli.ts` builds it, and the run is driven by the same
 * startRunController -> runEngine -> finishRunController sequence as
 * `ScenarioRun.runUnder`. The trip and city blocks are produced by the SAME
 * `buildChallengeResult` the official artifact uses, so a cell here can be
 * checked field-by-field against the benchmark document it belongs to.
 *
 *   npx tsx benchmark/extras.ts --trips soldier-field-to-navy-pier --traffic rush-hour --driver tourist --seed 42
 *   npx tsx benchmark/extras.ts --controllers fixed,adaptive,jev --out results.json
 *
 * Deterministic: same matrix, same bytes. No wall clock enters the document.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBenchmarkModel } from "./model";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { createJevController, type JevController } from "@/controllers/jev";
import { createMockJevClient } from "@/jev/client";
import { currentQueueWaitMs } from "@/sim/approach-stats";
import { computeMetrics } from "@/sim/metrics";
import { createEngine, runEngine, type EngineState } from "@/sim/engine";
import type { TrafficController } from "@/controllers/contract";
import { buildChallengeResult } from "@/worker/challenge-result";
import { buildScenarioRun, finishRunController, startRunController } from "@/worker/challenge-compare";
import { LIVE_RUN_HORIZON_MS, type ControllerChoice } from "@/worker/protocol";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";

const USAGE = `Benchmark extras

Usage: npx tsx benchmark/extras.ts [options]

  --trips <id,...>        curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --traffic <l,...>       everyday | rush-hour (default: both)
  --driver <d,...>        tourist | local (default: both)
  --seed <n,...>          deterministic seeds (default: 42)
  --controllers <c,...>   fixed | adaptive | jev (default: all three; jev = mock)
  --horizon <ms|Ns|Nm>    simulated run length (default ${LIVE_RUN_HORIZON_MS})
  --stuck-wait <ms>       continuous queue-head wait that makes a road STUCK (default 120000)
  --out <path>            JSON output (default: stdout only)
  --quiet                 only the JSON path and the summary line
  --help                  this text

Trips: ${CURATED_TRIP_IDS.join(", ")}`;

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

function intArg(name: string, fallback: number, min: number): number {
  const raw = arg(name);
  if (raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (received "${raw}")`);
  }
  return value;
}

function horizonArg(): number {
  const raw = arg("--horizon");
  if (raw === null || raw === "") {
    return LIVE_RUN_HORIZON_MS;
  }
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) {
    throw new Error(`--horizon must be a duration like 600000, 600s or 10m (received "${raw}")`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  return unit === "ms" ? amount : unit === "s" ? amount * 1000 : amount * 60_000;
}

function listArg(name: string, fallback: readonly string[]): string[] {
  const raw = arg(name);
  if (raw === null || raw === "") {
    return [...fallback];
  }
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const horizonMs = horizonArg();
const stuckWaitMs = intArg("--stuck-wait", 120_000, 0);
const quiet = process.argv.includes("--quiet");
const outPath = arg("--out");

const tripIds = listArg("--trips", CURATED_TRIP_IDS) as CuratedTripId[];
for (const tripId of tripIds) {
  if (!(CURATED_TRIP_IDS as readonly string[]).includes(tripId)) {
    console.error(`unknown trip id "${tripId}"\n${USAGE}`);
    process.exit(2);
  }
}
const trafficLevels = listArg("--traffic", ["everyday", "rush-hour"]) as TrafficLevel[];
for (const level of trafficLevels) {
  if (level !== "everyday" && level !== "rush-hour") {
    console.error(`unknown traffic level "${level}"\n${USAGE}`);
    process.exit(2);
  }
}
const drivers = listArg("--driver", ["tourist", "local"]) as DriverStrategy[];
for (const driver of drivers) {
  if (driver !== "tourist" && driver !== "local") {
    console.error(`unknown driver "${driver}"\n${USAGE}`);
    process.exit(2);
  }
}
const seeds = listArg("--seed", ["42"]).map((entry) => {
  const seed = Number(entry);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    console.error(`--seed must be an integer in [0, 4294967295] (received "${entry}")`);
    process.exit(2);
  }
  return seed;
});
const controllers = listArg("--controllers", ["fixed", "adaptive", "jev"]) as ControllerChoice[];
for (const choice of controllers) {
  if (choice !== "fixed" && choice !== "adaptive" && choice !== "jev") {
    console.error(`unknown controller "${choice}"\n${USAGE}`);
    process.exit(2);
  }
}

/* ---------------------------------------------------------------- record --- */

/** The engine metrics that only this tool surfaces, plus the queue state. */
export interface ExtrasMetrics {
  /** Stage/group transitions across all signals. */
  readonly signalPhaseChanges: number;
  /** Peak over the run of the max continuous queue wait on any approach (ms). */
  readonly maxApproachWaitMs: number;
  /** Occupancy units per directed road, averaged over ticks. */
  readonly averageRoadOccupancy: number;
  /** Peak occupancy units on any single directed road (spillback pressure). */
  readonly maxRoadOccupancy: number;
  readonly failedSpawns: number;
}

/** The horizon's queue state, in the definitions route-completion-report uses. */
export interface ExtrasQueue {
  /** Roads whose queue head has been continuously blocked >= stuckWaitMs. */
  readonly stuckRoads: number;
  /** City-wide worst current wait over the whole active population. */
  readonly longestWaitMs: number;
  readonly queuedVehicles: number;
  readonly pendingVehicles: number;
  readonly activeVehicles: number;
}

/** What the ego was doing when the horizon arrived (for an unfinished trip). */
export interface ExtrasEgo {
  readonly state: string;
  readonly roadId: number | null;
  readonly roadKind: string | null;
  readonly routeIndex: number | null;
  readonly routeLength: number | null;
}

/** A Jev run's own account of its policy source; absent for the baselines. */
export interface ExtrasJevStatus {
  readonly adapter: string;
  readonly mode: string;
  readonly configured: boolean;
  readonly source: string;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly heldMs: number;
  readonly invalidMs: number;
  readonly fallbackMs: number;
  readonly adaptiveTicks: number;
  /** The startup gate's outcome: "ready:N" or "unable:<cause>:<detail>". */
  readonly start: string | null;
  readonly invalidation: string | null;
}

export interface ExtrasCell {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly controller: ControllerChoice;
  readonly fingerprint: string;
  readonly horizonMs: number;
  readonly trip: ReturnType<typeof buildChallengeResult>["trip"];
  readonly city: ReturnType<typeof buildChallengeResult>["city"];
  readonly extras: ExtrasMetrics;
  readonly queue: ExtrasQueue;
  readonly ego: ExtrasEgo;
  readonly jev: ExtrasJevStatus | null;
}

function buildController(choice: ControllerChoice, fingerprint: string): TrafficController {
  if (choice === "fixed") {
    return createFixedController();
  }
  if (choice === "adaptive") {
    return createAdaptiveController();
  }
  // Built exactly as benchmark/cli.ts builds it for a mock matrix: no
  // refreshMs override, no service gate (a deterministic run spends nothing).
  return createJevController({ client: createMockJevClient(), scenarioFingerprint: fingerprint });
}

function jevStatusOf(controller: TrafficController): ExtrasJevStatus | null {
  const maybe = controller as Partial<JevController>;
  if (maybe.id !== "jev" || typeof maybe.status !== "function") {
    return null;
  }
  const status = (controller as JevController).status();
  const meta = typeof maybe.meta === "function" ? (controller as JevController).meta() : null;
  return {
    // The adapter comes from meta() — the same account the official artifact's
    // provenance is built from, so the two can never disagree.
    adapter: meta === null ? "unknown" : meta.adapter,
    mode: status.mode,
    configured: status.configured,
    source: status.source,
    refreshes: status.refreshes,
    accepted: status.accepted,
    rejected: status.rejected,
    expiries: status.expiries,
    liveMs: status.liveMs,
    replayMs: status.replayMs,
    heldMs: status.heldMs,
    invalidMs: status.invalidMs,
    fallbackMs: status.fallbackMs,
    adaptiveTicks: status.adaptiveTicks,
    start:
      status.start === null
        ? null
        : status.start.state === "ready"
          ? `ready:${status.start.attempts}`
          : `unable:${status.start.reason}:${status.start.detail}`,
    invalidation:
      status.invalidation === null
        ? null
        : `${status.invalidation.reason}@${status.invalidation.atSimMs}ms`,
  };
}

function measureQueue(engine: EngineState, stuckMs: number): ExtrasQueue {
  let longestWaitMs = 0;
  let queuedVehicles = 0;
  let pendingVehicles = 0;
  const headWaitByRoad = new Map<number, number>();
  for (const vehicle of engine.traffic.activeVehicles) {
    if (vehicle.waitTimeMs > longestWaitMs) {
      longestWaitMs = vehicle.waitTimeMs;
    }
    if (vehicle.state === "queued") {
      queuedVehicles += 1;
      if (vehicle.roadId !== null) {
        const wait = currentQueueWaitMs(engine.traffic.timeMs, vehicle.queuedSinceMs);
        const previous = headWaitByRoad.get(vehicle.roadId);
        if (previous === undefined || wait > previous) {
          headWaitByRoad.set(vehicle.roadId, wait);
        }
      }
    } else if (vehicle.state === "pending") {
      pendingVehicles += 1;
    }
  }
  let stuckRoads = 0;
  for (const wait of headWaitByRoad.values()) {
    if (wait >= stuckMs) {
      stuckRoads += 1;
    }
  }
  return {
    stuckRoads,
    longestWaitMs,
    queuedVehicles,
    pendingVehicles,
    activeVehicles: engine.traffic.activeVehicles.size,
  };
}

const model = loadBenchmarkModel();

function runCell(
  tripId: CuratedTripId,
  trafficLevel: TrafficLevel,
  driver: DriverStrategy,
  seed: number,
  choice: ControllerChoice,
): ExtrasCell {
  const run = buildScenarioRun(model, { tripId, trafficLevel, driver, seed, durationMs: horizonMs });
  const controller = buildController(choice, run.fingerprint);
  const engine = createEngine({
    city: model.city,
    controller,
    spawns: run.spawns,
    driver,
    incidents: run.incidents,
  });
  // The SAME sequence ScenarioRun.runUnder drives: the pure-Jev startup gate,
  // the run, then the controller's own closing accounting.
  const started = startRunController(engine);
  if (typeof (started as Promise<unknown>).then === "function") {
    throw new Error(`${tripId}/${choice}: the mock adapter answered asynchronously — not a matrix run`);
  }
  if ((started as { state: string }).state === "unable") {
    throw new Error(`${tripId}/${choice}: the run could not start (${(started as { reason: string }).reason})`);
  }
  runEngine(engine, horizonMs);
  finishRunController(engine);

  const result = buildChallengeResult(engine, run.scenario, choice, 0);
  const metrics = computeMetrics(engine.metrics, engine.traffic);
  const ego =
    engine.egoVehicleId === null ? undefined : engine.traffic.vehicles[engine.egoVehicleId];
  const egoRoad = ego !== undefined && ego.roadId !== null ? engine.city.roads[ego.roadId] : undefined;
  return {
    tripId,
    trafficLevel,
    driver,
    seed,
    controller: choice,
    fingerprint: run.fingerprint,
    horizonMs,
    trip: result.trip,
    city: result.city,
    extras: {
      signalPhaseChanges: metrics.signalPhaseChanges,
      maxApproachWaitMs: metrics.maxApproachWaitMs,
      averageRoadOccupancy: metrics.averageRoadOccupancy,
      maxRoadOccupancy: metrics.maxRoadOccupancy,
      failedSpawns: metrics.failedSpawns,
    },
    queue: measureQueue(engine, stuckWaitMs),
    ego: {
      state: ego === undefined ? "missing" : ego.state,
      roadId: ego === undefined ? null : ego.roadId,
      roadKind: egoRoad === undefined ? null : egoRoad.kind,
      routeIndex: ego === undefined ? null : ego.routeIndex,
      routeLength: ego === undefined ? null : ego.route.length,
    },
    jev: jevStatusOf(controller),
  };
}

/* ---------------------------------------------------------------- output --- */

const cells: ExtrasCell[] = [];
for (const tripId of tripIds) {
  for (const trafficLevel of trafficLevels) {
    for (const seed of seeds) {
      for (const driver of drivers) {
        for (const choice of controllers) {
          const started = Date.now();
          const cell = runCell(tripId, trafficLevel, driver, seed, choice);
          cells.push(cell);
          if (!quiet) {
            console.log(
              `${tripId.padEnd(32)} ${trafficLevel.padEnd(9)} ${driver.padEnd(7)} seed=${String(seed).padEnd(4)} ` +
                `${choice.padEnd(8)} done=${cell.trip.completed ? "yes" : "NO "} ` +
                `switches=${String(cell.extras.signalPhaseChanges).padStart(6)} ` +
                `stuck=${String(cell.queue.stuckRoads).padStart(4)} ` +
                `(${((Date.now() - started) / 1000).toFixed(0)}s)`,
            );
          }
        }
      }
    }
  }
}

const document = {
  version: 1 as const,
  tool: "benchmark/extras.ts",
  note:
    "engine metrics the benchmark document does not carry (signal switches, occupancy, " +
    "approach wait) plus the horizon queue state; jev is the deterministic mock adapter",
  matrix: { trips: tripIds, trafficLevels, drivers, seeds, controllers, horizonMs, stuckWaitMs },
  cells,
};

if (outPath !== null) {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`\nwrote ${resolved}`);
}
console.log(`${cells.length} cells, ${new Set(cells.map((cell) => cell.fingerprint)).size} worlds`);
