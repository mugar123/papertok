import type { ComponentProps, MouseEvent } from 'react';
import type { FollowInput } from '../../utils/following.ts';

import { Children, cloneElement, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
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
import { Toggle } from '../ui/toggle.tsx';

const COPY = {
  en: {
    placeholder: 'Search papers, authors, topics, institutions...',
    papers: 'Papers',
    authors: 'Authors',
    institutions: 'Institutions',
    topics: 'Topics',
    projects: 'Projects',
    empty: 'No results',
    searching: 'Searching...',
    suggested: 'Suggestions',
    partial: 'Some sources did not answer; showing what is available.',
    follow: 'Follow',
    following: 'Following',
    citations: 'citations',
    works: 'works',
    cancel: 'Cancel',
  },
};

const SUGGESTIONS = [
  { label: 'Cosmology', query: 'Cosmology', Icon: Lightbulb },
  { label: 'MIT', query: 'Massachusetts Institute of Technology', Icon: Buildings },
  { label: 'CRISPR Cas9', query: 'CRISPR Cas9', Icon: FileText },
  { label: 'Geoffrey Hinton', query: 'Geoffrey Hinton', Icon: Users },
  { label: 'Human Brain Project', query: 'Human Brain Project', Icon: Briefcase },
];

// Every section the palette can paint. Each one also has to be in
// searchRelevance's DEFAULT_SECTION_ORDER: a section the palette renders but
// the ordering module has never heard of scores 99 and sinks to the bottom of
// every search, silently.
const SECTIONS = ['papers', 'authors', 'institutions', 'topics', 'projects'] as const;

/**
 * How far down the list the entrance cascade runs before every remaining row
 * shares the last delay.
 *
 * A forty-row answer staggered end to end takes a second to finish arriving,
 * and a second of things still moving is a wait, not an animation — the reader
 * has already started on row one and the rest is movement in the corner of
 * their eye. Ten steps of 24 ms puts the last row in at 240 ms.
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
    isPending, hasSearched, searchIssue, reset,
  } = useEntitySearch();
  const [pendingEntity, setPendingEntity] = useState<string | null | undefined>(null);
  const [cascadeDone, setCascadeDone] = useState(false);

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
    }
  }, [open, reset]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open || cascadeDone || totalResults === 0) return undefined;
    const done = setTimeout(() => setCascadeDone(true), ENTER_STAGGER_CAP * ENTER_STEP_MS + ENTER_RISE_MS);
    return () => clearTimeout(done);
  }, [open, cascadeDone, totalResults]);

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

  // The section matching the query best is shown first, as on the old page.
  const orderedSections = useMemo(() => {
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
        <span className="sc-label">{paper.title}</span>
        <span className="sc-meta">
          {paper.year || ''}
          {paper.citationCount! > 0 ? ` · ${paper.citationCount} ${copy.citations}` : ''}
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

  /**
   * The answer arriving, as one movement.
   *
   * Everything lands in a single commit now, so without this the skeleton
   * vanishes and a finished page is simply there — the least fluid thing an
   * interface can do with half a second of work behind it. Each heading and row
   * rises 6px into place, one after the next.
   *
   * The counter runs across the WHOLE list rather than restarting per group, so
   * what the eye follows is one cascade down the sheet instead of four that
   * start at once. Headings take a step of their own, which is what makes a
   * group read as a group rather than as a label bolted to its first row.
   *
   * The index is injected here rather than written into each of the five row
   * renderers: they build plain `CommandItem`s and know nothing about where
   * they sit in the final order, which is decided by `orderedSections` after
   * the fact.
   */
  let enterIndex = 0;
  const renderedSections = orderedSections.map((section) => {
    if (results[section].length === 0) return null;
    const SectionIcon = SECTION_ICONS[section];
    const headingIndex = Math.min(enterIndex, ENTER_STAGGER_CAP);
    enterIndex += 1;
    const rows = cascadeDone ? sectionContent[section]() : Children.map(sectionContent[section](), (child, offset) => cloneElement(child, {
      className: [child.props.className, 'sc-enter'].filter(Boolean).join(' '),
      style: {
        ...child.props.style,
        '--sc-enter-index': Math.min(enterIndex + offset, ENTER_STAGGER_CAP),
      },
    }));
    enterIndex += results[section].length;
    return (
      <CommandGroup
        key={section}
        heading={
          <span className={cascadeDone ? 'sc-heading' : 'sc-heading sc-enter'} style={cascadeDone ? undefined : { '--sc-enter-index': headingIndex }}>
            <SectionIcon size={11} /> {copy[section]}
          </span>
        }
      >
        {rows}
      </CommandGroup>
    );
  });

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} finalFocus={finalFocus} title={copy.placeholder} className={`sc-sheet${leavingBySelect ? ' sc-sheet--select' : ''}`} overlayClassName={`sc-scrim${leavingBySelect ? ' sc-scrim--select' : ''}`}>
      {/* The field is still from the first frame: it is opened from the
          keyboard and typed into at once, so the sheet's own entrance is the
          only movement. */}
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={copy.placeholder}
        autoFocus
      >
        {/* The way out on a phone. There the sheet is the whole screen
            (SearchCommand.css): no scrim to tap and no Escape key, so without
            this the only exit is Back. A `DialogClose`, so Base UI closes and
            restores focus exactly as it does for the other two. Hidden on
            wider viewports, where the scrim and Escape already do the job
            and the row belongs to the field alone. */}
        <DialogClose
          render={<Button variant="ghost" size="sm" className="sc-cancel" />}
          // cmdk listens for Enter on the whole palette and answers it by
          // picking the highlighted row, so Enter on this button — Tab from
          // the field, then Enter — used to select "Cosmology" instead of
          // cancelling. The button still gets its native activation; only the
          // palette stops hearing the key.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.stopPropagation();
          }}
        >
          {copy.cancel}
        </DialogClose>
      </CommandInput>

      <CommandList>
        {/* The suggestions are simply there when the palette opens: the sheet's
            own entrance is the only movement (2026-10-15). */}
        {!query.trim() && (
          <CommandGroup
            heading={<span className="sc-heading">{copy.suggested}</span>}
          >
            {SUGGESTIONS.map((item) => (
              <CommandItem
                key={item.label}
                value={`suggestion-${item.label}`}
                onSelect={() => setQuery(item.query)}
              >
                <item.Icon size={14} className="sc-icon" />
                <span className="sc-label">{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Rows of the real height rather than a lone spinner. The palette now
            waits for every source before painting anything, so the wait needs a
            shape: a spinner over an empty sheet reads as nothing happening, and
            a sheet that fills from nothing shifts everything under the cursor
            when it does. */}
        {isPending && (
          <div className="sc-skeleton" role="status">
            {[0, 1, 2, 3, 4].map(index => (
              <div className="sc-skeleton-row" key={index}>
                <span className="sc-skeleton-icon" />
                <span className="sc-skeleton-line" />
                <span className="sc-skeleton-meta" />
              </div>
            ))}
            {/* Real text, not just an aria-label: the skeleton rows above are
                plain decorative placeholders, so an aria-label alone here
                would never be announced as a status change. Kept AFTER the
                rows on purpose -- the stagger below is keyed off
                `.sc-skeleton-row:nth-child(2..5)`, and a leading sibling
                would shift every row's position by one and break it. */}
            <span className="visually-hidden">{copy.searching}</span>
          </div>
        )}

        {searchIssue && !isPending && totalResults > 0 && (
          <div className="sc-status sc-status--warn" role="status">
            <WarningCircle size={14} /> {copy.partial}
          </div>
        )}

        {hasSearched && !isPending && totalResults === 0 && (
          <CommandEmpty>{copy.empty}</CommandEmpty>
        )}

        {/* No new section paints until the five sources land in one commit.
            Until then the skeleton above stands in, or, while the next search
            waits out its debounce, the previous rows stay up dimmed. */}
        {!isPending && renderedSections}

      </CommandList>
      <div className="sc-footer" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>↵</kbd> Open</span>
        <span><kbd>Esc</kbd> Close</span>
      </div>
    </CommandDialog>
  );
}
