"use client";

/**
 * TripHUD (Issue #25, consolidated in Issue #49).
 *
 * ONE panel answers everything the live view has to say: which trip, how it is
 * going, and what is driving the signals. The run-identity card that used to
 * float in the top-left corner carried the same trip name and the same
 * provenance, so two panels said the same thing and competed with the map for
 * attention. The card is gone; its content lives here, in the panel that was
 * already answering the trip questions.
 *
 * Elapsed, remaining and speed are the three facts a visitor reads mid-race.
 * Stopped time, intersections cleared, the estimate and the citywide health
 * block are still computed and still shown, behind ?debug.
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

export function TripHUD() {
  const phase = useUiStore((state) => state.phase);
  const runComplete = useUiStore((state) => state.runComplete);
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
  const view = tripHudView({ trip, egoState, egoSpeedMps });
  // One label, rendered in one place: the text names the controller, and the
  // hover title carries the same detail the payoff panel prints. How much of
  // the run was fresh, held or uncovered is the run's own record's business.
  const provenance = policyLabel(controller, policy);
  // The three facts a visitor reads mid-race; everything else waits for ?debug.
  const PRIMARY_ROWS = ["Elapsed", "Remaining", "Speed"];

  return (
    <AnimatePresence>
      {live && !runComplete && (
    <motion.div
      className="pointer-events-none absolute bottom-28 left-4 z-10 w-[240px] sm:bottom-4"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.32, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="surface flex flex-col px-4 py-3.5" role="status" aria-label="Trip">
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
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-meta leading-tight text-ink-70">
            {trafficLabel(trafficLevel)} · {driverLabel(driver)}
          </span>
          <span
            className="text-meta leading-none text-ink-70"
            title={provenance?.detail ?? undefined}
          >
            {provenance?.text ?? controller}
          </span>
        </div>
        {/* The three facts of the race, under one rule so they read as one
            block rather than as more lines of the header. */}
        <div className="mt-3.5 flex flex-col gap-2.5 border-t border-hairline pt-3.5">
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
        {runShowsNonComparable({ modified, manualIncidents }) && (
          <span className="mt-3 border-t border-hairline pt-2.5 text-meta leading-none text-ink-70">
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
