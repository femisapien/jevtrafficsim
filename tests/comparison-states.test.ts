import { describe, expect, it } from "vitest";
import { policyLabel, raceDelta, raceEntries } from "@/components/ui-model";
import { comparisonVerdictAll, type ChallengeResult } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";

function result(controller: ChallengeResult["controller"], tripTimeMs: number, completed = true): ChallengeResult {
  return {
    fingerprint: "same-world", controller, driver: "tourist", manualIncidents: 0,
    modified: false, simulatedMs: 600_000,
    trip: { completed, tripTimeMs, stoppedMs: 0, distanceM: 5000, averageSpeedMps: 10, rerouteCount: 0 },
    city: { averageWaitMs: 0, p95WaitMs: 0, completedTrips: 0, throughputPerMinute: 0, gridlockRatio: 0, activeVehicles: 0 },
  };
}

function policy(
  accepted: number,
  liveMs: number,
  invalidMs: number,
  source: PresentationPolicy["source"] = "live",
): PresentationPolicy {
  return { source, accepted, rejected: 0, refreshes: accepted,
    liveMs, replayMs: 0, fallbackMs: 0, invalidMs, adaptiveTicks: 0 };
}

describe("final comparison states", () => {
  it.each([
    ["Jev fastest", 300_000, 360_000, 420_000, "faster"],
    ["Adaptive fastest", 420_000, 300_000, 360_000, "slower"],
    ["Fixed fastest", 420_000, 360_000, 300_000, "slower"],
    ["effectively tied", 360_300, 360_000, 420_000, "within a second"],
  ] as const)("reports %s without a manufactured winner", (_name, jevMs, adaptiveMs, fixedMs, phrase) => {
    const entries = raceEntries(result("fixed", fixedMs), result("adaptive", adaptiveMs), result("jev", jevMs), "Jev");
    expect(raceDelta(entries, "Jev")?.text).toContain(phrase);
    expect(entries.map((entry) => entry.tripTimeMs)).toEqual([jevMs, adaptiveMs, fixedMs]);
  });

  it("makes a stopped run and a waiting run explicit, and leaves Jev unqualified", () => {
    // A run still waiting for its first policy, and one that LOST Jev: neither
    // is a Jev result, and neither is presented as one.
    expect(policyLabel("jev", policy(0, 0, 0, "waiting"))?.text).toBe("Waiting for Jev");
    expect(
      policyLabel("jev", {
        ...policy(2, 450_000, 150_000, "invalidated"),
        invalidation: { atSimMs: 450_000, reason: "expired" },
      })?.text,
    ).toBe("Jev · run invalidated");
    // Time that no policy covered stays in the record; the label stays a name.
    expect(policyLabel("jev", policy(2, 450_000, 150_000))?.text).toBe("Jev");
    expect(policyLabel("jev", policy(2, 600_000, 0))?.text).toBe("Jev");
  });

  it("marks an incomplete controller instead of presenting its horizon as an arrival", () => {
    const entries = raceEntries(result("fixed", 400_000), result("adaptive", 600_000, false), result("jev", 350_000), "Jev");
    expect(entries[1].incomplete).toBe(true);
    expect(raceDelta(entries, "Jev")?.text).toContain("did not finish");
  });

  it("refuses a modified or non-matching run", () => {
    const fixed = result("fixed", 400_000);
    const adaptive = result("adaptive", 390_000);
    const live = result("jev", 380_000);
    expect(comparisonVerdictAll([fixed, adaptive, { ...live, modified: true }]).comparable).toBe(false);
    expect(comparisonVerdictAll([fixed, adaptive, { ...live, fingerprint: "other-world" }]).comparable).toBe(false);
  });
});
