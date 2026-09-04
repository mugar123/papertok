import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { THEME } from "../theme";

// 420 fotogramas: la primera tarjeta en reposo; a partir del 150 un único
// swipe vertical con muelle deja la segunda asentada en el centro.
const CARD_W = 1400;
const CARD_H = 875; // 1400 * 2000/3200
const GAP = 80;

const Card: React.FC<{ src: string; y: number }> = ({ src, y }) => (
  <Img
    src={staticFile(`shots/${src}`)}
    style={{
      width: CARD_W,
      position: "absolute",
      left: (1920 - CARD_W) / 2,
      top: (1080 - CARD_H) / 2 + y,
      borderRadius: 16,
      boxShadow: "0 40px 120px rgba(17,19,24,0.18)",
    }}
  />
);

export const FeedSwipe: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - 150, fps, config: { damping: 200 } });
  const shift = interpolate(progress, [0, 1], [0, -(CARD_H + GAP)]);
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: THEME.paper, opacity: fade, overflow: "hidden" }}>
      <Card src="feed-a.png" y={shift} />
      <Card src="feed-b.png" y={shift + CARD_H + GAP} />
    </AbsoluteFill>
  );
};
