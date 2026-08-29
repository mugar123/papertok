export type Block = {
  id: string;
  kind: "arxiv" | "zoom" | "card" | "scene" | "outro";
  durationInFrames: number;
  text?: string;
  highlight?: string;
  shot?: string;
};

export const SCRIPT: Block[] = [
  { id: "arxiv", kind: "arxiv", durationInFrames: 540 },
  { id: "zoom", kind: "zoom", durationInFrames: 240 },

  { id: "card1", kind: "card", durationInFrames: 180,
    text: "Introducing PaperTok", highlight: "PaperTok" },

  { id: "card2", kind: "card", durationInFrames: 150,
    text: "Science, one swipe at a time", highlight: "swipe" },
  { id: "feed", kind: "scene", durationInFrames: 420, shot: "feed" },

  { id: "card3", kind: "card", durationInFrames: 150,
    text: "Read it like it was written for you", highlight: "written for you" },
  { id: "reader", kind: "scene", durationInFrames: 480, shot: "reader" },

  { id: "card4", kind: "card", durationInFrames: 150,
    text: "Keep what matters", highlight: "matters" },
  { id: "lists", kind: "scene", durationInFrames: 390, shot: "lists" },

  { id: "card5", kind: "card", durationInFrames: 150,
    text: "Follow the thread", highlight: "thread" },
  { id: "explorer", kind: "scene", durationInFrames: 420, shot: "explorer" },

  { id: "card6", kind: "card", durationInFrames: 150,
    text: "A week of reading, one report", highlight: "one report" },
  { id: "research", kind: "scene", durationInFrames: 540, shot: "research" },

  { id: "card7", kind: "card", durationInFrames: 180,
    text: "Put science back in your feed", highlight: "feed" },
  { id: "outro", kind: "outro", durationInFrames: 780 },
];

export const TOTAL_FRAMES = SCRIPT.reduce(
  (n, b) => n + b.durationInFrames,
  0
);

export const startFrameOf = (id: string): number => {
  let acc = 0;
  for (const b of SCRIPT) {
    if (b.id === id) return acc;
    acc += b.durationInFrames;
  }
  throw new Error(`Bloque desconocido: ${id}`);
};
