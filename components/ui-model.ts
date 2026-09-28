/**
 * UI model (Task 11 visual correction): pure option lists and seed handling
 * for the onboarding/config surfaces. Testable without a DOM.
 */
import type { IncidentKind } from "@/sim/incidents";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { ControllerChoice, PlaybackSpeed } from "@/worker/protocol";
import { PLAYBACK_SPEEDS } from "@/worker/protocol";
import { DRIVER_DESCRIPTIONS, type DriverStrategy } from "@/sim/driver";
import { CURATED_TRIPS } from "@/cities/chicago-trips";
import {
  ungovernedShare,
  type PresentationPolicy,
  type PresentationTripProgress,
} from "@/worker/presentation-snapshot";
import type { JevCause } from "@/jev/runtime";
import type { ChallengeResult } from "@/worker/challenge-result";

export interface ScaleOption {
  readonly value: CitySize;
  readonly label: string;
  readonly description: string;
}

/** Five nested scales of ONE showcase city, in onboarding order. */
export const CITY_SIZE_OPTIONS: readonly ScaleOption[] = [
  { value: "small", label: "Tiny", description: "Loop core" },
  { value: "small-medium", label: "Small", description: "Loop + river edge" },
  { value: "medium", label: "Medium", description: "Downtown + Grant Park" },
  { value: "medium-large", label: "Large", description: "Expressways + West Loop" },
  { value: "large", label: "Metro", description: "Central Chicago" },
];

export const TRAFFIC_OPTIONS: readonly { value: TrafficLevel; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "everyday", label: "Everyday" },
  { value: "rush-hour", label: "Rush Hour" },
];

/**
 * Controller choices — a DEVELOPER control (Issue #15).
 *
 * The product's setup does not ask which controller to run: the visible run is
 * Jev and the Fixed/Adaptive baselines are computed beside it for the same
 * scenario. Choosing a controller by hand is only useful when working on the
 * simulation, so this list lives behind `?debug`.
 */
export const CONTROLLER_OPTIONS: readonly { value: ControllerChoice; label: string }[] = [
  { value: "fixed", label: "Fixed" },
  { value: "adaptive", label: "Adaptive" },
  { value: "jev", label: "Jev" },
];

/**
 * Developer controls are opt-in: `?debug` in the URL (or `?debug=1`). Parsed
 * rather than searched so `?nodebug` cannot switch anything on.
 */
export function debugMode(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key === "debug" && value !== "0" && value !== "false") {
      return true;
    }
  }
  return false;
}

/** Driver choices for the setup control (issue #28). */
export const DRIVER_OPTIONS: readonly { value: DriverStrategy; label: string }[] = [
  { value: "tourist", label: "Tourist" },
  { value: "local", label: "Local" },
];

export function citySizeLabel(value: CitySize): string {
  return CITY_SIZE_OPTIONS.find((option) => option.value === value)?.label ?? "Medium";
}

export function citySizeDescription(value: CitySize): string {
  return CITY_SIZE_OPTIONS.find((option) => option.value === value)?.description ?? "";
}

export function trafficLabel(value: TrafficLevel): string {
  return TRAFFIC_OPTIONS.find((option) => option.value === value)?.label ?? "Everyday";
}

export function scaleIndexForSize(value: CitySize): number {
  const index = CITY_SIZE_OPTIONS.findIndex((option) => option.value === value);
  return index === -1 ? 2 : index;
}

export function sizeForScaleIndex(index: number): CitySize {
  const clamped = Math.min(Math.max(Math.floor(index), 0), CITY_SIZE_OPTIONS.length - 1);
  return CITY_SIZE_OPTIONS[clamped].value;
}

/** Accepts messy input; always returns a valid uint32 seed. */
export function normalizeSeed(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed >>> 0;
}

/** Deterministic helper for the dice: any [0,1) source becomes a uint32. */
export function seedFromRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    return 0;
  }
  return Math.floor(value * 0x100000000) >>> 0;
}

/**
 * UI randomness is allowed here (never in simulation logic): the resulting
 * explicit seed is shown and fully reproducible.
 */
export function diceSeed(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] >>> 0;
  }
  return seedFromRandom(() => Date.now() % 1000 / 1000);
}

/** Formats metric durations for the HUD: 27.4s / 1m 08s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms - minutes * 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatThroughput(perMinute: number): string {
  if (!Number.isFinite(perMinute) || perMinute < 0) {
    return "—";
  }
  return `${Math.round(perMinute)}/min`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return "—";
  }
  return `${Math.round(ratio * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* Trip HUD (Issue #25)                                                */
/* ------------------------------------------------------------------ */

/** "740 m" up to a kilometre, then "7.4 km". */
/**
 * US customary units: this is Chicago. Distances read in feet up to a quarter
 * mile, then in miles; the simulation stays in metres internally, so this is
 * presentation only.
 */
const METRES_PER_FOOT = 0.3048;
const METRES_PER_MILE = 1609.344;
/** Below this, feet are the honest unit (a quarter mile). */
const FEET_LIMIT_M = METRES_PER_MILE / 4;

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) {
    return "0 ft";
  }
  if (metres < FEET_LIMIT_M) {
    return `${Math.round(metres / METRES_PER_FOOT)} ft`;
  }
  return `${(metres / METRES_PER_MILE).toFixed(1)} mi`;
}

/** m/s -> mph, the unit a person reads speed in. */
export function formatSpeed(metresPerSecond: number): string {
  if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) {
    return "0 mph";
  }
  return `${Math.round((metresPerSecond / METRES_PER_MILE) * 3600)} mph`;
}

export type TripStateLabel = "Moving" | "Stopped" | "Arrived" | "Waiting";

/**
 * One place maps simulation state to the word the HUD shows, so the header
 * chip can never disagree with the numbers underneath it.
 */
export function tripStateLabel(egoState: string | null, completed: boolean): TripStateLabel {
  if (completed) {
    return "Arrived";
  }
  if (egoState === "queued") {
    return "Stopped";
  }
  if (egoState === "pending") {
    return "Waiting";
  }
  return "Moving";
}

export interface TripHudRow {
  readonly label: string;
  readonly value: string;
}

export interface TripHudView {
  readonly tripId: string;
  readonly tripName: string;
  readonly state: TripStateLabel;
  readonly completed: boolean;
  readonly rows: readonly TripHudRow[];
}

export interface TripHudInput {
  readonly trip: PresentationTripProgress | null;
  readonly egoState: string | null;
  readonly egoSpeedMps: number;
}

/**
 * The trip HUD is a pure read of the presentation frame: every value below is
 * a field the worker computed, formatted — no derived guesswork that could
 * drift from the map.
 */
export function tripHudView(input: TripHudInput): TripHudView | null {
  const { trip } = input;
  if (!trip) {
    return null;
  }
  const name = CURATED_TRIPS.find((candidate) => candidate.id === trip.tripId)?.label ?? trip.tripId;
  const cleared = `${trip.intersectionsCleared} / ${trip.routeRoadIds.length}`;
  return {
    tripId: trip.tripId,
    tripName: name,
    state: tripStateLabel(input.egoState, trip.completed),
    completed: trip.completed,
    rows: [
      { label: "Elapsed", value: formatDuration(trip.tripTimeMs) },
      { label: "Remaining", value: formatDistance(trip.distanceRemainingM) },
      { label: "Speed", value: formatSpeed(input.egoSpeedMps) },
      { label: "Stopped", value: formatDuration(trip.waitTimeMs) },
      { label: "Cleared", value: cleared },
      {
        label: "Est. remaining",
        value:
          trip.completed || trip.estimatedRemainingMs === null
            ? "—"
            : formatDuration(trip.estimatedRemainingMs),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Comparison (Issue #28)                                              */
/* ------------------------------------------------------------------ */

/**
 * One comparison row, three columns: the two deterministic baselines and the
 * run the user actually watched. Every cell is a field of a real run, formatted
 * — the panel never computes an outcome the runs did not produce.
 */
export interface ComparisonRow {
  readonly label: string;
  readonly fixed: string;
  readonly adaptive: string;
  readonly jev: string;
}

/** Column order of the comparison, and the word used for the visible run. */
export const COMPARISON_COLUMNS = ["Fixed", "Adaptive", "Jev"] as const;

/**
 * The compact comparison table: your trip first, then Chicago. Every value is
 * a field of the two results, formatted — the panel never computes anything the
 * runs did not produce.
 */
/** A run that never arrived did not have a trip time. */
function tripTime(result: ChallengeResult): string {
  return result.trip.completed ? formatDuration(result.trip.tripTimeMs) : "—";
}

export function comparisonRows(
  fixed: ChallengeResult,
  adaptive: ChallengeResult,
  jev: ChallengeResult,
): readonly ComparisonRow[] {
  const arrived = (result: ChallengeResult) => (result.trip.completed ? "Yes" : "No");
  return [
    { label: "Arrived", fixed: arrived(fixed), adaptive: arrived(adaptive), jev: arrived(jev) },
    { label: "Trip time", fixed: tripTime(fixed), adaptive: tripTime(adaptive), jev: tripTime(jev) },
    {
      label: "Stopped",
      fixed: formatDuration(fixed.trip.stoppedMs),
      adaptive: formatDuration(adaptive.trip.stoppedMs),
      jev: formatDuration(jev.trip.stoppedMs),
    },
    {
      label: "Distance",
      fixed: formatDistance(fixed.trip.distanceM),
      adaptive: formatDistance(adaptive.trip.distanceM),
      jev: formatDistance(jev.trip.distanceM),
    },
    {
      label: "Avg speed",
      fixed: formatSpeed(fixed.trip.averageSpeedMps),
      adaptive: formatSpeed(adaptive.trip.averageSpeedMps),
      jev: formatSpeed(jev.trip.averageSpeedMps),
    },
    {
      label: "Reroutes",
      fixed: String(fixed.trip.rerouteCount),
      adaptive: String(adaptive.trip.rerouteCount),
      jev: String(jev.trip.rerouteCount),
    },
    {
      label: "Avg wait",
      fixed: formatDuration(fixed.city.averageWaitMs),
      adaptive: formatDuration(adaptive.city.averageWaitMs),
      jev: formatDuration(jev.city.averageWaitMs),
    },
    {
      label: "P95 wait",
      fixed: formatDuration(fixed.city.p95WaitMs),
      adaptive: formatDuration(adaptive.city.p95WaitMs),
      jev: formatDuration(jev.city.p95WaitMs),
    },
    {
      label: "Trips done",
      fixed: fixed.city.completedTrips.toLocaleString("en-US"),
      adaptive: adaptive.city.completedTrips.toLocaleString("en-US"),
      jev: jev.city.completedTrips.toLocaleString("en-US"),
    },
    {
      label: "Throughput",
      fixed: formatThroughput(fixed.city.throughputPerMinute),
      adaptive: formatThroughput(adaptive.city.throughputPerMinute),
      jev: formatThroughput(jev.city.throughputPerMinute),
    },
    {
      label: "Queued time",
      fixed: formatPercent(fixed.city.gridlockRatio),
      adaptive: formatPercent(adaptive.city.gridlockRatio),
      jev: formatPercent(jev.city.gridlockRatio),
    },
    {
      label: "Active cars",
      fixed: fixed.city.activeVehicles.toLocaleString("en-US"),
      adaptive: adaptive.city.activeVehicles.toLocaleString("en-US"),
      jev: jev.city.activeVehicles.toLocaleString("en-US"),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Baselines (Issue #15)                                               */
/* ------------------------------------------------------------------ */

/** Past this long with no baselines, the run asks for them once more. */
export const BASELINES_REGRACE_MS = 60_000;

export interface BaselineWait {
  readonly runComplete: boolean;
  readonly hasBaselines: boolean;
  readonly fingerprint: string | null;
  /** Which fingerprint was last asked for, and when. */
  readonly askedFingerprint: string | null;
  readonly msSinceAsk: number;
  readonly alreadyReasked: boolean;
}

/**
 * The payoff needs two headless runs that are computed off-thread. A dispatch
 * can be lost without the page ever learning (a worker that never answers), and
 * then the comparison would simply never appear. So: if the run has finished,
 * the scenario's baselines are still missing well past the time they take, and
 * this scenario has not been re-asked yet, ask once more. Idempotent — the
 * baselines are a pure function of the scenario — and bounded to one extra ask.
 */
export function shouldReaskBaselines(wait: BaselineWait): boolean {
  if (!wait.runComplete || wait.hasBaselines || wait.alreadyReasked) {
    return false;
  }
  if (wait.fingerprint === null || wait.askedFingerprint !== wait.fingerprint) {
    return false;
  }
  return wait.msSinceAsk >= BASELINES_REGRACE_MS;
}

/* ------------------------------------------------------------------ */
/* The race (shipping pass)                                            */
/* ------------------------------------------------------------------ */

/**
 * One competitor's headline: the time the trip took.
 *
 * A visitor wants one answer — who got there faster — so the payoff leads with
 * three of these and one factual sentence, and keeps the engineering underneath
 * a disclosure. No score, no winner ranking, no claim that any controller is
 * universally better: only what this run measured.
 */
export interface RaceEntry {
  readonly key: "jev" | "adaptive" | "fixed";
  readonly label: string;
  readonly tripTimeMs: number;
  readonly formatted: string;
  /** True for the run the user actually watched. */
  readonly live: boolean;
  /** The car never arrived within the horizon. */
  readonly incomplete: boolean;
}

export function raceEntries(
  fixed: ChallengeResult,
  adaptive: ChallengeResult,
  live: ChallengeResult,
  liveLabel: string,
): readonly RaceEntry[] {
  return [
    {
      key: "jev",
      label: liveLabel,
      tripTimeMs: live.trip.tripTimeMs,
      formatted: formatRaceTime(live.trip.tripTimeMs),
      live: true,
      incomplete: !live.trip.completed,
    },
    {
      key: "adaptive",
      label: "Adaptive",
      tripTimeMs: adaptive.trip.tripTimeMs,
      formatted: formatRaceTime(adaptive.trip.tripTimeMs),
      live: false,
      incomplete: !adaptive.trip.completed,
    },
    {
      key: "fixed",
      label: "Fixed",
      tripTimeMs: fixed.trip.tripTimeMs,
      formatted: formatRaceTime(fixed.trip.tripTimeMs),
      live: false,
      incomplete: !fixed.trip.completed,
    },
  ];
}

/** m:ss, the unit a visitor reads a race in. */
export function formatRaceTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface RaceDelta {
  /** One factual sentence about the measured difference, never a judgement. */
  readonly text: string;
  /** Positive when the watched run was quicker than the yardstick. */
  readonly deltaMs: number;
  readonly comparedWith: "Adaptive" | "Fixed" | null;
}

/**
 * The single sentence under the times. The yardstick is Adaptive — the strong
 * local baseline — so the comparison says the most it can say: how this run did
 * against the controller it is supposed to be different from.
 */
export function raceDelta(
  entries: readonly RaceEntry[],
  liveLabel: string,
): RaceDelta | null {
  const live = entries.find((entry) => entry.live);
  const adaptive = entries.find((entry) => entry.key === "adaptive");
  const fixed = entries.find((entry) => entry.key === "fixed");
  const yardstick = adaptive ?? fixed;
  if (live === undefined || yardstick === undefined) {
    return null;
  }
  if (live.incomplete) {
    return {
      text: `${liveLabel} did not finish the trip within the run.`,
      deltaMs: 0,
      comparedWith: null,
    };
  }
  if (yardstick.incomplete) {
    return {
      text: `${yardstick.label} did not finish the trip within the run.`,
      deltaMs: 0,
      comparedWith: null,
    };
  }
  const deltaMs = yardstick.tripTimeMs - live.tripTimeMs;
  const seconds = Math.abs(Math.round(deltaMs / 1000));
  if (seconds === 0) {
    return {
      text: `${liveLabel} and ${yardstick.label} arrived within a second of each other.`,
      deltaMs,
      comparedWith: yardstick.key === "adaptive" ? "Adaptive" : "Fixed",
    };
  }
  const faster = deltaMs > 0;
  return {
    text:
      `${liveLabel} finished ${seconds}s ${faster ? "faster" : "slower"} than ` +
      `${yardstick.label}.`,
    deltaMs,
    comparedWith: yardstick.key === "adaptive" ? "Adaptive" : "Fixed",
  };
}

/* ------------------------------------------------------------------ */
/* Altered runs (the numbers are shown, marked)                        */
/* ------------------------------------------------------------------ */

/**
 * The marker an altered run's numbers are shown under.
 *
 * The owner's rule is that the comparison stays visible when a run was changed
 * by hand, so the numbers are no longer withheld — but nothing here may soften
 * what that means. `title` is the state, `detail` is what changed in the run's
 * own words (which instrument, and when), and `boundary` is why the numbers
 * underneath are real and still not a comparison.
 */
export interface AlteredRunNotice {
  readonly title: string;
  readonly detail: string;
  readonly boundary: string;
}

/**
 * The instruments, named exactly as the dock's own buttons name them: the marker
 * must not describe the intervention with a different word than the one the user
 * pressed.
 */
const INTERVENTION_LABELS: Record<IncidentKind, string> = {
  "traffic-burst": "+5× Traffic",
  crash: "Crash",
  "close-road": "Close Road",
  "bridge-closed": "Bridge Closed",
  "event-release": "Event Lets Out",
};

export const ALTERED_RUN_TITLE = "Altered by hand";
export const ALTERED_SCENARIO_TITLE = "Scenario changed mid-run";
/** The run's own record of an intervention, or the count when only that exists. */
export const ALTERED_INTERVENTIONS_LEAD = "Fired during this run: ";
export const ALTERED_SCENARIO_LINE = "A setting changed mid-run.";
export const ALTERED_RUN_BOUNDARY =
  "Fixed and Adaptive ran the clean scenario, so the numbers below are not comparable.";
/** The comparison's footer, in the two shapes the panel can honestly take. */
export const COMPARISON_FOOTER =
  "Same scenario, same demand, same incidents, same driver. Only the signals differ.";
export const ALTERED_COMPARISON_FOOTER =
  "Same scenario, same automatic incidents, same driver. The changes made by " +
  "hand during this run are not in the Fixed and Adaptive runs.";

/**
 * What the panel must say about this run, or null when nobody altered it.
 *
 * Read from the run's own record — the worker's count of hand-fired incidents,
 * the concrete entries the engine queued (kind and simulated time), and the
 * mid-run-change flag — so it cannot name an intervention that did not happen.
 * With no entries to name it falls back to the count it was given, and with
 * neither it says nothing at all.
 */
export function alteredRunNotice(live: ChallengeResult): AlteredRunNotice | null {
  const byHand = live.manualIncidents > 0;
  if (!byHand && !live.modified) {
    return null;
  }
  const lines: string[] = [];
  if (byHand) {
    const fired = live.interventions ?? [];
    lines.push(
      fired.length > 0
        ? ALTERED_INTERVENTIONS_LEAD +
            fired
              .map(
                (intervention) =>
                  `${INTERVENTION_LABELS[intervention.kind]} at ${formatRaceTime(intervention.atMs)}`,
              )
              .join(", ") +
            "."
        : `${ALTERED_INTERVENTIONS_LEAD}${live.manualIncidents} intervention${
            live.manualIncidents === 1 ? "" : "s"
          }.`,
    );
  }
  if (live.modified) {
    lines.push(ALTERED_SCENARIO_LINE);
  }
  return {
    title: byHand ? ALTERED_RUN_TITLE : ALTERED_SCENARIO_TITLE,
    detail: lines.join(" "),
    boundary: ALTERED_RUN_BOUNDARY,
  };
}

/* ------------------------------------------------------------------ */
/* Runs of another scenario (the numbers are still shown)              */
/* ------------------------------------------------------------------ */

/**
 * Whether the baselines describe a different world than the live run.
 *
 * The guard's refusal stands — three results of two scenarios are not a
 * comparison — and this only decides how that refusal LOOKS: the numbers are
 * real and still worth showing, so the panel shows them under one short line
 * saying what they are not. Read from the results' own fingerprints, never from
 * a reason string, so it cannot describe a state the runs are not in.
 */
export function baselinesFromAnotherScenario(
  fixed: ChallengeResult,
  adaptive: ChallengeResult,
  live: ChallengeResult,
): boolean {
  return fixed.fingerprint !== live.fingerprint || adaptive.fingerprint !== live.fingerprint;
}

/** The marker a run of another scenario is shown under. */
export const DIFFERENT_SCENARIO_TITLE = "Different scenario";
export const DIFFERENT_SCENARIO_LINE =
  "Fixed and Adaptive ran a different scenario. These times are not directly comparable.";
/** The details footer for that shape: the clean run's claim would be false here. */
export const DIFFERENT_SCENARIO_FOOTER =
  "This run and the Fixed and Adaptive runs played different scenarios.";

/**
 * The review state: the trip arrived, and the payoff is on screen.
 *
 * The payoff's two actions are "play this run again" and "back to the menu", and
 * both are deliberate there — asking again turns one decision into two. While a
 * run is still in flight the guard keeps asking, because then the action really
 * does throw away something the user has not seen yet.
 */
export function reviewStateNeedsNoConfirm(input: {
  readonly arrived: boolean;
  readonly runComplete: boolean;
}): boolean {
  return input.arrived || input.runComplete;
}

/* ------------------------------------------------------------------ */
/* Lifecycle (Issue #39)                                               */
/* ------------------------------------------------------------------ */

/**
 * Chaos a human queued, and whether the scenario itself has moved under the run.
 * Both are read from the worker's own account of the run (a presentation frame),
 * never inferred from the UI's idea of what the user clicked.
 */
export interface RunGovernanceLike {
  readonly modified: boolean;
  readonly manualIncidents: number;
}

/**
 * Whether an instrument may fire without a word first.
 *
 * The first manual incident silently destroyed the clean comparison: the user
 * only learned at the end, from a refusal panel. So the FIRST qualifying action
 * is confirmed, and nothing is asked again once the run is already modified —
 * repeating the warning after the fact would be nagging, not warning.
 */
export function firstCleanRunWarning(governance: RunGovernanceLike): boolean {
  return governance.manualIncidents === 0 && !governance.modified;
}

export const INCIDENT_WARNING_TITLE = "Incidents make this run non-comparable";
/**
 * What the reader actually sees when the first incident would end this run's
 * comparability. One sentence, said once: the consequence, not the mechanism.
 * The run is not modified yet at this point, so the wording stays in the future.
 */
export const INCIDENT_WARNING_BODY =
  "Your trip keeps running, but the run will be marked modified: no clean " +
  "comparison with Fixed and Adaptive.";
export const INCIDENT_WARNING_CONFIRM = "Add incident";
export const INCIDENT_WARNING_CANCEL = "Keep it clean";

/**
 * Whether the chrome must say this run is no longer a clean comparison.
 *
 * Both ways of losing comparability count: a scenario moved under the run
 * (`modified`) and chaos a human queued (`manualIncidents`). The verdict checks
 * both, so the badge has to as well — otherwise a run with a manual incident
 * would look clean while it plays and only confess at the end.
 */
export function runShowsNonComparable(input: RunGovernanceLike): boolean {
  return input.modified || input.manualIncidents > 0;
}

/** Shown once when a live setting change (not an incident) breaks comparability. */
export const CLEAN_RUN_LOST_NOTICE =
  "This run is now modified: the clean comparison with Fixed and Adaptive is off.";

/* ------------------------------------------------------------------ */
/* The run's two controls (final polish pass)                          */
/* ------------------------------------------------------------------ */

/**
 * The words on them. Obvious, short, and the same on every surface: a phone
 * shows them in the trip card, the wide layout in the control strip, and both
 * mean exactly the same thing.
 */
export const SKIP_TO_END_LABEL = "Skip to end";
export const SPEED_LABEL = "3× speed";

/**
 * Whether the two run controls apply at all.
 *
 * Both are conveniences over a run that is UNDER WAY, and neither is offered
 * where it could not do what it says:
 *
 *   - before the startup gate passes, no simulated time is passing, so there is
 *     nothing to finish early and nothing to watch faster;
 *   - a run that could not start, or that was stopped because Jev was lost, is
 *     over — its own message is the whole account of it;
 *   - once the trip has ARRIVED, the remaining simulated time is the run's own
 *     tail (the window its comparison needs), not something the user is sitting
 *     through: skipping it is already what the app does, and the speed of a
 *     parked car means nothing;
 *   - and a completed run has published its result.
 */
export function runControlsVisible(input: {
  /** A run exists and has reported a frame (its trip is known). */
  readonly started: boolean;
  /** Waiting for the first live policy: no simulated time is passing. */
  readonly starting: boolean;
  /** The run is not in flight (it could not start, or was stopped). */
  readonly failed: boolean;
  /** The trip is over. */
  readonly arrived: boolean;
  readonly runComplete: boolean;
}): boolean {
  return input.started && !input.starting && !input.failed && !input.arrived && !input.runComplete;
}

/**
 * The other speed. Two states, no system: pressing the control swaps the run's
 * playback between normal and 3× — the engine steps one real tick runs.
 */
export function nextPlaybackSpeed(speed: PlaybackSpeed): PlaybackSpeed {
  return speed === PLAYBACK_SPEEDS[0] ? PLAYBACK_SPEEDS[1] : PLAYBACK_SPEEDS[0];
}

/** The title a run wears when it could not finish: it did not complete. */
export const RUN_STOPPED_TITLE = "Run stopped";

/**
 * What the payoff says while the run's own window is still open.
 *
 * The panel is up from the ARRIVAL, and normally what is left is the wait for
 * the run's tail and then for the comparison. A run that was STOPPED in that
 * last stretch (Jev was lost, so the contract ends it there) is not finishing
 * anything, and a skipped or halted run must not be told it is about to get a
 * comparison it cannot have: the panel carries the worker's own reason instead.
 */
export function waitingPanelState(input: { readonly error: string | null }): "finishing" | "stopped" {
  return input.error === null ? "finishing" : "stopped";
}

/**
 * What the payoff panel should be showing after arrival. `waiting` is the only
 * state that may still say something vague, and it exists only before the run
 * has finished.
 */
export type BaselinePanelState = "comparison" | "computing" | "failed" | "waiting";

export function baselinePanelState(input: {
  readonly runComplete: boolean;
  readonly hasBaselines: boolean;
  readonly running: boolean;
  readonly failed: boolean;
}): BaselinePanelState {
  if (!input.runComplete) {
    return "waiting";
  }
  if (input.hasBaselines) {
    return "comparison";
  }
  if (input.failed) {
    return "failed";
  }
  if (input.running) {
    return "computing";
  }
  return "failed";
}

/**
 * The wait after arrival, in plain words: what is still running, and for what.
 * No invented progress — the copy promises a state, not a percentage. The detail
 * line that used to repeat this sentence underneath it is gone (Issue #46): one
 * state, said once.
 */
export const BASELINE_COMPUTING_TEXT = "Running the same scenario with Fixed and Adaptive…";
export const BASELINE_FAILED_TEXT = "The Fixed and Adaptive runs could not be computed.";
export const BASELINE_FAILED_DETAIL = "The comparison needs both runs.";
export const BASELINE_RETRY_LABEL = "Try again";

/** Actions that throw the current run away. */
export type DiscardAction = "trip" | "driver" | "seed" | "restart" | "new-scenario";

export interface DiscardCopy {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
}

export function discardCopy(action: DiscardAction): DiscardCopy {
  switch (action) {
    case "trip":
      return {
        title: "Start a new run of another trip?",
        body: "This discards the run in progress and starts a fresh one.",
        confirm: "Start new run",
      };
    case "driver":
      return {
        title: "Put a different driver in the car?",
        body: "A driver defines the run, so this discards it and starts a fresh one of the same scenario.",
        confirm: "Start new run",
      };
    case "seed":
      return {
        title: "Reseed the scenario?",
        body: "A new seed rebuilds the world, and the run in progress is discarded.",
        confirm: "Reseed and restart",
      };
    case "new-scenario":
      return {
        title: "Leave this run?",
        body: "The run in progress is discarded, and the menu opens.",
        confirm: "Leave run",
      };
    case "restart":
      return {
        title: "Restart this run?",
        body: "The run is discarded and played again from the start.",
        confirm: "Restart",
      };
  }
}

/**
 * Whether an action still has something to destroy. A change made before the
 * first run is frictionless; only meaningful progress is worth a question. A
 * finished run counts: its result is the thing the user came for.
 */
export function discardNeedsConfirm(input: {
  readonly started: boolean;
  readonly runComplete: boolean;
  readonly hasResult: boolean;
}): boolean {
  return input.runComplete || input.hasResult || input.started;
}

/** Incidents the dock may offer, with the reason each unavailable one is out. */
export interface IncidentAvailability {
  readonly kind: IncidentKind;
  readonly applicable: boolean;
  readonly reason: string | null;
}

/** The dock's availability view: unknown capability stays offered, and honest. */
export function incidentAvailability(
  kind: IncidentKind,
  capabilities: readonly IncidentAvailability[] | null,
): IncidentAvailability {
  const known = capabilities?.find((capability) => capability.kind === kind) ?? null;
  return known ?? { kind, applicable: true, reason: null };
}

/**
 * Why an instrument is unavailable, in the dock's words. The reason comes from
 * the resolver that would have run on click, so it says what actually happened
 * to this world rather than a generic apology.
 */
export function unavailableIncidentHint(availability: IncidentAvailability): string {
  return availability.reason ?? "Not available in this run";
}

/* ------------------------------------------------------------------ */
/* Provenance (Issue #15)                                              */
/* ------------------------------------------------------------------ */

export interface PolicyLabel {
  /** The word the product shows: the controller's name, or the run's own state. */
  readonly text: string;
  /** One compact line of public truth, or null when there is nothing to add. */
  readonly detail: string | null;
}

/**
 * Why a run was not fully governed by a fresh model policy, in plain words.
 *
 * One phrase per classified cause, so the label can say WHAT happened rather
 * than naming a mode. A cause this build does not recognise adds nothing: an
 * unknown reason is reported as unknown, never guessed at.
 */
export function causeReason(cause: JevCause | null | undefined): string | null {
  switch (cause) {
    case "unconfigured":
      return "no model was configured";
    case "first-policy":
      return "the run was still waiting for its first policy";
    case "service-budget":
      return "the service window did not allow a request in time";
    case "expired":
      return "the policy in force passed its maximum age";
    case "held":
      return "a fresher answer arrived inside the hold window";
    case "superseded":
      return "the answer arrived after its request was superseded";
    case "timeout":
      return "the model did not answer in time";
    case "rate-limited":
      return "the model service rate-limited the request";
    case "upstream-error":
      return "the model service returned an error";
    case "rejected":
      return "the model service refused the request";
    case "unreachable":
      return "the model could not be reached";
    case "not-configured":
      return "the relay has no model credential";
    case "malformed":
      return "the answer could not be used as a policy";
    default:
      return null;
  }
}

/** A compact note about answers that were applied but imperfect, or "". */
function imperfectNote(policy: PresentationPolicy): string {
  const dropped = policy.dropped ?? 0;
  const clamped = policy.clamped ?? 0;
  const parts: string[] = [];
  if (dropped > 0) {
    parts.push(`${dropped} ${dropped === 1 ? "answer" : "answers"} below the confidence floor`);
  }
  if (clamped > 0) {
    parts.push(`${clamped} ${clamped === 1 ? "value" : "values"} clamped`);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(", ")}`;
}

/** A share as the label writes it: "<1%" rather than a misleading "0%". */
function shareText(share: number): string {
  return share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

/**
 * Who governed the signals, in the fewest words that stay true.
 *
 *   Checking Jev           no runtime provenance has arrived yet
 *   Waiting for Jev        the run is waiting for its FIRST policy; no
 *                          simulated time is passing, and it will not start
 *                          until one is accepted
 *   Jev                    the controller the user watched
 *   Jev · run invalidated  Jev was LOST: the run stopped with its measurements
 *                          kept, and it is not a completed Jev result
 *   Replay                 a recorded policy run, applied offline
 *
 * The run is named for its controller, not for how the controller was doing:
 * fresh, held, and any simulated time a policy did not cover are the run's own
 * accounting — `heldMs`, `invalidMs`, `fallbackMs`, the per-refresh outcomes
 * and reasons — and they are read from the record that carries them
 * (jev/telemetry.ts, jev/provenance.ts, the harness line, `?debug`,
 * `__jevDebug`), not from a caption. A run that was not governed by Jev at all
 * is never named Jev: one still waiting for its first policy is not a Jev run,
 * and neither is one that lost Jev and stopped. Controllers with no external
 * policy (Fixed, Adaptive) label themselves.
 */
export function policyLabel(
  controller: string,
  policy: PresentationPolicy | null,
): PolicyLabel | null {
  if (controller === "fixed") {
    return { text: "Fixed", detail: null };
  }
  if (controller === "adaptive") {
    return { text: "Adaptive", detail: null };
  }
  if (controller !== "jev") {
    return null;
  }
  if (policy === null) {
    return { text: "Checking Jev", detail: "waiting for run provenance" };
  }
  const policies = `${policy.accepted} ${policy.accepted === 1 ? "policy" : "policies"}`;
  if (policy.source === "replay") {
    return { text: "Replay", detail: `${policy.replayMs > 0 ? formatDuration(policy.replayMs) : "recorded"} replayed` };
  }
  if (policy.source === "invalidated" || policy.invalidation != null) {
    // Jev was lost and the run stopped. The measurements are real and kept, but
    // this is not a completed Jev result and the label says so.
    const reason = causeReason(policy.invalidation?.reason ?? policy.cause);
    const at = policy.invalidation?.atSimMs;
    return {
      text: "Jev · run invalidated",
      detail:
        `${shareText(ungovernedShare(policy))} of the run after Jev was lost` +
        `${at === undefined ? "" : ` at ${formatDuration(at)}`}` +
        `${reason === null ? "" : ` (${reason})`} · not a completed Jev result`,
    };
  }
  if (policy.source === "waiting" || policy.accepted === 0) {
    // No policy has been accepted yet: the run is waiting for its first one and
    // no simulated time is passing. Nothing else is deciding.
    const reason = causeReason(policy.cause);
    return {
      text: "Waiting for Jev",
      detail: `the run starts once the first policy arrives${reason === null ? "" : ` · ${reason}`}`,
    };
  }
  return { text: "Jev", detail: `${policies}${imperfectNote(policy)}` };
}

/** Short label for chrome ("Tourist", "Local"). */
export function driverLabel(driver: DriverStrategy): string {
  return DRIVER_OPTIONS.find((option) => option.value === driver)?.label ?? "Tourist";
}

/**
 * The one sentence a run owes the user when Jev was LOST mid-run: what happened,
 * when, and that the run is not a completed Jev result. Plain words only — this
 * reaches the page.
 */
export function runStoppedMessage(invalidation: {
  readonly atSimMs: number;
  readonly reason: JevCause;
}): string {
  const reason = causeReason(invalidation.reason) ?? "the policy stopped arriving";
  return (
    `Jev was lost at ${formatDuration(invalidation.atSimMs)} (${reason}), so the run stopped there. ` +
    "Its measurements so far are kept — this is not a completed Jev result."
  );
}

/**
 * The one sentence a run owes the user when it could NOT START: why, and that
 * nothing was simulated in its place.
 */
export function runUnableMessage(reason: JevCause, detail: string): string {
  const cause = causeReason(reason) ?? detail;
  return `This run did not start: Jev could not provide its first policy (${cause}). Nothing was simulated.`;
}

export function driverDescription(driver: DriverStrategy): string {
  return DRIVER_DESCRIPTIONS[driver];
}
