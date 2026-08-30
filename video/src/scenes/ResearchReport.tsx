import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { THEME } from "../theme";

// 540 fotogramas. La captura es alta (3200×4800): se revela por bandas
// (40, 120, 200) y después el encuadre baja despacio hasta dejar el
// mapa mundial y el informe visibles el resto de la escena.
const IMG_W = 1560;
const IMG_H = Math.round((IMG_W * 4800) / 3200); // 2340

export const ResearchReport: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  // Tres bandas horizontales que se revelan en cascada.
  const reveal = (start: number) =>
    interpolate(frame, [start, start + 50], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const r1 = reveal(40);
  const r2 = reveal(120);
  const r3 = reveal(200);
  const clipBottom =
    IMG_H * (1 - (r1 / 3 + r2 / 3 + r3 / 3));

  // Paneo vertical: arranca en la cabecera y termina con el mapa centrado.
  // Termina con el mapa mundial centrado en el cuadro (está a ~1/3 de la captura).
  const y = interpolate(frame, [220, 420], [0, -260], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (t) => 1 - (1 - t) * (1 - t),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: THEME.paper, opacity: fade, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: (1920 - IMG_W) / 2,
          top: 40 + y,
          width: IMG_W,
          height: IMG_H,
          borderRadius: 16,
          boxShadow: "0 40px 120px rgba(17,19,24,0.18)",
          overflow: "hidden",
        }}
      >
        <Img
          src={staticFile("shots/research-report.png")}
          style={{
            width: IMG_W,
            display: "block",
            clipPath: `inset(0 0 ${Math.max(0, clipBottom)}px 0)`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
