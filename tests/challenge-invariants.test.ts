/**
 * Release closeout: the CANONICAL challenge world, exercised beyond the happy
 * path, asserting INVARIANTS rather than "it did not crash".
 *
 * The world here is the product's own: a curated Chicago trip, the shipping
 * demand profile (`sim/demand-profile.ts`), the automatic incident plan
 * (`worker/challenge-incidents.ts`) and the engine the worker drives. What this
 * file adds to the existing suites is not more of the same fixture — it is the
 * real world under the axes the 25-case release list names, with the engine's
 * own checker running through every window:
 *
 *   (2) Light traffic        (3) Rush Hour
 *   (4) driver Tourist       (5) driver Local
 *   (6) Fixed controller     (7) Adaptive controller
 *   (9) several deterministic seeds
 *  (10) no incident          (11) incident / closure   (12) reroute
 *  (21) arrival at the horizon
 *  (22) a run that cannot complete inside its horizon
 *
 * INVARIANTS asserted, and where they are checked:
 *   - deterministic same-seed world, demand, adversity and scenario fingerprint
 *     → "the resolved world is a pure function of the scenario"
 *   - legal signal transitions, capacity respected, no road drift, occupancy
 *     consistency, the active-vehicle index → `checkTrafficInvariants`
 *     (sim/traffic.ts): every tick in the Light cells, every 5th tick plus the
 *     final state in the two long ones (the checker walks the whole fleet)
 *   - closures respected → the roads an active closure names are closed, and
 *     nothing enters one that was not already on it when it closed
 *   - no teleporting → the ego's per-tick progress is bounded by its own speed
 *     and its speed by ACCEL_MPS2 / DECEL_MPS2 (the physics caps, not a
 *     tolerance of taste), and every road change lands where the old road ended
 *   - an arrival at the horizon is an arrival, one tick short is not, and a run
 *     that cannot finish inside its horizon never presents one
 *
 * Cases already covered elsewhere are named in the closeout report rather than
 * duplicated here.
 */
import { describe, expect, it } from "vitest";
import { buildScenarioRun } from "@/worker/challenge-compare";
import { buildChallengeResult } from "@/worker/challenge-result";
import {
  buildChallengeScenario,
  resolveScenarioWorld,
  scenarioFingerprint,
  type ChallengeScenario,
  type ScenarioWorld,
} from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { comparisonRows, raceEntries } from "@/components/ui-model";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { ACCEL_MPS2, DECEL_MPS2 } from "@/sim/road-traffic";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { checkTrafficInvariants } from "@/sim/traffic";
import { SIMULATION_TIMESTEP_MS } from "@/sim/config";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import { chicagoModel } from "./chicago-support";

const model = chicagoModel(4);
const DT_S = SIMULATION_TIMESTEP_MS / 1000;
/** Per-tick caps from the one authoritative physics module. */
const MAX_ACCEL_STEP = ACCEL_MPS2 * DT_S;
const MAX_DECEL_STEP = DECEL_MPS2 * DT_S;
/** The live run's horizon: the number every product path runs to. */
const HORIZON_MS = 600_000;

interface World {
  readonly scenario: ChallengeScenario;
  readonly fingerprint: string;
  readonly spawns: readonly ScheduledSpawn[];
  readonly incidentSeed: number;
  readonly incidentEntries: ScenarioWorld["incidentPlan"]["entries"];
  readonly routeLengthM: number;
}

/** The whole resolved world for one scenario — the same inputs the worker builds. */
function worldFor(
  tripId: CuratedTripId,
  trafficLevel: TrafficLevel,
  driver: DriverStrategy,
  seed: number,
  durationMs = HORIZON_MS,
): World {
  const challenge = materializeChallengeTrip(model, tripId, seed);
  const scenario = buildChallengeScenario({ tripId, trafficLevel, driver, seed, durationMs });
  const resolved = resolveScenarioWorld(model, challenge.trip, scenario);
  return {
    scenario,
    fingerprint: scenarioFingerprint(scenario),
    spawns: [
      challenge.spawn,
      ...productionDemand({
        city: model.city,
        level: trafficLevel,
        seed: resolved.demandSeed,
        durationMs,
      }),
    ],
    incidentSeed: resolved.incidentPlan.incidentSeed,
    incidentEntries: resolved.incidentPlan.entries,
    routeLengthM: challenge.trip.route.roadIds.reduce(
      (sum, roadId) => sum + model.city.roads[roadId].length,
      0,
    ),
  };
}

function engineFor(world: World, controller: "fixed" | "adaptive", driver: DriverStrategy): EngineState {
  return createEngine({
    city: model.city,
    controller: controller === "fixed" ? createFixedController() : createAdaptiveController(),
    spawns: [...world.spawns],
    driver,
    incidents: { seed: world.incidentSeed, script: [...world.incidentEntries] },
  });
}

/* ------------------------------------------------------------------ */
/* The world itself: identity, demand and adversity as pure functions  */
/* ------------------------------------------------------------------ */

describe("the resolved world is a pure function of the scenario", () => {
  const SEEDS = [42, 43, 2026] as const;
  const TRIP: CuratedTripId = "soldier-field-to-navy-pier";

  it("resolves byte-identical demand, adversity and identity for one seed — and a different world for another", () => {
    const worlds = SEEDS.map((seed) => worldFor(TRIP, "rush-hour", "tourist", seed));
    const repeated = worldFor(TRIP, "rush-hour", "tourist", SEEDS[0]);

    // Deterministic same-seed world: demand, incident script and identity.
    expect(JSON.stringify(repeated.spawns)).toBe(JSON.stringify(worlds[0].spawns));
    expect(JSON.stringify(repeated.incidentEntries)).toBe(JSON.stringify(worlds[0].incidentEntries));
    expect(repeated.fingerprint).toBe(worlds[0].fingerprint);
    expect(repeated.incidentSeed).toBe(worlds[0].incidentSeed);

    // Three seeds are three experiments, not one world drawn three times: the
    // demand, the adversity and the identity all move together.
    expect(new Set(worlds.map((world) => world.fingerprint)).size).toBe(SEEDS.length);
    expect(new Set(worlds.map((world) => JSON.stringify(world.spawns))).size).toBe(SEEDS.length);
    expect(new Set(worlds.map((world) => JSON.stringify(world.incidentEntries))).size).toBe(
      SEEDS.length,
    );
    // Every automatic entry is a real, bounded piece of adversity inside the run:
    // it lands inside the horizon, on a road the world really has, with either
    // an explicit duration or the kind's own default (IncidentScriptEntry).
    for (const world of worlds) {
      for (const entry of world.incidentEntries) {
        expect(entry.atMs).toBeGreaterThan(0);
        expect(entry.atMs).toBeLessThan(world.scenario.durationMs);
        expect(entry.durationMs === undefined || entry.durationMs > 0).toBe(true);
        if (entry.targetRoadId !== undefined) {
          expect(model.city.roads[entry.targetRoadId]).toBeDefined();
        }
      }
    }
  });

  it("carries the level's demand and adversity: Light asks for nothing, Rush Hour loads the city", () => {
    const light = worldFor(TRIP, "light", "tourist", 42);
    const everyday = worldFor(TRIP, "everyday", "tourist", 42);
    const rush = worldFor(TRIP, "rush-hour", "tourist", 42);

    // (10) no incident: the Light world resolves to no automatic adversity at
    // all — the plan is empty, not a script that happens to be harmless.
    expect(light.incidentEntries).toEqual([]);
    // (11) incident: Everyday and Rush Hour really do plan adversity.
    expect(everyday.incidentEntries.length).toBeGreaterThan(0);
    expect(rush.incidentEntries.length).toBeGreaterThan(everyday.incidentEntries.length);

    // (2)(3) the level is the demand knob, materially: the shipping profile is
    // what every path (worker, baseline worker, benchmark) builds from.
    expect(everyday.spawns.length).toBeGreaterThan(light.spawns.length);
    expect(rush.spawns.length).toBeGreaterThanOrEqual(light.spawns.length * 3);

    // One trip, one seed: the only thing that moved is the level.
    expect(new Set([light.fingerprint, everyday.fingerprint, rush.fingerprint]).size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* The world in motion: invariants on every tick of the real challenge  */
/* ------------------------------------------------------------------ */

interface Cell {
  readonly label: string;
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly controller: "fixed" | "adaptive";
  readonly seed: number;
  readonly horizonMs: number;
}

/**
 * Four cells that cover every axis value at least twice: both levels, both
 * drivers, both controllers. The last one runs long enough for the scenario's
 * own automatic closure to land, so "closures respected" and "reroute" are
 * proven on a real one rather than assumed.
 */
const CELLS: readonly Cell[] = [
  {
    label: "Light · Tourist · Fixed",
    tripId: "soldier-field-to-navy-pier",
    trafficLevel: "light",
    driver: "tourist",
    controller: "fixed",
    seed: 42,
    horizonMs: 60_000,
  },
  {
    label: "Light · Local · Adaptive",
    tripId: "soldier-field-to-navy-pier",
    trafficLevel: "light",
    driver: "local",
    controller: "adaptive",
    seed: 42,
    horizonMs: 60_000,
  },
  {
    label: "Rush Hour · Tourist · Adaptive",
    tripId: "soldier-field-to-navy-pier",
    trafficLevel: "rush-hour",
    driver: "tourist",
    controller: "adaptive",
    seed: 42,
    horizonMs: 60_000,
  },
  {
    label: "Rush Hour · Local · Fixed (through the automatic closure)",
    tripId: "soldier-field-to-navy-pier",
    trafficLevel: "rush-hour",
    driver: "local",
    controller: "fixed",
    // Seed 43's Rush Hour plan puts a real bridge closure on the route at
    // ~232 s; 240 s is the shortest window that contains it.
    seed: 43,
    horizonMs: 240_000,
  },
];

describe("the real challenge world stays legal on every tick", () => {
  for (const cell of CELLS) {
    it(
      `${cell.label}: engine invariants, road-locked ego, closures respected`,
      { timeout: 300_000 },
      () => {
        const world = worldFor(
          cell.tripId,
          cell.trafficLevel,
          cell.driver,
          cell.seed,
          cell.horizonMs,
        );
        const engine = engineFor(world, cell.controller, cell.driver);
        // The ego spawns on the first tick, not at construction: resolve it from
        // the engine's own record rather than by list position.
        let egoId: number | null = null;
        let ego: (typeof engine.traffic.vehicles)[number] | null = null;
        let fullRoute: readonly number[] = [];

        const violations: string[] = [];
        const closureViolations: string[] = [];
        const continuityViolations: string[] = [];
        let closureTicks = 0;
        let successfulReroutes = 0;
        let egoOnClosedRoad = 0;
        let previous: { roadId: number; progress: number; speed: number } | null = null;
        let maxProgressDelta = 0;
        let maxAccelDelta = 0;
        let maxDecelDelta = 0;
        /**
         * Vehicles that were ALREADY on a road when the world closed it. The
         * simulation lets a vehicle finish a road that closes underneath it
         * (sim/traffic.ts), so the invariant is not "no vehicle on a closed
         * road" — it is "nothing ENTERS one": anyone else on a closed road is a
         * violation. Snapshotted once per closure, when it activates.
         */
        const grandfathered = new Map<number, Set<number>>();
        const snapshotted = new Set<number>();

        const ticks = Math.floor(cell.horizonMs / SIMULATION_TIMESTEP_MS);
        /**
         * The engine's own checker iterates the whole fleet, so the two long
         * cells run it on a dense SAMPLE (every 5th tick = every 0.5 simulated
         * seconds) instead of every tick; the light cells check every tick. A
         * state corruption that survived half a second would still be caught,
         * and the end-of-window check is unconditional.
         */
        const checkEvery = cell.horizonMs > 60_000 ? 5 : 1;
        let invariantChecks = 0;
        for (let tick = 0; tick < ticks; tick += 1) {
          stepEngine(engine);
          if (tick % checkEvery === 0) {
            invariantChecks += 1;
            const problems = checkTrafficInvariants(engine.city, engine.traffic);
            if (problems.length > 0 && violations.length < 5) {
              violations.push(`tick ${tick}: ${problems.join(" | ")}`);
            }
          }
          // Closures respected: the roads an active closure names are closed,
          // and nothing that was not already there has entered one.
          let closureActive = false;
          for (const record of engine.incidents.records) {
            successfulReroutes = Math.max(successfulReroutes, record.successfulReroutes);
            if (record.status !== "active") {
              continue;
            }
            closureActive = true;
            for (const roadId of record.roadIds) {
              if (!engine.city.roads[roadId].closed) {
                closureViolations.push(
                  `tick ${tick}: closure ${record.id} is active but road ${roadId} is open`,
                );
              }
              if (!snapshotted.has(record.id)) {
                const already = new Set<number>();
                for (const vehicle of engine.traffic.vehicles) {
                  if (vehicle.roadId === roadId) {
                    already.add(vehicle.id);
                  }
                }
                grandfathered.set(roadId, already);
              }
            }
            snapshotted.add(record.id);
          }
          if (closureActive) {
            closureTicks += 1;
          }
          if (closureTicks > 0) {
            for (const vehicle of engine.traffic.vehicles) {
              if (vehicle.state === "pending" || vehicle.state === "arrived" || vehicle.roadId === null) {
                continue;
              }
              if (!engine.city.roads[vehicle.roadId].closed) {
                continue;
              }
              if (!grandfathered.get(vehicle.roadId)?.has(vehicle.id)) {
                closureViolations.push(
                  `tick ${tick}: vehicle ${vehicle.id} entered closed road ${vehicle.roadId}`,
                );
              }
            }
          }
          // No teleporting, no road drift: the ego is always on its own route,
          // its progress is bounded by its own speed, its speed by the physics
          // caps, and every road change lands where the previous road ended.
          if (ego === null) {
            const spawnedId = engine.egoVehicleId;
            if (spawnedId === null) {
              continue; // before the ego's own spawn tick
            }
            egoId = spawnedId;
            ego = engine.traffic.vehicles[spawnedId];
            fullRoute = [...ego.route];
          }
          const egoRoadId = ego.roadId;
          if (ego.state !== "arrived" && ego.state !== "pending") {
            if (egoRoadId === null) {
              continuityViolations.push(`tick ${tick}: ego is active but occupies no road`);
            } else {
              if (!ego.route.includes(egoRoadId)) {
                continuityViolations.push(`tick ${tick}: ego off its route (road ${egoRoadId})`);
              }
              if (engine.city.roads[egoRoadId].closed) {
                egoOnClosedRoad += 1;
              }
              if (previous !== null) {
                if (previous.roadId === egoRoadId) {
                  const delta = ego.progress - previous.progress;
                  maxProgressDelta = Math.max(maxProgressDelta, delta);
                  maxAccelDelta = Math.max(maxAccelDelta, ego.speed - previous.speed);
                  maxDecelDelta = Math.max(maxDecelDelta, previous.speed - ego.speed);
                  const bound = Math.max(previous.speed, ego.speed) * DT_S + 1e-9;
                  if (delta > bound) {
                    continuityViolations.push(
                      `tick ${tick}: ego moved ${delta.toFixed(4)} m in one tick, above its own speed bound ${bound.toFixed(4)}`,
                    );
                  }
                } else {
                  // A road change is a junction transfer onto the NEXT road of
                  // the ego's own route: it must land where the old road ended,
                  // and the leftover distance it carries over cannot exceed what
                  // the car travelled in one tick (progress is METRES, not a
                  // fraction — see sim/traffic.ts advance()).
                  const from = engine.city.roads[previous.roadId];
                  const to = engine.city.roads[egoRoadId];
                  const leftoverBound = ego.speed * DT_S + 1e-9;
                  if (from.to !== to.from) {
                    continuityViolations.push(
                      `tick ${tick}: ego teleported ${previous.roadId}->${egoRoadId} (${from.to} != ${to.from})`,
                    );
                  }
                  if (ego.progress > leftoverBound) {
                    continuityViolations.push(
                      `tick ${tick}: ego carried ${ego.progress.toFixed(4)} m onto road ${egoRoadId}, above one tick of travel ${leftoverBound.toFixed(4)}`,
                    );
                  }
                  if (engine.city.roads[egoRoadId].closed) {
                    continuityViolations.push(
                      `tick ${tick}: ego transferred onto closed road ${egoRoadId}`,
                    );
                  }
                }
              }
              previous = { roadId: egoRoadId, progress: ego.progress, speed: ego.speed };
            }
          }
        }

        // The sampled checks really ran, and the window's FINAL state is checked
        // unconditionally — the sampling narrows cost, never the claim.
        expect(invariantChecks).toBeGreaterThanOrEqual(Math.floor(ticks / checkEvery));
        expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
        expect(violations).toEqual([]);
        expect(closureViolations).toEqual([]);
        expect(continuityViolations).toEqual([]);
        // A vehicle may legitimately FINISH a road that closes underneath it
        // (sim/traffic.ts), so this is a fact about this world rather than a
        // general contract: here the ego never shares a road with a closure.
        expect(egoOnClosedRoad).toBe(0);
        if (ego === null || egoId === null) {
          throw new Error(`${cell.label}: the cell never spawned its ego`);
        }
        // The ego really moved: the continuity bounds above are not vacuous.
        expect(maxProgressDelta).toBeGreaterThan(0);
        expect(maxAccelDelta).toBeGreaterThan(0);
        // Bounded acceleration and braking, from the caps themselves.
        expect(maxAccelDelta).toBeLessThanOrEqual(MAX_ACCEL_STEP + 1e-9);
        expect(maxDecelDelta).toBeLessThanOrEqual(MAX_DECEL_STEP + 1e-9);
        // The ego is still the ego, on a route that is still a route: unchanged
        // unless the world invalidated it (a closure across it), in which case
        // the replacement must be connected, closed-free and start where the
        // car actually is.
        expect(engine.traffic.vehicles[egoId]).toBe(ego);
        if (ego.rerouteCount === 0) {
          expect(ego.route).toEqual(fullRoute);
        } else {
          expect(ego.route[ego.routeIndex]).toBe(ego.roadId);
          for (let index = 1; index < ego.route.length; index += 1) {
            const before = model.city.roads[ego.route[index - 1]];
            const after = model.city.roads[ego.route[index]];
            expect(before.to).toBe(after.from);
            expect(after.closed).toBe(false);
          }
        }

        if (cell.horizonMs === 240_000) {
          // (11)(12) a real automatic closure landed, and the world rerouted
          // around it rather than driving through it.
          const closure = engine.incidents.records.find((record) => record.kind === "bridge-closed");
          expect(closure).toBeDefined();
          expect(closure?.status).toBe("active");
          expect(closure?.roadIds.length).toBeGreaterThan(0);
          expect(closureTicks).toBeGreaterThan(0);
          for (const roadId of closure?.roadIds ?? []) {
            expect(engine.city.roads[roadId].closed).toBe(true);
            expect(engine.city.roads[roadId].kind).toBe("bridge");
          }
          expect(successfulReroutes).toBeGreaterThan(0);
          // The reroute was the engine's invalidity path, not a driver switch:
          // this driver made no proactive switch in this window.
          expect(engine.driverState.switches).toBe(0);
          expect(ego.rerouteCount).toBeGreaterThan(0);
        } else {
          // No closure can have landed inside a 60 s window, so a Tourist has
          // had nothing to react to — and reacts to nothing.
          expect(world.incidentEntries.every((entry) => entry.atMs > cell.horizonMs)).toBe(true);
          expect(engine.driverState.switches).toBe(0);
          expect(ego.rerouteCount).toBe(0);
          expect(ego.state).not.toBe("arrived");
        }
        // Every switch a driver makes is a reroute it counts; the reverse is
        // not claimed (a closure reroute is not a switch).
        expect(engine.driverState.switches).toBeLessThanOrEqual(ego.rerouteCount);
        expect(engine.traffic.vehicles.length).toBeGreaterThan(0);
      },
    );
  }
});

/* ------------------------------------------------------------------ */
/* The horizon boundary: exact, and honest in both directions          */
/* ------------------------------------------------------------------ */

describe("the horizon boundary is exact", () => {
  // The cheapest curated arrival at Light (236.2 s at seed 42), so the whole
  // proof costs one bounded run instead of a full 600 s one.
  const TRIP: CuratedTripId = "willis-tower-to-near-west-side";

  it(
    "an arrival at the horizon is an arrival; one tick short is not, and neither is presented as the other",
    { timeout: 300_000 },
    () => {
      const challenge = materializeChallengeTrip(model, TRIP, 42);
      const scenario = buildChallengeScenario({
        tripId: TRIP,
        trafficLevel: "light",
        driver: "tourist",
        seed: 42,
        durationMs: HORIZON_MS,
      });
      const resolved = resolveScenarioWorld(model, challenge.trip, scenario);
      const engine = createEngine({
        city: model.city,
        controller: createAdaptiveController(),
        spawns: [
          challenge.spawn,
          ...productionDemand({
            city: model.city,
            level: "light",
            seed: resolved.demandSeed,
            durationMs: HORIZON_MS,
          }),
        ],
        driver: "tourist",
        incidents: { seed: resolved.incidentPlan.incidentSeed, script: [...resolved.incidentPlan.entries] },
      });
      const routeLengthM = challenge.trip.route.roadIds.reduce(
        (sum, roadId) => sum + model.city.roads[roadId].length,
        0,
      );

      // Step the real world to its own arrival. The result is built at the tick
      // BEFORE the arriving step and at the arriving step: the two sides of the
      // horizon, from ONE world, with nothing re-run or re-derived. The ego
      // spawns on the first tick, so it is resolved from the engine's own record.
      let oneTickShort: ReturnType<typeof buildChallengeResult> | null = null;
      let arrivalMs = -1;
      let ticks = 0;
      let ego: (typeof engine.traffic.vehicles)[number] | null = null;
      const tickLimit = Math.floor(HORIZON_MS / SIMULATION_TIMESTEP_MS);
      while (ticks < tickLimit) {
        stepEngine(engine);
        ticks += 1;
        if (ego === null) {
          const spawnedId = engine.egoVehicleId;
          if (spawnedId === null) {
            continue;
          }
          ego = engine.traffic.vehicles[spawnedId];
        }
        if (ego.state === "arrived") {
          arrivalMs = engine.traffic.timeMs;
          break;
        }
        if (ego.routeIndex >= ego.route.length - 1) {
          oneTickShort = buildChallengeResult(engine, scenario, "adaptive", 0);
        }
      }
      const arrived = buildChallengeResult(engine, scenario, "adaptive", 0);
      expect(oneTickShort, "the world must have been stepped through its arrival").not.toBeNull();
      const short = oneTickShort as ReturnType<typeof buildChallengeResult>;

      // (21) The arrival is an arrival, at the instant it happened — not at the
      // horizon, and not silently rounded to it.
      expect(arrivalMs).toBeGreaterThan(0);
      expect(arrivalMs).toBeLessThan(HORIZON_MS);
      expect(arrived.trip.completed).toBe(true);
      expect(arrived.trip.tripTimeMs).toBe(arrivalMs);
      expect(arrived.trip.distanceM).toBeCloseTo(routeLengthM, 6);

      // One tick earlier: the same world, one step short of arrival. It is NOT
      // an arrival, and the elapsed time is the clock, never a fabricated one.
      expect(short.trip.completed).toBe(false);
      expect(short.simulatedMs).toBe(arrivalMs - SIMULATION_TIMESTEP_MS);
      expect(short.trip.tripTimeMs).toBe(short.simulatedMs);
      expect(short.trip.distanceM).toBeLessThan(routeLengthM);

      // The presentation half: an incomplete run is marked as one and never
      // shows a trip time it did not achieve.
      const entries = raceEntries(
        { ...short, controller: "fixed" },
        { ...arrived, controller: "adaptive" },
        { ...short, controller: "jev" },
        "Jev",
      );
      expect(entries.find((entry) => entry.key === "fixed")?.incomplete).toBe(true);
      expect(entries.find((entry) => entry.key === "adaptive")?.incomplete).toBe(false);
      const rows = comparisonRows(
        { ...short, controller: "fixed" },
        { ...arrived, controller: "adaptive" },
        { ...short, controller: "jev" },
      );
      const byLabel = new Map(rows.map((row) => [row.label, row]));
      expect(byLabel.get("Arrived")?.fixed).toBe("No");
      expect(byLabel.get("Arrived")?.adaptive).toBe("Yes");
      expect(byLabel.get("Trip time")?.fixed).toBe("—");
      expect(byLabel.get("Trip time")?.adaptive).not.toBe("—");
      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
    },
  );

  it(
    "(22) a run whose route cannot finish inside its horizon says so — no invented arrival",
    { timeout: 300_000 },
    () => {
      // The production seam the worker calls: a horizon far shorter than the
      // trip. Nothing about the result may claim the car arrived.
      const horizonMs = 20_000;
      const run = buildScenarioRun(model, {
        tripId: TRIP,
        trafficLevel: "light",
        driver: "tourist",
        seed: 42,
        durationMs: horizonMs,
      });
      const result = run.runUnder("adaptive");

      expect(result.trip.completed).toBe(false);
      expect(result.simulatedMs).toBe(horizonMs);
      expect(result.trip.tripTimeMs).toBe(horizonMs);
      expect(result.trip.distanceM).toBeGreaterThan(0);
      expect(result.trip.distanceM).toBeLessThan(run.trip.route.roadIds.reduce(
        (sum, roadId) => sum + model.city.roads[roadId].length,
        0,
      ));
      expect(Number.isFinite(result.trip.averageSpeedMps)).toBe(true);
      // The city half is still measured — an unfinished trip is not an empty run.
      expect(result.city.activeVehicles).toBeGreaterThan(0);

      const rows = comparisonRows(
        { ...result, controller: "fixed" },
        { ...result, controller: "adaptive" },
        { ...result, controller: "jev" },
      );
      for (const row of rows.filter((candidate) => candidate.label === "Arrived")) {
        expect([row.fixed, row.adaptive, row.jev]).toEqual(["No", "No", "No"]);
      }
      for (const row of rows.filter((candidate) => candidate.label === "Trip time")) {
        expect([row.fixed, row.adaptive, row.jev]).toEqual(["—", "—", "—"]);
      }
      // Same world, same fingerprint as the full-horizon run of the scenario:
      // the horizon is not part of the scenario's identity... it is, by
      // construction (durationMs is fingerprinted), so the claim is the honest
      // one: this run's own identity is the one it was built with.
      expect(result.fingerprint).toBe(scenarioFingerprint(run.scenario));
    },
  );
});
