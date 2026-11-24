import { useEffect, useRef } from 'react';

type Vec3 = [number, number, number];
type Form = 'node' | 'atom' | 'dna' | 'lattice' | 'galaxy' | 'wave';

const FORMS: Form[] = ['node', 'atom', 'dna', 'lattice', 'galaxy', 'wave'];
const SETTINGS = { particles: 1500, morph: 0.08, spin: 0.2, size: 0.36, dot: 1.4 };
/** The forms' own motion (orbits, twists, arms) at half the playground's pace, calm enough for a voice. */
const PACE = 0.5;
const BANDS = 6;
/** Seconds each form holds before the cloud moves on to the next. */
const FORM_SECONDS = 10;
const TAU = Math.PI * 2;

/** The same 0..1 for a particle every frame, so it keeps its place in a form. */
function hash(i: number, salt = 0) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Even points on a sphere. */
function sphere(k: number, m: number, r: number): Vec3 {
  const y = 1 - (2 * (k + 0.5)) / m;
  const rr = Math.sqrt(1 - y * y);
  const a = k * 2.39996;
  return [Math.cos(a) * rr * r, y * r, Math.sin(a) * rr * r];
}
function rotZ([x, y, z]: Vec3, a: number): Vec3 {
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
}
function rotX([x, y, z]: Vec3, a: number): Vec3 {
  return [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
}

/** A geodesic sphere: an icosahedron with each face cut in four, its points pushed out to the surface. */
function geodesic() {
  const g = (1 + Math.sqrt(5)) / 2;
  const points: Vec3[] = [
    [-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0],
    [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g],
    [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1],
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
    points.push([0, 1, 2].map(axis => (points[a][axis] + points[b][axis]) / 2) as Vec3);
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
  const unit = points.map(point => point.map(value => value / Math.hypot(...point)) as Vec3);
  return { points: unit, edges: [...edges].map(edge => edge.split('-').map(Number) as [number, number]) };
}
const MESH = geodesic();

/** The geodesic sphere the podcast first had: a clump on every node and dots along every edge. */
function node(i: number): Vec3 {
  if (hash(i, 23) < 0.2) {
    const [x, y, z] = MESH.points[Math.floor(hash(i, 24) * MESH.points.length)];
    const j = 0.94 + hash(i, 25) * 0.04;
    return [x * j * 0.9, y * j * 0.9, z * j * 0.9];
  }
  const [a, b] = MESH.edges[Math.floor(hash(i, 26) * MESH.edges.length)];
  const f = hash(i, 27);
  const p = [0, 1, 2].map(axis => MESH.points[a][axis] * (1 - f) + MESH.points[b][axis] * f) as Vec3;
  const length = Math.hypot(...p);
  return [(p[0] / length) * 0.9, (p[1] / length) * 0.9, (p[2] / length) * 0.9];
}

/** A nucleus and three tilted orbits, each with a clump of electrons racing round it. */
function atom(i: number, n: number, t: number, level: number): Vec3 {
  const core = Math.floor(n * 0.18);
  if (i < core) {
    const [x, y, z] = sphere(i, core, 0.16 * (1 + level * 0.6));
    const j = 1 + (hash(i, 1) - 0.5) * 0.4;
    return [x * j, y * j, z * j];
  }
  const k = i % 3;
  const u = hash(i, 2);
  const electron = hash(i, 3) < 0.3;
  const a = electron ? t * (2.2 + k * 0.5) + k * 2 + (u - 0.5) * 0.35 : u * TAU;
  const spread = electron ? 0.03 : 0.008;
  return rotZ(rotX([Math.cos(a) * 0.95, Math.sin(a) * 0.32, (hash(i, 4) - 0.5) * spread * 4], 0.25), (k * Math.PI) / 3);
}

/** A double helix with base-pair rungs. */
function dna(i: number, t: number): Vec3 {
  const rungs = 18;
  const u = hash(i, 5);
  if (hash(i, 6) < 0.25) {
    const y = -1 + (2 * (Math.floor(u * rungs) + 0.5)) / rungs;
    const phi = y * 2.2 * Math.PI + t * 0.6;
    const f = hash(i, 7) * 2 - 1;
    return [Math.cos(phi) * 0.38 * f, y, Math.sin(phi) * 0.38 * f];
  }
  const y = u * 2 - 1;
  const phi = y * 2.2 * Math.PI + t * 0.6 + (i % 2) * Math.PI;
  return [Math.cos(phi) * 0.38, y, Math.sin(phi) * 0.38];
}

/** A 3×3×3 cubic crystal: nodes joined by edges. */
function lattice(i: number): Vec3 {
  const s = 3;
  const span = 1.1;
  const c = (v: number) => (v / (s - 1)) * span - span / 2;
  const node = [Math.floor(hash(i, 8) * s), Math.floor(hash(i, 9) * s), Math.floor(hash(i, 10) * s)];
  if (hash(i, 11) < 0.45) {
    const j = 0.05;
    return [c(node[0]) + (hash(i, 12) - 0.5) * j, c(node[1]) + (hash(i, 13) - 0.5) * j, c(node[2]) + (hash(i, 14) - 0.5) * j];
  }
  const axis = Math.floor(hash(i, 15) * 3);
  if (node[axis] === s - 1) node[axis] -= 1;
  const p: Vec3 = [c(node[0]), c(node[1]), c(node[2])];
  p[axis] += hash(i, 16) * (span / (s - 1));
  return p;
}

/** A two-armed spiral galaxy round a dense core, lying nearly flat. */
function galaxy(i: number, t: number): Vec3 {
  if (hash(i, 21) < 0.15) {
    const [x, y, z] = sphere(i, 1000, 0.13 * Math.cbrt(hash(i, 22)));
    return rotX([x, y * 0.5, z], -1.1);
  }
  const r = Math.pow(hash(i, 17), 0.7);
  const a = (i % 2) * Math.PI + r * 5.5 + t * 0.25;
  const sc = 0.04 + r * 0.12;
  return rotX([Math.cos(a) * r + (hash(i, 18) - 0.5) * sc, (hash(i, 20) - 0.5) * 0.06 * (1 - r), Math.sin(a) * r + (hash(i, 19) - 0.5) * sc], -1.1);
}

/** Three stacked oscilloscope traces. */
function wave(i: number, n: number, t: number, bands: number[]): Vec3 {
  const line = i % 3;
  const x = (Math.floor(i / 3) / Math.max(1, Math.floor(n / 3))) * 2 - 1;
  let y = 0;
  bands.forEach((band, k) => { y += band * Math.sin((k + 1) * x * Math.PI * 1.2 + t * (1 + k * 0.4) + line); });
  y = (y / Math.sqrt(bands.length || 1)) * 0.45 + Math.sin(x * Math.PI + t) * 0.05;
  return [x, y + (line - 1) * 0.18, (line - 1) * 0.15];
}

function target(form: Form, i: number, n: number, t: number, level: number, bands: number[]): Vec3 {
  switch (form) {
    case 'node': return node(i);
    case 'atom': return atom(i, n, t, level);
    case 'dna': return dna(i, t);
    case 'lattice': return lattice(i);
    case 'galaxy': return galaxy(i, t);
    case 'wave': return wave(i, n, t, bands);
  }
}

/** Turned round the vertical, tilted a little, in perspective: the screen offset and the depth's scale. */
function project([x, y, z]: Vec3, yaw: number): Vec3 {
  const cx = x * Math.cos(yaw) + z * Math.sin(yaw);
  const cz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const [, ty, tz] = rotX([cx, y, cz], 0.3);
  const p = 3 / (3 + tz);
  return [cx * p, ty * p, p];
}

type Scene = { pos: Float32Array; form: number; shownAt: number; t: number; level: number; bands: number[]; pump: number; gather: number };

/** Every particle eases towards its place in the form at its own pace, so one form flows into the next. */
function step(scene: Scene, seconds: number, speaking: boolean, progress: number) {
  // Scattered while the audio is prepared, the particles gather into the form as it arrives.
  scene.gather += (progress - scene.gather) * Math.min(1, seconds * 4);
  // Paused, the forms' own motion stops too, so the play button is also what stills the cloud.
  if (speaking) scene.t += seconds;
  const next = Array.from({ length: BANDS }, (_, i) => 0.3 + 0.25 * Math.sin(scene.t * (speaking ? 1.6 : 1.1) + i * 1.9));
  next.forEach((value, i) => { scene.bands[i] = (scene.bands[i] ?? 0) * 0.88 + value * 0.12; });
  scene.level += ((speaking ? 0.2 : 0.1) - scene.level) * 0.02;
  // The pump: while the voice speaks the cloud swells and settles a little, as a speaker's cone does.
  const pump = speaking ? 1 + 0.035 * Math.sin(scene.t * 2.3) + 0.02 * Math.sin(scene.t * 5.9) : 1;
  scene.pump += (pump - scene.pump) * Math.min(1, seconds * 6);
  // The forms move on only while the voice speaks; paused, the cloud holds the one it is in.
  if (scene.t - scene.shownAt > FORM_SECONDS) {
    scene.form = (scene.form + 1) % FORMS.length;
    scene.shownAt = scene.t;
  }
  const form = FORMS[scene.form];
  const n = SETTINGS.particles;
  for (let i = 0; i < n; i++) {
    const [tx, ty, tz] = target(form, i, n, scene.t * PACE, scene.level, scene.bands);
    // The morph is a share per sixtieth of a second, so a 120Hz screen does not run it twice as fast.
    const k = 1 - Math.pow(1 - Math.min(1, SETTINGS.morph * (0.4 + hash(i, 99) * 1.2)), seconds * 60);
    const o = i * 3;
    scene.pos[o] += (tx - scene.pos[o]) * k;
    scene.pos[o + 1] += (ty - scene.pos[o + 1]) * k;
    scene.pos[o + 2] += (tz - scene.pos[o + 2]) * k;
  }
}

function settleScene(scene: Scene, progress: number) {
  scene.gather = progress;
  scene.level = 0.1;
  scene.pump = 1;
  scene.bands = Array.from({ length: BANDS }, (_, i) => 0.3 + 0.25 * Math.sin(scene.t * 1.1 + i * 1.9));
  for (let i = 0; i < SETTINGS.particles; i++) {
    scene.pos.set(target(FORMS[scene.form], i, SETTINGS.particles, scene.t * PACE, scene.level, scene.bands), i * 3);
  }
}

/** Dots in three colour groups, larger when nearer and as the voice swells; the glow is a blurred copy behind. */
function render(sharp: HTMLCanvasElement, glow: HTMLCanvasElement, scene: Scene, ready: boolean) {
  const gather = scene.gather;
  const context = sharp.getContext('2d');
  const glowContext = glow.getContext('2d');
  if (!context || !glowContext) return;
  const size = sharp.clientWidth;
  const ratio = window.devicePixelRatio || 1;
  for (const canvas of [sharp, glow]) {
    if (canvas.width !== Math.round(size * ratio)) {
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
    }
  }
  const style = getComputedStyle(sharp);
  // Until the audio is there the cloud is the faint mesh colour; then it takes the brand's.
  const colours = ready ? ['--podcast-visual-from', '--podcast-visual-via', '--podcast-visual-to'].map(name => style.getPropertyValue(name).trim()) : Array<string>(3).fill(style.getPropertyValue('--podcast-mesh').trim());
  if (colours.some(colour => !colour)) return;
  const half = (size / 2) * ratio;
  const radius = size * ratio * SETTINGS.size * scene.pump * (1 + scene.level * 0.2) * (ready ? 1 : 0.86);
  const yaw = scene.t * SETTINGS.spin;
  context.clearRect(0, 0, sharp.width, sharp.height);
  colours.forEach((colour, group) => {
    context.fillStyle = colour;
    context.beginPath();
    for (let i = group; i < SETTINGS.particles; i += 3) {
      const o = i * 3;
      // Scattered through a ball a little wider than the form, so they stay inside the ring round it.
      const [angle, height, reach] = [hash(i, 7) * TAU, hash(i, 8) * 2 - 1, Math.cbrt(hash(i, 9)) * 1.15 * (1 - gather)];
      const across = Math.sqrt(1 - height * height) * reach;
      const [x, y, depth] = project([scene.pos[o] * gather + Math.cos(angle) * across, scene.pos[o + 1] * gather + height * reach, scene.pos[o + 2] * gather + Math.sin(angle) * across], yaw);
      const dot = SETTINGS.dot * depth * (1 + scene.level * 0.6) * ratio;
      context.moveTo(half + x * radius + dot, half + y * radius);
      context.arc(half + x * radius, half + y * radius, dot, 0, TAU);
    }
    context.fill();
  });
  glowContext.clearRect(0, 0, glow.width, glow.height);
  glowContext.drawImage(sharp, 0, 0);
}

/**
 * The podcast tab's visualizer: a cloud of particles that flows from one scientific form to
 * the next (a geodesic sphere, an atom, DNA, a crystal, a galaxy, a wave) while the voice speaks, swelling and
 * settling with it, and holds its form while paused. It has a soft glow, and
 * pressing it shows the next form. With reduced motion it settles into each form and holds still.
 */
export default function ReadAloudForms({ progress, playing }: { progress: number; playing: boolean }) {
  const ready = progress >= 1;
  const sharp = useRef<HTMLCanvasElement | null>(null);
  const glow = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<Scene>({ pos: new Float32Array(SETTINGS.particles * 3), form: 0, shownAt: 0, t: 0, level: 0.1, bands: [], pump: 1, gather: progress });
  useEffect(() => {
    const [canvas, behind] = [sharp.current, glow.current];
    if (!canvas || !behind) return undefined;
    const state = scene.current;
    const speaking = playing && ready;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settleScene(state, progress);
      render(canvas, behind, state, ready);
      return undefined;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      step(state, Math.min(0.1, (now - last) / 1000), speaking, progress);
      last = now;
      render(canvas, behind, state, ready);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, progress, ready]);
  // A press moves the cloud on to the next form, as a beat does in the playground.
  const next = () => {
    const state = scene.current;
    state.form = (state.form + 1) % FORMS.length;
    state.shownAt = state.t;
    if (sharp.current && glow.current && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settleScene(state, progress);
      render(sharp.current, glow.current, state, ready);
    }
  };
  return (
    <button type="button" className="rd-podcast-visual rd-podcast-forms" onClick={next} aria-label="Show the next form" title="Next form">
      <canvas ref={glow} className="rd-podcast-forms-glow" />
      <canvas ref={sharp} />
    </button>
  );
}
