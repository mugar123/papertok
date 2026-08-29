import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { ArxivWordmark } from "../assets/arxiv-wordmark";

// 240 fotogramas: zoom 1 -> 40 sobre la chi del logotipo (0-180) mientras el
// punto de anclaje viaja al centro del cuadro; fundido a negro (180-235).
const ORIGIN_X = 79;
const ORIGIN_Y = 30.5;

const smooth = (t: number) => t * t * (3 - 2 * t);

export const LogoZoom: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, 180], [0, 1], {
    extrapolateRight: "clamp",
  });
  const progress = smooth(t);
  const scale = 1 + 39 * progress;
  const tx = (960 - ORIGIN_X) * progress;
  const ty = (540 - ORIGIN_Y) * progress;
  // Cruce a vectorial cuando el encuadre ya solo muestra el logotipo.
  const svgOpacity = interpolate(frame, [100, 135], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const black = interpolate(frame, [180, 235], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#1b1b1b", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: `${ORIGIN_X}px ${ORIGIN_Y}px`,
        }}
      >
        <Img
          src={staticFile("shots/arxiv-list.png")}
          style={{ width: 1920, position: "absolute", top: 0, left: 0 }}
        />
        <div style={{ position: "absolute", top: 0, left: 0, opacity: svgOpacity }}>
          <ArxivWordmark />
        </div>
      </div>
      <AbsoluteFill style={{ backgroundColor: "#000", opacity: black }} />
    </AbsoluteFill>
  );
};
