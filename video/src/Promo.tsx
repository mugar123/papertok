import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { SCRIPT } from "./script";
import type { Block } from "./script";
import { ArxivOpen } from "./scenes/ArxivOpen";
import { LogoZoom } from "./scenes/LogoZoom";
import { TitleCard } from "./scenes/TitleCard";
import { FeedSwipe } from "./scenes/FeedSwipe";
import { ReaderAnnotate } from "./scenes/ReaderAnnotate";
import { ListsSave } from "./scenes/ListsSave";
import { ExplorerThread } from "./scenes/ExplorerThread";
import { ResearchReport } from "./scenes/ResearchReport";
import { Outro } from "./scenes/Outro";

const renderBlock = (b: Block): React.ReactNode => {
  switch (b.id) {
    case "arxiv":    return <ArxivOpen />;
    case "zoom":     return <LogoZoom />;
    case "feed":     return <FeedSwipe />;
    case "reader":   return <ReaderAnnotate />;
    case "lists":    return <ListsSave />;
    case "explorer": return <ExplorerThread />;
    case "research": return <ResearchReport />;
    case "outro":    return <Outro />;
    default:
      if (b.kind === "card") {
        return <TitleCard text={b.text!} highlight={b.highlight!} />;
      }
      // Si el guion gana un bloque sin escena, el render falla en voz alta.
      throw new Error(`Bloque sin componente: ${b.id}`);
  }
};

export const Promo: React.FC = () => (
  <AbsoluteFill>
    <Series>
      {SCRIPT.map((b) => (
        <Series.Sequence key={b.id} durationInFrames={b.durationInFrames}>
          {renderBlock(b)}
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
