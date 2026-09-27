/**
 * Per-refresh telemetry (owner report: "track where Jev falls back and why").
 *
 * What is pinned here:
 *
 *   1. the classification: every refusal lands in the CLOSED vocabulary, and a
 *      schema refusal names the policy field and the bound it failed;
 *   2. an event per refresh window — live, held or ungoverned — with the simulated
 *      time each window spent on each source, summing to the run's own totals;
 *   3. the record can carry NO upstream text: a client error's message (which a
 *      client could in principle quote) never reaches it, and a detail is
 *      bounded and print-safe;
 *   4. the bounded list is bounded, and says how much it dropped;
 *   5. a healthy client's run has ZERO ungoverned windows and says so, and a
 *      failing one says exactly which window, why, and against which bound.
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController } from "@/controllers/jev";
import { JevClientError, createMockJevClient, type JevClient } from "@/jev/client";
import {
  boundedDetail,
  createJevRefreshTelemetryRecorder,
  refreshDetailForCause,
  refreshReasonFor,
  schemaRefusalField,
  JEV_REFRESH_DETAIL_LIMIT,
  JEV_REFRESH_EVENT_BOUND,
  JEV_REFRESH_OUTCOMES,
  JEV_REFRESH_REASONS,
  type JevRefreshReason,
} from "@/jev/telemetry";
import { createJevPolicyRuntime, type JevCause, type JevRejectionKind } from "@/jev/runtime";
import { jevProvenance, provenanceLine } from "@/jev/provenance";
import { policyLabel } from "@/components/ui-model";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import { JEV_LIMITS, JEV_SCHEMA_VERSION } from "@/jev/schema";
import { SIMULATION_TIMESTEP_MS } from "@/sim/config";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { makeCrossroads } from "./traffic-support";

/* -------------------------------------------------------------- helpers --- */

function crossroads(): { engine: EngineState; partition: CityPartition } {
  const built = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 120 },
      { angleDeg: 90, length: 120 },
      { angleDeg: 180, length: 120 },
      { angleDeg: 270, length: 120 },
    ],
  });
  return {
    engine: createEngine({ city: built.city, controller: createAdaptiveController(), spawns: [] }),
    partition: buildCityPartition(built.city),
  };
}

function observationOf(engine: EngineState, partition: CityPartition) {
  return {
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

function policy(scale = 1.2) {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: scale,
    hint: "neutral" as const,
    corridorWeights: [],
    regionWeights: [],
  };
}

/** Ticks with the event loop turning between them, so async answers can land. */
async function pacedTicks(
  runtime: { observe: (observation: ReturnType<typeof observationOf>) => unknown },
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.observe(observationOf(engine, partition));
    stepEngine(engine);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Ticks with NO event-loop turn, as the app's post-arrival tail behaves. */
function tailTicks(
  runtime: { observe: (observation: ReturnType<typeof observationOf>) => unknown },
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.observe(observationOf(engine, partition));
    stepEngine(engine);
  }
}

/* -------------------------------------------------- 1. the vocabulary ----- */

describe("the per-refresh vocabulary is closed and names what it can", () => {
  it("classifies every transport failure into the closed set", () => {
    const cases: [JevCause, JevRejectionKind, JevRefreshReason][] = [
      ["timeout", "client-error", "timeout"],
      ["rate-limited", "client-error", "rate-limited"],
      ["upstream-error", "client-error", "upstream-5xx"],
      ["unreachable", "client-error", "transport"],
      ["malformed", "client-error", "malformed-json"],
      ["malformed", "malformed", "schema-invalid"],
      ["superseded", "stale-generation", "stale"],
      ["superseded", "stale-fingerprint", "stale"],
      ["superseded", "invalidated", "stale"],
      ["held", "held", "other"],
      ["not-configured", "client-error", "other"],
      ["rejected", "client-error", "other"],
      ["unknown", "client-error", "other"],
    ];
    for (const [cause, kind, expected] of cases) {
      const reason = refreshReasonFor({ kind, cause });
      expect(reason, `${kind}/${cause}`).toBe(expected);
      expect(JEV_REFRESH_REASONS).toContain(reason);
    }
    // Nothing can leave the set, whatever a caller passes.
    for (const kind of ["stale-generation", "stale-fingerprint", "invalidated", "held", "malformed", "client-error"] as const) {
      for (const cause of ["timeout", "rate-limited", "upstream-error", "rejected", "unreachable", "not-configured", "malformed", "unknown"] as const) {
        expect(JEV_REFRESH_REASONS).toContain(refreshReasonFor({ kind, cause }));
      }
    }
  });

  it("names the policy field and the bound a schema refusal failed", () => {
    expect(schemaRefusalField("pressureScale must be a finite number")).toEqual({
      field: "pressureScale",
      bound: `pressureScale in [${JEV_LIMITS.PRESSURE_SCALE_MIN}, ${JEV_LIMITS.PRESSURE_SCALE_MAX}]`,
    });
    expect(schemaRefusalField("unsupported schemaVersion (expected 1)").field).toBe("schemaVersion");
    expect(schemaRefusalField("unknown hint (expected one of neutral, hold-longer, switch-sooner)").field).toBe("hint");
    expect(schemaRefusalField("corridorWeights weight for id 12 must be a finite number")).toEqual({
      field: "corridorWeights",
      bound: `weight in [${JEV_LIMITS.WEIGHT_MIN}, ${JEV_LIMITS.WEIGHT_MAX}]`,
    });
    expect(schemaRefusalField("regionIntents intent must be one of drain, meter").field).toBe("regionIntents");
    // Anything this codebase did not write yields nothing: the extractor cannot
    // be talked into carrying text through.
    expect(schemaRefusalField("upstream said: password=hunter2")).toEqual({ field: null, bound: null });
    expect(schemaRefusalField("policy must be an object")).toEqual({ field: null, bound: null });
  });

  it("bounds and print-sanitises any detail before it is kept", () => {
    expect(boundedDetail("short")).toBe("short");
    const long = boundedDetail("x".repeat(500));
    expect(long).toHaveLength(JEV_REFRESH_DETAIL_LIMIT);
    expect(long.endsWith("...")).toBe(true);
    expect(boundedDetail("tab\there\nnewline")).toBe("tab here newline");
  });

  it("has one bounded sentence per cause, and never echoes an error message", () => {
    const causes: JevCause[] = [
      "unconfigured", "first-policy", "expired", "held", "superseded",
      "timeout", "rate-limited", "upstream-error", "rejected", "unreachable",
      "not-configured", "malformed", "unknown",
    ];
    for (const cause of causes) {
      const sentence = refreshDetailForCause(cause);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain("responded");
      expect(sentence).not.toContain("Error");
    }
  });
});

/* -------------------------------------------------- 2. the recorder ------- */

describe("the recorder keeps one row per refresh window", () => {
  it("resolves a window live when its answer is used, and accounts its time", () => {
    const recorder = createJevRefreshTelemetryRecorder();
    recorder.begin({ atEpochMs: 1_000, atSimMs: 0, generation: 1 });
    recorder.accept({ generation: 1, settledAtEpochMs: 1_050, clamped: 1, dropped: 0 });
    recorder.account({ deltaMs: 20_000, source: "live", held: false });
    recorder.account({ deltaMs: 500, source: "invalidated", held: false });
    const summary = recorder.summary();
    expect(summary.total).toBe(1);
    expect(summary.issued).toBe(1);
    expect(summary.outcomes).toEqual({ live: 1, held: 0, ungoverned: 0 });
    expect(Object.keys(summary.reasons)).toHaveLength(0);
    const event = summary.recent[0];
    expect(event.settled).toBe(true);
    expect(event.outcome).toBe("live");
    expect(event.reason).toBeNull();
    expect(event.latencyMs).toBe(50);
    expect(event.clamped).toBe(1);
    expect(event.liveMs).toBe(20_000);
    expect(event.invalidMs).toBe(500);
  });

  it("classifies a held window, an ungoverned window and a skipped one apart", () => {
    const recorder = createJevRefreshTelemetryRecorder();
    // 1: refused while an older policy governs -> held, and the schema names
    //    the field.
    recorder.begin({ atEpochMs: 0, atSimMs: 0, generation: 1 });
    recorder.refuse({
      generation: 1,
      kind: "malformed",
      cause: "malformed",
      detail: "pressureScale must be a finite number",
      settledAtEpochMs: 5,
      governing: true,
    });
    // 2: refused while nothing governs -> ungoverned, transport class.
    recorder.begin({ atEpochMs: 10, atSimMs: 100, generation: 2 });
    recorder.refuse({
      generation: 2,
      kind: "client-error",
      cause: "timeout",
      detail: "the request's deadline passed before an answer arrived",
      settledAtEpochMs: 20,
      governing: false,
    });
    // 3: never asked at all: the slot was busy.
    recorder.skip({
      atEpochMs: 30,
      atSimMs: 200,
      governing: true,
      reason: "gap",
      detail: "the previous request was still in flight when this refresh was due",
    });
    const summary = recorder.summary();
    expect(summary.total).toBe(3);
    expect(summary.issued).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes).toEqual({ live: 0, held: 2, ungoverned: 1 });
    expect(summary.reasons).toEqual({ timeout: 1, "schema-invalid": 1, gap: 1 });
    expect(summary.fields).toEqual({ pressureScale: 1 });
    expect(summary.recent[0].bound).toContain("[0.5, 1.5]");
    expect(summary.recent[2].skipped).toBe(true);
  });

  it("marks a live window whose answer carried no usable opinion", () => {
    const recorder = createJevRefreshTelemetryRecorder();
    recorder.begin({ atEpochMs: 0, atSimMs: 0, generation: 1 });
    recorder.accept({ generation: 1, settledAtEpochMs: 1, clamped: 0, dropped: 4 });
    const summary = recorder.summary();
    expect(summary.outcomes.live).toBe(1);
    expect(summary.recent[0].degraded).toBe("confidence-rejected");
    expect(summary.degraded).toEqual({ "confidence-rejected": 1 });
  });

  it("keeps the recent list bounded and says how much it dropped", () => {
    const recorder = createJevRefreshTelemetryRecorder({ bound: 4 });
    for (let index = 0; index < 9; index += 1) {
      recorder.begin({ atEpochMs: index, atSimMs: index * 100, generation: index + 1 });
      recorder.accept({ generation: index + 1, settledAtEpochMs: index, clamped: 0, dropped: 0 });
    }
    const summary = recorder.summary();
    expect(summary.total).toBe(9);
    expect(summary.outcomes.live).toBe(9);
    expect(summary.recent).toHaveLength(4);
    expect(summary.evicted).toBe(5);
    expect(summary.recent[summary.recent.length - 1].index).toBe(9);
    // A refusal for a window this run no longer tracks cannot corrupt a count.
    recorder.refuse({
      generation: 2,
      kind: "client-error",
      cause: "timeout",
      detail: "late",
      settledAtEpochMs: 100,
      governing: true,
    });
    expect(recorder.summary().outcomes.held).toBe(0);
    expect(recorder.summary().orphans).toBe(1);
  });

  it("resets with the run it describes", () => {
    const recorder = createJevRefreshTelemetryRecorder();
    recorder.begin({ atEpochMs: 0, atSimMs: 0, generation: 1 });
    recorder.accept({ generation: 1, settledAtEpochMs: 0, clamped: 0, dropped: 0 });
    recorder.reset();
    const summary = recorder.summary();
    expect(summary.total).toBe(0);
    expect(summary.recent).toHaveLength(0);
    expect(summary.outcomes).toEqual({ live: 0, held: 0, ungoverned: 0 });
  });

  it("is a closed outcome set", () => {
    expect([...JEV_REFRESH_OUTCOMES]).toEqual(["live", "held", "ungoverned"]);
    expect(JEV_REFRESH_EVENT_BOUND).toBeGreaterThan(0);
  });
});

/* --------------------------------------- 3. the public surface stays plain -- */

describe("the diagnostic vocabulary never reaches a public surface", () => {
  it("words an invalidated run in plain English, not in reason tokens or field names", () => {
    const policy: PresentationPolicy = {
      source: "invalidated",
      liveMs: 300_000,
      replayMs: 0,
      fallbackMs: 0,
      invalidMs: 300_000,
      accepted: 3,
      rejected: 9,
      refreshes: 12,
      cause: "expired",
      invalidation: { atSimMs: 300_000, reason: "expired" },
      causes: { expired: 9 },
      dropped: 2,
      clamped: 1,
    };
    const label = policyLabel("jev", policy);
    expect(label).not.toBeNull();
    const text = `${label?.text ?? ""} ${label?.detail ?? ""}`;
    // No diagnostic token, and no policy field, may appear in what a visitor
    // reads: the record's vocabulary belongs to the record.
    for (const reason of JEV_REFRESH_REASONS) {
      expect(text, `reason "${reason}" leaked into the label`).not.toContain(reason);
    }
    for (const field of ["pressureScale", "corridorWeights", "regionWeights", "corridorIntents", "regionIntents"]) {
      expect(text, `field "${field}" leaked into the label`).not.toContain(field);
    }
    // The plain words it does use are the product's own.
    expect(text).toContain("the policy in force passed its maximum age");
    expect(text).toContain("of the run after Jev was lost");
    expect(text).toContain("not a completed Jev result");
  });

  it("names every Jev-governed run plainly, with no governance vocabulary", () => {
    // The public label names the controller. How it was governed — fresh, held,
    // ungoverned, or on a fallback — is the run's record's business, and the
    // record is where it is read exactly.
    const base: PresentationPolicy = {
      source: "live",
      liveMs: 600_000,
      replayMs: 0,
      fallbackMs: 0,
      accepted: 20,
      rejected: 0,
      refreshes: 20,
    };
    const governed: readonly PresentationPolicy[] = [
      base,
      { ...base, heldMs: 140_000, maxHoldMs: 300_000 },
      { ...base, liveMs: 480_000, fallbackMs: 120_000, accepted: 3 },
      { ...base, liveMs: 480_000, invalidMs: 120_000, cause: "superseded" },
    ];
    for (const policy of governed) {
      const label = policyLabel("jev", policy);
      expect(label?.text, "a Jev-governed run is named Jev").toBe("Jev");
      expect(`${label?.text ?? ""} ${label?.detail ?? ""}`).not.toMatch(
        /\b(?:live|held|stale|ungoverned|fallback)\b/i,
      );
    }
    // The states that are not Jev runs keep their own words — and none of the
    // governance vocabulary reaches them either.
    const others: readonly PresentationPolicy[] = [
      { ...base, source: "waiting", liveMs: 0, accepted: 0, cause: "first-policy" },
      {
        ...base,
        source: "invalidated",
        liveMs: 360_000,
        invalidMs: 240_000,
        invalidation: { atSimMs: 360_000, reason: "expired" },
      },
    ];
    for (const policy of others) {
      const label = policyLabel("jev", policy);
      expect(`${label?.text ?? ""} ${label?.detail ?? ""}`).not.toMatch(
        /\b(?:live|held|stale|ungoverned|fallback)\b/i,
      );
    }
  });
});

/* --------------------------------------------- 3. a run's own record ------ */

describe("a live run records where it went and why", () => {
  it("keeps every window live under a healthy client, with no ungoverned window", async () => {
    const { engine, partition } = crossroads();
    const runtime = createJevPolicyRuntime({
      client: createMockJevClient(),
      scenarioFingerprint: "healthy",
      refreshMs: 1_000,
      // Hysteresis is measured, not accidental (see the runtime): with the
      // shipped 5 s hold, a refresh due every second would be refused as `held`
      // on purpose. This run is about a healthy CADENCE, so the hold is opened.
      minHoldMs: 1,
    });
    // 320 ticks of 100 ms = 32 s of simulated time: a refresh due every second.
    await pacedTicks(runtime, engine, partition, 320);
    const status = runtime.status();
    const summary = status.refreshTelemetry;
    expect(summary.total).toBeGreaterThanOrEqual(30);
    expect(summary.outcomes.ungoverned).toBe(0);
    expect(summary.outcomes.live).toBe(summary.total - summary.skipped);
    expect(summary.reasons).toEqual({});
    // The rows add up to the run's own totals: nothing is attributed twice, and
    // nothing is lost between the per-window accounting and the run's.
    const sum = (field: "liveMs" | "heldMs" | "invalidMs") =>
      summary.recent.reduce((total, event) => total + event[field], 0);
    expect(sum("invalidMs")).toBe(status.invalidMs);
    expect(sum("liveMs")).toBe(status.liveMs);
    expect(summary.evicted).toBe(0);
  });

  it("names which window a failure cost, in the vocabulary, with its bound", async () => {
    const { engine, partition } = crossroads();
    const kinds: { client: JevClient; expected: JevRefreshReason }[] = [
      {
        client: { id: "mock", requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: "high" }) },
        expected: "schema-invalid",
      },
      {
        client: {
          id: "mock",
          requestPolicy: () => {
            throw new JevClientError("timeout", "jev relay request timed out");
          },
        },
        expected: "timeout",
      },
      {
        client: {
          id: "mock",
          requestPolicy: () => {
            throw new JevClientError("rate-limited", "jev gateway responded 429");
          },
        },
        expected: "rate-limited",
      },
      {
        client: {
          id: "mock",
          requestPolicy: () => {
            throw new Error("Authorization: Bearer jev-secret-token-leak");
          },
        },
        expected: "other",
      },
      {
        // A request that never settles: the window is skipped, and the run says
        // the slot was busy rather than inventing a reason.
        client: { id: "mock", requestPolicy: () => new Promise(() => undefined) },
        expected: "gap",
      },
    ];
    for (const { client, expected } of kinds) {
      const runtime = createJevPolicyRuntime({
        client,
        scenarioFingerprint: `classify-${expected}`,
        refreshMs: 200,
      });
      await pacedTicks(runtime, engine, partition, 12);
      const summary = runtime.status().refreshTelemetry;
      expect(summary.outcomes.ungoverned, expected).toBeGreaterThan(0);
      expect(Object.keys(summary.reasons), expected).toContain(expected);
      // No upstream text, no credential, ever — whatever a client threw.
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("jev-secret-token-leak");
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("responded 429");
      const rows = summary.recent.filter((event) => event.reason === expected && event.settled);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.detail.length).toBeLessThanOrEqual(JEV_REFRESH_DETAIL_LIMIT);
      }
      if (expected === "gap") {
        // The window that asked and never got an answer is NOT guessed into an
        // outcome: it is reported as unresolved, with its provisional row.
        expect(summary.unresolved).toBe(1);
        expect(summary.recent[0].settled).toBe(false);
        expect(summary.recent[0].detail).toBe("no answer had been used for this refresh yet");
      }
    }
  });

  it("names the field a refused answer failed on, and the bound", async () => {
    const { engine, partition } = crossroads();
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: "urgent" }),
      },
      scenarioFingerprint: "field",
      refreshMs: 200,
    });
    await pacedTicks(runtime, engine, partition, 6);
    const summary = runtime.status().refreshTelemetry;
    const row = summary.recent[0];
    expect(row.reason).toBe("schema-invalid");
    expect(row.field).toBe("pressureScale");
    expect(row.bound).toContain(`[${JEV_LIMITS.PRESSURE_SCALE_MIN}`);
    expect(summary.fields).toEqual({ pressureScale: summary.reasons["schema-invalid"] });
  });

  it("records an unconfigured run as windows that could not ask, not as silence", () => {
    const { engine, partition } = crossroads();
    const runtime = createJevPolicyRuntime({ client: null, scenarioFingerprint: "unconfigured", refreshMs: 100 });
    tailTicks(runtime, engine, partition, 30);
    const summary = runtime.status().refreshTelemetry;
    expect(summary.issued).toBe(0);
    expect(summary.skipped).toBeGreaterThan(0);
    // Nothing was in force and nothing else could be: the windows are
    // UNGOVERNED, which is the honest word for time this run did not control.
    expect(summary.outcomes.ungoverned).toBe(summary.total);
    expect(summary.reasons.other).toBe(summary.total);
    expect(summary.recent[0].detail).toContain("no policy client");
    expect(summary.recent[0].invalidMs).toBeGreaterThan(0);
  });

  it("names ungoverned time on the window that lived it, instead of silence", async () => {
    const { engine, partition } = crossroads();
    // The answer's arrival is controlled by the test, not by a timer: the gap
    // it measures is the startup gap, and a loaded machine must not be able to
    // turn this into a race.
    let answer: ((value: unknown) => void) | null = null;
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => new Promise((resolve) => (answer = resolve)),
      },
      scenarioFingerprint: "startup-gap",
      refreshMs: 10_000,
    });
    await pacedTicks(runtime, engine, partition, 4);
    // Nothing governs yet: the run is WAITING for its first policy, and the
    // window that asked for it must report that time as UNGOVERNED — never as
    // fallback time, which would name a controller that does not exist.
    const waiting = runtime.status().refreshTelemetry;
    expect(waiting.outcomes.ungoverned).toBe(0);
    expect(waiting.unresolved).toBe(1);
    expect(waiting.recent[0].invalidMs).toBeGreaterThan(0);
    (answer as unknown as (value: unknown) => void)(policy(1.1));
    await Promise.resolve();
    await pacedTicks(runtime, engine, partition, 4);
    tailTicks(runtime, engine, partition, 16);
    const status = runtime.status();
    const summary = status.refreshTelemetry;
    // The first window produced the policy that governs, so it is LIVE; the
    // ungoverned time inside it is the wait before the answer, reported there.
    const first = summary.recent[0];
    expect(first.settled).toBe(true);
    expect(first.outcome).toBe("live");
    expect(first.reason).toBeNull();
    expect(first.invalidMs).toBeGreaterThan(0);
    expect(summary.outcomes.ungoverned).toBe(0);
    expect(summary.reasonMs.gap).toBeGreaterThanOrEqual(first.invalidMs);
    // Ungoverned time is classified per reason and adds up to the run's own
    // total: no ungoverned millisecond is left unattributed.
    expect(
      Object.values(summary.reasonMs).reduce((total, ms) => total + ms, 0),
    ).toBe(status.invalidMs);
    expect(summary.invalidMs).toBe(status.invalidMs);
    // Every observed interval is accounted exactly once, and no Adaptive
    // controller ever governed a millisecond of it.
    expect(status.liveMs + status.replayMs + status.invalidMs + status.fallbackMs).toBe(
      engine.traffic.timeMs - SIMULATION_TIMESTEP_MS,
    );
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
  });

  it("survives a reset with the run it belongs to", () => {
    const controller = createJevController({
      client: createMockJevClient(),
      scenarioFingerprint: "reset-a",
      refreshMs: 100,
    });
    expect(controller.meta().telemetry.total).toBe(0);
    controller.reset({ scenarioFingerprint: "reset-b" });
    expect(controller.meta().telemetry.total).toBe(0);
    expect(controller.meta().telemetry.recent).toHaveLength(0);
    // Provenance carries the counters, never the per-event wall clock.
    const provenance = jevProvenance(controller.meta());
    expect(provenance.refreshOutcomes).toEqual({ live: 0, held: 0, ungoverned: 0 });
    expect(provenanceLine(provenance)).not.toContain("windows:");
  });
});
