/**
 * Per-refresh Jev telemetry (owner report: "track where Jev falls back and why").
 *
 * The runtime's own accounting answers HOW MUCH of a run each source governed
 * (`liveMs` / `heldMs`) and how much time NO Jev policy governed at all
 * (`invalidMs`). What a summary of totals cannot say is WHICH
 * refresh went wrong: a run that fell back twice for two different reasons and a
 * run that fell back once for twice as long produce the same numbers, and the
 * one thing the owner asked for — "track where Jev falls back and why" — is
 * exactly that missing dimension.
 *
 * This module is that record. ONE event per refresh window:
 *
 *   atEpochMs      when the window opened, in wall-clock ms (for correlating a
 *                  run with logs; every decision stays in simulated time)
 *   atSimMs        when it opened in SIMULATED time — what a run reasons in
 *   generation     the request generation the window belongs to (null when no
 *                  request was issued)
 *   outcome        live      this refresh produced the policy in force
 *                  held      it produced nothing; an older policy still governed
 *                  ungoverned  it produced nothing AND no policy was in force
 *                            at all. There is deliberately no `fallback`
 *                            member: a Jev run has no second controller to fall
 *                            back to, so "the safety net drove this window" is
 *                            not a state this codebase can report. A window in
 *                            this state is time the run did not control, and
 *                            `invalidMs` says how much.
 *   reason         for anything not live, one member of a CLOSED vocabulary:
 *                  timeout / rate-limited / upstream-5xx / transport /
 *                  malformed-json / schema-invalid / confidence-rejected /
 *                  stale / gap / other
 *   degraded       on a LIVE window: "confidence-rejected" when the accepted
 *                  answer's opinions were dropped below the confidence floor,
 *                  so a policy that governed with no model opinion behind it
 *                  cannot pass as a fresh one
 *   field / bound  when a refusal named a policy field: which field, and the
 *                  bound it was checked against (e.g. pressureScale,
 *                  "pressureScale in [0.5, 1.5]")
 *   detail         this codebase's OWN short sentence
 *   liveMs/heldMs/invalidMs
 *                  the simulated time THIS window spent on each source, so the
 *                  per-refresh rows add up to the run's own totals. There is no
 *                  fallback bucket to report: `invalidMs` is the honest home for
 *                  time no Jev policy governed at all.
 *
 * ## What can never appear here
 *
 * Not a response body, not a header value, not a token, not a URL, not a line
 * of upstream prose. Every string is either a literal in this repository or a
 * bounded identifier extracted from our own validation messages: the field
 * extractor recognises the message shapes jev/schema.ts produces and returns
 * null for anything else, so an unrecognised message cannot smuggle text in.
 * The timestamps are numbers and the counts are numbers. That is what makes the
 * record safe to keep after a run, to print in a report, and to hand to someone
 * diagnosing a deployment.
 *
 * ## Bounded, and honest about being bounded
 *
 * The recent-events list holds at most `JEV_REFRESH_EVENT_BOUND` events; the
 * counters (`total`, `outcomes`, `reasons`, `fields`, `reasonMs`) cover EVERY
 * refresh, and `evicted` says how many events are no longer in the list, so a
 * summary can never be mistaken for the whole history.
 *
 * ## Outcomes are resolved once, and say when they are not
 *
 * A window resolves when its answer is used (live), when its answer is refused
 * (held or ungoverned, decided by whether a policy was in force at that moment),
 * or when the window was skipped and never asked (gap/other). A window whose
 * request was still in flight when the run ended stays UNRESOLVED: it is
 * reported as such (`settled: false`, counted in `unresolved`) rather than
 * guessed into one of the three outcomes.
 */
import { JEV_HINTS, JEV_LIMITS, JEV_SCHEMA_VERSION } from "./schema";
import type { JevCause, JevRejectionKind } from "./runtime";
import type { JevPolicySource } from "./trace";

/** What a refresh window produced. */
export const JEV_REFRESH_OUTCOMES = ["live", "held", "ungoverned"] as const;

export type JevRefreshOutcome = (typeof JEV_REFRESH_OUTCOMES)[number];

/**
 * The closed vocabulary a non-live refresh is classified into. Every member is
 * a fact about the transport (timeout, rate limit, 5xx, an unreachable host), an
 * answer's shape (unreadable JSON, a schema refusal, opinions dropped by the
 * confidence floor) or the lifecycle (stale, a gap in coverage, anything else).
 */
export const JEV_REFRESH_REASONS = [
  "timeout",
  "rate-limited",
  "upstream-5xx",
  "transport",
  "malformed-json",
  "schema-invalid",
  "confidence-rejected",
  "stale",
  "gap",
  "other",
] as const;

export type JevRefreshReason = (typeof JEV_REFRESH_REASONS)[number];

/** How many recent events a summary keeps. Older ones survive as counts only. */
export const JEV_REFRESH_EVENT_BOUND = 64;

/** The policy fields a schema refusal can name. Order matters: first match wins. */
const POLICY_FIELDS = [
  "schemaVersion",
  "pressureScale",
  "hint",
  "corridorWeights",
  "regionWeights",
  "corridorIntents",
  "regionIntents",
] as const;

/**
 * The bound each field is checked against, spelled from JEV_LIMITS/JEV_HINTS so
 * a bound in a report can never drift from the bound in the code.
 */
const FIELD_BOUNDS: Record<(typeof POLICY_FIELDS)[number], string> = {
  schemaVersion: `schemaVersion = ${JEV_SCHEMA_VERSION}`,
  pressureScale: `pressureScale in [${JEV_LIMITS.PRESSURE_SCALE_MIN}, ${JEV_LIMITS.PRESSURE_SCALE_MAX}]`,
  hint: `hint in [${JEV_HINTS.join(", ")}]`,
  corridorWeights: `weight in [${JEV_LIMITS.WEIGHT_MIN}, ${JEV_LIMITS.WEIGHT_MAX}]`,
  regionWeights: `weight in [${JEV_LIMITS.WEIGHT_MIN}, ${JEV_LIMITS.WEIGHT_MAX}]`,
  corridorIntents: `strength in [${JEV_LIMITS.INTENT_STRENGTH_MIN}, ${JEV_LIMITS.INTENT_STRENGTH_MAX}]`,
  regionIntents: `strength in [${JEV_LIMITS.INTENT_STRENGTH_MIN}, ${JEV_LIMITS.INTENT_STRENGTH_MAX}]`,
};

/**
 * Which policy field a schema refusal named, and the bound it was checked
 * against. Recognises the message shapes jev/schema.ts produces; anything else
 * yields nulls, so no unrecognised text can reach a report through this door.
 */
export function schemaRefusalField(detail: string): {
  readonly field: string | null;
  readonly bound: string | null;
} {
  for (const field of POLICY_FIELDS) {
    if (detail === field || detail.startsWith(`${field} `) || detail.startsWith(`${field}[`) || detail.includes(` ${field}`)) {
      return { field, bound: FIELD_BOUNDS[field] };
    }
  }
  if (detail.startsWith("unsupported schemaVersion")) {
    return { field: "schemaVersion", bound: FIELD_BOUNDS.schemaVersion };
  }
  return { field: null, bound: null };
}

/**
 * One bounded sentence for the transport half of the vocabulary. This — never
 * an error message — is what the record keeps, because a client is an outside
 * seam: today every message is this codebase's own text, and this function is
 * what makes that irrelevant.
 */
export function refreshDetailForCause(cause: JevCause): string {
  switch (cause) {
    case "timeout":
      return "the request's deadline passed before an answer arrived";
    case "rate-limited":
      return "the model gateway rate-limited the request";
    case "upstream-error":
      return "the model gateway returned an error";
    case "rejected":
      return "the service refused the request";
    case "unreachable":
      return "the request never arrived";
    case "not-configured":
      return "no model credential was available";
    case "malformed":
      return "an answer arrived and could not be read as a policy";
    case "unconfigured":
      return "no policy client was configured for this run";
    case "first-policy":
      return "no policy existed yet";
    case "service-budget":
      return "the run's share of the service window did not allow a request in time";
    case "expired":
      return "the policy in force passed its maximum age";
    case "held":
      return "the previous policy was still inside its hold window";
    case "superseded":
      return "the request was superseded before its answer arrived";
    default:
      return "the request failed for an unclassified reason";
  }
}

/** How a refusal is classified, in the closed per-refresh vocabulary. */
export function refreshReasonFor(input: {
  readonly kind: JevRejectionKind;
  readonly cause: JevCause;
}): JevRefreshReason {
  switch (input.kind) {
    // An answer that belonged to a request the run had already replaced (or a
    // scenario that moved) is stale: the refresh it answered for produced
    // nothing usable, and that is a fact about the lifecycle, not the model.
    case "stale-generation":
    case "stale-fingerprint":
    case "invalidated":
      return "stale";
    // The answer parsed as a document but failed the policy contract: this is
    // the schema's refusal, and `schemaRefusalField` names the field.
    case "malformed":
      return "schema-invalid";
    // Usable answer, refused only for arriving inside the hold window. Nothing
    // failed; the refresh simply produced nothing new.
    case "held":
      return "other";
    case "client-error":
      break;
  }
  switch (input.cause) {
    case "timeout":
      return "timeout";
    case "rate-limited":
      return "rate-limited";
    case "upstream-error":
      return "upstream-5xx";
    case "unreachable":
      return "transport";
    // The class the clients raise when an answer arrived but could not be read
    // as a policy document at all (a non-JSON body, an answer with no payload).
    case "malformed":
      return "malformed-json";
    default:
      return "other";
  }
}

/** One refresh window, as reported. Every field is bounded and self-written. */
export interface JevRefreshEvent {
  /** 1-based ordinal of the refresh window within the run. */
  readonly index: number;
  readonly atEpochMs: number;
  readonly atSimMs: number;
  readonly generation: number | null;
  /** False when no answer was ever used for this window. */
  readonly settled: boolean;
  /** True when the window issued no request at all (no client, or slot busy). */
  readonly skipped: boolean;
  readonly outcome: JevRefreshOutcome;
  readonly reason: JevRefreshReason | null;
  readonly cause: JevCause | null;
  readonly field: string | null;
  readonly bound: string | null;
  readonly detail: string;
  /** Answer latency in wall-clock ms, when one arrived. */
  readonly latencyMs: number | null;
  readonly liveMs: number;
  readonly heldMs: number;
  /** Simulated ms this window spent with NO Jev policy in force. */
  readonly invalidMs: number;
  readonly clamped: number;
  readonly dropped: number;
  /** A live window whose accepted answer carried no usable model opinion. */
  readonly degraded: JevRefreshReason | null;
}

/** The durable summary: counters over EVERY refresh, plus the recent events. */
export interface JevRefreshTelemetry {
  /** Refresh windows the run was due to make (issued + skipped). */
  readonly total: number;
  /** Windows that issued a request. */
  readonly issued: number;
  /** Windows that could not ask (no client wired, or the slot was busy). */
  readonly skipped: number;
  /** Windows whose answer was still in flight when the run ended. */
  readonly unresolved: number;
  /** Resolved windows by outcome. */
  readonly outcomes: Readonly<Record<JevRefreshOutcome, number>>;
  /** Why each non-live window was not live. Only reasons that happened appear. */
  readonly reasons: Readonly<Partial<Record<JevRefreshReason, number>>>;
  /** Live windows whose answer carried no usable opinion, by reason. */
  readonly degraded: Readonly<Partial<Record<JevRefreshReason, number>>>;
  /**
   * Simulated ms of UNGOVERNED time each reason covered, across every window
   * that had it. Sums exactly to `invalidMs`.
   */
  readonly reasonMs: Readonly<Partial<Record<JevRefreshReason, number>>>;
  /**
   * Simulated ms with NO Jev policy in force, across every window. Zero for a
   * run that started under Jev and kept it; a non-zero value is time the run did
   * not control and is never reported as fallback time.
   */
  readonly invalidMs: number;
  /** Refusals that named a policy field, by field. */
  readonly fields: Readonly<Record<string, number>>;
  /** The most recent `JEV_REFRESH_EVENT_BOUND` windows, oldest first. */
  readonly recent: readonly JevRefreshEvent[];
  /** Events no longer in `recent` (their counts survive in the counters). */
  readonly evicted: number;
  /**
   * Refusals that arrived for a generation this run no longer tracks (a reset,
   * or an event already evicted from the bounded list). They are counted by the
   * runtime's own cause counters; they are not this run's windows.
   */
  readonly orphans: number;
}

/**
 * The recorder the runtime writes into, and the only way events are created.
 * Kept deliberately dumb: it classifies nothing about the simulation, it only
 * records what the runtime tells it, so the policy lifecycle stays the single
 * place that decides what happens.
 */
export interface JevRefreshTelemetryRecorder {
  begin(input: { atEpochMs: number; atSimMs: number; generation: number }): void;
  skip(input: {
    atEpochMs: number;
    atSimMs: number;
    /** True when a policy governed this window (held) rather than the net. */
    governing: boolean;
    reason: JevRefreshReason;
    detail: string;
  }): void;
  accept(input: {
    generation: number;
    settledAtEpochMs: number;
    clamped: number;
    dropped: number;
  }): void;
  refuse(input: {
    generation: number | null;
    kind: JevRejectionKind;
    cause: JevCause;
    detail: string;
    settledAtEpochMs: number;
    /** True when a policy was in force, so this window is held, not ungoverned. */
    governing: boolean;
  }): void;
  /** Attribute one simulated interval to the window that owned it. */
  account(input: { deltaMs: number; source: JevPolicySource; held: boolean }): void;
  reset(): void;
  summary(): JevRefreshTelemetry;
}

export interface JevRefreshTelemetryOptions {
  /** Recent-event bound; defaults to JEV_REFRESH_EVENT_BOUND. */
  readonly bound?: number;
}

interface MutableEvent {
  index: number;
  atEpochMs: number;
  atSimMs: number;
  generation: number | null;
  settled: boolean;
  skipped: boolean;
  outcome: JevRefreshOutcome;
  reason: JevRefreshReason | null;
  /**
   * Why this window's simulated TIME did not go live, kept even after the window
   * itself resolves live: a refresh whose answer arrived late covered the wait
   * with no policy in force, and that time must stay attributable to its reason.
   * Never reported directly — it is what `reasonMs` is summed from.
   */
  timeReason: JevRefreshReason | null;
  cause: JevCause | null;
  field: string | null;
  bound: string | null;
  detail: string;
  latencyMs: number | null;
  liveMs: number;
  heldMs: number;
  invalidMs: number;
  clamped: number;
  dropped: number;
  degraded: JevRefreshReason | null;
}

/** A copy: a reader can never reach into the recorder's own mutable state. */
function snapshot(event: MutableEvent): JevRefreshEvent {
  return {
    index: event.index,
    atEpochMs: event.atEpochMs,
    atSimMs: event.atSimMs,
    generation: event.generation,
    settled: event.settled,
    skipped: event.skipped,
    outcome: event.outcome,
    reason: event.reason,
    cause: event.cause,
    field: event.field,
    bound: event.bound,
    detail: event.detail,
    latencyMs: event.latencyMs,
    liveMs: event.liveMs,
    heldMs: event.heldMs,
    invalidMs: event.invalidMs,
    clamped: event.clamped,
    dropped: event.dropped,
    degraded: event.degraded,
  };
}

/** Nothing failed yet; every string is this repository's own words. */
const OPEN_DETAIL = "no answer had been used for this refresh yet";

/** Longest detail a record keeps. Longer text is truncated, never echoed whole. */
export const JEV_REFRESH_DETAIL_LIMIT = 160;

/**
 * Print-safe and bounded. Every caller passes this codebase's own text (see
 * `refreshDetailForCause` and the schema-refusal path), and this is the belt to
 * that pair of braces: no control characters, no unbounded string, ever.
 */
export function boundedDetail(detail: string): string {
  const printable = detail.replace(/[^\x20-\x7E]/g, " ");
  return printable.length <= JEV_REFRESH_DETAIL_LIMIT
    ? printable
    : `${printable.slice(0, JEV_REFRESH_DETAIL_LIMIT - 3)}...`;
}

export function createJevRefreshTelemetryRecorder(
  options: JevRefreshTelemetryOptions = {},
): JevRefreshTelemetryRecorder {
  const bound = options.bound ?? JEV_REFRESH_EVENT_BOUND;
  let events: MutableEvent[] = [];
  /** The window that owns the interval currently being simulated. */
  let current: MutableEvent | null = null;
  let nextIndex = 1;
  let total = 0;
  let issued = 0;
  let skipped = 0;
  let evicted = 0;
  let orphans = 0;
  const outcomes = new Map<JevRefreshOutcome, number>();
  const reasons = new Map<JevRefreshReason, number>();
  const degraded = new Map<JevRefreshReason, number>();
  const reasonMs = new Map<JevRefreshReason, number>();
  const fields = new Map<string, number>();
  /** Simulated ms with no Jev policy in force, across every window. */
  let invalidMsTotal = 0;

  const keep = (event: MutableEvent): MutableEvent => {
    events.push(event);
    if (events.length > bound) {
      events.shift();
      evicted += 1;
    }
    current = event;
    return event;
  };

  const open = (input: {
    atEpochMs: number;
    atSimMs: number;
    generation: number | null;
    skipped: boolean;
    governing: boolean;
  }): MutableEvent =>
    keep({
      index: nextIndex++,
      atEpochMs: input.atEpochMs,
      atSimMs: input.atSimMs,
      generation: input.generation,
      settled: false,
      skipped: input.skipped,
      // Provisional until an answer resolves it: a window that has produced
      // nothing yet is covered by whatever is in force right now.
      outcome: input.governing ? "held" : "ungoverned",
      reason: input.skipped ? null : "gap",
      timeReason: input.skipped ? null : "gap",
      cause: null,
      field: null,
      bound: null,
      detail: input.skipped ? "" : OPEN_DETAIL,
      latencyMs: null,
      liveMs: 0,
      heldMs: 0,
      invalidMs: 0,
      clamped: 0,
      dropped: 0,
      degraded: null,
    });

  const settle = (
    event: MutableEvent,
    input: {
      outcome: JevRefreshOutcome;
      reason: JevRefreshReason | null;
      cause: JevCause | null;
      field: string | null;
      bound: string | null;
      detail: string;
      settledAtEpochMs: number;
    },
  ): void => {
    event.settled = true;
    event.outcome = input.outcome;
    event.reason = input.reason;
    // A window that resolves LIVE keeps the reason its waiting time had: that
    // time really was covered by no policy, and it stays attributable.
    if (input.outcome !== "live" || event.timeReason === null) {
      event.timeReason = input.reason;
    }
    event.cause = input.cause;
    event.field = input.field;
    event.bound = input.bound;
    event.detail = boundedDetail(input.detail);
    event.latencyMs = Math.max(0, input.settledAtEpochMs - event.atEpochMs);
  };

  const countReason = (reason: JevRefreshReason): void => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };

  const byGeneration = (generation: number | null): MutableEvent | null => {
    if (generation === null) {
      return null;
    }
    for (const event of events) {
      if (event.generation === generation && !event.skipped) {
        return event;
      }
    }
    return null;
  };

  return {
    begin(input) {
      total += 1;
      issued += 1;
      open({ ...input, skipped: false, governing: false });
    },

    skip(input) {
      total += 1;
      skipped += 1;
      const event = open({
        atEpochMs: input.atEpochMs,
        atSimMs: input.atSimMs,
        generation: null,
        skipped: true,
        governing: input.governing,
      });
      const outcome: JevRefreshOutcome = input.governing ? "held" : "ungoverned";
      settle(event, {
        outcome,
        reason: input.reason,
        cause: null,
        field: null,
        bound: null,
        detail: input.detail,
        settledAtEpochMs: input.atEpochMs,
      });
      // A window that could not ask still belongs in the counts: the run was
      // due to refresh, and whatever governed the window is the honest answer.
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      countReason(input.reason);
    },

    accept(input) {
      const event = byGeneration(input.generation);
      if (event === null) {
        orphans += 1;
        return;
      }
      settle(event, {
        outcome: "live",
        reason: null,
        cause: null,
        field: null,
        bound: null,
        detail: "the answer became the policy in force",
        settledAtEpochMs: input.settledAtEpochMs,
      });
      event.clamped = Math.max(0, input.clamped);
      event.dropped = Math.max(0, input.dropped);
      // An answer whose opinions were all dropped still parses and still
      // governs — but it governs with NO model opinion behind it, and a live
      // window that cannot say so would be hiding the one imperfection the
      // gateway path leaves no other trace for.
      if (event.dropped > 0) {
        event.degraded = "confidence-rejected";
        degraded.set("confidence-rejected", (degraded.get("confidence-rejected") ?? 0) + 1);
      }
      outcomes.set("live", (outcomes.get("live") ?? 0) + 1);
    },

    refuse(input) {
      const event = byGeneration(input.generation);
      if (event === null) {
        // A refusal for a generation this run no longer tracks (a reset, or an
        // event evicted from the bounded list). The runtime's own cause
        // counters still hold it; it is not this run's window.
        orphans += 1;
        return;
      }
      const reason = refreshReasonFor({ kind: input.kind, cause: input.cause });
      const named = input.kind === "malformed" ? schemaRefusalField(input.detail) : { field: null, bound: null };
      const outcome: JevRefreshOutcome = input.governing ? "held" : "ungoverned";
      settle(event, {
        outcome,
        reason,
        cause: input.cause,
        field: named.field,
        bound: named.bound,
        detail: input.detail,
        settledAtEpochMs: input.settledAtEpochMs,
      });
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      countReason(reason);
      if (named.field !== null) {
        fields.set(named.field, (fields.get(named.field) ?? 0) + 1);
      }
    },

    account(input) {
      if (current === null) {
        return;
      }
      const delta = input.deltaMs;
      if (input.source === "waiting" || input.source === "invalidated") {
        // No Jev policy governed this interval. It is NOT fallback time: a Jev
        // run has no second controller to attribute it to, and saying otherwise
        // would be the one thing this record exists to prevent.
        current.invalidMs += delta;
        invalidMsTotal += delta;
        // ...and it is classified by the reason the window that lived it had,
        // so no ungoverned millisecond is left unattributed.
        if (current.timeReason !== null) {
          reasonMs.set(current.timeReason, (reasonMs.get(current.timeReason) ?? 0) + delta);
        }
        return;
      }
      current.liveMs += delta;
      if (input.held) {
        current.heldMs += delta;
      }
    },

    reset() {
      events = [];
      current = null;
      nextIndex = 1;
      total = 0;
      issued = 0;
      skipped = 0;
      evicted = 0;
      orphans = 0;
      outcomes.clear();
      reasons.clear();
      degraded.clear();
      reasonMs.clear();
      fields.clear();
      invalidMsTotal = 0;
    },

    summary() {
      const unresolved = events.filter((event) => !event.settled).length;
      /**
       * Counts in the vocabulary's own order, so two summaries of two runs
       * serialize the same way and a report cannot imply importance by order of
       * arrival. Zero counts are omitted.
       */
      const reasonRecord = (
        map: Map<JevRefreshReason, number>,
      ): Partial<Record<JevRefreshReason, number>> => {
        const out: Partial<Record<JevRefreshReason, number>> = {};
        for (const reason of JEV_REFRESH_REASONS) {
          const value = map.get(reason);
          if (value !== undefined && value > 0) {
            out[reason] = value;
          }
        }
        return out;
      };
      return {
        total,
        issued,
        skipped,
        unresolved,
        outcomes: {
          live: outcomes.get("live") ?? 0,
          held: outcomes.get("held") ?? 0,
          ungoverned: outcomes.get("ungoverned") ?? 0,
        },
        reasons: reasonRecord(reasons),
        degraded: reasonRecord(degraded),
        reasonMs: reasonRecord(reasonMs),
        invalidMs: invalidMsTotal,
        fields: Object.fromEntries([...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        recent: events.map(snapshot),
        evicted,
        orphans,
      };
    },
  };
}
