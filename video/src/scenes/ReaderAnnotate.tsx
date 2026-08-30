import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Typewriter } from "../components/Typewriter";
import { THEME } from "../theme";

// 480 fotogramas. Tres tiempos sobre el lector limpio:
// 60: selección azul sobre el resumen; 150: panel blanco a la derecha;
// 200: la respuesta IA se escribe dentro — texto real, no captura.
const ANSWER =
  "In plain words: instead of retraining the model for every task, GPT-3 is large enough to learn a new task from just a few examples written in the prompt.";

export const ReaderAnnotate: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const selOpacity = interpolate(frame, [60, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const panelX = interpolate(frame, [150, 175], [80, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const panelOpacity = interpolate(frame, [150, 172], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: THEME.paper, opacity: fade, overflow: "hidden" }}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <Img
            src={staticFile("shots/reader-clean.png")}
            style={{
              width: 1560,
              borderRadius: 16,
              boxShadow: "0 40px 120px rgba(17,19,24,0.25)",
              display: "block",
            }}
          />
          {/* Selección sobre el párrafo del abstract (coordenadas sobre 1560 de ancho). */}
          <div
            style={{
              position: "absolute",
              left: 640,
              top: 624,
              width: 444,
              height: 172,
              borderRadius: 6,
              backgroundColor: "rgba(26,95,208,0.18)",
              border: "2px solid rgba(26,95,208,0.55)",
              opacity: selOpacity,
            }}
          />
          {/* Panel de respuesta IA. */}
          <div
            style={{
              position: "absolute",
              right: 60,
              top: 160,
              width: 430,
              borderRadius: 14,
              backgroundColor: "#ffffff",
              boxShadow: "0 30px 90px rgba(17,19,24,0.3)",
              padding: "28px 30px",
              opacity: panelOpacity,
              transform: `translateX(${panelX}px)`,
            }}
          >
            <div
              style={{
                fontFamily: THEME.sans,
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: "0.08em",
                color: THEME.accent,
                marginBottom: 14,
              }}
            >
              ✦ EXPLAIN THIS
            </div>
            <div
              style={{
                fontFamily: THEME.sans,
                fontSize: 19,
                lineHeight: 1.55,
                color: THEME.ink,
                minHeight: 200,
              }}
            >
              <Typewriter text={ANSWER} charsPerFrame={0.9} delay={200} />
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
