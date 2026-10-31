import type { FollowEntity } from '../../utils/following.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import { EASE_OUT } from '../../utils/motion-curves.ts';
import {
  ArrowLeft,
  Briefcase,
  Buildings,
  CircleNotch,
  FileText,
  Tag,
  User,
  UserMinus,
} from '@phosphor-icons/react';
import { useFollowing } from '../../context/following-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { getFollowedEntityPath } from '../../utils/following-navigation.ts';
import { openingFollowType } from './opening-follow-type.ts';
import type { FollowRefusal } from '../following/follow-refused-toast.ts';
import { followRefusal, sayFollowRefused } from '../following/follow-refused-toast.ts';
import type { ActionStart } from '../ui/toast.ts';
import { sameAccount } from '../ui/toast.ts';
import { followsListPress } from './follows-list-press.ts';
import { journalLimitNote } from './journal-limit-note.ts';
import { getLocalizedInstitutionName } from '../../utils/institution-localization.ts';
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
import Petri from '../onboarding/petri.tsx';
import useIsPhone from '../../hooks/use-is-phone.ts';
import './settings-sheet.css';
import './following-settings-page.css';

const FOLLOW_TABS = [
  { type: 'author', label: { en: 'Authors' }, Icon: User },
  { type: 'topic', label: { en: 'Topics' }, Icon: Tag },
  { type: 'institution', label: { en: 'Institutions' }, Icon: Buildings },
  { type: 'project', label: { en: 'Projects' }, Icon: Briefcase },
  // The Explorer's icon for a source page.
  { type: 'journal', label: { en: 'Journals' }, Icon: FileText },
];
const FOLLOW_TAB_TYPES = FOLLOW_TABS.map(tab => tab.type);

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
// drifting off while the drawer goes (petri.css, petriBalloonAway).
const RELEASE_MS = 280;

/**
 * What the page and the phone sheet share: the type on show, its follows in
 * order, and an unfollow that asks first. Confirming lets go of Petri's
 * balloon, closes the question, and unfollows once it has gone, so the row
 * leaves in sight of the list it returns to; a toast offers Undo.
 */
function useFollowedView({ sheetOpen }: { sheetOpen?: boolean } = {}) {
  const { language, locale } = useLanguage();
  const following = useFollowing();
  const { followedByType } = following;
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [unfollowing, setUnfollowing] = useState<FollowEntity | null>(null);
  const [unfollowOpen, setUnfollowOpen] = useState(false);
  // When Unfollow was pressed in the question, which lets go of the balloon.
  const [confirmedAt, setConfirmedAt] = useState<ActionStart | null>(null);
  const released = confirmedAt !== null;
  const releaseTimer = useRef<number | undefined>(undefined);
  const reduceMotion = useReducedMotion();
  // Undo runs renders later, when this render's toggleFollow and isFollowing
  // close over follows that no longer hold.
  const latest = useRef(following);
  // Whether the list, and so its status line, is on screen: the page while it
  // is mounted, the phone sheet while it is open. A write can settle after
  // the reader has left either.
  const inView = useRef(false);
  useEffect(() => {
    latest.current = following;
    inView.current = sheetOpen ?? true;
  });
  useEffect(() => () => {
    clearTimeout(releaseTimer.current);
    inView.current = false;
  }, []);

  const pressStart = (press: 'unfollow' | 'undo') => followsListPress({ press, inOpenSheet: sheetOpen !== undefined && inView.current });
  const sayRefused = (refused: FollowRefusal, startedAt: ActionStart) => {
    sayFollowRefused(refused, { inView: inView.current, showInLine: ({ message }) => setActionError(message), startedAt });
  };

  const { state: locationState } = useLocation();
  const requestedType = (locationState as { followType?: unknown } | null)?.followType;
  const activeType = selectedType || openingFollowType(FOLLOW_TAB_TYPES, requestedType, followedByType);
  const activeTab = FOLLOW_TABS.find(tab => tab.type === activeType) || FOLLOW_TABS[0];
  const visibleEntities = useMemo(
    () => [...(followedByType[activeType] || [])]
      .sort((left, right) => (
        getFollowDisplayName(left)
          .localeCompare(getFollowDisplayName(right), locale)
      )),
    [activeType, followedByType, locale],
  );

  const handleUnfollow = async (entity: FollowEntity, startedAt: ActionStart) => {
    setActionError('');
    const displayName = getFollowDisplayName(entity);
    try {
      await latest.current.toggleFollow(entity);
    } catch {
      sayRefused({ message: `Could not unfollow ${displayName}.` }, startedAt);
      return;
    }
    // Its Undo, pressed by whoever signed in since, would follow in their account.
    if (!sameAccount(startedAt)) return;
    toast(`Unfollowed ${displayName}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          if (latest.current.isFollowing(entity)) return;
          // A journal's Undo can meet the journal limit, which another
          // device's follow may have reached in the meantime. Said in the
          // list's status line while the list is on screen, as the palette
          // does: on a phone the list is a sheet, and a toast would sit over
          // it outside its focus trap. The toast outlives the list, though,
          // so an Undo pressed after it closed is answered in a toast.
          setActionError('');
          const undoStartedAt = pressStart('undo');
          latest.current.toggleFollow(entity).catch((error: unknown) => {
            sayRefused(followRefusal(error, { name: displayName, following: false }), undoStartedAt);
          });
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
    setConfirmedAt(pressStart('unfollow'));
    releaseTimer.current = window.setTimeout(() => setUnfollowOpen(false), reduceMotion ? 0 : RELEASE_MS);
  };
  const finishUnfollow = (isOpen: boolean) => {
    if (isOpen) return;
    if (confirmedAt && unfollowing) void handleUnfollow(unfollowing, confirmedAt);
    setConfirmedAt(null);
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
    clearActionError: () => setActionError(''),
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
  const { activeType, activeTab, language, loading, followedEntities, followedByType, visibleEntities, isFollowPending, askUnfollow, actionError } = view;
  const limitNote = activeType === 'journal' ? journalLimitNote(followedByType.journal?.length ?? 0) : null;
  return (
    <>
      {limitNote && <p className="following-settings-note">{limitNote}</p>}
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
          {/* Search finds no journals, so the Journals tab says how to reach
              a journal's page instead of sending the reader there. */}
          <EmptyState
            art={<Petri pose="compass" className="following-settings-empty-petri" />}
            title={'Nothing followed here yet'}
            actions={activeType !== 'journal' && (
              <Button size="sm" onClick={onExplore}>
                {'Explore PaperTok'}
              </Button>
            )}
          >
            {activeType === 'journal'
              ? 'Open a paper with Read in plain words and select its journal’s name to follow the journal from its page.'
              : 'What you follow shows up here and shapes your feed.'}
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
    if (location.key !== 'default') void navigate(-1);
    else void navigate('/settings/discovery');
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
            <FollowedList view={view} onExplore={() => { void navigate('/search'); }} />
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
  const view = useFollowedView({ sheetOpen: open });
  const { language, followedByType, activeType, activeTab, setSelectedType, unfollowOpen, unfollowing, clearActionError } = view;
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
        if (isOpen) return;
        // A line left from this visit would greet the next one as news.
        clearActionError();
        if (!pendingPath) return;
        setPendingPath(null);
        void navigate(pendingPath);
      }}
    >
      <DrawerContent className={`settings-sheet is-tall${returning ? ' is-returning' : ''}`} overlayClassName="settings-sheet-backdrop">
        <DrawerHandle />
        <div className="settings-sheet-head">
          <DrawerTitle render={<h2 />}>{'Follows'}</DrawerTitle>
          <p>{followSummary(view)}</p>
          <Select value={activeType} onValueChange={value => setSelectedType(value)}>
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
