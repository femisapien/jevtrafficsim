import { describe, expect, it } from "vitest";
import {
  CONTROLLER_CHOICES,
  LIVE_RUN_HORIZON_MS,
  nextSeed,
  parseWorkerCommand,
  PLAYBACK_SPEEDS,
  PLAYBACK_STEPS_PER_TICK,
  SIM_TICK_MS,
} from "@/worker/protocol";
import { CONTROLLER_OPTIONS } from "@/components/ui-model";

describe("worker protocol validation", () => {
  it("accepts a well-formed INIT and applies defaults", () => {
    const command = parseWorkerCommand({
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "adaptive",
      seed: 42,
    });
    // Driver is part of the scenario; it defaults to the tourist profile.
    expect(command).toEqual({
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "adaptive",
      driver: "tourist",
      seed: 42,
      durationMs: undefined,
    });
    const withDuration = parseWorkerCommand({
      type: "INIT",
      citySize: "large",
      trafficLevel: "rush-hour",
      tripId: "united-center-to-willis-tower",
      controller: "fixed",
      driver: "local",
      seed: 0xffffffff,
      durationMs: 120_000,
    });
    expect(withDuration.type === "INIT" && withDuration.durationMs).toBe(120_000);
    expect(withDuration.type === "INIT" && withDuration.driver).toBe("local");
  });

  it("rejects malformed INIT payloads", () => {
    const base = {
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "fixed",
      seed: 42,
    };
    expect(() => parseWorkerCommand(null)).toThrow(RangeError);
    expect(() => parseWorkerCommand([base])).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, citySize: "huge" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, trafficLevel: "apocalypse" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, tripId: "made-up-trip" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, controller: "swarm" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: Number.NaN })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: -1 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: 1.5 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: 2 ** 32 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: 0 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: -5 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: Number.NaN })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: 10 * 24 * 60 * 60 * 1000 })).toThrow(
      RangeError,
    );
  });

  it("accepts START / PAUSE and rejects unknown command types", () => {
    expect(parseWorkerCommand({ type: "START" })).toEqual({ type: "START" });
    expect(parseWorkerCommand({ type: "PAUSE" })).toEqual({ type: "PAUSE" });
    expect(() => parseWorkerCommand({ type: "STEP" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({})).toThrow(RangeError);
    expect(() => parseWorkerCommand("START")).toThrow(RangeError);
  });

  it("accepts the two run controls and validates the speed", () => {
    // "Skip to end" (final polish pass) carries no arguments: which run it
    // applies to is the one the worker is holding.
    expect(parseWorkerCommand({ type: "SKIP_TO_END" })).toEqual({ type: "SKIP_TO_END" });
    // The speed is one of exactly two states, and anything else is refused
    // rather than rounded into one.
    for (const speed of PLAYBACK_SPEEDS) {
      expect(parseWorkerCommand({ type: "SET_SPEED", speed })).toEqual({ type: "SET_SPEED", speed });
    }
    for (const speed of [0, 2, 4, -3, 1.5, "3", null, undefined]) {
      expect(() => parseWorkerCommand({ type: "SET_SPEED", speed })).toThrow(RangeError);
    }
    expect(() => parseWorkerCommand({ type: "SET_SPEED" })).toThrow(RangeError);
  });

  it("validates RESET modes", () => {
    expect(parseWorkerCommand({ type: "RESET", mode: "same-seed" })).toEqual({
      type: "RESET",
      mode: "same-seed",
    });
    expect(parseWorkerCommand({ type: "RESET", mode: "new-seed" })).toEqual({
      type: "RESET",
      mode: "new-seed",
    });
    expect(() => parseWorkerCommand({ type: "RESET", mode: "random" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ type: "RESET" })).toThrow(RangeError);
  });

  it("validates SET_CONTROLLER against the known controllers", () => {
    // All three controllers are part of the protocol. The product does not ask a
    // visitor which one to run (the visible run is Jev, the baselines are
    // computed beside it), so the picker exists only behind ?debug — but it must
    // be able to reach every controller the protocol accepts.
    for (const controller of CONTROLLER_CHOICES) {
      expect(parseWorkerCommand({ type: "SET_CONTROLLER", controller })).toEqual({
        type: "SET_CONTROLLER",
        controller,
      });
    }
    expect([...CONTROLLER_CHOICES]).toEqual(["fixed", "adaptive", "jev"]);
    expect(CONTROLLER_OPTIONS.map((option) => option.value)).toEqual([...CONTROLLER_CHOICES]);
    expect(() => parseWorkerCommand({ type: "SET_CONTROLLER", controller: "swarm" })).toThrow(
      RangeError,
    );
    expect(() => parseWorkerCommand({ type: "SET_CONTROLLER" })).toThrow(RangeError);
  });

  it("accepts all five incident kinds and rejects anything else", () => {
    const kinds = ["traffic-burst", "crash", "close-road", "bridge-closed", "event-release"];
    for (const kind of kinds) {
      expect(parseWorkerCommand({ type: "INCIDENT", kind })).toEqual({ type: "INCIDENT", kind });
    }
    expect(() => parseWorkerCommand({ type: "INCIDENT", kind: "alien-invasion" })).toThrow(
      RangeError,
    );
    expect(() => parseWorkerCommand({ type: "INCIDENT" })).toThrow(RangeError);
  });

  it("keeps the centralized cadence constants consistent", () => {
    expect(SIM_TICK_MS).toBe(100);
    // Playback compression must stay well under the tick, and the frame
    // cadence IS the tick: the renderer interpolates over SIM_TICK_MS.
    expect(PLAYBACK_STEPS_PER_TICK).toBeGreaterThan(1);
    expect(PLAYBACK_STEPS_PER_TICK * SIM_TICK_MS).toBeLessThanOrEqual(1_000);
    expect(LIVE_RUN_HORIZON_MS).toBe(600_000);
    // The speed control's two states (final polish pass): normal, and 3× the
    // engine steps per real tick. The FRAME cadence is untouched — still one
    // frame per real tick — so the renderer's interpolation window is still
    // SIM_TICK_MS and 3× is more simulated distance per frame, not a different
    // animation clock.
    expect([...PLAYBACK_SPEEDS]).toEqual([1, 3]);
    expect(PLAYBACK_STEPS_PER_TICK * PLAYBACK_SPEEDS[1] * SIM_TICK_MS).toBe(2_400);
  });

  it("advances seeds in uint32 space deterministically", () => {
    expect(nextSeed(42)).toBe(43);
    expect(nextSeed(0)).toBe(1);
    expect(nextSeed(0xffffffff)).toBe(0);
  });
});
