import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { Typewriter } from "../components/Typewriter";
import { THEME } from "../theme";

// La captura es 6400x4000 (CSS 1600x1000). A pantalla completa se muestra a
// 1920 de ancho, anclada arriba: la parte visible es el listado real.
export const ArxivOpen: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#fff" }}>
    <Img
      src={staticFile("shots/arxiv-list.png")}
      style={{ width: 1920, position: "absolute", top: 0, left: 0 }}
    />
    <div
      style={{
        position: "absolute",
        left: 64,
        bottom: 64,
        padding: "28px 36px",
        backgroundColor: "rgba(250,250,248,0.92)",
        borderRadius: 8,
        maxWidth: 1100,
      }}
    >
      <div style={{ fontFamily: THEME.serif, fontSize: 48, color: THEME.ink, lineHeight: 1.35 }}>
        <Typewriter text="This is where science gets published." delay={60} charsPerFrame={0.9} />
      </div>
      <div style={{ fontFamily: THEME.serif, fontSize: 48, color: THEME.ink, lineHeight: 1.35 }}>
        <Typewriter text="It's just not where anyone reads it." delay={260} charsPerFrame={0.9} />
      </div>
    </div>
  </AbsoluteFill>
);
