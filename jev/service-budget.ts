/**
 * THE SESSION'S SHARE OF THE UPSTREAM SERVICE ALLOWANCE (one gate per session).
 *
 * ## The failure this module exists for
 *
 * A gate per CONTROLLER is not a gate on the upstream allowance. worker/
 * simulation.worker.ts used to build one with every Jev controller
 * (`createJevServiceGate()` inside `makeController`), so a run that rebuilt its
 * controller — a reset, a new scenario, a controller switch, or simply the next
 * run — started with an empty window and asked as if the previous run had never
 * happened. The upstream had counted every one of those requests and answered
 * the next one with 429: the exact failure jev/scheduler.ts was written to
 * prevent, reintroduced by the LIFETIME of the gate rather than by its rule.
 *
 * ## Where the allowance actually applies (evidence, not inference)
 *
 * The allowance is the CREDENTIAL's, and this deployment has exactly one:
 *
 *   - the browser carries no credential at all (`createRelayJevClient` in
 *     jev/client.ts sends no Authorization header) and posts to our own route,
 *     which is the only place the service credential lives (app/api/jev/policy/
 *     route.ts: the explicitly configured AI Gateway API key —
 *     AI_GATEWAY_API_KEY, then JEV_TOKEN — or the deployment's request-scoped
 *     OIDC token when no explicit key exists). Every tab, every run and every
 *     user of the deployment asks with that same credential;
 *   - the allowance is reported against that credential, per model, by the
 *     gateway itself: every 429 carries `x-ratelimit-limit-requests: 5`,
 *     `x-ratelimit-remaining-requests: 0` and `x-ratelimit-reset-requests`
 *     equal to `retry-after` (six samples: 27, 37, 40, 60, 60, 60 s), while
 *     every 200 carries NO rate-limit header at all — the remaining budget can
 *     be learned from a refusal and never from a success;
 *   - the probe that produced those headers (`/tmp/jev-gateway-probe-*.json`)
 *     spoke to the gateway DIRECTLY with the deployment's own token, and the
 *     deployed relay path produced the same 429 shape
 *     (`/tmp/jev-relay-probe-021825/`: 30 requests, 19 upstream rate limits).
 *     One credential, one window, whether the request came from a script or
 *     from a browser;
 *   - production's live path no longer runs through that gateway: it is
 *     TypeSafe's own API, directly (`JEV_BACKEND=typesafe`, credential
 *     TYPESAFE_API_KEY, held only by the relay). The one bounded probe of the
 *     direct API carried NO rate-limit metadata at all, so the schedule keeps
 *     its conservative measured shape (jev/scheduler.ts) until a direct refusal
 *     teaches something. The scope below is unchanged — one credential per
 *     deployment — because the credential still lives on the server;
 *   - the window is shared with the provider's other callers and moves with
 *     provider demand (12 requests at 5.3 s spacing passed with zero 429s in one
 *     quiet minute; 12.7/min took 10 rejections a minute later). That is why one
 *     run spends at most 4 of the advertised 5 (jev/scheduler.ts).
 *
 * So the real budget is per credential, i.e. per deployment, and at minimum
 * shared by every Jev run of one browser session. The narrowest scope that
 * matches it for a process we own is ONE gate per application session — this
 * module — and every Jev controller in the worker is built with it.
 *
 * ## What is shared, and what is NOT
 *
 * SHARED (the whole object): WHEN a request may be issued. Requests already
 * spent in the trailing window, the minimum spacing between them, a
 * `retry-after` the service asked for, a transient-failure backoff, and the
 * counters that describe those facts.
 *
 * NOT SHARED, and each stays per-run in jev/runtime.ts: the accepted policy,
 * the trace, the scenario fingerprint, the request generation, the per-refresh
 * telemetry, and every controller decision. A run reports its OWN requests by
 * subtracting the counters the gate already held when the run was built
 * (`serviceStatusSince` in jev/scheduler.ts), so sharing the gate cannot make
 * one run's numbers appear in another's result.
 *
 * ## Multi-tab, stated honestly
 *
 *   A. FOR THE INTENDED PUBLIC DEMO: sufficient. One person, one tab, sequential
 *      runs — the case that produced the measured 429s — is exactly what this
 *      fixes: run B inherits run A's spent window and waits instead of asking.
 *      A second tab is not part of the demo's intended use, and a demo visitor
 *      starting two tabs at once is a rarer failure than "run it again".
 *   B. THE RELAY DOES NOT ALREADY PROTECT THE UPSTREAM ALLOWANCE. Its guards
 *      are real but a different size: the Vercel Firewall rule (60 requests/60 s
 *      per IP, deployment-wide when the rule exists) and the instance-local
 *      limiter (180/60 s) are an order of magnitude above the upstream's 5 per
 *      ~60 s, so neither stops a second tab from spending the upstream window.
 *      The relay's contribution is the credential boundary, the schema
 *      validation and forwarding the pause (`x-jev-retry-after-ms`), not a
 *      global quota.
 *   C. TRUE GLOBAL ENFORCEMENT IS NOT IN THIS REPOSITORY. Two tabs each holding
 *      their own session gate CAN jointly exceed the real allowance, and no
 *      browser-side object can prevent that. Correct enforcement needs shared
 *      state on the server side: a durable token bucket (KV/Redis/Postgres)
 *      consulted by app/api/jev/policy/route.ts, or a Vercel Firewall rate-limit
 *      rule sized to the upstream allowance. Note what is NOT an answer:
 *      instance-local serverless memory is not a global coordinator — several
 *      instances each hold their own copy, and presenting that as a guarantee
 *      would be false. Until such state exists, this module claims exactly what
 *      it provides: one session's runs share one history, and a rebuilt
 *      controller cannot mint a new allowance.
 */
import {
  createJevServiceGate,
  type JevServiceGate,
  type JevServiceGateOptions,
} from "./scheduler";

/** The session's one gate. Created on first use; never replaced. */
let sessionGate: JevServiceGate | null = null;

/**
 * The gate every Jev controller in this application session is built with.
 *
 * The FIRST call decides the session: later calls return the same object, so
 * building a controller (a new run, a reset, a new scenario, a controller
 * switch) cannot start a new allowance. `options` is honoured by the first call
 * only — production passes nothing and gets the measured budget on the wall
 * clock; a test that needs to drive the session's own gate injects its clock
 * and sleep here.
 */
export function sessionJevServiceGate(options: JevServiceGateOptions = {}): JevServiceGate {
  sessionGate ??= createJevServiceGate(options);
  return sessionGate;
}
