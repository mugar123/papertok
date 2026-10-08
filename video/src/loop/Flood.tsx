import React from "react";
import { useCurrentFrame } from "remotion";
import { FIELD } from "./papers.ts";
import { easeInCubic, easeOutCubic, lerp, mulberry32, progress } from "./motion.ts";
import { T, WIDTH } from "./timeline.ts";
import { FONT, INK } from "./style";

// Real arXiv category codes; the titles are abstract bars on purpose, so no
// invented paper can be read into the background.
const CODES: [string, string][] = [
  ["cs.LG", FIELD.cs], ["astro-ph.GA", FIELD.physics], ["q-bio.NC", FIELD.bio],
  ["math.AG", FIELD.math], ["stat.ML", FIELD.stat], ["econ.EM", FIELD.econ],
  ["quant-ph", FIELD.physics], ["cs.CL", FIELD.cs], ["hep-th", FIELD.physics],
  ["math.PR", FIELD.math], ["q-bio.GN", FIELD.bio], ["cond-mat", FIELD.physics],
  ["cs.CV", FIELD.cs], ["stat.ME", FIELD.stat], ["gr-qc", FIELD.physics],
  ["q-fin.ST", FIELD.econ], ["math.NT", FIELD.math], ["cs.RO", FIELD.cs],
];

const COLUMNS = 5;
const COL_W = 330;
const ROW_H = 50;
const ROWS = 28;
const SPAN = ROWS * ROW_H;

type Row = { code: string; color: string; bar: number; bar2: number };

const rand = mulberry32(20260924);
const GRID: { speed: number; offset: number; rows: Row[] }[] = Array.from(
  { length: COLUMNS },
  () => ({
    speed: 0.8 + rand() * 0.45,
    offset: rand() * SPAN,
    rows: Array.from({ length: ROWS }, () => {
      const [code, color] = CODES[Math.floor(rand() * CODES.length)];
      return { code, color, bar: 50 + rand() * 80, bar2: 30 + rand() * 60 };
    }),
  })
);

// Distance travelled with an accelerating speed: v(t) = 0.8 + 16 (t/L)^2.
const scroll = (f: number): number => {
  const L = T.collapse - T.floodStart;
  const t = Math.max(0, f - T.floodStart);
  return 0.8 * t + (16 * t ** 3) / (3 * L * L);
};

export const Flood: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.floodStart || frame > T.breath + 8) return null;

  const appear = easeOutCubic(progress(frame, T.floodStart, 40));
  const squeeze = easeInCubic(progress(frame, T.collapse, T.breath - T.collapse));
  const vanish = progress(frame, T.breath, 8);
  const s = scroll(Math.min(frame, T.breath));
  const gap = (WIDTH - COLUMNS * COL_W) / (COLUMNS + 1);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: appear * (1 - vanish),
        transform: `scale(${lerp(1, 0.62, squeeze)}, ${lerp(1, 0.004, squeeze)})`,
        transformOrigin: "50% 50%",
        maskImage:
          "radial-gradient(ellipse 46% 30% at 50% 50%, transparent 0%, transparent 55%, #000 100%)",
      }}
    >
      {GRID.map((col, c) => (
        <div
          key={c}
          style={{ position: "absolute", left: gap + c * (COL_W + gap), top: 0, width: COL_W }}
        >
          {col.rows.map((row, r) => {
            const y = (((r * ROW_H + col.offset - s * col.speed) % SPAN) + SPAN) % SPAN - ROW_H * 2;
            return (
              <div
                key={r}
                style={{
                  position: "absolute",
                  top: y,
                  left: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  height: ROW_H,
                  width: COL_W,
                  borderTop: `1px solid ${INK.rule}`,
                }}
              >
                <span style={{ width: 7, height: 7, background: row.color, flex: "none" }} />
                <span
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 14,
                    color: INK.tertiary,
                    width: 118,
                    flex: "none",
                  }}
                >
                  {row.code}
                </span>
                <span style={{ height: 7, width: row.bar, background: "rgba(17,19,24,0.12)", borderRadius: 1 }} />
                <span style={{ height: 7, width: row.bar2 * 0.5, background: "rgba(17,19,24,0.06)", borderRadius: 1 }} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
