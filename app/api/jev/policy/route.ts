/**
 * Jev server boundary (Issue #13).
 *
 * The browser (or its worker) posts a Jev policy request here; this route — and
 * only this route — holds the service credential and talks to Jev. That is what
 * keeps the secret out of the client bundle, out of the worker payload, out of
 * browser state and out of logs:
 *
 *   - the credential comes from Vercel's request-scoped OIDC token for AI
 *     Gateway, or JEV_TOKEN for a separately hosted/local service;
 *   - the token travels in an Authorization header, never in a body, a URL or a
 *     message we log;
 *   - failure responses carry a status and a short message, never the service's
 *     own words, because an upstream error body can echo credentials back;
 *   - the request is validated here before anything is forwarded, and the
 *     response is validated and bounded before it is handed back.
 *
 * When the environment is not configured the route says so (503) and returns no
 * policy. It never fabricates one, and it never falls back to a replay or a
 * cached answer — that is Issue #14's territory.
 *
 * A failure upstream is reported to the caller as one short sentence and to the
 * operator as ONE bounded reason (an HTTP status, a timeout, or "unexpected
 * failure"). Nothing else is ever logged: an upstream body can echo credentials
 * back, and a free-form error message can carry anything, so neither is allowed
 * near the log. `failureReason` is the single place that decides what a log line
 * may say, which is what makes the rule testable.
 *
 * The same bounded class rides out to the caller in `x-jev-reason` (and, on a
 * successful answer, the counts of what the answer cost in `x-jev-clamped` /
 * `x-jev-dropped`). That is deliberate: the run can then say WHY it fell back —
 * a timeout, a rate limit, an upstream error — instead of reverting to the
 * safety net in silence. Response BODIES are unchanged: a status and one short
 * sentence, never the service's words.
 *
 * ## What guards this route, and what each guard is worth (Issue #37)
 *
 * | guard | scope | guarantee |
 * |---|---|---|
 * | platform rate limit (Vercel Firewall) | deployment-wide | real, when a rule exists — configured by id, see below |
 * | first-party check | per request | a browser on another site cannot use our quota |
 * | in-memory budget | ONE serverless instance | bounds a runaway caller on that instance; it is NOT a global limit |
 * | strict schema + body ceiling | per request | zero upstream calls for anything malformed |
 * | bounded question set | by construction | the route can never become a general model proxy |
 *
 * The in-memory counter is the last guard, not the wall: serverless instances
 * are created and destroyed on demand, so a caller spread across many of them
 * gets a budget per instance. The deployment-wide control is the platform's own
 * (`JEV_RATE_LIMIT_ID` → `@vercel/firewall`), which is inert until a matching
 * rate-limit rule is created in the Vercel Firewall — that step is a dashboard
 * action, and it is the one thing this repository cannot do for itself.
 */
import { unstable_checkRateLimit as checkRateLimit } from "@vercel/firewall";
import { getVercelOidcTokenSync } from "@vercel/oidc";
import {
  createHttpJevClient,
  JEV_CLAMPED_HEADER,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_DROPPED_HEADER,
  JEV_REASON_HEADER,
  JEV_RETRY_AFTER_HEADER,
  clientRetryAfterMs,
  type JevClient,
  type JevClientFailure,
} from "@/jev/client";
import { JEV_GATEWAY_TIMEOUT_MS } from "@/jev/gateway";
import { createGatewayJevClient, JEV_GATEWAY_ENDPOINT } from "@/jev/gateway";
import { jevPolicyContext } from "@/jev/request";
import { JEV_LIMITS, parseJevPolicy, validateJevPolicyRequest } from "@/jev/schema";
import { callerIdentity } from "./caller";

/**
 * Ceiling for one request body. The size was measured against the production
 * generator (see JEV_LIMITS.REQUEST_BODY_BYTES): a legitimate maximum is 18.3 KB,
 * and the schema caps the entry lists independently, so this cannot reject a
 * request the app can actually build.
 */
const MAX_BODY_BYTES = JEV_LIMITS.REQUEST_BODY_BYTES;

/**
 * Instance-local abuse budget (Issue #15, corrected in Issue #37).
 *
 * HONEST SCOPE: this counter lives in one serverless instance's memory. It
 * bounds a runaway caller that keeps hitting the same instance; it does NOT
 * bound a caller spread across instances, and it must never be described as the
 * endpoint's global limit. The deployment-wide control is the platform's own
 * rate limiter (see `platformRateLimited`), and the durable bound on cost is the
 * contract: only the Jev question set is ever forwarded (see jev/gateway.ts), so
 * this route cannot become a general completion endpoint whatever the caller
 * sends.
 *
 * The key comes from `callerIdentity` — the platform's client address, never a
 * caller-supplied header. A caller that trips this budget gets 429, the runtime
 * falls back to Adaptive, and the run continues; nothing is retried or queued
 * server-side.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 180;
/** Hard cap on tracked callers, so the counter cannot grow without bound. */
const RATE_LIMIT_MAX_KEYS = 4_096;

interface RateWindow {
  count: number;
  resetAtMs: number;
}

const rateWindows = new Map<string, RateWindow>();

/**
 * The deployment-wide limiter: Vercel's own Firewall rate limiting.
 *
 * `checkRateLimit` matches a rule defined in the Firewall by id, and keys it on
 * the same client address this route uses. Set `JEV_RATE_LIMIT_ID` to turn it
 * on; with no rule configured the platform answers "not-found", which is
 * reported once per process and then treated as "not configured" rather than as
 * a block. The limit itself is counted by the platform, not by us, so it holds
 * across every instance of this deployment.
 */
const rateLimitId = process.env.JEV_RATE_LIMIT_ID?.trim();

let warnedMissingRule = false;

/** True when the platform says this request is over its rule's budget. */
async function platformRateLimited(request: Request, key: string): Promise<boolean> {
  if (rateLimitId === undefined || rateLimitId === "" || process.env.NODE_ENV !== "production") {
    return false;
  }
  try {
    const { rateLimited, error } = await checkRateLimit(rateLimitId, { request, rateLimitKey: key });
    if (error === "not-found" && !warnedMissingRule) {
      warnedMissingRule = true;
      console.error(
        "[jev-relay] no Vercel Firewall rate-limit rule matches JEV_RATE_LIMIT_ID; only the per-instance budget is active",
      );
    }
    return rateLimited || error === "blocked";
  } catch {
    // Availability wins over an optional extra guard: the request continues to
    // the instance-local budget rather than failing because the platform call did.
    return false;
  }
}

/**
 * True when the caller may spend one request here. Fixed window, per instance.
 */
export function allowRequest(key: string, nowMs: number): boolean {
  for (const [existing, window] of rateWindows) {
    if (window.resetAtMs <= nowMs) {
      rateWindows.delete(existing);
    }
  }
  const window = rateWindows.get(key);
  if (window === undefined) {
    if (rateWindows.size >= RATE_LIMIT_MAX_KEYS) {
      return false;
    }
    rateWindows.set(key, { count: 1, resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (window.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  window.count += 1;
  return true;
}

/**
 * First-party only, when the request says where it came from.
 *
 * Browsers attach provenance to a cross-site POST, and this route is for our own
 * worker: an `Origin` that is not us is refused, and a `Sec-Fetch-Site` that
 * says another site is refused even without an Origin. A request with neither
 * (a script, a health check, the deployed smoke) is allowed through to the rate
 * limit — refusing it would only break legitimate server-side callers, since
 * headers are trivially forged anyway.
 */
export function firstParty(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "" && origin !== "null") {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return false;
  }
  return true;
}

export interface JevEnvironment {
  readonly token: string;
  readonly timeoutMs: number;
  /** Set when this deployment talks to the Vercel AI Gateway. */
  readonly gateway: {
    readonly endpoint: string;
    readonly model: string;
    /** Minimum usable answer confidence; undefined = the adapter's default. */
    readonly minConfidence: number | undefined;
  } | null;
  /** Set when this deployment talks to a service speaking the policy schema. */
  readonly endpoint: string | null;
}

/**
 * Two supported backends, chosen by configuration alone:
 *
 *   JEV_MODEL set    -> TypeSafe AI's evaluation model through the Vercel AI
 *                       Gateway (its own URL; JEV_GATEWAY_URL overrides it for a
 *                       self-hosted proxy). One model, no fallbacks.
 *   JEV_ENDPOINT set -> a service that speaks the Jev policy schema directly
 *
 * The two are never mixed: JEV_MODEL selects the gateway and JEV_ENDPOINT is
 * ignored for it, so a deployment cannot accidentally send gateway-shaped
 * questions to a schema-speaking service. Only the configured backend is ever
 * called, and without a token there is no client at all — the route answers 503
 * rather than inventing a policy.
 */
/** One named, optional confidence floor; the adapter owns the default. */
function readMinConfidence(): number | undefined {
  const raw = process.env.JEV_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** The only error messages this route will ever log: status codes, a timeout. */
const REPORTABLE_STATUS = /^jev (gateway|service|relay) responded \d{3}$/;
/** The clients' own bounded sentences for a deadline or a missing connection. */
const REPORTABLE_TRANSPORT = /^jev (gateway|service|relay) (request timed out|unreachable)$/;

/**
 * A bounded description of a failed policy request: safe to log, useless to an
 * attacker. Anything not recognised becomes "unexpected failure" rather than
 * trusting an error message to be harmless.
 */
export function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    if (REPORTABLE_STATUS.test(error.message)) {
      return error.message;
    }
    if (REPORTABLE_TRANSPORT.test(error.message)) {
      return error.message.endsWith("unreachable") ? "unreachable" : "timeout";
    }
  }
  return "unexpected failure";
}

/**
 * The bounded CLASS of a failure, for the response header. Same vocabulary the
 * browser client uses (`JevClientFailure`), so the run can report WHY it fell
 * back without the relay's body ever carrying upstream text.
 */
export function failureClass(error: unknown): JevClientFailure {
  const reason = failureReason(error);
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "unreachable") {
    return "unreachable";
  }
  const status = Number(/responded (\d{3})/.exec(reason)?.[1] ?? Number.NaN);
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

/**
 * A refusal, with its bounded class in a header.
 *
 * The BODY is unchanged on purpose (one short sentence, no upstream words — the
 * pinned contract), and the class travels beside it in `x-jev-reason`, which is
 * what lets the browser say "the model did not answer in time" instead of a
 * generic failure. Both channels are this codebase's own closed vocabulary.
 *
 * When the service named a pause, its LENGTH travels too, as a number in
 * `x-jev-retry-after-ms`. Without it the browser can only guess how long to
 * wait, retries into the same closed window and collects a second 429 — which is
 * how a burst of retries turns one rate limit into four. No upstream string
 * crosses this line: the header is an integer this codebase parsed and bounded.
 */
function refusal(
  status: number,
  error: string,
  failure: JevClientFailure,
  retryAfterMs: number | null = null,
): Response {
  const headers: Record<string, string> = { [JEV_REASON_HEADER]: failure };
  if (retryAfterMs !== null) {
    headers[JEV_RETRY_AFTER_HEADER] = String(retryAfterMs);
  }
  return Response.json({ error }, { status, headers });
}

export function readJevEnvironment(gatewayOidcToken?: string): JevEnvironment | null {
  const configuredToken = process.env.JEV_TOKEN?.trim();
  // JEV_TIMEOUT_MS overrides both transports when an operator sets it. WITHOUT
  // it each transport gets its own honest default: a live model call through the
  // gateway takes seconds, a direct HTTP relay answers in milliseconds. The
  // generic 4 s default used to be resolved here and then passed into the
  // gateway client, where the transport's own 15 s default could never apply -
  // so slow-but-healthy calls were recorded as `timeout` fallbacks (issue #57).
  const configured = Number(process.env.JEV_TIMEOUT_MS);
  const overrideMs = Number.isFinite(configured) && configured > 0 ? configured : null;

  const model = process.env.JEV_MODEL?.trim();
  if (model) {
    const token = gatewayOidcToken?.trim() || configuredToken;
    if (!token) return null;
    return {
      token,
      timeoutMs: overrideMs ?? JEV_GATEWAY_TIMEOUT_MS,
      gateway: {
        endpoint: process.env.JEV_GATEWAY_URL?.trim() || JEV_GATEWAY_ENDPOINT,
        model,
        minConfidence: readMinConfidence(),
      },
      endpoint: null,
    };
  }

  if (!configuredToken) return null;
  const endpoint = process.env.JEV_ENDPOINT?.trim();
  if (!endpoint) {
    return null;
  }
  return { token: configuredToken, timeoutMs: overrideMs ?? JEV_DEFAULT_TIMEOUT_MS, gateway: null, endpoint };
}

/** The one place a client is built from configuration. */
export function jevClientFromEnvironment(environment: JevEnvironment): JevClient {
  if (environment.gateway) {
    return createGatewayJevClient({
      token: environment.token,
      endpoint: environment.gateway.endpoint,
      model: environment.gateway.model,
      timeoutMs: environment.timeoutMs,
      minConfidence: environment.gateway.minConfidence,
    });
  }
  return createHttpJevClient({
    endpoint: environment.endpoint ?? "",
    token: environment.token,
    timeoutMs: environment.timeoutMs,
  });
}

export async function POST(request: Request): Promise<Response> {
  // In Functions the platform rotates this token on each request and exposes it
  // through request context, not a stable process.env value. The official helper
  // reads that context; a missing token leaves the explicit local key usable.
  let gatewayOidcToken: string | undefined;
  if (process.env.JEV_MODEL?.trim()) {
    try {
      gatewayOidcToken = getVercelOidcTokenSync();
    } catch {
      // Local/non-Vercel runs may intentionally use JEV_TOKEN instead.
    }
  }
  const environment = readJevEnvironment(gatewayOidcToken);
  if (environment === null) {
    return refusal(503, "jev is not configured", "not-configured");
  }

  if (!firstParty(request)) {
    return refusal(403, "cross-origin requests are not allowed", "rejected");
  }

  // Identity comes from the platform (see caller.ts), never from the caller's
  // own forwarding headers, and is never echoed back in a response.
  const key = callerIdentity(request);
  if (await platformRateLimited(request, key)) {
    return refusal(429, "too many policy requests", "rate-limited");
  }
  if (!allowRequest(key, Date.now())) {
    return refusal(429, "too many policy requests", "rate-limited");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return refusal(413, "request body is too large", "rejected");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return refusal(400, "request body could not be read", "rejected");
  }
  // The declared length is a claim; this is the actual size.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return refusal(413, "request body is too large", "rejected");
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return refusal(400, "request body must be JSON", "rejected");
  }

  const validated = validateJevPolicyRequest(body);
  if (!validated.ok) {
    return refusal(400, validated.error, "rejected");
  }

  const client = jevClientFromEnvironment(environment);
  try {
    const raw = await client.requestPolicy(validated.value);
    const parsed = parseJevPolicy(raw, jevPolicyContext(validated.value));
    if (!parsed.ok) {
      return refusal(502, parsed.error, "malformed");
    }
    // What this answer cost, in counts only: a policy that had to be clamped is
    // applied and reported as imperfect rather than hidden.
    const notes = client.answerNotes?.() ?? null;
    return Response.json(
      { policy: parsed.value.policy, clamped: parsed.value.clamped },
      {
        headers: {
          [JEV_CLAMPED_HEADER]: String(parsed.value.clamped.length),
          [JEV_DROPPED_HEADER]: String(notes?.dropped ?? 0),
        },
      },
    );
  } catch (error) {
    // Bounded by construction: a status or the word "timeout", never a body.
    console.error("[jev-relay] policy request failed:", failureReason(error));
    return refusal(502, "jev service request failed", failureClass(error), clientRetryAfterMs(error));
  }
}
