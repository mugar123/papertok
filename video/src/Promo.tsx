import React from "react";
import { Series } from "remotion";
import { ArxivOpen } from "./scenes/ArxivOpen";
import { LogoZoom } from "./scenes/LogoZoom";
import { TitleCard } from "./scenes/TitleCard";
import { FeedSwipe } from "./scenes/FeedSwipe";
import { Outro } from "./scenes/Outro";

// Montaje provisional con lo ya construido; el definitivo (Tarea 10)
// recorre SCRIPT cuando existan las cinco escenas de producto.
export const Promo: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={540}><ArxivOpen /></Series.Sequence>
    <Series.Sequence durationInFrames={240}><LogoZoom /></Series.Sequence>
    <Series.Sequence durationInFrames={180}>
      <TitleCard text="Introducing PaperTok" highlight="PaperTok" />
    </Series.Sequence>
    <Series.Sequence durationInFrames={150}>
      <TitleCard text="Science, one swipe at a time" highlight="swipe" />
    </Series.Sequence>
    <Series.Sequence durationInFrames={420}><FeedSwipe /></Series.Sequence>
    <Series.Sequence durationInFrames={3390}><Outro /></Series.Sequence>
  </Series>
);
