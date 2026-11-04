import type { Paper } from '../../models/paper.ts';
import { ListRowAuthors } from '../lists/list-row.tsx';
import ScientificText from '../scientific-text.ts';

/**
 * The paper's title block: its title, its authors as the feed's reader lists
 * them (`onLeave` closes the viewer when one is opened), and their
 * affiliations.
 */
export function PaperByline({ paper, onLeave }: { paper: Paper; onLeave?: () => void }) {
  const affiliations = [...new Set(paper.authors
    .map(author => (typeof author === 'string' ? '' : author.affiliation?.trim() ?? ''))
    .filter(Boolean))];
  return (
    <header className="ft-head">
      <h2 className="ft-title"><ScientificText>{paper.title}</ScientificText></h2>
      {paper.authors.length > 0 && <div className="ft-authors"><ListRowAuthors paper={paper} onNavigate={onLeave} /></div>}
      {affiliations.length > 0 && <p className="ft-affiliations">{affiliations.map(place => <span key={place}>{place}</span>)}</p>}
    </header>
  );
}
