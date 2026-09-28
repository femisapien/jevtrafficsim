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
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
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

  /**
   * The store transition itself, not its wiring: what a READY and a return to
   * the menu are allowed to do to a run that has FINISHED. A finished run's
   * outcome and provenance are the comparison state the payoff is made of, and
   * a preview or a menu press must not rewrite them.
   */
  it("keeps a finished run's outcome for its own world, and clears it for another", () => {
    const config: RunConfig = {
      citySize: "large",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "jev",
      driver: "tourist",
      seed: 42,
      durationMs: 600_000,
    };
    const fingerprint = "aaaa1111";
    const finished = result();
    const provenance: PresentationPolicy = {
      source: "live",
      liveMs: 600_000,
      replayMs: 0,
      fallbackMs: 0,
      invalidMs: 0,
      accepted: 118,
      rejected: 2,
      refreshes: 120,
    };

    useUiStore.getState().applyReady(config, "Metro", fingerprint);
    useUiStore.getState().setScenarioFingerprint(fingerprint);
    useUiStore.getState().setRunComplete(true);
    useUiStore.getState().setCompletedFingerprint(fingerprint);
    useUiStore.getState().setLiveResult(finished);
    useUiStore.getState().setPolicy(provenance);
    useUiStore.getState().setBaselines({
      fixed: result({ controller: "fixed", fingerprint }),
      adaptive: result({ controller: "adaptive", fingerprint }),
      fingerprint,
      incidentEntries: 1,
    });

    // A READY for the world that just finished — the prewarm race, where a run
    // entered without onboarding is handed its READY after RUN_COMPLETE. It may
    // not erase the outcome, and it may not erase the run's provenance.
    useUiStore.getState().applyReady(config, "Metro", fingerprint);
    const same = useUiStore.getState();
    expect(same.runComplete).toBe(true);
    expect(same.liveResult).toBe(finished);
    expect(same.policy).toBe(provenance);
    expect(same.completedFingerprint).toBe(fingerprint);
    expect(same.baselines?.fingerprint).toBe(fingerprint);

    // Another world is another experiment: the finished run's outcome and its
    // provenance go with it.
    useUiStore.getState().setScenarioFingerprint("bbbb2222");
    useUiStore.getState().applyReady(
      { ...config, tripId: "river-north-to-navy-pier" },
      "Metro",
      "bbbb2222",
    );
    const other = useUiStore.getState();
    expect(other.runComplete).toBe(false);
    expect(other.liveResult).toBeNull();
    expect(other.policy).toBeNull();
    // ...and a later READY for the OLD world cannot resurrect what is gone: the
    // gate is the finished run itself, not a remembered identity.
    useUiStore.getState().applyReady(config, "Metro", fingerprint);
    const resurrected = useUiStore.getState();
    expect(resurrected.runComplete).toBe(false);
    expect(resurrected.liveResult).toBeNull();
    expect(resurrected.policy).toBeNull();
  });

  it("returning to the menu ends the entered run without rewriting the finished one", () => {
    const config: RunConfig = {
      citySize: "large",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "jev",
      driver: "tourist",
      seed: 42,
      durationMs: 600_000,
    };
    const fingerprint = "cccc3333";
    const finished = result();
    useUiStore.getState().applyReady(config, "Metro", fingerprint);
    useUiStore.getState().setScenarioFingerprint(fingerprint);
    useUiStore.getState().setRunComplete(true);
    useUiStore.getState().setCompletedFingerprint(fingerprint);
    useUiStore.getState().setLiveResult(finished);

    useUiStore.getState().setPhase("config");
    const menu = useUiStore.getState();
    // The menu ends the run the USER entered — that is the payoff boundary...
    expect(menu.entered).toBe(false);
    // ...and touches nothing else: the run really finished, and the comparison
    // state it produced is not the menu's to rewrite.
    expect(menu.runComplete).toBe(true);
    expect(menu.liveResult).toBe(finished);
    expect(menu.completedFingerprint).toBe(fingerprint);
    expect(menu.scenarioFingerprint).toBe(fingerprint);
    // A preview landing while the menu is up cannot claim the payoff either.
    expect(menu.phase).toBe("config");
  });

  /**
   * The Restart action: the same world, played again. It clears the finished
   * run deliberately (setRunComplete(false) + resetMetrics, see
   * components/TrafficSimulator.tsx) BEFORE the worker is reset — so the READY
   * that comes back for the SAME fingerprint must not resurrect the old result.
   */
  it("a restart of the same world starts clean: the finished run cannot come back", () => {
    const config: RunConfig = {
      citySize: "large",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "jev",
      driver: "tourist",
      seed: 42,
      durationMs: 600_000,
    };
    const fingerprint = "dddd4444";
    const finished = result();
    useUiStore.getState().applyReady(config, "Metro", fingerprint);
    useUiStore.getState().setScenarioFingerprint(fingerprint);
    useUiStore.getState().setRunComplete(true);
    useUiStore.getState().setCompletedFingerprint(fingerprint);
    useUiStore.getState().setLiveResult(finished);

    // The restart path, in order.
    useUiStore.getState().setRunComplete(false);
    useUiStore.getState().resetMetrics();
    useUiStore.getState().setRunning(true);
    // The worker answers with a READY for the same world — same seed, same
    // trip, so the SAME fingerprint as the run that just finished.
    useUiStore.getState().applyReady(config, "Metro", fingerprint);

    const restarted = useUiStore.getState();
    expect(restarted.running).toBe(true);
    expect(restarted.runComplete).toBe(false);
    expect(restarted.liveResult).toBeNull();
    expect(restarted.metrics).toBeNull();
    expect(restarted.trip).toBeNull();
    // The scenario identity is untouched: a restart is the same experiment.
    expect(restarted.scenarioFingerprint).toBe(fingerprint);
    expect(restarted.completedFingerprint).toBe(fingerprint);
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
