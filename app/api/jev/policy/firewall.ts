/**
 * The deployment-wide cost guard: Vercel's own Firewall rate limiting.
 *
 * ## What this guard is worth
 *
 * `checkRateLimit` matches a rate-limit rule defined in the Vercel Firewall by
 * its RATE LIMIT API ID and keys it on the platform's client address. When a
 * matching rule exists the limit is counted by the PLATFORM, so it holds across
 * every instance of the deployment — which is the one thing the in-memory
 * budget in route.ts cannot do, because that counter lives in a single
 * serverless instance's memory.
 *
 * ## The defect this file fixes: a guard that removed itself
 *
 * The SDK answers in three ways, and the code this replaces collapsed two of
 * them into "not limited":
 *
 *   `{ rateLimited: false }`  the platform counted the request and it is inside
 *                             the rule's budget. Spend it.
 *   `{ rateLimited: true }`   over budget, or `error: "blocked"` — the platform
 *                             itself refused. Refuse (429).
 *   `error: "not-found"`      JEV_RATE_LIMIT_ID is set but no rule matches it:
 *                             the documented misconfiguration (the rule's own
 *                             generated `rule_...` identifier instead of its
 *                             rate-limit API ID, or a rule that was never
 *                             created), reported by the platform as a 404;
 *   or the call THREW         the SDK could not be consulted at all (platform
 *                             incident, an unkeyable request, a network error).
 *
 * The last two were treated as "allowed". That is fail-OPEN on precisely the
 * control that exists to bound cost: with a broken or missing rule the
 * deployment-wide guard stops running while the credential the relay holds
 * stays spendable, and the only outward signal was one log line per process.
 *
 * ## The rule now: configured means enforced
 *
 * In production, with JEV_RATE_LIMIT_ID explicitly set, "not-found" and a
 * thrown lookup are `unavailable`, and route.ts refuses the request with a
 * bounded 503 BEFORE any upstream call. Cost safety beats availability there on
 * purpose: a deployment whose guard cannot be consulted would otherwise serve
 * every caller without a deployment-wide bound, and nothing in the product
 * would say so. The refusal is bounded — a status and one fixed sentence of
 * this codebase's own — and it never carries the platform's error, the rule id
 * or anything else from the SDK.
 *
 * The condition is deliberately narrow, because a local run has no edge and no
 * rule to match:
 *
 *   NODE_ENV is not "production"           -> allowed (unchanged: `next dev`)
 *   JEV_RATE_LIMIT_ID unset or blank       -> allowed (unchanged: the operator's
 *                                             explicit choice to run with only
 *                                             the instance-local budget)
 *   production + id + rule resolves        -> the platform's own verdict (unchanged)
 *   production + id + not-found, or threw  -> unavailable (refused; was allowed)
 *
 * ## What is logged, and what is not
 *
 * ONE bounded sentence per condition, once per process: a missing rule and a
 * failed lookup are both facts an operator has to act on, and one line per
 * request would be a billed resource an attacker could drive at will. Nothing
 * else is ever logged — no request headers, no client address, no rule id, no
 * token, and not the SDK's own error text (which can carry a URL).
 */
import { unstable_checkRateLimit as checkRateLimit } from "@vercel/firewall";

/**
 * What the platform guard said about one request, as a closed three-value
 * verdict. "unavailable" is the state that used to be indistinguishable from
 * "allowed"; it is what makes fail-closed testable.
 */
export type PlatformGuardVerdict = "allowed" | "limited" | "unavailable";

/** Once per process per condition: the first occurrence, never every request. */
let warnedMissingRule = false;
let warnedLookupFailed = false;

/**
 * The guard's verdict for one request. See the module header for the exact
 * condition under which a broken guard refuses — and for why it is this narrow.
 *
 * The configured id is read per call rather than cached at module load: it is
 * the whole condition this decision rests on, and reading it here keeps that
 * condition in one place (environment changes still only reach a running
 * deployment on a new deployment).
 */
export async function platformGuardVerdict(
  request: Request,
  key: string,
): Promise<PlatformGuardVerdict> {
  const configuredId = process.env.JEV_RATE_LIMIT_ID?.trim();
  // Not in production, or no rule is configured: not our guard, not our
  // decision. The instance-local budget in route.ts still applies.
  if (configuredId === undefined || configuredId === "" || process.env.NODE_ENV !== "production") {
    return "allowed";
  }
  try {
    const { rateLimited, error } = await checkRateLimit(configuredId, { request, rateLimitKey: key });
    if (rateLimited || error === "blocked") {
      return "limited";
    }
    if (error === "not-found") {
      if (!warnedMissingRule) {
        warnedMissingRule = true;
        console.error(
          "[jev-relay] JEV_RATE_LIMIT_ID is set but no Vercel Firewall rate-limit rule matches it; refusing policy requests (fail closed)",
        );
      }
      return "unavailable";
    }
    return "allowed";
  } catch {
    if (!warnedLookupFailed) {
      warnedLookupFailed = true;
      console.error(
        "[jev-relay] the Vercel Firewall rate-limit check could not be consulted; refusing policy requests (fail closed)",
      );
    }
    return "unavailable";
  }
}
