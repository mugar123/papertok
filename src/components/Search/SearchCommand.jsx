import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { resolvePreferredSearchSection, getSearchSectionOrder } from '../../utils/searchRelevance';
import './SearchCommand.css';

const COPY = {
  es: {
    placeholder: 'Busca papers, autores, temas, instituciones, proyectos...',
    papers: 'Papers',
    authors: 'Autores',
    institutions: 'Instituciones',
    topics: 'Temas',
    projects: 'Proyectos',
    empty: 'Sin resultados',
    searching: 'Buscando...',
    hint: 'Escribe para buscar en papers, autores, temas, instituciones y proyectos financiados.',
    suggested: 'Sugerencias',
    partial: 'Algunas fuentes no respondieron; se muestra lo disponible.',
    follow: 'Seguir',
    following: 'Siguiendo',
    citations: 'citas',
    works: 'trabajos',
  },
  en: {
    placeholder: 'Search papers, authors, topics, institutions, projects...',
    papers: 'Papers',
    authors: 'Authors',
    institutions: 'Institutions',
    topics: 'Topics',
    projects: 'Projects',
    empty: 'No results',
    searching: 'Searching...',
    hint: 'Type to search papers, authors, topics, institutions and funded projects.',
    suggested: 'Suggestions',
    partial: 'Some sources did not answer; showing what is available.',
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

const SECTION_ICONS = {
  papers: FileText,
  authors: Users,
  institutions: Building2,
  topics: Lightbulb,
  projects: Briefcase,
};

function lastPathSegment(value) {
  return String(value || '').split('/').pop();
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
  const { query, setQuery, results, totalResults, isSearching, hasSearched, searchIssue, reset } = useEntitySearch();
  const [pendingEntity, setPendingEntity] = useState(null);

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
    const preferred = resolvePreferredSearchSection(query, {
      papers: results.papers,
      authors: results.authors,
      institutions: results.institutions,
      topics: results.topics,
      projects: results.projects,
    });
    return ['papers', 'authors', 'institutions', 'topics', 'projects']
      .sort((left, right) => getSearchSectionOrder(left, preferred) - getSearchSectionOrder(right, preferred));
  }, [query, results]);

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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={copy.placeholder}>
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

        {isSearching && (
          <div className="sc-status" role="status">
            <LoaderCircle size={14} className="spinning" /> {copy.searching}
          </div>
        )}

        {searchIssue && !isSearching && totalResults > 0 && (
          <div className="sc-status sc-status--warn" role="status">
            <AlertCircle size={14} /> {copy.partial}
          </div>
        )}

        {hasSearched && !isSearching && totalResults === 0 && (
          <CommandEmpty>{copy.empty}</CommandEmpty>
        )}

        {orderedSections.map(section => {
          if (results[section].length === 0) return null;
          const SectionIcon = SECTION_ICONS[section];
          return (
            <CommandGroup
              key={section}
              heading={
                <span className="sc-heading">
                  <SectionIcon size={11} /> {copy[section]}
                </span>
              }
            >
              {sectionContent[section]()}
            </CommandGroup>
          );
        })}

        {!query.trim() && (
          <div className="sc-status sc-status--hint">{copy.hint}</div>
        )}
      </CommandList>
    </CommandDialog>
  );
}
