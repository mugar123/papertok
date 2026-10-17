import { EASE_OUT } from './motionCurves.ts';
import { cubicBezier } from './scrollTween.ts';

/**
 * How the loading veil leaves when the first papers arrive: Petri smiles,
 * the camera flies into her smile and the feed is what is inside it.
 *
 * Everything here is a pure function of the time since the papers landed, so
 * VeilPetri.tsx only writes the numbers into the DOM. Lengths are in Petri's
 * own units (PetriFlask.tsx) unless a name ends in `Px`, which is a pixel on
 * the veil.
 */
export const SMILE_EXIT = Object.freeze({
  smileMs: 280,    // the face turns happy, with a hop
  flightStartMs: 280,
  flightMs: 400,   // ends the frame the open mouth covers the veil
  settleMs: 180,   // the feed keeps landing after the veil is gone
  reducedHoldMs: 260, // reduced motion: the smile is shown, then the veil fades
});

// The smile: an upper and a lower half-ellipse meeting on the line y = yc.
// Closed (before the flight) it is a D with a flat top; during the flight the
// top lip arches and the jaw drops, which also lets a smaller zoom cover the
// screen than the D would need.
export const MOUTH = Object.freeze({ cx: 82, yc: 96, a: 8, closedDepth: 6.5, openDepth: 9.5, openArch: 4 });
// Where the camera aims: the middle of the open mouth.
const AIM = Object.freeze({ x: MOUTH.cx, y: MOUTH.yc + (MOUTH.openDepth - MOUTH.openArch) / 2 });
// The lip is the smile's stroke. Its width is in screen pixels, so it stays a
// line instead of growing into a band while the camera zooms.
const LIP = 1.2;
const MAX_LIP_PX = 5;

const easeOut = cubicBezier(...EASE_OUT);
const easeIn = cubicBezier(0.11, 0, 0.5, 0); // the push accelerates through the mouth
const overshoot = cubicBezier(0.34, 1.56, 0.64, 1); // Petri's own rise (Petri.css)
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const span = (t: number, start: number, duration: number) => clamp01((t - start) / duration);
const lerp = (from: number, to: number, p: number) => from + (to - from) * p;

export function mouthPath(cx: number, yc: number, a: number, arch: number, depth: number) {
  return `M ${cx - a} ${yc} A ${a} ${arch} 0 0 1 ${cx + a} ${yc} A ${a} ${depth} 0 0 1 ${cx - a} ${yc} Z`;
}

function mouthOpening(open: number) {
  return { arch: MOUTH.openArch * open, depth: lerp(MOUTH.closedDepth, MOUTH.openDepth, open) };
}

export interface Box { left: number; top: number; width: number; height: number }
export interface ViewBox { x: number; y: number; width: number; height: number }
export interface SmileExitLayout {
  width: number;
  height: number;
  restScale: number;
  aimFrom: { x: number; y: number };
  coverScale: number;
}

/**
 * The flight, worked out once when the veil starts leaving. `petri` is the
 * box Petri is drawn in at rest, relative to the veil, and `viewBox` her svg's
 * crop (PetriFrame), drawn into that box the way `xMidYMid meet` does.
 */
export function smileExitLayout(veil: { width: number; height: number }, petri: Box, viewBox: ViewBox): SmileExitLayout {
  const { width, height } = veil;
  const restScale = Math.min(petri.width / viewBox.width, petri.height / viewBox.height);
  const left = petri.left + (petri.width - viewBox.width * restScale) / 2;
  const top = petri.top + (petri.height - viewBox.height * restScale) / 2;
  const aimFrom = { x: left + (AIM.x - viewBox.x) * restScale, y: top + (AIM.y - viewBox.y) * restScale };

  // The smallest zoom at which the open mouth, centred on the veil, holds all
  // four of its corners. The flight ends there, so no time is spent watching
  // the last corners of yellow leave.
  const covers = (zoom: number) => {
    const k = restScale * zoom;
    const cy = height / 2 + (MOUTH.yc - AIM.y) * k;
    return [[0, 0], [width, 0], [0, height], [width, height]].every(([x, y]) => {
      const radiusY = (y < cy ? MOUTH.openArch : MOUTH.openDepth) * k;
      return ((x - width / 2) / (MOUTH.a * k)) ** 2 + ((y - cy) / radiusY) ** 2 <= 1;
    });
  };
  let low = 1;
  let high = 1e5;
  for (let i = 0; i < 48; i += 1) {
    const mid = Math.sqrt(low * high);
    if (covers(mid)) high = mid; else low = mid;
  }
  return { width, height, restScale, aimFrom, coverScale: high * 1.01 };
}

/**
 * The camera and the mouth at `t` ms. `viewBox` is the crop of the svg that
 * covers the veil; `hole` is the veil's clip-path — the veil minus the inside
 * of the mouth, through which the feed shows — or null while there is none.
 */
export function smileExitFrame(t: number, layout: SmileExitLayout) {
  const { width, height, restScale, aimFrom, coverScale } = layout;
  const flight = span(t, SMILE_EXIT.flightStartMs, SMILE_EXIT.flightMs);

  // Aim (the mouth glides to the centre while the zoom is still gentle), then
  // push. The zoom runs in log space, so each frame multiplies the scale.
  const k = restScale * coverScale ** easeIn(flight);
  const aim = easeOut(clamp01(flight / 0.6));
  const focus = { x: lerp(aimFrom.x, width / 2, aim), y: lerp(aimFrom.y, height / 2, aim) };
  const x = AIM.x - focus.x / k;
  const y = AIM.y - focus.y / k;

  const { arch, depth } = mouthOpening(easeOut(clamp01(flight / 0.55)));
  // The inside of the mouth opens from its middle in the first third of the
  // flight: navy at first, then the feed behind it.
  const iris = easeOut(clamp01(flight / 0.3));
  let hole = null;
  if (flight > 0) {
    const cx = (MOUTH.cx - x) * k;
    const lipLine = (MOUTH.yc - y) * k;
    const middle = lipLine + ((depth - arch) / 2) * k;
    const mouth = mouthPath(cx, middle + (lipLine - middle) * iris, MOUTH.a * k * iris, arch * k * iris, depth * k * iris);
    hole = `path(evenodd, 'M 0 0 H ${width} V ${height} H 0 Z ${mouth}')`;
  }

  return {
    done: flight >= 1,
    viewBox: `${x} ${y} ${width / k} ${height / k}`,
    mouth: mouthPath(MOUTH.cx, MOUTH.yc, MOUTH.a, arch, depth),
    lipPx: Math.min(LIP * k, MAX_LIP_PX),
    hole,
  };
}

// Her hop, around her feet: squash, stretch up, settle.
function hopAt(hop: number): [number, number, number] {
  if (hop < 0.3) {
    const q = easeOut(hop / 0.3);
    return [1 + 0.05 * q, 1 - 0.07 * q, 0];
  }
  if (hop < 0.65) {
    const q = easeOut((hop - 0.3) / 0.35);
    return [lerp(1.05, 0.98, q), lerp(0.93, 1.05, q), 5 * q];
  }
  const q = easeOut((hop - 0.65) / 0.35);
  return [lerp(0.98, 1, q), lerp(1.05, 1, q), lerp(5, 0, q)];
}

/**
 * The face at `t` ms: the puzzled eyes blink shut and come back as happy
 * arcs, the raised brow relaxes away, the small "o" closes and the smile
 * opens with Petri's overshoot, while she hops (squash, stretch, settle).
 */
export function smileExitFace(t: number) {
  const blink = easeOut(span(t, 0, 110));
  const happy = span(t, 90, 160);
  const brow = easeOut(span(t, 0, 150));
  const o = easeOut(span(t, 0, 110));
  const smile = span(t, 50, 230);
  const grin = overshoot(smile);

  const hop = span(t, 0, SMILE_EXIT.smileMs);
  const [scaleX, scaleY, rise] = hopAt(hop);

  return {
    body: `translate(0px, ${-rise}px) scale(${scaleX}, ${scaleY})`,
    eyes: { opacity: blink < 1 ? 1 : 0, transform: `scale(1, ${1 - 0.85 * blink})` },
    happyEyes: { opacity: Math.min(1, happy * 3), transform: `scale(1, ${lerp(0.3, 1, overshoot(happy))})` },
    brow: { opacity: 1 - brow, transform: `translate(0px, ${2 * brow}px)` },
    o: { opacity: 1 - o, transform: `scale(${1 - 0.6 * o})` },
    smile: { opacity: smile > 0 ? 1 : 0, transform: `scale(${lerp(0.55, 1, grin)}, ${lerp(0.1, 1, grin)})` },
  };
}
