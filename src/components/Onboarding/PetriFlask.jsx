import { useId } from 'react';
import PetriFrame, { ANTENNAE, Hatch } from './PetriFrame.jsx';

const FLASK = 'M123 29v11l-11 24a3 3 0 0 0 2.7 4.3h22.6a3 3 0 0 0 2.7-4.3L129 40V29Z';

export default function PetriFlask({ label, className }) {
  const liquid = useId();
  const glass = useId();
  return (
    <PetriFrame
      label={label}
      className={className}
      // The flask's glass is paper at night too, so what is inside it is
      // drawn in the card's ink (--text-on-brand), not the page's.
      defs={(
        <>
          <Hatch id={liquid} fill="var(--text-on-brand)" />
          <clipPath id={glass}><path d={FLASK} /></clipPath>
        </>
      )}
      behind={<path d="M104 100q10-6 10-32" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="74" cy="86" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <circle cx="92" cy="86" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <path d="M86 77q5-3 10 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
      <ellipse cx="82" cy="100" rx="2.4" ry="3" fill="var(--text-on-brand)" stroke="none" />
      <path className="petri-prop-line" data-flat="" style={{ '--prop-fill': 'var(--bg-figure-plate)' }} d={FLASK} fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" />
      <path d="M116.1 55H135.9L140 64a3 3 0 0 1-2.7 4.3H114.7A3 3 0 0 1 112 64Z" fill={`url(#${liquid})`} stroke="none" />
      <path d="M116.1 55H135.9" stroke="var(--text-on-brand)" strokeWidth="1.6" />
      <path d="M121 29h10" strokeWidth="3" stroke="var(--text-on-brand)" />
      <g clipPath={`url(#${glass})`}>
        <circle className="petri-bubble" style={{ '--bubble': 0, '--dx': '4.6px' }} cx="122" cy="49" r="1.8" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" strokeWidth="1.3" />
        <circle className="petri-bubble" style={{ '--bubble': 1, '--dx': '-2px' }} cx="128" cy="44" r="1.3" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" strokeWidth="1.2" />
      </g>
      <circle className="petri-bubble" style={{ '--bubble': 2 }} cx="127" cy="21" r="1.8" fill="var(--bg-figure-plate)" strokeWidth="1.3" stroke="var(--text-on-brand)" />
      <circle cx="114" cy="66" r="5" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" strokeWidth="2.2" />
    </PetriFrame>
  );
}
