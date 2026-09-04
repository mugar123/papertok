import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

export const Screenshot: React.FC<{
  src: string;
  scale?: number;
  x?: number;
  y?: number;
  radius?: number;
}> = ({ src, scale = 1, x = 0, y = 0, radius = 16 }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
    <Img
      src={staticFile(`shots/${src}`)}
      style={{
        width: 1400,
        borderRadius: radius,
        boxShadow: "0 40px 120px rgba(17,19,24,0.18)",
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
      }}
    />
  </AbsoluteFill>
);
