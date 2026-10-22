import type { FollowEntity } from '../../utils/following.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
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
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select.tsx';
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

// How long Petri's balloon rises before the question leaves; it keeps
// drifting off while the drawer goes (Petri.css, petriBalloonAway).
const RELEASE_MS = 280;

/**
 * What the page and the phone sheet share: the type on show, its follows in
 * order, and an unfollow that asks first. Confirming lets go of Petri's
 * balloon, closes the question, and unfollows once it has gone, so the row
 * leaves in sight of the list it returns to; a toast offers Undo.
 */
function useFollowedView() {
  const { language, locale } = useLanguage();
  const following = useFollowing();
  const { followedByType } = following;
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [unfollowing, setUnfollowing] = useState<FollowEntity | null>(null);
  const [unfollowOpen, setUnfollowOpen] = useState(false);
  const [released, setReleased] = useState(false);
  const releaseTimer = useRef<number | undefined>(undefined);
  const reduceMotion = useReducedMotion();
  // Undo runs renders later, when this render's toggleFollow and isFollowing
  // close over follows that no longer hold.
  const latest = useRef(following);
  useEffect(() => {
    latest.current = following;
  });
  useEffect(() => () => clearTimeout(releaseTimer.current), []);

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
    const displayName = getFollowDisplayName(entity);
    try {
      await latest.current.toggleFollow(entity);
    } catch {
      setActionError(`Could not unfollow ${displayName}.`);
      return;
    }
    toast(`Unfollowed ${displayName}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          if (latest.current.isFollowing(entity)) return;
          latest.current.toggleFollow(entity).catch(() => toast.error(`Could not follow ${displayName} again`));
        },
      },
    });
  };

  const askUnfollow = (entity: FollowEntity) => {
    setUnfollowing(entity);
    setUnfollowOpen(true);
  };
  const confirmUnfollow = () => {
    if (released) return;
    setReleased(true);
    releaseTimer.current = window.setTimeout(() => setUnfollowOpen(false), reduceMotion ? 0 : RELEASE_MS);
  };
  const finishUnfollow = (isOpen: boolean) => {
    if (isOpen) return;
    if (released && unfollowing) handleUnfollow(unfollowing);
    setReleased(false);
    setUnfollowing(null);
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
    unfollowOpen,
    setUnfollowOpen,
    released,
    confirmUnfollow,
    finishUnfollow,
  };
}

type FollowedView = ReturnType<typeof useFollowedView>;

function followSummary({ loading, followedEntities }: FollowedView) {
  if (loading && followedEntities.length === 0) return 'Loading what you follow...';
  return `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`;
}

/** The follows of the type on show, or its loading or empty state. */
function FollowedList({ view, onExplore, onOpenEntity }: { view: FollowedView; onExplore: () => void; onOpenEntity?: (path: string) => void }) {
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
          {/* Two beats, never two rows in one place: a row leaves where it
              stands and the list then closes up; one that comes back (Undo)
              waits for the list to open its place. */}
          <AnimatePresence initial={false}>
            {visibleEntities.map((entity) => {
              const pending = isFollowPending(entity);
              const displayName = getFollowDisplayName(entity);
              const entityPath = getFollowedEntityPath(entity);
              return (
                <motion.article
                  layout
                  key={entity.followKey || `${entity.type}:${entity.canonicalId}`}
                  className="following-settings-item"
                  initial={{ opacity: 0, transform: 'translateX(32px)' }}
                  animate={{ opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.24, delay: 0.2, ease: EASE_OUT } }}
                  exit={{ opacity: 0, transform: 'translateX(32px)' }}
                  transition={{ duration: 0.24, ease: EASE_OUT }}
                >
                  <Link
                    to={entityPath}
                    className="following-settings-link"
                    onClick={onOpenEntity && ((event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      onOpenEntity(entityPath);
                    })}
                  >
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
  const { unfollowing, unfollowOpen, setUnfollowOpen, released, confirmUnfollow, finishUnfollow } = view;
  const isPhone = useIsPhone();
  const unfollowName = unfollowing ? getFollowDisplayName(unfollowing) : '';
  const unfollowTitle = unfollowing ? `Unfollow "${unfollowName}"?` : 'Unfollow?';
  const unfollowDescription = `${unfollowing?.type === 'author' ? 'Their' : 'Its'} papers will stop shaping your recommendations. You can follow again at any time.`;
  const petri = (
    <Petri
      pose="farewell"
      className={`following-unfollow-petri is-${unfollowing?.type || 'author'}`}
      initials={getInitials(unfollowName)}
      released={released}
    />
  );

  return isPhone ? (
    <Drawer
      open={unfollowOpen}
      onOpenChange={setUnfollowOpen}
      onOpenChangeComplete={finishUnfollow}
    >
      <DrawerContent className="pc-share-sheet following-unfollow-drawer">
        <DrawerHandle />
        <div className="following-unfollow-sheet">
          {petri}
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
      onOpenChangeComplete={finishUnfollow}
    >
      <AlertDialogContent className="following-unfollow-dialog">
        {petri}
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
 * interests editor, whose type is a select above the list. SettingsPage keeps
 * it mounted and drives `open`.
 */
export function FollowingSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const view = useFollowedView();
  const { language, followedByType, activeType, activeTab, setSelectedType, unfollowOpen, unfollowing } = view;
  const countOf = (type: string) => followedByType[type]?.length || 0;
  const returning = !unfollowOpen && unfollowing !== null;
  // A page opened from the sheet waits for the sheet to close; the sheet
  // belongs to Settings and would be cut off when Settings leaves.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const navigateAfterClose = (path: string) => {
    setPendingPath(path);
    onOpenChange(false);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen || !pendingPath) return;
        setPendingPath(null);
        navigate(pendingPath);
      }}
    >
      <DrawerContent className={`settings-sheet is-tall${returning ? ' is-returning' : ''}`} overlayClassName="settings-sheet-backdrop">
        <DrawerHandle />
        <div className="settings-sheet-head">
          <DrawerTitle render={<h2 />}>{'Follows'}</DrawerTitle>
          <p>{followSummary(view)}</p>
          <Select value={activeType} onValueChange={value => setSelectedType(value as string)}>
            <SelectTrigger aria-label={'Type of followed content'} className="settings-sheet-switcher">
              <span className="settings-sheet-switcher-icon"><activeTab.Icon size={18} weight="fill" aria-hidden="true" /></span>
              <span className="settings-sheet-switcher-copy">
                <small>{'Type'}</small>
                <strong>{`${activeTab.label[language]} · ${countOf(activeType)}`}</strong>
              </span>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} sideOffset={6}>
              {FOLLOW_TABS.map(({ type, label, Icon }) => (
                <SelectItem key={type} value={type} className="settings-sheet-option">
                  <Icon size={18} weight={type === activeType ? 'fill' : 'regular'} aria-hidden="true" />
                  <span>{label[language]}</span>
                  <small>{countOf(type)}</small>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="settings-sheet-body" data-base-ui-swipe-ignore="">
          <FollowedList view={view} onExplore={() => navigateAfterClose('/search')} onOpenEntity={navigateAfterClose} />
        </div>
        <UnfollowConfirm view={view} />
      </DrawerContent>
    </Drawer>
  );
}
