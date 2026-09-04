import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Typewriter } from "../components/Typewriter";
import { THEME } from "../theme";

export const TitleCard: React.FC<{ text: string; highlight: string }> = ({
  text,
  highlight,
}) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: THEME.paper,
        justifyContent: "center",
        alignItems: "center",
        opacity: fade,
      }}
    >
      <div
        style={{
          fontFamily: THEME.sans,
          fontWeight: 700,
          fontSize: 96,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          color: THEME.ink,
          textAlign: "center",
          maxWidth: 1400,
        }}
      >
        <Typewriter text={text} highlight={highlight} />
      </div>
    </AbsoluteFill>
  );
};
