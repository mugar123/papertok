import './ThinkingDots.css';

/**
 * Three dots in a row, breathing one after another.
 *
 * The wait before a rewrite starts is a minute of nothing: the worker is
 * downloading the PDF and the model is reading it, and neither produces a byte
 * the reader can show. A spinner measures that wait as failure — it is the same
 * shape at second one and second fifty. Three dots read as someone about to
 * speak, which is what is actually happening.
 *
 * Decorative by default: the sentence next to it already says what is going on,
 * so the dots stay out of the accessibility tree unless given a `label`.
 */
export default function ThinkingDots({ className = '', label = '' }) {
  return (
    <span
      className={className ? `td ${className}` : 'td'}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
    >
      <i /><i /><i />
    </span>
  );
}
