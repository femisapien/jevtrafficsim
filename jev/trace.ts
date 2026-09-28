/**
 * The Jev policy trace (Issue #14).
 *
 * A trace is the record of every policy a scenario ACTUALLY ACCEPTED, in
 * simulation time, with enough provenance to prove where each one came from.
 * It is the whole basis of replay: a run can be reproduced offline, with zero
 * network calls, from this file alone.
 *
 * ## What is in a trace, and what is deliberately not
 *
 * Only accepted policies are events. A malformed response, a timed-out request,
 * a stale answer from a superseded generation and a policy refused by hysteresis
 * are all absent — a replay stream must not contain a policy the run never used,
 * or replaying it would invent behaviour that did not happen. Rejections are
 * counted in the runtime's status and reported to the caller; they are not
 * policy.
 *
 * No-policy time is not an event either. "No valid policy right now" is a
 * property of the gap between events, and it is reproduced exactly by replaying
 * the same times against the same TTL — recording it would be recording a
 * decision the run did not make. A run that LOST its policy for good is not a
 * traceable run at all: it is invalidated, and its account says so.
 *
 * ## Determinism
 *
 * Events are ordered by simulated time (ties by request generation), every
 * number is finite, and serialising a trace twice produces the same bytes. A
 * replay therefore consumes an identical stream and, given the same scenario,
 * produces an identical ChallengeResult.
 */
import { parseJevPolicy, type JevPolicy, type JevValidation } from "./schema";

export const JEV_TRACE_VERSION = 1;

/**
 * What is in force for a Jev run, in the only four states it has.
 *
 *   live          a policy accepted from the live client governs the run
 *   replay        a policy from a recorded trace governs it, offline
 *   waiting       the run has NOT started: its first policy has not been
 *                 accepted yet (the startup gate). No simulated time passes.
 *   invalidated   Jev was LOST: the policy in force outlived its maximum hold.
 *                 The run stops; it is never continued under another controller.
 *
 * There is deliberately no `fallback` member: a live Jev run has no Adaptive
 * path at any stage, so "the safety net is driving" is not a state this codebase
 * can report.
 */
export type JevPolicySource = "live" | "replay" | "waiting" | "invalidated";

/**
 * Which policy source a run actually used (Issue #38).
 *
 *   mock            deterministic stand-in: no network, no credential, no model
 *   gateway         TypeSafe AI's jev through the Vercel AI Gateway
 *   typesafe-direct TypeSafe AI's jev reached DIRECTLY (POST /v1/systemone with
 *                   TYPESAFE_API_KEY) — the production live path. The relay
 *                   names it (`x-jev-backend`) and a browser run records it.
 *   schema-service  a service speaking the Jev policy schema (JEV_ENDPOINT)
 *   replay          an offline recorded trace, zero network calls
 *   unconfigured    no client at all: the run was the Adaptive fallback throughout
 */
export type JevAdapter = "mock" | "gateway" | "typesafe-direct" | "schema-service" | "replay" | "unconfigured";

/** The stand-in for an adapter string that arrived from outside this codebase. */
export function adapterFromId(id: string | null | undefined): JevAdapter | null {
  switch (id) {
    case "mock":
      return "mock";
    case "gateway":
      return "gateway";
    // The relay's own name for the gateway lane; the adapter vocabulary's word
    // for it is "gateway".
    case "ai-gateway":
      return "gateway";
    case "typesafe-direct":
      return "typesafe-direct";
    case "live":
    case "http":
    case "schema-service":
      return "schema-service";
    case "replay":
      return "replay";
    default:
      return null;
  }
}

/** True when a real external model produced (or originally produced) policies. */
export function adapterInvolvesModel(adapter: JevAdapter): boolean {
  return adapter !== "mock" && adapter !== "replay" && adapter !== "unconfigured";
}

/** The short label every surface shows: "jev-mock", "jev-replay", ... */
export function provenanceLabel(adapter: JevAdapter): string {
  return `jev-${adapter}`;
}

/**
 * Sources a recorded event can have. A trace records POLICIES a run accepted,
 * so the only two answers are where that policy came from when it was recorded
 * (`live`) and what it is when it is replayed offline (`replay`). The states a
 * run can be in without a policy in force — `waiting` and `invalidated` — are
 * never events: recording one would be recording a decision the run did not make.
 */
export type JevTraceSource = "live" | "replay";

export interface JevTraceEvent {
  /** The scenario this policy belongs to; a mismatch invalidates it. */
  readonly scenarioFingerprint: string;
  /**
   * Simulated ms at which the policy was ACCEPTED. It takes effect from the
   * next tick — the same rule live and replayed runs use, so both apply it to
   * exactly the same ticks.
   */
  readonly simulationTimeMs: number;
  /** Simulated ms at which the request that produced it was made. */
  readonly requestedAtSimMs: number;
  /** Monotonic per-runtime request counter; a newer one supersedes older ones. */
  readonly requestGeneration: number;
  readonly policy: JevPolicy;
  readonly source: JevTraceSource;
}

/**
 * The RECORDED run's own account of itself (Issue #38). Optional: traces written
 * before #38 do not carry it, and refusing to load them would break the "a trace
 * is reproducible from this file alone" promise for no security gain — an absent
 * block reads as "unknown", never as "no fallback".
 */
export interface JevTraceRecordedRun {
  readonly adapter: JevAdapter;
  readonly accepted: number;
  readonly rejected: number;
  readonly refreshes: number;
  readonly expiries: number;
  readonly liveMs: number;
  readonly fallbackMs: number;
}

export interface JevTrace {
  readonly version: typeof JEV_TRACE_VERSION;
  /** Controller the trace was recorded for ("jev"). */
  readonly controllerId: string;
  /** Client that produced the policies ("gateway", "live", "mock", "replay"). */
  readonly client: string;
  /** The scenario every event must match. */
  readonly scenarioFingerprint: string;
  readonly events: readonly JevTraceEvent[];
  /** What the recorded run was; absent in pre-#38 traces. */
  readonly recorded?: JevTraceRecordedRun | null;
}

export function emptyTrace(
  scenarioFingerprint: string,
  client: string,
  controllerId = "jev",
): JevTrace {
  return { version: JEV_TRACE_VERSION, controllerId, client, scenarioFingerprint, events: [] };
}

/** Order events the way replay consumes them: simulated time, then generation. */
export function compareTraceEvents(a: JevTraceEvent, b: JevTraceEvent): number {
  return a.simulationTimeMs - b.simulationTimeMs || a.requestGeneration - b.requestGeneration;
}

/** A trace with its events in replay order. Pure. */
export function normalizeTrace(trace: JevTrace): JevTrace {
  const normalized: JevTrace = { ...trace, events: [...trace.events].sort(compareTraceEvents) };
  // A trace with no recorded-run block serializes WITHOUT the key, so an
  // artifact written before #38 round-trips byte for byte. `recorded: null` on a
  // parsed trace still means "unknown" in memory (see parseJevTrace).
  if (normalized.recorded === null || normalized.recorded === undefined) {
    const rest = { ...normalized };
    delete rest.recorded;
    return rest;
  }
  return normalized;
}

/** Deterministic serialisation: same trace, same bytes. */
export function serializeTrace(trace: JevTrace): string {
  return `${JSON.stringify(normalizeTrace(trace), null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A trace policy must satisfy the LIVE bounded-policy contract exactly.
 *
 * The contract is `parseJevPolicy` — the same function the live path runs on a
 * service response, with no id context because a recorded policy has no
 * originating request to check ids against. Anything it would CLAMP is refused
 * outright here: a recorded policy was already clamped when it was accepted, so
 * a trace carrying an out-of-range value could not have come from a real run.
 *
 * That is the invariant this whole loader exists to keep: replay may reproduce
 * an accepted live policy, but it may never introduce one that live code could
 * not have accepted.
 */
function parsePolicy(value: unknown): { ok: true; policy: JevPolicy } | { ok: false; error: string } {
  const parsed = parseJevPolicy(value);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.value.clamped.length > 0) {
    return {
      ok: false,
      error: `policy is outside the live bounds (${parsed.value.clamped.join("; ")})`,
    };
  }
  return { ok: true, policy: parsed.value.policy };
}

/**
 * Validate a trace that came from outside (a file, a fixture). Structural only:
 * a trace may reference any policy the schema accepts, including one this city
 * would not produce.
 */
export function parseJevTrace(value: unknown): JevValidation<JevTrace> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "trace must be an object" };
  }
  if (value.version !== JEV_TRACE_VERSION) {
    return { ok: false, error: `unsupported trace version (expected ${JEV_TRACE_VERSION})` };
  }
  if (typeof value.scenarioFingerprint !== "string" || value.scenarioFingerprint.length === 0) {
    return { ok: false, error: "trace needs a scenarioFingerprint" };
  }
  if (typeof value.controllerId !== "string" || typeof value.client !== "string") {
    return { ok: false, error: "trace needs controllerId and client" };
  }
  if (!Array.isArray(value.events)) {
    return { ok: false, error: "trace.events must be an array" };
  }
  const events: JevTraceEvent[] = [];
  for (const [index, raw] of value.events.entries()) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: `event ${index} must be an object` };
    }
    if (raw.scenarioFingerprint !== value.scenarioFingerprint) {
      return { ok: false, error: `event ${index} belongs to a different scenario` };
    }
    const simulationTimeMs = finite(raw.simulationTimeMs);
    const requestedAtSimMs = finite(raw.requestedAtSimMs);
    const requestGeneration = finite(raw.requestGeneration);
    if (simulationTimeMs === null || simulationTimeMs < 0) {
      return { ok: false, error: `event ${index} needs a non-negative simulationTimeMs` };
    }
    if (requestedAtSimMs === null || requestedAtSimMs < 0) {
      return { ok: false, error: `event ${index} needs a non-negative requestedAtSimMs` };
    }
    if (requestGeneration === null || !Number.isInteger(requestGeneration) || requestGeneration < 0) {
      return { ok: false, error: `event ${index} needs a non-negative integer requestGeneration` };
    }
    if (raw.source !== "live" && raw.source !== "replay") {
      return { ok: false, error: `event ${index} needs source "live" or "replay"` };
    }
    const policy = parsePolicy(raw.policy);
    if (!policy.ok) {
      return { ok: false, error: `event ${index} carries an unusable policy: ${policy.error}` };
    }
    events.push({
      scenarioFingerprint: value.scenarioFingerprint,
      simulationTimeMs,
      requestedAtSimMs,
      requestGeneration,
      policy: policy.policy,
      source: raw.source,
    });
  }
  const recorded = parseRecorded(value.recorded);
  if (typeof recorded === "string") {
    return { ok: false, error: recorded };
  }

  return {
    ok: true,
    value: {
      version: JEV_TRACE_VERSION,
      controllerId: value.controllerId,
      client: value.client,
      scenarioFingerprint: value.scenarioFingerprint,
      events,
      recorded,
    },
  };
}

/**
 * The optional recorded-run block. Returns the block, null when absent, or the
 * error message as a string. Absent means "unknown", never "no fallback": a
 * pre-#38 trace simply cannot say what its run's refusals were.
 */
function parseRecorded(value: unknown): JevTraceRecordedRun | null | string {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "trace.recorded must be an object when present";
  }
  const raw = value as Record<string, unknown>;
  const adapter = adapterFromId(typeof raw.adapter === "string" ? raw.adapter : null);
  if (adapter === null) {
    return "trace.recorded.adapter must be one of mock, gateway, typesafe-direct, schema-service, replay";
  }
  const numbers: Record<string, number> = {};
  for (const field of ["accepted", "rejected", "refreshes", "expiries", "liveMs", "fallbackMs"] as const) {
    const parsed = finite(raw[field]);
    if (parsed === null || parsed < 0) {
      return `trace.recorded.${field} must be a finite number >= 0`;
    }
    numbers[field] = parsed;
  }
  return {
    adapter,
    accepted: numbers.accepted,
    rejected: numbers.rejected,
    refreshes: numbers.refreshes,
    expiries: numbers.expiries,
    liveMs: numbers.liveMs,
    fallbackMs: numbers.fallbackMs,
  };
}

/**
 * The events a replay should apply for a scenario: sorted, and only those whose
 * fingerprint matches. A trace recorded for another scenario yields nothing —
 * the runtime then refuses to start rather than replaying the wrong run.
 */
export function replayableEvents(
  trace: JevTrace,
  scenarioFingerprint: string,
): JevTraceEvent[] {
  if (trace.scenarioFingerprint !== scenarioFingerprint) {
    return [];
  }
  return normalizeTrace(trace).events.filter(
    (event) => event.scenarioFingerprint === scenarioFingerprint,
  );
}
