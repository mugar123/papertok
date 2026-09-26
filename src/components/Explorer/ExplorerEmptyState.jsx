import { Briefcase, FileText, MagnifyingGlass, Users } from '@phosphor-icons/react';
import { Button } from '../ui/button.jsx';

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

export function ExplorerEmptyState({ variant, onClearFilters, onRetry, errorMessage, openAireUrl }) {
  const lang = 'en';

  if (variant === 'error') {
    return (
      <div className="explorer-empty" role="alert">
        <span className="explorer-empty-icon"><FileText size={22} /></span>
        <h3 className="explorer-empty-title">{'The publications could not be loaded'}</h3>
        <p className="explorer-empty-body">{errorMessage}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{'Try again'}</Button>
      </div>
    );
  }

  const Icon = variant === 'filtered' ? MagnifyingGlass : variant === 'project-unindexed' ? Briefcase : variant === 'authors' || variant === 'authors-none' ? Users : FileText;
  const [title, body, action] = COPY[variant][lang];

  return (
    <div className="explorer-empty">
      <span className="explorer-empty-icon"><Icon size={22} /></span>
      <h3 className="explorer-empty-title">{title}</h3>
      <p className="explorer-empty-body">{body}</p>
      {variant === 'filtered' && (
        <Button variant="outline" size="sm" onClick={onClearFilters}>{action}</Button>
      )}
      {variant === 'project-unindexed' && openAireUrl && (
        <a className="explorer-empty-link" href={openAireUrl} target="_blank" rel="noopener noreferrer">{action}</a>
      )}
    </div>
  );
}
