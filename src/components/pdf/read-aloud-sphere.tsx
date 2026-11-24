import { useEffect, useRef } from 'react';

type Point = [number, number, number];

/** A geodesic sphere: an icosahedron with each face cut in four, its points pushed out to the surface. */
function geodesic() {
  const t = (1 + Math.sqrt(5)) / 2;
  const points: Point[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const middles = new Map<string, number>();
  const middle = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const known = middles.get(key);
    if (known !== undefined) return known;
    points.push([0, 1, 2].map(axis => (points[a][axis] + points[b][axis]) / 2) as Point);
    middles.set(key, points.length - 1);
    return points.length - 1;
  };
  const edges = new Set<string>();
  for (const [a, b, c] of faces) {
    const [ab, bc, ca] = [middle(a, b), middle(b, c), middle(c, a)];
    for (const [x, y, z] of [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]) {
      for (const [p, q] of [[x, y], [y, z], [z, x]]) edges.add(p < q ? `${p}-${q}` : `${q}-${p}`);
    }
  }
  const unit = points.map((point) => {
    const length = Math.hypot(...point);
    return point.map(value => value / length) as Point;
  });
  return { points: unit, edges: [...edges].map(edge => edge.split('-').map(Number) as [number, number]) };
}

const MESH = geodesic();
const TILT = 0.38;

type Motion = { angle: number; scale: number; ready: boolean; playing: boolean; at: number };

function draw(element: HTMLCanvasElement, motion: Motion, now: number, still: boolean) {
  const context = element.getContext('2d');
  if (!context) return;
  const seconds = Math.min(0.1, (now - motion.at) / 1000);
  motion.at = now;
  const size = element.clientWidth;
  const ratio = window.devicePixelRatio || 1;
  if (element.width !== Math.round(size * ratio)) {
    element.width = Math.round(size * ratio);
    element.height = Math.round(size * ratio);
  }
  const rest = motion.ready ? 1 : 0.86;
  if (still) motion.scale = rest;
  else {
    motion.angle += seconds * (motion.playing ? 0.32 : 0.12);
    const time = now / 1000;
    const target = rest * (motion.playing && motion.ready ? 1 + 0.035 * Math.sin(time * 2.3) + 0.02 * Math.sin(time * 5.9) : 1);
    motion.scale += (target - motion.scale) * Math.min(1, seconds * 6);
  }
  const style = getComputedStyle(element);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const mesh = read('--podcast-mesh');
  // Until the audio is there the whole sphere is the faint mesh; then its front takes the accent.
  const [edge, node, ring] = motion.ready ? [read('--podcast-edge'), read('--podcast-node'), read('--podcast-node-ring')] : [mesh, mesh, ''];
  const radius = (size / 2) * 0.92 * motion.scale * ratio;
  const centre = (size / 2) * ratio;
  const [sinA, cosA, sinT, cosT] = [Math.sin(motion.angle), Math.cos(motion.angle), Math.sin(TILT), Math.cos(TILT)];
  const projected = MESH.points.map(([x, y, z]) => {
    const rx = x * cosA + z * sinA;
    const rz = -x * sinA + z * cosA;
    return [centre + rx * radius, centre + (y * cosT - rz * sinT) * radius, y * sinT + rz * cosT] as const;
  });
  context.clearRect(0, 0, element.width, element.height);
  context.lineWidth = ratio;
  for (const [a, b] of MESH.edges) {
    const front = projected[a][2] + projected[b][2] > 0;
    context.strokeStyle = front ? edge : mesh;
    context.globalAlpha = front ? 0.95 : 0.3;
    context.beginPath();
    context.moveTo(projected[a][0], projected[a][1]);
    context.lineTo(projected[b][0], projected[b][1]);
    context.stroke();
  }
  // Nearer points are larger; the far side's are small and faint.
  for (const [x, y, z] of [...projected].sort((p, q) => p[2] - q[2])) {
    context.globalAlpha = z > 0 ? 1 : 0.35;
    context.fillStyle = z > 0 ? node : mesh;
    context.beginPath();
    context.arc(x, y, (z > 0 ? 1.8 + 1.6 * z : 1.2) * ratio, 0, Math.PI * 2);
    context.fill();
    if (z > 0 && ring) {
      context.strokeStyle = ring;
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

/**
 * The podcast tab's visualizer: a wireframe sphere that turns slowly, grey while
 * the audio is prepared and in the accent once it is there, swelling a little
 * while the voice speaks. Still, drawn again only when its state changes, with
 * reduced motion.
 */
export default function ReadAloudSphere({ ready, playing }: { ready: boolean; playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const motion = useRef<Motion>({ angle: 0.6, scale: 0.86, ready, playing, at: 0 });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    motion.current.ready = ready;
    motion.current.playing = playing;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(element, motion.current, performance.now(), true);
      return undefined;
    }
    let frame = 0;
    const tick = (now: number) => {
      draw(element, motion.current, now, false);
      frame = requestAnimationFrame(tick);
    };
    motion.current.at = performance.now();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, ready]);
  return <canvas ref={canvas} className="rd-podcast-sphere" aria-hidden="true" />;
}
