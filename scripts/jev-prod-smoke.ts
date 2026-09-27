/**
 * Production-style Jev smoke — a NON-JEV CONTROL PROBE.
 *
 * Exercises the DEPLOYED relay (which holds the token server-side) with a body
 * the production generator actually produces, and checks the answer is a real
 * bounded policy with honest provenance - not a fallback dressed as a model
 * answer. Also checks the route refuses an over-large body before it touches the
 * model (Issue #37's ceiling).
 *
 *   npx tsx scripts/jev-prod-smoke.ts [base-url]
 *
 * THIS IS NOT A JEV RUN. Nothing here is governed by a Jev policy: the probe
 * needs a populated city to build a realistic request from, and it drives that
 * city with the FIXED baseline — deliberately not Adaptive, so no run in this
 * file can ever be read as a Jev result or as an Adaptive-governed one. The
 * banner below says so on stdout, and no Jev provenance is produced here.
 *
 * No credentials are read, logged or needed here.
 */
import { createEngine, runEngine } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { productionDemand } from "@/sim/demand-profile";
import { buildCityPartition } from "@/sim/regions";
import { buildObservationFrame } from "@/sim/observations";
import { buildJevPolicyRequest } from "@/jev/request";
import { loadBenchmarkModel } from "@/benchmark/model";
import { checkOversizedAnswer, checkRelayAnswer, checkSmokeRequest } from "./jev-smoke-checks";

const BASE = process.argv[2] ?? "https://jevtrafficsim.vercel.app";
const HORIZON_MS = 600_000;

async function main(): Promise<void> {
  const model = loadBenchmarkModel();
  // The probe's own world: driven by the deterministic Fixed baseline (see the
  // module doc — this is a control probe, never a Jev or Adaptive run).
  console.log("probe world: driven by the Fixed baseline; this is NOT a Jev run");
  const engine = createEngine({
    city: model.city,
    controller: createFixedController(),
    spawns: productionDemand({ city: model.city, level: "rush-hour", seed: 42, durationMs: HORIZON_MS }),
  });
  runEngine(engine, HORIZON_MS);
  const request = buildJevPolicyRequest({
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition: buildCityPartition(engine.city),
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  });
  const body = JSON.stringify(request);
  checkSmokeRequest(request, body);
  console.log(`request: ${(body.length / 1024).toFixed(1)} KB · ${request.corridors.length} corridors · ${request.regions.length} regions · schema ${request.schemaVersion}`);

  const started = Date.now();
  const res = await fetch(`${BASE}/api/jev/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const elapsed = Date.now() - started;
  const payload = (await res.json().catch(() => null)) as unknown;

  console.log(`relay: HTTP ${res.status} in ${elapsed} ms`);
  // WHICH credential lane the deployment used: a name, never a value. It is the
  // one fact that makes a gateway 403 diagnosable; a deployment that predates
  // the diagnostic simply reports nothing here.
  const lane = res.headers.get("x-jev-auth");
  console.log(`relay: auth lane ${lane ?? "not reported (deployment predates x-jev-auth)"}`);
  checkRelayAnswer(res.status, payload, request);
  console.log("relay: schema-valid bounded policy; no credential-shaped value");

  // The ceiling: a body far past the limit must be refused before the model runs.
  const oversized = await fetch(`${BASE}/api/jev/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, pad: "x".repeat(200_000) }),
  });
  checkOversizedAnswer(oversized.status);
  console.log("oversized body: HTTP 413");
}

void main().catch((error: unknown) => {
  // Only our own fixed, bounded assertion messages are reported. Fetch/runtime
  // exceptions may contain URLs or credentials and are never echoed.
  const reason = error instanceof Error && /^(generated request|relay HTTP|relay returned|relay response|oversized request HTTP)/.test(error.message)
    ? error.message
    : "network or runtime failure";
  console.error(`Jev production smoke FAILED: ${reason}`);
  process.exitCode = 1;
});
