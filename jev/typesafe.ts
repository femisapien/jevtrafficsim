/**
 * TypeSafe AI direct transport for Jev (the production live path).
 *
 * The relay's server-side client for TypeSafe's own API — POST
 * https://api.typesafe.ai/v1/systemone — reached with the deployment's
 * TYPESAFE_API_KEY directly, instead of through the Vercel AI Gateway. The
 * browser still never holds the credential: it posts to our own route
 * (app/api/jev/policy/route.ts), which is the only place the key lives.
 *
 * ## This is a TRANSPORT change, not a controller change
 *
 * The request the model receives (the bounded citywide state digest, the typed
 * choice questions, the criteria) and the translation of its answers into a
 * policy are the SAME code the gateway lane uses (jev/gateway.ts). TypeSafe's
 * direct API answers the identical evaluation shape — verified with ONE bounded
 * live probe before this lane was built: HTTP 200 in 251 ms, body
 * `{ model: "jev-1.13.0", answers: { <id>: { type, choice, confidence,
 * probabilities } }, usage: { input_tokens, output_tokens } }`, no rate-limit
 * metadata on the response. Nothing about the policy schema, the question
 * semantics, the confidence floor or the bounds changed.
 *
 * What differs from the gateway lane, and all that differs:
 *
 *   - the endpoint: https://api.typesafe.ai/v1/systemone;
 *   - the model id: `jev-latest` — the gateway's `typesafe-ai/jev` alias is a
 *     gateway-side name and is not valid against the direct API;
 *   - the credential: TYPESAFE_API_KEY, and ONLY that key. No Vercel OIDC
 *     token, no AI_GATEWAY_API_KEY and no JEV_TOKEN is ever read or sent by
 *     this lane;
 *   - the name this client reports: `typesafe-direct`, which is what a run's
 *     provenance records (jev/trace.ts, jev/provenance.ts) and what the relay
 *     names in `x-jev-backend` — never "gateway" or "Vercel".
 *
 * The response parser is the existing one and reads only documented fields
 * (`answers[id].choice` with `probabilities`/`confidence`); an upstream error
 * body is never echoed anywhere — failures travel as a bounded status class
 * plus, when the service provided it, its `retry-after` as a bounded number.
 */
import type { JevClient } from "./client";
import { createGatewayJevClient } from "./gateway";

export const JEV_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_TYPESAFE_MODEL = "jev-latest";
/**
 * A live model call takes seconds; the same honest default the gateway lane
 * uses (JEV_TIMEOUT_MS still overrides it, see the relay route). Measured
 * against the direct API: 251 ms for the six-question production shape.
 */
export const JEV_TYPESAFE_TIMEOUT_MS = 15_000;
/** The client id, and the name in this transport's own error sentences. */
export const JEV_TYPESAFE_CLIENT_ID = "typesafe-direct";

export interface TypesafeJevClientOptions {
  /** TYPESAFE_API_KEY. Passed in, never read from the environment here. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** How many of the busiest corridors / regions get their own question. */
  readonly corridorQuestions?: number;
  readonly regionQuestions?: number;
  /** Minimum usable confidence per answer; defaults to the adapter's floor. */
  readonly minConfidence?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The direct client. Same `JevClient` contract as the gateway client, so the
 * controller and the relay do not know which transport is in use — except by
 * the truthful name this one reports.
 */
export function createTypesafeJevClient(options: TypesafeJevClientOptions): JevClient {
  return createGatewayJevClient({
    token: options.token,
    endpoint: JEV_TYPESAFE_ENDPOINT,
    model: JEV_TYPESAFE_MODEL,
    id: JEV_TYPESAFE_CLIENT_ID,
    timeoutMs: options.timeoutMs ?? JEV_TYPESAFE_TIMEOUT_MS,
    corridorQuestions: options.corridorQuestions,
    regionQuestions: options.regionQuestions,
    minConfidence: options.minConfidence,
    fetchImpl: options.fetchImpl,
  });
}
