// One 15-second loop at 60 fps on a 120 BPM grid (one beat = 30 frames).
// Frame 0 and the last frame show the same image (the lone PT tile at the
// centre), so the picture can repeat without a seam. The sound track is
// synthesised from these same numbers by `scripts/loop-sound.mjs`.

export const FPS = 60;
export const BEAT = 30;
export const TOTAL = 900;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const sec = (frame: number): number => frame / FPS;

export const T = {
  // Act 1: the flood. The tile releases a stream of papers.
  tileRelease: 0,
  floodStart: 6,
  caption1a: 30,
  caption1b: 72,
  collapse: 126,
  breath: 146,

  // Act 2: one paper, assembled piece by piece.
  cardIn: 150,
  caption2: 162,
  label: 168,
  chips: 180,
  title: 186,
  authors: 210,
  abstract: 222,
  actions: 240,

  // Act 3: the feed, with swipes that accelerate towards the downbeat.
  caption3: 330,
  swipes: [360, 420, 480, 510, 540, 555] as const,

  // Act 4: the AI reading action.
  caption4: 600,
  pointerIn: 600,
  press: 640,
  dissolve: 646,
  plainIn: 668,
  highlight: 708,

  // Act 5: the card folds back into the mark.
  fold: 744,
  tileLand: 784,
  wordmark: 794,
  tagline: 806,
  outro: 872,
  rest: 896,
} as const;

// Duration of each swipe, paired with `T.swipes`. The last one is longer so
// the final card settles instead of stopping.
export const SWIPE_DURATIONS = [28, 28, 22, 22, 14, 40] as const;

// Frames a caption takes to leave; the next one enters only after.
export const CAPTION_EXIT = 16;

export type Caption = {
  id: string;
  kicker?: string;
  lines: string[];
  in: number;
  out: number;
  layout: "center" | "left";
};

export const CAPTIONS: Caption[] = [
  {
    id: "flood",
    lines: ["Thousands of new papers.", "Every day."],
    in: T.caption1a,
    out: T.collapse,
    layout: "center",
  },
  {
    id: "one",
    kicker: "01 · Discover",
    lines: ["Here\u2019s one", "worth your time."],
    in: T.caption2,
    out: T.caption3 - CAPTION_EXIT,
    layout: "left",
  },
  {
    id: "swipe",
    kicker: "02 · Swipe",
    lines: ["Science,", "one swipe at a time."],
    in: T.caption3,
    out: T.caption4 - CAPTION_EXIT,
    layout: "left",
  },
  {
    id: "plain",
    kicker: "03 · Understand",
    lines: ["Read it in", "plain words."],
    in: T.caption4,
    out: T.fold - 4,
    layout: "left",
  },
];

export const TAGLINE = "Put science back in your feed.";
