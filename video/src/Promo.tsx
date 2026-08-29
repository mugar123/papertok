import React from "react";
import { AbsoluteFill } from "remotion";
import { THEME } from "./theme";

export const Promo: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: THEME.paper,
      justifyContent: "center",
      alignItems: "center",
    }}
  >
    <div style={{ fontFamily: THEME.sans, fontWeight: 700, fontSize: 120, color: THEME.ink }}>
      Inter 700 — PaperTok
    </div>
    <div style={{ fontFamily: THEME.serif, fontSize: 64, color: THEME.accent }}>
      Newsreader — arXiv
    </div>
  </AbsoluteFill>
);
