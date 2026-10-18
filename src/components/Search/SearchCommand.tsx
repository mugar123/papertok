import type { ComponentProps, MouseEvent } from 'react';
import type { FollowInput } from '../../utils/following.ts';

import { Children, cloneElement, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  ClockCounterClockwise,
  X,
  Briefcase,
  Buildings,
  Check,
  CircleNotch,
  FileText,
  Lightbulb,
  Plus,
  Users,
  WarningCircle,
} from '@phosphor-icons/react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command.tsx';
import { DialogClose } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { useEntitySearch } from '../../hooks/useEntitySearch.ts';
import { useFeed } from '../../context/FeedContext.tsx';
import { useFollowing } from '../../context/FollowingContext.tsx';
import { searchPaperDestination } from '../../utils/searchDestinations.ts';
import { handoverFromSearchRow } from '../../utils/explorerHandover.ts';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization.ts';
import {
  buildSearchSectionValues,
  getSearchSectionOrder,
  resolvePreferredSearchSection,
} from '../../utils/searchRelevance.ts';
import './SearchCommand.css';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import { useAuth } from '../../context/AuthContext.tsx';
import { authorDisplayName } from '../../utils/explorerPaths.ts';
import { SOURCE_LABELS } from '../../utils/searchOutage.ts';
import { readRecentSearches, updateRecentSearches } from './recentSearches.ts';
import { Toggle } from '../ui/toggle.tsx';

const COPY = {
  en: {
    placeholder: 'Search papers, authors, topics…',
    papers: 'Papers',
    authors: 'Authors',
    institutions: 'Institutions',
    topics: 'Topics',
    projects: 'Projects',
    empty: 'No results',
    searching: 'Searching...',
    suggested: 'Suggestions',
    follow: 'Follow',
    following: 'Following',
    works: 'works',
    cancel: 'Cancel',
  },
};

const SUGGESTIONS = [
  { label: 'Cosmology', query: 'Cosmology', type: 'Topic', Icon: Lightbulb },
  { label: 'MIT', query: 'Massachusetts Institute of Technology', type: 'Institution', Icon: Buildings },
  { label: 'CRISPR Cas9', query: 'CRISPR Cas9', type: 'Papers', Icon: FileText },
  { label: 'Geoffrey Hinton', query: 'Geoffrey Hinton', type: 'Author', Icon: Users },
  { label: 'Human Brain Project', query: 'Human Brain Project', type: 'Project', Icon: Briefcase },
];

// Every section the palette can paint. Each one also has to be in
// searchRelevance's DEFAULT_SECTION_ORDER: a section the palette renders but
// the ordering module has never heard of scores 99 and sinks to the bottom of
// every search, silently.
const SECTIONS = ['papers', 'authors', 'topics', 'institutions', 'projects'] as const;

/**
 * How far down a section the entrance cascade runs before every remaining row
 * shares the last delay.
 *
 * A forty-row answer staggered end to end takes a second to finish arriving,
 * and a second of things still moving is a wait, not an animation — the reader
 * has already started on row one and the rest is movement in the corner of
 * their eye. Ten steps of 24 ms puts the last row in at 240 ms.
 *
 * The index counts from each section's own heading, not from the top of the
 * list: sections arrive one by one, and a CSS animation's delay runs from the
 * moment its row is inserted. Counted down the whole list, a section landing
 * above one already arriving renumbered its rows and moved their delays mid
 * animation (measured: topics at 611 ms, papers above them at 636 ms).
 */
const ENTER_STAGGER_CAP = 10;
const ENTER_STEP_MS = 24;
const ENTER_RISE_MS = 260;

const SECTION_ICONS = {
  papers: FileText,
  authors: Users,
  institutions: Buildings,
  topics: Lightbulb,
  projects: Briefcase,
};

function lastPathSegment(value: unknown) {
  return String(value || '').split('/').pop();
}

/**
 * Search as an overlay palette rather than a page.
 *
 * Every source the full page queried is still queried, and results keep the
 * same grouping and destinations; what changes is that searching no longer
 * costs you your place in the feed.
 */
export default function SearchCommand({ open, onOpenChange, finalFocus }: { open: boolean; onOpenChange: (open: boolean) => void; finalFocus?: ComponentProps<typeof CommandDialog>['finalFocus'] }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const uid = user?.uid;
  const { papers: knownPapers } = useFeed();
  const isPhone = useIsPhone();
  const inputRef = useRef<HTMLInputElement>(null);
  const typedQuery = useRef(false);
  const selectionAllowed = useRef(true);
  const [selectedValue, setSelectedValue] = useState('');
  const [manualSelection, setManualSelection] = useState(false);
  const [activeSection, setActiveSection] = useState<'all' | typeof SECTIONS[number]>('all');
  const [recentOwner, setRecentOwner] = useState<{ uid?: string; queries: string[] }>({ queries: [] });
  const recents = recentOwner.uid === uid ? recentOwner.queries : [];

  // Whether the palette is closing because a row was picked. Picking is not
  // dismissing: the reader is being answered, not getting out of the way, so
  // the sheet and its scrim go in 100ms of opacity (`.sc-sheet--select`) and
  // the page transition is the only movement left. Measured before this:
  // sheet, scrim and feed dissolved on three clocks with two empty frames in
  // the middle. Cleared on the way in, like `reset`.
  const [leavingBySelect, setLeavingBySelect] = useState(false);
  const copy = COPY.en;
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    query, setQuery, results, totalResults,
    isPending, hasSearched, searchIssues, pendingSections, resultsTerm, reset, retry,
  } = useEntitySearch(open, knownPapers);
  const [pendingEntity, setPendingEntity] = useState<string | null | undefined>(null);
  const [cascadeDone, setCascadeDone] = useState(false);

  const rememberQuery = useEffectEvent(() => {
    if (!uid || recentOwner.uid !== uid || !typedQuery.current || !hasSearched
      || resultsTerm !== query.trim() || totalResults === 0 || isPending) return;
    setRecentOwner({ uid, queries: updateRecentSearches(uid, query) });
  });

  // Cleared on the way in, never on the way out. The palette stays mounted
  // between opens (App.jsx), so `open` turning false is the START of the exit,
  // not the end of the palette: a reset there repainted the sheet with the
  // empty-query view — results gone, suggestions cascading in — inside the
  // 220 ms it was fading out. A layout effect on open runs before that opening
  // is painted, so the previous answer is never on screen either way.
  // `leavingBySelect` clears here for the same reason: it must be false
  // before the next close that isn't a pick, or a stale `true` left over from
  // the last pick would give a plain Escape the picked exit instead of the
  // dismiss. Calling the setter synchronously is exactly the point — before
  // paint, same as `reset()` beside it — so the rule is off for this effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (open) {
      reset();
      setLeavingBySelect(false);
      setCascadeDone(false);
      setActiveSection('all');
      setSelectedValue('');
      setManualSelection(false);
      selectionAllowed.current = !window.matchMedia('(pointer: coarse)').matches;
      typedQuery.current = false;
      setRecentOwner({ uid, queries: readRecentSearches(uid) });
    } else {
      rememberQuery();
      if (recentOwner.uid !== uid) setRecentOwner({ uid, queries: [] });
    }
  }, [open, reset, uid, recentOwner.uid]);

  // cmdk selects the first registered row, even with a controlled empty value.
  // Clear that automatic choice before paint until a coarse-pointer interaction.
  useLayoutEffect(() => {
    if (!selectionAllowed.current && selectedValue) setSelectedValue('');
  }, [selectedValue]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const hasResults = totalResults > 0;
  useEffect(() => {
    if (!open || cascadeDone || !hasResults) return undefined;
    const done = setTimeout(() => setCascadeDone(true), ENTER_STAGGER_CAP * ENTER_STEP_MS + ENTER_RISE_MS);
    return () => clearTimeout(done);
  }, [open, cascadeDone, hasResults]);

  const go = useCallback((path: string, state: object | null = null) => {
    setLeavingBySelect(true);
    onOpenChange(false);
    // Router state, when there is any: the public paper page paints a paper
    // handed to it and treats its own fetch as an upgrade, so a row the palette
    // has already fetched opens without a second wait.
    navigate(path, state ? { state } : undefined);
  }, [navigate, onOpenChange]);

  const follow = useCallback(async (event: MouseEvent, entity: FollowInput) => {
    event.preventDefault();
    event.stopPropagation();
    setPendingEntity(entity.id);
    try {
      await toggleFollow(entity);
    } catch (error) {
      console.error('Could not update follow state', error);
    } finally {
      setPendingEntity(null);
    }
  }, [toggleFollow]);

  // The sections on screen when this view of the answer was first painted. One
  // that turns up after them answers no keystroke — it is news, often seconds
  // later and often above what is being read — so it enters even once the
  // cascade is off. Keyed by the type tab too: switching tabs repaints the view
  // and must not replay a late section's entrance. Recorded during render,
  // React's pattern for a value from a previous render, so the late section's
  // first paint already knows it is late.
  const shownSections = SECTIONS.filter(section => results[section].length > 0
    && (activeSection === 'all' || activeSection === section));
  const paintedView = query.trim() && !isPending && shownSections.length > 0 ? `${activeSection}:${resultsTerm}` : '';
  const [firstPaint, setFirstPaint] = useState({ view: '', sections: shownSections });
  if (firstPaint.view !== paintedView) setFirstPaint({ view: paintedView, sections: shownSections });

  // Type positions stay fixed while the result groups retain relevance ordering.
  const orderedSections = SECTIONS;
  const rankedSections = useMemo(() => {
    const preferred = resolvePreferredSearchSection({
      query,
      // Shared with the page. This block used to be written out here as well
      // and the copies had drifted: the palette left out `aliases` and
      // `acronyms`, so it alone could not match the "USAL" or "MIT" that ROR
      // had already handed it — and an acronym carries no organisation word,
      // so the exact sweep is the only way such a search can land.
      sectionValues: buildSearchSectionValues({
        papers: results.papers,
        authors: results.authors,
        institutions: results.institutions,
        topics: results.topics,
        projects: results.projects,
      }),
    });
    return [...SECTIONS]
      .sort((left, right) => getSearchSectionOrder(left, preferred) - getSearchSectionOrder(right, preferred));
  }, [query, results]);

  const changeQuery = (value: string, typed = false) => {
    typedQuery.current = typed;
    setActiveSection('all');
    setSelectedValue('');
    setManualSelection(false);
    selectionAllowed.current = !window.matchMedia('(pointer: coarse)').matches;
    setQuery(value);
  };

  const renderFollow = (entity: FollowInput) => {
    const following = isFollowing(entity);
    const pending = isFollowPending(entity) || pendingEntity === entity.id;
    return (
      <Toggle
        className={`sc-follow ${following ? 'is-following' : ''}`}
        onClick={(event) => follow(event, entity)}
        disabled={pending}
        pressed={following}
        aria-label={following ? copy.following : copy.follow}
        onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}
      >
        {pending
          ? <CircleNotch size={12} className="spinning" />
          : following ? <Check size={12} /> : <Plus size={12} />}
        <span>{following ? copy.following : copy.follow}</span>
      </Toggle>
    );
  };

  const sectionContent = {
    papers: () => results.papers.map(paper => (
      <CommandItem
        key={paper.id}
        value={`paper-${paper.id}`}
        onSelect={() => {
          // Not `/explorer/paper/…`: that route has never existed, and the id
          // ended up at the authors endpoint, which is where "Entity not found"
          // came from.
          const { path, state } = searchPaperDestination(paper, query);
          go(path, state);
        }}
      >
        <FileText size={14} className="sc-icon" />
        <span className="sc-paper-text">
          <span className="sc-label">{paper.title}</span>
          <span className="sc-paper-detail">
            <span className="sc-author">{authorDisplayName(paper.authors?.[0])}</span>
            <span className="sc-paper-numbers sc-paper-numbers--mobile">
              {paper.authors?.length && (paper.year != null || paper.citationCount != null) ? '· ' : ''}
              {[paper.year, paper.citationCount != null ? `${paper.citationCount.toLocaleString('en-US')} cit.` : null].filter(value => value != null).join(' · ')}
            </span>
          </span>
        </span>
        <span className="sc-paper-numbers sc-paper-numbers--desktop">
          {[paper.year, paper.citationCount != null ? `${paper.citationCount.toLocaleString('en-US')} cit.` : null].filter(value => value != null).join(' · ')}
        </span>
      </CommandItem>
    )),
    authors: () => results.authors.map(author => {
      const orcid = author.orcid ? String(author.orcid).replace(/^https?:\/\/orcid\.org\//, '') : '';
      const path = orcid
        ? `/explorer/author/https%3A%2F%2Forcid.org%2F${orcid}`
        : `/explorer/author/${lastPathSegment(author.id)}`;
      return (
        <CommandItem key={author.id} value={`author-${author.id}`} onSelect={() => go(path, { entity: handoverFromSearchRow('author', author), entityType: 'author' })}>
          <Users size={14} className="sc-icon" />
          <span className="sc-label">{author.display_name}</span>
          <span className="sc-meta">
            {author.last_known_institution?.display_name
              || author.localizedInstitutionName
              || ''}
          </span>
          {renderFollow({ type: 'author', id: author.id, name: author.display_name })}
        </CommandItem>
      );
    }),
    institutions: () => results.institutions.map(institution => (
      <CommandItem
        key={institution.id}
        value={`institution-${institution.id}`}
        onSelect={() => go(`/explorer/institution/${lastPathSegment(institution.id)}`, { entity: handoverFromSearchRow('institution', institution), entityType: 'institution' })}
      >
        <Buildings size={14} className="sc-icon" />
        <span className="sc-label">
          {getLocalizedInstitutionName(institution) || institution.display_name}
        </span>
        <span className="sc-meta">{institution.country_code || ''}</span>
        {renderFollow({
          type: 'institution',
          id: institution.id,
          name: institution.display_name,
        })}
      </CommandItem>
    )),
    topics: () => results.topics.map(concept => (
      <CommandItem
        key={concept.id}
        value={`topic-${concept.id}`}
        onSelect={() => go(`/explorer/topic/${encodeURIComponent(lastPathSegment(concept.id)!)}`, { entity: handoverFromSearchRow('topic', concept), entityType: 'topic' })}
      >
        <Lightbulb size={14} className="sc-icon" />
        <span className="sc-label">{concept.display_name || concept.label}</span>
        <span className="sc-meta">
          {concept.works_count ? `${concept.works_count.toLocaleString()} ${copy.works}` : ''}
        </span>
        {renderFollow({
          type: 'concept',
          id: concept.id,
          name: concept.display_name || concept.label,
        })}
      </CommandItem>
    )),
    projects: () => results.projects.map(project => (
      <CommandItem
        key={project.id}
        value={`project-${project.id}`}
        onSelect={() => go(
          `/explorer/project/${encodeURIComponent(project.id!)}`
          + `?name=${encodeURIComponent((project.acronym || project.title)!)}`
          + `&funder=${encodeURIComponent(project.funder || '')}`,
        )}
      >
        <Briefcase size={14} className="sc-icon" />
        <span className="sc-label">{project.acronym || project.title}</span>
        <span className="sc-meta">{project.funder || ''}</span>
      </CommandItem>
    )),
  };

  // Keep each section's animation clock independent of later arrivals.
  let firstResultValue = '';
  const renderedSections = rankedSections.map((section) => {
    if (results[section].length === 0 || (activeSection !== 'all' && activeSection !== section)) return null;
    const SectionIcon = SECTION_ICONS[section];
    const still = cascadeDone && firstPaint.sections.includes(section);
    const sectionRows = sectionContent[section]();
    const visibleRows = activeSection === 'all' ? sectionRows.slice(0, 4) : sectionRows;
    if (!firstResultValue) firstResultValue = visibleRows[0]?.props.value || '';
    const rows = still ? visibleRows : Children.map(visibleRows, (child, offset) => cloneElement(child, {
      className: [child.props.className, 'sc-enter'].filter(Boolean).join(' '),
      style: {
        ...child.props.style,
        '--sc-enter-index': Math.min(offset + 1, ENTER_STAGGER_CAP),
      },
    }));
    return (
      <CommandGroup
        key={section}
        heading={
          <span className={still ? 'sc-heading' : 'sc-heading sc-enter'}>
            <SectionIcon size={11} /> {copy[section]} · {results[section].length}
          </span>
        }
      >
        {rows}
        {activeSection === 'all' && sectionRows.length > 4 && (
          <CommandItem value={`show-all-${section}`} onSelect={() => setActiveSection(section)} className="sc-show-all">
            <span>Show all {sectionRows.length} {copy[section].toLowerCase()} <ArrowRight size={14} /></span>
          </CommandItem>
        )}
      </CommandGroup>
    );
  });

  const hasQuery = Boolean(query.trim());
  const visibleCount = activeSection === 'all' ? totalResults : results[activeSection].length;
  const waitingForView = activeSection === 'all' ? pendingSections.length > 0 : pendingSections.includes(activeSection);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} finalFocus={finalFocus} title={copy.placeholder} className={`sc-sheet${leavingBySelect ? ' sc-sheet--select' : ''}`} overlayClassName={`sc-scrim${leavingBySelect ? ' sc-scrim--select' : ''}`}
      commandProps={{
        label: copy.placeholder,
        // Late sections may rank above the first reply. Enter follows the
        // visible first row until the user explicitly chooses another one.
        value: hasQuery && !manualSelection && selectedValue ? firstResultValue : selectedValue,
        onValueChange: setSelectedValue,
        onPointerDownCapture: () => { selectionAllowed.current = true; setManualSelection(true); },
        onPointerMoveCapture: event => { if (event.pointerType === 'mouse') setManualSelection(true); },
        onKeyDownCapture: event => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            selectionAllowed.current = true;
            setManualSelection(true);
          }
        },
      }}
    >
      <Tabs value={activeSection} onValueChange={value => setActiveSection(value)} className="sc-index">
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={value => changeQuery(value, true)}
          placeholder={isPhone ? 'Search PaperTok' : copy.placeholder}
          className="sc-input"
          wrapperClassName="sc-input-row"
          autoFocus
        >
          {hasQuery && !isPending && <span className="sc-result-count">{totalResults} results</span>}
        </CommandInput>

        {hasQuery && (
          <TabsList activateOnFocus variant="line" className="sc-types" aria-label="Result types"
            onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
            <TabsTrigger value="all" aria-label={`All${isPending ? ', searching' : `, ${totalResults} results`}`}>
              All {isPending ? <CircleNotch size={10} className="spinning" aria-busy="true" aria-label="Searching" /> : <span className="sc-count">{totalResults}</span>}
            </TabsTrigger>
            {orderedSections.map(section => {
              const pending = pendingSections.includes(section);
              const count = results[section].length;
              return <TabsTrigger key={section} value={section} disabled={!pending && count === 0}
                aria-disabled={!pending && count === 0}
                aria-label={`${copy[section]}, ${pending ? 'searching' : `${count} results`}`}>
                {copy[section]} {pending
                  ? <CircleNotch size={10} className="spinning" aria-busy="true" aria-label="Searching" />
                  : <span className="sc-count">{count}</span>}
              </TabsTrigger>;
            })}
          </TabsList>
        )}

        <div className="sc-clear-slot">
          {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" className="sc-clear"
            onClick={() => { changeQuery(''); inputRef.current?.focus(); }}
            onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}><X size={16} /></Button>}
        </div>
        <div className="sc-cancel-slot">
          <DialogClose render={<Button variant="ghost" size="sm" className="sc-cancel" />}
            onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>{copy.cancel}</DialogClose>
        </div>

        <TabsContent value={activeSection} className="sc-panel">
          <CommandList className="sc-list">
            {!hasQuery && <>
              {recents.length > 0 && <CommandGroup heading={<span className="sc-heading">Recent</span>}>
                {recents.map(term => <CommandItem key={term} value={`recent-${term}`} onSelect={() => changeQuery(term)}>
                  <ClockCounterClockwise size={14} className="sc-icon" /><span className="sc-label">{term}</span>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove from recent: ${term}`} className="sc-remove"
                    onClick={event => { event.preventDefault(); event.stopPropagation(); setRecentOwner({ uid, queries: updateRecentSearches(uid, term, true) }); }}
                    onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}><X size={14} /></Button>
                </CommandItem>)}
              </CommandGroup>}
              <CommandGroup heading={<span className="sc-heading">{copy.suggested}</span>}>
                {SUGGESTIONS.map(item => <CommandItem key={item.label} value={`suggestion-${item.label}`} onSelect={() => changeQuery(item.query)}>
                  <item.Icon size={14} className="sc-icon" /><span className="sc-label">{item.label}</span><span className="sc-suggestion-type">{item.type}</span>
                </CommandItem>)}
              </CommandGroup>
            </>}

            {isPending && (
              <div className="sc-skeleton" aria-hidden="true">
                {[0, 1, 2, 3, 4].map(index => <div className="sc-skeleton-row" key={index}>
                  <span className="sc-skeleton-icon" /><span className="sc-skeleton-line" /><span className="sc-skeleton-meta" />
                </div>)}
              </div>
            )}
            {searchIssues.length > 0 && hasQuery && <div className="sc-status sc-status--warn"><WarningCircle size={14} />
              {searchIssues.map(issue => `${copy[issue.section]} ${issue.reason === 'timeout' ? 'timed out' : 'could not be loaded'}`).join('. ')}.
              <Button variant="ghost" size="sm" onClick={retry}>Try again</Button>
            </div>}
            {hasQuery && hasSearched && !waitingForView && !isPending && visibleCount === 0 && <CommandEmpty>{copy.empty}</CommandEmpty>}
            {!isPending && hasQuery && renderedSections}
            <span className="visually-hidden" role="status">{hasQuery ? (isPending ? copy.searching : `${visibleCount} results available.${waitingForView ? ' Other sections are still searching.' : ''}${searchIssues.length ? ` ${searchIssues.map(issue => copy[issue.section]).join(', ')} unavailable.` : ''}`) : ''}</span>
          </CommandList>
        </TabsContent>
        <div className="sc-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>Tab</kbd> Types</span>
          <span><kbd>Esc</kbd> Close</span>
          <span className="sc-sources">{['openalex', 'arxiv', 'openaire'].map(source => SOURCE_LABELS[source]).join(' · ')}</span>
        </div>
      </Tabs>
    </CommandDialog>
  );
}
