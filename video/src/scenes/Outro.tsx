import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { THEME } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, 20], [0.94, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: THEME.paper,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Img
        src={staticFile("brand/favicon.svg")}
        style={{ width: 220, opacity: fade, transform: `scale(${scale})` }}
      />
    </AbsoluteFill>
  );
};
