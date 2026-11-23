import { useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { findConferenceEdition } from '../../data/conferences.ts';
import type { ConferenceEdition } from '../../data/conferences.ts';
import { useConferencePapers, useConferenceStatus } from '../../hooks/use-conference-papers.ts';
import type { Paper } from '../../models/paper.ts';
import FeedContainer from '../feed/feed-container.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import './conference-papers-page.css';

type Props = Pick<ComponentProps<typeof FeedContainer>, 'onOpenPdf' | 'onSaveToList' | 'onAuthRequired'> & { appChrome: boolean };

function PapersFeed({ edition, appChrome, ...props }: Props & { edition: ConferenceEdition }) {
  const status = useConferenceStatus(edition.id);
  const { entries, next, loading, error, loadMore, refresh } = useConferencePapers(edition.id);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const papers = useMemo(() => entries.filter(entry => !hidden.has(entry.paper.id)).map(entry => entry.paper), [entries, hidden]);
  const dismissal = {
    hide: (paper: Paper) => setHidden(ids => new Set([...ids, paper.id])),
    restore: (paper: Paper) => setHidden(ids => new Set([...ids].filter(id => id !== paper.id))),
    label: 'Hidden for this visit',
    hint: 'Hide it for this visit',
  };
  return (
    <div className="conference-papers-page" data-app-chrome={appChrome || undefined}>
      <nav className="conference-papers-header" aria-label="Conference edition">
        <Link to={'/conferences/' + edition.id}>Event details <span className="visually-hidden">for {edition.name}</span></Link>
        <Link to={'/conferences/' + edition.id + '/papers'} aria-current="page">Papers</Link>
        {Boolean(status?.listed) && <span>{status?.listed} papers listed</span>}
        {status?.staleSince && status.updatedAt && (
          <span>Last updated {new Date(status.updatedAt).toLocaleDateString('en', { timeZone: 'UTC' })}</span>
        )}
      </nav>
      <FeedContainer
        {...props}
        landmark={{ label: edition.name + ' accepted papers', heading: edition.name + ' accepted papers' }}
        scrollKey={'conference:' + edition.id}
        source={{
          papers, loading, hasMore: Boolean(next), loadMore, refresh, error: error ? new Error('Conference papers unavailable') : undefined,
          dismissal, surface: 'other', trackImpressions: false, persistReadingPosition: false,
          emptyState: !loading && !error ? (
            <EmptyState title={entries.length ? 'No more papers shown' : 'No papers listed yet'} role="status">
              {next && <Button onClick={() => { loadMore(); }}>Load more papers</Button>}
            </EmptyState>
          ) : null,
        }}
      />
    </div>
  );
}

export default function ConferencePapersPage(props: Props) {
  const { editionId } = useParams();
  const { user } = useAuth();
  const edition = findConferenceEdition(editionId);
  if (!edition) return <div className="conference-page"><h1>Conference not found</h1><Link to="/conferences">Conference calendar</Link></div>;
  return <PapersFeed key={edition.id + ':' + (user?.uid ?? 'guest')} edition={edition} {...props} />;
}
