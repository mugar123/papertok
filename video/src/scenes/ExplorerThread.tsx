import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { THEME } from "../theme";

// 420 fotogramas: paneo lento sobre la entidad de autor; en el 220,
// cruce por opacidad a la entidad de conceptos, que continúa el paneo.
const Pan: React.FC<{ src: string; x: number; opacity: number }> = ({
  src,
  x,
  opacity,
}) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
    <Img
      src={staticFile(`shots/${src}`)}
      style={{
        width: 1560,
        borderRadius: 16,
        boxShadow: "0 40px 120px rgba(17,19,24,0.18)",
        transform: `translateX(${x}px)`,
      }}
    />
  </AbsoluteFill>
);

export const ExplorerThread: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const pan = interpolate(frame, [0, 420], [60, -60]);
  const cross = interpolate(frame, [220, 250], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: THEME.paper, opacity: fade, overflow: "hidden" }}>
      {/* La de conceptos entra POR ENCIMA de la de autor a plena opacidad
          debajo: así el cruce no produce doble exposición fantasma. */}
      {cross < 1 && <Pan src="explorer-author.png" x={pan} opacity={1} />}
      {cross > 0 && <Pan src="explorer-concepts.png" x={pan} opacity={cross} />}
    </AbsoluteFill>
  );
};
