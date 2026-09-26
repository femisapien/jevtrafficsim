/**
 * Pure-Jev completion harness (owner report; re-cut for the #61 contract).
 *
 *   "why does this keep happening and why is jev still being used for fallback…
 *    please track where Jev falls back and why. Also we should make sure when
 *    testing the fallback shit, we allow the run to complete without doing
 *    fallbacks."
 *
 * This is the repeatable answer. It drives EVERY curated Chicago trip to the
 * full horizon through the same world seam the app and the benchmark use
 * (`worker/challenge-compare.ts`), with the same controller the app runs, and
 * reports what the run's OWN record says (jev/telemetry.ts):
 *
 *   per route   refreshes, windows by outcome (live / held), liveMs / heldMs /
 *               invalidMs, adaptive ticks, the public provenance label
 *   per reason  how many windows each classified reason cost, and the simulated
 *               time it covered
 *   per failure WHICH refresh it was (`index` at `atSimMs`), what happened
 *               (`reason`), which policy `field`/`bound` was involved, and the
 *               run's own one-sentence `detail`
 *
 * ## The gate, stated exactly
 *
 * The execution contract is now absolute: a Jev run is Jev-derived policy
 * controlling 100% of its simulated signal-decision time, or it is not a Jev
 * result at all. A route passes when:
 *
 *   - `fallbackMs` is 0 AND no refresh window is `ungoverned`
 *     (there is no Adaptive path left to reach, and no window went uncovered)
 *   - `adaptiveTicks` is 0 (an Adaptive decision never happened)
 *   - `invalidMs` is 0 and the run was NOT invalidated: every simulated instant
 *     had a Jev policy in force
 *   - at least one live window was accepted, and the governed time adds up to
 *     the simulated window exactly
 *
 * A HELD policy is not a failure: holding a real, previously accepted policy IS
 * Jev control, and the tail after the ego arrives is reported as held time. A
 * run that LOST Jev (nothing replaced the policy before its maximum hold) is
 * invalidated, reported with the instant and the reason, and FAILS this gate —
 * it must never be read as a completed Jev result.
 *
 * Anything that fails is reported WHERE and WHY, from the run's own record. The
 * harness never retries a window, never tunes a bound and never edits a result.
 *
 * ## Clients, and the live quota
 *
 *   --client mock      deterministic stand-in. NO network, NO model, NO
 *                      credential. The default: iterate here.
 *   --client gateway   TypeSafe AI's jev through the Vercel AI Gateway, the
 *                      same client the relay route builds (JEV_TOKEN, and
 *                      JEV_MODEL to override the model).
 *   --client relay     the DEPLOYED relay route (`/api/jev/policy`), posted to
 *                      exactly as the browser posts to it: no credential here,
 *                      the deployment holds it.
 *
 * Live runs spend real quota, so they are capped: `--live-run-budget` (default
 * 3) routes per invocation, refused with a message rather than silently run.
 * Everything else about the harness is identical between clients, so a mock
 * iteration and a live confirmation are the same measurement of the same run.
 *
 * LIVE ROUTES IN ONE INVOCATION SHARE ONE SESSION GATE (jev/service-budget.ts).
 * They are sequential runs of one session — the same relationship two runs of
 * the app have — and the upstream allowance belongs to the credential, not to a
 * controller, so a per-route gate would ask as if the previous route had spent
 * nothing. Sharing it is what makes route 2 wait for the window route 1 really
 * used, and each route still reports its OWN requests: the runtime subtracts the
 * counters the shared gate already held when the route was built.
 *
 *   # iterate: all six trips, no network
 *   pnpm tsx scripts/jev-fallback-harness.ts
 *
 *   # confirm live on three trips (JEV_TOKEN from the environment)
 *   pnpm tsx --env-file=.env.local scripts/jev-fallback-harness.ts \
 *     --client gateway --trips soldier-field-to-navy-pier,united-center-to-willis-tower,willis-tower-to-near-west-side
 *
 *   # confirm the DEPLOYED relay path end to end (no credential needed)
 *   pnpm tsx scripts/jev-fallback-harness.ts --client relay --base-url https://jevtrafficsim.vercel.app \
 *     --trips soldier-field-to-navy-pier
 *
 *   # two sequential live runs in ONE session: the second inherits the first's
 *   # spent window and waits for the service budget rather than asking anyway
 *   pnpm tsx --env-file=.env.local scripts/jev-fallback-harness.ts \
 *     --client gateway --trips soldier-field-to-navy-pier,united-center-to-willis-tower
 *
 *   # negative control: a stand-in that cannot answer at all must FAIL the gate
 *   pnpm tsx scripts/jev-fallback-harness.ts --mock-fail timeout
 *
 *   # loss-of-Jev control: answers once, then goes silent for good
 *   pnpm tsx scripts/jev-fallback-harness.ts --mock-silent-after 1
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import { createJevController, type JevController } from "@/controllers/jev";
import { createGatewayJevClient } from "@/jev/gateway";
import {
  JevClientError,
  createMockJevClient,
  createRelayJevClient,
  type JevClient,
  type JevClientFailure,
} from "@/jev/client";
import { jevProvenance, provenanceLine, type JevProvenance } from "@/jev/provenance";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { JEV_REFRESH_REASONS, type JevRefreshEvent, type JevRefreshReason, type JevRefreshTelemetry } from "@/jev/telemetry";
import { sessionJevServiceGate } from "@/jev/service-budget";
import type { JevServiceStatus } from "@/jev/scheduler";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { ScenarioRun } from "@/worker/challenge-compare";
import { buildScenarioRun } from "@/worker/challenge-compare";
import { LIVE_RUN_HORIZON_MS } from "@/worker/protocol";
import { loadBenchmarkModel } from "@/benchmark/model";

/* ------------------------------------------------------------- options --- */

type ClientChoice = "mock" | "gateway" | "relay";

/** A class of failure the stand-in can be told to produce, for control runs. */
const MOCK_FAILURES = ["timeout", "rate-limited", "upstream-5xx", "transport", "malformed-json", "schema-invalid"] as const;

const USAGE = `Jev pure-execution completion harness

Usage: pnpm tsx scripts/jev-fallback-harness.ts [options]

  --client <mock|gateway|relay>  how Jev gets its policy (default mock)
  --trips <id,...>               curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --traffic <everyday|rush-hour> traffic level (default rush-hour)
  --driver <tourist|local>       driver strategy (default tourist)
  --seed <n>                     scenario seed (default 42)
  --horizon <ms>                 simulated run length (default ${LIVE_RUN_HORIZON_MS})
  --pace <simPerWall>            live clients: simulated ms per wall ms (default 8, the
                                 app's playback). Mock runs unpaced unless asked.
  --mock-latency <ms>            stand-in answers after this wall delay (default 0)
  --mock-fail <class>            stand-in refuses everything, in one class
                                 (${MOCK_FAILURES.join(" | ")}): a negative control
  --mock-silent-after <n>        stand-in answers the first n requests and refuses
                                 everything after: a loss-of-Jev control
  --base-url <url>               deployed origin for --client relay
  --timeout <ms>                 one request's deadline (default: the client's own)
  --live-run-budget <n>          routes a LIVE client may run per invocation (default 3)
  --require-completion           also fail the gate when a curated trip did not finish
                                 inside the horizon (reported separately either way)
  --json <path>                  write the whole report as JSON
  --no-gate                      report only; never fail
  --help                         this text

Trips: ${CURATED_TRIP_IDS.join(", ")}`;

interface Options {
  readonly client: ClientChoice;
  readonly trips: readonly CuratedTripId[];
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly horizonMs: number;
  readonly paceRatio: number | null;
  readonly mockLatencyMs: number;
  /** A stand-in that cannot be used, in this class; null for a healthy one. */
  readonly mockFail: string | null;
  /** Answer this many requests, then refuse everything; null = never go silent. */
  readonly mockSilentAfter: number | null;
  readonly baseUrl: string;
  readonly timeoutMs: number | null;
  readonly liveRunBudget: number;
  readonly jsonPath: string | null;
  readonly gate: boolean;
  /** Also fail the gate when a trip did not finish inside the horizon. */
  readonly requireCompletion: boolean;
}

class UsageError extends Error {}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

function intArg(name: string, fallback: number, min: number): number {
  const raw = arg(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`${name} must be an integer >= ${min} (received "${raw}")`);
  }
  return value;
}

function parseMockFail(): string | null {
  const raw = arg("--mock-fail");
  if (raw === null) {
    return null;
  }
  if (!(MOCK_FAILURES as readonly string[]).includes(raw)) {
    throw new UsageError(`--mock-fail must be one of ${MOCK_FAILURES.join(", ")} (received "${raw}")`);
  }
  return raw;
}

function parseOptions(): Options {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    throw new UsageError(USAGE);
  }
  const client = arg("--client") ?? "mock";
  if (client !== "mock" && client !== "gateway" && client !== "relay") {
    throw new UsageError(`--client must be mock, gateway or relay (received "${client}")`);
  }
  const trafficLevel = arg("--traffic") ?? "rush-hour";
  if (trafficLevel !== "everyday" && trafficLevel !== "rush-hour") {
    throw new UsageError(`--traffic must be everyday or rush-hour (received "${trafficLevel}")`);
  }
  const driver = arg("--driver") ?? "tourist";
  if (driver !== "tourist" && driver !== "local") {
    throw new UsageError(`--driver must be tourist or local (received "${driver}")`);
  }
  const tripArg = arg("--trips");
  const trips = (tripArg === null ? [...CURATED_TRIP_IDS] : tripArg.split(",").map((entry) => entry.trim()))
    .filter((entry) => entry.length > 0);
  const unknown = trips.filter((id) => !(CURATED_TRIP_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new UsageError(`unknown trip id(s): ${unknown.join(", ")}\nKnown: ${CURATED_TRIP_IDS.join(", ")}`);
  }
  const paceArg = arg("--pace");
  const paceRatio = paceArg === null ? null : Number(paceArg);
  if (paceRatio !== null && (!Number.isFinite(paceRatio) || paceRatio <= 0)) {
    throw new UsageError("--pace must be a positive number of simulated ms per wall ms");
  }
  const timeoutArg = arg("--timeout");
  const timeoutMs = timeoutArg === null ? null : Number(timeoutArg);
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new UsageError("--timeout must be a positive number of ms");
  }
  return {
    client,
    trips: trips as CuratedTripId[],
    trafficLevel,
    driver,
    seed: intArg("--seed", 42, 0),
    horizonMs: intArg("--horizon", LIVE_RUN_HORIZON_MS, 1_000),
    paceRatio,
    mockLatencyMs: intArg("--mock-latency", 0, 0),
    mockFail: parseMockFail(),
    mockSilentAfter: arg("--mock-silent-after") === null ? null : intArg("--mock-silent-after", 0, 1),
    baseUrl: arg("--base-url") ?? "https://jevtrafficsim.vercel.app",
    timeoutMs,
    liveRunBudget: intArg("--live-run-budget", 3, 1),
    jsonPath: arg("--json"),
    gate: !process.argv.includes("--no-gate"),
    requireCompletion: process.argv.includes("--require-completion"),
  };
}

/* -------------------------------------------------------------- clients --- */

/**
 * A deterministic stand-in that answers after a wall delay and — when asked —
 * goes SILENT after a given number of answers, for control runs. Its id stays
 * "mock": the adapter vocabulary describes what produced a policy, and a
 * delayed or flaky stand-in is still the stand-in — never a service.
 */
function delayedMockClient(delayMs: number, silentAfter: number | null): JevClient {
  const inner = createMockJevClient();
  let answers = 0;
  return {
    id: "mock",
    requestPolicy: (request) => {
      if (silentAfter !== null && answers >= silentAfter) {
        throw new JevClientError("timeout", "mock stand-in went silent");
      }
      answers += 1;
      if (delayMs <= 0) {
        return inner.requestPolicy(request);
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(inner.requestPolicy(request)), delayMs);
      });
    },
  };
}

/**
 * The negative control: a stand-in that cannot be used, in a chosen class. It
 * exists so the gate can be shown to FAIL — a harness that has never failed has
 * not been tested. Its id stays "mock": the adapter vocabulary describes what
 * produced policies, and this produced none.
 */
function failingMockClient(kind: string): JevClient {
  return {
    id: "mock",
    requestPolicy: () => {
      if (kind === "schema-invalid") {
        return { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: "high" };
      }
      if (kind === "malformed-json") {
        return null;
      }
      const failure = kind === "upstream-5xx" ? "upstream-error" : kind;
      throw new JevClientError(
        failure as JevClientFailure,
        `mock stand-in refused every request (${kind})`,
      );
    },
  };
}

function buildClient(options: Options): JevClient {
  switch (options.client) {
    case "mock":
      return options.mockFail === null
        ? delayedMockClient(options.mockLatencyMs, options.mockSilentAfter)
        : failingMockClient(options.mockFail);
    case "relay":
      return createRelayJevClient({
        url: `${options.baseUrl.replace(/\/$/, "")}/api/jev/policy`,
        ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
      });
    case "gateway": {
      const token = process.env.JEV_TOKEN?.trim();
      if (!token) {
        throw new UsageError(
          "a live gateway run needs JEV_TOKEN in the environment — nothing is fabricated without it " +
            "(pass --env-file=.env.local, or use --client mock to iterate)",
        );
      }
      return createGatewayJevClient({
        token,
        ...(process.env.JEV_MODEL?.trim() === undefined || process.env.JEV_MODEL?.trim() === ""
          ? {}
          : { model: process.env.JEV_MODEL.trim() }),
        ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
  }
}

/* ------------------------------------------------------------ reporting --- */

interface RouteReport {
  readonly tripId: CuratedTripId;
  readonly label: string;
  readonly line: string;
  readonly provenance: JevProvenance;
  readonly telemetry: JevRefreshTelemetry;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly liveMs: number;
  readonly heldMs: number;
  /**
   * Simulated ms an Adaptive controller governed. A hard zero, reported so the
   * gate can require it by value rather than by absence.
   */
  readonly fallbackMs: number;
  /** Ticks an Adaptive controller decided. A hard zero, for the same reason. */
  readonly adaptiveTicks: number;
  /** Simulated ms NO Jev policy governed. Must be zero to pass. */
  readonly invalidMs: number;
  /** Set when the run LOST Jev: the instant and the classified reason. */
  readonly invalidation: { readonly atSimMs: number; readonly reason: string } | null;
  /** Set when the run could not start at all: the classified reason. */
  readonly unableReason: string | null;
  readonly simulatedMs: number;
  /** The horizon the run was asked for, so "did not finish" names its bound. */
  readonly horizonMs: number;
  readonly tripCompleted: boolean;
  readonly tripTimeMs: number;
  /** How far the protagonist got, and how much of its time it spent stopped. */
  readonly tripDistanceM: number;
  readonly tripStoppedMs: number;
  readonly reasonMs: Readonly<Partial<Record<JevRefreshReason, number>>>;
  /**
   * The wall-clock service schedule this run actually achieved (jev/scheduler.ts):
   * requests issued, answers received, refusals by reason, and the spacing the
   * successful policies landed at. Null for a client that needs no gate.
   */
  readonly service: JevServiceStatus | null;
  /**
   * Simulated ms between accepted policies, from the run's own refresh record:
   * the freshness the schedule bought in SIMULATED time, which is the quantity
   * TTL and max hold are expressed in.
   */
  readonly successSpacingSimMs: { readonly p50: number; readonly max: number };
  readonly failures: readonly JevRefreshEvent[];
  readonly latencyP50Ms: number;
  readonly latencyMaxMs: number;
  /**
   * The wall-clock instants this route's run started and ended. They make the
   * report self-contained about TIMING: a run whose window was already spent
   * must show its first request AFTER the instant it started, which is the
   * difference between waiting for the shared budget and asking anyway.
   */
  readonly startedAtEpochMs: number;
  readonly endedAtEpochMs: number;
}

/** What a route report needs from a run's outcome; a ChallengeResult satisfies it. */
type RunOutcome = Parameters<typeof reportFor>[2];

/**
 * The outcome of a run that never started: zero measurements, named as such. The
 * harness reports it so a route that could not start FAILS the gate by name
 * instead of crashing the invocation.
 */
function emptyResult(): RunOutcome {
  return {
    simulatedMs: 0,
    trip: { completed: false, tripTimeMs: 0, distanceM: 0, stoppedMs: 0 },
  };
}

/** Nearest-rank p50/max of a list of durations; 0 for an empty list. */
function summarizeSpacing(values: readonly number[]): { p50: number; max: number } {
  if (values.length === 0) {
    return { p50: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
}

/**
 * The p50/max answer latency of the windows that actually ASKED.
 *
 * A window the schedule declined (or that found a request in flight) made no
 * request at all, so it has no answer latency; its recorded 0 is the absence of
 * an answer, not a fast one. Counting those zeros would drag the median towards
 * zero and describe a service that was never asked.
 */
function summarizeLatency(events: readonly JevRefreshEvent[]): { p50: number; max: number } {
  const values = events
    .filter((event) => event.generation !== null)
    .map((event) => event.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { p50: 0, max: 0 };
  }
  return { p50: values[Math.floor(values.length / 2)], max: values[values.length - 1] };
}

function reportFor(
  tripId: CuratedTripId,
  controller: JevController,
  result: {
    readonly simulatedMs: number;
    readonly trip: {
      readonly completed: boolean;
      readonly tripTimeMs: number;
      readonly distanceM: number;
      readonly stoppedMs: number;
    };
  },
  horizonMs: number,
  wall: { readonly startedAtEpochMs: number; readonly endedAtEpochMs: number },
): RouteReport {
  const meta = controller.meta();
  const provenance = jevProvenance(meta);
  const telemetry = meta.telemetry;
  const latency = summarizeLatency(telemetry.recent);
  // The simulated gap between accepted policies, from the accepted rows only:
  // the run's own answer to "how fresh was the policy stream, in the units the
  // TTL and the maximum hold are written in".
  const acceptedAtSim = telemetry.recent
    .filter((event) => event.outcome === "live")
    .map((event) => event.atSimMs);
  const simSpacings = acceptedAtSim.slice(1).map((at, index) => at - acceptedAtSim[index]);
  return {
    tripId,
    label: provenance.label,
    line: provenanceLine(provenance),
    provenance,
    telemetry,
    refreshes: meta.refreshes,
    accepted: meta.accepted,
    rejected: meta.rejected,
    liveMs: meta.liveMs,
    heldMs: meta.heldMs,
    fallbackMs: meta.fallbackMs,
    adaptiveTicks: meta.adaptiveTicks,
    invalidMs: meta.invalidMs,
    invalidation: meta.invalidation === null
      ? null
      : { atSimMs: meta.invalidation.atSimMs, reason: meta.invalidation.reason },
    unableReason: meta.start?.state === "unable" ? meta.start.reason : null,
    simulatedMs: result.simulatedMs,
    horizonMs,
    tripCompleted: result.trip.completed,
    tripTimeMs: result.trip.tripTimeMs,
    tripDistanceM: result.trip.distanceM,
    tripStoppedMs: result.trip.stoppedMs,
    reasonMs: telemetry.reasonMs,
    service: meta.service,
    successSpacingSimMs: summarizeSpacing(simSpacings),
    failures: telemetry.recent.filter((event) => event.outcome !== "live"),
    latencyP50Ms: latency.p50,
    latencyMaxMs: latency.max,
    startedAtEpochMs: wall.startedAtEpochMs,
    endedAtEpochMs: wall.endedAtEpochMs,
  };
}

/**
 * Everything the gate checks, per route. The two lists are kept apart on
 * purpose: "this run was not a Jev run" and "the trip did not finish" are
 * different failures with different owners, and a report that merged them would
 * be exactly the kind of thing this harness exists to prevent.
 */
export interface RouteVerdict {
  readonly fallbackProblems: readonly string[];
  readonly completionProblems: readonly string[];
}

export function routeVerdict(report: RouteReport): RouteVerdict {
  const fallbackProblems: string[] = [];
  const completionProblems: string[] = [];
  if (report.unableReason !== null) {
    fallbackProblems.push(
      `the run never started: the first policy could not be obtained (${report.unableReason}) — ` +
        "nothing was simulated and nothing was substituted for Jev",
    );
  }
  if (report.invalidation !== null) {
    fallbackProblems.push(
      `Jev was LOST at ${secs(report.invalidation.atSimMs)} (${report.invalidation.reason}): ` +
        "the run stopped there and is not a completed Jev result",
    );
  }
  if (report.adaptiveTicks > 0) {
    fallbackProblems.push(`${report.adaptiveTicks} tick(s) were decided by an Adaptive controller`);
  }
  if (report.fallbackMs > 0) {
    fallbackProblems.push(`${report.fallbackMs} ms were governed by an Adaptive controller`);
  }
  if (report.telemetry.outcomes.ungoverned > 0) {
    fallbackProblems.push(
      `${report.telemetry.outcomes.ungoverned} refresh window(s) had no policy in force at all`,
    );
  }
  if (report.invalidMs > 0) {
    fallbackProblems.push(
      `${report.invalidMs} ms of simulated time had NO Jev policy in force`,
    );
  }
  if (report.telemetry.outcomes.live < 1 || report.accepted < 1) {
    fallbackProblems.push("no policy was ever accepted: this was not a Jev run");
  }
  if (report.liveMs <= 0 && report.accepted > 0) {
    fallbackProblems.push("no simulated time was governed by the accepted policy");
  }
  if (!report.tripCompleted) {
    completionProblems.push(
      `the trip did not finish inside the ${secs(report.simulatedMs)} horizon` +
        ` (ego ${(report.tripDistanceM / 1000).toFixed(2)} km in, ${secs(report.tripStoppedMs)} stopped)`,
    );
  }
  return { fallbackProblems, completionProblems };
}

/* ----------------------------------------------------------------- run ---- */

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const options = parseOptions();
  const isLive = options.client !== "mock";
  if (isLive && options.trips.length > options.liveRunBudget) {
    throw new UsageError(
      `this invocation would spend ${options.trips.length} live runs and the budget is ` +
        `${options.liveRunBudget} (--live-run-budget). Narrow --trips, or raise the budget ` +
        "explicitly if the quota really allows it.",
    );
  }
  const paceRatio = options.paceRatio ?? (isLive ? 8 : 0);
  const client = buildClient(options);
  const model = loadBenchmarkModel();
  // ONE session gate for every route this invocation runs (see the module doc):
  // sequential live runs share one upstream allowance, so they share one gate.
  const sessionGate = isLive ? sessionJevServiceGate() : null;

  console.log(
    `\nJev pure-execution harness · client=${options.client}${options.client === "mock" && options.mockLatencyMs > 0 ? ` (+${options.mockLatencyMs}ms)` : ""}` +
      `${options.mockFail === null ? "" : ` · stand-in failure=${options.mockFail}`}` +
      `${options.mockSilentAfter === null ? "" : ` · silent after ${options.mockSilentAfter} answer(s)`}` +
      ` · traffic=${options.trafficLevel} · driver=${options.driver} · seed=${options.seed}` +
      ` · horizon=${secs(options.horizonMs)} · pace=${paceRatio === 0 ? "unpaced" : `${paceRatio}x`}` +
      ` · trips=${options.trips.length}`,
  );

  const reports: RouteReport[] = [];
  for (const tripId of options.trips) {
    const startedAt = Date.now();
    // ONE controller per route, captured through the seam the app uses, so the
    // run the record describes is the run the world produced.
    let controller: JevController | null = null;
    const run: ScenarioRun = buildScenarioRun(
      model,
      {
        tripId,
        trafficLevel: options.trafficLevel,
        driver: options.driver,
        seed: options.seed,
        durationMs: options.horizonMs,
      },
      {
        controllers: {
          jev: (context) => {
            controller = createJevController({
              client,
              scenarioFingerprint: context.fingerprint,
              // Live clients spend a real allowance; the stand-in spends none
              // and stays deterministic, so only the live paths are gated. The
              // gate is the SESSION's (shared by every route in this invocation,
              // exactly as it is shared by every run of one app session), not a
              // fresh one per route: the allowance belongs to the credential.
              serviceGate: sessionGate,
            });
            return controller;
          },
        },
      },
    );
    let result: RunOutcome;
    try {
      result =
        // A synchronous stand-in needs no event loop; anything live must be
        // paced, exactly like the app, or the run would outrun its own answers.
        options.client === "mock" && options.mockLatencyMs === 0 && paceRatio === 0
          ? run.runUnder("jev")
          : await run.runUnderAsync("jev", { paceRatio });
    } catch (error) {
      // A run that could not START is a result too, and the harness reports it
      // rather than crashing: the gate below fails it, by name.
      if (controller === null) {
        throw error;
      }
      const report = reportFor(tripId, controller, emptyResult(), options.horizonMs, {
        startedAtEpochMs: startedAt,
        endedAtEpochMs: Date.now(),
      });
      reports.push(report);
      console.log(
        `\n[run FAIL] ${tripId} · ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const problem of routeVerdict(report).fallbackProblems) {
        console.log(`       run: ${problem}`);
      }
      continue;
    }
    if (controller === null) {
      throw new Error("the seam never asked for a jev controller");
    }
    const report = reportFor(tripId, controller, result, options.horizonMs, {
      startedAtEpochMs: startedAt,
      endedAtEpochMs: Date.now(),
    });
    reports.push(report);
    const verdict = routeVerdict(report);
    const wallMs = Date.now() - startedAt;
    console.log(
      `\n[run ${verdict.fallbackProblems.length === 0 ? "PASS" : "FAIL"}` +
        ` · trip ${verdict.completionProblems.length === 0 ? "PASS" : "FAIL"}] ${tripId}` +
        ` · ${secs(wallMs)} wall · ${(report.simulatedMs / Math.max(1, wallMs)).toFixed(1)}x achieved` +
        ` · ${report.tripCompleted ? `completed in ${secs(report.tripTimeMs)}` : "NOT COMPLETED"}`,
    );
    for (const problem of verdict.fallbackProblems) {
      console.log(`       run: ${problem}`);
    }
    for (const problem of verdict.completionProblems) {
      console.log(`       completion: ${problem}`);
    }
  }

  /* ------------------------------------------------------------ summary --- */
  console.log("\n=== per-route summary ===");
  console.log(
    [
      "trip".padEnd(32),
      "windows live/held/ungov".padEnd(22),
      "liveMs".padStart(8),
      "heldMs".padStart(8),
      "ungov".padStart(8),
      "adaptive".padStart(8),
      "accepted".padStart(9),
      "p50/maxRTT".padStart(13),
      "label",
    ].join(" "),
  );
  for (const report of reports) {
    const outcomes = report.telemetry.outcomes;
    console.log(
      [
        report.tripId.padEnd(32),
        `${outcomes.live}/${outcomes.held}/${outcomes.ungoverned}`.padEnd(20),
        secs(report.liveMs).padStart(8),
        secs(report.heldMs).padStart(8),
        secs(report.invalidMs + report.fallbackMs).padStart(8),
        String(report.adaptiveTicks).padStart(8),
        String(report.accepted).padStart(9),
        `${report.latencyP50Ms}/${report.latencyMaxMs}ms`.padStart(13),
        report.label,
      ].join(" "),
    );
  }

  console.log("\n=== the service schedule the runs actually achieved ===");
  if (reports.every((report) => report.service === null)) {
    console.log("  (no service gate was wired: this client needs no wall-clock budget)");
  } else {
    console.log(
      [
        "trip".padEnd(32),
        "issued".padStart(7),
        "answered".padStart(9),
        "refused".padStart(8),
        "spacing wall p50/max".padStart(21),
        "spacing sim p50/max".padStart(20),
      ].join(" "),
    );
    for (const report of reports) {
      const service = report.service;
      const refusals = service === null
        ? 0
        : Object.values(service.refusals).reduce((sum, count) => sum + (count ?? 0), 0);
      console.log(
        [
          report.tripId.padEnd(32),
          String(service?.issued ?? 0).padStart(7),
          String(service?.answered ?? 0).padStart(9),
          String(refusals).padStart(8),
          `${service?.successSpacingP50Ms ?? 0}/${service?.successSpacingMaxMs ?? 0}ms`.padStart(21),
          `${secs(report.successSpacingSimMs.p50)}/${secs(report.successSpacingSimMs.max)}`.padStart(20),
        ].join(" "),
      );
    }
    // What the SESSION spent, not what one route spent: the counters above are
    // per-route (this run's own requests), and this line is the shared window
    // they all drew from — the fact a per-controller gate used to hide.
    if (sessionGate !== null) {
      const session = sessionGate.status();
      console.log(
        `  session budget (ONE gate for every route above): ${session.issued} requests issued, ` +
          `${session.issuedInWindow}/${session.allowedInWindow} in the trailing window` +
          `${session.retryAfterMs === null ? "" : `, a ${secs(session.retryAfterMs)} pause in force`}`,
      );
      // WHEN each route's first request landed relative to its own start: a
      // route that inherited a spent window shows a positive delay here, which
      // is the difference between waiting for the shared budget and asking
      // anyway. The instant is the window's own record (wall-clock, for
      // correlating a run with logs).
      for (const report of reports) {
        const firstRequest = report.telemetry.recent.find((event) => event.generation !== null);
        if (firstRequest === undefined) {
          continue;
        }
        console.log(
          `  ${report.tripId.padEnd(32)} first request ${secs(firstRequest.atEpochMs - report.startedAtEpochMs)}` +
            ` after this route started (route ran ${secs(report.endedAtEpochMs - report.startedAtEpochMs)})`,
        );
      }
    }
  }

  const reasons = new Map<JevRefreshReason, { windows: number; ms: number }>();
  for (const report of reports) {
    for (const [reason, count] of Object.entries(report.telemetry.reasons)) {
      const entry = reasons.get(reason as JevRefreshReason) ?? { windows: 0, ms: 0 };
      entry.windows += count;
      entry.ms += report.reasonMs[reason as JevRefreshReason] ?? 0;
      reasons.set(reason as JevRefreshReason, entry);
    }
  }
  console.log("\n=== per-reason counts (all routes) ===");
  if (reasons.size === 0) {
    console.log("  (no refresh window was anything but live)");
  } else {
    for (const reason of JEV_REFRESH_REASONS) {
      const entry = reasons.get(reason);
      if (entry !== undefined) {
        console.log(`  ${reason.padEnd(20)} windows ${String(entry.windows).padStart(4)} · ${secs(entry.ms)} of fallback`);
      }
    }
  }

  // WHERE it happened, and WHY: the run's own rows, one per non-live window.
  const nonLive = reports.flatMap((report) =>
    report.failures.map((event) => ({ tripId: report.tripId, event })),
  );
  console.log("\n=== every non-live refresh window ===");
  if (nonLive.length === 0) {
    console.log("  (every refresh window in every route produced the policy in force)");
  } else {
    for (const { tripId, event } of nonLive) {
      console.log(
        `  ${tripId.padEnd(32)} #${String(event.index).padStart(3)} at sim ${secs(event.atSimMs).padStart(9)}` +
          ` -> ${event.outcome.padEnd(8)} reason=${(event.reason ?? "none").padEnd(19)}` +
          (event.field === null ? "" : ` field=${event.field} bound=${event.bound}`) +
          `\n      ${event.detail}`,
      );
    }
  }

  console.log("\n=== provenance lines (what a result says about itself) ===");
  for (const report of reports) {
    console.log(`  ${report.tripId}: ${report.line}`);
  }

  if (options.jsonPath !== null) {
    const out = path.resolve(options.jsonPath);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          client: options.client,
          mockLatencyMs: options.mockLatencyMs,
          mockFail: options.mockFail,
          mockSilentAfter: options.mockSilentAfter,
          trafficLevel: options.trafficLevel,
          driver: options.driver,
          seed: options.seed,
          horizonMs: options.horizonMs,
          paceRatio,
          routes: reports.map((report) => ({
            ...report,
            provenance: report.provenance,
            telemetry: report.telemetry,
            failures: report.failures,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\nreport written to ${out}`);
  }

  const fallbackFailed = reports.filter((report) => routeVerdict(report).fallbackProblems.length > 0);
  const completionFailed = reports.filter(
    (report) => routeVerdict(report).completionProblems.length > 0,
  );
  if (fallbackFailed.length === 0) {
    const held = reports.reduce((sum, report) => sum + report.heldMs, 0);
    const governed = reports.reduce((sum, report) => sum + report.liveMs, 0);
    console.log(
      `\nGATE: pure Jev on ${reports.length}/${reports.length} routes — every simulated ` +
        "millisecond was governed by an accepted Jev policy: ZERO Adaptive ticks, ZERO fallback " +
        "time, ZERO ungoverned time, ZERO windows with no policy in force.",
    );
    console.log(
      `      ${secs(governed)} of simulated time governed by accepted policies` +
        `${held > 0 ? `, ${secs(held)} of it HELD past the refresh window (the accelerated tail)` : ""}.`,
    );
  } else {
    console.log(
      `\nGATE: ${fallbackFailed.length}/${reports.length} routes were not pure Jev runs: ` +
        fallbackFailed.map((report) => report.tripId).join(", "),
    );
  }
  if (completionFailed.length > 0) {
    // Reported, in its own words, always. It is a DIFFERENT failure from a
    // fallback — a trip that did not finish is not the safety net running — and
    // whether it should also fail the gate is a separate question, answered by
    // --require-completion rather than by quietly dropping the check.
    console.log(
      `\nCOMPLETION: ${completionFailed.length}/${reports.length} routes did not finish the trip inside the horizon:`,
    );
    for (const report of completionFailed) {
      console.log(`      ${report.tripId}: ${routeVerdict(report).completionProblems.join("; ")}`);
    }
  }
  if (options.gate && (fallbackFailed.length > 0 || (options.requireCompletion && completionFailed.length > 0))) {
    process.exitCode = 1;
  }
}

/** Importable for tests without running anything (see the guard below). */
export { main as runJevFallbackHarness };

if (process.argv[1]?.includes("jev-fallback-harness") === true) {
  void main().catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(
      `jev fallback harness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
