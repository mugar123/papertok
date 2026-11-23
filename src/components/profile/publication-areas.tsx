import { useRef, useState, type RefObject } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { getAreaLeaves, getCategoryLabel } from '../../data/category-taxonomy.ts';
import EditInterestsModal from '../settings/edit-interests-modal.tsx';
import { Button } from '../ui/button.tsx';
import { publicationAreas, suggestedInterests } from './publication-area-suggestions.ts';

export default function PublicationAreas({ papers, decisionPending, publicationsHeading }: {
  papers: Paper[];
  decisionPending: boolean;
  publicationsHeading: RefObject<HTMLHeadingElement | null>;
}) {
  const { userPreferences } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [suggested, setSuggested] = useState<string[]>();
  const [saved, setSaved] = useState(false);
  const review = useRef<HTMLButtonElement>(null);
  const areas = userPreferences && !dismissed ? publicationAreas(papers, userPreferences) : [];
  return (
    <>
      {areas.length > 0 && (
        <section className="settings-section" aria-labelledby="publication-areas-heading">
          <div className="settings-section-heading">
            <h2 id="publication-areas-heading">Add these areas based on your publications</h2>
          </div>
          <ul>
            {areas.map(id => <li key={id}>{getCategoryLabel(id)}{getAreaLeaves(id) && ' (all interests in this field)'}</li>)}
          </ul>
          <div className="orcid-work-actions">
            <Button ref={review} disabled={decisionPending} onClick={() => { setSaved(false); setSuggested(suggestedInterests(areas)); }}>Review interests</Button>
            <Button variant="ghost" onClick={() => { publicationsHeading.current?.focus(); setDismissed(true); }}>Dismiss</Button>
          </div>
        </section>
      )}
      <span className="sr-only" role="status">{saved && 'Feed interests saved.'}</span>
      <EditInterestsModal isOpen={suggested !== undefined} suggested={suggested} onClose={() => setSuggested(undefined)}
        onSaved={() => setSaved(true)} finalFocus={() => review.current ?? publicationsHeading.current} />
    </>
  );
}
