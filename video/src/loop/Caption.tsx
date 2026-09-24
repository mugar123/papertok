import React from "react";
import { useCurrentFrame } from "remotion";
import type { Caption as CaptionSpec } from "./timeline.ts";
import { easeInCubic, progress, rise } from "./motion.ts";
import { FONT, INK, monoLabel } from "./style";

const EXIT = 16;

export const Caption: React.FC<{ spec: CaptionSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  if (frame < spec.in || frame > spec.out + EXIT) return null;

  const exit = easeInCubic(progress(frame, spec.out, EXIT));
  const centered = spec.layout === "center";

  const lineStyle = (i: number): React.CSSProperties => {
    const r = rise(frame, spec.in + 6 + i * 9, { duration: 26, distance: 26, blur: 12 });
    return {
      display: "block",
      opacity: r.opacity * (1 - exit),
      transform: `translateY(${r.y - exit * 14}px)`,
      filter: `blur(${r.blur + exit * 8}px)`,
    };
  };

  const kicker = rise(frame, spec.in, { duration: 20, distance: 10, blur: 4 });

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: centered ? 0 : 150,
        right: centered ? 0 : undefined,
        width: centered ? undefined : 760,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: centered ? "center" : "flex-start",
        textAlign: centered ? "center" : "left",
      }}
    >
      {spec.kicker ? (
        <div
          style={{
            ...monoLabel,
            fontSize: 19,
            color: INK.tertiary,
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 34,
            opacity: kicker.opacity * (1 - exit),
            transform: `translateY(${kicker.y}px)`,
          }}
        >
          <span
            style={{
              width: 32 * kicker.opacity,
              height: 2,
              background: INK.primary,
              display: "inline-block",
            }}
          />
          {spec.kicker}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: FONT.serif,
          fontWeight: 500,
          fontSize: centered ? 92 : 84,
          lineHeight: 1.06,
          letterSpacing: "-0.018em",
          color: INK.primary,
        }}
      >
        {spec.lines.map((line, i) => (
          <span
            key={line}
            style={{
              ...lineStyle(i),
              fontStyle: i === 1 ? "italic" : "normal",
              color: i === 1 && centered ? INK.tertiary : INK.primary,
            }}
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  );
};
