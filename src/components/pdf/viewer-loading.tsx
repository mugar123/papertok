import Petri from '../onboarding/petri.tsx';

export default function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="pdf-loading" role="status">
      <Petri pose="download" className="petri-loader" />
      <p>{label}</p>
    </div>
  );
}
