import type { FollowEntity } from '../../utils/following.ts';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT } from '../../utils/motionCurves.ts';
import {
  ArrowLeft,
  Briefcase,
  Buildings,
  CircleNotch,
  Tag,
  User,
  UserMinus,
} from '@phosphor-icons/react';
import { useFollowing } from '../../context/FollowingContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { getFollowedEntityPath } from '../../utils/followingNavigation.ts';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization.ts';
import { Button } from '../ui/button.tsx';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../Onboarding/Petri.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import './FollowingSettingsPage.css';

const FOLLOW_TABS = [
  { type: 'author', label: { en: 'Authors' }, Icon: User },
  { type: 'topic', label: { en: 'Topics' }, Icon: Tag },
  { type: 'institution', label: { en: 'Institutions' }, Icon: Buildings },
  { type: 'project', label: { en: 'Projects' }, Icon: Briefcase },
];

function getFollowDisplayName(entity: FollowEntity) {
  return entity.type === 'institution'
    ? getLocalizedInstitutionName(entity)
    : entity.displayName;
}

function getInitials(name: string) {
  return name
    .split(/[\s-]+/)
    .filter(word => /^\p{L}/u.test(word) && !/^(of|and|for|the|de|la|del)$/i.test(word))
    .slice(0, 2)
    .map(word => word[0].toUpperCase())
    .join('');
}

export default function FollowingSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Reachable from Settings and from the profile's "Siguiendo" counter; back
  // returns to whichever one it was. The fallback covers a direct URL load.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/settings/discovery');
  };
  const { language, locale } = useLanguage();
  const {
    followedEntities,
    followedByType,
    loading,
    isFollowPending,
    toggleFollow,
  } = useFollowing();
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [unfollowing, setUnfollowing] = useState<FollowEntity | null>(null);
  const [unfollowOpen, setUnfollowOpen] = useState(false);
  const isPhone = useIsPhone();

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

  const handleUnfollow = async (entity: FollowEntity) => {
    setActionError('');
    try {
      await toggleFollow(entity);
    } catch {
      const displayName = getFollowDisplayName(entity);
      setActionError(`Could not unfollow ${displayName}.`);
    }
  };

  const askUnfollow = (entity: FollowEntity) => {
    setUnfollowing(entity);
    setUnfollowOpen(true);
  };
  const confirmUnfollow = () => {
    setUnfollowOpen(false);
    if (unfollowing) handleUnfollow(unfollowing);
  };
  const unfollowName = unfollowing ? getFollowDisplayName(unfollowing) : '';
  const unfollowTitle = unfollowing ? `Unfollow "${unfollowName}"?` : 'Unfollow?';
  const unfollowDescription = `${unfollowing?.type === 'author' ? 'Their' : 'Its'} papers will stop shaping your recommendations. You can follow again at any time.`;

  return (
    <main className="following-settings-page">
      <div className="following-settings-shell">
        <Button
          variant="ghost"
          size="icon"
          className="following-settings-back"
          onClick={goBack}
          aria-label={'Back'}
          title={'Back'}
        >
          <ArrowLeft size={18} />
        </Button>
        <header className="following-settings-heading">
          <h1>{'Follows'}</h1>
          <p>
            {loading && followedEntities.length === 0
              ? 'Loading what you follow...'
              : `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`}
          </p>
        </header>
        <div className="following-settings-layout">
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
                  <Icon size={18} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
                  <span>{label[language]}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </nav>

          <div className="following-settings-content">
            {loading && followedEntities.length === 0 ? (
              <div className="following-settings-loading" role="status">
                <CircleNotch size={24} />
                <span>
                  {'Loading'} {activeTab.label[language].toLowerCase()}...
                </span>
              </div>
            ) : visibleEntities.length > 0 ? (
              <section
                key={activeType}
                className="following-settings-list"
                aria-label={activeTab.label[language]}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {visibleEntities.map((entity) => {
                    const pending = isFollowPending(entity);
                    const displayName = getFollowDisplayName(entity);
                    return (
                      <motion.article
                        layout
                        key={entity.followKey || `${entity.type}:${entity.canonicalId}`}
                        className="following-settings-item"
                        exit={{ opacity: 0, transform: 'translateX(18px)' }}
                        transition={{ duration: 0.16, ease: EASE_OUT }}
                      >
                        <Link to={getFollowedEntityPath(entity)} className="following-settings-link">
                          <span className={`following-settings-initials is-${entity.type}`} aria-hidden="true">
                            {getInitials(displayName)}
                          </span>
                          <span className="following-settings-entity-name">{displayName}</span>
                        </Link>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="following-settings-unfollow"
                          disabled={pending}
                          onClick={() => askUnfollow(entity)}
                          aria-label={`${'Unfollow'} ${displayName}`}
                          title={'Unfollow'}
                        >
                          {pending
                            ? <CircleNotch size={16} aria-hidden="true" />
                            : <UserMinus size={16} aria-hidden="true" />}
                        </Button>
                      </motion.article>
                    );
                  })}
                </AnimatePresence>
              </section>
            ) : (
              <section className="following-settings-empty">
                <EmptyState
                  art={<Petri pose="compass" className="following-settings-empty-petri" />}
                  title={'Nothing followed here yet'}
                  actions={(
                    <Button size="sm" onClick={() => navigate('/search')}>
                      {'Explore PaperTok'}
                    </Button>
                  )}
                >
                  {'What you follow shows up here and shapes your feed.'}
                </EmptyState>
              </section>
            )}
            <p className="following-settings-feedback" role="status" aria-live="polite">
              {actionError}
            </p>
          </div>
        </div>
      </div>

      {isPhone ? (
        <Drawer
          open={unfollowOpen}
          onOpenChange={setUnfollowOpen}
          onOpenChangeComplete={(isOpen) => { if (!isOpen) setUnfollowing(null); }}
        >
          <DrawerContent className="pc-share-sheet">
            <DrawerHandle />
            <div className="following-unfollow-sheet">
              <Petri pose="letGo" className="following-unfollow-petri" />
              <DrawerTitle render={<h3 />} className="following-unfollow-title">{unfollowTitle}</DrawerTitle>
              <p className="following-unfollow-description">{unfollowDescription}</p>
              <div className="following-unfollow-actions">
                <DrawerClose render={<Button variant="outline" />}>{'Cancel'}</DrawerClose>
                <Button onClick={confirmUnfollow}>{'Unfollow'}</Button>
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <AlertDialog
          open={unfollowOpen}
          onOpenChange={setUnfollowOpen}
          onOpenChangeComplete={(isOpen) => { if (!isOpen) setUnfollowing(null); }}
        >
          <AlertDialogContent className="following-unfollow-dialog">
            <Petri pose="letGo" className="following-unfollow-petri" />
            <AlertDialogTitle>{unfollowTitle}</AlertDialogTitle>
            <AlertDialogDescription>{unfollowDescription}</AlertDialogDescription>
            <div className="following-unfollow-actions">
              <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
              <Button onClick={confirmUnfollow}>{'Unfollow'}</Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </main>
  );
}
