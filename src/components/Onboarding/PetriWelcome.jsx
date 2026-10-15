import { useId } from 'react';
import './Petri.css';

// Petri, the mascot, in its welcome pose (obradither/landing/petri.html,
// `petri-welcome`): on its dish, both pseudopods up, holding a card with the
// reader's first name like someone waiting at an arrivals gate. Body and arms
// are outlined in their own yellow, so Petri reads as one flat shape; the
// dish and the face keep the ink, and the card is outlined in the face's
// ink (--text-on-brand) in both themes, like a printed object. The card is
// paper on both themes (--bg-figure-plate) with ink on it, so the name reads
// the same at night. The drawing is the greeting, so it carries the greeting
// as its name (`label`, the onboarding's own greeting copy): assistive tech
// hears "Hello, Ada", not a picture.
export default function PetriWelcome({ name, label, className }) {
  const hatch = useId();
  const card = name || 'Hello';
  // 19 units fits about eight letters on the card; a longer name gets smaller
  // rather than spilling past its edges.
  const fontSize = Math.min(19, 150 / card.length);
  return (
    // Cropped to the drawing, not the 160 grid it is drawn on: the grid is
    // centred on x 80 and leaves more air above the card than under the dish,
    // while the dish, the body and the card all share x 78. Cropped around
    // that axis (64 either side) and to the card's top and the dish's rim, the
    // box's centre is the figure's centre, so centring the box centres Petri.
    <svg viewBox="14 22 128 124" role="img" aria-label={label} className={className}>
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="currentColor" />
        </pattern>
      </defs>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="78" cy="128" rx="62" ry="15" fill="var(--bg-primary)" />
        <ellipse cx="78" cy="124" rx="54" ry="10" fill={`url(#${hatch})`} strokeWidth="1.6" />
        <g className="onboarding-petri-body">
          <path d="M54 92 50 54M104 90l4-36" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />
          <path d="M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          <path d="M65 90q4-5 8 0M85 90q4-5 8 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.4" />
          <path d="M72 98q7 8 14 0Z" fill="var(--text-on-brand)" stroke="var(--text-on-brand)" strokeWidth="1.6" />
          <rect className="petri-prop-line" style={{ '--prop-fill': 'var(--bg-figure-plate)' }} x="32" y="24" width="90" height="30" rx="2" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" />
          <text
            x="77"
            y="45"
            textAnchor="middle"
            fontSize={fontSize}
            fill="var(--text-on-brand)"
            stroke="none"
            style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 500 }}
          >
            {card}
          </text>
        </g>
      </g>
    </svg>
  );
}
