import Petri from '../onboarding/petri.tsx';

/**
 * The viewer while a paper loads: Petri and a line, centred on the page under
 * the header, over whatever is still unseen beneath (the iframe takes its
 * place while it loads).
 */
export default function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="pdf-loading" role="status">
      <Petri pose="download" className="petri-loader" />
      <p>{label}</p>
    </div>
  );
}
