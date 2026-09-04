import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadNewsreader } from "@remotion/google-fonts/Newsreader";

const inter = loadInter();
const newsreader = loadNewsreader();

export const THEME = {
  ink: "#111318",
  accent: "#1a5fd0",
  paper: "#fafaf8",
  sans: inter.fontFamily,
  serif: newsreader.fontFamily,
};
