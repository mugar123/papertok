import React from "react";
import { Series } from "remotion";
import { ArxivOpen } from "./scenes/ArxivOpen";
import { LogoZoom } from "./scenes/LogoZoom";

export const Promo: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={540}><ArxivOpen /></Series.Sequence>
    <Series.Sequence durationInFrames={240}><LogoZoom /></Series.Sequence>
  </Series>
);
