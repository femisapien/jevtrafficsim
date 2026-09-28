/**
 * Issue #46 — the compact top-right control tile.
 *
 * The live view has exactly two places that speak about a control: the roadside
 * marker and this tile. The rules under test:
 *
 *   - a tile exists only while a control is relevant to the ego's near-term
 *     route (the nearest control ahead), never for the citywide network;
 *   - its lamp is the AUTHORITATIVE state for the ego's own movement, and it is
 *     the same lamp the marker lights — one derivation, so they cannot disagree;
 *   - it disappears once the control is passed (the control retires, the tile
 *     is gone), and it is gone at arrival;
 *   - a stop sign shows Stop and carries no lamp; a signal with no authoritative
 *     state in the frame shows nothing rather than a guessed colour.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { City, Intersection, Road } from "@/sim/types";
import type { MapModel } from "@/cities/map-model";
import { buildPathIndex, type Point } from "@/cities/paths";
import { createEngine, runEngine } from "@/sim/engine";
import { createAdaptiveController } from "@/controllers/adaptive";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { deriveContextualControls, type ContextualControl } from "@/render/contextual-controls";
import { controlSpriteFor } from "@/render/control-layers";
import { deriveControlTile, lampForSprite, sameControlTile } from "@/render/control-tile";
import { CONTROL_SPRITE_IDS } from "@/render/control-sprites";
import { chicagoModel } from "./chicago-support";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function road(id: number, from: number, to: number, length: number): Road {
  return { id, from, to, length, lanes: 2, speedLimit: 10, capacity: 20, kind: "arterial", closed: false };
}

function intersection(
  id: number,
  x: number,
  y: number,
  incoming: number[],
  outgoing: number[],
  control: Intersection["control"],
): Intersection {
  return { id, x, y, incoming, outgoing, control, regionId: 0 };
}

/** Straight chain: road i runs node i -> i+1 along +x, each `lengths[i]` long. */
function chainModel(
  lengths: number[],
  controls: Record<number, "signal" | "stop"> = {},
): MapModel {
  const nodes = lengths.length + 1;
  const xs: number[] = [0];
  for (const length of lengths) {
    xs.push(xs[xs.length - 1] + length);
  }
  const roads: Road[] = lengths.map((length, index) => road(index, index, index + 1, length));
  const intersections: Intersection[] = Array.from({ length: nodes }, (_, id) =>
    intersection(
      id,
      xs[id],
      0,
      id === 0 ? [] : [id - 1],
      id === nodes - 1 ? [] : [id],
      controls[id] ?? "uncontrolled",
    ),
  );
  const city: City = {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    intersections,
    roads,
  };
  const directedPaths = lengths.map(
    (_, index) => [[xs[index], 0], [xs[index + 1], 0]] as Point[],
  );
  return {
    scaleIndex: 2,
    size: "medium",
    city,
    streets: [],
    directedPaths,
    projection: { originLng: 0, originLat: 0, metresPerDegree: 111_320 },
  } as unknown as MapModel;
}

function trip(routeRoadIds: number[], routeIndex: number, completed = false) {
  return {
    tripId: "test-trip",
    originIntersectionId: 0,
    destinationIntersectionId: routeRoadIds[routeRoadIds.length - 1] + 1,
    routeRoadIds,
    routeIndex,
    tripTimeMs: 0,
    waitTimeMs: 0,
    distanceRemainingM: 0,
    distanceTravelledM: 0,
    intersectionsCleared: routeIndex,
    completed,
    estimatedRemainingMs: 0,
  };
}

function derive(
  model: MapModel,
  routeRoadIds: number[],
  routeIndex: number,
  ego: { roadId: number | null; progress: number },
  routeControls: { intersectionId: number; phaseIndex: number; stage: "green" | "yellow" | "all-red" }[] = [],
  completed = false,
): ContextualControl[] {
  return deriveContextualControls({
    model,
    indexes: model.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
    laneOffsets: model.city.roads.map(() => 0),
    trip: trip(routeRoadIds, routeIndex, completed),
    ego,
    routeControls,
  });
}

/* ------------------------------------------------------------------ */
/* When the tile exists                                                */
/* ------------------------------------------------------------------ */

describe("control tile: relevance", () => {
  const model = chainModel([100, 100, 100], { 1: "signal", 2: "stop" });

  it("is absent when nothing is ahead of the ego", () => {
    expect(deriveControlTile([])).toBeNull();
    // No route at all: nothing to be relevant to.
    expect(
      deriveControlTile(
        deriveContextualControls({
          model,
          indexes: model.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
          laneOffsets: model.city.roads.map(() => 0),
          trip: null,
          ego: { roadId: 0, progress: 10 },
          routeControls: [],
        }),
      ),
    ).toBeNull();
  });

  it("shows the nearest upcoming control, not the quieter preview behind it", () => {
    // Two controls inside the reveal band: the near one is a signal, the next a
    // stop. The tile answers for the control the ego meets first.
    const controls = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 95 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(controls.map((control) => control.kind)).toEqual(["signal", "stop"]);
    expect(deriveControlTile(controls)).toEqual({ kind: "signal", lamp: "green" });
  });

  it("disappears once the control is passed", () => {
    const approaching = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 95 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(deriveControlTile(approaching)).not.toBeNull();

    // Just past the stop line: the control is retiring behind the car. The next
    // one (the stop at node 2) is still inside the preview band, so the tile
    // switches to it rather than lingering on the passed signal.
    const justPassed = derive(model, [0, 1, 2], 1, { roadId: 1, progress: 5 }, [
      { intersectionId: 2, phaseIndex: 0, stage: "green" },
    ]);
    expect(justPassed.some((control) => control.lifecycle === "retiring")).toBe(true);
    expect(deriveControlTile(justPassed)).toEqual({ kind: "stop", lamp: null });

    // A passed control with nothing else relevant: no tile at all, both while it
    // is still retiring and once it is gone.
    const single = chainModel([100, 100], { 1: "signal" });
    const retiring = derive(single, [0, 1], 1, { roadId: 1, progress: 40 }, []);
    expect(retiring.map((control) => control.lifecycle)).toEqual(["retiring"]);
    expect(deriveControlTile(retiring)).toBeNull();
    const gone = derive(single, [0, 1], 1, { roadId: 1, progress: 80 }, []);
    expect(gone).toEqual([]);
    expect(deriveControlTile(gone)).toBeNull();
  });

  it("is gone at arrival", () => {
    const controls = derive(model, [0, 1, 2], 2, { roadId: 2, progress: 100 }, [], true);
    expect(controls).toEqual([]);
    expect(deriveControlTile(controls)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Marker and tile agreement                                           */
/* ------------------------------------------------------------------ */

describe("control tile: authoritative state", () => {
  const model = chainModel([100, 100], { 1: "signal" });

  it("shows the lamp the ego's own movement gets, in every stage", () => {
    const cases = [
      { stage: "green" as const, phaseIndex: 0, lamp: "green" as const },
      { stage: "yellow" as const, phaseIndex: 0, lamp: "yellow" as const },
      { stage: "all-red" as const, phaseIndex: 0, lamp: "red" as const },
    ];
    for (const entry of cases) {
      const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 }, [
        { intersectionId: 1, phaseIndex: entry.phaseIndex, stage: entry.stage },
      ]);
      expect(deriveControlTile(controls)).toEqual({ kind: "signal", lamp: entry.lamp });
    }
  });

  it("agrees with the marker sprite for every reachable signal state", () => {
    // The tile lamp is derived from the marker's own sprite decision, so this
    // pins the agreement instead of trusting it.
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    for (const stage of ["green", "yellow", "all-red"] as const) {
      for (const permitted of [true, false]) {
        for (const clearing of [true, false]) {
          const control: ContextualControl = {
            ...controls[0],
            signal: { stage, phaseIndex: 0, egoApproachPermitted: permitted, egoApproachClearing: clearing },
          };
          const tile = deriveControlTile([control]);
          const sprite = controlSpriteFor(control);
          expect(tile?.lamp).not.toBeNull();
          expect(sprite).toBe(`control-signal-${tile?.lamp}`);
          expect(lampForSprite(sprite)).toBe(tile?.lamp);
        }
      }
    }
  });

  it("shows Stop for a stop-controlled node, with no lamp", () => {
    const stopModel = chainModel([100, 100], { 1: "stop" });
    const controls = derive(stopModel, [0, 1], 0, { roadId: 0, progress: 40 });
    expect(controlSpriteFor(controls[0])).toBe("control-stop");
    expect(deriveControlTile(controls)).toEqual({ kind: "stop", lamp: null });
  });

  it("never invents a state: no authoritative frame state, no tile", () => {
    // A signal-controlled node with no routeControls entry produces no control
    // at all, so there is nothing for the tile to report.
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 }, []);
    expect(controls).toEqual([]);
    expect(deriveControlTile(controls)).toBeNull();
    // The neutral citywide sprite is not a state either.
    expect(lampForSprite("control-signal-neutral")).toBeNull();
    expect(lampForSprite("control-stop")).toBeNull();
  });

  it("only ever renders lamps the sprite atlas actually defines", () => {
    for (const lamp of ["green", "yellow", "red"] as const) {
      expect(CONTROL_SPRITE_IDS).toContain(`control-signal-${lamp}`);
      expect(lampForSprite(`control-signal-${lamp}`)).toBe(lamp);
    }
  });

  it("compares tile states by what they render", () => {
    expect(sameControlTile(null, null)).toBe(true);
    expect(sameControlTile({ kind: "stop", lamp: null }, null)).toBe(false);
    expect(sameControlTile({ kind: "signal", lamp: "green" }, { kind: "signal", lamp: "green" })).toBe(true);
    expect(sameControlTile({ kind: "signal", lamp: "green" }, { kind: "signal", lamp: "red" })).toBe(false);
    expect(sameControlTile({ kind: "signal", lamp: null }, { kind: "stop", lamp: null })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Real route, real payload                                            */
/* ------------------------------------------------------------------ */

describe("control tile on the curated challenge", () => {
  const model = chicagoModel(4);

  it("tracks the marker through a live trip and clears when nothing is ahead", () => {
    const { spawn } = materializeChallengeTrip(model, "soldier-field-to-navy-pier", 11);
    const engine = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns: [spawn],
    });
    const indexes = model.directedPaths.map((points) => (points ? buildPathIndex(points) : null));
    const laneOffsets = model.city.roads.map(() => 0);

    let samples = 0;
    let withTile = 0;
    let cleared = 0;
    let completed = false;
    for (let second = 1; second <= 60; second += 1) {
      runEngine(engine, second * 1_000);
      const snapshot = buildPresentationSnapshot(engine, second, "soldier-field-to-navy-pier");
      if (snapshot.trip?.completed) {
        completed = true;
        break;
      }
      const controls = deriveContextualControls({
        model,
        indexes,
        laneOffsets,
        trip: snapshot.trip,
        ego: snapshot.ego ? { roadId: snapshot.ego.roadId, progress: snapshot.ego.progress } : null,
        routeControls: snapshot.routeControls,
      });
      const tile = deriveControlTile(controls);
      samples += 1;
      if (tile === null) {
        cleared += 1;
      } else {
        withTile += 1;
        // Agreement, from a real frame: the tile's lamp is the marker's sprite.
        const upcoming = controls.find((control) => control.lifecycle === "upcoming");
        expect(upcoming).toBeDefined();
        expect(controlSpriteFor(upcoming!)).toBe(
          tile.kind === "stop" ? "control-stop" : `control-signal-${tile.lamp}`,
        );
        // And a tile never exists for a control the ego is only previewing as a
        // passed one: the tile's control is always the upcoming one.
        expect(upcoming!.kind).toBe(tile.kind);
      }
      // At most the nearest plus one quieter control, plus the one retiring
      // behind the car: no corridor, no forest.
      expect(controls.filter((control) => control.lifecycle === "upcoming").length).toBeLessThanOrEqual(2);
      expect(controls.filter((control) => control.lifecycle === "retiring").length).toBeLessThanOrEqual(1);
    }

    expect(completed).toBe(false);
    expect(samples).toBeGreaterThan(0);
    // The tile appears on a real trip (it is not dead chrome) and also clears.
    expect(withTile).toBeGreaterThan(0);
    expect(withTile + cleared).toBe(samples);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* The tile is the only control chrome                                 */
/* ------------------------------------------------------------------ */

describe("control tile surface", () => {
  const tile = readFileSync(new URL("../components/ControlTile.tsx", import.meta.url), "utf8");

  it("is rendered by the map as the live view's one control surface", () => {
    const map = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");
    expect(map).toContain("deriveControlTile(controls)");
    expect(map).toContain("<ControlTile state={controlTile} />");
    // Top-right, reading the marker's own colours.
    expect(tile).toContain("right-2");
    expect(tile).toContain("CONTROL_MARKER_COLORS");
    expect(tile).toContain("aria-label=\"Control ahead\"");
  });

  it("shows the whole object, not a dot beside a word", () => {
    // A complete three-lamp head: every lamp position is drawn, in the signal's
    // own order (red on top), and exactly one of them is lit at full strength.
    const lamps = [...tile.matchAll(/lamp: "(red|yellow|green)"/g)].map((match) => match[1]);
    expect(lamps).toEqual(["red", "yellow", "green"]);
    expect(tile).toContain("fillOpacity={on ? 1 : UNLIT_ALPHA}");
    expect(tile).toContain("const UNLIT_ALPHA = 0.22");
    // A complete stop sign: the octagon carries its own word.
    expect(tile).toMatch(/STOP\s*<\/text>/);
    expect(tile).toContain("CONTROL_MARKER_COLORS.stop");
    // The 10px dot-and-word pill this replaced is gone.
    expect(tile).not.toContain("h-2.5 w-2.5");
  });

  it("draws the objects large on the wide layout, and compact on a phone", () => {
    // "Large" is the point of this surface (the owner's ask): the object must not
    // shrink back to a glyph on the layout it was designed for. The wide layout
    // keeps the roadside sizes. The phone gets a deliberately compact chip of the
    // SAME whole object (owner's phone pass: the tile must not take over a 390px
    // screen) — smaller, never a dot, and the state still read from the object.
    const signalBox = tile.match(/const SIGNAL_BOX = "([^"]+)"/)?.[1] ?? "";
    const signBox = tile.match(/const SIGN_BOX = "([^"]+)"/)?.[1] ?? "";
    const width = (source: string, prefix: string) =>
      Number(source.match(new RegExp(`${prefix}\\[(\\d+)px\\]`))?.[1]);
    const wideSignal = width(signalBox, "sm:w-");
    const wideSign = width(signBox, "sm:w-");
    expect(wideSignal).toBeGreaterThanOrEqual(64);
    expect(wideSign).toBeGreaterThanOrEqual(96);
    const phoneSignal = width(signalBox, "w-");
    const phoneSign = width(signBox, "w-");
    // A three-lamp head and a sign you can still read as themselves.
    expect(phoneSignal).toBeGreaterThanOrEqual(16);
    expect(phoneSign).toBeGreaterThanOrEqual(28);
    expect(phoneSignal).toBeLessThan(wideSignal);
    expect(phoneSign).toBeLessThan(wideSign);
    // The authoritative inks come from CONTROL_MARKER_COLORS or not at all: a
    // literal lamp colour here could silently drift from the map marker.
    expect(tile).not.toMatch(/#ff4a3d|#ffc93c|#4ee06a|#b3312a/i);
  });

  it("is drawn flat: one housing fill, plain lamps, no gradients or filters", () => {
    // The owner's pass on the shipped tile: cleaner/flatter, less housing detail.
    // The roadside sprite keeps the bevel, the lamp wells and the lit-lens core;
    // this tile must not drift back toward them.
    expect(tile).not.toMatch(/Gradient|<defs|filter=/);
    // One housing shape, one fill: the old edge/bevel/sheen rects are gone.
    expect(tile.match(/fill=\{HOUSING\}/g)).toHaveLength(1);
    // Three lamps and at most one bead of detail (the thin ring on the lit lens):
    // no per-lamp wells, no halos, no specular cores.
    expect((tile.match(/<circle/g) ?? []).length).toBeLessThanOrEqual(4);
    // Exactly one white stroke in the file, and it is that lens ring.
    expect(tile.match(/stroke="#ffffff"/g)).toHaveLength(1);
    // The sign: a flat red octagon with no stroke and no shadow work, plus a
    // band drawn with plain mitred corners.
    expect(tile).toContain("<polygon points={SIGN_FACE} fill={CONTROL_MARKER_COLORS.stop} />");
    expect(tile).toContain('strokeLinejoin="miter"');
  });

  it("keeps the state in text for assistive tech, with nothing that ticks", () => {
    expect(tile).toContain("sr-only");
    expect(tile).toContain("aria-hidden=\"true\"");
    // No clock and no timer: the tile reports the control ahead, it never counts
    // down to it.
    expect(tile).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    expect(tile).not.toMatch(/remainingMs|countdownMs|etaMs/);
  });
});
