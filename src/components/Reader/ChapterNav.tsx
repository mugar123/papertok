import './ChapterNav.css';

export interface Chapter { label: string; heading: string }

interface NavProps { chapters: Chapter[]; active: number; onJump: (index: number) => void }

export function ChapterMargin({ chapters, active, onJump }: NavProps) {
  return (
    <nav className="rd-toc" aria-label="Chapters">
      <ol>
        {chapters.map((chapter, index) => (
          <li key={index}>
            <button
              type="button"
              className="rd-toc-item"
              aria-current={index === active ? 'location' : undefined}
              onClick={() => onJump(index)}
            >
              <span className="rd-toc-label">{chapter.label}</span>
              {chapter.heading && <span className="rd-toc-heading">{chapter.heading}</span>}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
