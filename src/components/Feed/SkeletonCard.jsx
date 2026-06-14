import './SkeletonCard.css';

export default function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-top">
        <div className="skeleton-line skeleton-badge" />
        <div className="skeleton-line skeleton-date" />
      </div>
      <div className="skeleton-content">
        <div className="skeleton-line skeleton-title" />
        <div className="skeleton-line skeleton-title skeleton-title--short" />
        <div className="skeleton-line skeleton-authors" />
        <div className="skeleton-block skeleton-abstract" />
      </div>
    </div>
  );
}
