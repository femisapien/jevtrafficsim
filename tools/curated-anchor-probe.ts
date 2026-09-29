/**
 * Curated-anchor explorer: probe candidate origin/destination anchors for a
 * curated trip against the real Metro graph BEFORE running the full traffic
 * report. Prints the route's length, road count, kinds, crossings, signals,
 * streets, and its overlap (intersection/union) with the five other curated
 * routes — the contract tests/chicago-trips.test.ts enforces.
 *
 *   pnpm tsx tools/curated-anchor-probe.ts --trip willis-tower-to-near-west-side \
 *     --dest-lon -87.649 --dest-lat 41.8865
 *
 * With no overrides it prints the current anchors of every trip.
 */
import {
  CURATED_TRIPS,
  materializeCuratedTrip,
  type CuratedTrip,
  type CuratedTripId,
} from "@/cities/chicago-trips";
import { loadBenchmarkModel } from "@/benchmark/model";

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const model = await loadBenchmarkModel();
  const tripArg = arg("--trip");
  const originLon = arg("--origin-lon");
  const originLat = arg("--origin-lat");
  const destLon = arg("--dest-lon");
  const destLat = arg("--dest-lat");

  const targets: CuratedTripId[] = tripArg
    ? ([tripArg] as CuratedTripId[])
    : (CURATED_TRIPS.map((t) => t.id) as CuratedTripId[]);

  for (const id of targets) {
    const trip = CURATED_TRIPS.find((t) => t.id === id)!;
    const overridden =
      originLon !== null || destLon !== null
        ? ({
            ...trip,
            origin:
              originLon !== null
                ? { name: `${trip.origin.name} (probe)`, lon: Number(originLon), lat: Number(originLat) }
                : trip.origin,
            destination:
              destLon !== null
                ? {
                    name: `${trip.destination.name} (probe)`,
                    lon: Number(destLon),
                    lat: Number(destLat),
                  }
                : trip.destination,
          } satisfies CuratedTrip)
        : trip;
    let materialized;
    try {
      materialized = materializeCuratedTrip(model, { tripId: id, seed: 42 }, {});
      if (overridden !== trip) {
        // materializeCuratedTrip reads the registry by id; build the changed
        // anchor set through a local copy instead.
        throw new Error("internal: use probeTrip path");
      }
    } catch {
      // fall through to the override path below
    }
    if (overridden !== trip) {
      // Manual materialization with the overridden anchors: reuse the module's
      // internals via the public API on a modified registry entry is not
      // possible, so snap + route directly here.
      const { nearestIntersectionTo } = await import("@/cities/chicago");
      const { findRoute } = await import("@/sim/astar");
      const originId = nearestIntersectionTo(model, overridden.origin.lon, overridden.origin.lat);
      const destinationId = nearestIntersectionTo(
        model,
        overridden.destination.lon,
        overridden.destination.lat,
      );
      if (originId === null || destinationId === null) {
        console.log(`${id}: override did not snap to the graph`);
        continue;
      }
      const route = findRoute(model.city, originId, destinationId);
      if (!route.found) {
        console.log(`${id}: override route not found`);
        continue;
      }
      const roads = route.roadIds.map((r) => model.city.roads[r]);
      const kinds = [...new Set(roads.map((r) => r.kind))].sort() as string[];
      const signals = route.roadIds.filter(
        (r) => model.city.intersections[model.city.roads[r].to]?.control === "signal",
      ).length;
      const crossings = new Set(
        model.waterCrossingBridges
          .filter((b) => route.roadIds.includes(b.roadId))
          .map((b) => b.groupId),
      );
      const streetNames = [
        ...new Set(
          model.streets
            .filter((s) => s.roadIds.some((r) => route.roadIds.includes(r)))
            .map((s) => s.name)
            .filter((n): n is string => Boolean(n)),
        ),
      ];
      const others = CURATED_TRIPS.filter((t) => t.id !== id).map((t) =>
        materializeCuratedTrip(model, { tripId: t.id, seed: 42 }),
      );
      const thisRoads = new Set(route.roadIds);
      const overlaps = others.map((o) => {
        const otherRoads = new Set(o.route.roadIds);
        const inter = [...thisRoads].filter((r) => otherRoads.has(r)).length;
        const union = new Set([...thisRoads, ...otherRoads]).size;
        return `${o.trip.id}: ${((inter / union) * 100).toFixed(0)}%`;
      });
      console.log(
        `${id} (overridden)\n` +
          `  origin      ${overridden.origin.name} (${overridden.origin.lon}, ${overridden.origin.lat})\n` +
          `  destination ${overridden.destination.name} (${overridden.destination.lon}, ${overridden.destination.lat})\n` +
          `  route       ${route.roadIds.length} roads, ${(roads.reduce((s, r) => s + r.length, 0) / 1000).toFixed(1)} km, ` +
          `kinds=[${kinds.join(", ")}] signals=${signals} crossings=${crossings.size} streets=${streetNames.length}\n` +
          `  overlap     ${overlaps.join("  ")}\n`,
      );
      continue;
    }
    const pairs = CURATED_TRIPS.filter((t) => t.id !== id).map((t) => {
      const other = materializeCuratedTrip(model, { tripId: t.id, seed: 42 });
      const inter = materialized!.route.roadIds.filter((r) => other.route.roadIds.includes(r)).length;
      const union = new Set([...materialized!.route.roadIds, ...other.route.roadIds]).size;
      return `${t.id}: ${((inter / union) * 100).toFixed(0)}%`;
    });
    console.log(
      `${id}\n` +
        `  origin      ${trip.origin.name} (${trip.origin.lon}, ${trip.origin.lat})\n` +
        `  destination ${trip.destination.name} (${trip.destination.lon}, ${trip.destination.lat})\n` +
        `  route       ${materialized!.route.roadIds.length} roads, ${(materialized!.coverage.lengthM / 1000).toFixed(1)} km, ` +
        `kinds=[${materialized!.coverage.roadKinds.join(", ")}] signals=${materialized!.coverage.signalCount} stops=${materialized!.coverage.stopCount} crossings=${materialized!.coverage.waterCrossingCount} streets=${materialized!.coverage.streetNames.length}\n` +
        `  overlap     ${pairs.join("  ")}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});