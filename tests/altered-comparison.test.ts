/**
 * An altered run shows its numbers, marked (owner's decision).
 *
 * The fairness boundary is the point of this file:
 *
 *   - a run nobody touched takes exactly the path it always took — no marker,
 *     no extra word, same numbers;
 *   - a run a human changed still shows the comparison's numbers, under a marker
 *     that says what was changed and when, and that it is not comparable;
 *   - the guard keeps refusing an altered run. Showing is not comparing, and
 *     `alteredComparisonAllowed` is only allowed to say yes when the alteration
 *     is the ONLY reason for the refusal;
 *   - the marker never names an intervention the run did not queue.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createEngine, queueIncident, runEngine, type ScheduledSpawn } from "@/sim/engine";
import type { City, Intersection, Road } from "@/sim/types";
import {
  ALTERED_COMPARISON_FOOTER,
  ALTERED_RUN_BOUNDARY,
  ALTERED_RUN_TITLE,
  ALTERED_SCENARIO_TITLE,
  alteredRunNotice,
  COMPARISON_FOOTER,
} from "@/components/ui-model";
import {
  alteredComparisonAllowed,
  buildChallengeResult,
  comparisonVerdictAll,
  type ChallengeResult,
} from "@/worker/challenge-result";
import { buildChallengeScenario } from "@/worker/challenge-scenario";

function result(overrides: Partial<ChallengeResult> = {}): ChallengeResult {
  return {
    fingerprint: "same0001",
    controller: "jev",
    driver: "tourist",
    manualIncidents: 0,
    modified: false,
    simulatedMs: 600_000,
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

const fixed = result({ controller: "fixed" });
const adaptive = result({ controller: "adaptive" });
const clean = result();

describe("an altered run keeps its numbers, marked", () => {
  it("shows nothing different for a run nobody touched", () => {
    // The panel reads these two; both say "no alteration", so the clean path is
    // the one it always took: same rows, same sentence, no marker.
    expect(alteredRunNotice(clean)).toBeNull();
    expect(alteredComparisonAllowed(fixed, adaptive, clean)).toBe(false);
  });

  it("still refuses the comparison — showing is not comparing", () => {
    const altered = result({ manualIncidents: 1, modified: false });
    expect(comparisonVerdictAll([fixed, adaptive, altered])).toEqual({
      comparable: false,
      reason: "a run was changed by hand",
    });
    // ...and the numbers may be shown anyway, which is the whole change.
    expect(alteredComparisonAllowed(fixed, adaptive, altered)).toBe(true);
  });

  it("shows the numbers for a run whose scenario moved mid-run too", () => {
    const moved = result({ modified: true });
    expect(comparisonVerdictAll([fixed, adaptive, moved]).comparable).toBe(false);
    expect(alteredComparisonAllowed(fixed, adaptive, moved)).toBe(true);
  });

  it("hides the numbers when the refusal is about anything else", () => {
    const altered = result({ manualIncidents: 1 });
    // A different world: these columns are not three runs of one scenario.
    expect(alteredComparisonAllowed(fixed, adaptive, { ...altered, fingerprint: "other000" }))
      .toBe(false);
    // A baseline disagreeing on the world is still a mismatch.
    expect(alteredComparisonAllowed({ ...fixed, fingerprint: "other000" }, adaptive, altered))
      .toBe(false);
    // The same controller twice is not a comparison either.
    expect(alteredComparisonAllowed(fixed, { ...adaptive, controller: "fixed" }, altered))
      .toBe(false);
    // Only the VISIBLE run may be forgiven for having been altered.
    expect(alteredComparisonAllowed({ ...fixed, manualIncidents: 1 }, adaptive, { ...clean }))
      .toBe(false);
  });
});

describe("the marker says what changed, and when", () => {
  it("names the interventions the run recorded, in the dock's own words", () => {
    const notice = alteredRunNotice(
      result({
        manualIncidents: 2,
        interventions: [
          { kind: "crash", atMs: 72_000 },
          { kind: "close-road", atMs: 220_000 },
        ],
      }),
    );
    expect(notice?.title).toBe(ALTERED_RUN_TITLE);
    expect(notice?.detail).toBe("Fired during this run: Crash at 1:12, Close Road at 3:40.");
    expect(notice?.boundary).toBe(ALTERED_RUN_BOUNDARY);
  });

  it("falls back to the count when the run has no entry to name", () => {
    // Never invent a kind: with no recorded entries, only the count is said.
    const notice = alteredRunNotice(result({ manualIncidents: 2 }));
    expect(notice?.detail).toContain("2 interventions");
    const single = alteredRunNotice(result({ manualIncidents: 1 }));
    expect(single?.detail).toContain("1 intervention.");
  });

  it("names a mid-run change without claiming an incident caused it", () => {
    const notice = alteredRunNotice(result({ modified: true }));
    expect(notice?.title).toBe(ALTERED_SCENARIO_TITLE);
    expect(notice?.detail).toContain("setting changed");
    expect(notice?.detail).not.toContain("Crash");
    // Both at once says both, and the title names the hand that did it.
    const both = alteredRunNotice(
      result({ manualIncidents: 1, modified: true, interventions: [{ kind: "crash", atMs: 5_000 }] }),
    );
    expect(both?.title).toBe(ALTERED_RUN_TITLE);
    expect(both?.detail).toContain("Crash at 0:05");
    expect(both?.detail).toContain("setting changed");
  });

  it("says plainly that the numbers are not comparable", () => {
    expect(ALTERED_RUN_BOUNDARY).toContain("not comparable");
    expect(ALTERED_RUN_BOUNDARY).toContain("Fixed and Adaptive");
    // The details footer must not repeat the clean run's claim about incidents
    // being identical; the hand-made changes are not in the baselines.
    expect(ALTERED_COMPARISON_FOOTER).not.toBe(COMPARISON_FOOTER);
    expect(ALTERED_COMPARISON_FOOTER).toContain("automatic incidents");
  });
});

/* ------------------------------------------------------------------ */
/* What the run itself records                                         */
/* ------------------------------------------------------------------ */

/** The incident-queue fixture's city: the four-node grid used above. */
function routeCity(): City {
  const intersections: Intersection[] = [
    { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 1, x: 10, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 2, x: 0, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 3, x: 10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
  ];
  const road = (id: number, from: number, to: number, length: number): Road => ({
    id,
    from,
    to,
    length,
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local",
    closed: false,
  });
  const roads: Road[] = [
    road(0, 0, 1, 40),
    road(1, 1, 0, 40),
    road(2, 0, 2, 80),
    road(3, 2, 0, 80),
    road(4, 1, 3, 40),
    road(5, 3, 1, 40),
    road(6, 2, 3, 80),
    road(7, 3, 2, 80),
  ];
  for (const r of roads) {
    intersections[r.from].outgoing.push(r.id);
    intersections[r.to].incoming.push(r.id);
  }
  return { size: "small", seed: 0, gridWidth: 2, gridHeight: 2, intersections, roads, corridors: [] };
}

const SCENARIO = buildChallengeScenario({
  tripId: "soldier-field-to-navy-pier",
  trafficLevel: "everyday",
  driver: "tourist",
  seed: 42,
  durationMs: 600_000,
});

function engineFor(): ReturnType<typeof createEngine> {
  const spawns: ScheduledSpawn[] = [
    { timeMs: 0, type: "car", origin: 0, destination: 3 },
  ];
  return createEngine({ city: routeCity(), controller: createFixedController(), spawns });
}

describe("the result records only interventions the run really queued", () => {
  it("carries the kind and the simulated time of each hand-fired incident", () => {
    const engine = engineFor();
    runEngine(engine, 1_000);
    queueIncident(engine, { kind: "crash", targetRoadId: 0, durationMs: 5_000 });
    queueIncident(engine, { kind: "close-road", targetRoadId: 4, durationMs: 5_000 });
    const built = buildChallengeResult(engine, SCENARIO, "jev", 2, false);
    expect(built.interventions).toEqual([
      { kind: "crash", atMs: 1_000 },
      { kind: "close-road", atMs: 1_000 },
    ]);
  });

  it("omits the field on a clean run, so a clean result serializes as it always has", () => {
    const engine = engineFor();
    runEngine(engine, 1_000);
    const built = buildChallengeResult(engine, SCENARIO, "adaptive", 0, false);
    expect("interventions" in built).toBe(false);
    expect(JSON.stringify(built)).not.toContain("interventions");
    // And nothing to mark, so the panel takes its clean path.
    expect(alteredRunNotice(built)).toBeNull();
  });

  it("never reports more than the run queued, even when the count says more", () => {
    const engine = engineFor();
    runEngine(engine, 1_000);
    const built = buildChallengeResult(engine, SCENARIO, "jev", 1, false);
    expect(built.interventions ?? []).toEqual([]);
    expect(alteredRunNotice(built)?.detail).toContain("1 intervention");
  });
});

/* ------------------------------------------------------------------ */
/* The panel's own wiring                                              */
/* ------------------------------------------------------------------ */

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("the panel shows an altered run's numbers under the marker", () => {
  const panel = source("components/ComparisonPanel.tsx");

  it("keeps a refusal with nothing to show down to one line and one number", () => {
    expect(panel).toContain("No comparison for this run: {verdict.reason}.");
    expect(panel).toContain("if (!verdict.comparable && !alteredNumbers && !otherScenario) {");
    // No reassurance above the numbers: the run's own time is the useful part.
    expect(panel).not.toContain("The trip still happened");
  });

  it("renders the marker above the rows, and drops the winner sentence", () => {
    expect(panel).toContain("data-jev-altered");
    expect(panel).toContain("alteredRunNotice(live)");
    // Both halves of the notice reach the marker that qualifies the numbers.
    expect(panel).toContain("notice?.title");
    expect(panel).toContain("notice?.detail");
    expect(panel).toContain("notice?.boundary");
    // "faster than Adaptive" is a comparison claim: not for an altered run.
    expect(panel).toContain("{race && delta !== null && (");
  });

  it("shows another scenario's baselines too, under their own marker", () => {
    // The owner's rule: a refusal keeps its numbers in every shape it can
    // honestly take, and the shape is decided from the fingerprints themselves.
    expect(panel).toContain("baselinesFromAnotherScenario(");
    expect(panel).toContain("DIFFERENT_SCENARIO_TITLE");
    expect(panel).toContain("DIFFERENT_SCENARIO_LINE");
    expect(panel).toContain('data-jev-scenario={otherScenario ? "different" : undefined}');
  });

  it("switches the details footer instead of repeating the clean claim", () => {
    expect(panel).toContain("? COMPARISON_FOOTER");
    expect(panel).toContain(": otherScenario");
    expect(panel).toContain(": ALTERED_COMPARISON_FOOTER}");
  });
});
