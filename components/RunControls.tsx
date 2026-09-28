"use client";

/**
 * The run's two convenience controls (final polish pass): SKIP TO END and
 * 3× SPEED.
 *
 * Both belong to the RUN, and both are shown only while a run is under way and
 * could still honour them (see runControlsVisible). They are rendered INSIDE the
 * surfaces that already exist — the trip card on a phone, the utility strip on
 * the wide layout — so no new floating surface appears anywhere, and the pill
 * vocabulary (obvious words, an ink fill for the state that is ON) is the same
 * in both places.
 *
 * Neither control is a mode: skipping advances the same paced run at the fastest
 * pace the run's own policy coverage allows until its horizon (so a skipped run
 * still completes and publishes its payoff), and the speed is a two-state toggle
 * over the engine steps one real tick runs. Neither is reported into the result —
 * a run is comparable or not for its own reasons (a hand-fired incident, a
 * mid-run setting change), never because of how fast someone watched it.
 */
import { useUiStore } from "@/store/ui-store";
import { PLAYBACK_SPEEDS } from "@/worker/protocol";
import { SKIP_TO_END_LABEL, SPEED_LABEL, runControlsVisible } from "./ui-model";

/** The two shapes the same pair of pills takes, in the surface that owns them. */
export type RunControlsVariant = "card" | "strip";

const ROW: Record<RunControlsVariant, string> = {
  card: "flex w-full gap-2",
  strip: "flex gap-1",
};

const SHAPE: Record<RunControlsVariant, string> = {
  // Phone: two thumb-sized pills sharing the card's width — half each on the
  // narrowest screen the product supports, and tall enough to hit without
  // aiming.
  card: "h-11 flex-1 rounded-full px-4 text-ui",
  // Wide: the same pair in the utility strip, at the strip's own height.
  strip: "h-9 rounded-[7px] px-3 text-meta",
};

const BASE =
  "flex items-center justify-center whitespace-nowrap border font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/25 active:scale-[0.99]";
/** Nothing is being watched faster than normal: an outlined, tappable pill. */
const IDLE = "border-hair-strong bg-surface text-ink hover:bg-ink/[0.04]";
/** This control's state is ON: the ink fill is the product's "this is active". */
const ACTIVE = "border-ink bg-ink text-surface";

export function RunControls({
  variant,
  onSkipToEnd,
  onToggleSpeed,
}: {
  variant: RunControlsVariant;
  onSkipToEnd: () => void;
  onToggleSpeed: () => void;
}) {
  const phase = useUiStore((state) => state.phase);
  const trip = useUiStore((state) => state.trip);
  const starting = useUiStore((state) => state.starting);
  const error = useUiStore((state) => state.error);
  const runComplete = useUiStore((state) => state.runComplete);
  const speed = useUiStore((state) => state.speed);
  const visible = runControlsVisible({
    started: phase === "city" && trip !== null,
    starting,
    // Any run-level message means this run is NOT in flight: it did not start,
    // or it was stopped because Jev was lost.
    failed: error !== null,
    arrived: trip?.completed === true,
    runComplete,
  });
  if (!visible) {
    return null;
  }
  const fast = speed !== PLAYBACK_SPEEDS[0];
  return (
    // `pointer-events-auto` because the trip card's wrapper is deliberately
    // transparent to pointers (it is one panel of type over the map).
    <div
      className={`pointer-events-auto ${ROW[variant]}`}
      role="group"
      aria-label="Run controls"
    >
      <button
        type="button"
        onClick={onSkipToEnd}
        className={`${BASE} ${SHAPE[variant]} ${IDLE}`}
      >
        {SKIP_TO_END_LABEL}
      </button>
      <button
        type="button"
        onClick={onToggleSpeed}
        aria-pressed={fast}
        className={`${BASE} ${SHAPE[variant]} ${fast ? ACTIVE : IDLE}`}
      >
        {SPEED_LABEL}
      </button>
    </div>
  );
}
