import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import { THEME } from "../theme";

const mono = loadMono("normal", { weights: ["400", "500", "600"] });

// Values from `src/styles/variables.css` (light theme).
export const INK = {
  primary: "#111318",
  secondary: "#4a4f58",
  tertiary: "#6b7079",
  rule: "#e4e4df",
  ground: THEME.paper,
  card: "#ffffff",
  yellow: "#ffd21e",
  yellowSoft: "#fff4c9",
};

export const FONT = {
  sans: THEME.sans,
  serif: THEME.serif,
  mono: mono.fontFamily,
};

export const monoLabel = {
  fontFamily: FONT.mono,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
} as const;

export const tint = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, #ffffff)`;
