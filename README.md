# Jev Traffic Sim

An interactive Chicago traffic simulator that runs **one experiment**: you watch a single car
cross real Chicago geography while the whole city simulates around it, and the same scenario
is also played out by two deterministic baselines.

**Live:** deploy URL is published with the release notes.

## The experiment

| Column | What it is |
| --- | --- |
| **Fixed** | Signals on a fixed rotation. No sensing, no adaptation. The do-nothing baseline. |
| **Adaptive** | Signals that react to local queue pressure and waits, with the same min/max green, yellow, all-red and starvation protection as everything else. |
| **Jev** | A citywide policy from an external evaluation model (TypeSafe AI's `jev` through the Vercel AI Gateway). It sees only citywide traffic state and answers bounded, typed questions. Its answer becomes corridor/region weights and a small pressure modifier. |

The visible run asks Jev for citywide policy. Fixed and Adaptive play the *same* scenario
headlessly, in a worker of their own, so the trip you are watching never stalls. The label
reports what actually governed the visible run.

**Nothing about the driver changes the scenario.** Tourist and Local are two ways of driving
the same trip in the same city: the tourist follows the shortest route and sits through
queues; the local knows the network and reroutes around trouble.

## Same-scenario fairness

A comparison is only shown when it is honest:

- all three runs share one **scenario fingerprint**: the scenario (trip, traffic level,
  driver, seed, horizon) is hashed into a short id, and results with different ids are never
  put side by side;
- all three runs are built from one **demand spawn list** and one **incident script**, so the
  weather in the city is byte-identical and only the signals differ;
- a run a human touched (a manual incident, a mid-run traffic change, a mid-run controller
  switch) is marked non-comparable and shown as such instead of being silently compared.

No winner score is computed. Every number in the panel is a field of a real run.

## What Jev may and may not do

- **No ego privilege.** The request never contains the ego vehicle id, its route, its
  destination, or anything else that could make one car special. Three independent tests
  prove that (schema scan, observation-frame scan, source scan).
- **No lamps.** Jev never sets a signal state. It answers with a small bounded policy:
  corridor/region weights (0.5-2), a pressure scale (0.5-1.5), a coarse hint. The existing
  controller layer translates that into legal local decisions. Phase order, min/max green,
  yellow, all-red and starvation protection stay in `sim/signals.ts` and are enforced whatever
  the model says.
- **Bound and validated.** The policy is parsed against hard limits; anything malformed or
  out of range is rejected (or clamped and reported) and the previous policy stays.
- **Applied even when imperfect, and reported.** The model's last accepted policy keeps
  governing while no fresher one arrives: bounded by a maximum hold, clamped like any other.
  How much of the run was governed fresh, how much was held past its refresh window, and
  whether any answer had to be clamped or fell below the confidence floor are all carried in
  the run's own record (`heldMs`, the per-refresh outcomes and reasons), not on the label.
- **No fabricated answers.** If Jev is unconfigured, has no answer yet, or has outlived even
  the maximum hold of its last policy, the run stops and says so in plain words, with the
  classified reason: a timeout, a rate limit, an upstream error, an unreadable answer. Before
  the first provenance snapshot, the UI says `Checking Jev`, never an unproven plain `Jev`.

The controller the product shows is named `Jev`, unqualified. The accounting underneath that
name stays in the run's own record — `heldMs`, `invalidMs`, `fallbackMs`, the refresh outcomes
and reasons in `provenance` and telemetry — and a run that was not governed by Jev (never
started, or lost mid-run) is never presented as a normal Jev run.

## Lifecycle

The experiment is easy to invalidate by accident, so the app says so before it happens:

| Moment | What the user sees |
| --- | --- |
| The **first** manual incident (or the first live demand change) | The consequence, in words: the run keeps playing, but the clean same-scenario comparison is off. Asked once: never repeated once the run is modified. |
| An incident this world cannot run | Disabled, with the worker's own reason ("no safe route-relevant bridge"), not a click that ends in "not available". |
| Arrival, while the baselines finish | "Running the same scenario with Fixed and Adaptive…": a named state with no invented progress. |
| The baselines fail | An explicit failure with a **Try again** button, which re-asks for the same scenario. Never an indefinite wait. |
| Anything that discards the run (trip, driver, seed, restart, new draw) | A confirmation when there is progress to lose, and nothing at all before the first run. |

The guards themselves are unchanged: a run touched by hand, or a scenario moved
mid-run, is marked `modified` and will not sit beside untouched baselines.
`/api/jev/policy` and the simulation stay exactly as they were.

## Deterministic replay

Every accepted policy is recorded with the simulated time it was accepted at. A trace can be
replayed offline with **zero network calls**, and reproduces the same policy sequence and
result for the same scenario with compatible code and Chicago assets. Traces do not yet
bind a code or geography version, so an old trace is not a cross-version replay guarantee:

```bash
pnpm benchmark --controllers jev --jev replay --trace path/to/trace.json
```

A trace whose scenario fingerprint does not match is refused before anything runs. A trace
carrying a policy that live code could not have accepted is refused too: replay may reproduce
an accepted policy, never invent one.

A replay says both that it is a replay **and** what the recorded run was. `--trace-out` writes
the recorded run's own history into the trace (its adapter, accepted/rejected counts, and its
fallback time), so replaying a run that spent time on the Adaptive fallback cannot present
itself as a clean live-Jev result. Traces written before that block existed report
`"recorded": null` means unknown, not clean, and the banner says so.

## Architecture

```
browser
 ├─ components/…            React shell: map, chrome, trip HUD, comparison panel
 ├─ worker/simulation.worker.ts   ALL simulation state: city, demand, engine, frames
 ├─ worker/baselines.worker.ts    Fixed + Adaptive for the same scenario (off-thread)
 └─ POST /api/jev/policy          the ONLY place the service credential exists
        └─ jev/gateway.ts → Vercel AI Gateway (typesafe-ai/jev)
```

- Simulation: framework-independent TypeScript in `sim/` (engine, traffic physics, signals,
  demand, incidents, metrics) and `controllers/` (Fixed, Adaptive, Jev).
- Rendering: MapLibre + deck.gl over frozen Chicago geography; the simulation never touches
  the DOM.
- The worker owns every piece of simulation state. The main thread sends commands and draws
  frames; the UI store holds UI state only.
- The credential is server-side only and travels in an `Authorization` header. It never
  appears in the client bundle, the worker payload, browser state or logs: the browser only
  ever talks to its own origin's relay.

## Running it locally

```bash
pnpm install
cp .env.example .env.local      # then fill in JEV_TOKEN (see below)
pnpm dev                        # http://localhost:3000
```

With no Jev configuration there is no Jev run: the startup gate reports the reason in
plain words, and nothing is simulated in its place.

On Vercel, set `JEV_MODEL=typesafe-ai/jev`. The relay authenticates with the
explicitly configured AI Gateway API key whenever one exists — `AI_GATEWAY_API_KEY`
first, then `JEV_TOKEN` for deployments configured before the standard name — and
falls back to the deployment's request-scoped Vercel OIDC token ONLY when no
explicit key is set. Exactly one credential is ever sent, and every relay
response reports which lane was used as `x-jev-auth: api-key | oidc` (a name,
never any part of the credential), so a gateway 403 can be diagnosed without
guessing. For local runs outside Vercel, provide a valid AI Gateway key in
`.env.local` (never committed):

```
JEV_MODEL=typesafe-ai/jev
AI_GATEWAY_API_KEY=<your local AI Gateway key>
# optional
JEV_MIN_CONFIDENCE=0.25
JEV_TIMEOUT_MS=12000   # the free evaluation tier is variable; a tight
                       # timeout turns slow answers into fallback time
```

`JEV_ENDPOINT` is the alternative backend: a service that speaks the Jev policy schema
directly. The two are never mixed: `JEV_MODEL` selects the gateway.
The policy refresh is scheduled from **wall-clock service capacity**, not from a
simulated constant. `jev/scheduler.ts` spends at most **4 of the 5 requests per ~60 s
window** the AI Gateway advertises for `typesafe-ai/jev` (measured:
`x-ratelimit-limit-requests: 5` on every rejection, with a `retry-after` of 27–60 s) —
one request every 15 s of wall time. At the 8× browser playback that is a fresh policy
every ~120 simulated seconds, which is the freshest stream the measured allowance
sustains. The previous fixed cadence asked for ~24 requests/minute against a 5-per-window
allowance: two thirds of a full run's refreshes came back 429, and the run was
invalidated when no fresh policy arrived before the last one's maximum hold. An explicit
`retry-after` is honoured to the millisecond (the relay forwards it to the browser as a
bounded number), a transient 5xx backs off instead of retrying in a burst, and a
successful answer clears that backoff. The gate is the SESSION's, not the controller's
(`jev/service-budget.ts`): the allowance belongs to the credential the relay holds, so a
rebuilt controller — a reset, a new scenario, the next run — inherits the window the
previous run spent and waits for it, instead of asking as if nothing had been spent. The
startup gate goes through the same schedule: a run whose first request the service cannot
allow inside its bound reports itself unable and sends nothing. Scope, stated honestly:
this keeps ONE session's runs inside the allowance, and it is what the measured 429s came
from; two tabs each hold their own session gate and can still jointly exceed a
credential-wide allowance, so a guarantee across tabs/users would need shared state at the
relay (a durable token bucket) or a Vercel Firewall rule sized to the upstream allowance —
instance-local serverless memory is not a global coordinator and is not presented as one.

A refused or failed request never substitutes anything: the last accepted policy keeps
governing — reported as *held* once it is past its freshness window, bounded by a maximum
hold of four service cadences — and the run reports the time that policy covered as
*held*. A run whose policy outlives that hold is invalidated and says so; it is never
continued under another controller.

That hold exists for a measured reason. The run's last stretch, after the ego
car arrives, is simulated back to back so the visible run covers
the same simulated window as its baselines, and a back-to-back loop never turns
the event loop, so an answer already in flight cannot land. With a one-window
TTL, 26.7% of a 600 s run was attributed to the Adaptive fallback (140 s of it in
that tail) against a model that answered every single request successfully.

For a public deployment, configure a matching Vercel Firewall rate-limit rule and set
`JEV_RATE_LIMIT_ID` to its **Rate Limit API ID**, the handle the rule's condition matches,
printed by `vercel firewall rules inspect <rule>` as `Conditions: rate limit API ID equals
<value>`. Do **not** use the rule's own generated `rule_...` identifier: the CLI accepts it,
and at runtime the SDK's lookup finds no rule, the route logs
`no Vercel Firewall rate-limit rule matches JEV_RATE_LIMIT_ID`, and only the per-instance
budget is active. Environment variables reach the running deployment only on a new
deployment, so redeploy after changing this. The route's in-memory budget is per serverless
instance, not a production-wide cost limit. Verify the rule with
`vercel firewall rules inspect`: repository tests cannot prove it exists. `/api/build`
exposes the deployed commit SHA (or `unknown` when the platform provides no build identity).
The manual Jev production smoke is separate from routine CI and must prove a completed run
used live policy before calling a release live-Jev verified.

## Developer flags

`?debug` (or `?debug=1`) reveals the controls the public flow deliberately hides: the
controller picker and raw seed. Previews on the landing and setup
screens always run the Adaptive controller, so an idle visit never spends live model calls.

## Benchmarks

The same engine, controllers and scenario builders run headlessly, without a browser:

```bash
pnpm benchmark                                     # the default matrix
pnpm benchmark --trip soldier-field-to-navy-pier   # one trip
pnpm benchmark --traffic rush-hour --seed 42       # narrower slices
pnpm benchmark --out results.json                  # write the run document
```

The default matrix is 6 curated trips × 2 traffic levels × 2 seeds × 2 drivers × 2 controllers
(96 runs at a 600 s horizon), aggregated only across compatible groups. JSON output stays
local and gitignored.

Fixed and Adaptive are deterministic. Jev needs a policy source, and **the artifact always says
which one it used**, in the file name, in the document, and in every run record:

```bash
pnpm benchmark --controllers jev --jev mock     # -> benchmark-jev-mock.json     (no model, no network)
pnpm benchmark --controllers jev --jev gateway  # -> benchmark-jev-gateway.json  (real model, not reproducible)
pnpm benchmark --controllers jev --jev live     # -> benchmark-jev-schema-service.json (JEV_ENDPOINT)
pnpm benchmark --controllers jev --jev replay --trace t.json  # -> benchmark-jev-replay.json
```

A mock run is never presentable as a live one: the CLI banner says so in words, the file is
named `jev-mock`, and each record carries `provenance`, the authoritative typed object
(`jev/provenance.ts`) built from the controller's own account of its run:

```json
"provenance": {
  "controller": "jev",
  "label": "jev-mock",
  "adapter": "mock",
  "mode": "live",
  "modelInvolved": false,
  "accepted": 3, "rejected": 2, "refreshes": 5, "expiries": 0,
  "liveMs": 15000, "replayMs": 0, "fallbackMs": 5000,
  "trace": null,
  "recorded": null
}
```

A replay fills in `trace` (what it consumed) and `recorded` (what that run was), and keeps
`modelInvolved` true when the recorded run used a model: replayed offline, still
model-derived. Groups are keyed by controller **and** provenance, so a mock Jev run and a
gateway Jev run of the same scenario are never averaged together.

## Fallback-free completion (per-refresh Jev telemetry)

Jev's policy source can be live, held (the last good policy still governing) or the Adaptive
fallback. `jev/telemetry.ts` records every policy refresh: its wall-clock and simulated
instant, its outcome, a **classified reason** when it was not live (`timeout`, `rate-limited`,
`upstream-5xx`, `transport`, `malformed-json`, `schema-invalid`, `confidence-rejected`,
`stale`, `gap`, `other`), and the policy `field`/`bound` a schema refusal failed. It also
records the simulated time each window spent on each source. Counters cover every refresh;
the recent-event list is bounded; nothing upstream-derived (a body, a header, a token) can
enter it. It is
inspectable after a run from `controller.meta().telemetry` (and via `window.__jevDebug` with
`?debug`, never in the public DOM).

```bash
pnpm test:jev-fallback                            # all six curated trips, mock client, gate
pnpm test:jev-fallback --client relay             # the DEPLOYED relay, exactly as the browser calls it
pnpm test:jev-fallback --client gateway --trips soldier-field-to-navy-pier   # one live run
pnpm test:jev-fallback --mock-fail timeout        # negative control: this MUST fail
```

The harness drives each curated trip to the full horizon through the same world seam the app
uses and **fails unless every route was fallback-free**: zero fallback windows and zero
failure-attributed fallback time. The only fallback time it allows is the structural opening
gap (a policy is in force from the tick after it is accepted), reported by name and never
allowed to grow. Trip completion is reported in its own section: an unfinished trip is not a
fallback, and `--require-completion` makes it fail the gate too. Live clients are capped at 3
routes per invocation (`--live-run-budget`), so an invocation cannot quietly spend the quota.

## Commands

```bash
pnpm dev          # dev server
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # production build
pnpm test:browser # production-mode browser journey with mocked relay, no live quota
pnpm benchmark    # headless benchmark harness
pnpm test:jev-fallback  # fallback-free completion gate over all six curated trips
```

The detailed product requirements live in `docs/` and are intentionally local-only.
