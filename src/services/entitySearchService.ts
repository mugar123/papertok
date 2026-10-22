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
export type SearchScope = 'all' | SearchSection;
// `error` is the failure itself, for what a reason cannot carry: the wait a
// rate limit named, which the OpenAlex client parsed out of `Retry-After`.
// That wait counts from `failedAtMs`, when the section failed.
export interface SearchIssue { section: SearchSection; reason: 'timeout' | 'error'; error?: unknown; failedAtMs: number }
export interface SearchSnapshot { results: SearchResults; pending: SearchSection[]; issues: SearchIssue[] }
export type SearchProviders = { [K in SearchSection]: (query: string, signal: AbortSignal) => Promise<SearchResults[K]> };
export const SEARCH_SECTIONS: SearchSection[] = ['papers', 'authors', 'institutions', 'topics', 'projects'];
export const EMPTY_SEARCH: SearchSnapshot = { results: { papers: [], authors: [], institutions: [], topics: [], projects: [] }, pending: [], issues: [] };

// The sections that ask OpenAlex a question of their own: the author search
// is billed as ten list calls, the institution ranking and the topic
// autocomplete as one each (worker/provider-runtime.ts).
const ENTITY_SECTIONS: SearchSection[] = ['authors', 'institutions', 'topics'];

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

function sectionsShown(scope: SearchScope): SearchSection[] {
  return scope === 'all' ? SEARCH_SECTIONS : [scope];
}

/** One query's search. A scope is asked for when it is shown, and each section runs once. */
export interface EntitySearch {
  /** Runs whatever `scope` shows that has not run yet; resolves once all of it has settled. */
  ask(scope: SearchScope): Promise<SearchSnapshot>;
  /** Whether everything `scope` shows has settled. */
  settled(scope: SearchScope): boolean;
}

/**
 * Each section settles independently; display priority never gates another
 * source. Under All the papers go first and the entity sections follow once
 * the papers have settled: every debounced term is a papers search, but a
 * term the reader was still typing is never searched for authors, which
 * costs as much again. Projects come from OpenAIRE and run beside the papers.
 */
export function searchEntities(query: string, {
  signal, onUpdate, knownPapers = [], sources = providers, timeouts = SECTION_TIMEOUTS,
}: { signal: AbortSignal; knownPapers?: Paper[]; onUpdate: (snapshot: SearchSnapshot) => void; sources?: SearchProviders; timeouts?: typeof SECTION_TIMEOUTS }): EntitySearch {
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
      finish(EMPTY_SEARCH.results[section], { section, reason: deadline.reason?.name === 'TimeoutError' ? 'timeout' : 'error', failedAtMs: Date.now() });
    }
    if (deadline.aborted) { abort(); return; }
    deadline.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => sources[section](query, deadline)).then(
      items => finish(items),
      error => finish(EMPTY_SEARCH.results[section], { section, reason: error?.name === 'TimeoutError' ? 'timeout' : 'error', error, failedAtMs: Date.now() }),
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
  const runs = new Map<SearchSection, Promise<void>>();
  const run = (section: SearchSection) => {
    let running = runs.get(section);
    if (!running) {
      running = search(section).then(reveal);
      runs.set(section, running);
    }
    return running;
  };

  return {
    settled: scope => sectionsShown(scope).every(section => !snapshot.pending.includes(section)),
    async ask(scope) {
      if (scope === 'all') {
        await Promise.all([
          run('papers').then(() => (signal.aborted ? undefined : Promise.all(ENTITY_SECTIONS.map(run)))),
          run('projects'),
        ]);
      } else {
        await run(scope);
      }
      return snapshot;
    },
  };
}
