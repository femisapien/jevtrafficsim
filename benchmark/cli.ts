/**
 * Benchmark CLI (Issue #12): `pnpm benchmark`.
 *
 *   pnpm benchmark                                  # the default matrix
 *   pnpm benchmark --trip soldier-field-to-navy-pier --traffic rush-hour
 *   pnpm benchmark --driver tourist --seed 42,2026 --out /tmp/bench.json
 *
 * Writes one JSON document (matrix + every run + the aggregates) to a local,
 * gitignored path and prints a readable summary. Browser-free: this is the same
 * engine, the same controllers and the same geography the app runs, driven from
 * Node with no DOM, no React, no MapLibre and no worker.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import { createJevController, type JevController } from "@/controllers/jev";
import { sessionJevServiceGate } from "@/jev/service-budget";
import {
  createHttpJevClient,
  createMockJevClient,
  JEV_DEFAULT_TIMEOUT_MS,
  type JevClient,
} from "@/jev/client";
import { JEV_GATEWAY_TIMEOUT_MS } from "@/jev/gateway";
import {
  createGatewayJevClient,
  JEV_GATEWAY_ENDPOINT,
  JEV_GATEWAY_MODEL,
} from "@/jev/gateway";
import { parseJevTrace, serializeTrace, type JevTrace } from "@/jev/trace";
import { jevProvenance, provenanceLabel, provenanceLine } from "@/jev/provenance";
import { buildChallengeScenario, scenarioFingerprint } from "@/worker/challenge-scenario";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import { type ControllerChoice } from "@/worker/protocol";
import type { ScenarioRunOptions } from "@/worker/challenge-compare";
import { aggregateRuns, type ExperimentGroup } from "./aggregate";
import { loadBenchmarkModel } from "./model";
import {
  runBenchmarkMatrix,
  runBenchmarkScenario,
  runLiveScenario,
  type BenchmarkRunRecord,
  type ControllerDescriber,
  type RunProgress,
} from "./runner";
import {
  DEFAULT_BENCHMARK_MATRIX,
  describeMatrix,
  expandMatrix,
  withOverrides,
  type BenchmarkMatrix,
  type MatrixOverrides,
} from "./scenarios";

/**
 * The JSON contract. Deterministic: no timestamps, no wall times.
 *
 * `jevAdapter` names the policy source for this document's jev rows (Issue #38),
 * so a reader learns what produced them from the artifact's first screen — and
 * `runs[].provenance` repeats it per run with the funnel and governed time.
 */
export interface BenchmarkDocument {
  readonly version: 1;
  readonly jevAdapter: {
    readonly adapter: string;
    readonly label: string;
    readonly modelInvolved: boolean;
  } | null;
  readonly matrix: BenchmarkMatrix;
  readonly runs: readonly BenchmarkRunRecord[];
  readonly groups: readonly ExperimentGroup[];
}

const USAGE = `pnpm benchmark [options]

Options:
  --trip <id,...>           curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --traffic <level,...>     everyday | rush-hour (default: both)
  --driver <name,...>       tourist | local (default: both)
  --seed <n,...>            deterministic seeds (default: 42)
  --controllers <c,...>     fixed | adaptive | jev (default: fixed,adaptive)
  --jev <mock|live|gateway|replay>
                            how jev gets its policy (default: mock). The
                            artifact records this as jev-<adapter>, and the
                            output file is named for it.
                              mock    = deterministic stand-in, no network, no credential
                              gateway = TypeSafe AI's jev via the Vercel AI Gateway
                                        (JEV_TOKEN + JEV_MODEL; JEV_GATEWAY_URL overrides
                                        the gateway URL)
                              live    = a service that speaks the Jev policy schema
                                        (JEV_ENDPOINT + JEV_TOKEN), called server-side
                              replay  = an offline trace recorded by an earlier run
                                        (--trace); zero network calls
                            live and gateway refuse to run a big matrix
  --trace <path>            accepted-policy trace to replay (required by --jev replay)
  --trace-out <path>        write the accepted-policy trace of a single run
  --pace <simPerWall>       live/gateway only: pace simulated time against the wall
                            clock (8 matches the app's playback). Results are
                            unchanged; without it a live drive runs as fast as the
                            event loop allows and can outrun a remote model
  --horizon <ms|Ns|Nm>      simulated run length (default: the live horizon)
  --out <path>              JSON output (default: benchmark/results/benchmark-jev-<adapter>-<stamp>.json
                            when the matrix includes jev)
  --quiet                   only the final summary
  --help                    this text

Trips: ${CURATED_TRIP_IDS.join(", ")}`;

class UsageError extends Error {}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseHorizon(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) {
    throw new UsageError(`--horizon must be a duration like 600000, 600s or 10m (received "${value}")`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const ms = unit === "ms" ? amount : unit === "s" ? amount * 1000 : amount * 60_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(`--horizon must be positive (received "${value}")`);
  }
  return ms;
}

function parseSeeds(values: readonly string[]): number[] {
  const seeds = values.flatMap(splitList).map((entry) => {
    const seed = Number(entry);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new UsageError(`--seed must be an integer in [0, 4294967295] (received "${entry}")`);
    }
    return seed;
  });
  if (seeds.length === 0) {
    throw new UsageError("--seed needs at least one value");
  }
  return [...new Set(seeds)];
}

function parseTrips(values: readonly string[]): CuratedTripId[] {
  const ids = values.flatMap(splitList);
  const unknown = ids.filter((id) => !CURATED_TRIP_IDS.includes(id as CuratedTripId));
  if (unknown.length > 0) {
    throw new UsageError(`unknown trip id(s): ${unknown.join(", ")}\nKnown: ${CURATED_TRIP_IDS.join(", ")}`);
  }
  return ids as CuratedTripId[];
}

function parseLevels(values: readonly string[]): TrafficLevel[] {
  const levels = values.flatMap(splitList);
  const unknown = levels.filter((level) => level !== "everyday" && level !== "rush-hour");
  if (unknown.length > 0) {
    throw new UsageError(`unknown traffic level(s): ${unknown.join(", ")} (everyday | rush-hour)`);
  }
  return levels as TrafficLevel[];
}

function parseDrivers(values: readonly string[]): DriverStrategy[] {
  const drivers = values.flatMap(splitList);
  const unknown = drivers.filter((driver) => driver !== "tourist" && driver !== "local");
  if (unknown.length > 0) {
    throw new UsageError(`unknown driver(s): ${unknown.join(", ")} (tourist | local)`);
  }
  return drivers as DriverStrategy[];
}

function parseControllers(values: readonly string[]): ControllerChoice[] {
  const controllers = values.flatMap(splitList);
  const unknown = controllers.filter((c) => c !== "fixed" && c !== "adaptive" && c !== "jev");
  if (unknown.length > 0) {
    throw new UsageError(`unknown controller(s): ${unknown.join(", ")} (fixed | adaptive | jev)`);
  }
  return controllers as ControllerChoice[];
}

export type JevAdapterChoice = "mock" | "live" | "gateway" | "replay";

function parseJevAdapter(value: string): JevAdapterChoice {
  if (value !== "mock" && value !== "live" && value !== "gateway" && value !== "replay") {
    throw new UsageError(`--jev must be mock, live, gateway or replay (received "${value}")`);
  }
  return value;
}

function parsePace(value: string): number {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new UsageError(`--pace must be a positive number of simulated ms per wall ms`);
  }
  return ratio;
}

export interface CliOptions {
  readonly overrides: MatrixOverrides;
  readonly outPath: string | null;
  readonly quiet: boolean;
  /** How the jev controller gets its policy when it is in the matrix. */
  readonly jevAdapter: JevAdapterChoice;
  /** Accepted-policy trace to replay (--jev replay). */
  readonly tracePath: string | null;
  /** Where to write this run's accepted-policy trace. */
  readonly traceOutPath: string | null;
  /** Pacing for live runs, in simulated ms per wall ms (0 = unpaced). */
  readonly paceRatio: number;
}

/** Parse argv (without node/script) into options. Throws UsageError on bad input. */
export function parseArgs(argv: readonly string[], now: Date = new Date()): CliOptions {
  const overrides: {
    trips?: CuratedTripId[];
    trafficLevels?: TrafficLevel[];
    seeds?: number[];
    drivers?: DriverStrategy[];
    controllers?: ControllerChoice[];
    durationMs?: number;
  } = {};
  let outPath: string | null = null;
  let quiet = false;
  let jevAdapter: JevAdapterChoice = "mock";
  let tracePath: string | null = null;
  let traceOutPath: string | null = null;
  let paceRatio = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (): string[] => {
      index += 1;
      if (index >= argv.length) {
        throw new UsageError(`${arg} needs a value`);
      }
      return [argv[index]];
    };
    switch (arg) {
      case "--help":
      case "-h":
        throw new UsageError(USAGE);
      case "--trip":
        overrides.trips = [...(overrides.trips ?? []), ...parseTrips(take())];
        break;
      case "--traffic":
        overrides.trafficLevels = [...(overrides.trafficLevels ?? []), ...parseLevels(take())];
        break;
      case "--driver":
        overrides.drivers = [...(overrides.drivers ?? []), ...parseDrivers(take())];
        break;
      case "--seed":
        overrides.seeds = parseSeeds([...(overrides.seeds ?? []).map(String), ...take()]);
        break;
      case "--controllers":
        overrides.controllers = parseControllers(take());
        break;
      case "--jev":
        jevAdapter = parseJevAdapter(take()[0]);
        break;
      case "--trace":
        tracePath = take()[0];
        break;
      case "--trace-out":
        traceOutPath = take()[0];
        break;
      case "--pace":
        paceRatio = parsePace(take()[0]);
        break;
      case "--horizon":
        overrides.durationMs = parseHorizon(take()[0]);
        break;
      case "--out":
        outPath = take()[0];
        break;
      case "--quiet":
        quiet = true;
        break;
      default:
        throw new UsageError(`unknown option "${arg}"\n\n${USAGE}`);
    }
  }
  if (outPath === null) {
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    // The file name carries the policy source (Issue #38): a mock artifact must
    // never sit in a results directory wearing the same name as a live one.
    const label = overrides.controllers?.includes("jev") === true ? `-${jevLabel({ jevAdapter })}` : "";
    outPath = path.join("benchmark", "results", `benchmark${label}-${stamp}.json`);
  }
  return { overrides, outPath, quiet, jevAdapter, tracePath, traceOutPath, paceRatio };
}

/** Load and validate a trace file. Throws UsageError with a clear message. */
function loadTrace(path: string): JevTrace {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new UsageError(
      `could not read the trace at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseJevTrace(raw);
  if (!parsed.ok) {
    throw new UsageError(`the trace at ${path} is not usable: ${parsed.error}`);
  }
  return parsed.value;
}

const pad = (value: string, width: number): string => value.padEnd(width, " ").slice(0, width);
const num = (value: number, digits = 0): string => value.toFixed(digits);

function seconds(ms: number): string {
  return `${num(ms / 1000, 1)}s`;
}

/** Human-readable summary of the aggregates (stdout only — not the JSON). */
export function formatSummary(groups: readonly ExperimentGroup[]): string {
  const lines: string[] = [];
  lines.push(
    [
      pad("trip", 32),
      pad("traffic", 10),
      pad("driver", 8),
      pad("controller", 10),
      pad("done", 6),
      pad("trip mean", 10),
      pad("trip p95", 10),
      pad("wait mean", 10),
      pad("wait p95", 10),
      pad("thru/min", 9),
      pad("gridlock", 9),
      pad("active", 7),
    ].join(" "),
  );
  for (const group of groups) {
    for (const summary of group.controllers) {
      lines.push(
        [
          pad(group.key.tripId, 32),
          pad(group.key.trafficLevel, 10),
          pad(group.key.driver, 8),
          pad(summary.controller, 10),
          pad(`${num(summary.completionRate * 100)}%`, 6),
          pad(seconds(summary.tripTimeMs.mean), 10),
          pad(seconds(summary.tripTimeMs.p95), 10),
          pad(seconds(summary.city.averageWaitMs.mean), 10),
          pad(seconds(summary.city.p95WaitMs.mean), 10),
          pad(num(summary.city.throughputPerMinute.mean, 1), 9),
          pad(num(summary.city.gridlockRatio.mean, 3), 9),
          pad(num(summary.city.activeVehicles.mean), 7),
        ].join(" "),
      );
    }
  }
  return lines.join("\n");
}

/** Assemble the output document: matrix + every run + the aggregates. */
export function buildDocument(
  matrix: BenchmarkMatrix,
  runs: readonly BenchmarkRunRecord[],
  jevAdapter: JevAdapterChoice = "mock",
): BenchmarkDocument {
  for (const run of runs) {
    if (run.controller === "jev" && run.provenance?.controller !== "jev") {
      throw new Error("cannot emit a Jev benchmark artifact without provenance");
    }
    if (run.controller !== "jev" && run.provenance !== undefined) {
      throw new Error("baseline artifact cannot carry Jev provenance");
    }
  }
  return {
    version: 1,
    // The document says which adapter produced its jev rows, so the artifact is
    // self-describing even before its per-run provenance is read.
    jevAdapter: matrix.controllers.includes("jev")
      ? {
          adapter: jevAdapter === "live" ? "schema-service" : jevAdapter,
          label: jevLabel({ jevAdapter }),
          // A replay's own flag says nothing about the model: follow the records
          // when they exist, so replaying a gateway run cannot read as model-free.
          modelInvolved:
            runs.find((run) => run.provenance !== undefined)?.provenance?.modelInvolved ??
            (jevAdapter === "gateway" || jevAdapter === "live"),
        }
      : null,
    matrix,
    runs,
    groups: aggregateRuns(runs),
  };
}

/** A live matrix is a smoke run, not a benchmark: never hammer the service. */
export const LIVE_SMOKE_MAX_RUNS = 8;

/**
 * Why a live run cannot proceed, or null when it can. Kept separate from the
 * CLI so the cap is testable without running anything.
 */
export function liveRunCapError(runCount: number): string | null {
  if (runCount <= LIVE_SMOKE_MAX_RUNS) {
    return null;
  }
  return (
    `live jev runs are capped at ${LIVE_SMOKE_MAX_RUNS} (this matrix is ${runCount}) — ` +
    "narrow --trip / --seed / --driver"
  );
}

/** The run's provenance token, from the flag the user actually passed. */
export function jevLabel(options: { readonly jevAdapter: JevAdapterChoice }): string {
  return provenanceLabel(options.jevAdapter === "live" ? "schema-service" : options.jevAdapter);
}

/** One explicit banner, so no reader has to infer the adapter from the numbers. */
export function adapterBanner(options: { readonly jevAdapter: JevAdapterChoice }, trace: JevTrace | null): string {
  switch (options.jevAdapter) {
    case "mock":
      return (
        `jev: ${jevLabel(options)} — MOCK adapter: a deterministic stand-in. ` +
        "NO model, NO network, NO credential, NOT the Jev service; the numbers below describe the stub, not Jev."
      );
    case "replay":
      return (
        `jev: ${jevLabel(options)} — REPLAY adapter: ${trace?.events.length ?? 0} recorded policies, ` +
        `zero network calls; it reproduces a run recorded from client "${trace?.client ?? "unknown"}"` +
        (trace?.recorded == null
          ? " (that run's own history is NOT recorded — treat its refusals as unknown)"
          : ` (recorded run used ${provenanceLabel(trace.recorded.adapter)}: ` +
            `${trace.recorded.accepted} accepted, ${trace.recorded.rejected} rejected, ` +
            `${(trace.recorded.fallbackMs / 1000).toFixed(1)}s on the Adaptive fallback` +
            " — under the pre-#61 contract, so a pre-#61 trace can carry it)")
      );
    case "gateway":
      return (
        `jev: ${jevLabel(options)} — GATEWAY adapter: ${process.env.JEV_MODEL?.trim() || JEV_GATEWAY_MODEL} ` +
        "via the Vercel AI Gateway; results are not reproducible (wall-clock arrival)"
      );
    default:
      return (
        `jev: ${jevLabel(options)} — LIVE adapter: policies come from JEV_ENDPOINT server-side; ` +
        "results are not reproducible (wall-clock arrival)"
      );
  }
}

/** Optional confidence floor from the environment; the adapter owns the default. */
function readMinConfidenceEnv(): number | undefined {
  const raw = process.env.JEV_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function liveJevClientFromEnv(
  adapter: "live" | "gateway",
): { client: JevClient } | { error: string } {
  const token = process.env.JEV_TOKEN?.trim();
  if (!token) {
    return {
      error:
        "a live jev run needs JEV_TOKEN in the environment — no policy is " +
        "fabricated without it (use --jev mock to exercise the seam)",
    };
  }
  // JEV_TIMEOUT_MS overrides; without it each transport keeps its own default,
  // so the gateway's 15 s is not silently replaced by the generic 4 s (issue #57).
  const configured = Number(process.env.JEV_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : JEV_DEFAULT_TIMEOUT_MS;
  const gatewayTimeoutMs = Number.isFinite(configured) && configured > 0 ? configured : JEV_GATEWAY_TIMEOUT_MS;

  if (adapter === "gateway") {
    // Only the configured model is ever asked (TypeSafe AI's jev by default).
    return {
      client: createGatewayJevClient({
        token,
        endpoint: process.env.JEV_GATEWAY_URL?.trim() || JEV_GATEWAY_ENDPOINT,
        model: process.env.JEV_MODEL?.trim() || JEV_GATEWAY_MODEL,
        timeoutMs: gatewayTimeoutMs,
        minConfidence: readMinConfidenceEnv(),
      }),
    };
  }

  const endpoint = process.env.JEV_ENDPOINT?.trim();
  if (!endpoint) {
    return { error: "the live adapter needs JEV_ENDPOINT in the environment" };
  }
  return { client: createHttpJevClient({ endpoint, token, timeoutMs }) };
}

/** Aggregate the adapter's own account of what it did — evidence, not a claim. */
export function describeJevStatus(controllers: readonly JevController[]): string {
  if (controllers.length === 0) {
    return "";
  }
  let refreshes = 0;
  let accepted = 0;
  let rejected = 0;
  let expiries = 0;
  let fallbackMs = 0;
  let invalidMs = 0;
  let adaptiveTicks = 0;
  let heldMs = 0;
  let policyMs = 0;
  const adapters = new Set<string>();
  const errors = new Set<string>();
  const stopped: string[] = [];
  for (const controller of controllers) {
    const status = controller.status();
    refreshes += status.refreshes;
    accepted += status.accepted;
    rejected += status.rejected;
    expiries += status.expiries;
    fallbackMs += status.fallbackMs;
    invalidMs += status.invalidMs;
    adaptiveTicks += status.adaptiveTicks;
    heldMs += status.heldMs;
    policyMs += status.liveMs + status.replayMs;
    adapters.add(provenanceLabel(controller.meta().adapter));
    if (status.lastRejection !== null) {
      errors.add(`${status.lastRejection.kind}: ${status.lastRejection.detail}`);
    }
    if (status.start?.state === "unable") {
      stopped.push(`a run could not start (${status.start.reason})`);
    }
    if (status.invalidation !== null) {
      stopped.push(
        `a run was INVALIDATED at ${(status.invalidation.atSimMs / 1000).toFixed(1)}s ` +
          `(${status.invalidation.reason}): not a completed Jev result`,
      );
    }
  }
  const lines = [
    `jev adapter [${[...adapters].join(", ")}]: ` +
      `${refreshes} policy refreshes, ` +
      `${accepted} accepted, ${rejected} rejected, ${expiries} expired`,
    `  governed simulated time: ${(policyMs / 1000).toFixed(1)}s by Jev policy` +
      `${heldMs > 0 ? ` (${(heldMs / 1000).toFixed(1)}s of it HELD past the refresh window)` : ""}, ` +
      `${((invalidMs + fallbackMs) / 1000).toFixed(1)}s ungoverned, ` +
      `${adaptiveTicks} Adaptive decision ticks`,
  ];
  if (stopped.length > 0) {
    lines.push(`  ${stopped.join(" | ")}`);
  }
  if (errors.size > 0) {
    lines.push(`  adapter errors: ${[...errors].join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * The live path: the same runs as the matrix, driven with a yield between ticks
 * so an asynchronous policy can land mid-run. Baseline controllers still go
 * through the synchronous path — only jev needs the event loop.
 */
async function runLiveMatrix(
  model: ReturnType<typeof loadBenchmarkModel>,
  matrix: BenchmarkMatrix,
  controllers: ScenarioRunOptions["controllers"],
  onRun: (progress: RunProgress) => void,
  options: {
    readonly describeController: ControllerDescriber["describeController"];
    readonly paceRatio: number;
  },
): Promise<BenchmarkRunRecord[]> {
  const scenarios = expandMatrix(matrix);
  const total = scenarios.length * matrix.controllers.length;
  const records: BenchmarkRunRecord[] = [];
  let index = 0;
  for (const scenario of scenarios) {
    for (const controller of matrix.controllers) {
      const record =
        controller === "jev"
          ? await runLiveScenario(model, scenario, controller, {
              controllers,
              describeController: options.describeController,
              paceRatio: options.paceRatio,
            })
          : runBenchmarkScenario(model, scenario, [controller], {
              controllers,
              describeController: options.describeController,
            })[0];
      records.push(record);
      index += 1;
      onRun({ index, total, scenario, controller });
    }
  }
  return records;
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${message}\n`);
    // `--help` travels as a UsageError carrying the usage text: print it, exit 0.
    return error instanceof UsageError && message === USAGE ? 0 : 2;
  }

  const matrix = withOverrides(DEFAULT_BENCHMARK_MATRIX, options.overrides);
  const scenarios = expandMatrix(matrix);
  if (scenarios.length === 0) {
    process.stderr.write("the matrix is empty — nothing to run\n");
    return 2;
  }

  const wantsJev = matrix.controllers.includes("jev");
  const replaying = wantsJev && options.jevAdapter === "replay";
  const live = wantsJev && !replaying && options.jevAdapter !== "mock";

  let replayTrace: JevTrace | null = null;
  if (replaying) {
    if (options.tracePath === null) {
      process.stderr.write("--jev replay needs --trace <path>\n");
      return 2;
    }
    if (options.traceOutPath !== null) {
      process.stderr.write("--trace-out has nothing to add when replaying a trace\n");
      return 2;
    }
    try {
      replayTrace = loadTrace(options.tracePath);
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    // Every scenario in the matrix must match the trace's fingerprint, or the
    // replay would silently run the wrong run's policies.
    for (const scenario of scenarios) {
      const fingerprint = scenarioFingerprint(
        buildChallengeScenario({
          tripId: scenario.tripId,
          trafficLevel: scenario.trafficLevel,
          driver: scenario.driver,
          seed: scenario.seed,
          durationMs: scenario.durationMs,
        }),
      );
      if (fingerprint !== replayTrace.scenarioFingerprint) {
        process.stderr.write(
          `the trace was recorded for scenario ${replayTrace.scenarioFingerprint}, ` +
            `but ${scenario.tripId}/${scenario.trafficLevel}/${scenario.driver}/seed ` +
            `${scenario.seed} is ${fingerprint} — replay refused\n`,
        );
        return 2;
      }
    }
  }

  let jevClient: JevClient | null = null;
  if (wantsJev && live) {
    const configured = liveJevClientFromEnv(options.jevAdapter === "gateway" ? "gateway" : "live");
    if ("error" in configured) {
      process.stderr.write(`${configured.error}\n`);
      return 2;
    }
    jevClient = configured.client;
    const capError = liveRunCapError(scenarios.length * matrix.controllers.length);
    if (capError !== null) {
      process.stderr.write(`${capError}\n`);
      return 2;
    }
  } else if (wantsJev && !replaying) {
    jevClient = createMockJevClient();
  }

  // One controller per run, kept so the adapter's own account can be reported.
  const jevControllers: JevController[] = [];
  let currentJev: JevController | null = null;
  const controllerFactories: ScenarioRunOptions["controllers"] = wantsJev
    ? {
        jev: (context) => {
          const controller = replaying
            ? createJevController({
                client: null,
                mode: "replay",
                trace: replayTrace,
                scenarioFingerprint: context.fingerprint,
              })
            : createJevController({
                client: jevClient,
                scenarioFingerprint: context.fingerprint,
                // A LIVE run spends a real, measured allowance: the gate is what
                // keeps it inside the upstream budget instead of asking 24 times
                // a minute at a service that grants about 5. A deterministic
                // run (mock, replay) wires none, so its results are unchanged.
                //
                // The SESSION's gate, shared by every run in this invocation:
                // the allowance belongs to the credential, so a per-run gate
                // would let run 2 ask as if run 1 had spent nothing — the 429s
                // this exists to prevent. Each run still reports its own
                // requests (jev/scheduler.ts `serviceStatusSince`).
                serviceGate: live ? sessionJevServiceGate() : null,
              });
          jevControllers.push(controller);
          currentJev = controller;
          return controller;
        },
      }
    : {};
  const describeController: ControllerDescriber["describeController"] = (choice) =>
    choice === "jev" && currentJev !== null
      ? jevProvenance(currentJev.meta(), replayTrace)
      : undefined;

  const startedAt = Date.now();
  const model = loadBenchmarkModel();
  process.stdout.write(`benchmark: ${describeMatrix(matrix)}\n`);
  if (wantsJev) {
    process.stdout.write(`${adapterBanner(options, replayTrace)}\n`);
  }
  process.stdout.write(
    `city: ${model.city.roads.length} roads, ${model.city.intersections.length} intersections\n`,
  );

  const report = (progress: RunProgress): void => {
    if (options.quiet) {
      return;
    }
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const source = progress.controller === "jev" ? ` [${jevLabel(options)}]` : "";
    process.stdout.write(
      `[${String(progress.index).padStart(3)}/${progress.total}] ` +
        `${progress.scenario.tripId} ${progress.scenario.trafficLevel} ` +
        `seed=${progress.scenario.seed} ${progress.scenario.driver} ${progress.controller}${source} ` +
        `(${elapsed}s)\n`,
    );
  };

  const runs = live
    ? await runLiveMatrix(model, matrix, controllerFactories, report, {
        describeController,
        paceRatio: options.paceRatio,
      })
    : runBenchmarkMatrix(model, matrix, {
        controllers: controllerFactories,
        onRun: report,
        describeController,
      });

  const output = buildDocument(matrix, runs, options.jevAdapter);

  const outPath = options.outPath ?? "benchmark/results/benchmark.json";
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(path.resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);

  if (options.traceOutPath !== null) {
    if (jevControllers.length !== 1) {
      process.stderr.write(
        `--trace-out records a single run's trace; this matrix ran ${jevControllers.length}\n`,
      );
      return 2;
    }
    const tracePath = path.resolve(options.traceOutPath);
    mkdirSync(path.dirname(tracePath), { recursive: true });
    const controller = jevControllers[0];
    const meta = controller.meta();
    // The recorded run's own history travels WITH the trace: without it a replay
    // would present the original's refusals and ungoverned time as a clean run.
    writeFileSync(
      tracePath,
      serializeTrace({
        ...controller.trace(),
        recorded: {
          adapter: meta.adapter,
          accepted: meta.accepted,
          rejected: meta.rejected,
          refreshes: meta.refreshes,
          expiries: meta.expiries,
          liveMs: meta.liveMs,
          fallbackMs: meta.fallbackMs,
        },
      }),
    );
  }

  process.stdout.write(`\n${formatSummary(output.groups)}\n`);
  if (wantsJev) {
    const provenance = jevControllers.length > 0 ? jevProvenance(jevControllers[0].meta(), replayTrace) : null;
    if (provenance !== null) {
      process.stdout.write(`\nprovenance: ${provenanceLine(provenance)}\n`);
    }
    process.stdout.write(`\n${describeJevStatus(jevControllers)}\n`);
    if (options.traceOutPath !== null) {
      process.stdout.write(
        `  trace: ${jevControllers[0].trace().events.length} accepted policies written to ` +
          `${path.resolve(options.traceOutPath)}\n`,
      );
    }
  }
  process.stdout.write(
    `\n${runs.length} runs, ${output.groups.length} compatible groups, ` +
      `${((Date.now() - startedAt) / 1000).toFixed(0)}s wall time\n` +
      `wrote ${path.resolve(outPath)}` +
      (wantsJev ? `  [${jevLabel(options)}]` : "") +
      "\n",
  );
  return 0;
}

/**
 * Run when executed (`pnpm benchmark`), stay silent when imported by a test.
 * `require` only exists under the CLI runner, so this guard is safe in ESM too.
 */
if (typeof require !== "undefined" && require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
