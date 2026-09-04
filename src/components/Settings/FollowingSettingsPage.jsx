import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Building2,
  BriefcaseBusiness,
  ChevronRight,
  Compass,
  LoaderCircle,
  Tag,
  UserMinus,
  UserRound,
} from 'lucide-react';
import { useFollowing } from '../../context/FollowingContext';
import { useLanguage } from '../../context/LanguageContext';
import { getFollowedEntityPath } from '../../utils/followingNavigation';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import SettingsSubheader from './SettingsSubheader.jsx';
import { SETTINGS_BREADCRUMB } from './settingsBreadcrumb.js';
import './FollowingSettingsPage.css';

const FOLLOW_TABS = [
  { type: 'author', label: { es: 'Autores', en: 'Authors' }, singular: { es: 'autor', en: 'author' }, Icon: UserRound },
  { type: 'topic', label: { es: 'Temas', en: 'Topics' }, singular: { es: 'tema', en: 'topic' }, Icon: Tag },
  { type: 'institution', label: { es: 'Instituciones', en: 'Institutions' }, singular: { es: 'institución', en: 'institution' }, Icon: Building2 },
  { type: 'project', label: { es: 'Proyectos', en: 'Projects' }, singular: { es: 'proyecto', en: 'project' }, Icon: BriefcaseBusiness },
];

const SOURCE_LABELS = {
  openalex: 'OpenAlex',
  openaire: 'OpenAIRE',
  papertok: 'PaperTok',
  legacy: 'Perfil anterior',
};

function getFollowDisplayName(entity, language) {
  return entity.type === 'institution'
    ? getLocalizedInstitutionName(entity, language)
    : entity.displayName;
}

export default function FollowingSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Reachable from Settings and from the profile's "Siguiendo" counter; back
  // returns to whichever one it was. The fallback covers a direct URL load.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/settings');
  };
  const { language, isEnglish, locale } = useLanguage();
  const {
    followedEntities,
    followedByType,
    loading,
    isFollowPending,
    toggleFollow,
  } = useFollowing();
  const [selectedType, setSelectedType] = useState(null);
  const [actionError, setActionError] = useState('');

  const activeType = selectedType
    || FOLLOW_TABS.find(tab => followedByType[tab.type]?.length > 0)?.type
    || 'author';
  const activeTab = FOLLOW_TABS.find(tab => tab.type === activeType) || FOLLOW_TABS[0];
  const visibleEntities = useMemo(
    () => [...(followedByType[activeType] || [])]
      .sort((left, right) => (
        getFollowDisplayName(left, language)
          .localeCompare(getFollowDisplayName(right, language), locale)
      )),
    [activeType, followedByType, language, locale],
  );

  const handleUnfollow = async (entity) => {
    setActionError('');
    try {
      await toggleFollow(entity);
    } catch {
      const displayName = getFollowDisplayName(entity, language);
      setActionError(isEnglish
        ? `Could not unfollow ${displayName}.`
        : `No se pudo dejar de seguir a ${displayName}.`);
    }
  };

  return (
    <main className="following-settings-page">
      <div className="following-settings-shell">
        <SettingsSubheader
          eyebrow={SETTINGS_BREADCRUMB[isEnglish ? 'en' : 'es']}
          title={isEnglish ? 'What you follow' : 'Lo que sigues'}
          subtitle={loading && followedEntities.length === 0
            ? (isEnglish ? 'Loading what you follow...' : 'Cargando tus seguimientos...')
            : isEnglish
              ? `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`
              : `${followedEntities.length} ${followedEntities.length === 1 ? 'seguimiento influye' : 'seguimientos influyen'} en tus recomendaciones.`}
          backLabel={isEnglish ? 'Back' : 'Volver'}
          onBack={goBack}
        />

        <nav className="following-settings-tabs" aria-label={isEnglish ? 'Types of followed content' : 'Tipos de contenido seguido'}>
          {FOLLOW_TABS.map(({ type, label, Icon }) => {
            const count = followedByType[type]?.length || 0;
            const active = activeType === type;
            return (
              <button
                key={type}
                type="button"
                className={active ? 'is-active' : ''}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSelectedType(type)}
              >
                <Icon size={18} />
                <span>{label[language]}</span>
                <small>{count}</small>
              </button>
            );
          })}
        </nav>

        <p className="following-settings-feedback" role="status" aria-live="polite">
          {actionError}
        </p>

        {loading && followedEntities.length === 0 ? (
          <div className="following-settings-loading" role="status">
            <LoaderCircle size={24} />
            <span>
              {isEnglish ? 'Loading' : 'Cargando'} {activeTab.label[language].toLowerCase()}...
            </span>
          </div>
        ) : visibleEntities.length > 0 ? (
          <motion.section
            key={activeType}
            className="following-settings-list"
            aria-label={activeTab.label[language]}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {visibleEntities.map((entity) => {
                const Icon = activeTab.Icon;
                const pending = isFollowPending(entity);
                const displayName = getFollowDisplayName(entity, language);
                return (
                  <motion.article
                    layout
                    key={entity.followKey || `${entity.type}:${entity.canonicalId}`}
                    className="following-settings-item"
                    initial={{ opacity: 0, y: 7 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 18, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Link to={getFollowedEntityPath(entity)} className="following-settings-link">
                      <span className={`following-settings-entity-icon is-${entity.type}`}>
                        <Icon size={20} />
                      </span>
                      <span className="following-settings-entity-copy">
                        <strong>{displayName}</strong>
                        <small>
                          {activeTab.singular[language].charAt(0).toUpperCase() + activeTab.singular[language].slice(1)}
                          {' · '}
                          {SOURCE_LABELS[entity.source] || 'PaperTok'}
                        </small>
                      </span>
                      <ChevronRight size={18} aria-hidden="true" />
                    </Link>
                    <button
                      type="button"
                      className="following-settings-unfollow"
                      disabled={pending}
                      onClick={() => handleUnfollow(entity)}
                      aria-label={`${isEnglish ? 'Unfollow' : 'Dejar de seguir'} ${displayName}`}
                      title={`${isEnglish ? 'Unfollow' : 'Dejar de seguir'} ${displayName}`}
                    >
                      {pending ? <LoaderCircle size={18} /> : <UserMinus size={18} />}
                    </button>
                  </motion.article>
                );
              })}
            </AnimatePresence>
          </motion.section>
        ) : (
          <motion.section
            key={`empty-${activeType}`}
            className="following-settings-empty"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Compass size={28} />
            <h2>
              {isEnglish
                ? `You are not following any ${activeTab.singular.en}s`
                : `No sigues ningún ${activeTab.singular.es}`}
            </h2>
            <p>{isEnglish
              ? 'Anything you follow will appear here and help personalize your feeds.'
              : 'Los que sigas aparecerán aquí y ayudarán a personalizar tus feeds.'}</p>
            <button type="button" onClick={() => navigate('/search')}>
              {isEnglish ? 'Explore PaperTok' : 'Explorar PaperTok'}
            </button>
          </motion.section>
        )}
      </div>
    </main>
  );
}
