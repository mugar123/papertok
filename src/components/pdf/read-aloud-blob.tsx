import { useEffect, useRef } from 'react';

const BLOB = { sensitivity: 2.1, morph: 0.55, lobes: 5, release: 0.73, size: 0.3, spin: 0.25 };
const SEGMENTS = 96;

/** A slow, uneven swell per lobe; quicker and larger while the voice speaks. */
function bands(time: number, speaking: boolean) {
  const pace = speaking ? 2.4 : 1;
  return Array.from({ length: BLOB.lobes }, (_, index) => {
    const level = 0.25 + 0.2 * Math.sin(time * pace * 0.9 + index * 1.7) * Math.sin(time * pace * 0.37 + index);
    return speaking ? Math.min(1.5, level * BLOB.sensitivity * 0.6) : level;
  });
}

/** Fast attack, slower release, so a swell lands at once and settles. */
function follow(levels: number[], next: number[]) {
  next.forEach((value, index) => {
    const last = levels[index] ?? 0;
    levels[index] = value > last ? last + (value - last) * 0.6 : last * BLOB.release + value * (1 - BLOB.release);
  });
  return levels;
}

function draw(element: HTMLCanvasElement, levels: number[], time: number, ready: boolean) {
  const context = element.getContext('2d');
  if (!context) return;
  const size = element.clientWidth;
  const ratio = window.devicePixelRatio || 1;
  if (element.width !== Math.round(size * ratio)) {
    element.width = Math.round(size * ratio);
    element.height = Math.round(size * ratio);
  }
  const centre = (size / 2) * ratio;
  const radius = size * BLOB.size * ratio * (ready ? 1 : 0.86);
  const energy = levels.reduce((sum, level) => sum + level, 0) / levels.length;
  const points: [number, number][] = [];
  for (let step = 0; step < SEGMENTS; step++) {
    const angle = (step / SEGMENTS) * Math.PI * 2;
    let wave = 0;
    levels.forEach((level, index) => { wave += level * Math.sin((index + 2) * angle + time * 0.4 * (index % 2 ? 1 : -1) + index); });
    const reach = Math.max(0.4, 1 + energy * 0.25 + (BLOB.morph * wave) / Math.sqrt(levels.length));
    points.push([centre + Math.cos(angle) * radius * reach, centre + Math.sin(angle) * radius * reach]);
  }
  const style = getComputedStyle(element);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const turn = time * BLOB.spin;
  const [dx, dy] = [Math.cos(turn) * radius * 1.4, Math.sin(turn) * radius * 1.4];
  const fill = context.createLinearGradient(centre - dx, centre - dy, centre + dx, centre + dy);
  // Until the audio is there the blob is the faint mesh colour; then it takes the brand's.
  const stops = ready ? ['--podcast-blob-from', '--podcast-blob-via', '--podcast-blob-to'].map(read) : Array(3).fill(read('--podcast-mesh'));
  if (stops.some(colour => !colour)) return;
  stops.forEach((colour, index) => fill.addColorStop(index / 2, colour));
  const middle = (index: number) => {
    const [a, b] = [points[index % SEGMENTS], points[(index + 1) % SEGMENTS]];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  };
  context.clearRect(0, 0, element.width, element.height);
  context.beginPath();
  context.moveTo(...middle(0));
  for (let index = 1; index <= SEGMENTS; index++) context.quadraticCurveTo(...points[index % SEGMENTS], ...middle(index));
  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

/**
 * The podcast tab's visualizer: a soft gradient blob that breathes on its own and
 * swells faster while the voice speaks. Still, drawn again only when its state
 * changes, with reduced motion.
 */
export default function ReadAloudBlob({ ready, playing }: { ready: boolean; playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const clock = useRef({ time: 0, levels: [] as number[] });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const state = clock.current;
    const speaking = playing && ready;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(element, bands(state.time, false), state.time, ready);
      return undefined;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      state.time += Math.min(0.1, (now - last) / 1000);
      last = now;
      draw(element, follow(state.levels, bands(state.time, speaking)), state.time, ready);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, ready]);
  return <canvas ref={canvas} className="rd-podcast-visual rd-podcast-blob" aria-hidden="true" />;
}
