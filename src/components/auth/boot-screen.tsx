import Petri from '../onboarding/petri.tsx';

/**
 * The loader shown while the session resolves. Fixed over the whole viewport,
 * so a page held under it (`holdBootScreen`) and the navbar it brings stay
 * covered by the same mascot instead of a second one rising again.
 */
export default function BootScreen() {
  return (
    <div className="boot-screen">
      <Petri pose="flask" className="petri-loader boot-screen-atom" />
      <p className="boot-screen-text" aria-hidden="true">PaperTok</p>
      <style>{`
        .boot-screen {
          position: fixed;
          inset: 0;
          z-index: var(--z-overlay);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: var(--bg-primary);
          gap: var(--space-4);
        }
        .petri.boot-screen-atom {
          width: 80px;
          height: 80px;
          margin: 0;
        }
        .boot-screen-text {
          color: var(--text-secondary);
          font-size: var(--fs-sm);
        }
      `}</style>
    </div>
  );
}
