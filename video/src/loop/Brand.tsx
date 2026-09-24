import React from "react";
import { useCurrentFrame } from "remotion";
import { easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, lerp, progress } from "./motion.ts";
import { HEIGHT, T, TAGLINE, WIDTH } from "./timeline.ts";
import { FONT, INK } from "./style";

export const TILE = 150;
// The navbar mark is 26px with a 2px radius and a 2px hard shadow.
const R = (TILE * 2) / 26;
const WORDMARK_W = 560;
const GAP = 46;
const LOCKUP_DX = (WORDMARK_W + GAP) / 2;
const LOCKUP_DY = -34;

export const TileBox: React.FC<{
  cx: number;
  cy: number;
  size?: number;
  scale?: number;
  shadow?: number;
  letters?: number;
  opacity?: number;
}> = ({ cx, cy, size = TILE, scale = 1, shadow = 1, letters = 1, opacity = 1 }) => (
  <div
    style={{
      position: "absolute",
      left: cx - size / 2,
      top: cy - size / 2,
      width: size,
      height: size,
      transform: `scale(${scale})`,
      opacity,
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: R,
        background: INK.primary,
        transform: `translate(${R * shadow}px, ${R * shadow}px)`,
      }}
    />
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: R,
        background: INK.yellow,
        display: "grid",
        placeItems: "center",
        fontFamily: FONT.mono,
        fontWeight: 600,
        fontSize: size * 0.42,
        letterSpacing: "0.02em",
        color: INK.primary,
      }}
    >
      <span style={{ opacity: letters }}>PT</span>
    </div>
  </div>
);

const CX = WIDTH / 2;
const CY = HEIGHT / 2;

// Where the tile sits at a given frame of the closing act, and how.
const closingTile = (frame: number) => {
  const land = progress(frame, T.tileLand, 22);
  const toLockup = easeInOutCubic(progress(frame, T.wordmark, 32));
  const home = easeInOutCubic(progress(frame, T.outro, T.rest - T.outro));
  const k = toLockup * (1 - home);
  return {
    k,
    cx: CX - LOCKUP_DX * k,
    cy: CY + LOCKUP_DY * k,
    scale: land < 1 ? lerp(0.94, 1, easeOutBack(land, 2.2)) : 1,
    shadow: easeOutCubic(progress(frame, T.tileLand, 12)),
    letters: easeOutCubic(progress(frame, T.tileLand + 2, 14)),
  };
};

export const Brand: React.FC = () => {
  const frame = useCurrentFrame();

  if (frame < T.tileLand) {
    // The loop opens on the resting tile, which winds up and lets go.
    const squash = progress(frame, 0, 8);
    const go = easeInCubic(progress(frame, 8, 18));
    if (go >= 1) return null;
    return (
      <TileBox
        cx={CX}
        cy={CY}
        scale={lerp(1, 1.06, easeOutCubic(squash)) * (1 - go)}
        shadow={1 - go}
        opacity={1 - progress(frame, 18, 8)}
      />
    );
  }

  const tile = closingTile(frame);
  // The wordmark slides out from under the tile and later tucks back in;
  // anything left of the tile's centre is clipped away.
  const left = CX - LOCKUP_DX + TILE / 2 + GAP - LOCKUP_DX * (1 - tile.k);
  const hidden = Math.max(0, tile.cx - left);
  const shown = progress(frame, T.wordmark, 10) * (1 - progress(frame, T.rest - 6, 6));
  const band = easeInOutCubic(progress(frame, T.wordmark + 30, 22)) * (1 - easeInCubic(progress(frame, T.outro, 14)));
  const tagIn = easeOutCubic(progress(frame, T.tagline, 26));
  const tagOut = easeInCubic(progress(frame, T.outro, 16));

  return (
    <>
      <div
        style={{
          position: "absolute",
          left,
          top: CY + LOCKUP_DY - 80,
          width: WORDMARK_W,
          height: 160,
          display: "flex",
          alignItems: "center",
          opacity: shown,
          clipPath: `inset(-20% -10% -20% ${hidden}px)`,
        }}
      >
        <span
          style={{
            fontFamily: FONT.sans,
            fontWeight: 700,
            fontSize: 132,
            letterSpacing: "-0.035em",
            color: INK.primary,
            lineHeight: 1,
          }}
        >
          Paper
          <span
            style={{
              backgroundImage: `linear-gradient(transparent 60%, ${INK.yellow} 60%, ${INK.yellow} 82%, transparent 82%)`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${band * 100}% 100%`,
            }}
          >
            Tok
          </span>
        </span>
      </div>
      <TileBox cx={tile.cx} cy={tile.cy} scale={tile.scale} shadow={tile.shadow} letters={tile.letters} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: CY + LOCKUP_DY + 128,
          textAlign: "center",
          fontFamily: FONT.serif,
          fontStyle: "italic",
          fontSize: 50,
          letterSpacing: "-0.01em",
          color: INK.secondary,
          opacity: tagIn * (1 - tagOut),
          transform: `translateY(${(1 - tagIn) * 18 - tagOut * 10}px)`,
          filter: `blur(${(1 - tagIn) * 8 + tagOut * 6}px)`,
        }}
      >
        {TAGLINE}
      </div>
    </>
  );
};
