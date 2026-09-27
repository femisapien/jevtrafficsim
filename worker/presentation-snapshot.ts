/**
 * Bounded presentation snapshots: the live-render frame sent to the main thread.
 *
 * Issue #24 changed what this frame IS. It used to carry every active vehicle,
 * which made the render payload scale with the fleet: a rush-hour city shipped
 * hundreds of vehicle objects across the worker boundary every 200 ms so the map
 * could draw them. The product now has ONE protagonist — the curated trip's ego
 * car — and background traffic stays in the engine where it belongs.
 *
 * The frame therefore contains:
 *
 * - the ego vehicle, or null before it spawns (and if its route never forms);
 * - SPARSE per-road traffic aggregates, so roads can be coloured by state in
 *   Issue #25 without shipping a single background vehicle object;
 * - control state for the ego's remaining route only — the city still runs
 *   every signal, presentation just stops transmitting the ones that do not
 *   matter to the challenge;
 * - the ego's trip progress, from facts the simulation actually has;
 * - runtime road conditions and incident markers the UI already needs.
 *
 * Deterministic for identical engine state.
 */
import type { EngineState } from "@/sim/engine";
import { roadSpeedFactor, severityForFactor } from "@/sim/road-traffic";
import { MIN_TRAFFIC_SPEED_FACTOR } from "@/sim/config";
import { currentQueueWaitMs } from "@/sim/approach-stats";
import { computeMetrics, type SimulationMetrics } from "@/sim/metrics";
import type { SignalStage } from "@/sim/signals";
import type { IncidentKind, IncidentRecord } from "@/sim/incidents";
import type { IntersectionId, RoadId, VehicleId, VehicleState, VehicleType } from "@/sim/types";
import { activeVehicleCount } from "@/sim/traffic";
import type { JevCause, JevCauseCounts } from "@/jev/runtime";
import type { JevPolicySource } from "@/jev/trace";

/** One directed road carrying visible state. Absent road = free baseline. */
export interface PresentationRoadTraffic {
  readonly roadId: RoadId;
  /** Footprint units currently on the road (the simulation's own measure). */
  readonly occupancy: number;
  /** Effective capacity, so a consumer can ratio the two without city data. */
  readonly capacity: number;
  /** Active vehicles on this road (any state except arrived). */
  readonly vehicleCount: number;
  /** Vehicles queued at this road's stop line. */
  readonly queuedCount: number;
  /**
   * Longest current blocked wait on this road, in ms. Kept here because road
   * congestion reads it, and one scalar per OCCUPIED road is still sparse —
   * versus a wait field on every vehicle object.
   */
  readonly maxBlockedWaitMs: number;
  /**
   * Authoritative flow state from the simulation (sim/road-traffic): the road's
   * current speed factor and the severity derived from it. Presentation reads
   * these instead of re-deriving congestion from occupancy.
   */
  readonly speedFactor: number;
  readonly severity: "free" | "slower" | "severe";
}

/**
 * The one vehicle the map draws. Everything here is a straight read of the
 * simulation's own vehicle: no re-derivation, no presentation-only physics.
 */
export interface PresentationEgoVehicle {
  readonly id: VehicleId;
  readonly type: VehicleType;
  readonly state: VehicleState;
  readonly roadId: RoadId | null;
  readonly progress: number;
  readonly routeIndex: number;
  readonly queueRank: number | null;
  readonly blockedWaitMs: number;
  /** Current effective speed (world units per second). */
  readonly speed: number;
}

export interface PresentationTripProgress {
  readonly tripId: string;
  readonly originIntersectionId: IntersectionId;
  readonly destinationIntersectionId: IntersectionId;
  /** The ego's CURRENT route — updates if an incident reroutes it. */
  readonly routeRoadIds: readonly RoadId[];
  readonly routeIndex: number;
  readonly tripTimeMs: number;
  readonly waitTimeMs: number;
  readonly distanceRemainingM: number;
  readonly distanceTravelledM: number;
  readonly intersectionsCleared: number;
  readonly completed: boolean;
  /**
   * Deterministic estimate of the time left, derived ONLY from the remaining
   * route's free-flow times and the AUTHORITATIVE per-road traffic state —
   * the same speed factor that slows vehicles and paints the map (a closed
   * road is priced at the model's jam floor). It ignores signal waits, so it
   * is an estimate, not a promise — which is why the HUD labels it "Est.".
   */
  readonly estimatedRemainingMs: number | null;
}

export interface PresentationSignal {
  readonly intersectionId: IntersectionId;
  readonly phaseIndex: number;
  readonly stage: SignalStage;
}

export interface PresentationRoadCondition {
  readonly roadId: RoadId;
  readonly closed: boolean;
  readonly capacity: number;
}

export interface PresentationIncidentMarker {
  readonly id: number;
  readonly kind: IncidentKind;
  readonly status: IncidentRecord["status"];
  readonly roadIds: readonly RoadId[];
  readonly eventCenterIntersectionId: IntersectionId | null;
  readonly expiresAtMs: number | null;
}

/**
 * Who actually governed the signals this run, in the smallest form the product
 * needs.
 *
 * `live` and `replay` mean a Jev policy was speaking; `waiting` means the run
 * has not started yet (its first policy is still being obtained) and
 * `invalidated` means Jev was lost and the run stopped. There is no member for
 * "something else decided": a live Jev run has no other controller in it.
 *
 * The same standard applies to the two halves of "the policy governed it": a
 * policy that governed past its freshness window was still the model's opinion,
 * but no fresh one arrived in time (`heldMs`), and an answer that had to be
 * clamped or dropped for low confidence was applied imperfectly (`clamped`,
 * `dropped`). Both are reported in the run's own record, so an artifact can say
 * exactly which of those happened instead of collapsing them into one word.
 */
export interface PresentationPolicy {
  /** Where the decisions come from: a policy (`live`/`replay`), or none at all. */
  readonly source: JevPolicySource;
  readonly liveMs: number;
  readonly replayMs: number;
  /**
   * Simulated ms an Adaptive controller governed. A HARD ZERO for a Jev run:
   * the controller has no Adaptive path, and the field is reported so the zero
   * is stated rather than implied.
   */
  readonly fallbackMs: number;
  /** Simulated ms NO Jev policy governed: time this run did not control. */
  readonly invalidMs?: number;
  /** Subset of the governed time covered after the policy's freshness window. */
  readonly heldMs?: number;
  /** Simulated ms a policy may keep governing without a replacement. */
  readonly maxHoldMs?: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly refreshes: number;
  /** Ticks an Adaptive controller decided. A HARD ZERO, for the same reason. */
  readonly adaptiveTicks?: number;
  /**
   * Why Jev is not governing (or did not start): a bounded, classified cause.
   * Null while a policy governs.
   */
  readonly cause?: JevCause | null;
  /** How many times each classified cause was seen. */
  readonly causes?: JevCauseCounts;
  /** Values clamped to their bounds across accepted answers. */
  readonly clamped?: number;
  /** Answers dropped below the confidence floor across accepted answers. */
  readonly dropped?: number;
  /**
   * Non-null once Jev was LOST: the simulated instant the policy in force
   * outlived its maximum hold, and the classified reason. The run stopped there
   * with its measurements kept; it was never continued under another controller.
   */
  readonly invalidation?: { readonly atSimMs: number; readonly reason: JevCause } | null;
}

/** Fraction of a Jev run NO Jev policy governed, in [0,1]. */
export function ungovernedShare(policy: PresentationPolicy): number {
  const total = policy.liveMs + policy.replayMs + (policy.invalidMs ?? 0) + policy.fallbackMs;
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (policy.invalidMs ?? 0) / total));
}

/**
 * Fraction of a policy run the model's policy governed AFTER its freshness
 * window — i.e. how much of "live Jev" was an opinion nobody had refreshed.
 */
export function heldShare(policy: PresentationPolicy): number {
  const total = policy.liveMs + policy.replayMs + (policy.invalidMs ?? 0) + policy.fallbackMs;
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (policy.heldMs ?? 0) / total));
}

/**
 * How honest this run's result is allowed to be about itself (Issue #39).
 *
 * `modified` is true once anything changed the scenario under the run — a live
 * traffic change or a controller swap — and `manualIncidents` counts the chaos
 * a human queued. Both decide whether the result may sit beside clean baselines,
 * so the UI must be able to read them while the run is still going, not only
 * from a finished ChallengeResult.
 */
export interface RunGovernance {
  readonly modified: boolean;
  readonly manualIncidents: number;
}

export const CLEAN_RUN: RunGovernance = { modified: false, manualIncidents: 0 };

export interface PresentationSnapshot {
  /** Monotonic frame counter from the worker. */
  readonly sequence: number;
  readonly timeMs: number;
  readonly controller: string;
  /** Whether the run still describes the scenario it started as. */
  readonly governance: RunGovernance;
  /** Policy provenance, or null for controllers that have no external policy. */
  readonly policy: PresentationPolicy | null;
  /** The challenge's protagonist, or null before it exists. At most one. */
  readonly ego: PresentationEgoVehicle | null;
  /** Sparse road state for later traffic colouring. No vehicle objects. */
  readonly roadTraffic: readonly PresentationRoadTraffic[];
  /** Control state on the ego's remaining route only. */
  readonly routeControls: readonly PresentationSignal[];
  readonly trip: PresentationTripProgress | null;
  readonly roadConditions: readonly PresentationRoadCondition[];
  readonly incidents: readonly PresentationIncidentMarker[];
}

export type PresentationMetrics = SimulationMetrics & {
  readonly activeVehicles: number;
};

/**
 * Queue rank per vehicle: 0 is the front of its directed road's queue.
 *
 * The rule is copied from `sim/traffic.ts` deliberately — queuedSinceMs
 * ascending, then id — because presentation must never disagree with the
 * simulation about who is in front. Exported so the exact semantics are
 * testable without standing up an engine.
 */
export function assignQueueRanks(
  vehicles: readonly {
    readonly id: VehicleId;
    readonly state: string;
    readonly roadId: RoadId | null;
    readonly queuedSinceMs: number | null;
  }[],
): Map<VehicleId, number> {
  const ranks = new Map<VehicleId, number>();
  const queues = new Map<RoadId, { id: VehicleId; since: number }[]>();
  for (const vehicle of vehicles) {
    if (vehicle.state !== "queued" || vehicle.roadId === null) {
      continue;
    }
    const list = queues.get(vehicle.roadId) ?? [];
    list.push({ id: vehicle.id, since: vehicle.queuedSinceMs ?? 0 });
    queues.set(vehicle.roadId, list);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => a.since - b.since || a.id - b.id);
    queue.forEach((entry, rank) => ranks.set(entry.id, rank));
  }
  return ranks;
}

/** Blocked wait by state: continuous while queued, pending wait, else zero. */
function blockedWaitOf(engine: EngineState, vehicle: EngineState["traffic"]["vehicles"][number]): number {
  if (vehicle.state === "queued") {
    return currentQueueWaitMs(engine.traffic.timeMs, vehicle.queuedSinceMs);
  }
  if (vehicle.state === "pending") {
    return vehicle.waitTimeMs;
  }
  return 0;
}

/**
 * Sparse road aggregates: only roads with vehicles or queues appear. An absent
 * road is a free road, so the payload scales with NETWORK STATE rather than
 * with the number of vehicle objects.
 */
export function aggregateRoadTraffic(engine: EngineState): PresentationRoadTraffic[] {
  const vehicleCounts = new Map<RoadId, number>();
  const queuedCounts = new Map<RoadId, number>();
  const maxWaits = new Map<RoadId, number>();
  // Live traffic only: arrived vehicles were skipped by the history scan too.
  for (const vehicle of engine.traffic.activeVehicles) {
    if (vehicle.roadId === null) {
      continue;
    }
    vehicleCounts.set(vehicle.roadId, (vehicleCounts.get(vehicle.roadId) ?? 0) + 1);
    if (vehicle.state === "queued") {
      queuedCounts.set(vehicle.roadId, (queuedCounts.get(vehicle.roadId) ?? 0) + 1);
    }
    const wait = blockedWaitOf(engine, vehicle);
    if (wait > 0) {
      maxWaits.set(vehicle.roadId, Math.max(maxWaits.get(vehicle.roadId) ?? 0, wait));
    }
  }
  const roadIds = new Set<RoadId>(engine.traffic.occupancy.keys());
  for (const roadId of queuedCounts.keys()) {
    roadIds.add(roadId);
  }
  // Roads still RECOVERING in the authoritative state stay in the frame even
  // though their occupancy has already dropped to zero: the simulation has not
  // declared them clear yet, so the map must not either.
  for (const roadId of engine.traffic.roadTraffic.factor.keys()) {
    roadIds.add(roadId);
  }
  return [...roadIds]
    .sort((a, b) => a - b)
    .map((roadId) => {
      const factor = roadSpeedFactor(engine.traffic.roadTraffic, roadId);
      return {
        roadId,
        occupancy: engine.traffic.occupancy.get(roadId) ?? 0,
        capacity: engine.city.roads[roadId]?.capacity ?? 0,
        vehicleCount: vehicleCounts.get(roadId) ?? 0,
        queuedCount: queuedCounts.get(roadId) ?? 0,
        maxBlockedWaitMs: maxWaits.get(roadId) ?? 0,
        // The simulation's own flow state: how fast traffic actually moves on
        // this road right now, and the severity that follows from it. Every
        // consumer paints from these two fields, so colours cannot disagree
        // with the physics they describe.
        speedFactor: factor,
        severity: severityForFactor(factor),
      };
    });
}

/** Intersections the ego still has to pass: the remaining route's endpoints. */
function remainingRouteIntersections(
  engine: EngineState,
  route: readonly RoadId[],
  routeIndex: number,
): Set<IntersectionId> {
  const nodes = new Set<IntersectionId>();
  for (let index = Math.max(0, routeIndex - 1); index < route.length; index += 1) {
    const road = engine.city.roads[route[index]];
    if (!road) {
      continue;
    }
    nodes.add(road.from);
    nodes.add(road.to);
  }
  return nodes;
}

function tripProgressOf(
  engine: EngineState,
  tripId: string | null,
  ego: EngineState["traffic"]["vehicles"][number],
): PresentationTripProgress | null {
  if (tripId === null) {
    return null;
  }
  let travelled = 0;
  let remaining = 0;
  for (let index = 0; index < ego.route.length; index += 1) {
    const length = engine.city.roads[ego.route[index]]?.length ?? 0;
    if (index < ego.routeIndex) {
      travelled += length;
    } else if (index === ego.routeIndex) {
      travelled += Math.max(0, Math.min(length, ego.progress));
      remaining += Math.max(0, length - ego.progress);
    } else {
      remaining += length;
    }
  }
  let etaSeconds = 0;
  for (let index = ego.routeIndex; index < ego.route.length; index += 1) {
    const road = engine.city.roads[ego.route[index]];
    if (!road || road.speedLimit <= 0) {
      continue;
    }
    const length = index === ego.routeIndex ? Math.max(0, road.length - ego.progress) : road.length;
    // The SAME authoritative speed factor that slows vehicles, prices the
    // router and paints the map — no second slowdown model in the ETA.
    const factor = road.closed
      ? MIN_TRAFFIC_SPEED_FACTOR
      : roadSpeedFactor(engine.traffic.roadTraffic, road.id);
    etaSeconds += length / road.speedLimit / factor;
  }
  const completed = ego.state === "arrived";
  return {
    tripId,
    originIntersectionId: ego.origin,
    destinationIntersectionId: ego.destination,
    routeRoadIds: [...ego.route],
    routeIndex: ego.routeIndex,
    tripTimeMs: ego.tripTimeMs,
    waitTimeMs: ego.waitTimeMs,
    distanceRemainingM: remaining,
    distanceTravelledM: travelled,
    intersectionsCleared: ego.routeIndex,
    completed,
    estimatedRemainingMs: completed ? 0 : Math.round(etaSeconds * 1_000),
  };
}

export function buildPresentationSnapshot(
  engine: EngineState,
  sequence: number,
  tripId: string | null = null,
  policy: PresentationPolicy | null = null,
  governance: RunGovernance = CLEAN_RUN,
): PresentationSnapshot {
  const vehicles = engine.traffic.vehicles;
  const queueRanks = assignQueueRanks(vehicles);

  // Exactly one ego, identified by the id the engine recorded when the ego
  // spawn created its vehicle — never by position in the vehicle list.
  const egoVehicle =
    engine.egoVehicleId === null ? undefined : vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
  const ego: PresentationEgoVehicle | null = egoVehicle
    ? {
        id: egoVehicle.id,
        type: egoVehicle.type,
        state: egoVehicle.state,
        roadId: egoVehicle.roadId,
        progress: egoVehicle.progress,
        routeIndex: egoVehicle.routeIndex,
        queueRank: queueRanks.get(egoVehicle.id) ?? null,
        blockedWaitMs: blockedWaitOf(engine, egoVehicle),
        // An arrived car is parked: report 0 rather than the speed it was
        // carrying when it crossed the destination.
        speed: egoVehicle.state === "arrived" ? 0 : egoVehicle.speed,
      }
    : null;

  // Control state is filtered to the ego's remaining route: the data exists for
  // the challenge, not for a citywide signal field. No visual behaviour here —
  // Issue #26 decides how controls appear.
  const routeNodes = egoVehicle
    ? remainingRouteIntersections(engine, egoVehicle.route, egoVehicle.routeIndex)
    : new Set<IntersectionId>();
  const routeControls: PresentationSignal[] = [...engine.traffic.signals.entries()]
    .filter(([intersectionId]) => routeNodes.has(intersectionId))
    .sort((a, b) => a[0] - b[0])
    .map(([intersectionId, signal]) => ({
      intersectionId,
      phaseIndex: signal.phaseIndex,
      stage: signal.stage,
    }));

  const roadConditions: PresentationRoadCondition[] = [];
  for (const road of engine.city.roads) {
    const base = engine.baseCity.roads[road.id];
    if (road.closed !== base.closed || road.capacity !== base.capacity) {
      roadConditions.push({ roadId: road.id, closed: road.closed, capacity: road.capacity });
    }
  }
  roadConditions.sort((a, b) => a.roadId - b.roadId);

  const incidents: PresentationIncidentMarker[] = [...engine.incidents.records]
    .sort((a, b) => a.id - b.id)
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      roadIds: [...record.roadIds],
      eventCenterIntersectionId: record.eventCenterIntersectionId,
      expiresAtMs: record.expiresAtMs,
    }));

  return {
    sequence,
    timeMs: engine.traffic.timeMs,
    controller: engine.controller.id,
    governance,
    policy,
    ego,
    roadTraffic: aggregateRoadTraffic(engine),
    routeControls,
    trip: egoVehicle ? tripProgressOf(engine, tripId, egoVehicle) : null,
    roadConditions,
    incidents,
  };
}

export function buildPresentationMetrics(engine: EngineState): PresentationMetrics {
  return {
    ...computeMetrics(engine.metrics, engine.traffic),
    activeVehicles: activeVehicleCount(engine.traffic),
  };
}
