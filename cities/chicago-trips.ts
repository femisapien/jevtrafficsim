/**
 * Curated Chicago challenge trips (Issue #23).
 *
 * The public product no longer asks the user to choose an arbitrary city size.
 * It offers six researched, human-readable Chicago trips on the frozen Metro
 * graph. Geography is still real Chicago; this module only chooses stable
 * origin/destination anchors and materializes the route with the existing A*.
 *
 * The selected trip is evaluation/presentation metadata. Controllers do not
 * receive ego identity or route information through this module.
 */
import { nearestIntersectionTo } from "./chicago";
import type { MapModel } from "./map-model";
import { findRoute, type RouteFound, type RouteOptions } from "@/sim/astar";
import type { CorridorKind, RoadKind } from "@/sim/types";

export const CURATED_TRIP_IDS = [
  "soldier-field-to-navy-pier",
  "united-center-to-willis-tower",
  "river-north-to-navy-pier",
  "millennium-park-to-west-loop",
  "streeterville-to-south-loop",
  "willis-tower-to-near-west-side",
] as const;

export type CuratedTripId = (typeof CURATED_TRIP_IDS)[number];

export interface TripAnchor {
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
}

export interface CuratedTripCameraHint {
  readonly mode: "fit-route";
  readonly paddingPx: number;
  readonly maxZoom: number;
}

export interface CuratedTrip {
  readonly id: CuratedTripId;
  readonly label: string;
  readonly summary: string;
  readonly origin: TripAnchor;
  readonly destination: TripAnchor;
  readonly camera: CuratedTripCameraHint;
  /** Human-curated expectations that tests verify against the actual Metro route. */
  readonly expected: {
    readonly minRoadKinds: number;
    readonly features: readonly (
      | "downtown-grid"
      | "local-streets"
      | "major-arterial"
      | "river-crossing"
      | "expressway"
      | "lakefront"
      | "diagonal-corridor"
    )[];
  };
}

export interface CuratedTripCoverage {
  readonly roadKinds: readonly RoadKind[];
  readonly corridorKinds: readonly CorridorKind[];
  readonly roadCount: number;
  readonly lengthM: number;
  readonly signalCount: number;
  readonly stopCount: number;
  readonly waterCrossingCount: number;
  readonly streetNames: readonly string[];
}

export interface CuratedTripSelection {
  readonly tripId: CuratedTripId;
  readonly seed: number;
}

export interface MaterializedCuratedTrip {
  readonly trip: CuratedTrip;
  readonly seed: number;
  readonly originIntersectionId: number;
  readonly destinationIntersectionId: number;
  readonly route: RouteFound;
  readonly coverage: CuratedTripCoverage;
  /** Stable non-cryptographic identity for deterministic scenario plumbing. */
  readonly routeKey: string;
}

/** The curated challenge runs the full Metro city: the trips are defined for it. */
export const METRO_SCALE_INDEX = 4;

/**
 * Anchors reuse the same Chicago coordinates already shipped by the showcase.
 * They are intentionally recognizable places/neighborhoods rather than opaque
 * graph node ids; snapping to the frozen graph is deterministic.
 */
export const CURATED_TRIPS: readonly CuratedTrip[] = [
  {
    id: "soldier-field-to-navy-pier",
    label: "Soldier Field → Navy Pier",
    summary: "Lakefront trunk roads, downtown signals, the river and the pier.",
    origin: { name: "Soldier Field", lon: -87.6167, lat: 41.8623 },
    destination: { name: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    camera: { mode: "fit-route", paddingPx: 88, maxZoom: 15.9 },
    expected: {
      minRoadKinds: 4,
      features: ["local-streets", "major-arterial", "river-crossing", "lakefront", "downtown-grid"],
    },
  },
  {
    id: "united-center-to-willis-tower",
    label: "United Center → Willis Tower",
    summary: "West Side streets, the Eisenhower, and a downtown finish.",
    origin: { name: "United Center", lon: -87.6742, lat: 41.8806 },
    destination: { name: "Willis Tower", lon: -87.6359, lat: 41.8789 },
    camera: { mode: "fit-route", paddingPx: 88, maxZoom: 15.9 },
    expected: {
      minRoadKinds: 4,
      // Only 7 signals on this route — the Eisenhower does the heavy lifting —
      // so it does NOT claim downtown-grid (the ≥10-signal contract).
      features: ["local-streets", "major-arterial", "expressway", "river-crossing"],
    },
  },
  {
    id: "river-north-to-navy-pier",
    label: "River North → Navy Pier",
    summary: "Dense downtown streets out to the lakefront and the pier.",
    origin: { name: "River North", lon: -87.634, lat: 41.893 },
    destination: { name: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    camera: { mode: "fit-route", paddingPx: 88, maxZoom: 16.0 },
    expected: {
      minRoadKinds: 2,
      // Downtown streets the whole way: no river crossing and no Lake Shore
      // Drive on this route, so neither is claimed.
      features: ["local-streets", "major-arterial", "downtown-grid"],
    },
  },
  {
    id: "millennium-park-to-west-loop",
    label: "Millennium Park → West Loop",
    summary: "Loop grid, river crossing, Randolph corridor, then neighborhood streets.",
    origin: { name: "Millennium Park", lon: -87.6229, lat: 41.8826 },
    destination: { name: "West Loop", lon: -87.652, lat: 41.883 },
    camera: { mode: "fit-route", paddingPx: 84, maxZoom: 16.2 },
    expected: {
      minRoadKinds: 3,
      features: ["local-streets", "major-arterial", "river-crossing", "downtown-grid"],
    },
  },
  {
    id: "streeterville-to-south-loop",
    label: "Streeterville → South Loop",
    summary: "Dense downtown streets, the river, and a South Loop finish.",
    origin: { name: "Streeterville", lon: -87.617, lat: 41.893 },
    destination: { name: "South Loop", lon: -87.627, lat: 41.872 },
    camera: { mode: "fit-route", paddingPx: 88, maxZoom: 15.9 },
    expected: {
      minRoadKinds: 2,
      features: ["major-arterial", "river-crossing", "downtown-grid"],
    },
  },
  {
    id: "willis-tower-to-near-west-side",
    label: "Willis Tower → Near West Side",
    summary: "Downtown grid, a bridge crossing, and a Near West Side arterial finish.",
    origin: { name: "Willis Tower", lon: -87.6359, lat: 41.8789 },
    destination: { name: "Near West Side", lon: -87.654, lat: 41.872 },
    camera: { mode: "fit-route", paddingPx: 84, maxZoom: 16.0 },
    expected: {
      minRoadKinds: 3,
      features: ["major-arterial", "expressway", "river-crossing", "downtown-grid"],
    },
  },
] as const;

const BY_ID = new Map<CuratedTripId, CuratedTrip>(CURATED_TRIPS.map((trip) => [trip.id, trip]));

export function curatedTrip(id: CuratedTripId): CuratedTrip {
  const trip = BY_ID.get(id);
  if (!trip) {
    throw new RangeError(`unknown curated Chicago trip ${String(id)}`);
  }
  return trip;
}

function routeCoverage(model: MapModel, roadIds: readonly number[]): CuratedTripCoverage {
  const roads = roadIds.map((id) => model.city.roads[id]);
  const roadKinds = [...new Set(roads.map((road) => road.kind))].sort() as RoadKind[];
  const routeRoads = new Set(roadIds);
  const corridorKinds = [
    ...new Set(
      model.city.corridors
        .filter((corridor) => corridor.roadIds.some((roadId) => routeRoads.has(roadId)))
        .map((corridor) => corridor.kind),
    ),
  ].sort() as CorridorKind[];

  let signalCount = 0;
  let stopCount = 0;
  for (const road of roads) {
    const control = model.city.intersections[road.to]?.control;
    if (control === "signal") signalCount += 1;
    if (control === "stop") stopCount += 1;
  }

  const crossingGroups = new Set(
    model.waterCrossingBridges
      .filter((bridge) => routeRoads.has(bridge.roadId))
      .map((bridge) => bridge.groupId),
  );

  const streetNames = [
    ...new Set(
      model.streets
        .filter((street) => street.roadIds.some((roadId) => routeRoads.has(roadId)))
        .map((street) => street.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  return {
    roadKinds,
    corridorKinds,
    roadCount: roadIds.length,
    lengthM: roads.reduce((sum, road) => sum + road.length, 0),
    signalCount,
    stopCount,
    waterCrossingCount: crossingGroups.size,
    streetNames,
  };
}

/**
 * Materializes one curated trip against the real Metro graph.
 *
 * `seed` is deliberately carried as scenario identity but does not perturb
 * static geography. Traffic-aware routing is represented by `routeOptions`
 * (not hidden randomness), so identical trip + seed + traffic state is exactly
 * reproducible.
 */
export function materializeCuratedTrip(
  model: MapModel,
  selection: CuratedTripSelection,
  routeOptions: RouteOptions = {},
): MaterializedCuratedTrip {
  if (model.scaleIndex !== METRO_SCALE_INDEX) {
    throw new RangeError(
      `curated challenge trips require Metro Chicago (scale 4), received scale ${model.scaleIndex}`,
    );
  }
  if (!Number.isInteger(selection.seed) || selection.seed < 0 || selection.seed > 0xffffffff) {
    throw new RangeError(`curated trip seed must be uint32, received ${selection.seed}`);
  }

  const trip = curatedTrip(selection.tripId);
  const originIntersectionId = nearestIntersectionTo(
    model,
    trip.origin.lon,
    trip.origin.lat,
  );
  const destinationIntersectionId = nearestIntersectionTo(
    model,
    trip.destination.lon,
    trip.destination.lat,
  );
  if (originIntersectionId === null || destinationIntersectionId === null) {
    throw new Error(`curated trip ${trip.id} could not snap to the Metro graph`);
  }

  const route = findRoute(
    model.city,
    originIntersectionId,
    destinationIntersectionId,
    routeOptions,
  );
  if (!route.found) {
    throw new Error(`curated trip ${trip.id} is unreachable on the current traffic state`);
  }

  return {
    trip,
    seed: selection.seed >>> 0,
    originIntersectionId,
    destinationIntersectionId,
    route,
    coverage: routeCoverage(model, route.roadIds),
    routeKey: `${trip.id}:${originIntersectionId}:${destinationIntersectionId}:${route.roadIds.join(".")}`,
  };
}
