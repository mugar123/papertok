import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../Onboarding/Petri.tsx';

// Copy for every non-error variant, as [title, body, action label] per
// language. 'error' is handled separately below because its body is a
// runtime message, not a fixed string.
const COPY = {
  filtered: {
    en: ['Nothing matches these filters', 'Loosen the search or the filters to see the full list again.', 'Clear filters'],
  },
  'project-unindexed': {
    en: ['OpenAIRE has not linked publications to this project yet', 'Projects are indexed with some delay. Papers that acknowledge this grant will appear here once OpenAIRE links them.', 'View on OpenAIRE'],
  },
  none: {
    en: ['No publications here', 'Nothing to show for this entity yet.', null],
  },
  authors: {
    en: ['No authors matched your search', 'Try a different spelling, or clear the search to see everyone on this entity.', null],
  },
  // The same tab with nothing typed into it. The copy above would be telling
  // the reader to clear a search they never ran.
  'authors-none': {
    en: ['No authors here', 'Nobody is listed as an author on this entity yet.', null],
  },
};

const POSE = {
  filtered: 'search',
  'project-unindexed': 'flask',
  none: 'blankPage',
  authors: 'search',
  'authors-none': 'blankPage',
} as const;

export function ExplorerEmptyState({ variant, onClearFilters, onRetry, errorMessage, openAireUrl }: { variant: keyof typeof COPY | 'error'; onClearFilters?: () => void; onRetry?: () => void; errorMessage?: string; openAireUrl?: string | null }) {
  const lang = 'en';

  if (variant === 'error') {
    return (
      <EmptyState
        className="explorer-empty"
        role="alert"
        as="h3"
        art={<Petri pose="upset" />}
        title={'The publications could not be loaded'}
        actions={<Button variant="outline" size="sm" onClick={onRetry}>{'Try again'}</Button>}
      >
        {errorMessage}
      </EmptyState>
    );
  }

  const [title, body, action] = COPY[variant][lang];

  return (
    <EmptyState
      className="explorer-empty"
      as="h3"
      art={<Petri pose={POSE[variant]} />}
      title={title}
      actions={variant === 'filtered' ? (
        <Button variant="outline" size="sm" onClick={onClearFilters}>{action}</Button>
      ) : variant === 'project-unindexed' && openAireUrl ? (
        <a className="explorer-empty-link" href={openAireUrl} target="_blank" rel="noopener noreferrer">{action}</a>
      ) : null}
    >
      {body}
    </EmptyState>
  );
}
