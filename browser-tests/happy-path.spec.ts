import { expect, test, type Page } from "@playwright/test";
import type { PresentationPolicy } from "../worker/presentation-snapshot";
import { checkLiveJevParticipation } from "../scripts/jev-participation-check";

async function journey(page: Page, relayStatus: 200 | 503) {
  const assets = new Set<string>();
  page.on("response", (response) => {
    if (response.url().includes("/chicago/") && response.ok()) assets.add(new URL(response.url()).pathname);
  });
  await page.route("**/api/jev/policy", async (route) => {
    if (relayStatus === 503) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: { schemaVersion: 1, pressureScale: 1, hint: "neutral", corridorWeights: [], regionWeights: [], corridorIntents: [], regionIntents: [] },
        clamped: [],
      }),
    });
  });

  const root = await page.goto("/?debug=1");
  expect(root?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Jev Traffic Simulator" })).toBeVisible();
  await expect.poll(() => assets.has("/chicago/metro.json")).toBe(true);
  await expect.poll(async () => page.evaluate(() => Boolean((window as Window & { __jevDebug?: { snapshot?: unknown } }).__jevDebug?.snapshot))).toBe(true);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByLabel("Chicago trip")).toBeVisible();
  await page.getByRole("button", { name: "Enter City" }).click();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    Boolean((window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap?.vehicles()[0]),
  )).toBe(true);
  const first = await page.evaluate(() =>
    (window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap!.vehicles()[0],
  );
  await page.evaluate((position) => {
    (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo = position;
  }, first);
  await expect.poll(async () => page.evaluate(() => {
    const current = (window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap?.vehicles()[0];
    return current ? Math.hypot(current.x - (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo!.x,
      current.y - (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo!.y) : 0;
  }), { timeout: 30_000 }).toBeGreaterThan(0.1);
  // The comparison panel itself is the signal: it renders once the run's window
  // has closed and its baselines are in (the heading alone only says "complete").
  await expect(page.locator("[data-jev-label]")).toBeVisible({ timeout: 100_000 });
  // The arrival keeps the street framing. Pulling the camera back to a
  // city-wide view on completion was tried and removed: the result belongs over
  // the car, not over a mostly-empty lake (measured 13.6 before, 15.4 now).
  await expect.poll(async () => page.evaluate(() =>
    (window as Window & { __jevMapInstance?: { getZoom: () => number } }).__jevMapInstance?.getZoom() ?? 0,
    // Still the street framing (the follow preset is 15.0), and still far from
    // the city-wide view the arrival used to pull back to.
  )).toBeGreaterThan(14.5);
  await expect(page.getByRole("status", { name: "Trip" })).toBeHidden();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeHidden();
  await expect(page.getByRole("button", { name: "+5× Traffic" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Following the car" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeHidden();
  const panel = page.locator("[data-jev-provenance]");
  await expect(panel).toBeVisible();
  const payoffBox = await page.locator(".surface-overlay").filter({ hasText: "Run complete" }).boundingBox();
  expect(payoffBox).not.toBeNull();
  expect(Math.abs(payoffBox!.x + payoffBox!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(3);
  const policy = JSON.parse((await panel.getAttribute("data-jev-provenance")) ?? "null") as PresentationPolicy;
  const label = (await panel.getAttribute("data-jev-label")) ?? "";
  const simulatedMs = Number(await panel.getAttribute("data-simulated-ms"));
  expect(assets.has("/chicago/metadata.json")).toBe(true);
  expect(assets.has("/chicago/metro.json")).toBe(true);
  return { policy, label, simulatedMs, first };
}

test("happy path completes and accounts for mocked live Jev without network quota", async ({ page }) => {
  // The browser contract is real; only the external model boundary is mocked.
  const result = await journey(page, 200);
  expect(result.policy.accepted).toBeGreaterThan(0);
  checkLiveJevParticipation(result.policy, result.label, result.simulatedMs);
  // The run's own per-refresh record is inspectable AFTER it finished, and only
  // behind ?debug: counters for every refresh window, plus a bounded list of the
  // most recent ones (jev/telemetry.ts). It is never rendered into the page.
  const telemetry = await page.evaluate(() =>
    (window as Window & {
      __jevDebug?: {
        telemetry?: { total: number; outcomes: Record<string, number>; recent: unknown[] } | null;
      };
    }).__jevDebug?.telemetry ?? null,
  );
  expect(telemetry).not.toBeNull();
  expect(telemetry!.total).toBeGreaterThan(0);
  expect(telemetry!.outcomes.live).toBeGreaterThan(0);
  // The mocked relay answers every refresh: no window may go ungoverned, and
  // the record is what says so. (The accelerated tail holds the last policy and
  // asks for nothing, which is why its windows are HELD.)
  expect(telemetry!.outcomes.ungoverned).toBe(0);
  expect(telemetry!.recent.length).toBeLessThanOrEqual(64);
  const identity = await page.request.get("/api/build");
  expect(identity.ok()).toBe(true);
  expect((await identity.json() as { commit: string }).commit).toMatch(/^[a-f0-9]{40}$/);
});

test("a relay that cannot answer starts NO run: no Jev result is produced", async ({ page }) => {
  await page.route("**/api/jev/policy", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
  });
  await page.goto("/?debug=1");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Enter City" }).click();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeVisible();

  // The startup gate never passes: the run does not begin, nothing is
  // substituted for Jev, and the reason is shown in plain words.
  await expect(page.getByText(/This run did not start/)).toBeVisible({ timeout: 30_000 });
  // No payoff, no comparison, no provenance panel: this run produced no result.
  await expect(page.locator("[data-jev-label]")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Run complete" })).toBeHidden();
  const telemetry = await page.evaluate(() =>
    (window as Window & { __jevDebug?: { telemetry?: unknown } }).__jevDebug?.telemetry ?? null,
  );
  expect(telemetry).toBeNull();
  // And no simulated time was advanced behind the wait.
  const timeMs = await page.evaluate(() =>
    (window as Window & { __jevDebug?: { snapshot?: { timeMs?: number } } }).__jevDebug?.snapshot?.timeMs ?? 0,
  );
  expect(timeMs).toBe(0);
});

test("mobile trip HUD and incident controls stay inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?debug=1");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("radio", { name: "Adaptive" }).click();
  await page.getByRole("button", { name: "Enter City" }).click();
  const hud = page.getByRole("status", { name: "Trip" });
  const lastControl = page.getByRole("button", { name: "Event Lets Out" });
  const following = page.getByRole("button", { name: "Following the car" });
  const scenario = page.getByRole("button", { name: "Scenario" });
  await expect(hud).toBeVisible();
  await expect(lastControl).toBeVisible();
  await expect(following).toBeVisible();
  await expect(scenario).toBeVisible();
  const hudBox = await hud.boundingBox();
  const firstControlBox = await page.getByRole("button", { name: "+5× Traffic" }).boundingBox();
  const lastControlBox = await lastControl.boundingBox();
  const followingBox = await following.boundingBox();
  const scenarioBox = await scenario.boundingBox();
  expect(hudBox && firstControlBox && lastControlBox && followingBox && scenarioBox).toBeTruthy();
  expect(lastControlBox!.x + lastControlBox!.width).toBeLessThanOrEqual(390);
  expect(followingBox!.x + followingBox!.width).toBeLessThanOrEqual(390);
  expect(scenarioBox!.x + scenarioBox!.width).toBeLessThanOrEqual(390);
  expect(scenarioBox!.x).toBeGreaterThanOrEqual(followingBox!.x + followingBox!.width);
  expect(hudBox!.y + hudBox!.height).toBeLessThan(firstControlBox!.y);
  // Readability pass (Issue #46): larger chrome type must not push the page
  // sideways. 390 px is the narrowest viewport the product supports.
  const liveOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(liveOverflow).toBeLessThanOrEqual(0);
  // The comparison panel itself is the signal: it renders once the run's window
  // has closed and its baselines are in (the heading alone only says "complete").
  await expect(page.locator("[data-jev-label]")).toBeVisible({ timeout: 100_000 });
  // The arrival keeps the street framing. Pulling the camera back to a
  // city-wide view on completion was tried and removed: the result belongs over
  // the car, not over a mostly-empty lake (measured 13.6 before, 15.4 now).
  await expect.poll(async () => page.evaluate(() =>
    (window as Window & { __jevMapInstance?: { getZoom: () => number } }).__jevMapInstance?.getZoom() ?? 0,
    // Still the street framing (the follow preset is 15.0), and still far from
    // the city-wide view the arrival used to pull back to.
  )).toBeGreaterThan(14.5);
  const payoff = page.locator(".surface-overlay").filter({ hasText: "Run complete" });
  const box = await payoff.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  // The full comparison table is the widest public surface: open it and check it
  // still fits the phone (Issue #46 enlarged the type on every row).
  await page.getByRole("button", { name: "See details" }).click();
  await expect(page.getByText("Same scenario, same demand")).toBeVisible();
  const payoffOverflow = await payoff.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(payoffOverflow).toBeLessThanOrEqual(1);
  const arrivalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(arrivalOverflow).toBeLessThanOrEqual(0);
  await expect(lastControl).toBeHidden();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeHidden();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeHidden();
});
