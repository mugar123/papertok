import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Briefcase,
  Buildings,
  CaretRight,
  CircleNotch,
  Compass,
  Tag,
  User,
  UserMinus,
} from '@phosphor-icons/react';
import { useFollowing } from '../../context/FollowingContext';
import { useLanguage } from '../../context/LanguageContext';
import { getFollowedEntityPath } from '../../utils/followingNavigation';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import SettingsSubheader from './SettingsSubheader.jsx';
import { SETTINGS_BREADCRUMB } from './settingsBreadcrumb.js';
import './FollowingSettingsPage.css';

const FOLLOW_TABS = [
  { type: 'author', label: { en: 'Authors' }, singular: { en: 'author' }, Icon: User },
  { type: 'topic', label: { en: 'Topics' }, singular: { en: 'topic' }, Icon: Tag },
  { type: 'institution', label: { en: 'Institutions' }, singular: { en: 'institution' }, Icon: Buildings },
  { type: 'project', label: { en: 'Projects' }, singular: { en: 'project' }, Icon: Briefcase },
];

const SOURCE_LABELS = {
  openalex: 'OpenAlex',
  openaire: 'OpenAIRE',
  papertok: 'PaperTok',
  legacy: 'Perfil anterior',
};

function getFollowDisplayName(entity) {
  return entity.type === 'institution'
    ? getLocalizedInstitutionName(entity)
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
  const { language, locale } = useLanguage();
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
        getFollowDisplayName(left)
          .localeCompare(getFollowDisplayName(right), locale)
      )),
    [activeType, followedByType, locale],
  );

  const handleUnfollow = async (entity) => {
    setActionError('');
    try {
      await toggleFollow(entity);
    } catch {
      const displayName = getFollowDisplayName(entity);
      setActionError(`Could not unfollow ${displayName}.`);
    }
  };

  return (
    <main className="following-settings-page">
      <div className="following-settings-shell">
        <SettingsSubheader
          eyebrow={SETTINGS_BREADCRUMB.en}
          title={'What you follow'}
          subtitle={loading && followedEntities.length === 0
            ? ('Loading what you follow...')
            : `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`}
          backLabel={'Back'}
          onBack={goBack}
        />

        <nav className="following-settings-tabs" aria-label={'Types of followed content'}>
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
            <CircleNotch size={24} />
            <span>
              {'Loading'} {activeTab.label[language].toLowerCase()}...
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
                const displayName = getFollowDisplayName(entity);
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
                      <CaretRight size={18} aria-hidden="true" />
                    </Link>
                    <button
                      type="button"
                      className="following-settings-unfollow"
                      disabled={pending}
                      onClick={() => handleUnfollow(entity)}
                      aria-label={`${'Unfollow'} ${displayName}`}
                      title={`${'Unfollow'} ${displayName}`}
                    >
                      {pending ? <CircleNotch size={18} /> : <UserMinus size={18} />}
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
              {`You are not following any ${activeTab.singular.en}s`}
            </h2>
            <p>{'Anything you follow will appear here and help personalize your feeds.'}</p>
            <button type="button" onClick={() => navigate('/search')}>
              {'Explore PaperTok'}
            </button>
          </motion.section>
        )}
      </div>
    </main>
  );
}
