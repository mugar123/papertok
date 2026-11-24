import type { FollowEntity } from '../../utils/following.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import { EASE_OUT } from '../../utils/motion-curves.ts';
import {
  ArrowLeft,
  Briefcase,
  Buildings,
  CircleNotch,
  Tag,
  User,
  UserMinus,
} from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { getFollowedEntityPath } from '../../utils/following-navigation.ts';
import { openingFollowType } from './opening-follow-type.ts';
import type { FollowRefusal, RefusalLine } from '../following/follow-refused-toast.ts';
import { followRefusal, refusalShownTo, sayFollowRefused } from '../following/follow-refused-toast.ts';
import type { ActionStart } from '../ui/toast.ts';
import { afterOverlaysSince, sameAccount } from '../ui/toast.ts';
import { followsListPress, unfollowOnLeave } from './follows-list-press.ts';
import { focusAfterUnfollow, focusLeftByQuestion } from './focus-after-unfollow.ts';
import { getFollowDisplayName } from '../../utils/follow-display-name.ts';
import { Button } from '../ui/button.tsx';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import Petri from '../onboarding/petri.tsx';
import useIsPhone from '../../hooks/use-is-phone.ts';
import './settings-sheet.css';
import './following-settings-page.css';

const FOLLOW_TABS = [
  { type: 'author', label: { en: 'Authors' }, Icon: User },
  { type: 'topic', label: { en: 'Topics' }, Icon: Tag },
  { type: 'institution', label: { en: 'Institutions' }, Icon: Buildings },
  { type: 'project', label: { en: 'Projects' }, Icon: Briefcase },
];
const FOLLOW_TAB_TYPES = FOLLOW_TABS.map(tab => tab.type);

function getRowKey(entity: FollowEntity) {
  return entity.followKey || `${entity.type}:${entity.canonicalId}`;
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
 * What the page, the phone sheet and the dialog share: the type on show, its follows in
 * order, and an unfollow that asks first. Confirming lets go of Petri's
 * balloon, closes the question, and unfollows once it has gone, so the row
 * leaves in sight of the list it returns to. A toast offers Undo, or a line
 * above the list in the dialog (`undoInList`).
 */
function useFollowedView({ sheetOpen, undoInList = false }: { sheetOpen?: boolean; undoInList?: boolean } = {}) {
  const { language, locale } = useLanguage();
  const following = useFollowing();
  const { followedByType } = following;
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const uid = useAuth().user?.uid;
  // Kept with the account that pressed, and hidden once another is signed in.
  const [errorLine, setErrorLine] = useState<RefusalLine<string> | null>(null);
  const actionError = refusalShownTo(errorLine, uid) ?? '';
  const setActionError = (message: string) => setErrorLine(message ? { uid, refused: message } : null);
  // The last unfollow's Undo, said in the list rather than in a toast where
  // the list is a dialog (`undoInList`): the toast sits outside the dialog's
  // focus trap, where a keyboard cannot reach it before it leaves. Kept with
  // the account that unfollowed, like the error line.
  const [undoLine, setUndoLine] = useState<RefusalLine<{ entity: FollowEntity; name: string; startedAt: ActionStart }> | null>(null);
  const lastUnfollow = refusalShownTo(undoLine, uid);
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
  // Whether the list, and so its status line, is on screen: the page until
  // the route leaves it (it stays mounted through its exit transition), the
  // phone sheet or the dialog while it is open. A write can settle after the
  // reader has left any of them.
  const present = useIsPresent();
  const inView = useRef(false);
  useEffect(() => {
    latest.current = following;
    inView.current = (sheetOpen ?? true) && present;
  });
  useEffect(() => () => {
    clearTimeout(releaseTimer.current);
    inView.current = false;
  }, []);
  // Where focus goes once a confirmed unfollow's question has left: from the
  // row it asked about to the row whose Unfollow button takes it, or to null
  // for the type control (the page's current tab, the sheet's select). The
  // row's own button, where the question would return it, leaves with the
  // row, so a confirmed question returns no focus (finalFocus is false from
  // the press) and the effect below moves it instead, in the commit that
  // follows finishUnfollow. It moves focus only while focus is still where the
  // question leaves it, never off a control the reader moved to during the
  // close, and goes to the type control if the chosen row's button has gone
  // or been disabled since. A cancelled question keeps Base UI's own return,
  // which also leaves moved focus alone. toggleFollow takes the row out
  // before its first await, so when the opening tab empties and the page
  // switches tabs, the tab it switches to is the one that takes focus.
  const unfollowFocus = useRef<{ from: string; to: string | null } | undefined>(undefined);
  const unfollowButtons = useRef(new Map<string, HTMLButtonElement>());
  const typeControl = useRef<HTMLButtonElement | null>(null);
  const question = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const handOff = unfollowFocus.current;
    if (!handOff) return;
    unfollowFocus.current = undefined;
    const { activeElement, body } = document;
    if (!focusLeftByQuestion(activeElement, { body, rowButton: unfollowButtons.current.get(handOff.from), question: question.current })) return;
    const nextRow = handOff.to === null ? undefined : unfollowButtons.current.get(handOff.to);
    (nextRow && !nextRow.disabled ? nextRow : typeControl.current)?.focus();
  });

  const pressStart = (press: 'unfollow' | 'undo') => followsListPress({ press, inOpenSheet: sheetOpen !== undefined && inView.current });
  const sayRefused = (refused: FollowRefusal, startedAt: ActionStart) => {
    sayFollowRefused(refused, {
      inView: () => inView.current,
      inOverlay: sheetOpen !== undefined,
      showInLine: ({ message }) => setActionError(message),
      startedAt,
    });
  };

  const activeType = selectedType || openingFollowType(FOLLOW_TAB_TYPES, followedByType);
  const activeTab = FOLLOW_TABS.find(tab => tab.type === activeType) || FOLLOW_TABS[0];
  const visibleEntities = useMemo(
    () => [...(followedByType[activeType] || [])]
      .sort((left, right) => (
        getFollowDisplayName(left)
          .localeCompare(getFollowDisplayName(right), locale)
      )),
    [activeType, followedByType, locale],
  );

  const undoUnfollow = (entity: FollowEntity, displayName: string, startedAt: ActionStart) => {
    // The account change puts the toast and the line away; a press as they
    // leave would still follow for whoever signed in since.
    if (!sameAccount(startedAt) || latest.current.isFollowing(entity)) return;
    // A refused Undo is said in the list's status line while the list is on
    // screen, as the palette does: the list is a sheet or a dialog, and a
    // toast would sit over it outside its focus trap. The toast outlives the
    // list, though, so an Undo pressed after it closed is answered in a toast.
    setActionError('');
    const undoStartedAt = pressStart('undo');
    latest.current.toggleFollow(entity).catch((error: unknown) => {
      sayRefused(followRefusal(error, { name: displayName, following: false }), undoStartedAt);
    });
  };
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
    // A dialog closed while the write settled has no list to say it in. The
    // line waits, as a refusal does, for an overlay opened since the press:
    // under one it would change unseen and unannounced.
    if (undoInList && inView.current) {
      afterOverlaysSince(startedAt, () => setUndoLine({ uid, refused: { entity, name: displayName, startedAt } }), { inOverlay: true });
      return;
    }
    toast(`Unfollowed ${displayName}`, {
      action: { label: 'Undo', onClick: () => undoUnfollow(entity, displayName, startedAt) },
    });
  };

  // The line's Undo leaves with the line. Focus goes to the type control: the
  // row it brings back waits for its write, its Unfollow disabled until then.
  const undoLastUnfollow = () => {
    if (!lastUnfollow) return;
    setUndoLine(null);
    const key = getRowKey(lastUnfollow.entity);
    unfollowFocus.current = { from: key, to: key };
    undoUnfollow(lastUnfollow.entity, lastUnfollow.name, lastUnfollow.startedAt);
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
    const unfollow = unfollowOnLeave({ confirmedAt, unfollowing });
    if (unfollow) {
      const from = getRowKey(unfollow.entity);
      const pendingKeys = new Set(visibleEntities.filter(entity => following.isFollowPending(entity)).map(getRowKey));
      unfollowFocus.current = { from, to: focusAfterUnfollow(visibleEntities.map(getRowKey), from, pendingKeys) };
      void handleUnfollow(unfollow.entity, unfollow.startedAt);
    } else if (released && unfollowing) {
      // Confirmed, but the account changed during the leave and the row
      // stays: its own button takes focus back, which the question did not.
      const from = getRowKey(unfollowing);
      unfollowFocus.current = { from, to: from };
    }
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
    lastUnfollow,
    undoLastUnfollow,
    // A line left from this visit would greet the next one as news.
    clearActionError: () => {
      setActionError('');
      setUndoLine(null);
    },
    askUnfollow,
    unfollowing,
    unfollowOpen,
    setUnfollowOpen,
    released,
    confirmUnfollow,
    finishUnfollow,
    question,
    unfollowButtons,
    typeControl,
  };
}

type FollowedView = ReturnType<typeof useFollowedView>;

function followSummary({ loading, followedEntities }: FollowedView) {
  if (loading && followedEntities.length === 0) return 'Loading what you follow...';
  return `${followedEntities.length} ${followedEntities.length === 1 ? 'follow influences' : 'follows influence'} your recommendations.`;
}

/** The follows of the type on show, or its loading or empty state. */
function FollowedList({ view, onExplore, onOpenEntity, withUndoLine = false }: { view: FollowedView; onExplore: () => void; onOpenEntity?: (path: string) => void; withUndoLine?: boolean }) {
  const { activeType, activeTab, language, loading, followedEntities, visibleEntities, isFollowPending, askUnfollow, actionError, unfollowButtons, lastUnfollow, undoLastUnfollow } = view;
  return (
    <>
      {withUndoLine && (
        <div className="following-settings-undo">
          <p role="status">{lastUnfollow ? `Unfollowed ${lastUnfollow.name}.` : ''}</p>
          {lastUnfollow && <Button variant="outline" size="sm" onClick={undoLastUnfollow}>{'Undo'}</Button>}
        </div>
      )}
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
              const rowKey = getRowKey(entity);
              return (
                <motion.article
                  layout
                  key={rowKey}
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
                    ref={(button: HTMLButtonElement | null) => {
                      if (!button) return;
                      unfollowButtons.current.set(rowKey, button);
                      return () => { unfollowButtons.current.delete(rowKey); };
                    }}
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
  const { unfollowing, unfollowOpen, setUnfollowOpen, released, confirmUnfollow, finishUnfollow, question } = view;
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
      <DrawerContent ref={question} className="pc-share-sheet following-unfollow-drawer" finalFocus={!released}>
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
      <AlertDialogContent ref={question} className="following-unfollow-dialog" finalFocus={!released}>
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
  // A phone reaches the page from links elsewhere (Settings opens the
  // sheet); back returns there. The fallback covers a direct URL load.
  const goBack = () => {
    if (location.key !== 'default') void navigate(-1);
    else void navigate('/settings/discovery');
  };
  const view = useFollowedView();
  const { language, followedByType, activeType, setSelectedType, typeControl } = view;

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
                  ref={active ? typeControl : undefined}
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
  const { language, followedByType, activeType, activeTab, setSelectedType, unfollowOpen, unfollowing, clearActionError, typeControl } = view;
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
            <SelectTrigger ref={typeControl} aria-label={'Type of followed content'} className="settings-sheet-switcher">
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

/**
 * The same follows wider than a phone: a dialog over Settings, like the
 * interests editor, with the types down a rail beside the list.
 * /settings/following opens it over the Discovery page, which drives `open`
 * from the route. Closing it goes back to where it was opened from, and a
 * page opened from the list waits for the dialog to leave first, as the
 * phone sheet does, rather than leave it behind over the next page.
 */
export function FollowingDialog({ open }: { open: boolean }) {
  const navigate = useNavigate();
  // Mounted open (a direct load, or Back from a followed page), Base UI
  // would show the dialog without its arrival; it opens a frame later.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Where to go once the dialog has left: `null` back where it was opened
  // from, or a page opened from the list. Over once the route has left
  // /settings/following, so the next Edit opens it again.
  const [leaving, setLeaving] = useState<{ to: string | null } | null>(null);
  if (!open && leaving) setLeaving(null);
  const shown = open && arrived && !leaving;
  // Closing changes the route back to Discovery, and RouteAnnouncer then
  // moves focus to the page after the dialog has returned it. The control
  // that opened the dialog, noted before that announcer runs as the route
  // arrives, takes it back, unless the reader has moved focus since.
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);
  useEffect(() => {
    const control = opener.current;
    if (open || !(control instanceof HTMLElement) || !control.isConnected) return;
    opener.current = null;
    const { activeElement, body } = document;
    if (activeElement === body || activeElement?.id === 'main-content') control.focus();
  }, [open]);
  const view = useFollowedView({ sheetOpen: shown, undoInList: true });
  const { language, followedByType, activeType, setSelectedType, clearActionError, typeControl, unfollowing, setUnfollowOpen, finishUnfollow } = view;
  const countOf = (type: string) => followedByType[type]?.length || 0;

  return (
    <Dialog
      open={shown}
      onOpenChange={(nextOpen) => { if (!nextOpen) setLeaving({ to: null }); }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        // A line left from this visit would greet the next one as news.
        clearActionError();
        // Browser Back closes the dialog with the unfollow question still
        // open, and the question then unmounts without reporting its leave:
        // it is settled here, writing an unfollow already confirmed, so that
        // nothing of it is left for the next visit.
        if (unfollowing) {
          setUnfollowOpen(false);
          finishUnfollow(false);
        }
        if (!leaving) return;
        if (leaving.to) void navigate(leaving.to);
        // An entry before this one in the tab's history is PaperTok's; on the
        // first, Back would leave the app or do nothing.
        else if (Number.isInteger(window.history.state?.idx) && window.history.state.idx > 0) void navigate(-1);
        else void navigate('/settings/discovery', { replace: true });
      }}
      modal
    >
      <DialogContent className="following-dialog" overlayClassName="following-dialog-overlay" closeLabel={'Close'}>
        <header className="following-dialog-header">
          <DialogTitle>{'Follows'}</DialogTitle>
          <DialogDescription>{followSummary(view)}</DialogDescription>
        </header>
        <Tabs value={activeType} onValueChange={value => setSelectedType(value as string)} orientation="vertical" className="following-dialog-body">
          <TabsList variant="pill" className="following-dialog-rail" aria-label={'Types of followed content'}>
            {FOLLOW_TABS.map(({ type, label, Icon }) => (
              <TabsTrigger key={type} ref={type === activeType ? typeControl : undefined} value={type} className="following-dialog-tab">
                <Icon size={18} weight={type === activeType ? 'fill' : 'regular'} aria-hidden="true" />
                <span className="following-dialog-tab-label">{label[language]}</span>
                <small>{countOf(type)}</small>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={activeType} className="following-dialog-panel">
            <FollowedList
              view={view}
              onExplore={() => setLeaving({ to: '/search' })}
              onOpenEntity={path => setLeaving({ to: path })}
              withUndoLine
            />
          </TabsContent>
        </Tabs>
        <UnfollowConfirm view={view} />
      </DialogContent>
    </Dialog>
  );
}
