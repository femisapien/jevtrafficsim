/**
 * The post-run flow (friction pass).
 *
 * Three things the owner asked for, pinned as rules rather than as prose:
 *
 *   - a refusal keeps its numbers, in every shape it can honestly take: an
 *     altered run, and a run whose baselines are another scenario's;
 *   - the payoff belongs to the run the user ENTERED: a preview finishing
 *     behind the menu must not throw a result over the setup screen;
 *   - the payoff offers two actions, and neither asks a second time once the
 *     trip has arrived.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIFFERENT_SCENARIO_FOOTER,
  DIFFERENT_SCENARIO_LINE,
  DIFFERENT_SCENARIO_TITLE,
  BASELINE_FAILED_DETAIL,
  baselinesFromAnotherScenario,
  reviewStateNeedsNoConfirm,
} from "@/components/ui-model";
import { ARRIVED_FINISHING_DETAIL, ARRIVED_FINISHING_TEXT } from "@/components/SimChrome";
import { comparisonVerdictAll, type ChallengeResult } from "@/worker/challenge-result";
import { useUiStore } from "@/store/ui-store";
import type { RunConfig } from "@/worker/protocol";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

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
      tripTimeMs: 397_000,
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

describe("baselines from another scenario are shown, marked", () => {
  it("is decided by the fingerprints the results carry, not by a reason string", () => {
    const fixed = result({ controller: "fixed" });
    const adaptive = result({ controller: "adaptive" });
    const live = result();
    expect(baselinesFromAnotherScenario(fixed, adaptive, live)).toBe(false);
    // Either baseline moving to another world is enough.
    expect(baselinesFromAnotherScenario({ ...fixed, fingerprint: "other000" }, adaptive, live)).toBe(true);
    expect(baselinesFromAnotherScenario(fixed, { ...adaptive, fingerprint: "other000" }, live)).toBe(true);
    expect(baselinesFromAnotherScenario(fixed, adaptive, { ...live, fingerprint: "other000" })).toBe(true);
  });

  it("is a refusal the guard still makes — showing is not comparing", () => {
    const fixed = result({ controller: "fixed" });
    const adaptive = result({ controller: "adaptive" });
    const live = result({ fingerprint: "other000" });
    expect(comparisonVerdictAll([fixed, adaptive, live])).toEqual({
      comparable: false,
      reason: "different scenarios",
    });
  });

  it("says what it is and what it is not, in one line", () => {
    expect(DIFFERENT_SCENARIO_TITLE).toBe("Different scenario");
    expect(DIFFERENT_SCENARIO_LINE).toContain("different scenario");
    expect(DIFFERENT_SCENARIO_LINE).toContain("not directly comparable");
    expect(DIFFERENT_SCENARIO_FOOTER).toContain("different scenarios");
    // Never the clean run's claim: the three runs were not one experiment.
    expect(DIFFERENT_SCENARIO_FOOTER).not.toContain("Same scenario");
  });
});

describe("the payoff belongs to the run the user entered", () => {
  it("marks the store entered when a READY is applied, and clears it on the way out", () => {
    const config: RunConfig = {
      citySize: "large",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "jev",
      driver: "tourist",
      seed: 42,
      durationMs: 600_000,
    };
    useUiStore.getState().applyReady(config, "Metro", "abcd1234");
    expect(useUiStore.getState().entered).toBe(true);
    useUiStore.getState().setPhase("city");
    expect(useUiStore.getState().entered).toBe(true);
    // Back to the menu: what plays on from here is a preview, not the user's run.
    useUiStore.getState().setPhase("config");
    expect(useUiStore.getState().entered).toBe(false);
  });

  it("gates the live chrome (and so the payoff) on it", () => {
    const chrome = source("components/SimChrome.tsx");
    expect(chrome).toContain("const live = phase === \"city\" || (runComplete && entered);");
    // The store owns the flag; the chrome only reads it.
    const store = source("store/ui-store.ts");
    expect(store).toContain("entered: true,");
    expect(store).toContain("{ cameraFramedFor: null, entered: false }");
  });

  it("spends no comparison on a run nobody entered", () => {
    // The payoff's baselines are asked for by the run the user entered; the
    // stale config of the last played run is what made a preview's result read
    // as "different scenarios".
    const simulator = source("components/TrafficSimulator.tsx");
    expect(simulator).toContain("store.entered &&");
    expect(simulator).toContain("if (!runComplete || !entered) {");
  });
});

describe("the payoff offers two actions, and neither asks twice", () => {
  it("knows the review state, and only the review state", () => {
    expect(reviewStateNeedsNoConfirm({ arrived: true, runComplete: false })).toBe(true);
    expect(reviewStateNeedsNoConfirm({ arrived: false, runComplete: true })).toBe(true);
    expect(reviewStateNeedsNoConfirm({ arrived: false, runComplete: false })).toBe(false);
  });

  it("skips the confirmation there, and keeps it while a run is in flight", () => {
    const simulator = source("components/TrafficSimulator.tsx");
    expect(simulator).toContain("const reviewed = reviewStateNeedsNoConfirm({");
    expect(simulator).toContain("const needsConfirm =\n      !reviewed &&");
    // The mid-run guard is untouched: it is the one that protects real work.
    expect(simulator).toContain("discardNeedsConfirm({");
  });

  it("names them with words people already know", () => {
    const chrome = source("components/SimChrome.tsx");
    expect(chrome).toMatch(/>\s*Menu\s*</);
    expect(chrome).toMatch(/>\s*Restart\s*</);
    expect(chrome).not.toContain("New draw");
    // Two actions, side by side, and no third.
    const actions = chrome.slice(chrome.indexOf("Two actions, and only two"));
    const row = actions.slice(0, actions.indexOf("</motion.div>"));
    expect(row.match(/<button/g)?.length).toBe(2);
  });
});

describe("the post-run copy stays short", () => {
  it("says the arrival wait in one state line and one fact", () => {
    expect(ARRIVED_FINISHING_TEXT).toContain("You arrived");
    expect(ARRIVED_FINISHING_DETAIL.split(" ").length).toBeLessThanOrEqual(6);
    expect(ARRIVED_FINISHING_DETAIL).not.toContain("still finishing");
  });

  it("keeps no reassurance in the failure state", () => {
    expect(BASELINE_FAILED_DETAIL).not.toContain("safe");
    expect(BASELINE_FAILED_DETAIL.split(" ").length).toBeLessThanOrEqual(8);
  });

  it("prints one heading and one status line, not two labels", () => {
    const chrome = source("components/SimChrome.tsx");
    expect(chrome).toContain("Run complete</h2>");
    // The competing micro-label is gone from the whole product.
    expect(chrome).not.toContain("Who got there first");
    expect(source("components/ComparisonPanel.tsx")).not.toContain("Who got there first");
  });
});
