import './SkeletonCard.css';

export default function SkeletonCard() {
  return (
    <div className="sk">
      <div className="sk-bg" />
      <div className="sk-body">
        <div className="sk-meta">
          <div className="sk-pill" />
          <div className="sk-small" />
          <div className="sk-small" />
        </div>
        <div className="sk-title" />
        <div className="sk-title sk-title--short" />
        <div className="sk-authors">
          <div className="sk-avatar" />
          <div className="sk-avatar" />
          <div className="sk-name" />
        </div>
        <div className="sk-text" />
        <div className="sk-text sk-text--short" />
        <div className="sk-bar">
          <div className="sk-btn" />
          <div className="sk-btn sk-btn--small" />
        </div>
      </div>
    </div>
  );
}
