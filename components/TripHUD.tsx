"use client";

/**
 * TripHUD (Issue #25, consolidated in Issue #49; phone pass).
 *
 * ONE panel answers everything the live view has to say: which trip, how it is
 * going, and what is driving the signals. The run-identity card that used to
 * float in the top-left corner carried the same trip name and the same
 * provenance, so two panels said the same thing and competed with the map for
 * attention. The card is gone; its content lives here, in the panel that was
 * already answering the trip questions.
 *
 * Phone pass: the same panel, one size smaller and in the bottom stack. The
 * identity and the context share lines instead of stacking four of them; the
 * three facts a visitor reads mid-race (elapsed, left, speed) are one compact
 * three-cell row with a short label each, not three label/value rows; and the
 * two things the chrome owes the user mid-startup — "Waiting for Jev's first
 * policy" and any run-level error — are announced IN this card instead of as
 * their own floating block on top of it. Desktop keeps the panel exactly where
 * it was, bottom-left at 240px.
 *
 * Stopped time, intersections cleared, the estimate and the citywide health
 * block are still computed and still shown, on the wide layout, behind ?debug.
 *
 * Every value is a field the worker computed (see tripHudView in ui-model), so
 * the HUD can never disagree with the map or the simulation.
 */
import { AnimatePresence, motion } from "motion/react";
import { useUiStore } from "@/store/ui-store";
import {
  formatDuration,
  formatPercent,
  policyLabel,
  runShowsNonComparable,
  trafficLabel,
  driverLabel,
  tripHudView,
} from "./ui-model";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-4">
      <span className="label-micro">{label}</span>
      <span className="value-num text-ui font-medium leading-none text-ink">{value}</span>
    </div>
  );
}

/** The one row a phone shows: three facts, three short labels. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="label-micro">{label}</div>
      <div className="value-num mt-1 truncate text-ui font-medium leading-none text-ink">
        {value}
      </div>
    </div>
  );
}

/** "Remaining" is a column heading on a phone, so it is said in one word. */
const COMPACT_LABEL: Record<string, string> = { Remaining: "Left" };

export function TripHUD() {
  const phase = useUiStore((state) => state.phase);
  const runComplete = useUiStore((state) => state.runComplete);
  const starting = useUiStore((state) => state.starting);
  const error = useUiStore((state) => state.error);
  const trip = useUiStore((state) => state.trip);
  const egoState = useUiStore((state) => state.egoState);
  const egoSpeedMps = useUiStore((state) => state.egoSpeedMps);
  const metrics = useUiStore((state) => state.metrics);
  const debug = useUiStore((state) => state.debug);
  const controller = useUiStore((state) => state.controller);
  const policy = useUiStore((state) => state.policy);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const driver = useUiStore((state) => state.driver);
  const modified = useUiStore((state) => state.modified);
  const manualIncidents = useUiStore((state) => state.manualIncidents);
  const scenarioFingerprint = useUiStore((state) => state.scenarioFingerprint);
  const live = phase === "city";
  /**
   * A finished trip owes the payoff, and the payoff is the one surface that
   * gets to speak then: it carries the race, the live run's own time included.
   * So this card retires the moment the payoff opens (arrival), rather than
   * sitting behind it with the same numbers.
   */
  const finished = runComplete || trip?.completed === true;
  const view = tripHudView({ trip, egoState, egoSpeedMps });
  // One label, rendered in one place: the text names the controller, and the
  // hover title carries the same detail the payoff panel prints. How much of
  // the run was fresh, held or uncovered is the run's own record's business.
  const provenance = policyLabel(controller, policy);
  // The three facts a visitor reads mid-race; everything else waits for ?debug.
  const PRIMARY_ROWS = ["Elapsed", "Remaining", "Speed"];
  const primaryRows = (view?.rows ?? []).slice(0, PRIMARY_ROWS.length);

  return (
    <AnimatePresence>
      {live && !finished && (
        /**
         * Phone in landscape (a wide but SHORT viewport) still uses the wide
         * layout, so this card sits above the dock instead of under it: the dock
         * is 70px idle and ~118px while it asks to confirm an incident.
         */
        <motion.div
          className="pointer-events-none z-10 w-full sm:absolute sm:bottom-4 sm:left-4 sm:w-[240px] sm:[@media(max-height:520px)]:bottom-[140px] sm:[@media(max-height:520px)]:w-[220px]"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.32, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          <div
            className="surface flex flex-col px-3.5 py-3 sm:px-4 sm:py-3.5"
            role="status"
            aria-label="Trip"
          >
            {/* Identity: the panel's own name, the trip, and its state. */}
            <div className="flex items-baseline justify-between gap-3">
              <span className="label-micro">Jev Traffic · Chicago</span>
              <span
                className={`label-micro shrink-0 ${view?.completed ? "text-ink" : "text-ink-70"}`}
              >
                {view?.state ?? "—"}
              </span>
            </div>
            <span className="mt-1.5 min-w-0 truncate text-ui font-medium text-ink">
              {view?.tripName ?? "Trip"}
            </span>
            {/* One context line: how busy the city is, who is driving, and who is
                running the signals (the label carries its own detail on hover). */}
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <span className="truncate text-meta leading-tight text-ink-70">
                {trafficLabel(trafficLevel)} · {driverLabel(driver)}
              </span>
              <span
                className="shrink-0 text-meta leading-none text-ink-70"
                title={provenance?.detail ?? undefined}
              >
                {provenance?.text ?? controller}
              </span>
            </div>
            {/*
              The status the run owes the user, in the card that already answers
              "what is happening": the wait for Jev's first policy, or the reason
              this run is not running at all. Never a block on top of the map,
              never a second panel to read past.
            */}
            {error !== null ? (
              <div className="mt-2.5 flex items-start gap-2 border-t border-hairline pt-2.5">
                <span
                  className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#b0392b]"
                  aria-hidden="true"
                />
                <span className="text-meta leading-snug text-ink-70">{error}</span>
              </div>
            ) : starting ? (
              <div className="mt-2.5 flex items-center gap-2 border-t border-hairline pt-2.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/40" aria-hidden="true" />
                <span className="text-meta leading-snug text-ink-70">
                  Waiting for Jev&apos;s first policy — the run starts when it arrives.
                </span>
              </div>
            ) : (
              <>
                {/* Phone: the three facts of the race as one compact row. */}
                <div className="mt-2.5 grid grid-cols-3 gap-x-3 border-t border-hairline pt-2.5 sm:hidden">
                  {view ? (
                    primaryRows.map((row) => (
                      <Metric
                        key={row.label}
                        label={COMPACT_LABEL[row.label] ?? row.label}
                        value={row.value}
                      />
                    ))
                  ) : (
                    Array.from({ length: 3 }, (_, index) => (
                      <span
                        key={index}
                        className="h-[9px] w-10 animate-pulse rounded-full bg-ink/10"
                      />
                    ))
                  )}
                </div>
                {/* Wide layout: the same facts, one rule above them, one per row. */}
                <div className="mt-3.5 hidden flex-col gap-2.5 border-t border-hairline pt-3.5 sm:flex">
                  {view ? (
                    view.rows
                      .filter((row) => debug || PRIMARY_ROWS.includes(row.label))
                      .map((row) => <Row key={row.label} label={row.label} value={row.value} />)
                  ) : (
                    Array.from({ length: 3 }, (_, index) => (
                      <div key={index} className="grid grid-cols-[1fr_auto] items-baseline gap-4">
                        <span className="label-micro">·</span>
                        <span className="h-[9px] w-10 animate-pulse rounded-full bg-ink/10" />
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            {runShowsNonComparable({ modified, manualIncidents }) && (
              <span className="mt-2.5 border-t border-hairline pt-2 text-meta leading-none text-ink-70 sm:mt-3 sm:pt-2.5">
                modified · not comparable
              </span>
            )}
            {debug && (
              <div className="mt-0.5 border-t border-hair pt-2">
                <div className="value-num mb-1 truncate text-micro text-ink-38">
                  {scenarioFingerprint ?? "—"}
                </div>
                <div className="mb-1 label-micro text-ink-38">City traffic · debug</div>
                <div className="value-num flex items-baseline justify-between text-micro text-ink-38">
                  <span>{formatDuration(metrics?.averageWaitTimeMs ?? 0)} avg wait</span>
                  <span>{formatPercent(metrics?.gridlockRatio ?? 0)} gridlock</span>
                </div>
                <div className="value-num mt-[3px] flex items-baseline justify-between text-micro text-ink-38">
                  <span>{(metrics?.activeVehicles ?? 0).toLocaleString("en-US")} active</span>
                  <span>{(metrics?.completedTrips ?? 0).toLocaleString("en-US")} trips</span>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
