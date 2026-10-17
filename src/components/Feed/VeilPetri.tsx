import type { RefObject } from 'react';
import { useEffect, useEffectEvent, useRef } from 'react';
import { usePresence, useReducedMotion } from 'framer-motion';
import PetriFlask from '../Onboarding/PetriFlask.tsx';
import { EASE_OUT } from '../../utils/motionCurves.ts';
import { SMILE_EXIT, smileExitFace, smileExitFrame, smileExitLayout } from '../../utils/petriSmileExit.ts';

const FACE_PARTS = {
  eyes: '.petri-face-eyes',
  happyEyes: '.petri-face-happy-eyes',
  brow: '.petri-face-brow',
  o: '.petri-face-o',
  smile: '.petri-face-smile',
} as const;

/**
 * Petri on the loading veil, and the veil's way out when the papers arrive
 * (utils/petriSmileExit.ts): she smiles, the camera flies into the smile and
 * the feed under the veil shows through it, landing from a little further
 * back. The veil is removed the frame the mouth covers it.
 *
 * The camera is the svg's own viewBox rather than a CSS scale: the zoom ends
 * past a hundredfold, and a scaled layer would be drawn from Petri's 96-pixel
 * raster. With reduced motion she smiles in place and the veil fades
 * (FeedContainer's reduced variants).
 */
export default function VeilPetri({ feedRef }: { feedRef: RefObject<HTMLElement | null> }) {
  const [isPresent, safeToRemove] = usePresence();
  const reduceMotion = useReducedMotion();
  const loaderRef = useRef<HTMLDivElement>(null);
  // The feed re-renders while the veil leaves (the cards are mounting), and
  // each render hands out a new `safeToRemove`. Keyed on it, the exit would
  // restart from its first frame every time.
  const remove = useEffectEvent(() => safeToRemove?.());

  useEffect(() => {
    if (isPresent) return undefined;
    const loader = loaderRef.current;
    const veil = loader?.parentElement;
    const svg = loader?.querySelector('svg');
    const body = svg?.querySelector<SVGGElement>('.onboarding-petri-body');
    const parts = Object.fromEntries(Object.entries(FACE_PARTS)
      .map(([name, selector]) => [name, svg?.querySelector<SVGElement>(selector)])) as Record<keyof typeof FACE_PARTS, SVGElement | null>;
    if (!loader || !veil || !svg || !body || Object.values(parts).some((part) => !part)) {
      remove();
      return undefined;
    }
    const smile = parts.smile!;
    const rest = {
      viewBox: svg.getAttribute('viewBox'),
      aspect: svg.getAttribute('preserveAspectRatio'),
      mouth: smile.getAttribute('d'),
      lip: smile.getAttribute('stroke-width'),
    };
    let finished = false;
    let frame = 0;
    let landing: Animation | undefined;

    const applyFace = (t: number) => {
      const face = smileExitFace(t);
      body.style.transform = face.body;
      for (const name of Object.keys(FACE_PARTS) as (keyof typeof FACE_PARTS)[]) {
        parts[name]!.style.opacity = String(face[name].opacity);
        parts[name]!.style.transform = face[name].transform;
      }
    };

    if (reduceMotion) {
      applyFace(SMILE_EXIT.smileMs);
      finished = true;
      remove();
    } else {
      const veilBox = veil.getBoundingClientRect();
      const svgBox = svg.getBoundingClientRect();
      const loaderBox = loader.getBoundingClientRect();
      const { x, y, width, height } = svg.viewBox.baseVal;
      const layout = smileExitLayout(
        veilBox,
        { left: svgBox.left - veilBox.left, top: svgBox.top - veilBox.top, width: svgBox.width, height: svgBox.height },
        { x, y, width, height },
      );
      // The svg now covers the veil; the viewBox keeps Petri where she was.
      // Clipped to that box, since Petri's svg draws past its edges and the
      // zoomed mouth would paint outside the veil.
      Object.assign(svg.style, {
        position: 'absolute',
        overflow: 'hidden',
        left: `${veilBox.left - loaderBox.left}px`,
        top: `${veilBox.top - loaderBox.top}px`,
        width: `${veilBox.width}px`,
        height: `${veilBox.height}px`,
      });
      svg.setAttribute('preserveAspectRatio', 'none');
      landing = feedRef.current?.animate(
        [{ transform: 'scale(0.86)' }, { transform: 'none' }],
        {
          duration: SMILE_EXIT.flightMs + SMILE_EXIT.settleMs,
          delay: SMILE_EXIT.flightStartMs,
          easing: `cubic-bezier(${EASE_OUT.join(', ')})`,
          fill: 'backwards',
        },
      );

      const start = performance.now();
      const draw = (now: number) => {
        const t = now - start;
        applyFace(t);
        const camera = smileExitFrame(t, layout);
        svg.setAttribute('viewBox', camera.viewBox);
        smile.setAttribute('d', camera.mouth);
        smile.setAttribute('stroke-width', String(camera.lipPx));
        veil.style.clipPath = camera.hole ?? '';
        if (camera.done) {
          finished = true;
          remove();
          return;
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    }

    // Back before the exit ran (the veil came back: the feed emptied again),
    // she returns to waiting. After it ran the veil is being removed and
    // undoing costs nothing, but the feed's landing outlives the veil.
    return () => {
      cancelAnimationFrame(frame);
      if (!finished) landing?.cancel();
      for (const element of [svg, body, ...Object.values(parts) as SVGElement[]]) element.removeAttribute('style');
      veil.style.clipPath = '';
      for (const [element, name, value] of [
        [svg, 'viewBox', rest.viewBox],
        [svg, 'preserveAspectRatio', rest.aspect],
        [smile, 'd', rest.mouth],
        [smile, 'stroke-width', rest.lip],
      ] as const) {
        if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
      }
    };
  }, [isPresent, reduceMotion, feedRef]);

  return (
    <div ref={loaderRef} className="atom-loader" aria-hidden="true">
      <PetriFlask smile className="petri-loader" />
    </div>
  );
}
