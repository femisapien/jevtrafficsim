/**
 * Route completion report: every curated Chicago trip, under every controller,
 * on the production world (the worker's own `buildScenarioRun` seam).
 *
 * This is the repeatable evidence for the owner's goal — "test it on every
 * route, this should best simulate all kinds of trips" — so it reports, per
 * route per controller:
 *
 *   - ARRIVAL: the simulated time the ego reached its destination, or NEVER;
 *   - the ego's final state (state, road, route index) when it did not finish;
 *   - LONGEST WAIT: the city-wide worst waiting vehicle at the horizon, plus
 *     how many roads still carry a blocked queue (a road counts as STUCK when
 *     the vehicle at the head of its queue has been continuously blocked for
 *     at least `--stuck-wait` ms);
 *   - QUEUED/PENDING population, so a jammed city shows up as numbers.
 *
 * The world is the production one: `buildScenarioRun` resolves the trip, the
 * demand (productionDemand — the profile the app and the benchmark both play)
 * and the incident plan ONCE, and this script steps an engine built from that
 * same resolved world. `--check` re-runs each cell through `runUnder()` and
 * asserts the traced run and the seam agree, which is what proves this harness
 * is not measuring a second simulation path.
 *
 *   npx tsx scripts/route-completion-report.ts
 *   npx tsx scripts/route-completion-report.ts --trips soldier-field-to-navy-pier --controller fixed
 *   npx tsx scripts/route-completion-report.ts --tail 1800000      # drain probe: demand cut at the horizon
 *   npx tsx scripts/route-completion-report.ts --check --json tmp/route-report.json
 *
 * Nothing here changes the simulation: it drives the product's own engine and
 * counts. Exit code is 1 when any route did not finish inside the horizon, so
 * the report doubles as a gate.
 */
import { loadBenchmarkModel } from "@/benchmark/model";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { createJevController } from "@/controllers/jev";
import { createMockJevClient } from "@/jev/client";
import { currentQueueWaitMs } from "@/sim/approach-stats";
import { computeMetrics } from "@/sim/metrics";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import type { TrafficController } from "@/controllers/contract";
import { buildScenarioRun } from "@/worker/challenge-compare";
import { LIVE_RUN_HORIZON_MS, type ControllerChoice } from "@/worker/protocol";
import { writeFileSync } from "node:fs";

/* ------------------------------------------------------------- options --- */

const USAGE = `Route completion report

Usage: pnpm tsx scripts/route-completion-report.ts [options]

  --trips <id,...>        curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --controller <list>     fixed,adaptive,jev (default: all three)
  --traffic <level>       everyday | rush-hour (default rush-hour)
  --driver <tourist|local> (default tourist)
  --seed <n>              scenario seed (default 42)
  --horizon <ms>          simulated run length (default ${LIVE_RUN_HORIZON_MS})
  --tail <ms>             after the horizon, cut demand and keep stepping this long
                          (anti-deadlock drain probe; default 0)
  --stuck-wait <ms>       continuous wait that makes a road "stuck" (default 120000)
  --check                 also run each cell through ScenarioRun.runUnder() and
                          assert the traced run agrees with the production seam
  --json <path>           write the whole report as JSON
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

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const seed = intArg("--seed", 42, 0);
const horizonMs = intArg("--horizon", LIVE_RUN_HORIZON_MS, 1_000);
const tailMs = intArg("--tail", 0, 0);
const stuckWaitMs = intArg("--stuck-wait", 120_000, 0);
const trafficLevel = (arg("--traffic") ?? "rush-hour") as "everyday" | "rush-hour";
const driver = (arg("--driver") ?? "tourist") as "tourist" | "local";
const check = process.argv.includes("--check");
const jsonPath = arg("--json");

const tripIds = (arg("--trips") ?? CURATED_TRIP_IDS.join(",")).split(",").filter(Boolean);
for (const tripId of tripIds) {
  if (!(CURATED_TRIP_IDS as readonly string[]).includes(tripId)) {
    console.error(`unknown trip id "${tripId}"\n${USAGE}`);
    process.exit(2);
  }
}
const controllerChoices = (arg("--controller") ?? "fixed,adaptive,jev").split(",").filter(Boolean);
for (const choice of controllerChoices) {
  if (choice !== "fixed" && choice !== "adaptive" && choice !== "jev") {
    console.error(`unknown controller "${choice}"\n${USAGE}`);
    process.exit(2);
  }
}

/* -------------------------------------------------------------- report --- */

interface Cell {
  readonly tripId: CuratedTripId;
  readonly controller: ControllerChoice;
  readonly fingerprint: string;
  readonly arrivalMs: number | null;
  readonly egoState: string;
  readonly egoRoadId: number | null;
  readonly egoRoadKind: string | null;
  readonly egoRouteIndex: number | null;
  readonly egoRouteLength: number | null;
  readonly egoWaitMs: number;
  readonly egoTripMs: number;
  /** City-wide worst current wait over the whole spawned population. */
  readonly longestWaitMs: number;
  readonly queuedVehicles: number;
  readonly pendingVehicles: number;
  readonly activeVehicles: number;
  /** Roads whose queue head has been continuously blocked >= stuckWaitMs. */
  readonly stuckRoads: number;
  /** Occupied directed roads (the drain probe's residual). */
  readonly occupiedRoads: number;
  readonly completedTrips: number;
  readonly failedSpawns: number;
  readonly tailMs: number;
}

const model = loadBenchmarkModel();

function buildController(choice: ControllerChoice, fingerprint: string): TrafficController {
  if (choice === "fixed") {
    return createFixedController();
  }
  if (choice === "adaptive") {
    return createAdaptiveController();
  }
  return createJevController({ client: createMockJevClient(), scenarioFingerprint: fingerprint });
}

function egoOf(engine: EngineState) {
  return engine.egoVehicleId === null ? undefined : engine.traffic.vehicles[engine.egoVehicleId];
}

function measure(
  engine: EngineState,
): Omit<Cell, "tripId" | "controller" | "fingerprint" | "tailMs" | "arrivalMs"> {
  const ego = egoOf(engine);
  const active = [...engine.traffic.activeVehicles];
  let longestWaitMs = 0;
  let queuedVehicles = 0;
  let pendingVehicles = 0;
  const headWaitByRoad = new Map<number, number>();
  for (const vehicle of active) {
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
    if (wait >= stuckWaitMs) {
      stuckRoads += 1;
    }
  }
  const metrics = computeMetrics(engine.metrics, engine.traffic);
  const egoRoad = ego && ego.roadId !== null ? engine.city.roads[ego.roadId] : undefined;
  return {
    egoState: ego ? ego.state : "missing",
    egoRoadId: ego ? ego.roadId : null,
    egoRoadKind: egoRoad ? egoRoad.kind : null,
    egoRouteIndex: ego ? ego.routeIndex : null,
    egoRouteLength: ego ? ego.route.length : null,
    egoWaitMs: ego ? ego.waitTimeMs : 0,
    egoTripMs: ego ? ego.tripTimeMs : 0,
    longestWaitMs,
    queuedVehicles,
    pendingVehicles,
    activeVehicles: active.length,
    stuckRoads,
    occupiedRoads: engine.traffic.occupancy.size,
    completedTrips: metrics.completedTrips,
    failedSpawns: metrics.failedSpawns,
  };
}

function runCell(tripId: CuratedTripId, choice: ControllerChoice): Cell {
  const run = buildScenarioRun(
    model,
    {
      tripId,
      trafficLevel,
      driver,
      seed,
      durationMs: horizonMs,
    },
    {
      // The seam's jev factory needs an adapter; the report always benches the
      // deterministic mock (same client the traced path below uses).
      controllers: {
        jev: (context) =>
          createJevController({
            client: createMockJevClient(),
            scenarioFingerprint: context.fingerprint,
          }),
      },
    },
  );
  const engine = createEngine({
    city: model.city,
    controller: buildController(choice, run.fingerprint),
    spawns: run.spawns,
    driver,
    incidents: run.incidents,
  });
  let arrivalMs: number | null = null;
  while (engine.traffic.timeMs < horizonMs) {
    stepEngine(engine);
    const ego = egoOf(engine);
    if (arrivalMs === null && ego && ego.state === "arrived") {
      arrivalMs = engine.traffic.timeMs;
    }
  }
  if (tailMs > 0) {
    // Demand cut: nothing new enters, so what is left is what never drained.
    engine.nextSpawnIndex = engine.spawnQueue.length;
    while (engine.traffic.timeMs < horizonMs + tailMs) {
      stepEngine(engine);
    }
  }
  if (check) {
    // The production seam, run over the same resolved world: the traced run
    // must agree with it on the facts the report publishes.
    const viaSeam = run.runUnder(choice);
    if (viaSeam.trip.completed !== (arrivalMs !== null)) {
      throw new Error(
        `${tripId}/${choice}: traced completion ${String(arrivalMs !== null)} != seam completion ${String(viaSeam.trip.completed)}`,
      );
    }
    const traced = measure(engine);
    if (traced.completedTrips !== viaSeam.city.completedTrips) {
      throw new Error(
        `${tripId}/${choice}: traced completed trips ${traced.completedTrips} != seam ${viaSeam.city.completedTrips}`,
      );
    }
    if (traced.egoTripMs !== viaSeam.trip.tripTimeMs) {
      throw new Error(
        `${tripId}/${choice}: traced ego trip time ${traced.egoTripMs} != seam ${viaSeam.trip.tripTimeMs}`,
      );
    }
  }
  const measured = measure(engine);
  return {
    tripId,
    controller: choice,
    fingerprint: run.fingerprint,
    tailMs,
    ...measured,
    arrivalMs,
  };
}

/* --------------------------------------------------------------- output --- */

const rows: Cell[] = [];
for (const tripId of tripIds as CuratedTripId[]) {
  for (const choice of controllerChoices as ControllerChoice[]) {
    const started = Date.now();
    const cell = runCell(tripId, choice);
    rows.push(cell);
    console.log(
      `${tripId.padEnd(32)} ${choice.padEnd(8)} ${
        cell.arrivalMs === null ? "NEVER" : `${(cell.arrivalMs / 1000).toFixed(1)}s`
      }  (${((Date.now() - started) / 1000).toFixed(0)}s wall)`,
    );
  }
}

const header = [
  "route".padEnd(32),
  "controller".padEnd(10),
  "arrival",
  "egoState".padEnd(10),
  "egoWait",
  "longestWait",
  "stuckRoads",
  "queued".padStart(7),
  "pending".padStart(8),
  "active".padStart(7),
  "done".padStart(6),
];
console.log(`\n${header.join(" ")}`);
for (const row of rows) {
  console.log(
    [
      row.tripId.padEnd(32),
      row.controller.padEnd(10),
      (row.arrivalMs === null ? "NEVER" : `${(row.arrivalMs / 1000).toFixed(1)}s`).padEnd(8),
      row.egoState.padEnd(10),
      `${(row.egoWaitMs / 1000).toFixed(0)}s`.padStart(7),
      `${(row.longestWaitMs / 1000).toFixed(0)}s`.padStart(11),
      String(row.stuckRoads).padStart(10),
      String(row.queuedVehicles).padStart(7),
      String(row.pendingVehicles).padStart(8),
      String(row.activeVehicles).padStart(7),
      String(row.completedTrips).padStart(6),
    ].join(" "),
  );
}
console.log(
  `\nworld: ${trafficLevel} / ${driver} / seed ${seed} / horizon ${(horizonMs / 1000).toFixed(0)}s` +
    `${tailMs > 0 ? ` + tail ${(tailMs / 1000).toFixed(0)}s (demand cut)` : ""}` +
    `; stuck road = queue head blocked >= ${(stuckWaitMs / 1000).toFixed(0)}s`,
);
for (const row of rows) {
  if (row.arrivalMs === null) {
    console.log(
      `  ${row.tripId}/${row.controller}: ego ${row.egoState} on road ${String(row.egoRoadId)}` +
        ` (${String(row.egoRoadKind)}) at route index ${String(row.egoRouteIndex)}/${String(row.egoRouteLength)},` +
        ` trip ${(row.egoTripMs / 1000).toFixed(1)}s, wait ${(row.egoWaitMs / 1000).toFixed(1)}s`,
    );
  }
}

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({ trafficLevel, driver, seed, horizonMs, tailMs, rows }, null, 2)}\n`);
  console.log(`wrote ${jsonPath}`);
}

const unfinished = rows.filter((row) => row.arrivalMs === null);
if (unfinished.length > 0) {
  console.log(`\n${unfinished.length} of ${rows.length} route/controller cells did not finish.`);
  process.exit(1);
}
console.log(`\nall ${rows.length} route/controller cells finished inside the horizon.`);

