import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Screenshot } from "../components/Screenshot";
import { THEME } from "../theme";

// 390 fotogramas: el modal de guardar entra (escala 0.96→1, opacidad 0→1);
// en el 200, corte a la rejilla de listas con la misma entrada.
const Enter: React.FC<{ src: string; start: number; frame: number }> = ({
  src,
  start,
  frame,
}) => {
  const t = frame - start;
  const opacity = interpolate(t, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(t, [0, 20], [0.96, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity }}>
      <Screenshot src={src} scale={scale} />
    </AbsoluteFill>
  );
};

export const ListsSave: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: THEME.paper }}>
      {frame < 200 ? (
        <Enter src="lists-modal.png" start={0} frame={frame} />
      ) : (
        <Enter src="lists-grid.png" start={200} frame={frame} />
      )}
    </AbsoluteFill>
  );
};
