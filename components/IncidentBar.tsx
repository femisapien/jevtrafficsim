"use client";

/**
 * IncidentBar (Task 11 polish pass): the chaos dock.
 *
 * Five instruments in one hairline surface. Each button arms briefly on click
 * (ink fill), the reserved line above the dock reports what was queued or, on
 * hover, what the instrument does — so the dock never shifts height.
 *
 * Issue #39 additions, all of them about not surprising the user later:
 *
 *   - the FIRST manual incident is confirmed in place, because it makes the run
 *     non-comparable to the untouched baselines. Never repeated afterwards. The
 *     confirmation says that once, in one sentence (Issue #46 readability pass):
 *     the title is the accessible name, the body is what the reader sees.
 *   - instruments the world cannot support are disabled and SAY SO, using the
 *     worker's own resolution as the reason — no click that ends in "not
 *     available" when the answer was knowable beforehand.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { IncidentKind } from "@/sim/incidents";
import { useUiStore } from "@/store/ui-store";
import {
  INCIDENT_WARNING_BODY,
  INCIDENT_WARNING_CANCEL,
  INCIDENT_WARNING_CONFIRM,
  INCIDENT_WARNING_TITLE,
  firstCleanRunWarning,
  incidentAvailability,
  unavailableIncidentHint,
} from "./ui-model";

interface IncidentOption {
  readonly kind: IncidentKind;
  readonly label: string;
  readonly hint: string;
  readonly icon: () => React.JSX.Element;
}

const iconProps = {
  width: 12,
  height: 12,
  viewBox: "0 0 12 12",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const INCIDENTS: readonly IncidentOption[] = [
  {
    kind: "traffic-burst",
    label: "+5× Traffic",
    hint: "More cars arriving across the city",
    icon: () => (
      <svg {...iconProps}>
        <path d="M2.5 9.5 6 4.5l3.5 5" />
        <path d="M2.5 6.5 6 1.5l3.5 5" />
      </svg>
    ),
  },
  {
    kind: "crash",
    label: "Crash",
    hint: "Block the busiest approach",
    icon: () => (
      <svg {...iconProps}>
        <path d="M6 1.5v3.2M6 7.3v3.2M1.5 6h3.2M7.3 6h3.2" />
        <path d="M3 3l1.6 1.6M7.4 7.4 9 9M9 3 7.4 4.6M4.6 7.4 3 9" />
      </svg>
    ),
  },
  {
    kind: "close-road",
    label: "Close Road",
    hint: "Close a road and force rerouting",
    icon: () => (
      <svg {...iconProps}>
        <path d="M1.5 4.5h9M1.5 7.5h9" />
        <path d="M3.5 4.5v3M8.5 4.5v3" />
      </svg>
    ),
  },
  {
    kind: "bridge-closed",
    label: "Bridge Closed",
    hint: "Close a river crossing",
    icon: () => (
      <svg {...iconProps}>
        <path d="M1.5 8.5h9" />
        <path d="M1.5 8.5c2-3.4 7-3.4 9 0" />
        <path d="M6 4.6v3.9" />
      </svg>
    ),
  },
  {
    kind: "event-release",
    label: "Event Lets Out",
    hint: "Release a crowd onto the streets",
    icon: () => (
      <svg {...iconProps}>
        <path d="M2 6h5.5" />
        <path d="M5.5 3.5 8 6l-2.5 2.5" />
        <path d="M10 2.5v7" />
      </svg>
    ),
  },
];

const ARMED_MS = 600;
const FEEDBACK_MS = 2400;

/**
 * What the dock says between the click and the worker's own answer. It names the
 * thing being looked for, in the dock's plain words — the worker still owns the
 * truth (it reports what was actually queued, or why nothing was).
 */
function resolvingCopy(kind: IncidentKind): string {
  switch (kind) {
    case "traffic-burst":
      return "Adding traffic across the city…";
    case "crash":
      return "Finding an approach to block…";
    case "close-road":
      return "Finding a road to close…";
    case "bridge-closed":
      return "Finding a river crossing to close…";
    case "event-release":
      return "Releasing a crowd onto the streets…";
  }
}

export function IncidentBar({ onIncident }: { onIncident: (kind: IncidentKind) => void }) {
  const phase = useUiStore((state) => state.phase);
  const feedback = useUiStore((state) => state.feedback);
  const flashSurge = useUiStore((state) => state.flashSurge);
  const showSurge = useUiStore((state) => state.showSurge);
  const hideSurge = useUiStore((state) => state.hideSurge);
  const runComplete = useUiStore((state) => state.runComplete);
  const modified = useUiStore((state) => state.modified);
  const manualIncidents = useUiStore((state) => state.manualIncidents);
  const cleanRunWarningShown = useUiStore((state) => state.cleanRunWarningShown);
  const capabilities = useUiStore((state) => state.incidentCapabilities);
  const noteCleanRunWarning = useUiStore((state) => state.noteCleanRunWarning);
  const [armed, setArmed] = useState<IncidentKind | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /** The instrument waiting for the user to accept that the run stops comparing. */
  const [pending, setPending] = useState<IncidentOption | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  // Worker feedback is authoritative because manual targeting can legitimately
  // be not-applicable (for example, no safe route-relevant bridge). Keep the
  // message long enough to read, then clear exactly the message we showed.
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => {
      const store = useUiStore.getState();
      if (store.feedback === feedback) store.setFeedback(null);
    }, FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const fire = (option: IncidentOption) => {
    onIncident(option.kind);
    if (option.kind === "traffic-burst") {
      flashSurge();
      showSurge();
      timers.current.push(window.setTimeout(() => hideSurge(), 6000));
    }
    setArmed(option.kind);
    // Do not claim success before the worker has resolved a concrete target.
    useUiStore.getState().setFeedback(resolvingCopy(option.kind));
    timers.current.push(
      window.setTimeout(
        () => setArmed((current) => (current === option.kind ? null : current)),
        ARMED_MS,
      ),
    );
  };

  /**
   * The gate: the first incident that would end this run's comparability asks
   * first. Once the run is modified — by an incident or a live setting change —
   * nothing is asked again, because the warning has already been given.
   */
  const request = (option: IncidentOption) => {
    if (!cleanRunWarningShown && firstCleanRunWarning({ modified, manualIncidents })) {
      setPending(option);
      setHint(null);
      return;
    }
    fire(option);
  };

  const acceptPending = () => {
    const option = pending;
    setPending(null);
    noteCleanRunWarning();
    if (option !== null) fire(option);
  };

  const live = phase === "city" && !runComplete;
  // Queued feedback outranks the hover hint: after a click the cursor is
  // still on the button, and the confirmation is what matters.
  const line = pending === null ? (feedback ?? hint) : null;

  return (
    <motion.div
      aria-hidden={!live}
      className={`pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex flex-col items-center gap-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 ${live ? "" : "invisible"}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: live ? 1 : 0, y: live ? 0 : 8 }}
      transition={{ duration: 0.32, delay: live ? 0.12 : 0, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="surface pointer-events-auto flex w-full max-w-full flex-col p-1 sm:w-auto">
        <div
          className="grid h-6 items-center px-2.5 text-meta font-medium text-ink-70"
          aria-live="polite"
        >
          <AnimatePresence mode="wait">
            {line && !runComplete && (
              <motion.span
                key={line}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="block truncate"
              >
                {line}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {pending === null ? (
          <div className="grid grid-cols-3 items-center gap-1 sm:flex sm:gap-1.5">
            {INCIDENTS.map((option) => {
              const availability = incidentAvailability(option.kind, capabilities);
              const Icon = option.icon;
              const isArmed = armed === option.kind;
              const unavailableHint = availability.applicable
                ? null
                : unavailableIncidentHint(availability);
              return (
                <span
                  key={option.kind}
                  // A disabled control still needs to explain itself, so the
                  // reason lives on the wrapper that can receive the hover.
                  title={unavailableHint ?? option.hint}
                  onMouseEnter={() => setHint(unavailableHint ?? option.hint)}
                  onMouseLeave={() => setHint((current) => (current === option.hint ? null : current))}
                >
                  <button
                    type="button"
                    disabled={!live || !availability.applicable}
                    aria-disabled={!availability.applicable}
                    aria-label={
                      availability.applicable
                        ? option.label
                        : `${option.label} unavailable. ${unavailableHint}`
                    }
                    onClick={() => request(option)}
                    onMouseEnter={() => setHint(unavailableHint ?? option.hint)}
                    onMouseLeave={() => setHint((current) => (current === option.hint ? null : current))}
                    onFocus={() => setHint(unavailableHint ?? option.hint)}
                    onBlur={() => setHint((current) => (current === option.hint ? null : current))}
                  className={`flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-1.5 text-meta font-medium transition-colors duration-150 sm:w-auto sm:px-3 ${
                      isArmed
                        ? "bg-ink text-surface"
                        : availability.applicable
                          ? "text-ink-70 hover:bg-ink/[0.05] hover:text-ink"
                          : "cursor-not-allowed text-ink-38"
                    }`}
                  >
                    <Icon />
                    {option.label}
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <div
            role="group"
            aria-label={INCIDENT_WARNING_TITLE}
            className="flex flex-wrap items-center justify-center gap-2 px-2 py-[6px]"
          >
            <span className="max-w-[340px] text-meta leading-snug text-ink-70">
              {INCIDENT_WARNING_BODY}
            </span>
            <button
              type="button"
              onClick={acceptPending}
              className="h-7 whitespace-nowrap rounded-[5px] bg-ink px-2.5 text-meta font-medium text-surface transition-opacity duration-150 hover:opacity-90"
            >
              {INCIDENT_WARNING_CONFIRM}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="h-7 whitespace-nowrap rounded-[5px] px-2.5 text-meta font-medium text-ink-70 transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink"
            >
              {INCIDENT_WARNING_CANCEL}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
