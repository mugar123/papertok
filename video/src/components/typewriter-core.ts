// Separado de Typewriter.tsx para que node --test no tenga que cargar remotion.
export const charsVisible = (
  frame: number,
  total: number,
  charsPerFrame: number,
  delay: number
): number => {
  if (frame < delay) return 0;
  return Math.min(total, Math.floor((frame - delay) * charsPerFrame));
};
