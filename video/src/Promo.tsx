import React from "react";
import { AbsoluteFill } from "remotion";
import { Screenshot } from "./components/Screenshot";
import { THEME } from "./theme";

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: THEME.paper }}>
    <Screenshot src="arxiv-list.png" />
  </AbsoluteFill>
);
