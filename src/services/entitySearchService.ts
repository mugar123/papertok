import type { Paper } from '../models/Paper.ts';
import type { OpenAlexAuthor, OpenAlexInstitution, OpenAlexTopic } from './adapters/openAlexTypes.ts';
import type { Project } from './openAireService.ts';
import { searchProjects } from './openAireService.ts';
import { searchPapersAcrossSources } from './paperSearchService.ts';
import { searchAuthors, searchConcepts, searchInstitutions, enrichAuthorInstitutionLocalization } from './openAlexService.ts';
import { authorProminenceWeight, authorSearchValues, filterRelevantSearchResults, isOrganisationAuthorRecord } from '../utils/searchRelevance.ts';
import { PaperBuilder } from './PaperBuilder.ts';
import { rankPaperSearchResults, scorePaperSearchMatch } from '../utils/searchRelevance.ts';
import { withEnforcedDeadline } from '../utils/requestDeadline.ts';

export interface SearchResults { papers: Paper[]; authors: OpenAlexAuthor[]; institutions: OpenAlexInstitution[]; topics: OpenAlexTopic[]; projects: Project[] }
export type SearchSection = keyof SearchResults;
export interface SearchIssue { section: SearchSection; reason: 'timeout' | 'error' }
export interface SearchSnapshot { results: SearchResults; pending: SearchSection[]; issues: SearchIssue[] }
type SearchProviders = { [K in SearchSection]: (query: string, signal: AbortSignal) => Promise<SearchResults[K]> };
export const SEARCH_SECTIONS: SearchSection[] = ['papers', 'authors', 'institutions', 'topics', 'projects'];
export const EMPTY_SEARCH: SearchSnapshot = { results: { papers: [], authors: [], institutions: [], topics: [], projects: [] }, pending: [], issues: [] };

// These include the services' own deadlines and enrichment. Expiry cancels
// the underlying request as well as releasing the UI; late replies stay out.
const SECTION_TIMEOUTS = { papers: 6000, authors: 9000, institutions: 9000, topics: 4500, projects: 6000 };
const providers: SearchProviders = {
  papers: (query, signal) => searchPapersAcrossSources(query, { signal }),
  authors: (query, signal) => searchAuthors(query, { signal, throwOnError: true, typeahead: true })
    .then(items => filterRelevantSearchResults(query, items.filter(author => !isOrganisationAuthorRecord(author)),
      authorSearchValues, { getWeight: authorProminenceWeight }))
    .then(items => Promise.all(items.map(author => enrichAuthorInstitutionLocalization(author, { timeoutMs: 1500 })))),
  institutions: (query, signal) => searchInstitutions(query, { signal, throwOnError: true }),
  topics: (query, signal) => searchConcepts(query, { signal, limit: 8, throwOnError: true }),
  projects: (query, signal) => searchProjects(query, 1, { signal, throwOnError: true }).then(result => result.projects),
};

/** Each section settles independently; display priority never gates another source. */
export async function searchEntities(query: string, {
  signal, onUpdate, knownPapers = [], sources = providers, timeouts = SECTION_TIMEOUTS,
}: { signal: AbortSignal; knownPapers?: Paper[]; onUpdate: (snapshot: SearchSnapshot) => void; sources?: SearchProviders; timeouts?: typeof SECTION_TIMEOUTS }) {
  const localPapers = rankPaperSearchResults(query, knownPapers.filter(paper => scorePaperSearchMatch(query, paper) >= 80)).slice(0, 10);
  let snapshot: SearchSnapshot = { results: { ...EMPTY_SEARCH.results, papers: localPapers }, pending: [...SEARCH_SECTIONS], issues: [] };
  const publish = () => { if (!signal.aborted) onUpdate(snapshot); };
  publish();

  const search = <K extends SearchSection>(section: K) => new Promise<{ section: K; items: SearchResults[K]; issue?: SearchIssue }>(resolve => {
    const deadline = withEnforcedDeadline({ signal }, timeouts[section]).signal;
    let settled = false;
    function finish(items: SearchResults[K], issue?: SearchIssue) {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', abort);
      resolve({ section, items, issue });
    }
    function abort() {
      finish(EMPTY_SEARCH.results[section], { section, reason: deadline.reason?.name === 'TimeoutError' ? 'timeout' : 'error' });
    }
    if (deadline.aborted) { abort(); return; }
    deadline.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => sources[section](query, deadline)).then(
      items => finish(items),
      error => finish(EMPTY_SEARCH.results[section], { section, reason: error?.name === 'TimeoutError' ? 'timeout' : 'error' }),
    );
  });
  const reveal = (outcome: Awaited<ReturnType<typeof search>>) => {
    snapshot = {
      results: { ...snapshot.results, [outcome.section]: outcome.section === 'papers' && localPapers.length > 0
        ? rankPaperSearchResults(query, PaperBuilder.deduplicate([...localPapers, ...outcome.items as Paper[]])).slice(0, 10)
        : outcome.items },
      pending: snapshot.pending.filter(section => section !== outcome.section),
      issues: [...snapshot.issues, ...(outcome.issue ? [outcome.issue] : [])],
    };
    publish();
  };
  await Promise.all(SEARCH_SECTIONS.map(section => search(section).then(reveal)));
  return snapshot;
}
