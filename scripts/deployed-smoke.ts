/**
 * Deployed smoke test: drives the PUBLIC experience in a real browser.
 *
 * Usage
 *   node --experimental-strip-types ... no: this repo runs TS via tsx
 *   npx tsx scripts/deployed-smoke.ts [url]
 *
 * Needs a Chromium CDP endpoint (default http://127.0.0.1:9223); see the
 * screenshot tooling for how to launch one. Nothing here writes to the
 * deployment — it only observes.
 *
 * Drives the PUBLIC experience in a real browser against production and asserts
 * what the release actually promises: the page loads without login, the Chicago
 * assets arrive, the challenge starts, the app calls its own relay successfully,
 * the run finishes, and the payoff shows Fixed, Adaptive and the visible run on
 * ONE scenario fingerprint with the third column named for whoever governed it.
 *
 * Reports facts only; nothing here writes to the deployment.
 */
import puppeteer from "puppeteer-core";
import type { PresentationPolicy } from "../worker/presentation-snapshot";
import { checkLiveJevParticipation } from "./jev-participation-check";

const URL = process.argv[2] ?? "https://jevtrafficsim.vercel.app";

interface RelayCall {
  status: number | null;
  ok: boolean;
  ms: number;
}

async function main(): Promise<void> {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9223",
    protocolTimeout: 600_000,
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  /**
   * Body text arrives with CSS applied, and this UI renders its small labels in
   * uppercase ("TRIP", "JEV TRAFFIC · CHICAGO", "SAME SCENARIO · THREE RUNS").
   * Every text assertion below is therefore case-insensitive — matching the
   * source strings instead was how this probe once reported the setup screen as
   * missing its fields and the payoff panel as never appearing.
   */
  const has = (text: string, needle: string): boolean =>
    text.toUpperCase().includes(needle.toUpperCase());

  /** Clickable controls only: a descriptive line is not a picker. */
  const buttonLabels = async (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map((element) =>
        (element as HTMLElement).innerText.trim(),
      ),
    );

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const relays: RelayCall[] = [];
  const relayStarted = new Map<string, number>();

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push("browser console error");
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(request.resourceType());
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/jev/policy")) {
      relayStarted.set(request.url(), Date.now());
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/jev/policy")) {
      relays.push({
        status: response.status(),
        ok: response.ok(),
        ms: Date.now() - (relayStarted.get(url) ?? Date.now()),
      });
    }
  });

  console.log("--- load ---");
  const response = await page.goto(URL, { waitUntil: "networkidle2", timeout: 120_000 });
  console.log("page status:", response?.status());
  console.log("title:", await page.title());

  const text = async (): Promise<string> => page.evaluate(() => document.body.innerText);
  const start = await text();
  console.log("landing shows the thesis:", has(start, "while Jev runs the signals"));
  console.log("chicago assets requested:", await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("/chicago/")),
  ));

  console.log("--- start the challenge ---");
  const clickText = async (label: string): Promise<boolean> =>
    page.evaluate((wanted) => {
      const elements = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
      const target = elements.find((element) => element.innerText.trim().toUpperCase() === wanted.toUpperCase());
      if (!target) {
        return false;
      }
      target.click();
      return true;
    }, label);

  console.log("Start clicked:", await clickText("Start"));
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const setup = await text();
  console.log(
    "setup shows Trip/Traffic/Driver:",
    has(setup, "Trip") && has(setup, "Traffic") && has(setup, "Driver"),
  );
  const setupButtons = await buttonLabels();
  console.log(
    "setup has no controller picker:",
    !setupButtons.some((label) => /^(Fixed|Adaptive|Jev)$/i.test(label)),
  );
  console.log("setup shows no raw seed:", !has(setup, "Seed"));

  console.log("Enter City clicked:", await clickText("Enter City"));
  // The challenge runs at 8x; a 600 s horizon is ~75 s of wall time.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const live = await text();
  console.log("live chrome present:", has(live, "Jev Traffic · Chicago"));
  console.log("signals provenance line:", (live.match(/Signals\s*\n?\s*([^\n]+)/) ?? [])[1] ?? "(none)");
  console.log("scenario fingerprint shown:", /Scenario/.test(live));

  console.log("--- relay calls so far ---");
  console.log("requests:", relays.length, "| statuses:", relays.map((call) => call.status).join(","));
  const accepted = relays.filter((call) => call.ok).length;
  console.log("successful relay answers:", accepted);

  console.log("--- wait for the run to finish (the payoff) ---");
  // Up to 3 minutes: the horizon plus the baselines finishing in their worker.
  let comparison = "";
  for (let waited = 0; waited < 24; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 7_500));
    const body = await text();
    // The payoff leads with one sentence and the three race rows; the full
    // same-scenario table is deliberately collapsed behind See details.
    if (has(body, "See details") && has(body, "Fixed") && has(body, "Adaptive")) {
      comparison = body;
      break;
    }
  }
  if (comparison === "") {
    throw new Error("comparison panel did not appear");
  } else {
    if (!await clickText("See details")) throw new Error("comparison details did not open");
    await new Promise((resolve) => setTimeout(resolve, 350));
    comparison = await text();
    if (!has(comparison, "Same scenario")) throw new Error("comparison details did not appear");
    const columns = (comparison.match(/Same scenario · three runs\s*\n\s*([0-9a-f]{8})\s*\n\s*([^\n]*)\n([^\n]*)\n([^\n]*)/i) ?? []).slice(1);
    console.log("payoff fingerprint:", columns[0] ?? "(none)");
    console.log("payoff column headers:", columns.slice(1).join(" | "));
    const rows = comparison
      .split("\n")
      .filter((line) =>
        /^(Arrived|Trip time|Stopped|Distance|Avg speed|Reroutes|Avg wait|P95 wait|Trips done|Throughput|Gridlock|Active cars)/i.test(
          line,
        ),
      );
    console.log("payoff rows found:", rows.length);
    for (const row of rows.slice(0, 6)) {
      console.log("   ", row.replace(/\s+/g, " "));
    }
    const detailLine = comparison.match(/[0-9]+ policies?/i);
    console.log("provenance detail:", detailLine?.[0] ?? "(none)");
    const run = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>("[data-jev-provenance]");
      return element === null ? null : {
        provenance: element.dataset.jevProvenance ?? "",
        label: element.dataset.jevLabel ?? "",
        simulatedMs: Number(element.dataset.simulatedMs),
      };
    });
    if (run === null) throw new Error("completed run has no public provenance");
    let policy: PresentationPolicy;
    try {
      policy = JSON.parse(run.provenance) as PresentationPolicy;
    } catch {
      throw new Error("completed run has malformed provenance");
    }
    checkLiveJevParticipation(policy, run.label, run.simulatedMs);
    console.log("live Jev participation: PASS");
  }

  console.log("--- relay calls, whole run ---");
  const statuses = relays.map((call) => call.status);
  console.log("total:", relays.length, "| ok:", relays.filter((call) => call.ok).length, "| statuses:", statuses.join(","));
  if (relays.length > 0) {
    const slowest = relays.reduce((max, call) => Math.max(max, call.ms), 0);
    console.log("slowest relay round trip:", slowest, "ms");
  }

  console.log("--- console errors ---");
  console.log(consoleErrors.length === 0 ? "none" : `${consoleErrors.length} browser console errors`);
  console.log("--- failed requests ---");
  console.log(failedRequests.length === 0 ? "none" : `${failedRequests.length} failed requests`);

  await context.close();
  browser.disconnect();
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error && /^(comparison panel|comparison details|completed run|run has|invalid policy|policy outcomes|governed time|public label|zero accepted|no live Jev)/.test(error.message)
    ? error.message
    : "browser smoke failed";
  console.error(`Deployed smoke FAILED: ${reason}`);
  process.exitCode = 1;
});
