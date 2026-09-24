import React from "react";
import { useCurrentFrame } from "remotion";
import type { LoopPaper } from "./papers.ts";
import { PLAIN_WORDS } from "./papers.ts";
import { easeInOutCubic, easeOutCubic, progress, rise } from "./motion.ts";
import { T } from "./timeline.ts";
import { Bookmark, FileText, Heart, Sparkles } from "./icons";
import { FONT, INK, monoLabel, tint } from "./style";

export const CARD = { left: 1000, top: 150, w: 820, h: 780, padX: 60, padY: 56 };
export const RULE = { x: CARD.left + CARD.padX, y: CARD.top + CARD.padY, w: 56, h: 4 };
const READ_W = 200;
const PLAIN_W = 272;
const BTN_H = 54;
export const PLAIN_BUTTON = {
  x: CARD.left + CARD.padX + READ_W + 14 + PLAIN_W / 2,
  y: CARD.top + CARD.h - CARD.padY - BTN_H / 2,
};

type Reveal = (at: number, opts?: Parameters<typeof rise>[2]) => React.CSSProperties;

const revealer = (frame: number, built: boolean): Reveal => (at, opts) => {
  if (built) return {};
  const r = rise(frame, at, { duration: 20, distance: 14, blur: 6, ...opts });
  return { opacity: r.opacity, transform: `translateY(${r.y}px)`, filter: `blur(${r.blur}px)` };
};

const Abstract: React.FC<{ paper: LoopPaper; frame: number; plain: boolean }> = ({
  paper,
  frame,
  plain,
}) => {
  const words = paper.abstract.split(" ");
  const fade = (i: number): React.CSSProperties => {
    if (!plain || frame < T.dissolve) return {};
    const out = easeOutCubic(progress(frame, T.dissolve + i * 0.8, 12));
    return { opacity: 1 - out, filter: `blur(${out * 6}px)`, transform: `translateY(${-out * 8}px)` };
  };
  return (
    <p
      style={{
        margin: 0,
        fontFamily: FONT.serif,
        fontSize: 24,
        lineHeight: 1.52,
        color: "#3a3f47",
      }}
    >
      <span
        style={{
          float: "left",
          fontSize: 76,
          lineHeight: 0.8,
          margin: "8px 10px 0 0",
          color: paper.field,
          fontWeight: 500,
          ...fade(0),
        }}
      >
        {words[0][0]}
      </span>
      {words.map((word, i) => (
        <span key={i} style={{ display: "inline-block", marginRight: "0.26em", ...fade(i) }}>
          {i === 0 ? word.slice(1) : word}
        </span>
      ))}
    </p>
  );
};

const PlainWords: React.FC<{ frame: number }> = ({ frame }) => {
  if (frame < T.plainIn - 6) return null;
  const chip = rise(frame, T.plainIn - 6, { duration: 18, distance: 8, blur: 4 });
  const before = PLAIN_WORDS.before.trim().split(" ");
  const hl = PLAIN_WORDS.highlight.split(" ");
  const sweep = easeInOutCubic(progress(frame, T.highlight, 30));
  const word = (w: string, i: number) => {
    const r = rise(frame, T.plainIn + i * 2.2, { duration: 20, distance: 12, blur: 8 });
    return (
      <span
        key={i}
        style={{
          display: "inline-block",
          marginRight: "0.24em",
          opacity: r.opacity,
          transform: `translateY(${r.y}px)`,
          filter: `blur(${r.blur}px)`,
        }}
      >
        {w}
      </span>
    );
  };
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        style={{
          ...monoLabel,
          fontSize: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: INK.yellowSoft,
          color: INK.primary,
          borderRadius: 3,
          marginBottom: 16,
          opacity: chip.opacity,
          transform: `translateY(${chip.y}px)`,
        }}
      >
        <Sparkles size={15} color={INK.primary} />
        In plain words
      </div>
      <p
        style={{
          margin: 0,
          fontFamily: FONT.serif,
          fontSize: 34,
          lineHeight: 1.3,
          color: INK.primary,
          letterSpacing: "-0.005em",
        }}
      >
        {before.map(word)}
        <span
          style={{
            backgroundImage: `linear-gradient(transparent 52%, ${INK.yellow} 52%, ${INK.yellow} 84%, transparent 84%)`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${sweep * 100}% 100%`,
            boxDecorationBreak: "clone",
            WebkitBoxDecorationBreak: "clone",
          }}
        >
          {hl.map((w, i) => word(w, before.length + i))}
        </span>
      </p>
    </div>
  );
};

export const Card: React.FC<{
  paper: LoopPaper;
  built?: boolean;
  plain?: boolean;
  hideRule?: boolean;
  contentOpacity?: number;
}> = ({ paper, built = true, plain = false, hideRule = false, contentOpacity = 1 }) => {
  const frame = useCurrentFrame();
  const reveal = revealer(frame, built);
  const titleWords = paper.title.split(" ");
  const press = plain ? progress(frame, T.press - 4, 14) : 0;
  const pressScale = 1 - 0.05 * Math.sin(Math.PI * press);
  const pressed = plain && frame >= T.press;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: `${CARD.padY}px ${CARD.padX}px`,
        display: "flex",
        flexDirection: "column",
        opacity: contentOpacity,
      }}
    >
      <div style={{ position: "absolute", top: CARD.padY - 4, right: CARD.padX - 4, display: "flex", gap: 18, ...reveal(T.actions + 6) }}>
        <Heart size={26} color="#8a8f98" />
        <Bookmark size={26} color="#8a8f98" />
      </div>

      <div style={{ height: RULE.h, width: RULE.w, background: paper.field, opacity: hideRule ? 0 : 1 }} />

      <div style={{ ...monoLabel, fontSize: 17, marginTop: 24, color: paper.field, ...reveal(T.label) }}>
        {paper.label}
        <span style={{ color: INK.tertiary }}> · {paper.year}</span>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {paper.concepts.map((c, i) => (
          <span
            key={c}
            style={{
              fontFamily: FONT.sans,
              fontSize: 17,
              fontWeight: 500,
              color: paper.field,
              background: tint(paper.field, 8),
              border: `1px solid ${tint(paper.field, 26)}`,
              borderRadius: 3,
              padding: "5px 12px",
              ...reveal(T.chips + i * 4),
            }}
          >
            {c}
          </span>
        ))}
      </div>

      <h2
        style={{
          margin: "22px 0 0",
          fontFamily: FONT.serif,
          fontWeight: 600,
          fontSize: 48,
          lineHeight: 1.08,
          letterSpacing: "-0.012em",
          color: INK.primary,
        }}
      >
        {titleWords.map((w, i) => (
          <span key={i} style={{ display: "inline-block", marginRight: "0.24em", ...reveal(T.title + i * 3, { duration: 24, distance: 20, blur: 8 }) }}>
            {w}
          </span>
        ))}
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 20, ...reveal(T.authors) }}>
        <div style={{ display: "flex" }}>
          {paper.initials.map((ini, i) => (
            <span
              key={ini}
              style={{
                width: 30,
                height: 30,
                borderRadius: 999,
                marginLeft: i ? -8 : 0,
                background: tint(paper.field, 12),
                border: "2px solid #fff",
                color: paper.field,
                fontFamily: FONT.mono,
                fontSize: 10,
                fontWeight: 600,
                display: "grid",
                placeItems: "center",
              }}
            >
              {ini}
            </span>
          ))}
        </div>
        <span style={{ fontFamily: FONT.sans, fontSize: 19, color: INK.secondary }}>{paper.authors}</span>
      </div>

      <div style={{ height: 1, background: INK.rule, margin: "22px 0", ...reveal(T.abstract - 4) }} />

      <div
        style={{
          position: "relative",
          flex: 1,
          overflow: "hidden",
          maskImage: pressed ? undefined : "linear-gradient(#000 62%, transparent 100%)",
          ...reveal(T.abstract, { duration: 26 }),
        }}
      >
        <Abstract paper={paper} frame={frame} plain={plain} />
        {plain ? <PlainWords frame={frame} /> : null}
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 22, ...reveal(T.actions) }}>
        <span
          style={{
            width: READ_W,
            height: BTN_H,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: INK.primary,
            color: "#fff",
            borderRadius: 4,
            fontFamily: FONT.sans,
            fontWeight: 600,
            fontSize: 19,
          }}
        >
          <FileText size={20} color="#fff" />
          Read article
        </span>
        <span
          style={{
            width: PLAIN_W,
            height: BTN_H,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: INK.yellow,
            color: INK.primary,
            borderRadius: 4,
            fontFamily: FONT.sans,
            fontWeight: 600,
            fontSize: 19,
            transform: `scale(${pressScale})`,
            boxShadow: pressed ? `3px 3px 0 ${INK.primary}` : "none",
          }}
        >
          <Sparkles size={20} color={INK.primary} />
          Read in plain words
        </span>
      </div>
    </div>
  );
};
