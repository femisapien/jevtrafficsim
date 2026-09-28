"use client";

/**
 * ControlTile (Issue #46; flattened in the tile-as-object pass).
 *
 * The ONE control surface in the top-right corner while a control ahead is
 * relevant. It renders the state the map marker is showing, from the same
 * derivation (`deriveControlTile`, built on the marker's own sprite decision),
 * so the two can never disagree.
 *
 * It is a TILE THAT SHOWS THE OBJECT, not a dot beside a word: a complete
 * three-lamp signal head with the authoritative lamp lit and the other two
 * unlit, or a complete stop-sign octagon with STOP on its face. A viewer who has
 * never seen this product should know what it is in one glance.
 *
 * Both objects are drawn FLAT. The roadside sprite is the full-detail object at
 * map scale — bevelled housing, lamp wells, a specular core on the lit lens —
 * because it is drawn tiny in map metres. This tile is drawn large on paper and
 * needs none of that: one housing fill, three plain lamp circles, one red
 * octagon with a white band. Same geometry, same inks, less drawing.
 *
 * Phone pass: the same objects, drawn by the same code, at chip scale. A 132px
 * tile is a quarter of a 390px screen and took the route with it, so the phone
 * gets a compact chip that still shows the whole head, or the whole sign, with
 * the lit lens at full strength. Nothing about the drawing changes — only the
 * CSS box the sprite cell is scaled into.
 *
 * Both objects are drawn in the marker sprite's OWN coordinate systems
 * (render/control-sprites.ts: a 128x320 head cell, a 256x256 sign cell) with the
 * marker's own housing and sign inks, so the tile and the roadside marker read as
 * the same physical object at two sizes. The only STATE ink in this file is
 * `CONTROL_MARKER_COLORS` — never a literal, never a guessed colour, never a
 * countdown, and nothing animated that implies progress. When the state is null
 * the tile renders nothing, and it disappears the moment the control is passed.
 */
import { AnimatePresence, motion } from "motion/react";
import { CONTROL_MARKER_COLORS } from "@/render/control-sprites";
import type { ControlTileLamp, ControlTileState } from "@/render/control-tile";

const LAMP_LABEL: Record<ControlTileLamp, string> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
};

const EASE = [0.22, 1, 0.36, 1] as const;

/* ------------------------------------------------------------------ */
/* Object inks                                                         */
/* ------------------------------------------------------------------ */

/** The head's own ink: the marker sprite's graphite housing, one flat fill. */
const HOUSING = "#23262a";
/**
 * An unlit lens is the marker's own colour laid on the flat housing at a low
 * alpha: dark and low-saturation, so it reads as a lens that is OFF rather than
 * as a second lamp that is on (bright "dim" lamps read as lit).
 */
const UNLIT_ALPHA = 0.22;
/** The sign's white — the marker sprite's own sign tone. */
const SIGN_WHITE = "#f6efe2";

/* ------------------------------------------------------------------ */
/* Size                                                                */
/* ------------------------------------------------------------------ */

/**
 * The tile's content box. Both objects are drawn in their own sprite cell and
 * scaled by CSS: the same signal head is a 76x190 object on a laptop and a
 * 22x55 chip on a phone, where a roadside-sized tile would be a quarter of the
 * screen and would steal the route it is supposed to serve.
 */
const SIGNAL_BOX = "h-[55px] w-[22px] sm:h-[190px] sm:w-[76px]";
/** The stop sign is square, so it needs one number, not an aspect ratio. */
const SIGN_BOX = "h-[36px] w-[36px] sm:h-[104px] sm:w-[104px]";

/* ------------------------------------------------------------------ */
/* The signal head — the whole object                                  */
/* ------------------------------------------------------------------ */

/** The three lamp positions in the sprite's own cell: red on top, green at the bottom. */
const SIGNAL_LAMPS = [
  { lamp: "red", cy: 66 },
  { lamp: "yellow", cy: 160 },
  { lamp: "green", cy: 254 },
] as const;

/** One housing rect at the sprite's own aspect: inset 10 a side, lamps 44 across. */
const HOUSING_BOX = { x: 10, y: 8, width: 108, height: 304, rx: 28 } as const;
const LAMP_RADIUS = 44;
/**
 * The lit lamp's one piece of detail: a single thin ring inside the lens edge.
 * It says "lit glass" without a glow, a halo or a second light source — the
 * full-strength marker colour is what carries the state.
 */
const LENS_RING_RADIUS = 37;

/** A complete three-lamp head: one flat housing, three lamps, one of them lit. */
function SignalHead({ lit }: { lit: ControlTileLamp }) {
  return (
    <span className={`block shrink-0 ${SIGNAL_BOX}`}>
      <svg
        aria-hidden="true"
        className="block h-full w-full"
        viewBox="0 0 128 320"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect
          x={HOUSING_BOX.x}
          y={HOUSING_BOX.y}
          width={HOUSING_BOX.width}
          height={HOUSING_BOX.height}
          rx={HOUSING_BOX.rx}
          fill={HOUSING}
        />
        {SIGNAL_LAMPS.map(({ lamp, cy }) => {
          const on = lamp === lit;
          return (
            <g key={lamp}>
              <circle
                cx={64}
                cy={cy}
                r={LAMP_RADIUS}
                fill={CONTROL_MARKER_COLORS[lamp]}
                fillOpacity={on ? 1 : UNLIT_ALPHA}
              />
              {on && (
                <circle
                  cx={64}
                  cy={cy}
                  r={LENS_RING_RADIUS}
                  fill="none"
                  stroke="#ffffff"
                  strokeOpacity={0.38}
                  strokeWidth={3}
                />
              )}
            </g>
          );
        })}
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The stop sign — the whole object                                    */
/* ------------------------------------------------------------------ */

/** Octagon geometry, in the sprite's own 256x256 sign cell. */
const SIGN_RADIUS = 121;
const SIGN_CENTER = 128;

function octagonPoints(radius: number): string {
  return Array.from({ length: 8 }, (_, corner) => {
    const angle = Math.PI / 8 + (corner * Math.PI) / 4;
    return `${(SIGN_CENTER + Math.cos(angle) * radius).toFixed(2)},${(SIGN_CENTER + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ");
}

const SIGN_FACE = octagonPoints(SIGN_RADIUS);
/**
 * The white band just inside the face, as on the roadside sign: one stroked
 * octagon, mitred so its corners stay an octagon instead of rounding off.
 */
const SIGN_BAND = octagonPoints(SIGN_RADIUS * Math.cos(Math.PI / 8) - 4);

/** The entire sign as an object: flat red octagon, white band, STOP on its face. */
function StopSign() {
  return (
    <span className={`block shrink-0 ${SIGN_BOX}`}>
      <svg
        aria-hidden="true"
        className="block h-full w-full"
        viewBox="0 0 256 256"
        preserveAspectRatio="xMidYMid meet"
      >
        <polygon points={SIGN_FACE} fill={CONTROL_MARKER_COLORS.stop} />
        <polygon
          points={SIGN_BAND}
          fill="none"
          stroke={SIGN_WHITE}
          strokeWidth={7}
          strokeLinejoin="miter"
        />
        <text
          x={SIGN_CENTER}
          y={SIGN_CENTER}
          dy="0.35em"
          textAnchor="middle"
          fontSize={62}
          fontWeight={700}
          letterSpacing={1}
          fill={SIGN_WHITE}
          className="font-sans"
        >
          STOP
        </text>
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The tile                                                            */
/* ------------------------------------------------------------------ */

/**
 * The visible object is the star; the state is still carried in text for
 * assistive tech, and never as a second visual label beside the object.
 */
function Body({ state }: { state: ControlTileState }) {
  if (state.kind === "stop") {
    return (
      <>
        <StopSign />
        <span className="sr-only">Stop sign, stop</span>
      </>
    );
  }
  if (state.lamp === null) {
    return null;
  }
  return (
    <>
      <SignalHead lit={state.lamp} />
      <span className="sr-only">Traffic light, {LAMP_LABEL[state.lamp].toLowerCase()}</span>
    </>
  );
}

export function ControlTile({ state }: { state: ControlTileState | null }) {
  return (
    <AnimatePresence>
      {state !== null && (
        <motion.div
          key="control-tile"
          data-control-tile={state.kind}
          data-control-lamp={state.lamp ?? "none"}
          // Top-right, clear of the two things that already live there: the OSM
          // attribution (top-2, ~10px tall) on wide screens, and the utilities
          // strip (top-3, ~48px tall) on a phone. The phone's chip is ~38px wide
          // and stays inside the narrowest supported viewport (360px).
          className="pointer-events-none absolute right-2 top-[68px] z-10 sm:top-8"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.26, ease: EASE }}
        >
          <div
            role="status"
            aria-label="Control ahead"
            className="surface flex w-auto items-center justify-center p-2 sm:w-[132px] sm:flex-col sm:px-3.5 sm:py-3.5"
          >
            <Body state={state} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
