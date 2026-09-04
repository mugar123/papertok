import React from "react";
import { useCurrentFrame } from "remotion";
import { THEME } from "../theme";
import { charsVisible } from "./typewriter-core";

export { charsVisible };

export const Typewriter: React.FC<{
  text: string;
  charsPerFrame?: number;
  delay?: number;
  style?: React.CSSProperties;
  highlight?: string;
  highlightColor?: string;
}> = ({
  text,
  charsPerFrame = 1.6,
  delay = 0,
  style,
  highlight,
  highlightColor = THEME.accent,
}) => {
  const frame = useCurrentFrame();
  const n = charsVisible(frame, text.length, charsPerFrame, delay);
  const shown = text.slice(0, n);

  if (!highlight) return <span style={style}>{shown}</span>;

  // La palabra destacada se colorea solo en la parte ya escrita.
  const at = text.indexOf(highlight);
  const before = shown.slice(0, Math.min(n, at));
  const inside = shown.slice(Math.min(n, at), Math.min(n, at + highlight.length));
  const after = shown.slice(Math.min(n, at + highlight.length));

  return (
    <span style={style}>
      {before}
      <span style={{ color: highlightColor }}>{inside}</span>
      {after}
    </span>
  );
};
