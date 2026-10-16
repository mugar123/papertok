import PetriFrame from './PetriFrame.jsx';


export default function PetriWelcome({ name, label, className }) {
  const card = name || 'Hello';
  // 19 units fits about eight letters on the card; a longer name gets smaller
  // rather than spilling past its edges.
  const fontSize = Math.min(19, 150 / card.length);
  return (
    <PetriFrame
      label={label}
      className={className}
      behind={<path d="M54 92 50 54M104 90l4-36" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />}
    >
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
    </PetriFrame>
  );
}
