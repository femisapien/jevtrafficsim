"use client";

/**
 * Onboarding (Task 11 polish pass; Issue #15 made it the PUBLIC flow).
 *
 * Screen 1 — the title, one line and a single Start action, centered over
 * the city seen whole (the map is the hero, not a blurred backdrop).
 * Screen 2 — the experiment's inputs and nothing else: which Chicago trip, how
 * much traffic, who is driving, and a fresh scenario. The controller is not a
 * setting: the visible run is Jev and Fixed/Adaptive play the same city beside
 * it. The raw seed stays internal (deterministic replay, not a user control).
 * Both remain available behind `?debug`.
 */
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useUiStore } from "@/store/ui-store";
import { DiscreteSlider, SeedField, Segmented, TickRow } from "./controls";
import { DRIVER_OPTIONS, driverDescription } from "./ui-model";
import { CURATED_TRIPS, curatedTrip } from "@/cities/chicago-trips";
import {
  CONTROLLER_OPTIONS,
  TRAFFIC_OPTIONS,
  diceSeed,
  normalizeSeed,
  trafficLabel,
} from "./ui-model";

const EASE = [0.22, 1, 0.36, 1] as const;

const fieldVariants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
};

/**
 * The raw seed is a developer control: it exists so a run can be reproduced
 * exactly, not so a visitor can half-specify a scenario. Only rendered behind
 * `?debug`, and labelled as such.
 */
function DebugSeedField({
  seed,
  onSeed,
  onRoll,
}: {
  seed: number;
  onSeed: (seed: number) => void;
  onRoll: () => void;
}) {
  const [text, setText] = useState(String(seed));
  const [rotation, setRotation] = useState(0);
  const [synced, setSynced] = useState(seed);
  if (synced !== seed) {
    setSynced(seed);
    setText(String(seed));
  }
  return (
    <SeedField
      text={text}
      onText={setText}
      onCommit={() => {
        const next = normalizeSeed(text, seed);
        setText(String(next));
        if (next !== seed) {
          onSeed(next);
        }
      }}
      onRoll={() => {
        setRotation((degrees) => degrees + 540);
        onRoll();
      }}
      rotation={rotation}
      label={<span className="label-micro">Seed</span>}
    />
  );
}

export function Onboarding({
  onEnterCity,
  onPreviewSetup,
  debug,
}: {
  onEnterCity: () => void;
  onPreviewSetup: () => void;
  debug: boolean;
}) {
  const phase = useUiStore((state) => state.phase);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const tripId = useUiStore((state) => state.tripId);
  const controller = useUiStore((state) => state.controller);
  const setPhase = useUiStore((state) => state.setPhase);
  const setTrafficLevel = useUiStore((state) => state.setTrafficLevel);
  const setTripId = useUiStore((state) => state.setTripId);
  const setController = useUiStore((state) => state.setController);
  const seed = useUiStore((state) => state.seed);
  const setSeed = useUiStore((state) => state.setSeed);
  const driver = useUiStore((state) => state.driver);
  const setDriver = useUiStore((state) => state.setDriver);
  /** A new scenario is a new seed — deterministic, just not user-facing. */
  const newScenario = () => {
    setSeed(diceSeed());
    onPreviewSetup();
  };

  const trafficIndex = TRAFFIC_OPTIONS.findIndex((option) => option.value === trafficLevel);
  const trip = curatedTrip(tripId);
  const configuring = phase === "config" || phase === "entering";

  return (
    /**
     * Phone (the narrow layout is mobile-FIRST): the landing is a bottom-
     * anchored block — title, one line, one full-width Start — so the city
     * stays whole above it and the action is always in the same place. From
     * `sm` up it is the centred desktop statement it always was.
     */
    <div className="pointer-events-none absolute inset-0 z-20 flex items-end justify-center px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] sm:items-center sm:px-10 sm:pb-0">
      <AnimatePresence mode="wait">
        {phase === "landing" && (
          <motion.div
            key="landing"
            className="pointer-events-auto w-full max-w-lg sm:w-auto"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, scale: 0.99 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <h1 className="on-map-display text-display font-semibold leading-[1.04] tracking-[-0.03em] text-ink">
              Jev Traffic Simulator
            </h1>
            <p className="on-map-display mt-3 max-w-md text-ui leading-relaxed text-ink-70 sm:mt-4">
              One car crosses Chicago on Jev&apos;s signals. Fixed and Adaptive run the
              same trip.
            </p>
            <button
              type="button"
              onClick={() => setPhase("config")}
              className="mt-6 h-12 w-full rounded-control bg-ink px-7 text-ui font-medium text-surface shadow-[0_1px_2px_rgb(33_29_24/0.14),0_10px_24px_-14px_rgb(33_29_24/0.5)] transition-[opacity,transform] duration-150 hover:opacity-92 active:scale-[0.99] sm:mt-8 sm:w-auto"
            >
              Start
            </button>
            {/* The phone tells the honest version of the story: this is a
                desktop-first city. A note, never a gate. */}
            <p className="mt-3 text-meta text-ink-52 on-map-soft sm:hidden">
              Best experienced on desktop.
            </p>
          </motion.div>
        )}

        {configuring && (
          /**
           * Phone: a bottom-docked sheet — one column, four decisions, the
           * primary action last and full width. Desktop keeps the centred card.
           * Helper copy that only repeats the control is desktop-only: on a
           * phone the labels are the explanation.
           */
          <motion.div
            key="config"
            className="surface-overlay pointer-events-auto max-h-[calc(100dvh-24px)] w-full max-w-[420px] overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] sm:max-h-[calc(100dvh-48px)] sm:p-6"
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.99 }}
            transition={{ duration: 0.42, ease: EASE }}
          >
            <motion.div
              className="flex flex-col gap-4 sm:gap-7"
              variants={{ shown: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } } }}
              initial="hidden"
              animate="shown"
            >
              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <span className="label-micro">Trip</span>
                <label className="mt-2 block sm:mt-3">
                  <span className="sr-only">Chicago trip</span>
                  <select
                    value={tripId}
                    onChange={(event) => {
                      setTripId(event.target.value as typeof tripId);
                      onPreviewSetup();
                    }}
                    className="h-12 w-full rounded-control border border-hair-strong bg-surface px-3 text-ui font-medium text-ink outline-none transition-colors focus:border-ink-38 sm:h-11"
                  >
                    {CURATED_TRIPS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2.5 hidden text-meta leading-relaxed text-ink-70 sm:block">
                  {trip.summary}
                </p>
              </motion.div>

              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                {/* Label and value share one line: the value is not said twice. */}
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label-micro">Traffic</span>
                  <span className="text-meta font-medium text-ink">{trafficLabel(trafficLevel)}</span>
                </div>
                <div className="mt-2.5 sm:mt-3">
                  <DiscreteSlider
                    value={trafficIndex}
                    count={TRAFFIC_OPTIONS.length}
                    onChange={(index) => {
                      setTrafficLevel(TRAFFIC_OPTIONS[index].value);
                      onPreviewSetup();
                    }}
                    ariaLabel="Traffic level"
                  />
                  <TickRow
                    labels={TRAFFIC_OPTIONS.map((option) => option.label)}
                    value={trafficIndex}
                    onSelect={(index) => {
                      setTrafficLevel(TRAFFIC_OPTIONS[index].value);
                      onPreviewSetup();
                    }}
                  />
                </div>
              </motion.div>

              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <span className="label-micro">Driver</span>
                <div className="mt-2 sm:mt-3">
                  <Segmented
                    options={DRIVER_OPTIONS}
                    value={driver}
                    onChange={(nextDriver) => {
                      setDriver(nextDriver);
                      onPreviewSetup();
                    }}
                    layoutId="driver-pill-config"
                    height={36}
                    ariaLabel="Driver"
                  />
                </div>
                <p className="mt-2.5 hidden text-meta leading-relaxed text-ink-70 sm:block">
                  {driverDescription(driver)}
                </p>
              </motion.div>

              {debug && (
                <motion.div
                  variants={fieldVariants}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="flex flex-col gap-5 rounded-control border border-hairline bg-surface-94 px-3.5 py-3.5"
                >
                  <div>
                    <div className="flex items-baseline justify-between">
                      <span className="label-micro">Controller</span>
                      <span className="text-micro text-ink-38">?debug</span>
                    </div>
                    <div className="mt-2.5">
                      <Segmented
                        options={CONTROLLER_OPTIONS}
                        value={controller}
                        onChange={(nextController) => {
                          setController(nextController);
                          onPreviewSetup();
                        }}
                        layoutId="controller-pill-config"
                        height={36}
                        ariaLabel="Controller"
                      />
                    </div>
                  </div>
                  <DebugSeedField
                    seed={seed}
                    onSeed={(next) => {
                      setSeed(next);
                      onPreviewSetup();
                    }}
                    onRoll={newScenario}
                  />
                </motion.div>
              )}

              {/* The action block: one primary, then the two ways out of this
                  screen as one quiet row — the redraw on the left, the way back
                  on the right. Both are thumb-sized, neither competes with the
                  primary. */}
              <motion.div
                variants={fieldVariants}
                transition={{ duration: 0.3, ease: EASE }}
                className="mt-1 flex flex-col gap-1.5 sm:mt-2 sm:gap-3"
              >
                <button
                  type="button"
                  disabled={phase === "entering"}
                  onClick={onEnterCity}
                  className="h-12 w-full rounded-control bg-ink text-ui font-medium text-surface shadow-resting transition-[opacity,transform] duration-150 hover:opacity-92 active:scale-[0.995] disabled:opacity-60"
                >
                  {phase === "entering" ? "Entering…" : "Enter City"}
                </button>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={newScenario}
                    className="h-11 px-2 text-meta font-medium text-ink-70 transition-colors duration-150 hover:text-ink sm:h-9"
                  >
                    New scenario
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhase("landing")}
                    className="h-11 px-2 text-meta font-medium text-ink-70 transition-colors duration-150 hover:text-ink sm:h-9"
                  >
                    Back
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
