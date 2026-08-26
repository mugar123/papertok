import { Children, cloneElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Building2,
  Check,
  FileText,
  Briefcase,
  Lightbulb,
  LoaderCircle,
  Plus,
  UserRound,
  Users,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command.jsx';
import { useEntitySearch } from '../../hooks/useEntitySearch.js';
import { useFollowing } from '../../context/FollowingContext';
import { useLanguage } from '../../context/LanguageContext';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import {
  buildSearchSectionValues,
  getSearchSectionOrder,
  resolvePreferredSearchSection,
} from '../../utils/searchRelevance';
import './SearchCommand.css';

const COPY = {
  es: {
    placeholder: 'Busca papers, personas, autores, temas, instituciones...',
    papers: 'Papers',
    users: 'Usuarios de PaperTok',
    authors: 'Autores',
    institutions: 'Instituciones',
    topics: 'Temas',
    projects: 'Proyectos',
    empty: 'Sin resultados',
    searching: 'Buscando...',
    hint: 'Escribe para buscar en papers, usuarios, autores, temas, instituciones y proyectos financiados.',
    suggested: 'Sugerencias',
    partial: 'Algunas fuentes no respondieron; se muestra lo disponible.',
    peopleSlow: 'Las personas están tardando más de lo normal.',
    peopleFailed: 'No se han podido cargar las personas.',
    follow: 'Seguir',
    following: 'Siguiendo',
    citations: 'citas',
    works: 'trabajos',
  },
  en: {
    placeholder: 'Search papers, people, authors, topics, institutions...',
    papers: 'Papers',
    users: 'PaperTok users',
    authors: 'Authors',
    institutions: 'Institutions',
    topics: 'Topics',
    projects: 'Projects',
    empty: 'No results',
    searching: 'Searching...',
    hint: 'Type to search papers, users, authors, topics, institutions and funded projects.',
    suggested: 'Suggestions',
    partial: 'Some sources did not answer; showing what is available.',
    peopleSlow: 'People are taking longer than usual.',
    peopleFailed: 'People could not be loaded.',
    follow: 'Follow',
    following: 'Following',
    citations: 'citations',
    works: 'works',
  },
};

const SUGGESTIONS = [
  { labelEs: 'Cosmología', labelEn: 'Cosmology', queryEs: 'Cosmología', queryEn: 'Cosmology', Icon: Lightbulb },
  { labelEs: 'MIT', labelEn: 'MIT', queryEs: 'Massachusetts Institute of Technology', queryEn: 'Massachusetts Institute of Technology', Icon: Building2 },
  { labelEs: 'CRISPR Cas9', labelEn: 'CRISPR Cas9', queryEs: 'CRISPR Cas9', queryEn: 'CRISPR Cas9', Icon: FileText },
  { labelEs: 'Geoffrey Hinton', labelEn: 'Geoffrey Hinton', queryEs: 'Geoffrey Hinton', queryEn: 'Geoffrey Hinton', Icon: Users },
];

// Every section the palette can paint. `users` has to be in here AND in
// searchRelevance's DEFAULT_SECTION_ORDER: a section the palette renders but
// the ordering module has never heard of scores 99 and sinks to the bottom of
// every search, silently.
const SECTIONS = ['papers', 'users', 'authors', 'institutions', 'topics', 'projects'];

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

const SECTION_ICONS = {
  papers: FileText,
  // `users` is somebody with a PaperTok account; `authors` is whoever wrote a
  // paper, from OpenAlex. Different things, so different icons.
  users: UserRound,
  authors: Users,
  institutions: Building2,
  topics: Lightbulb,
  projects: Briefcase,
};

function lastPathSegment(value) {
  return String(value || '').split('/').pop();
}

function initialOf(name, handle) {
  const source = (name || handle || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

/**
 * Search as an overlay palette rather than a page.
 *
 * Every source the full page queried is still queried, and results keep the
 * same grouping and destinations; what changes is that searching no longer
 * costs you your place in the feed.
 */
export default function SearchCommand({ open, onOpenChange }) {
  const navigate = useNavigate();
  const { isEnglish, language } = useLanguage();
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  // The spend gate, in the palette's own terms. The page has filter pills and
  // only pays for people under the two that render the section; the palette has
  // one view and no pills, so what decides whether the section is going to be
  // painted is simply whether the palette is on screen. A closed palette shows
  // nothing, so it must not spend a Firestore read on anything — including a
  // query still sitting in state from the last time it was open.
  const usersRequested = open;
  const {
    query, setQuery, results, users, userStatus, totalResults,
    isSearching, peoplePending, isStale, hasSearched, searchIssue, reset,
  } = useEntitySearch({ usersRequested });
  const [pendingEntity, setPendingEntity] = useState(null);

  // Both channels, one wait: the external fan-out settles on its own clock and
  // people on theirs, and announcing "no results" while either is still owed an
  // answer is how the palette would end up denying somebody who is about to
  // appear. It is also what holds the paint back until the whole answer exists
  // — see the skeleton and the section gate below.
  const searchPending = isSearching || peoplePending;

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const go = useCallback((path) => {
    onOpenChange(false);
    navigate(path);
  }, [navigate, onOpenChange]);

  const follow = useCallback(async (event, entity) => {
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
        users,
        papers: results.papers,
        authors: results.authors,
        institutions: results.institutions,
        topics: results.topics,
        projects: results.projects,
      }),
    });
    return [...SECTIONS]
      .sort((left, right) => getSearchSectionOrder(left, preferred) - getSearchSectionOrder(right, preferred));
  }, [query, results, users]);

  const renderFollow = (entity) => {
    const following = isFollowing(entity);
    const pending = isFollowPending(entity) || pendingEntity === entity.id;
    return (
      <button
        type="button"
        className={`sc-follow ${following ? 'is-following' : ''}`}
        onClick={(event) => follow(event, entity)}
        disabled={pending}
        aria-pressed={following}
        aria-label={following ? copy.following : copy.follow}
      >
        {pending
          ? <LoaderCircle size={12} className="spinning" />
          : following ? <Check size={12} /> : <Plus size={12} />}
        <span>{following ? copy.following : copy.follow}</span>
      </button>
    );
  };

  // A monogram, the name, the handle — and nothing else. No photo, because the
  // people index deliberately carries none, and no follow button: knowing
  // whether you already follow somebody is one read per row, and the profile
  // this opens is where following lives.
  const userRow = (person) => (
    <CommandItem
      key={person.uid}
      value={`user-${person.uid}`}
      onSelect={() => go(`/public/user/${person.handle}`)}
    >
      <span className="sc-avatar" aria-hidden="true">{initialOf(person.name, person.handle)}</span>
      <span className="sc-label">{person.name || person.handle}</span>
      <span className="sc-meta sc-meta--handle">@{person.handle}</span>
    </CommandItem>
  );

  const sectionItems = { ...results, users };

  const sectionContent = {
    papers: () => results.papers.map(paper => (
      <CommandItem
        key={paper.id}
        value={`paper-${paper.id}`}
        onSelect={() => go(`/explorer/paper/${encodeURIComponent(paper.id)}`)}
      >
        <FileText size={14} className="sc-icon" />
        <span className="sc-label">{paper.title}</span>
        <span className="sc-meta">
          {paper.year || ''}
          {paper.citationCount > 0 ? ` · ${paper.citationCount} ${copy.citations}` : ''}
        </span>
      </CommandItem>
    )),
    users: () => users.map(userRow),
    authors: () => results.authors.map(author => {
      const orcid = author.orcid ? String(author.orcid).replace(/^https?:\/\/orcid\.org\//, '') : '';
      const path = orcid
        ? `/explorer/author/https%3A%2F%2Forcid.org%2F${orcid}`
        : `/explorer/author/${lastPathSegment(author.id)}`;
      return (
        <CommandItem key={author.id} value={`author-${author.id}`} onSelect={() => go(path)}>
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
        onSelect={() => go(`/explorer/institution/${lastPathSegment(institution.id)}`)}
      >
        <Building2 size={14} className="sc-icon" />
        <span className="sc-label">
          {getLocalizedInstitutionName(institution, language) || institution.display_name}
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
        onSelect={() => go(`/explorer/topic/${encodeURIComponent(lastPathSegment(concept.id))}`)}
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
          `/explorer/project/${project.id}`
          + `?name=${encodeURIComponent(project.acronym || project.title)}`
          + `&funder=${encodeURIComponent(project.funder || '')}`,
        )}
      >
        <Briefcase size={14} className="sc-icon" />
        <span className="sc-label">{project.acronym || project.title}</span>
        <span className="sc-meta">{project.funder || ''}</span>
      </CommandItem>
    )),
  };

  // People speak for themselves, in their own line, never through the banner
  // above: that one names the external providers, and a Firestore hiccup
  // announced under somebody else's name is a sentence the palette made up.
  // 'needs-session' and 'unsupported' say nothing at all — the first cannot
  // happen (the palette only mounts with a session) and the second is a demo
  // build without a people index, neither of which is news to anybody.
  const peopleNote = userStatus === 'failed'
    ? copy.peopleFailed
    : userStatus === 'slow' ? copy.peopleSlow : null;

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
   * The index is injected here rather than written into each of the six row
   * renderers: they build plain `CommandItem`s and know nothing about where
   * they sit in the final order, which is decided by `orderedSections` after
   * the fact.
   */
  let enterIndex = 0;
  const renderedSections = orderedSections.map((section) => {
    if (sectionItems[section].length === 0) return null;
    const SectionIcon = SECTION_ICONS[section];
    const headingIndex = Math.min(enterIndex, ENTER_STAGGER_CAP);
    enterIndex += 1;
    const rows = Children.map(sectionContent[section](), (child, offset) => cloneElement(child, {
      className: [child.props.className, 'sc-enter'].filter(Boolean).join(' '),
      style: {
        ...child.props.style,
        '--sc-enter-index': Math.min(enterIndex + offset, ENTER_STAGGER_CAP),
      },
    }));
    enterIndex += sectionItems[section].length;
    return (
      <CommandGroup
        key={section}
        // Rows that still answer the previous query are dimmed rather
        // than passed off as this one's.
        className={isStale ? 'sc-group--stale' : undefined}
        heading={
          <span className="sc-heading sc-enter" style={{ '--sc-enter-index': headingIndex }}>
            <SectionIcon size={11} /> {copy[section]}
          </span>
        }
      >
        {rows}
      </CommandGroup>
    );
  });

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={copy.placeholder} className="sc-sheet">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={copy.placeholder}
        autoFocus
      />

      <CommandList>
        {!query.trim() && (
          <CommandGroup heading={copy.suggested}>
            {SUGGESTIONS.map(item => (
              <CommandItem
                key={item.labelEn}
                value={`suggestion-${item.labelEn}`}
                onSelect={() => setQuery(isEnglish ? item.queryEn : item.queryEs)}
              >
                <item.Icon size={14} className="sc-icon" />
                <span className="sc-label">{isEnglish ? item.labelEn : item.labelEs}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Rows of the real height rather than a lone spinner. The palette now
            waits for every source before painting anything, so the wait needs a
            shape: a spinner over an empty sheet reads as nothing happening, and
            a sheet that fills from nothing shifts everything under the cursor
            when it does. */}
        {searchPending && (
          <div className="sc-skeleton" role="status" aria-label={copy.searching}>
            {[0, 1, 2, 3, 4].map(index => (
              <div className="sc-skeleton-row" key={index}>
                <span className="sc-skeleton-icon" />
                <span className="sc-skeleton-line" />
                <span className="sc-skeleton-meta" />
              </div>
            ))}
          </div>
        )}

        {searchIssue && !searchPending && totalResults > 0 && (
          <div className="sc-status sc-status--warn" role="status">
            <AlertCircle size={14} /> {copy.partial}
          </div>
        )}

        {peopleNote && !searchPending && (
          <div className="sc-status sc-status--warn" role="status">
            <UserRound size={14} /> {peopleNote}
          </div>
        )}

        {hasSearched && !searchPending && totalResults === 0 && (
          <CommandEmpty>{copy.empty}</CommandEmpty>
        )}

        {/* Nothing paints while an answer is still owed. The five external
            sources land in one commit, but people run on their own 400 ms clock
            and used to appear on their own — one section arriving alone, after
            the rest, and pushing them down. The gate covers both channels. */}
        {!searchPending && renderedSections}

        {!query.trim() && (
          <div className="sc-status sc-status--hint">{copy.hint}</div>
        )}
      </CommandList>
    </CommandDialog>
  );
}
