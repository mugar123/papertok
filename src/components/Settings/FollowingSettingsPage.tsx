import type { FollowEntity } from '../../utils/following.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT } from '../../utils/motionCurves.ts';
import {
  ArrowLeft,
  Briefcase,
  Buildings,
  CaretDown,
  CaretLeft,
  Check,
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
import './SettingsSheet.css';
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

/**
 * What the page and the phone sheet share: the type on show, its follows in
 * order, and an unfollow that asks first.
 */
function useFollowedView() {
  const { language, locale } = useLanguage();
  const following = useFollowing();
  const { followedByType, toggleFollow } = following;
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [unfollowing, setUnfollowing] = useState<FollowEntity | null>(null);
  const [unfollowOpen, setUnfollowOpen] = useState(false);

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

  return {
    ...following,
    language,
    activeType,
    activeTab,
    setSelectedType,
    visibleEntities,
    actionError,
    askUnfollow,
    unfollowing,
    setUnfollowing,
    unfollowOpen,
    setUnfollowOpen,
    confirmUnfollow,
  };
}

type FollowedView = ReturnType<typeof useFollowedView>;

function followSummary({ loading, followedEntities }: FollowedView) {
  if (loading && followedEntities.length === 0) return 'Loading what you follow...';
  return `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`;
}

/** The follows of the type on show, or its loading or empty state. */
function FollowedList({ view, onExplore }: { view: FollowedView; onExplore: () => void }) {
  const { activeType, activeTab, language, loading, followedEntities, visibleEntities, isFollowPending, askUnfollow, actionError } = view;
  return (
    <>
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
              <Button size="sm" onClick={onExplore}>
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
    </>
  );
}

/**
 * The question before an unfollow: a drawer on a phone, an alert dialog
 * wider than that. Inside the phone sheet the drawer stacks on the sheet,
 * which keeps its list and its scroll behind it.
 */
function UnfollowConfirm({ view }: { view: FollowedView }) {
  const { unfollowing, unfollowOpen, setUnfollowOpen, setUnfollowing, confirmUnfollow } = view;
  const isPhone = useIsPhone();
  const unfollowName = unfollowing ? getFollowDisplayName(unfollowing) : '';
  const unfollowTitle = unfollowing ? `Unfollow "${unfollowName}"?` : 'Unfollow?';
  const unfollowDescription = `${unfollowing?.type === 'author' ? 'Their' : 'Its'} papers will stop shaping your recommendations. You can follow again at any time.`;

  return isPhone ? (
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
  );
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
  const view = useFollowedView();
  const { language, followedByType, activeType, setSelectedType } = view;

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
          <p>{followSummary(view)}</p>
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
            <FollowedList view={view} onExplore={() => navigate('/search')} />
          </div>
        </div>
      </div>

      <UnfollowConfirm view={view} />
    </main>
  );
}

/**
 * The same follows, opened from Settings on a phone: a sheet like the
 * interests editor, whose switcher swaps the follows for the four types
 * inside the same sheet. SettingsPage keeps it mounted and drives `open`.
 */
export function FollowingSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const view = useFollowedView();
  const { language, followedByType, activeType, activeTab, setSelectedType } = view;
  const [typesOpen, setTypesOpen] = useState(false);
  // Whether the sheet has changed page since it opened: the page it opens on
  // arrives with the sheet, every later one slides in (SettingsSheet.css).
  const [moved, setMoved] = useState(false);
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const pickedType = useRef(false);

  useEffect(() => {
    if (typesOpen) backRef.current?.focus();
    else if (pickedType.current) switcherRef.current?.focus();
    pickedType.current = false;
  }, [typesOpen]);

  const leaveTypes = () => {
    pickedType.current = true;
    setTypesOpen(false);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        setTypesOpen(false);
        setMoved(false);
      }}
    >
      <DrawerContent className="settings-sheet is-tall" overlayClassName="settings-sheet-backdrop">
        <DrawerHandle />
        {typesOpen ? (
          <div key="types" className="settings-sheet-view" data-direction="forward">
            <div className="settings-sheet-choices-head">
              <Button ref={backRef} variant="ghost" size="icon-sm" aria-label={'Back to follows'} onClick={leaveTypes}>
                <CaretLeft size={18} aria-hidden="true" />
              </Button>
              <DrawerTitle render={<h2 />}>{'Types of followed content'}</DrawerTitle>
            </div>
            <ul className="settings-sheet-choices" data-base-ui-swipe-ignore="">
              {FOLLOW_TABS.map(({ type, label, Icon }) => {
                const count = followedByType[type]?.length || 0;
                const isActive = type === activeType;
                return (
                  <li key={type}>
                    <button
                      type="button"
                      className={isActive ? 'is-active' : undefined}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => { setSelectedType(type); leaveTypes(); }}
                    >
                      <Icon size={20} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                      <span className="settings-sheet-choice-copy">
                        <strong>{label[language]}</strong>
                        <small>{`${count} followed`}</small>
                      </span>
                      {isActive && <Check size={16} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div key="follows" className="settings-sheet-view" data-direction={moved ? 'back' : undefined}>
            <div className="settings-sheet-head">
              <DrawerTitle render={<h2 />}>{'Follows'}</DrawerTitle>
              <p>{followSummary(view)}</p>
              <button
                ref={switcherRef}
                type="button"
                className="settings-sheet-switcher"
                onClick={() => { setTypesOpen(true); setMoved(true); }}
              >
                <span className="settings-sheet-switcher-icon"><activeTab.Icon size={18} weight="fill" aria-hidden="true" /></span>
                <span className="settings-sheet-switcher-copy">
                  <small>{'Type'}</small>
                  <strong>{`${activeTab.label[language]} · ${followedByType[activeType]?.length || 0}`}</strong>
                </span>
                <CaretDown size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="settings-sheet-body" data-base-ui-swipe-ignore="">
              <FollowedList view={view} onExplore={() => navigate('/search')} />
            </div>
          </div>
        )}
        <UnfollowConfirm view={view} />
      </DrawerContent>
    </Drawer>
  );
}
