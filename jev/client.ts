/**
 * The Jev client seam (Issue #13): one narrow interface, three implementations,
 * and no knowledge of any SDK.
 *
 *   JevClient             request in, raw response out. The adapter validates
 *                         whatever comes back; a client never decides policy.
 *   createMockJevClient   deterministic, in-process, no network. Used by tests
 *                         and by benchmark runs so a Jev run is reproducible.
 *   createHttpJevClient   the SERVER-side client. It takes its endpoint and
 *                         bearer token as arguments — it never reads the
 *                         environment itself — so only server code ever holds a
 *                         credential (see app/api/jev/policy/route.ts and the
 *                         benchmark CLI, both of which read env).
 *   createRelayJevClient  the BROWSER-side client. It talks to our own route and
 *                         carries no credential of any kind, which is why the
 *                         client bundle, the worker payload and browser state
 *                         can hold none: there is none to hold.
 *
 * A client may answer synchronously (the mock does) or with a promise (both
 * HTTP paths do). The controller applies a synchronous answer immediately and
 * an asynchronous one when it arrives; it never blocks a tick on the network.
 *
 * ## Failure and imperfection are REPORTED, never guessed at
 *
 * A transport failure is classified into a bounded vocabulary
 * (`JevClientFailure`) from the HTTP status and one bounded response header the
 * relay sets. A client never throws upstream text and never invents a policy:
 * the classes exist so the run can say WHY it fell back instead of logging a
 * status nobody reads. `JevAnswerNotes` is the other half — what one answer
 * COST (values clamped, answers dropped by the confidence floor) — which is how
 * a policy that is applied but imperfect becomes visible instead of silent.
 */
import type { JevPolicyRequest } from "./schema";

/** The header names the relay and its browser client agree on. One definition. */
export const JEV_REASON_HEADER = "x-jev-reason";
export const JEV_CLAMPED_HEADER = "x-jev-clamped";
export const JEV_DROPPED_HEADER = "x-jev-dropped";
/**
 * How long the service asked the caller to wait, in wall MILLISECONDS. The relay
 * forwards the upstream `retry-after` under this name (see
 * app/api/jev/policy/route.ts) because the browser path never sees an upstream
 * header: without it the app would retry into the same closed window and collect
 * a second 429 instead of waiting the pause it was given. Milliseconds, not
 * seconds, so the unit cannot be misread.
 */
export const JEV_RETRY_AFTER_HEADER = "x-jev-retry-after-ms";

/**
 * How a policy request failed, in the smallest vocabulary that can be reported
 * honestly. Every member is a fact about the TRANSPORT, never an opinion about
 * the model, and every one of them is safe to show a user.
 */
export const JEV_CLIENT_FAILURES = [
  /** The request's own deadline passed before an answer arrived. */
  "timeout",
  /** 429, ours or the gateway's. */
  "rate-limited",
  /** 5xx from the service or the gateway. */
  "upstream-error",
  /** 4xx: the service refused the request itself. */
  "rejected",
  /** The request never arrived (network failure, aborted connection). */
  "unreachable",
  /** The relay holds no credential, so there was nothing to ask with. */
  "not-configured",
  /** An answer arrived and could not be used as a policy. */
  "malformed",
  /** A failure the bounded classifier does not recognise. */
  "unknown",
] as const;

export type JevClientFailure = (typeof JEV_CLIENT_FAILURES)[number];

/** True when the value is one of the bounded failure classes. */
export function isJevClientFailure(value: unknown): value is JevClientFailure {
  return typeof value === "string" && (JEV_CLIENT_FAILURES as readonly string[]).includes(value);
}

/**
 * A transport failure, carrying its bounded class. The message is always this
 * module's own text (or the relay's own short sentence), never an upstream
 * body, so it is safe to count and to keep in a rejection record.
 *
 * `retryAfterMs` is the one piece of upstream rate-limit metadata worth keeping:
 * a NUMBER, bounded, and the only thing that lets a caller wait the pause the
 * service actually asked for instead of guessing (see jev/scheduler.ts). It is
 * null whenever the service did not say, and it is never a string from the wire.
 */
export class JevClientError extends Error {
  readonly failure: JevClientFailure;
  readonly retryAfterMs: number | null;
  constructor(failure: JevClientFailure, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "JevClientError";
    this.failure = failure;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The pause a service asked for, in wall ms, from the headers it can say it in:
 * the standard `retry-after` (delta-seconds; an HTTP-date is not a duration and
 * is ignored rather than guessed at), then this codebase's own
 * `x-jev-retry-after-ms` on the relay path, then the gateway's
 * `x-ratelimit-reset-requests` (a `40s`-shaped value). Anything absent, junk,
 * negative or longer than ten minutes is null: a bound the scheduler then
 * replaces with its own cadence.
 */
export function retryAfterMsFromHeaders(headers: Headers): number | null {
  const seconds = Number(headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return boundedRetryAfter(seconds * 1_000);
  }
  const millis = Number(headers.get(JEV_RETRY_AFTER_HEADER));
  if (Number.isFinite(millis) && millis > 0) {
    return boundedRetryAfter(millis);
  }
  const reset = /^(\d+)\s*s?$/.exec(headers.get("x-ratelimit-reset-requests") ?? "");
  if (reset !== null) {
    return boundedRetryAfter(Number(reset[1]) * 1_000);
  }
  return null;
}

/** Ten minutes: longer than any pause worth waiting for inside one run. */
const MAX_RETRY_AFTER_MS = 600_000;

function boundedRetryAfter(valueMs: number): number | null {
  if (!Number.isFinite(valueMs) || valueMs <= 0) {
    return null;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(valueMs));
}

/** The pause a thrown client failure asked for, or null. Safe on any error. */
export function clientRetryAfterMs(error: unknown): number | null {
  return error instanceof JevClientError ? error.retryAfterMs : null;
}

/** What one answer cost, in counts only: never upstream text, never a policy. */
export interface JevAnswerNotes {
  /** Values the adapter had to clamp to their bounds. */
  readonly clamped: number;
  /** Answers the confidence floor dropped, so they carried no opinion. */
  readonly dropped: number;
}

/**
 * The bounded class of an HTTP status, refined by the relay's own reason header
 * when it is present (the relay distinguishes a timeout from a 5xx inside one
 * 502, which the status alone cannot).
 */
export function failureFromStatus(status: number, reasonHeader: string | null): JevClientFailure {
  if (isJevClientFailure(reasonHeader)) {
    return reasonHeader;
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500) {
    return "upstream-error";
  }
  if (status >= 400) {
    return "rejected";
  }
  return "unknown";
}

/** The bounded class of a thrown transport error (an abort is a timeout). */
export function failureFromError(error: unknown): JevClientFailure {
  if (error instanceof JevClientError) {
    return error.failure;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "unreachable";
}

/** A bounded non-negative count from a header, or null when it is absent/junk. */
function countHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface JevClient {
  /** Stable id for logs and run metadata: "mock" | "http" | "relay". */
  readonly id: string;
  /**
   * Ask for a policy. The response is UNVALIDATED by design — the adapter owns
   * validation and bounds, so a client can be as dumb as possible.
   */
  requestPolicy(request: JevPolicyRequest): unknown | Promise<unknown>;
  /**
   * What the MOST RECENT answer cost, or null when this client reports nothing.
   * Optional because a deterministic stand-in has nothing to report. One
   * mutable field read once per answer, the same exception the controller makes
   * for its most recent policy — and it is unambiguous because the runtime
   * keeps exactly one request in flight.
   */
  answerNotes?(): JevAnswerNotes | null;
}

/**
 * Deterministic stand-in for the service, for tests and benchmark runs.
 *
 * Its default answer is a pure function of the request: it leans on the busiest
 * corridor and region it was shown and holds greens slightly longer. That
 * exercises every part of the seam — id validation, bounded weights, hint
 * translation — without pretending to be Jev's judgement. `id` is "mock" and
 * callers are expected to say so out loud.
 */
export interface MockJevClientOptions {
  /** Override the answer. Must stay deterministic. */
  readonly respond?: (request: JevPolicyRequest) => unknown;
}

export function createMockJevClient(options: MockJevClientOptions = {}): JevClient {
  const respond = options.respond ?? defaultMockResponse;
  return {
    id: "mock",
    requestPolicy: (request) => respond(request),
  };
}

/** The default mock answer: busy corridor/region weighted, greens held longer. */
function defaultMockResponse(request: JevPolicyRequest): unknown {
  const busiestCorridor = request.corridors
    .filter((corridor) => corridor.queuedVehicles > 0 || corridor.maxWaitMs > 0)
    .sort((a, b) => b.queuedVehicles - a.queuedVehicles || a.corridorId - b.corridorId)[0];
  const busiestRegion = request.regions
    .filter((region) => region.queuedVehicles > 0 || region.maxWaitMs > 0)
    .sort((a, b) => b.queuedVehicles - a.queuedVehicles || a.regionId - b.regionId)[0];
  return {
    schemaVersion: request.schemaVersion,
    pressureScale: 1.1,
    hint: "hold-longer",
    corridorWeights: busiestCorridor ? [{ id: busiestCorridor.corridorId, weight: 1.5 }] : [],
    regionWeights: busiestRegion ? [{ id: busiestRegion.regionId, weight: 1.25 }] : [],
  };
}

export interface HttpJevClientOptions {
  /** Service endpoint, e.g. https://jev.example.com/policy. */
  readonly endpoint: string;
  /** Bearer token. SERVER-SIDE ONLY — never pass a browser-reachable value. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const JEV_DEFAULT_TIMEOUT_MS = 4_000;

/**
 * The browser's budget for asking OUR relay route, which then calls the model
 * gateway. It must exceed the server's own gateway budget (15 s) or the browser
 * aborts a request the server is still working on and records a fallback the
 * deployment never actually needed - measured: aborted at 4 004 ms against a
 * healthy call (issue #57).
 */
export const JEV_RELAY_TIMEOUT_MS = 20_000;

/**
 * Server-side HTTP client. Callers pass credentials in; this module never reads
 * process.env, and the token is only ever placed in the Authorization header —
 * never in the body, a URL, a log line or an error message.
 */
export function createHttpJevClient(options: HttpJevClientOptions): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createHttpJevClient needs a fetch implementation");
  }
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  let notes: JevAnswerNotes | null = null;
  return {
    id: "http",
    answerNotes: () => notes,
    requestPolicy: async (request) => {
      notes = null;
      let response: Response;
      try {
        response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${options.token}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // An abort is a timeout; anything else never arrived. The message stays
        // this module's own text so it can be counted and kept.
        const failure = failureFromError(error);
        throw new JevClientError(
          failure,
          failure === "timeout" ? "jev service request timed out" : "jev service unreachable",
        );
      }
      if (!response.ok) {
        // Status only: response bodies can echo credentials back. The bounded
        // pause the service asked for travels with the class, so a caller can
        // wait it instead of retrying into the same closed window.
        throw new JevClientError(
          failureFromStatus(response.status, response.headers.get(JEV_REASON_HEADER)),
          `jev service responded ${response.status}`,
          retryAfterMsFromHeaders(response.headers),
        );
      }
      const body = (await response.json()) as unknown;
      notes = notesOf(response.headers, body);
      return body;
    },
  };
}

/**
 * What one answer cost, from the bounded counts the relay reports. Header first
 * (it survives any body shape), then the documented body fields; anything
 * absent or malformed counts as nothing rather than as a guess.
 */
function notesOf(headers: Headers, body: unknown): JevAnswerNotes {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const clampedFromBody = Array.isArray(record.clamped) ? record.clamped.length : 0;
  const droppedFromBody =
    typeof record.dropped === "number" && Number.isSafeInteger(record.dropped) && record.dropped >= 0
      ? record.dropped
      : 0;
  return {
    clamped: countHeader(headers, JEV_CLAMPED_HEADER) ?? clampedFromBody,
    dropped: countHeader(headers, JEV_DROPPED_HEADER) ?? droppedFromBody,
  };
}

export interface RelayJevClientOptions {
  /** Same-origin route that holds the credential. */
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const JEV_RELAY_PATH = "/api/jev/policy";

/**
 * Browser-side client: it asks OUR route, which holds the credential. No token
 * is read, stored or sent here, so nothing about this path can leak one.
 */
export function createRelayJevClient(options: RelayJevClientOptions = {}): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createRelayJevClient needs a fetch implementation");
  }
  const url = options.url ?? JEV_RELAY_PATH;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  let notes: JevAnswerNotes | null = null;
  return {
    id: "relay",
    answerNotes: () => notes,
    requestPolicy: async (request) => {
      notes = null;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The browser's own deadline, or a request that never arrived: the run
        // must be able to say which, so the class travels with the error.
        const failure = failureFromError(error);
        throw new JevClientError(
          failure,
          failure === "timeout" ? "jev relay request timed out" : "jev relay unreachable",
        );
      }
      const body = (await response.json().catch(() => null)) as
        | { policy?: unknown; error?: string; clamped?: unknown; dropped?: unknown }
        | null;
      if (!response.ok || body === null || body.policy === undefined) {
        // The relay's own short sentence, plus the bounded class it reported —
        // and the pause it was asked to wait, when the service named one.
        throw new JevClientError(
          failureFromStatus(response.status, response.headers.get(JEV_REASON_HEADER)),
          body?.error ?? `jev relay responded ${response.status}`,
          retryAfterMsFromHeaders(response.headers),
        );
      }
      notes = notesOf(response.headers, body);
      return body.policy;
    },
  };
}
