import './PaperCard.css';
import './SkeletonCard.css';

// Enough lines to fill a tall phone's well; the well clips the rest, as the
// real one clips a long abstract.
const ABSTRACT_LINES = [100, 97, 100, 94, 100, 98, 100, 91, 100, 96, 100, 88, 100, 95, 100, 93, 100, 97, 100, 90, 100, 96, 100, 89];

/**
 * The card while its paper loads. Built on the card's own frame (`.pc`,
 * `.pc-sheet`, `.pc-body`, the rail), so it takes the real card's width,
 * centring and rail at every breakpoint and the swap lands where the paper
 * will be. The rows are the card's own wrappers too, so their spacing follows
 * the card; only the blocks inside them are the skeleton's.
 * Decoration for assistive tech; the page announces the loading itself.
 */
export default function SkeletonCard() {
  return (
    <div className="pc sk" aria-hidden="true">
      <div className="pc-sheet">
        <div className="pc-body">
          {/* The phone's lead: the figure's place above the paper (hidden on
              wider screens, as the card's own is), so the title waits where
              the real one will land. */}
          <div className="pc-lead">
            <span className="sk-block sk-figure" />
          </div>
          <div className="pc-meta sk-meta">
            <span className="sk-block" style={{ width: '7.5rem' }} />
            <span className="sk-block" style={{ width: '2.5rem' }} />
            <span className="sk-block" style={{ width: '5rem' }} />
          </div>
          <div className="sk-title">
            <span className="sk-block" style={{ width: '96%' }} />
            <span className="sk-block" style={{ width: '88%' }} />
            <span className="sk-block" style={{ width: '46%' }} />
          </div>
          <div className="pc-authors">
            <div className="pc-author-avatars sk-authors">
              {[0, 1, 2].map((i) => <span key={i} className="sk-block" style={{ '--i': i }} />)}
            </div>
          </div>
          <div className="pc-slot">
            <div className="sk-abstract">
              {ABSTRACT_LINES.map((width, i) => (
                <span key={i} className="sk-block sk-line" style={{ width: `${width}%` }} />
              ))}
            </div>
            <span className="sk-block sk-toggle" />
          </div>
          <div className="pc-action-bar">
            <span className="sk-block sk-button" />
          </div>
        </div>
      </div>
      <div className="pc-side-actions sk-rail">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="pc-side-btn">
            <span className="pc-side-icon"><span className="sk-block sk-glyph" /></span>
          </span>
        ))}
      </div>
    </div>
  );
}
