/**
 * Quota-aware refresh scheduling (the fix for routine upstream 429s).
 *
 * ## The failure this exists for, measured rather than assumed
 *
 * A live Jev run asks for a policy on a SIMULATED cadence (`REFRESH_MS`), which
 * at the shipped 8.0x playback is one request every 2.5 s of wall time — about
 * 24 requests/minute. The upstream AI Gateway / model provider does not grant
 * that. In the one controlled live probe (30 requests, 75.2 s of wall time,
 * `/tmp/jev-relay-probe-021825/`):
 *
 *   30 refreshes · 10 accepted · 20 rejected · 0 local refusals
 *   causes: upstream rate limit x19, upstream 5xx x1
 *   the run was INVALIDATED at 483.5 s: the last accepted policy outlived its
 *   maximum hold because 35 s of wall time (280 s simulated) went by with no
 *   successful refresh at all.
 *
 * Our own two layers never fired: the Vercel Firewall rule (60 requests/60 s
 * per IP) and the instance-local limiter (180/60 s per instance per IP) were
 * used at 40% and 13% of their allowances and rejected nothing. Raising either
 * would not have changed a single one of those 19 rejections, which is why this
 * module schedules around the UPSTREAM allowance instead of spending it faster.
 *
 * ## What the upstream actually tells us, from the raw responses
 *
 * Every rejected response carries the provider's own rate-limit metadata and
 * every ACCEPTED one carries none at all (checked header by header on
 * `/tmp/jev-gateway-probe-12permin.json` and `-24permin.json`):
 *
 *   429: retry-after: 40 · x-ratelimit-limit-requests: 5
 *        x-ratelimit-remaining-requests: 0 · x-ratelimit-reset-requests: 40s
 *        (six samples: retry-after == reset-requests in all six; values 27, 37,
 *         40, 60, 60, 60)
 *   200: no retry-after, no x-ratelimit-* — nothing to learn from
 *   503: no rate-limit metadata either
 *
 * Two consequences drive this module, and neither is an inference:
 *
 *   1. The window is PROVIDER-DEFINED, not a fixed client-observable boundary.
 *      The reset value counts down (40s → 37s across 2.6 s) and also jumps back
 *      to 60 s on a fresh rejection, so there is no boundary a client can align
 *      to; and the allowance itself moves with provider demand — 12 requests at
 *      5.3 s spacing passed with zero 429s in one minute, while 12.7/min took 10
 *      rejections a minute later. The advertised ceiling when the provider is
 *      under demand is `limit-requests: 5` per window of at most 60 s.
 *   2. Success teaches us NOTHING about the remaining budget, so the only
 *      signals a scheduler can use are (a) the window it observed on a
 *      rejection, and (b) how far apart its own successful policies actually
 *      landed. This module uses both and invents no third.
 *
 * ## The direct TypeSafe transport (the production live path)
 *
 * Every number above was measured against the Vercel AI Gateway. Production now
 * reaches TypeSafe's own API DIRECTLY (`JEV_BACKEND=typesafe`, POST
 * https://api.typesafe.ai/v1/systemone, model `jev-latest`, credential
 * TYPESAFE_API_KEY; see jev/typesafe.ts), and the direct API was probed ONCE
 * with the production request shape: a 200 carried NO rate-limit metadata (no
 * `retry-after`, no `x-ratelimit-*`), and no refusal was observed. There is
 * therefore nothing to re-derive a cadence from, and this module does not guess
 * upward: the conservative schedule below is PRESERVED UNCHANGED for the direct
 * path — 4 requests per trailing 60 s, 15 s spacing, which is strictly tighter
 * than the gateway's advertised 5-per-window — and a direct refusal's
 * `retry-after` (if the service ever names one) is honoured by the same rule.
 * Re-tuning is a product decision that waits for a measurement.
 *
 * ## The rule
 *
 * Never spend the whole advertised allowance, and never answer a refusal with a
 * burst:
 *
 *   - at most `MAX_PER_WINDOW` requests in any trailing `WINDOW_MS` (4 of the
 *     advertised 5, so one request of the window is left for the provider's
 *     other callers and for clock skew — the allowance is shared, which is why
 *     it moves);
 *   - at least `MIN_SPACING_MS` between requests (`WINDOW_MS / MAX_PER_WINDOW`),
 *     so the budget is spent as a steady cadence rather than as a burst that
 *     happens to fit inside the window;
 *   - an explicit `retry-after` is respected to the millisecond: nothing is
 *     asked before it expires;
 *   - a transient failure (5xx, timeout, unreachable) backs off — doubling from
 *     the cadence up to `MAX_BACKOFF_MS` — and a successful answer CLEARS that
 *     backoff, because the state it guards against is over;
 *   - a bounded roll-up of what actually happened (`status()`), so a run can
 *     report its own service cadence instead of asserting it.
 *
 * The arithmetic, at the shipped 8.0x playback:
 *
 *   window 60 s ÷ 4 requests      = 15 s of wall time per request
 *   15 s × 8.0 simulated ms/wall  = 120 s of simulated time per policy
 *   a 600 s run                   = 5-6 accepted policies, every 15 s of wall
 *                                   time (the old schedule asked 30 times and
 *                                   was answered 10 times)
 *
 * That is deliberately the highest rate the measured allowance supports rather
 * than the lowest that would silence the 429s: 4 per window is the most the
 * service can be asked without spending the whole advertised budget.
 *
 * ## What this module is not
 *
 * It decides WHEN a request may be made and nothing else. It has no opinion
 * about policy, it never touches simulated time, it cannot accept, refuse or
 * fabricate a policy, and a refusal here is a request that was never made — the
 * policy in force simply keeps governing, which is what the pure-Jev contract
 * says happens when a refresh produces nothing. Simulation mechanics are
 * untouched: only the WALL-CLOCK eligibility of a request is decided here.
 *
 * ## Its SCOPE, which is the whole point of jev/service-budget.ts
 *
 * One gate guards one upstream allowance, so there is exactly ONE gate per
 * application session (`sessionJevServiceGate`), not one per controller. The
 * allowance belongs to the credential the request is made with, and in this
 * deployment that credential lives on the server: a run that builds a fresh
 * gate — a reset, a new scenario, a rebuilt controller — would ask as if the
 * window were empty while the upstream still counts the previous run's
 * requests. See the module doc of jev/service-budget.ts for the measured scope
 * of the allowance, what is shared across runs, what is deliberately not, and
 * what a browser-local gate can and cannot protect.
 */
import { percentile } from "@/sim/metrics";
import type { JevClientFailure } from "./client";

/**
 * The measured upstream budget, and the share of it this run spends.
 *
 * Every number here comes from the live probe's raw headers (see the module
 * doc). `WINDOW_MS` is the LONGEST window the provider ever reported (60 s), so
 * a trailing-window guard of that length is conservative for a provider whose
 * actual window is shorter.
 */
export const JEV_SERVICE_BUDGET = {
  /** Longest window the provider reported: `x-ratelimit-reset-requests: 60s`. */
  WINDOW_MS: 60_000,
  /** Advertised ceiling under demand: `x-ratelimit-limit-requests: 5`. */
  WINDOW_LIMIT: 5,
  /**
   * The share of the advertised allowance a single run spends. The allowance is
   * shared with every other caller of the same model, and it moves with provider
   * demand, so one run must not spend all of it: 4 of 5 leaves a request of the
   * window for everyone else and for clock skew.
   */
  SAFETY_SHARE: 0.8,
  /** Hardest retry-after this module will honour from a service, in wall ms. */
  MAX_RETRY_AFTER_MS: 600_000,
  /** Slack added to a computed wait so a boundary is stepped past, not re-tried. */
  TIMER_SLACK_MS: 50,
} as const;

/** Requests one run may make in any trailing window. Derived, never typed twice. */
export const JEV_SERVICE_MAX_PER_WINDOW = Math.max(
  1,
  Math.floor(JEV_SERVICE_BUDGET.WINDOW_LIMIT * JEV_SERVICE_BUDGET.SAFETY_SHARE),
);

/** Shortest wall-clock gap between two requests: the window, spent evenly. */
export const JEV_SERVICE_MIN_SPACING_MS = Math.ceil(
  JEV_SERVICE_BUDGET.WINDOW_MS / JEV_SERVICE_MAX_PER_WINDOW,
);

/** Ceiling on the transient-failure backoff: two cadences, never an outage. */
export const JEV_SERVICE_MAX_BACKOFF_MS = JEV_SERVICE_MIN_SPACING_MS * 2;

/** Why a request may not be made right now. A closed set of scheduling facts. */
export const JEV_SERVICE_REFUSALS = ["budget", "spacing", "retry-after", "backoff"] as const;

export type JevServiceRefusal = (typeof JEV_SERVICE_REFUSALS)[number];

export interface JevServiceEligibility {
  readonly ok: boolean;
  /** Why not, or null when a request may be made. */
  readonly reason: JevServiceRefusal | null;
  /** Wall ms until the next instant a request would be eligible (0 when ok). */
  readonly waitMs: number;
}

/** What a run's own scheduling did, in counts and durations — no instants. */
export interface JevServiceStatus {
  /** Requests issued (a refusal from the service still counts as issued). */
  readonly issued: number;
  /** Answers that arrived and were usable, whatever the run then did with them. */
  readonly answered: number;
  /** Answers that failed, by transport class. */
  readonly failedByCause: Readonly<Partial<Record<JevClientFailure, number>>>;
  /** Times this scheduler refused to ask, by reason. */
  readonly refusals: Readonly<Partial<Record<JevServiceRefusal, number>>>;
  /** Requests in the trailing window right now, against what is allowed. */
  readonly issuedInWindow: number;
  readonly allowedInWindow: number;
  readonly minSpacingMs: number;
  /** Transient failures in a row; a successful answer resets this to 0. */
  readonly failuresInARow: number;
  /** Wall ms until the next eligible instant, from the most recent decision. */
  readonly nextEligibleInMs: number;
  /** Wall ms between consecutive successful answers: p50 and worst observed. */
  readonly successSpacingP50Ms: number | null;
  readonly successSpacingMaxMs: number | null;
  /** Bounded retry-after currently in force, or null. */
  readonly retryAfterMs: number | null;
}

export interface JevServiceGateOptions {
  readonly windowMs?: number;
  readonly maxPerWindow?: number;
  readonly minSpacingMs?: number;
  readonly maxBackoffMs?: number;
  /** Injected so a test can freeze time; production uses the wall clock. */
  readonly now?: () => number;
  /** Injected so a test never sleeps; production waits on a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The seam the runtime consults before it asks the service for a policy, and
 * reports every outcome back to. Small on purpose: four facts in, four facts
 * out. It cannot carry a policy and it cannot decide anything about the
 * simulation — it decides only whether a request may be made right now.
 */
export interface JevServiceGate {
  /** May a request be made at this instant? */
  eligibility(): JevServiceEligibility;
  /** This codebase's own one-sentence account of the current wait. */
  waitDetail(): string;
  /** A request was issued at this instant. Counted against the window. */
  issued(atEpochMs?: number): void;
  /** An answer arrived. Clears the transient-failure backoff. */
  succeeded(atEpochMs?: number): void;
  /** A request failed, with the bounded retry-after the service gave (or null). */
  failed(input: {
    readonly cause: JevClientFailure;
    readonly retryAfterMs: number | null;
    readonly atEpochMs?: number;
  }): void;
  /**
   * Wait until a request would be eligible, up to a TOTAL of `maxWaitMs`.
   *
   * The wait is re-decided as the state moves, because a refusal can hand over
   * to another one: the trailing window emptying can reveal that the cadence
   * has not yet passed, and a retry-after expiring can reveal a backoff behind
   * it. A single sleep would report "not eligible" while a request would in
   * fact have become possible inside the bound. Returns false when the bound
   * cannot be met — a caller that cannot wait must report the truth rather than
   * start a run late.
   */
  waitUntilEligible(options?: { readonly maxWaitMs?: number }): Promise<boolean>;
  status(): JevServiceStatus;
}

/**
 * A failure class that means the SERVICE was briefly unavailable, as opposed to
 * a refusal to serve this request at all. Only these back off: an answer that
 * arrived but could not be read (`malformed`) proves the service answered, and a
 * rate limit has its own explicit retry-after.
 */
const TRANSIENT_FAILURES: readonly JevClientFailure[] = [
  "upstream-error",
  "timeout",
  "unreachable",
  "rejected",
  "unknown",
];

/** How long a failure streak delays the next request: the cadence, doubled. */
export function serviceBackoffMs(
  failuresInARow: number,
  minSpacingMs: number,
  maxBackoffMs: number,
): number {
  if (failuresInARow <= 0) {
    return 0;
  }
  return Math.min(maxBackoffMs, minSpacingMs * 2 ** (failuresInARow - 1));
}

/** A bounded, finite, non-negative duration from anything a service reported. */
export function boundedRetryAfterMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(JEV_SERVICE_BUDGET.MAX_RETRY_AFTER_MS, Math.ceil(value));
}

/** How many successful spacings the status keeps for its percentile. */
const SPACING_SAMPLES = 64;

/**
 * ONE RUN's own view of a SHARED gate's counters.
 *
 * The gate is session-scoped (jev/service-budget.ts), so its counters describe
 * the whole session: how many requests every run in it issued, what came back,
 * and how often the schedule refused. A run's own account of itself must
 * describe ITS requests — `service.issued` in a result has to mean the requests
 * that run made — so the runtime subtracts the snapshot it took when it was
 * built (`baseline`) from the live status.
 *
 * The CAPACITY fields are passed through unchanged and deliberately: how much
 * of the trailing window is spent, how long until the next eligible instant,
 * what pause is in force and how far apart successes landed are facts about the
 * SERVICE right now, not about one run. A per-run delta of "requests in the
 * window" would be meaningless — the window is shared, which is the entire
 * point of sharing the gate.
 *
 * `baseline` null means "no gate": the status is returned as it stands.
 */
export function serviceStatusSince(
  current: JevServiceStatus,
  baseline: JevServiceStatus | null,
): JevServiceStatus {
  if (baseline === null) {
    return current;
  }
  const failedByCause: Record<string, number> = {};
  for (const [cause, count] of Object.entries(current.failedByCause)) {
    const before = baseline.failedByCause[cause as JevClientFailure] ?? 0;
    if (count > before) {
      failedByCause[cause] = count - before;
    }
  }
  const refusals: Record<string, number> = {};
  for (const [reason, count] of Object.entries(current.refusals)) {
    const before = baseline.refusals[reason as JevServiceRefusal] ?? 0;
    if (count > before) {
      refusals[reason] = count - before;
    }
  }
  return {
    ...current,
    issued: Math.max(0, current.issued - baseline.issued),
    answered: Math.max(0, current.answered - baseline.answered),
    failedByCause,
    refusals,
  };
}

export function createJevServiceGate(options: JevServiceGateOptions = {}): JevServiceGate {
  const windowMs = options.windowMs ?? JEV_SERVICE_BUDGET.WINDOW_MS;
  const maxPerWindow = options.maxPerWindow ?? JEV_SERVICE_MAX_PER_WINDOW;
  const minSpacingMs =
    options.minSpacingMs ?? Math.max(1, Math.ceil(windowMs / Math.max(1, maxPerWindow)));
  const maxBackoffMs = options.maxBackoffMs ?? minSpacingMs * 2;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const [name, value] of [
    ["windowMs", windowMs],
    ["maxPerWindow", maxPerWindow],
    ["minSpacingMs", minSpacingMs],
    ["maxBackoffMs", maxBackoffMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be finite and positive, received ${value}`);
    }
  }

  /** Wall instants of requests issued inside the trailing window, oldest first. */
  let issuedAt: number[] = [];
  let lastIssuedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  /** Wall instant before which the service itself said not to ask. */
  let retryAfterUntilMs: number | null = null;
  let retryAfterMs: number | null = null;
  let failuresInARow = 0;
  let issued = 0;
  let answered = 0;
  const failedByCause = new Map<JevClientFailure, number>();
  const refusals = new Map<JevServiceRefusal, number>();
  let spacings: number[] = [];
  let nextEligibleInMs = 0;

  /** Forget requests that have aged out of the trailing window. */
  const prune = (at: number): void => {
    if (issuedAt.length === 0) {
      return;
    }
    const cutoff = at - windowMs;
    let keepFrom = 0;
    while (keepFrom < issuedAt.length && issuedAt[keepFrom] <= cutoff) {
      keepFrom += 1;
    }
    if (keepFrom > 0) {
      issuedAt = issuedAt.slice(keepFrom);
    }
  };

  const decide = (at: number): JevServiceEligibility => {
    prune(at);
    // 1. The service's own instruction outranks everything else we know.
    if (retryAfterUntilMs !== null) {
      if (at < retryAfterUntilMs) {
        return { ok: false, reason: "retry-after", waitMs: retryAfterUntilMs - at };
      }
      retryAfterUntilMs = null;
      retryAfterMs = null;
    }
    // 2. The trailing window: the advertised allowance, less the safety share.
    if (issuedAt.length >= maxPerWindow) {
      return { ok: false, reason: "budget", waitMs: issuedAt[0] + windowMs - at };
    }
    if (lastIssuedAt !== null) {
      // 3. A steady cadence, so the window is spent evenly rather than in a
      //    burst that happens to fit inside it.
      if (at - lastIssuedAt < minSpacingMs) {
        return { ok: false, reason: "spacing", waitMs: lastIssuedAt + minSpacingMs - at };
      }
      // 4. A transient failure backs off; a success clears this entirely.
      const backoff = serviceBackoffMs(failuresInARow, minSpacingMs, maxBackoffMs);
      if (backoff > 0 && at - lastIssuedAt < backoff) {
        return { ok: false, reason: "backoff", waitMs: lastIssuedAt + backoff - at };
      }
    }
    return { ok: true, reason: null, waitMs: 0 };
  };

  const eligibility = (): JevServiceEligibility => {
    const decision = decide(now());
    nextEligibleInMs = decision.waitMs;
    if (!decision.ok && decision.reason !== null) {
      refusals.set(decision.reason, (refusals.get(decision.reason) ?? 0) + 1);
    }
    return decision;
  };

  return {
    eligibility,

    waitDetail(): string {
      const decision = decide(now());
      if (decision.ok) {
        return "the service budget allows a request at this instant";
      }
      switch (decision.reason) {
        case "budget":
          return `the service budget for this window is spent (${maxPerWindow} requests per ${Math.round(windowMs / 1000)} s)`;
        case "spacing":
          return `the service cadence holds requests ${Math.round(minSpacingMs / 1000)} s apart`;
        case "retry-after":
          return "the service asked for a pause and it has not passed";
        case "backoff":
          return "a previous request failed; the run is backing off before it asks again";
        default:
          return "no request may be made at this instant";
      }
    },

    issued(atEpochMs) {
      const at = atEpochMs ?? now();
      prune(at);
      issuedAt.push(at);
      lastIssuedAt = at;
      issued += 1;
    },

    succeeded(atEpochMs) {
      const at = atEpochMs ?? now();
      answered += 1;
      failuresInARow = 0;
      retryAfterUntilMs = null;
      retryAfterMs = null;
      if (lastSuccessAt !== null) {
        spacings.push(at - lastSuccessAt);
        if (spacings.length > SPACING_SAMPLES) {
          spacings = spacings.slice(spacings.length - SPACING_SAMPLES);
        }
      }
      lastSuccessAt = at;
    },

    failed(input) {
      const at = input.atEpochMs ?? now();
      failedByCause.set(input.cause, (failedByCause.get(input.cause) ?? 0) + 1);
      if (input.cause === "rate-limited") {
        // The service named a pause: honour it exactly, and count it as one.
        // A rate limit is not a transient failure — retrying sooner is what
        // produced the burst that got the run rate-limited in the first place.
        const wait = boundedRetryAfterMs(input.retryAfterMs);
        retryAfterMs = wait;
        if (wait !== null) {
          retryAfterUntilMs = at + wait;
        }
        return;
      }
      if (TRANSIENT_FAILURES.includes(input.cause)) {
        failuresInARow += 1;
      }
    },

    async waitUntilEligible(waitOptions = {}) {
      const maxWaitMs = waitOptions.maxWaitMs ?? windowMs;
      const deadline = now() + maxWaitMs;
      // Re-decide after every wait: one refusal can hand over to another (the
      // window emptying reveals a cadence, a retry-after expiring reveals a
      // backoff), and the bound is on the TOTAL wait, not on one step of it.
      // Each wait clears at least the constraint that produced it and there are
      // four of those, so the loop is bounded even if a clock never moves; the
      // decision after the last step is the honest answer either way.
      for (let step = 0; step < JEV_SERVICE_REFUSALS.length; step += 1) {
        const decision = decide(now());
        if (decision.ok) {
          return true;
        }
        if (decision.waitMs > deadline - now()) {
          return false;
        }
        await sleep(decision.waitMs + JEV_SERVICE_BUDGET.TIMER_SLACK_MS);
      }
      return decide(now()).ok;
    },

    status(): JevServiceStatus {
      const at = now();
      prune(at);
      const failures: Record<string, number> = {};
      for (const [cause, count] of failedByCause) {
        failures[cause] = count;
      }
      const seen: Record<string, number> = {};
      for (const [reason, count] of refusals) {
        seen[reason] = count;
      }
      return {
        issued,
        answered,
        failedByCause: failures,
        refusals: seen,
        issuedInWindow: issuedAt.length,
        allowedInWindow: maxPerWindow,
        minSpacingMs,
        failuresInARow,
        nextEligibleInMs: nextEligibleInMs,
        successSpacingP50Ms: spacings.length === 0 ? null : percentile(spacings, 0.5),
        successSpacingMaxMs: spacings.length === 0 ? null : Math.max(...spacings),
        retryAfterMs,
      };
    },
  };
}
