/* eslint-disable react-refresh/only-export-components */
import { Briefcase, FileText, SearchX, Users } from 'lucide-react';
import { Button } from '../ui/button.jsx';

export { pickEmptyVariant } from './explorerEmptyVariant.js';

// Copy for every non-error variant, as [title, body, action label] per
// language. 'error' is handled separately below because its body is a
// runtime message, not a fixed string.
const COPY = {
  filtered: {
    en: ['Nothing matches these filters', 'Loosen the search or the filters to see the full list again.', 'Clear filters'],
    es: ['Nada coincide con estos filtros', 'Afloja la búsqueda o los filtros para volver a ver la lista completa.', 'Quitar filtros'],
  },
  'project-unindexed': {
    en: ['OpenAIRE has not linked publications to this project yet', 'Projects are indexed with some delay. Papers that acknowledge this grant will appear here once OpenAIRE links them.', 'View on OpenAIRE'],
    es: ['OpenAIRE aún no enlaza publicaciones con este proyecto', 'Los proyectos se indexan con retraso. Los artículos que citan esta financiación aparecerán aquí cuando OpenAIRE los enlace.', 'Ver en OpenAIRE'],
  },
  none: {
    en: ['No publications here', 'Nothing to show for this entity yet.', null],
    es: ['No hay publicaciones', 'Todavía no hay nada que mostrar para esta entidad.', null],
  },
  authors: {
    en: ['No authors matched your search', 'Try a different spelling, or clear the search to see everyone on this entity.', null],
    es: ['Ningún autor coincide con tu búsqueda', 'Prueba otra grafía, o limpia la búsqueda para ver a todos.', null],
  },
};

export function ExplorerEmptyState({ variant, isEnglish, onClearFilters, onRetry, errorMessage, openAireUrl }) {
  const lang = isEnglish ? 'en' : 'es';

  if (variant === 'error') {
    return (
      <div className="explorer-empty" role="alert">
        <span className="explorer-empty-icon"><FileText size={22} /></span>
        <h3 className="explorer-empty-title">{isEnglish ? 'The publications could not be loaded' : 'No se pudieron cargar las publicaciones'}</h3>
        <p className="explorer-empty-body">{errorMessage}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
      </div>
    );
  }

  const Icon = variant === 'filtered' ? SearchX : variant === 'project-unindexed' ? Briefcase : variant === 'authors' ? Users : FileText;
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
