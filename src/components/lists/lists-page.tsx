import type { DocumentData, QuerySnapshot } from 'firebase/firestore';
import type { Paper } from '../../models/paper.ts';
import type { OwnList } from '../../utils/own-lists.ts';
import type { MetadataRequest } from '../../utils/list-paper-metadata-plan.ts';
import type { SyncState } from '../../services/public-list-sync.ts';
import type { PublicPaperInput } from '../../services/public-list-payload.ts';
import type { ReactElement } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../../services/firebase.ts';
import {
  collection,
  getDocs,
  getDocsFromCache,
  query,
  where,
  documentId,
  doc,
  deleteDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  arrayRemove,
  limit,
} from 'firebase/firestore';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { getCategoryLabel } from '../../data/categories.ts';
import { getIcon } from '../../utils/icons.ts';
import CreateListDialog from './create-list-dialog.tsx';
import { removePaperFromList } from './remove-paper-from-list.ts';
import { writeNewList } from './write-new-list.ts';
import SaveToListModal from './save-to-list-modal.tsx';
import ListNote from './list-note.tsx';
import { ListRowAuthors, PaperListRow } from './list-row.tsx';
import { Button } from '../ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.tsx';
import RailMenu from '../feed/rail-menu.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { EASE_DRAWER, EASE_OUT, animateSize } from '../../utils/motion-curves.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import Petri from '../onboarding/petri.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { toastError } from '../ui/toast.ts';
import { resolveListColor } from '../../utils/list-colors.ts';
import ScientificText from '../scientific-text.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import {
  ArrowLeft,
  DotsThree,
  CaretDown,
  Check,
  DownloadSimple,
  GlobeHemisphereWest,
  LinkBreak,
  Lock,
  PencilSimple,
  Plus,
  ShareNetwork,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { shareOrCopyLink } from '../../utils/share-link.ts';
import { timeAgo } from '../../utils/time-ago.ts';
import { downloadCitationFile } from '../../utils/reading-library.ts';
import { decodeFirestoreDocId, encodeFirestoreDocId } from '../../utils/firestore-doc-id.ts';
import { hydrateLegacyArxivPapers } from '../../services/liked-paper-records.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { useAnalyticsConsent } from '../../context/analytics-context.tsx';
import {
  PUBLIC_LIST_LIMITS,
  publishPublicList,
  readPublicList,
  unpublishPublicList,
} from '../../services/public-list-service.ts';
import {
  cancelPublicListSync,
  queuePublicListSync,
  retryPublicListSync,
  subscribeToPublicListSync,
} from '../../services/public-list-sync.ts';
import {
  listNeedsPublicSync,
  publicListSyncKey,
  toEpochMillis,
} from '../../utils/public-list-freshness.ts';
import { getPublicListUrl, getPublicPaperPath } from '../../utils/public-navigation.ts';
import PaperCard from '../feed/paper-card.tsx';
import PaperOverlay from '../feed/paper-overlay.tsx';
import { isReadTimeout, patientRead } from '../../utils/bounded-read.ts';
import {
  ownListsCache,
  readListPapers,
  rememberListPapers,
  rememberOwnLists,
} from '../../utils/profile-session-caches.ts';
import { OWN_LISTS_PAGE_SIZE, snapshotIsAuthoritative } from '../../utils/own-lists.ts';
import { readStoredLists, saveStoredLists } from '../../utils/user-scoped-storage.ts';
import { queryIsAuthoritative } from '../../utils/cache-authority.ts';
import {
  PAPER_METADATA_BATCH_SIZE,
  planMetadataRequests,
  planRetryRequests,
} from '../../utils/list-paper-metadata-plan.ts';
import './lists-page.css';

/**
 * How long a read may take before it is allowed to draw a placeholder.
 *
 * Under roughly a third of a second a wait reads as instantaneous, so a
 * placeholder that appears immediately is not a loading state — it is a flash
 * on every healthy visit, which is worse than the wait it describes.
 */
const LIST_PLACEHOLDER_DELAY_MS = 320;
const PAPER_METADATA_LOAD_DEADLINE_MS = 4_000;
/**
 * The ceiling on the whole open, as opposed to on one request.
 *
 * Every other deadline here bounds a single read, and a read that passes its
 * deadline deliberately keeps running so it can still paint the row when it
 * lands. That is right, and it left the fan-out as a whole bounded by nothing:
 * a request that never settles is a row that shimmers forever.
 *
 * Twenty seconds, because it must not fire on anything that is merely slow.
 * A healthy open measures under a third of a second, and Firestore reports a
 * stalled channel as `unavailable` at about ten — so this only ever bites when
 * something has gone wrong in a way the SDK itself has not noticed.
 *
 * What happens at expiry is the part that matters: the rows stop waiting AND
 * the banner appears. Stopping the wait without the banner is the bug this
 * screen just had — a row falling back to its raw id as though the answer were
 * "this paper has no metadata". The banner is what keeps it "we could not find
 * out", which is the one thing the rows alone cannot say.
 */
const PAPER_METADATA_TOTAL_BUDGET_MS = 20_000;
const PRIVATE_LIST_IDS = new Set(['__favorites__', '__read__', '__read_later__']);
const FOLDER_BACK = 'M0 3 Q0 0 3 0 H30 Q33 0 34 3 L36 7 Q37 9 40 9 H97 Q100 9 100 12 V97 Q100 100 97 100 H3 Q0 100 0 97 Z';
const FOLDER_POCKET = 'M0 3 Q0 0 3 0 H33 Q36 0 38 3 L42 10 Q44 13 47 13 H97 Q100 13 100 16 V97 Q100 100 97 100 H3 Q0 100 0 97 Z';

type ListMenuAction = { id: string; label: string; hint: string; Icon: Icon; disabled?: boolean; onSelect: () => void };

/**
 * A list's overflow actions: a dropdown on desktop, and on a phone a drawer of
 * the paper options' hinted rows, where a thumb has room to read what each does.
 */
function ListMenu({ title, trigger, actions }: { title: string; trigger: ReactElement; actions: ListMenuAction[] }) {
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <RailMenu
        title={title}
        trigger={trigger}
        sheet={actions.map(({ id, label, hint, Icon, disabled, onSelect }) => (
          <li key={id}>
            <DrawerClose className="pc-menu-item" data-action={id} disabled={disabled} onClick={onSelect}>
              <span className="pc-menu-item-icon">
                <Icon size={20} aria-hidden="true" />
              </span>
              <span>
                <span className="pc-menu-item-label">{label}</span>
                <span className="pc-menu-item-hint">{hint}</span>
              </span>
            </DrawerClose>
          </li>
        ))}
      />
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" aria-label={title}>
        {actions.map(({ id, label, Icon, disabled, onSelect }) => (
          <DropdownMenuItem key={id} disabled={disabled} onClick={onSelect}>
            <Icon size={15} aria-hidden="true" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function copyText(value: string) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === 'undefined') throw new Error('Clipboard access is unavailable.');
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}


/** A list paper from its `savedPapers` document or its lighter interaction record. */
function paperFromMetadataDoc(source: MetadataRequest['source'], paperId: string, data: DocumentData) {
  return paperLegacyAdapter(source === 'saved'
    ? { id: paperId, ...data }
    : data.paper
      ? { id: paperId, ...data.paper }
      // Without a copy, the record kept only the category its card showed,
      // which the adapter cannot trust (PAP-60).
      : {
          id: paperId,
          title: data.paperTitle || '',
          authors: data.paperAuthors || [],
          published: data.timestamp,
          arxivId: paperId,
        });
}

/**
 * The Public badge doubles as the sync indicator, and that is the whole
 * replacement for the Update button.
 *
 * The button answered one question — is the public link current? — by making
 * the owner press it and find out. The badge answers the same question without
 * ever asking for a click: it says what the background sync is doing, and goes
 * quiet again when there is nothing to say.
 */
function publicBadgeState(status: string | undefined) {
  if (status === 'pending' || status === 'syncing') return 'syncing';
  if (status === 'synced') return 'synced';
  if (status === 'error') return 'stale';
  return 'public';
}


/** A paper in one list: what the row's remove dialog and phone sheet act on. */
type RowTarget = { listId: string; listName?: string; paperId: string; paper: Partial<Paper> };

export default function ListsPage({ onOpenPdf, onEditPaper }: { onOpenPdf: (paper: Paper) => void; onEditPaper: (paper: Paper) => void }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { trackEvent } = useAnalyticsConsent();
  const { language, locale } = useLanguage();
  const {
    unmarkAsRead,
    interactionIdFor,
    toggleLike,
    markNotInterested,
    markAsRead,
    trackViewTime,
    trackSkip,
    personalLibrary,
    ensurePersonalLibrary,
    libraryPapers,
    toggleReadLater,
    likedPaperIds,
    savedPaperIds,
    readPaperIds,
  } = useFeed();

  // The paper open in the card overlay below: one that has no address on the
  // public paper page, so the card is painted from the stored copy instead.
  const [overlayPaper, setOverlayPaper] = useState<Paper | null>(null);
  const closeOverlayPaper = useCallback(() => setOverlayPaper(null), []);

  // The paper the overlay is SHOWING, which outlives the one selected. Closing
  // sets `overlayPaper` to null to start the leave; if the card went with it,
  // the surface would spend its 200ms exit fading out over nothing. This is
  // dropped when the leave actually ends (`onExitComplete`).
  //
  // Adjusted during render rather than in an effect: a paper opened while
  // another is still leaving has to take over in the same commit, or the
  // window shows the wrong paper for a frame.
  const [shownPaper, setShownPaper] = useState<Paper | null>(null);
  if (overlayPaper && overlayPaper !== shownPaper) {
    setShownPaper(overlayPaper);
  }

  const getInteractionState = useCallback((paper: Partial<Paper>) => ({
    isLiked: likedPaperIds.has(paper.id!),
    isSaved: savedPaperIds.has(paper.id!),
    isRead: readPaperIds.has(paper.id!),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);

  // Notes, tags and read timestamps no longer ride along on every feed load;
  // this screen is the one that renders them, so it is the one that fetches
  // them.
  useEffect(() => {
    void ensurePersonalLibrary?.();
  }, [ensurePersonalLibrary]);
  /**
   * Seeded from the session cache, not from nothing.
   *
   * This screen wrote `rememberOwnLists` on every visit and never read it back,
   * which made it the one screen the cache was built for that did not use it.
   * The cost was visible: Favorites, Read later and Reading history are
   * synthesised from contexts already in memory, so three cards painted in the
   * first frame and the owner's own lists appeared seconds later when the read
   * resolved — the grid growing under someone already reading it.
   *
   * The save modal next door has seeded from this cache since it was written
   * (`useState(() => seededLists ?? [])`). Same cache, same key, same rule here.
   */
  /**
   * Two seeds, in order of freshness: the session cache first, then what this
   * device stored last time. The cache covers re-entry within a tab; storage
   * covers the first visit after a reload, which is the one where the seam
   * showed — three synthesised cards painting instantly and the owner's own
   * lists dropping in behind them.
   */
  const seededLists = user?.uid
    ? (ownListsCache.get(user.uid) ?? readStoredLists(user.uid))
    : null;
  const [lists, setLists] = useState(() => seededLists ?? []);
  // Seeded, for the same reason the lists are. Leaving a list to read a paper
  // and coming back used to re-fetch every document the tab had in its hands
  // seconds earlier — Firestore's own cache cannot cover it, because this app
  // deliberately runs the in-memory one with no persistence (firebase.js).
  const [savedPapers, setSavedPapers] = useState(
    () => (user?.uid ? readListPapers(user.uid) : null) ?? {},
  );
  const [expandedList, setExpandedList] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Placeholder tiles for the cold case, and only for it. Seeding from the
  // session cache covers a revisit and the IndexedDB read covers this device,
  // so what is left is a first visit — where three system cards alone look like
  // a finished grid right up until the owner's own lists shove them aside.
  const [placeholdersDue, setPlaceholdersDue] = useState(false);
  /**
   * The papers whose metadata is still on its way, by id.
   *
   * A single "is this list loading" flag could not express what actually
   * happens here. `openList` gives each request four seconds and then returns —
   * but a request that merely ran out of time is still running, and the handler
   * that merges it when it lands is deliberate (counting those as failures is
   * what used to put "some metadata could not be loaded" on screen for data
   * that arrived a second later). The flag was cleared at the deadline, so from
   * that moment every paper still in flight rendered the "nothing is coming"
   * placeholder: its raw arXiv id. On Favorites — the biggest list, ten
   * concurrent queries — that was the whole list.
   *
   * A row now waits while its own id is in this set, so the late window the
   * loader already supports is visible rather than contradicted.
   */
  const [pendingPaperIds, setPendingPaperIds] = useState(() => new Set<string>());
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [shareFeedback, setShareFeedback] = useState<{ listId: string; state: string; url?: string | null; copied?: boolean } | null>(null);
  // What the sync engine is doing, keyed by list. It is not this page's state
  // to own: the save-and-organize modal queues syncs too, and they have to
  // outlive whichever screen started them, so the page subscribes instead.
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  // What visitors actually see, per list. One read of the public document when
  // a published list is opened, and it earns its place twice: it is the only
  // honest source for "N papers are not in the public link yet", and it is
  // what lets a list damaged by an earlier sync repair itself on open — the
  // dirty stamp cannot, because a bad sync marks itself as done.
  const [publicSnapshots, setPublicSnapshots] = useState<Record<string, { paperCount: number | null }>>({});
  // The index needs its own door to a new list: the only other one in the app is
  // inside the save modal, and it opens the very same window (CreateListDialog).
  const [creating, setCreating] = useState(false);
  // The list the edit window is open on, or null. Holding the list rather than
  // its id keeps the window's preset off a lookup that can miss mid-refresh.
  const [editing, setEditing] = useState<OwnList | null>(null);
  const [removing, setRemoving] = useState<RowTarget | null>(null);
  const [createdListId, setCreatedListId] = useState<string | null>(null);
  const [foldersArrived, setFoldersArrived] = useState(false);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [deletingList, setDeletingList] = useState<OwnList | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isPhone = useIsPhone();
  const [rowSheet, setRowSheet] = useState<RowTarget | null>(null);
  const [rowSheetOpen, setRowSheetOpen] = useState(false);
  const [rowSheetStep, setRowSheetStep] = useState<'menu' | 'remove' | 'edit'>('menu');
  const rowSheetFrom = useRef<number | null>(null);
  const rowSheetStepRef = useRef<HTMLElement | null>(null);
  const setRowSheetStepRef = (node: HTMLElement | null) => { if (node) rowSheetStepRef.current = node; };
  const rowSheetCancelRef = useRef<HTMLButtonElement | null>(null);
  const editGuardRef = useRef<((eventDetails?: unknown) => void) | null>(null);
  // Whether this session has had one authoritative answer about which lists
  // exist. Until it has, `lists` is a seed or a guess, and persisting it could
  // overwrite what this device knew with an emptiness nobody confirmed.
  const listsHeardFromServer = useRef(false);
  const metadataRequestId = useRef(0);
  const metadataAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => metadataAbortRef.current?.abort(), []);
  // The ceiling on the whole metadata fan-out; a new open cancels the last one's.
  const metadataBudgetTimer = useRef<number | null>(null);
  const failedMetadataRequests = useRef(new Map<string, MetadataRequest[]>());
  const prefersReducedMotion = useReducedMotion();

  const displayLists = useMemo<OwnList[]>(() => {
    const favoriteIds = Array.from(likedPaperIds || []);
    const readIds = Array.from(readPaperIds || [])
      .sort((a, b) => (new Date(personalLibrary[b]?.readAt || 0) as Date & number) - (new Date(personalLibrary[a]?.readAt || 0) as Date & number));
    const readLaterIds = Object.values(personalLibrary)
      .filter((record) => record.readLater)
      .sort((a, b) => (new Date(b.updatedAt || 0) as Date & number) - (new Date(a.updatedAt || 0) as Date & number))
      .map((record) => record.paperId);
    return [
      { id: '__favorites__', name: 'Favorites', emoji: 'Heart', paperIds: favoriteIds, createdAt: 'default' },
      { id: '__read_later__', name: 'Read later', emoji: 'BookOpen', paperIds: readLaterIds, createdAt: 'default' },
      { id: '__read__', name: 'Reading history', emoji: 'Eye', paperIds: readIds, createdAt: 'default' },
      ...lists,
    ];
  }, [likedPaperIds, lists, personalLibrary, readPaperIds]);

  const getPaper = useCallback((paperId: string) => {
    // `libraryPapers` last of the three, because it is the broadest and the
    // least specific: it is whatever the mount's bounded read happened to
    // fetch, and either of the other two is a deliberate fetch of this paper.
    const libraryPaper = personalLibrary[paperId]?.paper;
    const savedPaper = savedPapers[paperId] ?? libraryPapers[paperId];
    if (!libraryPaper) return savedPaper;
    if (!savedPaper) return libraryPaper;
    const mergedPaper = {
      ...libraryPaper,
      ...savedPaper,
      doi: libraryPaper.doi || savedPaper.doi,
      arxivId: libraryPaper.arxivId || savedPaper.arxivId,
      openUrl: libraryPaper.openUrl || savedPaper.openUrl,
      landingPageUrl: libraryPaper.landingPageUrl || savedPaper.landingPageUrl,
      pdfUrl: libraryPaper.pdfUrl || savedPaper.pdfUrl,
      abstract: libraryPaper.abstract || savedPaper.abstract,
      summary: libraryPaper.summary || savedPaper.summary,
      concepts: libraryPaper.concepts?.length ? libraryPaper.concepts : savedPaper.concepts,
    };
    return mergedPaper.sources ? mergedPaper : paperLegacyAdapter(mergedPaper);
  }, [libraryPapers, personalLibrary, savedPapers]);

  useEffect(() => subscribeToPublicListSync((key, state) => {
    setSyncStates((current) => {
      if (!state) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (current[key]?.status === state.status && current[key]?.code === state.code) {
        return current;
      }
      return { ...current, [key]: state };
    });
    // Record the sync on the local copy of the list. `publicSyncedAt` is the
    // Worker's field and the Worker has just written it — reading it back
    // would cost a document. Stamping it here keeps the freshness check
    // comparing two times from the SAME clock for the rest of the session,
    // instead of one from Firestore against one from Cloudflare.
    if (state?.status === 'synced' && state.listId) {
      setLists((current) => current.map((entry) => (
        entry.id === state.listId ? { ...entry, publicSyncedAt: new Date() } : entry
      )));
      // Straight from the Worker, so the note and the mismatch check do not
      // need a second read of the document that was just written.
      if (Number.isInteger(state.result?.paperCount)) {
        setPublicSnapshots((current) => ({
          ...current, [state.listId!]: { paperCount: state.result!.paperCount },
        }));
      }
    }
  }), []);

  // Only the turning-on is state, and it happens in the timer. Turning off is
  // derived below, because writing it here would set state synchronously in an
  // effect body and cascade a render on every load that beats the threshold —
  // which is most of them.
  useEffect(() => {
    if (!loading || lists.length > 0) return undefined;
    const timer = setTimeout(() => setPlaceholdersDue(true), LIST_PLACEHOLDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading, lists.length]);

  useEffect(() => {
    let active = true;
    // The retry loop outlives the promise; leaving the screen must end it.
    const controller = new AbortController();

    const loadData = async () => {
      if (!user) {
        if (active) setLists([]);
        if (active) setLoading(false);
        return;
      }
      if (active) {
        setLoading(true);
        setError(null);
      }
      /**
       * Returns false when the snapshot is not worth believing.
       *
       * `patientRead` below covers a read that is slow or that never comes
       * back. It cannot cover a read that answers instantly with nothing:
       * with the backend unreachable `getDocs` resolves against the in-memory
       * cache, so a perfectly fulfilled empty success arrives — and believing
       * it painted an account's custom lists out of existence, measured at 0
       * documents in 0.3 ms, with no error state shown at all. Records in
       * hand are records; an *absence* only counts when the server is the one
       * reporting it.
       */
      const applySnapshot = (snapshot: QuerySnapshot) => {
        if (!active) return false;
        if (!snapshotIsAuthoritative(snapshot)) return false;
        const customLists: OwnList[] = [];
        snapshot.forEach((item) => customLists.push({ id: item.id, ...item.data() }));
        setLists(customLists);
        // The save modal paints from this same cache. Stamping it here means
        // a visit to Mis listas refreshes what the modal will show next.
        rememberOwnLists(user.uid, customLists);
        // The gate on persisting: from here on this session has heard from the
        // server at least once, so `lists` is worth writing to disk — including
        // after a create, a rename or a delete.
        listsHeardFromServer.current = true;
        return true;
      };

      try {

        // A bounded page, never the whole collection: this and the save modal
        // were the last two raw `collection(...)` reads in the client.
        const listsRef = query(
          collection(db, 'users', user.uid, 'lists'),
          limit(OWN_LISTS_PAGE_SIZE),
        );

        // FeedContext already owns Favorites, Read and Read later. Custom lists
        // paint from IndexedDB first while one network refresh runs behind them.
        try {
          const cached = await getDocsFromCache(listsRef);
          applySnapshot(cached);
        } catch {
          // First visit on this device: nothing cached yet.
        }

        // This screen used to bound the read itself: one 2.5-second deadline,
        // and a `throw` when it expired. That deadline was the banner. A read
        // that has not answered yet says nothing about whether it will, and
        // 2.5 seconds is well inside normal — the auth gate alone measures up
        // to 470 ms, and the first read after Firestore closes its idle
        // stream at sixty seconds pays a whole handshake. So the banner fired
        // on healthy accounts, then cleared itself when the answer landed a
        // moment later: a false alarm that argued with itself.
        //
        // `patientRead` replaces it. A timeout keeps the read alive and
        // re-asks; only a real refusal is an error, and the ceiling says
        // "still trying" rather than "could not be updated".
        const answered = await patientRead(() => getDocs(listsRef), {
          attempts: 3,
          label: 'custom lists',
          // A cache-served emptiness is not an answer, and the stream kick
          // behind `patientRead` produces exactly one for the read it
          // flushes. Refused here, it becomes a retry on the rebuilt stream
          // instead of the "could not be loaded" the `throw` below would say.
          isAnswer: snapshotIsAuthoritative,
          signal: controller.signal,
          onLateResult: (lateSnapshot) => {
            if (!active) return;
            if (applySnapshot(lateSnapshot)) {
              setError(null);
              setLoading(false);
            }
          },
        });
        if (!applySnapshot(answered)) {
          // Answered, but only by the cache, and with nothing in it. That is
          // "could not load", not "you have no lists".
          throw new Error('Custom lists could not be loaded.');
        }
        if (active) setError(null);
      } catch (err) {
        if (!active) return;
        if (isReadTimeout(err)) {
          // The budget is spent; the retry loop and `onLateResult` are not.
          console.warn('The custom lists did not answer in time', err);
          setError('LISTS_LOAD_STALLED');
          return;
        }
        console.error('Error loading lists:', err);
        setError('LISTS_LOAD_FAILED');
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadData();
    return () => {
      active = false;
      controller.abort();
    };
  }, [user, reloadToken]);

  const openList = useCallback(async (list: OwnList, retryFailedOnly = false) => {
    const requestId = ++metadataRequestId.current;
    setExpandedList(list.id);
    setMetadataError(null);

    const paperIds = [...new Set(
      (list.paperIds || []).filter((paperId) => typeof paperId === 'string' && paperId),
    )];
    // The mount's library read now keeps what it fetches, so most lists open
    // with nothing missing at all — which is the difference between a list that
    // paints instantly and one that goes back out for every paper it holds.
    const missingIds = paperIds.filter(
      (paperId) => !savedPapers[paperId]
        && !personalLibrary[paperId]?.paper
        && !libraryPapers[paperId],
    );
    // Whatever the last list left waiting is not this list's business.
    setPendingPaperIds(new Set());

    if (missingIds.length === 0) {
      failedMetadataRequests.current.delete(list.id);
      return;
    }

    if (!user) return;
    setPendingPaperIds(new Set(missingIds));
    // The retry loops behind the reads below outlive their promises; a newer
    // open, or leaving the screen, must end the previous one's.
    metadataAbortRef.current?.abort();
    const metadataAbort = new AbortController();
    metadataAbortRef.current = metadataAbort;

    /**
     * The same set, in the closure.
     *
     * The budget below has to know whether anything is STILL waiting, and it
     * fires long after `openList` has returned — so it cannot ask React for the
     * current state, and an updater is no place to decide whether to raise a
     * banner. `dropPending` is the single funnel through which rows stop
     * waiting, so it keeps both copies in step.
     */
    const stillPending = new Set(missingIds);

    // Deliberately NOT cleared when openList returns: a request past its own
    // deadline is still running and can still paint its rows, and this is the
    // ceiling on that window too. A previous open's timer is cancelled by the
    // ref below, and a fire that finds nothing waiting does nothing.
    clearTimeout(metadataBudgetTimer.current!);
    metadataBudgetTimer.current = setTimeout(() => {
      if (metadataRequestId.current !== requestId || stillPending.size === 0) return;
      stillPending.clear();
      setPendingPaperIds(new Set());
      setMetadataError('LIST_METADATA_LOAD_FAILED');
    }, PAPER_METADATA_TOTAL_BUDGET_MS);

    /** Stops a superseded open from clearing the rows of the current one. */
    const dropPending = (ids: string[]) => {
      if (metadataRequestId.current !== requestId || ids.length === 0) return;
      ids.forEach((paperId) => stillPending.delete(paperId));
      setPendingPaperIds((current) => {
        if (!ids.some((paperId) => current.has(paperId))) return current;
        const next = new Set(current);
        ids.forEach((paperId) => next.delete(paperId));
        return next;
      });
    };

    try {
      const retryRequests = retryFailedOnly
        ? (failedMetadataRequests.current.get(list.id) || [])
        : [];
      failedMetadataRequests.current.delete(list.id);

      // The batching lives in list-paper-metadata-plan.ts, where it can be tested:
      // a batch one value over Firestore's cap is not caught by the SDK, and a
      // legacy arXiv id carrying a slash rejects the entire query it rides in.
      const { requests: requestDefinitions, unfetchable } = retryRequests.length > 0
        ? planRetryRequests({ failedRequests: retryRequests, missingIds })
        : planMetadataRequests({ missingIds, batchSize: PAPER_METADATA_BATCH_SIZE });

      // Nothing is ever going to answer for these, so they must not sit under a
      // skeleton waiting for a request that was never made.
      dropPending(unfetchable);

      /**
       * How many requests still cover each paper, so a row stops waiting only
       * when nothing is left that could answer for it.
       *
       * Every batch is asked of two collections. Dropping an id the moment one
       * of them came back empty would put the placeholder under a paper the
       * other request was about to deliver.
       */
      const outstanding = new Map<string, number>();
      requestDefinitions.forEach((requestDefinition) => {
        requestDefinition.paperIds.forEach((paperId) => {
          outstanding.set(paperId, (outstanding.get(paperId) || 0) + 1);
        });
      });
      // Retrying re-asks only the batches that failed, so anything the retry
      // does not cover has nothing left coming for it. Without this those rows
      // would wait on a request that is never going to be made.
      dropPending(missingIds.filter((paperId) => !outstanding.has(paperId)));

      const settleRequest = (requestDefinition: MetadataRequest) => {
        const exhausted: string[] = [];
        requestDefinition.paperIds.forEach((paperId) => {
          const left = (outstanding.get(paperId) ?? 1) - 1;
          outstanding.set(paperId, left);
          if (left <= 0) exhausted.push(paperId);
        });
        dropPending(exhausted);
      };

      const resolvedIds = new Set<string>();
      const mergeSnapshot = (source: MetadataRequest['source'], snapshot: QuerySnapshot) => {
        if (metadataRequestId.current !== requestId) return;
        const loadedPapers: Record<string, Partial<Paper>> = {};
        snapshot.forEach((item) => {
          const data = item.data();
          // Decoded: the document is named by the encoded id, the row by the
          // paper id the list holds.
          const paperId = decodeFirestoreDocId(item.id);
          const paper = paperFromMetadataDoc(source, paperId, data);
          loadedPapers[paperId] = paper;
          if (paper.title && paper.title !== paperId) {
            resolvedIds.add(paperId);
          }
        });

        if (Object.keys(loadedPapers).length === 0) return;
        // A row with data in hand stops waiting immediately; it does not sit
        // under a skeleton until the other collection also reports back.
        dropPending(Object.keys(loadedPapers));
        // Kept for the rest of the session, so leaving this list to read a
        // paper and coming back costs nothing.
        rememberListPapers(user.uid, loadedPapers);
        setSavedPapers((current) => {
          const next = { ...current };
          Object.entries(loadedPapers).forEach(([paperId, paper]) => {
            // savedPapers contains the canonical document and must win even if
            // the lighter interaction record finishes later.
            if (source === 'saved' || !next[paperId]) {
              next[paperId] = paper;
            }
          });
          return next;
        });
      };

      const runRequest = async (requestDefinition: MetadataRequest): Promise<{ status: string; value?: QuerySnapshot; reason?: { code?: string; message?: string } }> => {
        const sourceCollection = requestDefinition.source === 'saved'
          ? 'savedPapers'
          : 'interactions';
        const metadataQuery = query(
          collection(db, 'users', user.uid, sourceCollection),
          where(documentId(), 'in', requestDefinition.paperIds.map(encodeFirestoreDocId)),
        );

        /**
         * No local-cache leg here, and it took two reversals to be sure.
         *
         * It was justified while the mount fetched paper documents and threw
         * most of them away: this read then found them still sitting in
         * Firestore's memory cache, which — measured against the emulator, not
         * assumed — does retain them, across other query traffic, for a
         * DIFFERENT `in` filter over a subset. That was a real hit rate.
         *
         * `ensurePersonalLibrary` now keeps what it fetches, so those documents
         * arrive as `libraryPapers` and never reach `missingIds` at all. What is
         * left for a cache leg to find is a document this session has never
         * fetched — which is exactly what a cache cannot have. It would only
         * buy a second `mergeSnapshot` racing the first.
         */
        /**
         * One `patientRead` per batch. It used to be a bare `getDocs` under a
         * four-second deadline, and against a listen stream that had died
         * under the client the read never answered: every row sat under its
         * skeleton until the total budget said "some metadata could not be
         * loaded", for papers the server would have returned in 130 ms on a
         * fresh stream. `patientRead` kicks the stream at DEFAULT_STALL_MS
         * and asks again; `isAnswer` refuses the empty cache answer the kick
         * flushes — an ABSENCE only counts when the server reports it, and
         * settling on a local one would put the raw arXiv id under every row.
         * A batch past its deadline is still running: `onLateResult` merges
         * and settles it when it lands, exactly as before.
         */
        const settleLate = (lateSnapshot: QuerySnapshot) => {
          mergeSnapshot(requestDefinition.source, lateSnapshot);
          settleRequest(requestDefinition);
          if (
            metadataRequestId.current === requestId
            && missingIds.every((paperId) => resolvedIds.has(paperId))
          ) {
            failedMetadataRequests.current.delete(list.id);
            setMetadataError(null);
          }
        };
        return patientRead(() => getDocs(metadataQuery), {
          attempts: 1,
          ms: PAPER_METADATA_LOAD_DEADLINE_MS,
          label: `list metadata (${requestDefinition.source})`,
          isAnswer: queryIsAuthoritative,
          signal: metadataAbort.signal,
          onLateResult: settleLate,
        }).then((snapshot) => {
          // Documents in hand are documents whatever their provenance; a
          // server saying "no such document" is an answer too, and the row
          // it covers stops waiting.
          mergeSnapshot(requestDefinition.source, snapshot);
          settleRequest(requestDefinition);
          return { status: 'fulfilled', value: snapshot };
        }, (reason) => {
          // Still running past its deadline: the rows it covers keep waiting
          // until it lands or the total budget gives up on them.
          if (isReadTimeout(reason)) return { status: 'timed_out' };
          settleRequest(requestDefinition);
          return { status: 'rejected', reason };
        });
      };

      // Every source/batch has its own deadline and paints as soon as it
      // resolves. One slow Firestore query can no longer hold back the others.
      const requestResults = await Promise.allSettled(
        requestDefinitions.map((requestDefinition) => runRequest(requestDefinition)),
      );
      if (metadataRequestId.current !== requestId) return;

      // A batch that merely ran out of time is still in flight, and the
      // handler above already merges it when it lands. Counting it as a
      // failure is what put "some metadata could not be loaded" on screen for
      // data that arrived a second later.
      const failedRequests = requestResults.flatMap((result, index) => {
        const timedOut = result.status === 'fulfilled' && result.value?.status === 'timed_out';
        if (!timedOut && (result.status === 'rejected' || result.value?.status !== 'fulfilled')) {
          // `settleWithin` resolves with the reason rather than throwing it, so
          // without this every cause reaches the owner as the same sentence and
          // reaches the console as nothing at all. A batch one value over
          // Firestore's cap fails as `invalid-argument` on every attempt and is
          // otherwise indistinguishable from a flaky channel.
          const definition = requestDefinitions[index];
          const reason = result.status === 'rejected' ? result.reason : result.value?.reason;
          console.warn(
            `List metadata request failed (${definition.source}, ${definition.paperIds.length} ids):`,
            reason?.code ?? (result as PromiseFulfilledResult<{ status: string }>).value?.status ?? 'unknown',
            reason?.message ?? '',
          );
          return [definition];
        }
        return [];
      });
      /**
       * The safety net under the per-id accounting.
       *
       * `outstanding` is a counter, and a counter that misses a decrement is a
       * row that shimmers forever — the failure mode with no natural end, and
       * the one worth being paranoid about. So after the burst the question is
       * asked the other way round: which ids could STILL be answered?
       *
       *   timed out      — the read is genuinely still running, and its late
       *                    handler will merge and settle when it lands.
       *
       * An empty answer off the local cache never reaches here any more:
       * `patientRead` refuses it (`isAnswer`) and asks again. Anything else
       * has had its answer, whatever the answer was. If the
       * counter says otherwise, the counter is wrong and this frees the row.
       * The total budget is what bounds the two cases above.
       */
      const stillAnswerable = new Set(
        requestResults.flatMap((result, index) => {
          const status = result.status === 'fulfilled' ? result.value?.status : 'rejected';
          return status === 'timed_out' ? requestDefinitions[index].paperIds : [];
        }),
      );
      dropPending(missingIds.filter((paperId) => !stillAnswerable.has(paperId)));

      const unresolvedIds = missingIds.filter((paperId) => !resolvedIds.has(paperId));

      // A legacy arXiv id (`hep-th/0603001`) saved or liked before document
      // names were encoded has no document to answer for it. arXiv names it;
      // a superseded open paints nothing.
      const legacyMissing = unresolvedIds.filter((paperId) => !stillAnswerable.has(paperId));
      if (legacyMissing.length > 0) {
        setPendingPaperIds((current) => {
          const next = new Set(current);
          legacyMissing.forEach((paperId) => next.add(paperId));
          return next;
        });
        hydrateLegacyArxivPapers(legacyMissing).then(({ records }) => {
          if (metadataRequestId.current !== requestId) return;
          const named: Record<string, Partial<Paper>> = {};
          records.forEach(({ id, data }) => { named[id] = { ...data.paper, id }; });
          if (Object.keys(named).length > 0) {
            rememberListPapers(user.uid, named);
            setSavedPapers((current) => ({ ...named, ...current }));
          }
          dropPending(legacyMissing);
        }).catch(() => dropPending(legacyMissing));
      }

      if (failedRequests.length > 0 && unresolvedIds.length > 0) {
        failedMetadataRequests.current.set(list.id, failedRequests);
        setMetadataError('LIST_METADATA_LOAD_FAILED');
      } else {
        // Either everything resolved, or what is missing is merely late and
        // the merge handler above is still waiting for it. Neither is an error.
        failedMetadataRequests.current.delete(list.id);
        setMetadataError(null);
      }
    } catch (metadataLoadError) {
      console.error('Error loading list paper metadata:', metadataLoadError);
      if (metadataRequestId.current === requestId) {
        setMetadataError('LIST_METADATA_LOAD_FAILED');
        // Nothing is coming: a throw here means the requests were never
        // dispatched, and rows left in the pending set would wait forever.
        setPendingPaperIds(new Set());
      }
    }
  }, [libraryPapers, personalLibrary, savedPapers, user]);

  // The cards show each list's first two papers, and only `openList` used to
  // fetch a list's papers: ask the same two collections for the previews
  // nothing has answered yet, once each, so a fresh load paints no blank sheet.
  const previewAsked = useRef(new Set<string>());
  const previewAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const asked = previewAsked.current;
    previewAbortRef.current = controller;
    return () => {
      controller.abort();
      asked.clear();
    };
  }, []);
  useEffect(() => {
    if (!user?.uid) return;
    const userId = user.uid;
    const missingIds = [...new Set(displayLists.flatMap((list) => (list.paperIds || []).slice(0, 2)))]
      .filter((paperId) => paperId && !getPaper(paperId)?.title && !previewAsked.current.has(`${userId}:${paperId}`));
    const signal = previewAbortRef.current?.signal;
    if (missingIds.length === 0 || !signal) return;
    missingIds.forEach((paperId) => previewAsked.current.add(`${userId}:${paperId}`));
    planMetadataRequests({ missingIds, batchSize: PAPER_METADATA_BATCH_SIZE }).requests
      .forEach((request) => {
        const previewQuery = query(
          collection(db, 'users', userId, request.source === 'saved' ? 'savedPapers' : 'interactions'),
          where(documentId(), 'in', request.paperIds.map(encodeFirestoreDocId)),
        );
        patientRead(() => getDocs(previewQuery), {
          attempts: 1,
          ms: PAPER_METADATA_LOAD_DEADLINE_MS,
          label: 'list card previews',
          isAnswer: queryIsAuthoritative,
          signal,
        }).then((snapshot) => {
          const loaded: Record<string, Partial<Paper>> = {};
          snapshot.forEach((item) => {
            const paperId = decodeFirestoreDocId(item.id);
            const paper = paperFromMetadataDoc(request.source, paperId, item.data());
            if (paper.title && paper.title !== paperId) loaded[paperId] = paper;
          });
          if (signal.aborted || Object.keys(loaded).length === 0) return;
          rememberListPapers(userId, loaded);
          setSavedPapers((current) => {
            const next = { ...current };
            Object.entries(loaded).forEach(([paperId, paper]) => {
              if (request.source === 'saved' || !next[paperId]) next[paperId] = paper;
            });
            return next;
          });
        }, (error) => {
          if (signal.aborted) return;
          request.paperIds.forEach((paperId) => previewAsked.current.delete(`${userId}:${paperId}`));
          console.error('List card previews did not load', error);
        });
      });
  }, [displayLists, getPaper, user?.uid]);

  // Coming back from a paper restores the list that was open. Once per id: the
  // state survives in the history entry, so coming back after closing the list
  // must not snap it open again.
  const autoOpenedListId = useRef<string | null>(null);
  useEffect(() => {
    const targetId = location.state?.openListId;
    if (!targetId || autoOpenedListId.current === targetId) return undefined;
    // `displayLists`, not `lists`: Favorites, Read later and Reading history
    // are assembled here rather than stored, and they must restore too.
    const target = displayLists.find((entry) => entry.id === targetId);
    if (!target) return undefined;
    const timeoutId = setTimeout(() => {
      // Claimed here rather than before the timer: the contexts this list is
      // built from hydrate in several passes, and every pass re-runs this
      // effect and cancels the pending open. Marking it early meant the
      // retry was refused and the list never opened at all.
      autoOpenedListId.current = targetId;
      void openList(target);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [displayLists, location.state, openList]);

  /**
   * A paper in a list opens its card, not the PDF: the card is the whole
   * paper (abstract, actions, related work) and carries a "Read article"
   * button of its own, so nothing is lost and everything else is gained.
   *
   * Before leaving, the current history entry is re-stamped with the open
   * list, so coming back restores the papers rather than the list index.
   */
  const openPaperCard = (paper: Partial<Paper>) => {
    // The public paper page when the paper has an address there — a DOI, an
    // arXiv id, the OpenAlex or PubMed id it was keyed by — with the stored
    // copy riding along so the page paints at once. A paper with no such
    // address (a Semantic Scholar hash saved before the adapter kept the DOI,
    // a Scopus eid) is still the paper the reader saved: its card opens right
    // here, in the same overlay the search and the explorer use, painted from
    // the stored copy. No URL is invented for it — one nobody could load is
    // worse than none — and the PDF viewer is never handed the raw id as an
    // arXiv id, which built a PDF link nothing served.
    const path = getPublicPaperPath(paper) || getPublicPaperPath(paper.id);
    if (!path) {
      setOverlayPaper(paper as Paper);
      return;
    }
    if (expandedList) {
      void navigate(location.pathname, {
        replace: true,
        state: { openListId: expandedList, pageMotion: 'still' },
      });
    }
    // `stored`: this copy is what the list saved, not the paper — the page
    // shows its skeleton until the providers answer and keeps the copy only
    // as the fallback (PublicPaperPage).
    void navigate(path, { state: { paper, stored: true, pageMotion: 'still' } });
  };

  useEffect(() => () => clearTimeout(metadataBudgetTimer.current!), []);

  /**
   * Keeps the stored copy in step with the screen.
   *
   * One write point rather than a call in every handler that mutates a list:
   * creating, renaming, recolouring, deleting and adding or removing a paper
   * all end at `setLists`, and a persisted copy that misses one of them is a
   * deleted list coming back to life on the next reload — which is worse than
   * not persisting at all.
   */
  useEffect(() => {
    if (!user?.uid || !listsHeardFromServer.current) return;
    saveStoredLists(user.uid, lists);
  }, [user?.uid, lists]);

  const listViewMotion = {
    variants: {
      enter: (direction: number) => ({ opacity: 0, transform: prefersReducedMotion ? 'translateX(0px)' : `translateX(${direction * 16}px)` }),
      center: { opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.24, ease: EASE_OUT } },
      exit: (direction: number) => ({ opacity: 0, transform: prefersReducedMotion ? 'translateX(0px)' : `translateX(${direction * -8}px)`, transition: { duration: 0.08, ease: EASE_OUT } }),
    },
    initial: 'enter',
    animate: 'center',
    exit: 'exit',
  };

  const enterList = (list: OwnList) => {
    void openList(list);
  };

  const closeExpandedList = () => {
    metadataRequestId.current += 1;
    setExpandedList(null);
    // Drop the restore marker, or a later visit would reopen a list the user
    // has explicitly closed.
    if (location.state?.openListId) {
      void navigate(location.pathname, { replace: true, state: null });
    }
    setPendingPaperIds(new Set());
    setMetadataError(null);
    setShareFeedback(null);
  };

  // The dialog owns the form and its busy/error states; this owns the write.
  // Letting the failure through is the contract: CreateListDialog keeps itself
  // open and says so, instead of the caller guessing what to render.
  const handleCreateList = async (name: string, icon: string, color: string, { isPublic = false } = {}) => {
    const listId = `list_${Date.now()}`;
    const newList = { id: listId, name, emoji: icon, color, paperIds: [], createdAt: new Date().toISOString() };
    // Public from the start: published empty; the Worker writes the share id
    // onto the list. A failed publish leaves it private, and says so.
    await writeNewList(newList, {
      isPublic,
      write: (list) => setDoc(doc(db, 'users', user!.uid, 'lists', listId), list),
      publish: () => publishPublicList({ listId, title: name, language: 'en', papers: [] }),
      onPublishFailed: (publishError) => {
        console.error('The new list could not be published', publishError);
        toastError('List created, but still private', { description: 'It could not be published. Make it public from My lists.' });
      },
    });
    setLists((prev) => [...prev, newList]);
    setCreatedListId(listId);
  };

  /**
   * Renaming, re-icon-ing or recolouring a list the owner made.
   *
   * A partial update rather than a `setDoc`: the document also carries
   * `paperIds`, `createdAt` and the public-share bookkeeping, and rewriting it
   * whole from a form that knows about three fields would drop the rest. Left
   * to throw, so a failed save keeps the window open with its message instead of
   * closing over a change that never landed.
   *
   * `updatedAt` is not bookkeeping here: the published copy carries the list's
   * NAME, and the sync effect below rebuilds it only when `updatedAt` runs ahead
   * of `publicSyncedAt`. Renaming a published list without leaving that mark
   * would rename it everywhere except on the page strangers actually read.
   */
  const handleEditList = async (listId: string, fields: { name: string; icon: string; color: string }) => {
    if (PRIVATE_LIST_IDS.has(listId)) return;
    const edit = { name: fields.name, emoji: fields.icon, color: fields.color };
    const editedAt = new Date();

    await updateDoc(doc(db, 'users', user!.uid, 'lists', listId), {
      ...edit,
      updatedAt: serverTimestamp(),
    });

    setLists((prev) => prev.map(item => (
      item.id === listId ? { ...item, ...edit, updatedAt: editedAt } : item
    )));
  };

  const handleDeleteList = async (listId: string) => {
    if (PRIVATE_LIST_IDS.has(listId)) return;
    const list = lists.find(candidate => candidate.id === listId);
    if (list?.publicShareId) {
      await unpublishPublicList(list.publicShareId, list.id);
      cancelPublicListSync(publicListSyncKey(user!.uid, listId));
    }
    await deleteDoc(doc(db, 'users', user!.uid, 'lists', listId));
    setLists((prev) => prev.filter((l) => l.id !== listId));
    if (expandedList === listId) setExpandedList(null);
  };

  // Taking a read mark back, from the row's own button or from the card's
  // read toggle in the overlay: the mark goes, and the row leaves the list.
  const forgetRead = (paperId: string) => {
    void unmarkAsRead(paperId);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__read__') {
        return { ...list, paperIds: list.paperIds!.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleUnmarkAsRead = (paperId: string) => {
    forgetRead(paperId);
  };

  const handleUnlike = async (paperId: string, paper: Partial<Paper>) => {
    await toggleLike(paper as Paper);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__favorites__') {
        return { ...list, paperIds: list.paperIds!.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleRemoveFromCustomList = (listId: string, paperId: string) => removePaperFromList(listId, paperId, {
    write: () => updateDoc(doc(db, 'users', user!.uid, 'lists', listId), {
      paperIds: arrayRemove(paperId),
      // The mark the background sync looks for (P25). Every edit leaves
      // it; nothing else here decides when the public copy is rebuilt.
      updatedAt: serverTimestamp(),
    }),
    apply: setLists,
    onFailed: (removeError) => {
      console.error('Error removing paper from custom list:', removeError);
      toastError('The paper could not be removed', { description: 'Try again.' });
    },
  });

  const switchRowSheetStep = (step: 'menu' | 'remove' | 'edit') => {
    rowSheetFrom.current = rowSheetStepRef.current?.closest<HTMLElement>('[data-slot="drawer-content"]')?.offsetHeight ?? null;
    setRowSheetStep(step);
  };

  useLayoutEffect(() => {
    const from = rowSheetFrom.current;
    rowSheetFrom.current = null;
    if (from == null) return;
    if (rowSheetStep === 'remove') rowSheetCancelRef.current?.focus();
    else rowSheetStepRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    const sheet = rowSheetStepRef.current?.closest<HTMLElement>('[data-slot="drawer-content"]');
    if (!sheet || prefersReducedMotion) return;
    animateSize(sheet, 'height', from, 240, EASE_DRAWER, { overflow: 'hidden' });
  }, [rowSheetStep, prefersReducedMotion]);

  const removePaper = ({ listId, paperId, paper }: RowTarget) => {
    if (listId === '__read__') handleUnmarkAsRead(paperId);
    else if (listId === '__favorites__') void handleUnlike(paperId, paper);
    else if (listId === '__read_later__') void toggleReadLater(paper as Paper);
    else void handleRemoveFromCustomList(listId, paperId);
  };

  const setListShareId = (listId: string, publicShareId: string | null | undefined) => {
    setPublicSnapshots((current) => {
      if (!(listId in current)) return current;
      const next = { ...current };
      delete next[listId];
      return next;
    });
    setLists(current => current.map(list => {
      if (list.id !== listId) return list;
      // `publicSyncedAt` too: publishing wrote the public document in the same
      // commit, so without it the freshness check would read a fresh
      // `updatedAt` against nothing and queue a sync of what was just written.
      if (publicShareId) return { ...list, publicShareId, publicSyncedAt: new Date() };
      // Falls through to the private branch below; either way what we knew
      // about the public copy no longer describes anything.
      const privateList = { ...list };
      delete privateList.publicShareId;
      return privateList;
    }));
  };

  // The platform share sheet when there is one (phones, mostly), the
  // clipboard when there is not. A dismissed sheet ends silently: closing it
  // was a decision, not a failure.
  const shareListLink = async (listId: string, publicShareId: string | null | undefined, listName: string | undefined) => {
    const url = getPublicListUrl(publicShareId);
    if (!url) throw new Error('A public link could not be created.');
    const outcome = await shareOrCopyLink({ url, title: listName, copy: copyText });
    if (outcome === 'shared') {
      void trackEvent('share', { method: 'native', content_type: 'list', surface: 'lists' });
      setShareFeedback({ listId, state: 'shared', url });
    } else if (outcome === 'copied') {
      void trackEvent('share', { method: 'clipboard', content_type: 'list', surface: 'lists' });
      setShareFeedback({ listId, state: 'success', url, copied: true });
    } else {
      setShareFeedback(null);
    }
    return url;
  };

  const handlePublishList = async (list: OwnList, papers: PublicPaperInput[]) => {

    setShareFeedback({ listId: list.id, state: 'loading' });
    const input = {
      listId: list.id,
      title: list.name,
      description: list.description,
      language: 'en',
      papers,
    };

    try {
      // Publishing only. Keeping an already-published list current is not a
      // button any more: it is the sync engine, driven by `updatedAt` (P25).
      const result = await publishPublicList(input);
      setListShareId(list.id, result.shareId);
      try {
        await shareListLink(list.id, result.shareId, list.name);
      } catch (clipboardError) {
        console.error('Public list link could not be shared:', clipboardError);
        setShareFeedback({
          listId: list.id,
          state: 'success',
          url: getPublicListUrl(result.shareId),
          copied: false,
        });
      }
    } catch (publishError) {
      console.error('Error publishing public list:', publishError);
      setShareFeedback(null);
      toastError('The public link could not be changed', { description: 'Try again.' });
    }
  };

  const handleShareList = async (list: OwnList) => {
    try {
      setShareFeedback({ listId: list.id, state: 'loading' });
      await shareListLink(list.id, list.publicShareId, list.name);
    } catch (shareError) {
      console.error('Public list link could not be shared:', shareError);
      setShareFeedback({
        listId: list.id,
        state: 'copy-error',
        url: getPublicListUrl(list.publicShareId),
      });
    }
  };

  const handleUnpublishList = async (list: OwnList) => {
    const confirmed = globalThis.confirm?.(
      'Stop sharing this list? Its public link will no longer work.',
    );
    if (confirmed === false) return;

    setShareFeedback({ listId: list.id, state: 'loading' });
    try {
      await unpublishPublicList(list.publicShareId!, list.id);
      // Whatever was queued for this list is about a share id that no longer
      // exists; letting it fire would report a failure for a decision the
      // owner has already made.
      if (user) cancelPublicListSync(publicListSyncKey(user.uid, list.id));
      setListShareId(list.id, null);
      setShareFeedback({ listId: list.id, state: 'unpublished' });
    } catch (unpublishError) {
      console.error('Error unpublishing public list:', unpublishError);
      setShareFeedback(null);
      toastError('The public link could not be changed', { description: 'Try again.' });
    }
  };

  /**
   * The only thing that starts a sync, and the reason the Update button could
   * go away without leaving a hole.
   *
   * Every edit does one thing: stamp `updatedAt`. This asks the list itself
   * whether the last edit is newer than the last sync the Worker committed,
   * and rebuilds the public copy when it is. That indirection is what makes
   * recovery free — a sync lost to a closed tab, a dead connection or a spent
   * daily quota leaves the list dirty in Firestore, and simply opening it
   * later reconciles it, which is exactly the job the button used to do by
   * hand.
   *
   * It waits for the papers and refuses to run on a metadata failure. The
   * Worker's merge preserves an already-published paper for every id the
   * payload does not hydrate — but only an already-published one, so syncing a
   * half-loaded list would quietly drop whatever was added while the load was
   * broken.
   */
  /**
   * What the public copy actually holds, read once when a published list is
   * opened. Best-effort: a failed read leaves the check to the dirty stamp.
   */
  useEffect(() => {
    if (!expandedList) return undefined;
    const list = lists.find((entry) => entry.id === expandedList);
    if (!list?.publicShareId || expandedList in publicSnapshots) return undefined;

    let active = true;
    readPublicList(list.publicShareId)
      .then((document) => {
        if (!active) return;
        setPublicSnapshots((current) => ({
          ...current,
          [list.id]: { paperCount: Number.isInteger(document?.paperCount) ? document!.paperCount : null },
        }));
      })
      .catch((readError) => {
        // Not knowing is not the same as knowing it is wrong: leave the entry
        // absent so the check falls back to the dirty stamp alone.
        console.warn('The public copy of this list could not be checked:', readError);
      });
    return () => { active = false; };
  }, [expandedList, lists, publicSnapshots]);

  /**
   * The two things that start a sync.
   *
   * **The edit stamp.** Every edit sets `updatedAt` and stops there; this
   * compares it with the `publicSyncedAt` the Worker wrote and rebuilds the
   * public copy when the edit is newer. That is what makes recovery free: a
   * sync lost to a closed tab, a dead connection or a spent daily quota is
   * replayed the next time the list is opened, with no click.
   *
   * **The count.** The stamp alone is not enough, and that gap cost a real
   * shared list two papers: a sync that published the WRONG thing still marks
   * itself done, so the list looks clean for ever. When the public copy holds
   * fewer papers than this screen could publish, it is rebuilt. Holding more
   * is fine — those are papers published earlier that this device cannot
   * hydrate right now, and the merge keeps them.
   *
   * It waits for the papers and refuses to run on a metadata failure: syncing
   * a half-loaded list would republish it short.
   */
  const queuedSyncs = useRef(new Map<string, string>());
  useEffect(() => {
    if (!user || !expandedList) return;
    // Never from a seed. A list read back from this device's storage carries
    // the name it had when the tab last closed, and republishing THAT would
    // push a stale title onto the page strangers read — the seed is for
    // painting, not for deciding what the world sees. The read that confirms
    // the lists sets this, and setting `lists` re-runs the effect.
    if (!listsHeardFromServer.current) return;
    const list = lists.find((entry) => entry.id === expandedList);
    if (!list?.publicShareId) return;
    // The pending set, not the loading flag. The flag went false when the
    // four-second deadline elapsed, not when the papers landed, so this guard
    // released while reads were still in flight — and a sync that fires then
    // republishes the list short, which is the thing the guard exists to stop.
    if (pendingPaperIds.size > 0 || metadataError) return;

    // `listPaperId` ALONGSIDE the paper's own id, never over it: the public
    // copy is joined on the stored id (R8), but the paper's identity lives in
    // its own id — the legacy adapter folds the arXiv id in there and emits no
    // `arxivId`, so overwriting it strips the identity on the way out. A paper
    // whose metadata never arrived has no title to publish.
    const papers = (list.paperIds || [])
      .map((paperId) => {
        const paper = getPaper(paperId);
        return paper?.title && paper.title !== paperId
          ? { ...paper, listPaperId: paperId }
          : null;
      })
      .filter(Boolean);

    const publishedCount = publicSnapshots[list.id]?.paperCount;
    const behind = Number.isInteger(publishedCount) && publishedCount! < papers.length;
    if (!listNeedsPublicSync(list) && !behind) return;

    // One request per state of the list, however many renders it causes.
    const signature = `${toEpochMillis(list.updatedAt)}:${publishedCount ?? '?'}:${papers.length}`;
    if (queuedSyncs.current.get(list.id) === signature) return;
    queuedSyncs.current.set(list.id, signature);

    queuePublicListSync({
      key: publicListSyncKey(user.uid, list.id),
      shareId: list.publicShareId,
      listId: list.id,
      title: list.name,
      description: list.description,
      language: 'en',
      // Advisory only — the Worker reads the membership from the private list.
      paperIds: list.paperIds || [],
      papers: papers as PublicPaperInput[],
    });
  }, [
    expandedList, getPaper, language, lists, metadataError, pendingPaperIds,
    publicSnapshots, user,
  ]);

  const papersCount = (count: number) => `${count} ${count === 1 ? 'paper' : 'papers'}`;

  // One motion vocabulary for the two views of this page: the index and an
  // open list cross-fade with a small vertical step instead of swapping DOM in
  // a single frame.
  const rowMotion = {
    layout: true,
    exit: { opacity: 0, transform: 'translateX(18px)' },
    transition: { duration: 0.2, ease: EASE_OUT },
  };
  const cardMotion = {
    layout: true,
    exit: { opacity: 0, transform: 'scale(0.97)' },
    transition: { duration: 0.2, ease: EASE_OUT },
  };


  // Returning from a paper with { openListId }: until the effect above opens
  // it, hold a skeleton instead of flashing the index. Falls through to the
  // index if the list never shows up; closing the list clears the state, so
  // this cannot re-trap a closed list.
  // Derived, never stored: the placeholders must vanish the instant real cards
  // exist, and a stale `true` left over from a failed load is harmless — by
  // then the wait is already known to be long.
  const showListPlaceholders = placeholdersDue && loading && lists.length === 0;

  const targetOpenId = location.state?.openListId;
  const pendingOpen = Boolean(
    targetOpenId
    && !expandedList
    && (loading || displayLists.some((entry) => entry.id === targetOpenId)),
  );

  const deleteListTitle = deletingList ? `Delete "${deletingList.name}"?` : 'Delete this list?';
  const deleteListDescription = `Only the list goes: its papers stay saved with their notes and tags. ${deletingList?.publicShareId
    ? 'Its public link will stop working. '
    : ''}This cannot be undone.`;
  const confirmDeleteList = () => {
    handleDeleteList(deletingList!.id).catch((deleteError) => {
      console.error('Error deleting list:', deleteError);
      toastError('The list could not be deleted', { description: 'Try again.' });
    });
    setDeleteOpen(false);
  };

  return (
    <div className="lists-page">
      {/* Only on the index. This line reports the LIST COLLECTION refresh, and
          showing it over an open list put a second spinner on screen next to
          the one that was actually about the papers being looked at. */}
      {/* `lists.length === 0` as well: a revalidation running behind a grid the
          owner is already reading is not a loading state, and announcing it
          puts a spinner over a finished screen. Same rule as the save modal. */}
      {loading && !expandedList && lists.length === 0 && (
        <div className="lists-inline-status is-loading" aria-live="polite">
          <div className="lists-loading-spinner" />
          <span>{'Updating personal lists...'}</span>
        </div>
      )}
      {error && (
        // 'stalled' is not an alarm: the read behind it is still running and
        // can still refresh the cards on its own, so it keeps `aria-busy` and
        // stays out of `role="alert"`. Only a real refusal is an error.
        <div
          className={`lists-inline-status${error === 'LISTS_LOAD_STALLED' ? '' : ' is-error'}`}
          role={error === 'LISTS_LOAD_STALLED' ? 'status' : 'alert'}
          aria-busy={error === 'LISTS_LOAD_STALLED'}
        >
          <span>{getUiErrorMessage(error, 'LISTS_LOAD_FAILED')}</span>
          <button className="lists-retry-btn" onClick={() => setReloadToken(token => token + 1)}>
            {'Try again'}
          </button>
        </div>
      )}

      <AnimatePresence
        initial={false}
        mode="wait"
        custom={expandedList || pendingOpen ? 1 : -1}
        onExitComplete={() => { window.scrollTo({ top: 0, behavior: 'instant' }); setFoldersArrived(true); }}
      >
      {expandedList ? (
        <motion.div key="list" className="lists-expanded" {...listViewMotion}>
          {(() => {
            const list = displayLists.find((l) => l.id === expandedList);
            const backButton = (
              <Button
                variant="ghost"
                size="icon"
                className="lists-back-btn"
                onClick={closeExpandedList}
                aria-label={'Back to My lists'}
                title={'My lists'}
              >
                <ArrowLeft size={18} />
              </Button>
            );
            if (!list) return <div className="lists-expanded-bar">{backButton}</div>;
            const exportPapers = (list.paperIds || []).map(getPaper).filter(Boolean);
            // `listPaperId` from the first publish onwards: it becomes
            // `sourceId` on the public paper, and it is what lets every later
            // sync recognise this paper as one it already published.
            const publicPapers = (list.paperIds || [])
              .map(paperId => ({ paperId, paper: getPaper(paperId) }))
              .filter(({ paperId, paper }) => paper?.title && paper.title !== paperId)
              .map(({ paperId, paper }) => ({ ...paper, listPaperId: paperId }));
            const isCustomList = !PRIVATE_LIST_IDS.has(list.id);
            const listShareFeedback = shareFeedback?.listId === list.id ? shareFeedback : null;
            const shareBusy = listShareFeedback?.state === 'loading';
            const syncKey = user && isCustomList ? publicListSyncKey(user.uid, list.id) : null;
            const syncState = syncKey ? syncStates[syncKey] : null;
            const badgeState = publicBadgeState(syncState?.status);
            // How many papers of this list the public link does NOT carry.
            // The Worker's own count when we have it, the hydration gap when
            // we do not — never a guess dressed as a fact.
            const listTotal = (list.paperIds || []).length;
            const publishedCount = publicSnapshots[list.id]?.paperCount;
            const missingFromPublic = list.publicShareId
              ? Math.max(0, listTotal - (Number.isInteger(publishedCount)
                ? publishedCount!
                : publicPapers.length))
              : 0;
            const badgeLabel = {
              public: 'Public',
              syncing: 'Updating…',
              synced: 'Up to date',
              stale: 'Out of date',
            }[badgeState];
            return (
              <>
                <div className="lists-expanded-bar">{backButton}</div>
                <header
                  className={`lists-expanded-header${resolveListColor(list) ? '' : ' lists-expanded-header--uncoloured'}`}
                  style={resolveListColor(list) ? { '--list-accent': resolveListColor(list)! } : undefined}
                >
                  <div className="lists-expanded-titleblock">
                    <span className="lists-expanded-icon" aria-hidden="true">
                      {(() => {
                        const Icon = getIcon(list.emoji!);
                        return <Icon size={22} />;
                      })()}
                    </span>
                    <div className="lists-expanded-copy">
                      <h1 className="lists-expanded-title">{list.name} <span className="lists-expanded-count">({list.paperIds?.length ?? 0})</span></h1>
                    </div>
                  </div>
                  {(exportPapers.length > 0 || isCustomList) && (
                    <div className="lists-export-actions">
                      {exportPapers.length > 0 && (
                        <ListMenu
                          title={'Export citations'}
                          trigger={(
                            <Button variant="outline">
                              <DownloadSimple size={15} aria-hidden="true" />
                              {'Export'}
                              <CaretDown size={13} aria-hidden="true" />
                            </Button>
                          )}
                          actions={[
                            { id: 'bibtex', label: 'BibTeX (.bib)', hint: 'For LaTeX and BibTeX managers' },
                            { id: 'ris', label: 'RIS (.ris)', hint: 'For Zotero, EndNote and Mendeley' },
                          ].map(({ id, label, hint }) => ({ id, label, hint, Icon: DownloadSimple, onSelect: () => downloadCitationFile(exportPapers, id, `papertok-${list.name}`) }))}
                        />
                      )}
                      {isCustomList && (() => {
                        const listActions = [
                          ...([list.publicShareId
                            ? { id: 'share', label: 'Share', hint: 'Send or copy the public link', Icon: ShareNetwork, disabled: shareBusy, onSelect: () => handleShareList(list) }
                            : { id: 'publish', label: 'Publish & share', hint: 'Anyone with the link can read it', Icon: GlobeHemisphereWest, disabled: shareBusy || pendingPaperIds.size > 0, onSelect: () => handlePublishList(list, publicPapers) }]),
                          ...(list.publicShareId && !shareBusy
                            ? [{ id: 'unpublish', label: 'Stop sharing', hint: 'The public link stops working', Icon: LinkBreak, onSelect: () => handleUnpublishList(list) }]
                            : []),
                          { id: 'edit', label: 'Edit list', hint: 'Name, icon and colour', Icon: PencilSimple, onSelect: () => setEditing(list) },
                          { id: 'delete', label: 'Delete list', hint: 'Its papers stay saved', Icon: Trash, onSelect: () => { setDeletingList(list); setDeleteOpen(true); } },
                        ];
                        const trigger = (
                          <Button variant="outline" size="icon" aria-label={'List actions'}>
                            <DotsThree size={18} weight="bold" aria-hidden="true" />
                          </Button>
                        );
                        return <ListMenu title={'List actions'} trigger={trigger} actions={listActions} />;
                      })()}
                    </div>
                  )}
                </header>
                {isCustomList && (
                <p className="lists-expanded-meta">
                  {list.publicShareId ? (
                    <span
                      className={`lists-badge lists-badge--public is-${badgeState}`}
                      aria-live="polite"
                    >
                      {badgeState === 'syncing'
                        ? <span className="lists-badge-spinner" aria-hidden="true" />
                        : badgeState === 'synced'
                          ? <Check size={11} aria-hidden="true" />
                          : badgeState === 'stale'
                            ? <Warning size={11} aria-hidden="true" />
                            : <GlobeHemisphereWest size={11} aria-hidden="true" />}
                      {' '}{badgeLabel}
                    </span>
                  ) : (
                    <span className="lists-badge">
                      <Lock size={11} aria-hidden="true" /> {'Private'}
                    </span>
                  )}
                </p>
                )}
                {listShareFeedback && (
                  <div
                    className={`lists-share-status ${listShareFeedback.state === 'copy-error' ? 'is-error' : ''}`}
                    role={listShareFeedback.state === 'copy-error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {listShareFeedback.state === 'loading' && (
                      <><span className="lists-loading-spinner" /> {'Updating public link...'}</>
                    )}
                    {listShareFeedback.state === 'shared' && (
                      <span>{'Public link shared.'}</span>
                    )}
                    {listShareFeedback.state === 'success' && (
                      <>
                        <span>{listShareFeedback.copied
                          ? ('Public link copied.')
                          : ('Public link ready. Copy it from here:')}</span>
                        {listShareFeedback.url && <a href={listShareFeedback.url} target="_blank" rel="noopener noreferrer">{listShareFeedback.url}</a>}
                      </>
                    )}
                    {listShareFeedback.state === 'copy-error' && (
                      <>
                        <span>{'The link is public, but it could not be copied automatically.'}</span>
                        {listShareFeedback.url && <a href={listShareFeedback.url} target="_blank" rel="noopener noreferrer">{listShareFeedback.url}</a>}
                      </>
                    )}
                    {listShareFeedback.state === 'unpublished' && (
                      <span>{'The list is private again.'}</span>
                    )}
                  </div>
                )}
                {/* A sync only surfaces once it has already retried itself.
                    Nothing was lost when it does: the edit is in Firestore and
                    the list stays marked dirty, so opening it later would fix
                    this on its own — the button is here to save the wait. */}
                {list.publicShareId && syncState?.status === 'error' && (
                  <div className="lists-share-status is-error" role="alert">
                    <span>{getUiErrorMessage(syncState.code, 'PUBLIC_LIST_SYNC_FAILED')}</span>
                    <button className="lists-retry-btn" onClick={() => retryPublicListSync(syncKey)}>
                      {'Try again'}
                    </button>
                  </div>
                )}
                {/* The number the owner had to open a second account to
                    discover. A public copy shorter than the list is a fact
                    worth saying out loud, not a discrepancy to be found. */}
                {isCustomList && (list.publicShareId
                  ? missingFromPublic > 0 && (
                    <p className="lists-share-limit-note">
                      {`${missingFromPublic} of ${listTotal} papers are not in the public link yet.`}
                      {listTotal > PUBLIC_LIST_LIMITS.papers && (` Public links include up to ${PUBLIC_LIST_LIMITS.papers} papers.`)}
                    </p>
                  )
                  : publicPapers.length < listTotal && (
                    <p className="lists-share-limit-note">
                      {`Publishing would include ${publicPapers.length} of ${listTotal} papers: the rest have no details saved yet.`}
                    </p>
                  ))}
                {/* No spinner here. The skeleton rows below ARE the loading
                    state — they say the same thing in the shape of the content
                    that is coming, and they do not move the layout when it
                    lands. The announcement they used to borrow from this line
                    now lives on the papers container itself. */}
                {metadataError && (
                  <div className="lists-metadata-status is-error" role="alert">
                    <span>{getUiErrorMessage(metadataError, 'LIST_METADATA_LOAD_FAILED')}</span>
                    <button className="lists-retry-btn" onClick={() => { void openList(list, true); }}>
                      {'Try again'}
                    </button>
                  </div>
                )}
                <div
                  className="lists-expanded-papers"
                  aria-busy={pendingPaperIds.size > 0 ? 'true' : undefined}
                  aria-label={pendingPaperIds.size > 0
                    ? ('Loading papers in this list...')
                    : undefined}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                  {(list.paperIds || []).map((paperId) => {
                    const paper = getPaper(paperId);
                    const record = personalLibrary[paperId];
                    if (!paper) return (
                      // While metadata is in flight the row is a shimmer with
                      // the finished row's silhouette; the status line above
                      // carries the accessible announcement.
                      <motion.div
                        {...rowMotion}
                        key={paperId}
                        className="list-row lists-paper-item--skeleton"
                        aria-hidden={pendingPaperIds.has(paperId) ? 'true' : undefined}
                      >
                        {/* This paper's own id, not the list's loading flag.
                            The flag went false at the deadline while the read
                            behind it was still running, so every row still in
                            flight fell through to its raw id. */}
                        {pendingPaperIds.has(paperId) ? (
                          // Three bars, not two, and each the height of the line
                          // it stands in for: the field label, the title, the
                          // authors. The old two-bar silhouette measured ~79px
                          // against a finished row's ~100–140px, so the moment
                          // the metadata landed every row in the list grew at
                          // once and the page shoved itself down.
                          <div className="lists-paper-skeleton">
                            <span className="lists-skeleton-bar lists-skeleton-bar--cat" />
                            <span className="lists-skeleton-bar lists-skeleton-bar--title" />
                            <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
                          </div>
                        ) : (
                          <p className="list-row-title lists-paper-placeholder">
                            {'The title could not be loaded'}
                          </p>
                        )}
                      </motion.div>
                    );
                    return (
                      <PaperListRow {...rowMotion} key={paperId}
                        paper={paper}
                        onOpen={() => openPaperCard(paper)}
                        actions={(
                          <>
                          {/* The stored id, not the merged paper's: the list
                              and the library key this paper by `paperId`, and
                              the modal's membership check and note record
                              must look under the same key (R8: ids differ by
                              entry route). */}
                          {isPhone ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-haspopup="dialog"
                              aria-label={`Actions for ${paper.title}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRowSheet({ listId: list.id, listName: list.name, paperId, paper });
                                setRowSheetStep('menu');
                                setRowSheetOpen(true);
                              }}
                            >
                              <DotsThree size={20} weight="bold" aria-hidden="true" />
                            </Button>
                          ) : (
                            <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={(e) => { e.stopPropagation(); onEditPaper?.({ ...paper, id: paperId } as Paper); }}
                              aria-label={'Edit note and tags'}
                              title={'Edit note and tags'}
                            >
                              <PencilSimple size={16} aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRemoving({ listId: list.id, listName: list.name, paperId, paper });
                                setRemovalOpen(true);
                              }}
                              aria-label={'Remove from list'}
                              title={'Remove from list'}
                            >
                              <Trash size={16} aria-hidden="true" />
                            </Button>
                            </>
                          )}
                          </>
                        )}
                      >
                          {(paper.authors?.length ?? 0) > 0 && (
                            <ListRowAuthors
                              paper={paper}
                              onNavigate={() => {
                                if (expandedList) void navigate(location.pathname, { replace: true, state: { openListId: expandedList } });
                              }}
                            />
                          )}
                          {(record?.tags?.length as number) > 0 && (
                            <div className="lists-paper-tags">
                              {record.tags!.map((tag) => <span key={tag}>{tag}</span>)}
                            </div>
                          )}
                          {record?.note && <ListNote note={record.note} />}
                      </PaperListRow>
                    );
                  })}
                  </AnimatePresence>
                  {(!list.paperIds || list.paperIds.length === 0) && (
                    <EmptyState
                      as="h3"
                      art={<Petri pose="blankPage" className="lists-empty-petri" />}
                      title={'This list is empty'}
                    >
                      {'Add papers to it from the feed with "Save and organize".'}
                    </EmptyState>
                  )}
                </div>
              </>
            );
          })()}
        </motion.div>
      ) : pendingOpen ? (
        <motion.div
          key="list"
          {...listViewMotion}
          className="lists-opening"
          aria-busy="true"
          aria-label={'Opening list...'}
        >
          {/* The same three-bar rhythm the finished rows have, so opening a
              list settles into its content instead of swapping silhouettes. */}
          {[0, 1, 2, 3].map((slot) => (
            <div key={slot} className="lists-skeleton-row">
              <span className="lists-skeleton-bar lists-skeleton-bar--cat" />
              <span className="lists-skeleton-bar lists-skeleton-bar--title" />
              <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
            </div>
          ))}
        </motion.div>
      ) : (
        <motion.div key="index" {...listViewMotion}>
          <header className="lists-header">
            <div className="lists-header-row">
              <h1>{'My lists'}</h1>
              <Button className="lists-create-btn" onClick={() => setCreating(true)}>
                <Plus size={16} aria-hidden="true" />
                {'New list'}
              </Button>
            </div>
            <p>{'Organize, annotate and share the papers you keep.'}</p>
          </header>
          <div className="lists-grid">
            <AnimatePresence initial={false} mode="popLayout">
            {displayLists.map((list, index) => {
              const isCustomList = !PRIVATE_LIST_IDS.has(list.id);
              const accent = resolveListColor(list);
              const behindIds = (list.paperIds || []).slice(0, 2).reverse();
              const isNew = list.id === createdListId;
              return (
              <motion.div
                {...cardMotion}
                initial={isNew ? { opacity: 0, transform: 'scale(0.97)' } : false}
                animate={{ opacity: 1, transform: 'scale(1)' }}
                transition={isNew ? { ...cardMotion.transition, delay: 0.14 } : cardMotion.transition}
                key={list.id}
                className={`list-card${accent ? '' : ' list-card--uncoloured'}${foldersArrived || isNew ? '' : ' list-card--arrive'}`}
                onClick={() => enterList(list)}
                style={{ ...(accent && { '--list-accent': accent }), '--arrive-index': Math.min(index, 3) }}
              >
                <div className="list-card-preview">
                  <svg className="list-card-folder" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={FOLDER_BACK} /></svg>
                  {behindIds.map((paperId, index) => {
                    const paper = getPaper(paperId);
                    const category = paper?.categories?.[0];
                    return (
                      <div key={paperId} className="list-card-sheet" data-pos={index + 2 - behindIds.length} aria-hidden="true">
                        {category && <span className="list-card-sheet-cat">{getCategoryLabel(category)}</span>}
                        {paper?.title && <span className="list-card-sheet-title"><ScientificText>{paper.title}</ScientificText></span>}
                      </div>
                    );
                  })}
                  <div className="list-card-cover">
                    <svg className="list-card-pocket" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={FOLDER_POCKET} vectorEffect="non-scaling-stroke" /></svg>
                    <h3 className="list-card-name">
                      <button
                        type="button"
                        className="list-card-name-btn"
                        onClick={(e) => { e.stopPropagation(); enterList(list); }}
                      >
                        {list.name}
                      </button>
                    </h3>
                    {(list.paperIds?.length ?? 0) === 0 && (
                      <p className="list-card-preview-empty">{'Nothing saved yet.'}</p>
                    )}
                    <div className="list-card-footer">
                      <span className="list-card-count">
                        {papersCount(list.paperIds?.length || 0)}
                        {(list.paperIds?.length ?? 0) > 0 && timeAgo(list.updatedAt as Parameters<typeof timeAgo>[0], locale) && ` · Updated ${timeAgo(list.updatedAt as Parameters<typeof timeAgo>[0], locale)}`}
                      </span>
                      {list.publicShareId && (
                        <span className="lists-badge lists-badge--public">
                          <GlobeHemisphereWest size={11} aria-hidden="true" /> {'Public'}
                        </span>
                      )}
                    </div>
                    {isCustomList && (
                      <div className="list-card-tools">
                        <button
                          className="list-card-tool"
                          onClick={(e) => { e.stopPropagation(); setEditing(list); }}
                          aria-label={`Edit ${list.name}`}
                          title={'Edit list'}
                        >
                          <PencilSimple size={13} aria-hidden="true" />
                        </button>
                        <button
                          className="list-card-tool list-card-tool--danger"
                          onClick={(e) => { e.stopPropagation(); setDeletingList(list); setDeleteOpen(true); }}
                          aria-label={`Delete ${list.name}`}
                          title={'Delete list'}
                        >
                          <Trash size={13} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
              );
            })}
            </AnimatePresence>
            {showListPlaceholders && [0, 1].map((slot) => (
              <div
                key={`list-placeholder-${slot}`}
                className="list-card list-card--placeholder"
                aria-hidden="true"
              >
                <div className="list-card-preview">
                  <svg className="list-card-folder" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={FOLDER_BACK} /></svg>
                  <div className="list-card-cover">
                    <svg className="list-card-pocket" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={FOLDER_POCKET} vectorEffect="non-scaling-stroke" /></svg>
                    <span className="lists-skeleton-bar lists-skeleton-bar--title" />
                    <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* The card for a saved paper that has no public paper page — see
          `openPaperCard`. Same takeover the search and the explorer use,
          painted from the stored copy, with the feed's own actions wired so a
          like or a read here lands where one from the feed would. */}
      <PaperOverlay
        open={Boolean(overlayPaper)}
        onClose={closeOverlayPaper}
        onExitComplete={() => setShownPaper(null)}
       
        label={'Paper details'}
      >
        {shownPaper && (
          <PaperCard
            paper={shownPaper}
            isLiked={likedPaperIds.has(interactionIdFor(shownPaper)!)}
            isSaved={savedPaperIds.has(interactionIdFor(shownPaper)!)}
            isRead={readPaperIds.has(interactionIdFor(shownPaper)!)}
            onLike={toggleLike}
            onNotInterested={(paper) => { void markNotInterested(paper); closeOverlayPaper(); }}
            onMarkAsRead={markAsRead}
            onUnmarkAsRead={forgetRead}
            onOpenPdf={(paper) => onOpenPdf?.(paper)}
            onSaveToList={(paper) => onEditPaper?.(paper)}
            getInteractionState={getInteractionState}
            trackViewTime={trackViewTime}
            trackSkip={trackSkip}
          />
        )}
      </PaperOverlay>

      {/* Outside the AnimatePresence on purpose: Edit is reachable from a card
          in the grid AND from inside an open list, and a window that lived in
          one branch would unmount the moment the other took over. */}
      {isPhone && (
        <Drawer
          open={rowSheetOpen}
          onOpenChange={(nextOpen, eventDetails) => {
            if (!nextOpen && rowSheetStep === 'edit' && editGuardRef.current) {
              editGuardRef.current(eventDetails);
              return;
            }
            setRowSheetOpen(nextOpen);
          }}
          onOpenChangeComplete={(isOpen) => {
            if (!isOpen) { setRowSheet(null); setRowSheetStep('menu'); editGuardRef.current = null; }
          }}
        >
          <DrawerContent className={`pc-share-sheet lists-row-sheet${rowSheetStep === 'edit' ? ' save-modal--sheet' : ''}`}>
            <DrawerHandle />
            <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={rowSheetStep}
              ref={setRowSheetStepRef}
              initial={{
                opacity: 0,
                filter: prefersReducedMotion ? 'none' : 'blur(4px)',
                transform: prefersReducedMotion ? 'translateY(0px)' : 'translateY(16px)',
              }}
              animate={{
                opacity: 1,
                filter: prefersReducedMotion ? 'none' : 'blur(0px)',
                transform: 'translateY(0px)',
                transition: { duration: 0.24, ease: EASE_DRAWER },
              }}
              exit={{
                opacity: 0,
                filter: prefersReducedMotion ? 'none' : 'blur(4px)',
                transition: { duration: 0.16, ease: EASE_OUT },
              }}
            >
              {rowSheetStep === 'menu' ? (
                <>
                  <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{'More actions'}</DrawerTitle>
                  <ul className="pc-share-list">
                    <li>
                      <button type="button" className="pc-share-row" onClick={() => switchRowSheetStep('edit')}>
                        <PencilSimple size={20} aria-hidden="true" />
                        {'Edit note and tags'}
                      </button>
                    </li>
                    <li>
                      <button type="button" className="pc-share-row" onClick={() => switchRowSheetStep('remove')}>
                        <Trash size={20} aria-hidden="true" />
                        {'Remove from list'}
                      </button>
                    </li>
                  </ul>
                </>
              ) : rowSheetStep === 'edit' ? (
                <SaveToListModal
                  embedded
                  paper={{ ...rowSheet!.paper, id: rowSheet!.paperId } as Paper}
                  closeGuardRef={editGuardRef}
                  onClose={() => setRowSheetOpen(false)}
                />
              ) : (
                <div className="lists-remove-sheet">
                  <Petri pose="letGo" className="lists-remove-petri" />
                  <DrawerTitle render={<h3 />} className="lists-remove-title">
                    {`Remove from ${rowSheet?.listName || 'this list'}?`}
                  </DrawerTitle>
                  <p className="lists-remove-paper"><ScientificText>{rowSheet?.paper?.title || ''}</ScientificText></p>
                  <div className="lists-remove-actions">
                    <DrawerClose ref={rowSheetCancelRef} render={<Button variant="outline" />}>{'Cancel'}</DrawerClose>
                    <Button onClick={() => { removePaper(rowSheet!); setRowSheetOpen(false); }}>{'Remove'}</Button>
                  </div>
                </div>
              )}
            </motion.div>
            </AnimatePresence>
          </DrawerContent>
        </Drawer>
      )}

      <AlertDialog
        open={removalOpen}
        onOpenChange={setRemovalOpen}
        onOpenChangeComplete={(isOpen) => { if (!isOpen) setRemoving(null); }}
      >
        <AlertDialogContent className="lists-remove-dialog">
          <Petri pose="letGo" className="lists-remove-petri" />
          <AlertDialogTitle>{`Remove from ${removing?.listName || 'this list'}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            <ScientificText>{removing?.paper?.title || ''}</ScientificText>
          </AlertDialogDescription>
          <div className="lists-remove-actions">
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <Button onClick={() => { removePaper(removing!); setRemovalOpen(false); }}>
              {'Remove'}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {isPhone ? (
        <Drawer
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onOpenChangeComplete={(isOpen) => { if (!isOpen) setDeletingList(null); }}
        >
          <DrawerContent className="pc-share-sheet">
            <DrawerHandle />
            <div className="lists-remove-sheet lists-delete-sheet">
              <Petri pose="letGo" className="lists-remove-petri" />
              <DrawerTitle render={<h3 />} className="lists-remove-title">{deleteListTitle}</DrawerTitle>
              <p className="lists-remove-paper">{deleteListDescription}</p>
              <div className="lists-remove-actions">
                <DrawerClose render={<Button variant="outline" />}>{'Cancel'}</DrawerClose>
                <Button onClick={confirmDeleteList}>{'Delete'}</Button>
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <AlertDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onOpenChangeComplete={(isOpen) => { if (!isOpen) setDeletingList(null); }}
        >
          <AlertDialogContent className="lists-remove-dialog lists-delete-dialog">
            <Petri pose="letGo" className="lists-remove-petri" />
            <AlertDialogTitle>{deleteListTitle}</AlertDialogTitle>
            <AlertDialogDescription>{deleteListDescription}</AlertDialogDescription>
            <div className="lists-remove-actions">
              <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
              <Button onClick={confirmDeleteList}>{'Delete'}</Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <CreateListDialog
        open={creating}
       
        onClose={() => setCreating(false)}
        onCreate={handleCreateList}
      />
      <CreateListDialog
        open={Boolean(editing)}
       
        list={editing}
        onClose={() => setEditing(null)}
        onSave={handleEditList}
      />
    </div>
  );
}
