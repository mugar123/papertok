import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from "remotion";
import { Brand, TILE } from "./Brand";
import { Caption } from "./Caption";
import { CARD, Card, PLAIN_BUTTON, RULE } from "./Card";
import { Flood } from "./Flood";
import { Pointer } from "./icons";
import {
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  progress,
  trackPosition,
} from "./motion.ts";
import { FIELD, PAPERS } from "./papers.ts";
import { CAPTIONS, HEIGHT, T, WIDTH } from "./timeline.ts";
import { INK } from "./style";

const STEP = CARD.h + 72;
const LAST = PAPERS.length - 1;
const RULE_ON = T.cardIn + 24;

const cardFrame: React.CSSProperties = {
  position: "absolute",
  width: CARD.w,
  height: CARD.h,
  background: INK.card,
  border: `1px solid ${INK.rule}`,
  borderRadius: 8,
  boxShadow: "0 1px 2px rgba(17,19,24,0.04), 0 30px 70px -30px rgba(17,19,24,0.22)",
  overflow: "hidden",
};

// The collapsed flood becomes a single hairline, which travels into the first
// card and turns into its field rule.
const Thread: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.collapse + 12 || frame >= RULE_ON) return null;
  const on = progress(frame, T.collapse + 12, 8);
  const t = easeInOutCubic(progress(frame, T.breath, RULE_ON - T.breath));
  const w = lerp(1180, RULE.w, t);
  const h = lerp(2, RULE.h, t);
  const x = lerp(WIDTH / 2 - 590, RULE.x, t);
  const y = lerp(HEIGHT / 2 - 1, RULE.y, t);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        opacity: on,
        background: `color-mix(in srgb, ${FIELD.cs} ${t * 100}%, ${INK.primary})`,
      }}
    />
  );
};

const Track: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.cardIn || frame >= T.fold) return null;
  const p = trackPosition(frame);
  const v = (trackPosition(frame + 1) - trackPosition(frame - 1)) / 2;
  const enter = easeOutCubic(progress(frame, T.cardIn + 8, 22));
  const neighbours =
    easeOutCubic(progress(frame, T.caption3, 24)) * (1 - easeInCubic(progress(frame, T.caption4, 20)));

  return (
    <>
      {PAPERS.map((paper, i) => {
        const d = i - p;
        if (Math.abs(d) > 1.4) return null;
        const a = Math.min(1, Math.abs(d));
        return (
          <div
            key={paper.id}
            style={{
              ...cardFrame,
              left: CARD.left,
              top: CARD.top + d * STEP,
              opacity: lerp(1, 0.25 * neighbours, a) * enter,
              transform: `scale(${(1 - 0.06 * a) * lerp(0.985, 1, enter)})`,
              filter: `blur(${Math.min(3, Math.abs(v) * 22)}px)`,
            }}
          >
            <Card
              paper={paper}
              built={i > 0}
              plain={i === LAST}
              hideRule={i === 0 && frame < RULE_ON}
            />
          </div>
        );
      })}
    </>
  );
};

// The final card folds into the PT tile.
const Fold: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.fold || frame >= T.tileLand) return null;
  const q = easeInOutCubic(progress(frame, T.fold, T.tileLand - T.fold));
  const end = TILE * 0.94;
  const w = lerp(CARD.w, end, q);
  const h = lerp(CARD.h, end, q);
  const cx = lerp(CARD.left + CARD.w / 2, WIDTH / 2, q);
  const cy = lerp(CARD.top + CARD.h / 2, HEIGHT / 2, q);
  const yellow = progress(q, 0.3, 0.45);
  return (
    <div
      style={{
        ...cardFrame,
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        borderRadius: lerp(8, (end * 2) / 26, q),
        background: `color-mix(in srgb, ${INK.yellow} ${yellow * 100}%, ${INK.card})`,
        borderColor: `color-mix(in srgb, transparent ${yellow * 100}%, ${INK.rule})`,
        boxShadow: `0 30px 70px -30px rgba(17,19,24,${0.22 * (1 - q)})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: CARD.w,
          height: CARD.h,
          left: (w - CARD.w) / 2,
          top: (h - CARD.h) / 2,
        }}
      >
        <Card paper={PAPERS[LAST]} plain contentOpacity={1 - easeOutCubic(progress(q, 0, 0.22))} />
      </div>
    </div>
  );
};

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const leave = progress(frame, T.press + 50, 40);
  if (frame < T.pointerIn || leave >= 1) return null;
  const go = easeInOutCubic(progress(frame, T.pointerIn, T.press - 6 - T.pointerIn));
  const x = lerp(1660, PLAIN_BUTTON.x, go) + easeInCubic(leave) * 260;
  const y = lerp(1060, PLAIN_BUTTON.y, go) - Math.sin(go * Math.PI) * 60 + easeInCubic(leave) * 200;
  const click = progress(frame, T.press - 4, 12);
  const scale = 1 - 0.14 * Math.sin(Math.PI * click);
  return (
    <div
      style={{
        position: "absolute",
        left: x - 7.5,
        top: y - 4.7,
        transform: `scale(${scale})`,
        transformOrigin: "7.5px 4.7px",
        opacity: 1 - leave,
        filter: "drop-shadow(0 4px 8px rgba(17,19,24,0.18))",
      }}
    >
      <Pointer size={40} />
    </div>
  );
};

export const Loop: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: INK.ground, overflow: "hidden" }}>
    <Flood />
    {CAPTIONS.map((c) => (
      <Caption key={c.id} spec={c} />
    ))}
    <Thread />
    <Track />
    <Fold />
    <Cursor />
    <Brand />
    <Audio src={staticFile("audio/papertok-loop.wav")} />
  </AbsoluteFill>
);
