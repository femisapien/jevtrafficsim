import { describe, expect, it } from "vitest";
import { checkOversizedAnswer, checkRelayAnswer, checkSmokeRequest } from "../scripts/jev-smoke-checks";
import { checkLiveJevParticipation } from "../scripts/jev-participation-check";
import { policyLabel } from "../components/ui-model";
import type { JevPolicyRequest } from "../jev/schema";
import type { PresentationPolicy } from "../worker/presentation-snapshot";

const request: JevPolicyRequest = {
  schemaVersion: 1,
  timeMs: 5_000,
  windowMs: 5_000,
  city: {
    intersections: 1,
    signalizedIntersections: 1,
    activeVehicles: 0,
    queuedVehicles: 0,
    maxWaitMs: 0,
    arrivalRatePerSecond: 0,
  },
  corridors: [],
  regions: [],
  hotspots: [],
};
const policy = {
  schemaVersion: 1,
  pressureScale: 1,
  hint: "neutral",
  corridorWeights: [],
  regionWeights: [],
  corridorIntents: [],
  regionIntents: [],
};

describe("deployed relay release gate", () => {
  it("accepts a schema-valid request and policy", () => {
    expect(() => checkSmokeRequest(request, JSON.stringify(request))).not.toThrow();
    expect(() => checkRelayAnswer(200, { policy, clamped: [] }, request)).not.toThrow();
    expect(() => checkOversizedAnswer(413)).not.toThrow();
  });
  it("fails on non-200, absent or malformed policy", () => {
    expect(() => checkRelayAnswer(502, null, request)).toThrow("HTTP 502");
    expect(() => checkRelayAnswer(200, {}, request)).toThrow("invalid");
    expect(() => checkRelayAnswer(200, { policy: { ...policy, hint: "unsafe" } }, request)).toThrow("invalid");
  });
  it("requires an exact 413 for the oversized request", () => {
    expect(() => checkOversizedAnswer(200)).toThrow("expected 413");
    expect(() => checkOversizedAnswer(429)).toThrow("expected 413");
  });
  it("rejects credential-shaped content anywhere in the public response", () => {
    expect(() => checkRelayAnswer(200, { policy, note: "Bearer abcdefghijklmnop" }, request))
      .toThrow("credential-shaped");
  });
});

describe("completed-run pure-Jev participation gate", () => {
  const live: PresentationPolicy = {
    source: "live", liveMs: 600_000, replayMs: 0, fallbackMs: 0, invalidMs: 0,
    adaptiveTicks: 0, heldMs: 140_000, accepted: 3, rejected: 1, refreshes: 4,
  };
  it("passes an internally consistent live run with the public label", () => {
    expect(() => checkLiveJevParticipation(live, "Jev", 600_000)).not.toThrow();
    expect(() => checkLiveJevParticipation(live, "Jev", 600_100)).not.toThrow();
  });
  it("fails any run an Adaptive controller decided in, or left ungoverned", () => {
    // The three ways a run could stop being a Jev run. The public label is not
    // the enforcement — the run's own accounting is, and each failure is named.
    const withFallback: PresentationPolicy = { ...live, fallbackMs: 10_000, liveMs: 590_000 };
    expect(policyLabel("jev", withFallback)?.text).toBe("Jev");
    expect(() => checkLiveJevParticipation(withFallback, "Jev", 600_000))
      .toThrow("fallback time");

    const withAdaptiveTicks: PresentationPolicy = { ...live, adaptiveTicks: 2 };
    expect(() => checkLiveJevParticipation(withAdaptiveTicks, "Jev", 600_000))
      .toThrow("Adaptive controller decided");

    const ungoverned: PresentationPolicy = { ...live, liveMs: 480_000, invalidMs: 120_000 };
    expect(policyLabel("jev", ungoverned)?.text).toBe("Jev");
    expect(() => checkLiveJevParticipation(ungoverned, "Jev", 600_000))
      .toThrow("ungoverned time");

    // A run that cannot STATE its ungoverned time cannot prove the contract.
    const silent: PresentationPolicy = { ...live, invalidMs: undefined };
    expect(() => checkLiveJevParticipation(silent, "Jev", 600_000))
      .toThrow("does not state its ungoverned time");

    // And an invalidated run is never a completed Jev result.
    const stopped: PresentationPolicy = {
      ...live,
      source: "invalidated",
      liveMs: 420_000,
      invalidMs: 180_000,
      invalidation: { atSimMs: 420_000, reason: "expired" },
    };
    expect(() => checkLiveJevParticipation(stopped, "Jev · run invalidated", 600_000))
      .toThrow("not a completed Jev result");

    // A run still waiting for its first policy is not a Jev run either.
    const waiting: PresentationPolicy = {
      source: "waiting", liveMs: 0, replayMs: 0, fallbackMs: 0, invalidMs: 600_000,
      adaptiveTicks: 0, accepted: 0, rejected: 3, refreshes: 3,
    };
    expect(policyLabel("jev", waiting)?.text).toBe("Waiting for Jev");
    expect(() => checkLiveJevParticipation(waiting, "Waiting for Jev", 600_000)).toThrow("no live");
    expect(() => checkLiveJevParticipation(waiting, "Jev", 600_000)).toThrow("public label");
  });
  it("rejects inconsistent policy and time accounting", () => {
    expect(() => checkLiveJevParticipation({ ...live, refreshes: 2 }, "Jev", 600_000))
      .toThrow("outcomes exceed");
    expect(() => checkLiveJevParticipation(live, "Jev", 599_000)).toThrow("governed time");
  });
});
