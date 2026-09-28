/**
 * Direct TypeSafe transport tests (the production live path).
 *
 * The relay's server-side client for TypeSafe's own API — POST
 * https://api.typesafe.ai/v1/systemone — is a TRANSPORT adaptation: the request
 * shape, the bounded question set and the answer translation are the same code
 * the gateway lane uses (jev/gateway.ts). These tests pin the transport's own
 * contract: the exact endpoint, model and credential; parsing of the answer
 * shape the direct API actually returns (verified with one bounded live probe:
 * `answers[id] = { type, choice, confidence, probabilities }`); the bounded
 * failure classes; and that no credential can reach the browser.
 *
 * Every upstream is a stub — no test reaches the network, and none invents what
 * the model would decide.
 */
import { describe, expect, it } from "vitest";
import { createJevController } from "@/controllers/jev";
import {
  createRelayJevClient,
  isJevBackendName,
  JEV_BACKEND_HEADER,
  JEV_BACKENDS,
  JevClientError,
  type JevBackendName,
} from "@/jev/client";
import { adapterFromId, adapterInvolvesModel, provenanceLabel } from "@/jev/provenance";
import { JEV_SCHEMA_VERSION, parseJevPolicy, type JevPolicyRequest } from "@/jev/schema";
import {
  createTypesafeJevClient,
  JEV_TYPESAFE_CLIENT_ID,
  JEV_TYPESAFE_ENDPOINT,
  JEV_TYPESAFE_MODEL,
} from "@/jev/typesafe";

function request(overrides: Partial<JevPolicyRequest> = {}): JevPolicyRequest {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 5_000,
    windowMs: 5_000,
    city: {
      intersections: 100,
      signalizedIntersections: 40,
      activeVehicles: 400,
      queuedVehicles: 120,
      maxWaitMs: 30_000,
      arrivalRatePerSecond: 9,
    },
    corridors: [
      {
        corridorId: 1,
        kind: "arterial",
        intersections: 3,
        queuedVehicles: 20,
        maxWaitMs: 5_000,
        arrivalRatePerSecond: 1,
        occupancyRatio: 0.4,
      },
    ],
    regions: [
      {
        regionId: 1,
        intersections: 20,
        signalizedIntersections: 8,
        queuedVehicles: 60,
        maxWaitMs: 30_000,
        arrivalRatePerSecond: 4,
        occupancyRatio: 0.5,
      },
    ],
    hotspots: [],
    ...overrides,
  };
}

interface SeenRequest {
  url: string;
  authorization: string | null;
  body: { model?: string; questions?: Record<string, unknown> };
}

/**
 * A direct-API-shaped answer for every question the request asked, in the shape
 * the live probe returned: a choice, a probability for each option, and a
 * confidence. The chosen option's own probability is what the adapter uses.
 */
function answerFor(seen: SeenRequest, pick: (id: string) => string | null): Response {
  const questions = seen.body.questions ?? {};
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(questions)) {
    const choice = pick(id);
    if (choice !== null) {
      answers[id] = {
        type: "choice",
        choice,
        confidence: 0.6,
        probabilities: { [choice]: 0.7 },
      };
    }
  }
  return new Response(
    JSON.stringify({
      // The fields the live probe returned that this codebase does not parse.
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 1_420, output_tokens: 262 },
    }),
    { status: 200 },
  );
}

/** The client under test, with a fetch that records what went upstream. */
function typesafeClient(respond: (seen: SeenRequest) => Response) {
  const seen: SeenRequest[] = [];
  const client = createTypesafeJevClient({
    token: "typesafe-test-key",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const record: SeenRequest = {
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as SeenRequest["body"],
      };
      seen.push(record);
      return respond(record);
    }) as unknown as typeof fetch,
  });
  return { client, seen };
}

describe("direct TypeSafe transport", () => {
  it("posts the production evaluation shape to TypeSafe's endpoint, with jev-latest", async () => {
    const { client, seen } = typesafeClient((record) =>
      answerFor(record, (id) => {
        if (id === "hint") return "hold-longer";
        if (id === "pressure") return "assertive";
        return "high";
      }),
    );

    const raw = (await client.requestPolicy(request())) as {
      pressureScale: number;
      hint: string;
      corridorWeights: { id: number; weight: number }[];
    };

    // The direct endpoint and the direct model id — not the gateway's alias.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JEV_TYPESAFE_ENDPOINT).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0].body.model).toBe("jev-latest");
    expect(JEV_TYPESAFE_MODEL).toBe("jev-latest");
    // The credential travels in the header only.
    expect(seen[0].authorization).toBe("Bearer typesafe-test-key");
    expect(JSON.stringify(seen[0].body)).not.toContain("typesafe-test-key");
    // The bounded question set is preserved exactly.
    expect(Object.keys(seen[0].body.questions ?? {}).sort()).toEqual([
      "corridor-intent:1",
      "corridor:1",
      "hint",
      "pressure",
      "region-intent:1",
      "region:1",
    ]);
    // The client names itself truthfully.
    expect(client.id).toBe(JEV_TYPESAFE_CLIENT_ID);
    expect(client.id).toBe("typesafe-direct");

    // And the existing adapter translated the answers into a valid policy.
    const parsed = parseJevPolicy(raw, { corridorIds: [1], regionIds: [1] });
    expect(parsed.ok).toBe(true);
    expect(raw.hint).toBe("hold-longer");
    expect(raw.pressureScale).toBe(1.25);
    expect(raw.corridorWeights).toEqual([{ id: 1, weight: 1.5 }]);
  });

  it("reads the documented answer shape: the selected choice's own probability", async () => {
    const { client } = typesafeClient((record) =>
      // A choice whose own probability sits below the confidence floor is not
      // an opinion: the policy falls back to neutral for it, and the answer is
      // counted as dropped rather than guessed at.
      answerFor(record, (id) => (id === "pressure" ? "urgent" : id === "hint" ? "switch-sooner" : "top")),
    );
    const lowConfidence = createTypesafeJevClient({
      token: "typesafe-test-key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              pressure: { type: "choice", choice: "urgent", confidence: 0.1, probabilities: { urgent: 0.1 } },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    const confident = (await client.requestPolicy(request())) as { pressureScale: number };
    expect(confident.pressureScale).toBe(1.5);

    const dropped = (await lowConfidence.requestPolicy(request())) as { pressureScale: number };
    expect(dropped.pressureScale).toBe(1); // neutral: the answer was not usable
    expect(lowConfidence.answerNotes?.()).toEqual({ clamped: 0, dropped: 1 });
  });

  it("refuses a malformed response instead of inventing a policy", async () => {
    const noAnswers = typesafeClient(
      () => new Response(JSON.stringify({ model: "jev-1.13.0", usage: {} }), { status: 200 }),
    );
    await expect(noAnswers.client.requestPolicy(request())).rejects.toThrow(/no answers/);

    const nonsense = typesafeClient(
      () =>
        new Response(
          JSON.stringify({ answers: { pressure: { choice: "not-a-bucket" }, hint: {} } }),
          { status: 200 },
        ),
    );
    // Unusable choices become the schema's neutral defaults — never a guessed
    // opinion, and never an out-of-bounds value.
    const policy = (await nonsense.client.requestPolicy(request())) as {
      pressureScale: number;
      hint: string;
    };
    expect(policy.pressureScale).toBe(1);
    expect(policy.hint).toBe("neutral");
  });

  it("classifies 401/403 separately from 429 and 5xx, keeping the pause TypeSafe names", async () => {
    const failureOf = async (status: number, headers: Record<string, string> = {}) => {
      const { client } = typesafeClient(
        () => new Response("upstream prose that must never travel", { status, headers }),
      );
      try {
        await client.requestPolicy(request());
        throw new Error("expected a failure");
      } catch (error) {
        return error as JevClientError;
      }
    };

    const unauthorized = await failureOf(401);
    expect(unauthorized).toBeInstanceOf(JevClientError);
    expect(unauthorized.failure).toBe("rejected");
    expect(unauthorized.message).toBe("jev typesafe-direct responded 401");
    expect(unauthorized.message).not.toContain("upstream prose");
    expect(unauthorized.retryAfterMs).toBeNull();

    const forbidden = await failureOf(403);
    expect(forbidden.failure).toBe("rejected");

    const limited = await failureOf(429, { "retry-after": "30" });
    expect(limited.failure).toBe("rate-limited");
    expect(limited.retryAfterMs).toBe(30_000);

    const serverError = await failureOf(500);
    expect(serverError.failure).toBe("upstream-error");
    expect(serverError.message).toBe("jev typesafe-direct responded 500");
  });

  it("never echoes an upstream body, even one that repeats the credential", async () => {
    const { client } = typesafeClient(
      () =>
        new Response("upstream says: typesafe-test-key is revoked", {
          status: 403,
        }),
    );
    await expect(client.requestPolicy(request())).rejects.toThrow(/responded 403/);
    await expect(client.requestPolicy(request())).rejects.not.toThrow(/revoked|typesafe-test-key/);
  });
});

describe("the browser path holds no credential and learns the backend by name", () => {
  it("sends no authorization header and records the backend the relay named", async () => {
    const seenHeaders: Headers[] = [];
    const relay = createRelayJevClient({
      url: "https://app.invalid/api/jev/policy",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seenHeaders.push(headers);
        return new Response(JSON.stringify({ policy: { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1 } }), {
          status: 200,
          headers: { [JEV_BACKEND_HEADER]: "typesafe-direct" },
        });
      }) as unknown as typeof fetch,
    });

    expect(relay.backend?.()).toBeNull();
    await relay.requestPolicy(request());
    // No credential of any kind rides the browser request.
    expect(seenHeaders[0].get("authorization")).toBeNull();
    expect([...seenHeaders[0].keys()].some((key) => key.includes("authorization"))).toBe(false);
    expect(relay.backend?.()).toBe("typesafe-direct");
  });

  it("records the relay's backend on a refusal too", async () => {
    const relay = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "jev service request failed" }), {
          status: 502,
          headers: { [JEV_BACKEND_HEADER]: "typesafe-direct", "x-jev-reason": "rejected" },
        })) as unknown as typeof fetch,
    });
    await expect(relay.requestPolicy(request())).rejects.toThrow(/jev service request failed/);
    expect(relay.backend?.()).toBe("typesafe-direct");
  });

  it("keeps the backend vocabulary closed: junk names are ignored", async () => {
    expect(JEV_BACKENDS).toEqual(["typesafe-direct", "ai-gateway", "schema-service"]);
    for (const name of JEV_BACKENDS) {
      expect(isJevBackendName(name)).toBe(true);
    }
    for (const junk of ["", "v", "typesafe", "openai", null, undefined, 1]) {
      expect(isJevBackendName(junk)).toBe(false);
    }

    const relay = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ policy: { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1 } }), {
          status: 200,
          headers: { [JEV_BACKEND_HEADER]: "something-else" },
        })) as unknown as typeof fetch,
    });
    await relay.requestPolicy(request());
    expect(relay.backend?.()).toBeNull();
  });

  it("a completed run records direct TypeSafe, never the gateway or a mock", async () => {
    const relayWith = (backend: JevBackendName) =>
      createRelayJevClient({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ policy: { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1 } }), {
            status: 200,
            headers: { [JEV_BACKEND_HEADER]: backend },
          })) as unknown as typeof fetch,
      });

    const typesafe = relayWith("typesafe-direct");
    const controller = createJevController({ client: typesafe, scenarioFingerprint: "typesafe-1" });
    await typesafe.requestPolicy(request());
    expect(controller.meta().adapter).toBe("typesafe-direct");
    expect(provenanceLabel(controller.meta().adapter)).toBe("jev-typesafe-direct");

    // The relay's gateway lane still reports the gateway — truthfully.
    const gateway = relayWith("ai-gateway");
    const gatewayController = createJevController({ client: gateway, scenarioFingerprint: "gateway-1" });
    await gateway.requestPolicy(request());
    expect(gatewayController.meta().adapter).toBe("gateway");
  });
});

describe("direct TypeSafe provenance", () => {
  it("names the adapter, its label and its model involvement", () => {
    expect(adapterFromId("typesafe-direct")).toBe("typesafe-direct");
    expect(provenanceLabel("typesafe-direct")).toBe("jev-typesafe-direct");
    expect(adapterInvolvesModel("typesafe-direct")).toBe(true);
  });
});
