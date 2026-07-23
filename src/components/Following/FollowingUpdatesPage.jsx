import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  BellRing,
  BookOpen,
  Building2,
  CheckCheck,
  Clock3,
  FolderKanban,
  RefreshCw,
  Sparkles,
  Tag,
  UserRound,
} from 'lucide-react';
import { useFollowing } from '../../context/FollowingContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useFeed } from '../../context/FeedContext';
import { getFollowingUpdatePaperKey } from '../../utils/followingUpdates';
import './FollowingUpdatesPage.css';

const TYPE_CONFIG = {
  author: { label: 'Autores', singular: 'Autor', Icon: UserRound },
  topic: { label: 'Temas', singular: 'Tema', Icon: Tag },
  institution: { label: 'Instituciones', singular: 'Institución', Icon: Building2 },
  project: { label: 'Proyectos', singular: 'Proyecto', Icon: FolderKanban },
};

function formatPaperDate(paper) {
  const value = paper.published || paper.publishedDate || (paper.year ? `${paper.year}-01-01` : '');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return paper.year || 'Fecha no disponible';
  const days = Math.max(0, Math.floor((Date.now() - time) / 86400000));
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  if (days < 30) return `Hace ${days} días`;
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(time);
}

function formatAuthors(authors = []) {
  const names = authors.map(author => author?.name || author?.display_name || author).filter(Boolean);
  if (!names.length) return 'Autoría no disponible';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} y ${names.length - 2} más`;
}

function entityPath(match) {
  return `/explorer/${match.type}/${encodeURIComponent(match.canonicalId)}`;
}

export default function FollowingUpdatesPage({ onOpenPdf }) {
  const navigate = useNavigate();
  const { followedEntities } = useFollowing();
  const {
    items,
    seenIds,
    unreadCount,
    loading,
    refreshing,
    error,
    meta,
    lastUpdatedAt,
    refresh,
    markSeen,
    markAllSeen,
  } = useFollowingUpdates();
  const { personalLibrary, toggleReadLater } = useFeed();
  const [activeType, setActiveType] = useState('all');

  const availableTypes = useMemo(() => Object.keys(TYPE_CONFIG).filter(type => (
    followedEntities.some(entity => entity.type === type)
  )), [followedEntities]);

  const visibleItems = useMemo(() => {
    if (activeType === 'all') return items;
    return items.filter(paper => paper._followedEntityMatches?.some(match => match.type === activeType));
  }, [activeType, items]);

  const lastUpdatedLabel = lastUpdatedAt
    ? new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(lastUpdatedAt))
    : null;

  const openPaper = (paper) => {
    markSeen(paper);
    onOpenPdf(paper);
  };

  return (
    <main className="following-updates-page">
      <header className="following-updates-header">
        <div>
          <span className="following-updates-eyebrow"><BellRing size={15} /> NOVEDADES SEGUIDAS</span>
          <h1>Tu radar científico</h1>
          <p>Publicaciones recientes de los autores, temas, instituciones y proyectos que sigues.</p>
        </div>
        <div className="following-updates-actions">
          {unreadCount > 0 && (
            <button className="following-updates-secondary" onClick={markAllSeen}>
              <CheckCheck size={18} /> Marcar todo como visto
            </button>
          )}
          <button
            className="following-updates-refresh"
            onClick={() => refresh()}
            disabled={refreshing}
            title="Buscar novedades"
          >
            <RefreshCw size={19} className={refreshing ? 'is-spinning' : ''} />
            <span>Actualizar</span>
          </button>
        </div>
      </header>

      <section className="following-updates-toolbar" aria-label="Filtros de novedades">
        <div className="following-updates-filters">
          <button
            className={activeType === 'all' ? 'is-active' : ''}
            onClick={() => setActiveType('all')}
          >
            Todo <span>{items.length}</span>
          </button>
          {availableTypes.map((type) => {
            const { label, Icon } = TYPE_CONFIG[type];
            const count = items.filter(paper => paper._followedEntityMatches?.some(match => match.type === type)).length;
            return (
              <button
                key={type}
                className={activeType === type ? 'is-active' : ''}
                onClick={() => setActiveType(type)}
              >
                <Icon size={15} /> {label} <span>{count}</span>
              </button>
            );
          })}
        </div>
        <p className="following-updates-status">
          {unreadCount > 0 ? <strong>{unreadCount} sin ver</strong> : 'Todo al día'}
          {lastUpdatedLabel ? ` · Actualizado a las ${lastUpdatedLabel}` : ''}
        </p>
      </section>

      {loading && items.length === 0 && (
        <section className="following-updates-loading" aria-live="polite">
          <div className="following-updates-loader"><Sparkles size={20} /></div>
          <div><strong>Buscando novedades</strong><span>Consultando tus seguimientos...</span></div>
        </section>
      )}

      {!loading && followedEntities.length === 0 && (
        <section className="following-updates-empty">
          <BellRing size={28} />
          <h2>Tu bandeja todavía está vacía</h2>
          <p>Sigue un tema desde cualquier paper, o un autor, institución o proyecto desde su página.</p>
          <button onClick={() => navigate('/')}>Descubrir papers</button>
        </section>
      )}

      {!loading && followedEntities.length > 0 && visibleItems.length === 0 && (
        <section className="following-updates-empty">
          <CheckCheck size={28} />
          <h2>No hay novedades en este filtro</h2>
          <p>La bandeja recoge publicaciones del último año y se actualizará cuando aparezcan trabajos nuevos.</p>
          {activeType !== 'all' && <button onClick={() => setActiveType('all')}>Ver todas</button>}
        </section>
      )}

      {error && items.length === 0 && (
        <section className="following-updates-error">
          <p>No se han podido consultar las novedades en este momento.</p>
          <button onClick={() => refresh()}>Reintentar</button>
        </section>
      )}

      {visibleItems.length > 0 && (
        <motion.section
          className="following-updates-list"
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.045 } } }}
        >
          {visibleItems.map((paper) => {
            const paperKey = getFollowingUpdatePaperKey(paper);
            const isUnread = !seenIds.has(paperKey);
            const isReadLater = Boolean(personalLibrary[paper.id]?.readLater);
            return (
              <motion.article
                key={paperKey}
                className={`following-update-row ${isUnread ? 'is-unread' : ''}`}
                variants={{
                  hidden: { opacity: 0, y: 12 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
                }}
                onClick={() => openPaper(paper)}
              >
                <span className="following-update-unread-dot" aria-label={isUnread ? 'Sin ver' : 'Visto'} />
                <div className="following-update-main">
                  <div className="following-update-matches">
                    {(paper._followedEntityMatches || []).map((match) => {
                      const config = TYPE_CONFIG[match.type] || TYPE_CONFIG.topic;
                      const Icon = config.Icon;
                      return (
                        <button
                          key={`${match.type}:${match.canonicalId}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(entityPath(match));
                          }}
                          title={`Ver ${config.singular.toLowerCase()}`}
                        >
                          <Icon size={13} />
                          <span>{match.displayName}</span>
                        </button>
                      );
                    })}
                  </div>
                  <h2>{paper.title}</h2>
                  <p className="following-update-authors">{formatAuthors(paper.authors)}</p>
                  <div className="following-update-meta">
                    <span>{formatPaperDate(paper)}</span>
                    {paper.journal && <span>{paper.journal}</span>}
                    {(paper.citationCountKnown || paper.citationCount > 0) && <span>{paper.citationCount || 0} citas</span>}
                    {paper.openAccess && <span className="is-open">Acceso abierto</span>}
                  </div>
                </div>
                <div className="following-update-actions">
                  <button
                    className={isReadLater ? 'is-saved' : ''}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleReadLater(paper);
                    }}
                    title={isReadLater ? 'Quitar de leer después' : 'Leer después'}
                  >
                    <Clock3 size={18} />
                  </button>
                  <button
                    className="following-update-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      openPaper(paper);
                    }}
                  >
                    <BookOpen size={17} /> Abrir
                  </button>
                </div>
              </motion.article>
            );
          })}
        </motion.section>
      )}

      {meta.failedEntities > 0 && items.length > 0 && (
        <p className="following-updates-partial">
          Algunas fuentes no respondieron. Se muestran las novedades disponibles y puedes volver a actualizar.
        </p>
      )}
    </main>
  );
}
