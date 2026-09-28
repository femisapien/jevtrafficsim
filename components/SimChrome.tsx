"use client";

/**
 * SimChrome (Task 11 polish pass): the live product's chrome in discrete
 * zones — nothing spans the viewport.
 *
 *   top-centre    pause/play · follow/recenter · zoom out/in · scenario
 *   bottom-left   trip state and provenance (TripHUD, one panel)
 *   bottom-centre incident dock, run-complete payoff and error state
 *
 * Two surfaces and a dock (Issue #49). The run-identity card that used to sit
 * top-left said the same things as the trip panel - trip name, level, driver,
 * provenance - so it was merged into it, and the camera stack moved into the
 * control row where follow/recenter already lives. Panels are the only overlay
 * material; everything else is type on the map.
 *
 * Phone pass: three anchored zones and no floating status block. A compact
 * strip top-left (40px targets, icon-only), the bottom stack (trip card over
 * incident tray, TrafficSimulator), and the contextual control chip at the top
 * right. The two run-level messages that used to float over the middle of the
 * screen — waiting for Jev's first policy, and a run that could not start —
 * now render INSIDE the trip card, so nothing overlaps the map's action.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { TrafficLevel } from "@/sim/types";
import { CURATED_TRIPS, curatedTrip, type CuratedTripId } from "@/cities/chicago-trips";
import { useUiStore } from "@/store/ui-store";
import type { ControllerChoice } from "@/worker/protocol";
import { DiscreteSlider, SeedField, Segmented, TickRow } from "./controls";
import { ComparisonPanel, ComparisonSkeleton } from "./ComparisonPanel";
import {
  BASELINE_COMPUTING_TEXT,
  BASELINE_FAILED_DETAIL,
  BASELINE_FAILED_TEXT,
  BASELINE_RETRY_LABEL,
  baselinePanelState,
  discardCopy,
  runShowsNonComparable,
} from "./ui-model";
import {
  CONTROLLER_OPTIONS,
  DRIVER_OPTIONS,
  TRAFFIC_OPTIONS,
  diceSeed,
  normalizeSeed,
} from "./ui-model";

import type { DriverStrategy } from "@/sim/driver";

interface SimChromeProps {
  /** Developer controls (?debug): controller choice and the raw seed. */
  debug: boolean;
  /** Follow camera state, mirrored from the map. */
  following: boolean;
  onFollow: () => void;
  onPause: () => void;
  onResume: () => void;
  onController: (controller: ControllerChoice) => void;
  onTripId: (tripId: CuratedTripId) => void;
  onTrafficLevel: (trafficLevel: TrafficLevel) => void;
  onDriver: (driver: DriverStrategy) => void;
  onSeed: (seed: number) => void;
  onRestart: () => void;
  onNewScenario: () => void;
  /** Re-ask the baseline worker for this scenario (Issue #39 failure state). */
  onRetryBaselines: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The wait after arrival, in plain words.
 *
 * The trip is over — the ego arrived, and its time is final — but the RUN is
 * not: the comparison's citywide rows can only be read from a run that covers
 * the same window as the Fixed and Adaptive baselines, so the rest of that
 * window is simulated before the table can be printed. The copy says exactly
 * that: one state line, one fact, and the skeleton underneath showing the
 * comparison's shape. It never says "still playing" (the car is parked) and
 * never claims the run is complete (it is not, and "Run complete" stays
 * conditional on RUN_COMPLETE).
 */
export const ARRIVED_FINISHING_TEXT = "You arrived. Finishing the citywide comparison…";
export const ARRIVED_FINISHING_DETAIL = "Your trip time is final.";
/** What a screen reader hears while either wait is on screen. */
export const COMPARISON_PREPARING_ANNOUNCEMENT = "Preparing the citywide comparison.";

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-[7px] text-ink-70 transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink active:scale-[0.96] sm:h-9 sm:w-9"
    >
      {children}
    </button>
  );
}

const glyph = {
  width: 14,
  height: 14,
  viewBox: "0 0 13 13",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/**
 * Scenario popover: the same decisions as onboarding, editable live. Trip and
 * driver rebuild the run (they define who and where the challenge is); traffic
 * is applied to the world in progress. The raw seed is a developer control.
 */
function ScenarioPanel({
  onTripId,
  onTrafficLevel,
  onDriver,
  onSeed,
  debug,
}: Pick<SimChromeProps, "onTripId" | "onTrafficLevel" | "onDriver" | "onSeed" | "debug">) {
  const tripId = useUiStore((state) => state.tripId);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const driver = useUiStore((state) => state.driver);
  const seed = useUiStore((state) => state.seed);
  const setScenarioOpen = useUiStore((state) => state.setScenarioOpen);
  const [seedText, setSeedText] = useState(String(seed));
  const [rotation, setRotation] = useState(0);
  const [syncedSeed, setSyncedSeed] = useState(seed);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Adjust state during render when the store's seed changes (no effect).
  if (syncedSeed !== seed) {
    setSyncedSeed(seed);
    setSeedText(String(seed));
  }

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current && !panelRef.current.contains(target)) {
        setScenarioOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setScenarioOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [setScenarioOpen]);

  const trip = curatedTrip(tripId);
  const trafficIndex = TRAFFIC_OPTIONS.findIndex((option) => option.value === trafficLevel);

  return (
    <motion.div
      ref={panelRef}
      className="surface-overlay absolute left-1/2 top-[64px] z-20 w-[280px] -translate-x-1/2 p-4 sm:top-14 sm:w-[288px] sm:p-5"
      initial={{ opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985 }}
      transition={{ duration: 0.2, ease: EASE }}
      style={{ transformOrigin: "top center" }}
    >
      <div className="flex flex-col gap-4 sm:gap-5">
        <div>
          <span className="label-micro">Trip</span>
          <select
            value={tripId}
            onChange={(event) => onTripId(event.target.value as CuratedTripId)}
            className="mt-2.5 h-11 w-full rounded-control border border-hair-strong bg-surface px-2.5 text-meta font-medium text-ink outline-none"
          >
            {CURATED_TRIPS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <p className="mt-2 hidden text-meta leading-relaxed text-ink-70 sm:block">{trip.summary}</p>
        </div>
        <div>
          <span className="label-micro">Traffic</span>
          <div className="mt-2.5">
            <DiscreteSlider
              value={trafficIndex}
              count={TRAFFIC_OPTIONS.length}
              onChange={(index) => onTrafficLevel(TRAFFIC_OPTIONS[index].value)}
              ariaLabel="Traffic level"
            />
            <TickRow
              labels={TRAFFIC_OPTIONS.map((option) => option.label)}
              value={trafficIndex}
              // Live mid-trip: this goes through the same handler as the
              // slider, which applies the new level to the RUNNING world
              // instead of rebuilding it.
              onSelect={(index) => onTrafficLevel(TRAFFIC_OPTIONS[index].value)}
            />
          </div>
        </div>
        <div>
          <span className="label-micro">Driver</span>
          <div className="mt-2.5">
            <Segmented
              options={DRIVER_OPTIONS}
              value={driver}
              onChange={onDriver}
              layoutId="driver-pill-live"
              height={30}
              ariaLabel="Driver"
            />
          </div>
        </div>
        {debug && (
          <SeedField
            text={seedText}
            onText={setSeedText}
            onCommit={() => {
              const next = normalizeSeed(seedText, seed);
              setSeedText(String(next));
              if (next !== seed) {
                onSeed(next);
              }
            }}
            onRoll={() => {
              const next = diceSeed();
              setSeedText(String(next));
              setRotation((degrees) => degrees + 540);
              onSeed(next);
            }}
            rotation={rotation}
            label={<span className="label-micro">Seed</span>}
          />
        )}
      </div>
    </motion.div>
  );
}

export function SimChrome(props: SimChromeProps) {
  const phase = useUiStore((state) => state.phase);
  const running = useUiStore((state) => state.running);
  const controller = useUiStore((state) => state.controller);
  const scenarioOpen = useUiStore((state) => state.scenarioOpen);
  const setScenarioOpen = useUiStore((state) => state.setScenarioOpen);
  const runComplete = useUiStore((state) => state.runComplete);
  /**
   * The authoritative trip completion (Issue #46), read from the frame the UI
   * already holds. The ego's arrival IS the end of the trip, and the payoff is
   * owed then — not when the citywide horizon lands.
   */
  const arrived = useUiStore((state) => state.trip?.completed === true);
  const policy = useUiStore((state) => state.policy);
  const liveResult = useUiStore((state) => state.liveResult);
  const baselines = useUiStore((state) => state.baselines);
  const baselinesRunning = useUiStore((state) => state.baselinesRunning);
  const baselinesFailed = useUiStore((state) => state.baselinesFailed);
  const pendingDiscard = useUiStore((state) => state.pendingDiscard);
  const modified = useUiStore((state) => state.modified);
  const manualIncidents = useUiStore((state) => state.manualIncidents);
  const surgeFlash = useUiStore((state) => state.surgeFlash);
  const surgeVisible = useUiStore((state) => state.surgeVisible);
  // "Live" means the city is the surface the user is looking at: the run they
  // entered, or the payoff it earned. A preview playing behind the menu is
  // neither — its own completion must not throw a result over the setup screen.
  const entered = useUiStore((state) => state.entered);
  const live = phase === "city" || (runComplete && entered);
  /**
   * The payoff opens when the TRIP is over, and only hands over to the
   * comparison when the RUN's window is final. The two are not the same moment:
   * the ego arrives well inside the 600 s horizon (measured 398.4 s of 600 s on
   * the default scenario), and the citywide numbers the comparison prints can
   * only be read from a run that covers the same window as its baselines. So the
   * panel appears at the arrival, the waiting state says what the last stretch
   * is, and the comparison takes over at RUN_COMPLETE.
   */
  const finished = runComplete || arrived;
  const panel = baselinePanelState({
    runComplete,
    hasBaselines: baselines !== null,
    running: baselinesRunning,
    failed: baselinesFailed !== null,
  });
  const discard = pendingDiscard === null ? null : discardCopy(pendingDiscard);
  /**
   * The skeleton mirrors the shape the comparison will actually take: a run that
   * was changed by hand gets the refusal (two sentences), everything else gets
   * the three race rows. Known during the wait — the worker's own account of the
   * run is already in the store — so the placeholder never promises a table the
   * run cannot have.
   */
  const skeleton = runShowsNonComparable({ modified, manualIncidents }) ? "refusal" : "race";

  return (
    <>
      {/* Top-centre: utilities. Phone: a compact strip at the top-left, sized
          for a thumb (40px targets); wide: the centred arrangement as before. */}
      <AnimatePresence>
        {live && !runComplete && (
          <motion.div
            key="utilities"
            className="absolute left-3 right-3 top-3 z-20 sm:left-1/2 sm:right-auto sm:top-4 sm:-translate-x-1/2"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.34, delay: 0.06, ease: EASE }}
          >
            <div className="surface flex w-fit max-w-full items-center gap-1 overflow-x-auto p-1">
              {/*
                The visible run is Jev. Choosing another controller by hand is a
                developer control, so the picker only exists behind ?debug — a
                public visitor cannot turn the experiment into a different one.
              */}
              {props.debug && (
                <>
                  <Segmented
                    options={CONTROLLER_OPTIONS}
                    value={controller}
                    onChange={props.onController}
                    layoutId="controller-pill-live"
                    height={30}
                    ariaLabel="Controller"
                  />
                  <span className="mx-[3px] h-[18px] w-px bg-hair" aria-hidden="true" />
                </>
              )}
              <IconButton
                label={running ? "Pause" : "Play"}
                onClick={running ? props.onPause : props.onResume}
              >
                {running ? (
                  <svg {...glyph}>
                    <path d="M4.6 2.6v7.8M8.4 2.6v7.8" />
                  </svg>
                ) : (
                  <svg {...glyph}>
                    <path d="M4 2.6 10 6.5 4 10.4z" fill="currentColor" stroke="none" />
                  </svg>
                )}
              </IconButton>
              <span className="mx-[3px] h-[18px] w-px bg-hair" aria-hidden="true" />
              <button
                type="button"
                onClick={props.onFollow}
                aria-pressed={props.following}
                aria-label={props.following ? "Following the car" : "Recenter on the car"}
                title={props.following ? "Following the car" : "Recenter on the car"}
                className={`flex h-10 items-center gap-1.5 rounded-[7px] px-2.5 text-meta font-medium transition-colors duration-150 sm:h-9 ${
                  props.following ? "text-ink-70 hover:bg-ink/[0.05] hover:text-ink" : "bg-ink/[0.06] text-ink"
                }`}
              >
                <svg {...glyph}>
                  <circle cx="6.5" cy="6.5" r="2.1" />
                  <path d="M6.5 1.4v1.9M6.5 9.7v1.9M1.4 6.5h1.9M9.7 6.5h1.9" />
                </svg>
                <span className="hidden sm:inline">{props.following ? "Following" : "Recenter"}</span>
              </button>
              {/* Zoom is a pointer affordance: on touch the map pinches, and the
                  row has to fit 390px with the debug controller picker in it
                  (measured: it pushed Scenario off-screen when always shown). */}
              <span className="mx-[3px] hidden h-[18px] w-px bg-hair sm:block" aria-hidden="true" />
              <span className="hidden items-center gap-[3px] sm:flex">
                <IconButton label="Zoom out" onClick={props.onZoomOut}>
                  <svg {...glyph}>
                    <path d="M3 6.5h7" />
                  </svg>
                </IconButton>
                <IconButton label="Zoom in" onClick={props.onZoomIn}>
                  <svg {...glyph}>
                    <path d="M6.5 3v7M3 6.5h7" />
                  </svg>
                </IconButton>
              </span>
              <span className="mx-[3px] h-[18px] w-px bg-hair" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setScenarioOpen(!scenarioOpen)}
                aria-expanded={scenarioOpen}
                aria-label="Scenario"
                className={`flex h-10 items-center gap-1.5 rounded-[7px] px-2.5 text-meta font-medium transition-colors duration-150 sm:h-9 ${
                  scenarioOpen ? "bg-ink/[0.06] text-ink" : "text-ink-70 hover:bg-ink/[0.05] hover:text-ink"
                } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/25`}
              >
                <svg {...glyph}>
                  <path d="M2 4h9M2 6.5h9M2 9h9" />
                  <circle cx="4.6" cy="4" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="8.4" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="5.8" cy="9" r="1.2" fill="currentColor" stroke="none" />
                </svg>
                <span className="hidden sm:inline">Scenario</span>
              </button>
            </div>
            <AnimatePresence>
              {scenarioOpen && (
                <ScenarioPanel
                  onTripId={props.onTripId}
                  onTrafficLevel={props.onTrafficLevel}
                  onDriver={props.onDriver}
                  onSeed={props.onSeed}
                  debug={props.debug}
                />
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top-centre: demand surge confirmation (transient). */}
      <AnimatePresence>
        {live && surgeVisible && (
          <motion.div
            key={`surge-${surgeFlash}`}
            className="surface pointer-events-none absolute left-1/2 top-16 z-10 flex items-center gap-2 px-3 py-1.5"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#b0392b]" aria-hidden="true" />
            <span className="text-meta font-medium text-ink">+5× traffic</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The payoff IS the comparison, then the error state. */}
      <AnimatePresence>
        {live && finished && (
          <motion.div
            key="complete"
            className="surface-overlay absolute left-1/2 top-1/2 z-20 max-h-[calc(100dvh-40px)] w-[520px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 sm:max-h-[calc(100dvh-48px)] sm:max-w-[calc(100vw-32px)] sm:p-7"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            {/* One heading for the whole payoff: the run's own window only closes
                at RUN_COMPLETE, and before that the panel is up because the TRIP
                ended, so claiming the run is complete would be false. */}
            {runComplete && (
              <h2 className="text-ui font-semibold tracking-[-0.01em] text-ink">Run complete</h2>
            )}
            <div className={runComplete ? "mt-4" : ""}>
              {panel === "comparison" && liveResult !== null && baselines !== null ? (
                <ComparisonPanel baselines={baselines} live={liveResult} policy={policy} />
              ) : null}
              {panel === "computing" && (
                <div role="status" aria-live="polite">
                  <p className="text-ui font-medium text-ink">{BASELINE_COMPUTING_TEXT}</p>
                  <p className="sr-only">{COMPARISON_PREPARING_ANNOUNCEMENT}</p>
                </div>
              )}
              {panel === "failed" && (
                <div role="alert" className="flex flex-col items-start gap-4">
                  <div>
                    <p className="text-ui font-medium text-ink">{BASELINE_FAILED_TEXT}</p>
                    <p className="mt-2 text-meta leading-relaxed text-ink-70">
                      {baselinesFailed ?? BASELINE_FAILED_DETAIL}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={props.onRetryBaselines}
                    className="h-10 rounded-control border border-hair-strong px-4 text-meta font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
                  >
                    {BASELINE_RETRY_LABEL}
                  </button>
                </div>
              )}
              {/* The trip ended at the arrival; the run's window has not. Say
                  which of the two is still going, and show the comparison's
                  shape while it is prepared. Never "still playing": the car is
                  parked, and the wait is the fairness rule doing its work. */}
              {panel === "waiting" && (
                <div role="status" aria-live="polite">
                  <p className="text-ui font-medium text-ink">{ARRIVED_FINISHING_TEXT}</p>
                  <p className="mt-2 text-meta leading-relaxed text-ink-70">
                    {ARRIVED_FINISHING_DETAIL}
                  </p>
                  <p className="sr-only">{COMPARISON_PREPARING_ANNOUNCEMENT}</p>
                </div>
              )}
              {/* The same skeleton for both waits — the run's tail and the two
                  headless baselines are one continuous "results are coming". */}
              {(panel === "waiting" || panel === "computing") && (
                <ComparisonSkeleton variant={skeleton} />
              )}
            </div>
            {/* Two actions, and only two: play this run again, or go back to the
                menu and choose another. A finished run has nothing left to ask
                about, so neither one asks again. */}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={props.onRestart}
                className="h-11 flex-1 rounded-control bg-ink text-ui font-medium text-surface transition-opacity duration-150 hover:opacity-90 active:scale-[0.99]"
              >
                Restart
              </button>
              <button
                type="button"
                onClick={props.onNewScenario}
                className="h-11 flex-1 rounded-control border border-hair-strong text-ui font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
              >
                Menu
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Above the dock: the one action that throws the run away asks first.
          Phone: a centred dialog. Wide: the low card over the dock. */}
      <AnimatePresence>
        {live && discard !== null && (
          <motion.div
            key="discard"
            role="alertdialog"
            aria-label={discard.title}
            className="surface-overlay absolute left-1/2 top-1/2 z-30 flex w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2.5 p-4 sm:bottom-16 sm:top-auto sm:translate-y-0"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <span className="text-ui font-medium text-ink">{discard.title}</span>
            <p className="text-meta leading-relaxed text-ink-70">{discard.body}</p>
            <div className="mt-1.5 flex gap-2.5">
              <button
                type="button"
                autoFocus
                onClick={props.onConfirmDiscard}
                className="h-9 flex-1 rounded-control bg-ink text-meta font-medium text-surface transition-opacity duration-150 hover:opacity-90 active:scale-[0.99]"
              >
                {discard.confirm}
              </button>
              <button
                type="button"
                onClick={props.onCancelDiscard}
                className="h-9 flex-1 rounded-control border border-hair-strong text-meta font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </>
  );
}
