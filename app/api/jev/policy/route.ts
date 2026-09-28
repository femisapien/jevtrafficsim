/**
 * Jev server boundary (Issue #13).
 *
 * The browser (or its worker) posts a Jev policy request here; this route — and
 * only this route — holds the service credential and talks to Jev. That is what
 * keeps the secret out of the client bundle, out of the worker payload, out of
 * browser state and out of logs:
 *
 *   - the production backend is TypeSafe AI's own API, directly
 *     (`JEV_BACKEND=typesafe` -> POST https://api.typesafe.ai/v1/systemone,
 *     model `jev-latest`), reached with `TYPESAFE_API_KEY` and nothing else.
 *     The older lanes remain selectable but inert unless configured: the Vercel
 *     AI Gateway (the explicitly configured AI Gateway API key whenever one
 *     exists — `AI_GATEWAY_API_KEY` first, then `JEV_TOKEN` — and the
 *     deployment's request-scoped Vercel OIDC token for AI Gateway ONLY as the
 *     fallback when no explicit key is set), and a schema-speaking service
 *     behind `JEV_ENDPOINT`. Exactly one credential is ever used per request,
 *     no credential ever crosses lanes (no Vercel OIDC token, gateway key or
 *     JEV_TOKEN is sent to TypeSafe; the TypeSafe key is never sent to the
 *     gateway), and which LANE it was travels as a name (`authMode`,
 *     `x-jev-auth`), never as a value;
 *   - which BACKEND served the request travels as a name too (`x-jev-backend`,
 *     a closed vocabulary: "typesafe-direct" | "ai-gateway" |
 *     "schema-service"), on successes and refusals alike, so production can
 *     prove the live path without any credential being visible;
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
 * failure") plus the credential LANE it happened on — a name from a closed
 * two-value vocabulary ("api-key" | "oidc"), because "the gateway answered 403"
 * is undiagnosable without knowing which credential asked. Nothing else is ever
 * logged: an upstream body can echo credentials back, and a free-form error
 * message can carry anything, so neither is allowed near the log.
 * `failureReason` is the single place that decides what a log line
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
  JEV_AUTH_HEADER,
  JEV_BACKEND_HEADER,
  JEV_CLAMPED_HEADER,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_DROPPED_HEADER,
  JEV_REASON_HEADER,
  JEV_RETRY_AFTER_HEADER,
  clientRetryAfterMs,
  type JevBackendName,
  type JevClient,
  type JevClientFailure,
} from "@/jev/client";
import { JEV_GATEWAY_TIMEOUT_MS } from "@/jev/gateway";
import { createGatewayJevClient, JEV_GATEWAY_ENDPOINT } from "@/jev/gateway";
import { createTypesafeJevClient, JEV_TYPESAFE_TIMEOUT_MS } from "@/jev/typesafe";
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

/**
 * WHICH credential lane a resolved environment uses, as a name.
 *
 * This is the only thing about the credential that is ever reported anywhere —
 * a closed two-value vocabulary, never a token, a prefix, a length or a hash.
 * It exists because a gateway refusal ("responded 403") is undiagnosable
 * without knowing which credential asked.
 */
export type JevAuthMode = "api-key" | "oidc";

export interface JevEnvironment {
  readonly token: string;
  /** Which lane `token` came from: an explicit key, or the deployment's OIDC. */
  readonly authMode: JevAuthMode;
  readonly timeoutMs: number;
  /**
   * Which backend this configuration selected, as a NAME from the closed
   * vocabulary in jev/client.ts. It rides every response (and every refusal)
   * in `x-jev-backend`, which is how production proves which backend served a
   * request — and how a browser run records it — with no credential visible.
   */
  readonly backend: JevBackendName;
  /** Minimum usable answer confidence for a model lane; undefined = adapter default. */
  readonly minConfidence: number | undefined;
  /** Set when this deployment talks to the Vercel AI Gateway. */
  readonly gateway: {
    readonly endpoint: string;
    readonly model: string;
  } | null;
  /** Set when this deployment talks to a service speaking the policy schema. */
  readonly endpoint: string | null;
}

/**
 * Three supported backends, chosen by configuration alone:
 *
 *   JEV_BACKEND=typesafe -> TypeSafe AI's own API, DIRECTLY: POST
 *                       https://api.typesafe.ai/v1/systemone, model
 *                       `jev-latest`, credential `TYPESAFE_API_KEY`. This is
 *                       the production live path. It outranks the selectors
 *                       below, it reads TYPESAFE_API_KEY and nothing else, and
 *                       no Vercel OIDC token, AI_GATEWAY_API_KEY or JEV_TOKEN
 *                       is ever sent to TypeSafe's endpoint (nor the TypeSafe
 *                       key to the gateway).
 *   JEV_MODEL set    -> TypeSafe AI's evaluation model through the Vercel AI
 *                       Gateway (its own URL; JEV_GATEWAY_URL overrides it for a
 *                       self-hosted proxy). One model, no fallbacks.
 *   JEV_ENDPOINT set -> a service that speaks the Jev policy schema directly
 *
 * The lanes are never mixed: an explicit backend selection outranks the lane
 * selectors, JEV_MODEL selects the gateway and JEV_ENDPOINT is ignored for it,
 * and a JEV_BACKEND value this codebase does not recognise fails CLOSED (503)
 * rather than falling through to whichever lane an older variable still
 * selects. Without a credential for the selected lane there is no client at
 * all — the route answers 503 rather than inventing a policy or switching
 * lanes behind the operator's back.
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
const REPORTABLE_STATUS = /^jev (gateway|typesafe-direct|service|relay) responded \d{3}$/;
/** The clients' own bounded sentences for a deadline or a missing connection. */
const REPORTABLE_TRANSPORT = /^jev (gateway|typesafe-direct|service|relay) (request timed out|unreachable)$/;

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
 *
 * `authMode` rides along as `x-jev-auth` whenever the lane is known: the
 * credential LANE as a name ("api-key" | "oidc"), never any part of the
 * credential itself.
 *
 * `backend` rides along as `x-jev-backend` for the same reason: the backend as
 * a name ("typesafe-direct" | "ai-gateway" | "schema-service"), so a refusal
 * still says which backend refused.
 */
function refusal(
  status: number,
  error: string,
  failure: JevClientFailure,
  retryAfterMs: number | null = null,
  authMode: JevAuthMode | null = null,
  backend: JevBackendName | null = null,
): Response {
  const headers: Record<string, string> = { [JEV_REASON_HEADER]: failure };
  if (authMode !== null) {
    headers[JEV_AUTH_HEADER] = authMode;
  }
  if (backend !== null) {
    headers[JEV_BACKEND_HEADER] = backend;
  }
  if (retryAfterMs !== null) {
    headers[JEV_RETRY_AFTER_HEADER] = String(retryAfterMs);
  }
  return Response.json({ error }, { status, headers });
}

/**
 * The explicitly configured AI Gateway credential, when there is one.
 *
 * The precedence is fixed and deliberate: the standard `AI_GATEWAY_API_KEY`
 * first, then `JEV_TOKEN`, which deployments configured before the standard
 * name existed still hold. Exactly ONE credential is selected here; the two are
 * never combined, and neither is ever combined with the OIDC fallback.
 *
 * This is the credential the GATEWAY lane uses. A schema-speaking service
 * behind JEV_ENDPOINT keeps its own credential (JEV_TOKEN) — an AI Gateway key
 * is not a credential for that service, so it is never sent to one.
 */
export function configuredGatewayApiKey(): string | undefined {
  const standard = process.env.AI_GATEWAY_API_KEY?.trim();
  if (standard !== undefined && standard !== "") {
    return standard;
  }
  const legacy = process.env.JEV_TOKEN?.trim();
  return legacy === undefined || legacy === "" ? undefined : legacy;
}

export function readJevEnvironment(gatewayOidcToken?: string): JevEnvironment | null {
  const configuredToken = process.env.JEV_TOKEN?.trim();
  // JEV_TIMEOUT_MS overrides every transport when an operator sets it. WITHOUT
  // it each transport gets its own honest default: a live model call takes
  // seconds (the direct TypeSafe lane and the gateway lane both budget 15 s), a
  // direct HTTP relay answers in milliseconds. The generic 4 s default used to
  // be resolved here and then passed into the gateway client, where the
  // transport's own 15 s default could never apply -
  // so slow-but-healthy calls were recorded as `timeout` fallbacks (issue #57).
  const configured = Number(process.env.JEV_TIMEOUT_MS);
  const overrideMs = Number.isFinite(configured) && configured > 0 ? configured : null;

  // 1. An explicit backend selection. `typesafe` is the direct TypeSafe lane —
  //    the production live path — and it reads TYPESAFE_API_KEY and nothing
  //    else: no gateway key, no JEV_TOKEN, no Vercel OIDC token. A name this
  //    codebase does not recognise fails CLOSED rather than falling through to
  //    the gateway lane an older JEV_MODEL might still select.
  const backend = process.env.JEV_BACKEND?.trim();
  if (backend !== undefined && backend !== "") {
    if (backend !== "typesafe") {
      return null;
    }
    const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
    if (typesafeKey === undefined || typesafeKey === "") {
      return null;
    }
    return {
      token: typesafeKey,
      authMode: "api-key",
      timeoutMs: overrideMs ?? JEV_TYPESAFE_TIMEOUT_MS,
      backend: "typesafe-direct",
      minConfidence: readMinConfidence(),
      gateway: null,
      endpoint: null,
    };
  }

  const model = process.env.JEV_MODEL?.trim();
  if (model) {
    // The credential precedence for the GATEWAY lane, in one place and in this
    // order:
    //   1. the explicitly configured AI Gateway API key (AI_GATEWAY_API_KEY,
    //      then JEV_TOKEN) — when one exists, the deployment's own OIDC token is
    //      not even consulted;
    //   2. the deployment's request-scoped OIDC token, ONLY as the fallback;
    //   3. nothing — the route answers 503 rather than guessing at a credential.
    // Which lane was taken is reported as `authMode`, so production can prove
    // it without any part of the credential being seen.
    const apiKey = configuredGatewayApiKey();
    const oidcToken = gatewayOidcToken?.trim();
    const token = apiKey ?? oidcToken;
    if (token === undefined || token === "") {
      return null;
    }
    return {
      token,
      authMode: apiKey === undefined ? "oidc" : "api-key",
      timeoutMs: overrideMs ?? JEV_GATEWAY_TIMEOUT_MS,
      backend: "ai-gateway",
      minConfidence: readMinConfidence(),
      gateway: {
        endpoint: process.env.JEV_GATEWAY_URL?.trim() || JEV_GATEWAY_ENDPOINT,
        model,
      },
      endpoint: null,
    };
  }

  if (!configuredToken) return null;
  const endpoint = process.env.JEV_ENDPOINT?.trim();
  if (!endpoint) {
    return null;
  }
  return {
    token: configuredToken,
    authMode: "api-key",
    timeoutMs: overrideMs ?? JEV_DEFAULT_TIMEOUT_MS,
    backend: "schema-service",
    minConfidence: undefined,
    gateway: null,
    endpoint,
  };
}

/**
 * True when the configuration selects the AI Gateway lane — the only lane the
 * deployment's OIDC token serves. An explicit backend selection (JEV_BACKEND)
 * outranks it, so OIDC is not even read for any other lane.
 */
export function selectsGatewayLane(): boolean {
  const backend = process.env.JEV_BACKEND?.trim();
  if (backend !== undefined && backend !== "") {
    return false;
  }
  return (process.env.JEV_MODEL?.trim() ?? "") !== "";
}

/** The one place a client is built from configuration. */
export function jevClientFromEnvironment(environment: JevEnvironment): JevClient {
  if (environment.backend === "typesafe-direct") {
    return createTypesafeJevClient({
      token: environment.token,
      timeoutMs: environment.timeoutMs,
      minConfidence: environment.minConfidence,
    });
  }
  if (environment.gateway) {
    return createGatewayJevClient({
      token: environment.token,
      endpoint: environment.gateway.endpoint,
      model: environment.gateway.model,
      timeoutMs: environment.timeoutMs,
      minConfidence: environment.minConfidence,
    });
  }
  return createHttpJevClient({
    endpoint: environment.endpoint ?? "",
    token: environment.token,
    timeoutMs: environment.timeoutMs,
  });
}

export async function POST(request: Request): Promise<Response> {
  // The deployment's OIDC token is the FALLBACK credential for the GATEWAY
  // lane, so it is read only when that lane is selected and no explicit AI
  // Gateway API key is configured: with a key present — or with an explicit
  // backend selection — the request never depends on OIDC at all. (In
  // Functions the platform rotates this token on each request and exposes it
  // through request context, not a stable process.env value. The official
  // helper reads that context.)
  let gatewayOidcToken: string | undefined;
  if (selectsGatewayLane() && configuredGatewayApiKey() === undefined) {
    try {
      gatewayOidcToken = getVercelOidcTokenSync();
    } catch {
      // No OIDC context here (a local run, or a project without it). With no
      // explicit key either, the route reports itself unconfigured — it never
      // invents a credential.
    }
  }
  const environment = readJevEnvironment(gatewayOidcToken);
  if (environment === null) {
    return refusal(503, "jev is not configured", "not-configured");
  }

  // Every refusal past this point knows which credential lane and which
  // backend it is about, so each carries both as names. The 503 above has no
  // lane to report: nothing is configured.
  const deny = (
    status: number,
    error: string,
    failure: JevClientFailure,
    retryAfterMs: number | null = null,
  ): Response => refusal(status, error, failure, retryAfterMs, environment.authMode, environment.backend);

  if (!firstParty(request)) {
    return deny(403, "cross-origin requests are not allowed", "rejected");
  }

  // Identity comes from the platform (see caller.ts), never from the caller's
  // own forwarding headers, and is never echoed back in a response.
  const key = callerIdentity(request);
  if (await platformRateLimited(request, key)) {
    return deny(429, "too many policy requests", "rate-limited");
  }
  if (!allowRequest(key, Date.now())) {
    return deny(429, "too many policy requests", "rate-limited");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return deny(413, "request body is too large", "rejected");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return deny(400, "request body could not be read", "rejected");
  }
  // The declared length is a claim; this is the actual size.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return deny(413, "request body is too large", "rejected");
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return deny(400, "request body must be JSON", "rejected");
  }

  const validated = validateJevPolicyRequest(body);
  if (!validated.ok) {
    return deny(400, validated.error, "rejected");
  }

  const client = jevClientFromEnvironment(environment);
  try {
    const raw = await client.requestPolicy(validated.value);
    const parsed = parseJevPolicy(raw, jevPolicyContext(validated.value));
    if (!parsed.ok) {
      return deny(502, parsed.error, "malformed");
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
          // The lane, as a name — so production can prove which credential
          // asked without any part of it being visible.
          [JEV_AUTH_HEADER]: environment.authMode,
          // The backend, as a name — so production can prove the live path
          // (TypeSafe direct) without seeing a credential or a body.
          [JEV_BACKEND_HEADER]: environment.backend,
        },
      },
    );
  } catch (error) {
    // Bounded by construction: a status or the word "timeout", never a body —
    // plus the credential LANE the failure happened on (a name, never a value).
    console.error("[jev-relay] policy request failed:", failureReason(error), environment.authMode);
    return deny(502, "jev service request failed", failureClass(error), clientRetryAfterMs(error));
  }
}
