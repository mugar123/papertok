import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove, serverTimestamp, setDoc, limit, query } from 'firebase/firestore';
import { isReadTimeout, patientRead } from '../../utils/boundedRead';
import { OWN_LISTS_PAGE_SIZE } from '../../services/userProfileService';
import {
  listsHolding, mergeCreatedLists, readOwnLists, withPaperMembership,
} from '../../utils/ownLists';
import { queuePublicListSync } from '../../services/publicListSync.js';
import { publicListSyncKey } from '../../utils/publicListFreshness.js';
import {
  commitTagInput,
  diffListSelection,
  EMPTY_LIST_INTENT,
  hasUnsavedChanges,
  removeTag,
  resolveSelection,
  toggleListIntent,
} from '../../utils/saveOrganizeModel.js';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { getIcon } from '../../utils/icons';
import CreateListDialog from './CreateListDialog.jsx';
import ScientificText from '../ScientificText.js';
import { BookOpen, Check, Download, Plus, StickyNote, Tags, X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { downloadCitationFile } from '../../utils/readingLibrary';
import { buildSavedPaperPayload } from '../../utils/savedPaperPayload.js';
import {
  ownListsAreFresh,
  ownListsCache,
  rememberOwnLists,
  reviseOwnLists,
} from '../../utils/profileSessionCaches.js';
import { readStoredLists, saveStoredLists } from '../../utils/userScopedStorage.js';
import './SaveToListModal.css';

/** Kept in step with the exit animation in SaveToListModal.css. */
const DIALOG_EXIT_MS = 160;

/**
 * States where the lists are still on their way. 'slow' and 'offline' keep the
 * skeleton and the read behind it: only 'unavailable' is the screen giving up.
 */
const LISTS_WAITING = ['loading', 'slow', 'offline'];

/**
 * States where the skeleton has given way to words. 'stalled' is still a wait
 * — the retry loop runs behind it and `onLateResult` can still paint the
 * lists — but a skeleton with no end and no explanation reads as a hung
 * screen, so past the budget the modal says so and offers the button.
 */
const LISTS_STOPPED = ['stalled', 'unavailable'];

// Demo storage helpers
function demoGet(key, fallback) {
  try {
    const v = localStorage.getItem(`papertok_${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function demoSet(key, value) {
  localStorage.setItem(`papertok_${key}`, JSON.stringify(value));
}

/**
 * Confirm-on-save. Everything in this modal — list membership, Read later,
 * the note, the tags — is PENDING state until the one Save button commits it.
 * The old version mixed two save models in one window (checkboxes wrote
 * instantly, the note waited for its own button) and neither was the one a
 * person expects.
 *
 * Because nothing saves on touch, closing with pending changes must warn:
 * every close path (✕, backdrop, Escape) funnels through `requestClose`,
 * which swaps the save bar for a discard confirmation while changes exist.
 *
 * Structural contract, pinned by saveOrganizeModel.test.js: the ONLY
 * handlers that write are `handleCreateList` (its own explicit button; it
 * creates an EMPTY list — the paper joins it on Save) and `handleSave`, and
 * they are defined last, after every write-free handler.
 */
export default function SaveToListModal({ paper, onClose }) {
  const { user } = useAuth();
  const { language, isEnglish } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const {
    markSaved, personalLibrary, ensurePersonalLibrary, toggleReadLater, saveReadingMetadata,
  } = useFeed();

  // The note and tags for this paper live in the reading library, which is
  // loaded on demand rather than with the feed.
  useEffect(() => {
    void ensurePersonalLibrary?.();
  }, [ensurePersonalLibrary]);

  // Saving fifty papers in a row used to re-read all sixty list documents
  // fifty times, once per open, and that is what saturated: the reads pile up
  // on a channel already busy with a write per save to the same document.
  // The lists are the same lists every time, so the modal paints from the
  // session cache the profile screens already share, and revalidates behind
  // it. Membership is the one thing that is NOT cached — it is per paper, so
  // it is derived here from the cached lists.
  const seededLists = user?.uid
    ? (ownListsCache.get(user.uid) ?? readStoredLists(user.uid))
    : null;
  const seededMembership = useMemo(
    () => listsHolding(seededLists, paper.id),
    [seededLists, paper.id],
  );

  const [lists, setLists] = useState(() => seededLists ?? []);
  // Four outcomes, four states. 'loading', 'slow'/'offline' and 'unavailable'
  // are deliberately not the same thing as an empty 'ready': "we could not
  // find out" must never render as "you have no lists", which is the lie this
  // modal used to tell.
  const [listsStatus, setListsStatus] = useState(seededLists ? 'ready' : 'loading');
  const [listsAttempt, setListsAttempt] = useState(0);
  // Whether THIS open started from the cache: a failed revalidation behind a
  // painted view must stay quiet, the same rule the comment sheet follows.
  const openedSeeded = useRef(Boolean(seededLists));

  // Server truth, and — kept apart from it — what the user did to it. Save
  // writes the diff between the two, both directions.
  //
  // These used to be two full sets, and the second one froze the moment the
  // user touched any checkbox: a membership arriving after that first touch
  // updated `initial` while `pending` stayed on the stale snapshot, so every
  // list the fresh read knew about and the cache did not became a REMOVAL
  // nobody asked for. `listIntent` holds only the rows the user disagreed
  // with the account about; everything else follows the membership, however
  // late it lands. See saveOrganizeModel.js.
  const [initialListIds, setInitialListIds] = useState(() => new Set(seededMembership));
  const [listIntent, setListIntent] = useState(EMPTY_LIST_INTENT);

  // Drafts are null until the user edits the field; while null, the field
  // shows the library baseline. This is what lets a library record that lands
  // AFTER the modal opens fill an untouched field — the old version seeded
  // once at mount, showed empty, and saving would have replaced a real note
  // with nothing.
  const [noteDraft, setNoteDraft] = useState(null);
  const [tagsDraft, setTagsDraft] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [readLaterDraft, setReadLaterDraft] = useState(null);
  // Lists created in this window, kept so a read issued before they existed —
  // including a late answer from patientRead's healing loop — cannot take them
  // back off the screen and out of the shared cache. See mergeCreatedLists.
  const createdLists = useRef([]);

  // The creation form stays folded behind its button until asked for.
  const [creatingList, setCreatingList] = useState(false);
  const [saving, setSaving] = useState(false);
  // A ref beside the state, the same reason CreateListDialog keeps one: two
  // clicks can land before React re-renders and both would read a stale
  // `saving: false`. The list writes are idempotent, but `toggleReadLater` is
  // a toggle — running it twice puts Read later back where it started.
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [closing, setClosing] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const dialogRef = useRef(null);
  const closeTimer = useRef(null);

  // What the library says today: the dirty check and the save diff compare
  // against this, and untouched fields render it directly.
  const baseline = useMemo(() => {
    const record = personalLibrary[paper.id] || {};
    return {
      note: record.note || '',
      tags: record.tags || [],
      readLater: Boolean(record.readLater),
    };
  }, [personalLibrary, paper.id]);

  const note = noteDraft ?? baseline.note;
  const tags = tagsDraft ?? baseline.tags;
  const pendingReadLater = readLaterDraft ?? baseline.readLater;

  // The ticks on screen: never stored, always derived. `known` bounds the
  // user's own ticks to lists that still exist — a list deleted on another
  // device must not be written to — and deliberately never bounds the
  // membership, which is why it is only supplied once the rows are real.
  const knownListIds = useMemo(
    () => (listsStatus === 'ready' ? lists.map((list) => list.id) : null),
    [listsStatus, lists],
  );
  const pendingListIds = useMemo(() => resolveSelection({
    membership: initialListIds, ...listIntent, known: knownListIds,
  }), [initialListIds, listIntent, knownListIds]);

  /**
   * The account's custom lists: a bounded page, `patientRead` for the stall,
   * and an emptiness that is only believed when the server said it (see the
   * history of this read in ownLists.js).
   */
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    // The retry loop outlives the promise; closing the modal must end it.
    const controller = new AbortController();

    const fromDemo = () => {
      const stored = demoGet('lists', []);
      const inLists = new Set(stored
        .filter((list) => list.paperIds?.includes(paper.id))
        .map((list) => list.id));
      return { lists: stored, inLists, authoritative: true };
    };

    const fromFirestore = async () => readOwnLists(
      await getDocs(query(
        collection(db, 'users', user.uid, 'lists'),
        limit(OWN_LISTS_PAGE_SIZE),
      )),
      paper.id,
    );

    const apply = ({ lists: userLists, inLists, authoritative, cached = false }) => {
      if (!active) return;
      if (!authoritative) {
        setListsStatus('unavailable');
        return;
      }
      // A read issued before a list was created cannot contain it, and a late
      // answer can land minutes after the Create button was pressed. Merging
      // is what stops the snapshot from taking that list back off the screen
      // — and, worse, out of the shared cache stamped fresh on the next line.
      const merged = mergeCreatedLists(userLists, createdLists.current);
      setLists(merged);
      if (cached) reviseOwnLists(user?.uid, merged);
      else {
        rememberOwnLists(user?.uid, merged);
        saveStoredLists(user?.uid, merged);
      }
      // Only the membership moves. The ticks are derived from it plus what the
      // user did, so a late answer can no longer wipe a toggle, nor turn a
      // list it reveals into a removal.
      setInitialListIds(new Set(inLists));
      setListsStatus('ready');
    };

    /**
     * Inside the freshness window the cached lists ARE the answer, and this is
     * what stops a burst of saves from re-reading sixty documents per paper.
     *
     * It goes through the same pipeline rather than short-circuiting it, and
     * that is deliberate: membership is per paper, so opening the modal on a
     * second paper without a fresh `apply` would leave the FIRST paper's
     * checkboxes on screen. Feeding the cache in as an attempt keeps one path,
     * one `apply`, and no state set synchronously inside the effect.
     */
    const fromFreshCache = () => {
      const cached = ownListsCache.get(user.uid);
      // `cached: true` is what stops `apply` from renewing the freshness
      // window with data it did not fetch — otherwise the window would keep
      // extending itself and the lists would never be re-read at all.
      return {
        lists: cached, inLists: listsHolding(cached, paper.id),
        authoritative: true, cached: true,
      };
    };
    const readLists = IS_DEMO
      ? fromDemo
      : (ownListsAreFresh(user.uid) ? fromFreshCache : fromFirestore);

    patientRead(readLists, {
      attempts: 3,
      label: 'lists',
      signal: controller.signal,
      // A mute connection is a wait, not a verdict: saying the lists could not
      // be loaded, while the read behind it is still going, is the one thing
      // this screen must never do to somebody's own data.
      onSlow: (attemptNumber, info) => {
        if (active && !openedSeeded.current) setListsStatus(info?.offline ? 'offline' : 'slow');
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch((err) => {
        // A revalidation that failed behind a painted view keeps the view.
        if (active && openedSeeded.current) {
          console.warn('The lists could not be refreshed; the cached view stands', err);
          return;
        }
        if (isReadTimeout(err)) {
          // The budget is spent but the retry loop is not: say so, offer the
          // button, and keep `onLateResult` armed. An unlabelled skeleton that
          // never ends is indistinguishable from being hung, which is what
          // this state exists to stop.
          console.warn('The lists did not answer in time', err);
          if (active) setListsStatus('stalled');
          return;
        }
        console.error('Error loading lists:', err);
        if (active) setListsStatus('unavailable');
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [user, paper.id, listsAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  /* --- Write-free pending-state handlers --------------------------------- */

  // Editing anything is an implicit "keep editing": it dismisses the discard
  // prompt and clears a stale save error.
  const beginEdit = () => {
    setConfirmingDiscard(false);
    setSaveError(false);
  };

  const toggleListSelection = (listId) => {
    beginEdit();
    setListIntent((previous) => toggleListIntent(previous, listId, initialListIds));
  };

  const toggleReadLaterSelection = () => {
    beginEdit();
    setReadLaterDraft(!pendingReadLater);
  };

  const editNote = (value) => {
    beginEdit();
    setNoteDraft(value);
  };

  const commitPendingTag = () => {
    if (!tagInput.trim()) return;
    // `beginEdit` like every other editing handler: committing a chip with
    // Enter while the discard prompt is up is the user saying "keep editing",
    // and it must clear a stale save error too.
    beginEdit();
    setTagsDraft(commitTagInput(tags, tagInput));
    setTagInput('');
  };

  const removePendingTag = (tag) => {
    beginEdit();
    setTagsDraft(removeTag(tags, tag));
  };

  const onTagInputKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitPendingTag();
    } else if (event.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      removePendingTag(tags[tags.length - 1]);
    }
  };

  // A tag typed but not yet committed with Enter still counts: it joins the
  // save, and it counts as a change worth warning about.
  const effectiveTags = useMemo(() => commitTagInput(tags, tagInput), [tags, tagInput]);

  const dirty = useMemo(() => hasUnsavedChanges({
    initial: {
      listIds: [...initialListIds],
      note: baseline.note,
      tags: baseline.tags,
      readLater: baseline.readLater,
    },
    pending: {
      listIds: [...pendingListIds],
      note,
      tags: effectiveTags,
      readLater: pendingReadLater,
    },
  }), [initialListIds, pendingListIds, baseline, note, effectiveTags, pendingReadLater]);

  /* --- Close paths, all through the guard -------------------------------- */

  /**
   * Every close path lands here once the discard guard has already decided
   * the window can go.
   *
   * `.close()` before the parent unmounts us, always: the platform hands focus
   * back to the button that opened the dialog when it is closed, and not when
   * it is merely removed from the document.
   *
   * The window has to survive its own exit animation, so the close is held for
   * the length of it and the card is marked on the way out. A TIMER decides
   * when that is over, not `animationend`: under `prefers-reduced-motion` the
   * animation is `none`, no `animationend` ever fires, and a window waiting for
   * one would never close at all. Reduced motion skips the wait entirely.
   */
  const closeDialog = () => {
    if (closeTimer.current) return;
    if (prefersReducedMotion) {
      dialogRef.current?.close();
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      dialogRef.current?.close();
      onClose();
      setClosing(false);
    }, DIALOG_EXIT_MS);
  };

  const requestClose = () => {
    if (saving || closing || closeTimer.current) return;
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    closeDialog();
  };

  /* --- The two write sites, last by contract ------------------------------ */

  // The write, and only the write: CreateListDialog owns the form, the busy
  // state and the error. Letting this throw is what gives the owner a message —
  // it used to end at console.error, leaving an unchanged screen behind.
  const handleCreateList = async (name, icon, color) => {
    const listId = `list_${Date.now()}`;
    // Created EMPTY: creating the list is this button's explicit act; the
    // paper joins it when Save commits the (auto-checked) selection.
    const newList = {
      id: listId, name, emoji: icon, color,
      paperIds: [], createdAt: new Date().toISOString(),
    };

    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      allLists.push(newList);
      demoSet('lists', allLists);
    } else {
      const listRef = doc(db, 'users', user.uid, 'lists', listId);
      await setDoc(listRef, newList);
    }

    createdLists.current = [...createdLists.current, newList];
    setLists((previous) => mergeCreatedLists(previous, [newList]));
    // A list created here has to reach the cache too, or the next open inside
    // the freshness window would paint a list that no longer matches the
    // account. But ONLY when what is on screen is the account: this button is
    // live from the first frame, and writing `[...[], newList]` through while
    // the read was still on its way — or after it had failed — replaced every
    // screen's shared view of the collection with an array of one.
    if (listsStatus === 'ready') {
      reviseOwnLists(user?.uid, mergeCreatedLists(lists, [newList]));
      saveStoredLists(user?.uid, ownListsCache.get(user?.uid));
    }
    setListIntent((previous) => toggleListIntent(previous, listId, initialListIds));
  };

  const handleSave = async () => {
    if (savingRef.current || saving || !dirty) return;
    savingRef.current = true;
    const finalTags = effectiveTags;
    const { toAdd, toRemove } = diffListSelection([...initialListIds], [...pendingListIds]);
    const metadataChanged = note !== baseline.note
      || JSON.stringify(finalTags) !== JSON.stringify(baseline.tags);
    const readLaterChanged = pendingReadLater !== baseline.readLater;

    setSaving(true);
    setSaveError(false);
    try {
      if (IS_DEMO) {
        const allLists = demoGet('lists', []);
        for (const list of allLists) {
          if (toAdd.includes(list.id)) {
            list.paperIds = [...new Set([...(list.paperIds || []), paper.id])];
          }
          if (toRemove.includes(list.id)) {
            list.paperIds = (list.paperIds || []).filter(id => id !== paper.id);
          }
        }
        demoSet('lists', allLists);
        if (toAdd.length > 0) {
          markSaved(paper);
          const allSaved = demoGet('savedPapersData', {});
          allSaved[paper.id] = {
            title: paper.title, authors: paper.authors?.slice(0, 5),
            primaryCategory: paper.primaryCategory, published: paper.published,
            arxivId: paper.arxivId, summary: (paper.summary || paper.abstract)?.substring(0, 500),
            doi: paper.doi, landingPageUrl: paper.landingPageUrl,
          };
          demoSet('savedPapersData', allSaved);
        }
      } else {
        /**
         * The paper's document FIRST, before any list is told about it.
         *
         * The order used to be the other way round, and that is how a list ends
         * up holding an id with nothing behind it: the `arrayUnion` landed, the
         * `setDoc` was refused, and the row rendered as a bare arXiv id for
         * good — no later read can produce a document that was never written.
         * Writing the paper first means a refusal costs the owner an error
         * message and nothing else.
         *
         * Still sequential and still retry-safe: `setDoc` merges, `arrayUnion`
         * of a present id and `arrayRemove` of an absent one are no-ops, so
         * pressing Save again redoes only what is missing.
         */
        if (toAdd.length > 0) {
          markSaved(paper);
          await setDoc(
            doc(db, 'users', user.uid, 'savedPapers', paper.id),
            buildSavedPaperPayload(paper, new Date().toISOString()),
            { merge: true },
          );
        }

        // `updatedAt` rides along on every list write. It is what tells a
        // later visit that an edit happened here, so a sync lost to a closed
        // tab or a dead connection can still be found and replayed (P25).
        for (const listId of toAdd) {
          await updateDoc(doc(db, 'users', user.uid, 'lists', listId), {
            paperIds: arrayUnion(paper.id),
            updatedAt: serverTimestamp(),
          });
        }
        for (const listId of toRemove) {
          await updateDoc(doc(db, 'users', user.uid, 'lists', listId), {
            paperIds: arrayRemove(paper.id),
            updatedAt: serverTimestamp(),
          });
        }
        /**
         * Published lists rebuild their public copy from here, with no button
         * and no visit to Mis listas (P25).
         *
         * This modal has exactly one paper hydrated, which is why the sync
         * sends the membership separately: the ids are authoritative, and the
         * Worker keeps every other paper from the published document. A
         * whole-payload update from this screen would have published a list
         * of one and called it an update.
         *
         * Fire-and-forget on purpose — the queue lives outside React, so it
         * survives this dialog closing a moment from now.
         */
        for (const listId of [...toAdd, ...toRemove]) {
          const list = lists.find((entry) => entry.id === listId);
          if (!list?.publicShareId) continue;
          const added = toAdd.includes(listId);
          queuePublicListSync({
            key: publicListSyncKey(user.uid, listId),
            shareId: list.publicShareId,
            listId,
            title: list.name,
            description: list.description,
            language,
            paperIds: added
              ? [...new Set([...(list.paperIds || []), paper.id])]
              : (list.paperIds || []).filter((id) => id !== paper.id),
            // `listPaperId` is what the Worker joins on, and it is the id
            // this modal just wrote into `paperIds`. Explicit rather than
            // implied: the paper's own id must survive sanitizing intact.
            papers: added ? [{ ...paper, listPaperId: paper.id }] : [],
          });
        }
      }

      // The cache this modal paints from has to learn what the save just
      // wrote, or reopening on the same paper would show the checkbox as it
      // was BEFORE the save — a worse lie than the spinner the cache removes.
      if (user?.uid) {
        const cached = ownListsCache.get(user.uid);
        if (cached) {
          // `revise`, not `remember`: the lists were edited, not re-read, so
          // this must not renew the freshness window. A list created in this
          // window while the read had not landed is folded in here too, or the
          // membership just written would be recorded against a list the cache
          // has never heard of and silently dropped.
          reviseOwnLists(user.uid, withPaperMembership(
            mergeCreatedLists(cached, createdLists.current), paper.id,
            { added: toAdd, removed: toRemove },
          ));
          saveStoredLists(user.uid, ownListsCache.get(user.uid));
        }
      }

      if (readLaterChanged) await toggleReadLater(paper);
      if (metadataChanged) await saveReadingMetadata(paper, { note, tags: finalTags });

      toAdd.forEach(() => trackEvent('save_change', { action: 'add', surface: 'lists' }));
      toRemove.forEach(() => trackEvent('save_change', { action: 'remove', surface: 'lists' }));
      if (toAdd.length > 0) markActivation();

      closeDialog();
    } catch (err) {
      console.error('Save and organize could not commit everything:', err);
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const copy = isEnglish ? {
    kicker: 'This paper',
    title: 'Save and organize',
    close: 'Close',
    saveTo: 'Save to',
    saveToHint: 'Applied when you press Save.',
    readLaterOn: 'In Read later',
    readLaterOff: 'Add to Read later',
    readLaterOnHint: 'Kept in your personal queue',
    readLaterOffHint: 'Keep this paper for another time',
    loadingLists: 'Loading lists...',
    listsSlow: 'This is taking longer than usual. Still trying.',
    listsOffline: 'There seems to be no connection. Still trying.',
    listsStalled: 'Your lists are taking unusually long. We are still trying — your papers are safe.',
    listsUnavailable: 'Your lists could not be loaded. They are still there.',
    retry: 'Try again',
    noLists: 'No lists yet — create the first one right below.',
    newListCta: 'Create a new list',
    noteAndTags: 'Note and tags',
    noteAndTagsHint: 'Private to you.',
    privateNote: 'Private note',
    notePlaceholder: 'Ideas, questions, or conclusions...',
    tags: 'Tags',
    tagPlaceholder: 'Type a tag and press Enter',
    removeTagLabel: tag => `Remove ${tag}`,
    exportCitation: 'Export citation',
    save: 'Save',
    saving: 'Saving...',
    saveFailed: 'Not everything could be saved. Save again to retry what is missing.',
    discardTitle: 'You have unsaved changes.',
    discard: 'Discard',
    keepEditing: 'Keep editing',
  } : {
    kicker: 'Este paper',
    title: 'Guardar y organizar',
    close: 'Cerrar',
    saveTo: 'Guardar en',
    saveToHint: 'Se aplica al pulsar Guardar.',
    readLaterOn: 'En Leer después',
    readLaterOff: 'Añadir a Leer después',
    readLaterOnHint: 'Guardado en tu cola personal',
    readLaterOffHint: 'Reserva este paper para otro momento',
    loadingLists: 'Cargando listas...',
    listsSlow: 'Está tardando más de lo normal. Seguimos intentándolo.',
    listsOffline: 'Parece que no hay conexión. Seguimos intentándolo.',
    listsStalled: 'Tus listas están tardando muchísimo. Seguimos intentándolo — tus papers están a salvo.',
    listsUnavailable: 'No se pudieron cargar tus listas. Siguen ahí.',
    retry: 'Reintentar',
    noLists: 'Aún no tienes listas: crea la primera aquí debajo.',
    newListCta: 'Crear nueva lista',
    noteAndTags: 'Nota y etiquetas',
    noteAndTagsHint: 'Solo tú los ves.',
    privateNote: 'Nota privada',
    notePlaceholder: 'Ideas, dudas o conclusiones...',
    tags: 'Etiquetas',
    tagPlaceholder: 'Escribe una etiqueta y pulsa Enter',
    removeTagLabel: tag => `Quitar ${tag}`,
    exportCitation: 'Exportar cita',
    save: 'Guardar',
    saving: 'Guardando...',
    saveFailed: 'No se pudo guardar todo. Vuelve a Guardar para reintentar lo que falta.',
    discardTitle: 'Tienes cambios sin guardar.',
    discard: 'Descartar',
    keepEditing: 'Seguir editando',
  };

  return (
    <dialog
      ref={dialogRef}
      className={`save-modal-dialog${closing ? ' is-closing' : ''}`}
      onClose={(event) => event.stopPropagation()}
      onCancel={(event) => {
        // Escape: through the same guard as every other close path.
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onClick={(e) => { if (e.target === dialogRef.current) requestClose(); }}
    >
      <div className={`save-modal${closing ? ' is-closing' : ''}`}>
        <header className="save-modal-header">
          <div>
            <p className="save-modal-kicker">{copy.kicker}</p>
            <h2>{copy.title}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={requestClose}
            aria-label={copy.close}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        {/* The same KaTeX pass the feed uses: a title like "$p$-adic
            $\text{GL}_n$" must not render as raw dollar signs here. */}
        <p className="save-modal-paper-title"><ScientificText>{paper.title}</ScientificText></p>

        <div className="save-modal-body">
          <section className="save-modal-destinations" aria-label={copy.saveTo}>
            <div className="save-modal-section-head">
              <p className="save-modal-section-title">{copy.saveTo}</p>
              <p className="save-modal-section-hint">{copy.saveToHint}</p>
            </div>

            {/* Read later is a destination like any other, so it is the first
                row of the same ruled list rather than a card of its own. */}
            <div className="save-modal-rows">
              <button
                type="button"
                className={`save-modal-row${pendingReadLater ? ' is-selected' : ''}`}
                onClick={toggleReadLaterSelection}
                aria-pressed={pendingReadLater}
              >
                <span className="save-modal-tick" aria-hidden="true">
                  <Check size={13} strokeWidth={3} />
                </span>
                <BookOpen className="save-modal-row-icon" size={18} strokeWidth={1.5} aria-hidden="true" />
                <span className="save-modal-row-text">
                  <span className="save-modal-row-name">
                    {pendingReadLater ? copy.readLaterOn : copy.readLaterOff}
                  </span>
                  <span className="save-modal-row-hint">
                    {pendingReadLater ? copy.readLaterOnHint : copy.readLaterOffHint}
                  </span>
                </span>
              </button>
            </div>

            {LISTS_WAITING.includes(listsStatus) ? (
              <div className="save-modal-rows" aria-busy="true" aria-label={copy.loadingLists}>
                <div className="save-modal-skeleton" />
                <div className="save-modal-skeleton" />
                {listsStatus !== 'loading' && (
                  <p className="save-modal-notice" role="status">
                    {listsStatus === 'offline' ? copy.listsOffline : copy.listsSlow}
                  </p>
                )}
              </div>
            ) : LISTS_STOPPED.includes(listsStatus) ? (
              // 'stalled' keeps `aria-busy`: the read behind it is still going
              // and can still paint the lists without anybody pressing anything.
              // 'unavailable' is the verdict, and there the button is the only
              // way forward.
              <div className="save-modal-notice" role="status" aria-busy={listsStatus === 'stalled'}>
                <span>{listsStatus === 'stalled' ? copy.listsStalled : copy.listsUnavailable}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setListsStatus('loading'); setListsAttempt((n) => n + 1); }}
                >
                  {copy.retry}
                </Button>
              </div>
            ) : (
              <div className="save-modal-rows">
                {lists.map((list) => {
                  const selected = pendingListIds.has(list.id);
                  const Icon = getIcon(list.emoji);
                  return (
                    <label key={list.id} className={`save-modal-row${selected ? ' is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        className="save-modal-row-input"
                        checked={selected}
                        onChange={() => toggleListSelection(list.id)}
                      />
                      <span className="save-modal-tick" aria-hidden="true">
                        <Check size={13} strokeWidth={3} />
                      </span>
                      <Icon className="save-modal-row-icon" size={18} strokeWidth={1.5} aria-hidden="true" />
                      <span className="save-modal-row-text">
                        <span className="save-modal-row-name">{list.name}</span>
                      </span>
                      <span className="save-modal-count">{list.paperIds?.length || 0}</span>
                    </label>
                  );
                })}
                {lists.length === 0 && (
                  <p className="save-modal-empty">{copy.noLists}</p>
                )}
              </div>
            )}

            <Button
              variant="outline"
              className="w-full save-modal-create-toggle"
              onClick={() => setCreatingList(true)}
            >
              <Plus size={15} aria-hidden="true" /> {copy.newListCta}
            </Button>

            {/* Its own window over the save modal, not a box crammed inside it,
                and the same window the lists page opens. */}
            <CreateListDialog
              open={creatingList}
              isEnglish={isEnglish}
              onClose={() => setCreatingList(false)}
              onCreate={handleCreateList}
            />
          </section>

          <section className="save-modal-personal" aria-label={copy.noteAndTags}>
            <div className="save-modal-section-head">
              <p className="save-modal-section-title">{copy.noteAndTags}</p>
              <p className="save-modal-section-hint">{copy.noteAndTagsHint}</p>
            </div>
            <label className="save-modal-field">
              <span><StickyNote size={14} aria-hidden="true" /> {copy.privateNote}</span>
              <textarea
                value={note}
                onChange={(event) => editNote(event.target.value)}
                placeholder={copy.notePlaceholder}
                maxLength={3000}
              />
            </label>
            <div className="save-modal-field">
              <span id="save-modal-tags-label"><Tags size={14} aria-hidden="true" /> {copy.tags}</span>
              <div className="save-modal-tag-editor">
                {tags.map((tag) => (
                  <span key={tag} className="save-modal-tag-chip">
                    {tag}
                    <button
                      type="button"
                      className="save-modal-tag-remove"
                      onClick={() => removePendingTag(tag)}
                      aria-label={copy.removeTagLabel(tag)}
                    >
                      <X size={11} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                <input
                  className="save-modal-tag-input"
                  aria-labelledby="save-modal-tags-label"
                  value={tagInput}
                  placeholder={tags.length === 0 ? copy.tagPlaceholder : ''}
                  onChange={(event) => { beginEdit(); setTagInput(event.target.value); }}
                  onKeyDown={onTagInputKeyDown}
                  onBlur={commitPendingTag}
                />
              </div>
            </div>
          </section>

          {/* Rule 6: the utility group sits right, behind its own rule. */}
          <div className="save-modal-footer">
            <span className="save-modal-footer-label">{copy.exportCitation}</span>
            <div className="save-modal-export">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => downloadCitationFile([paper], 'bibtex', 'papertok-paper')}
              >
                <Download size={14} aria-hidden="true" /> BibTeX
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => downloadCitationFile([paper], 'ris', 'papertok-paper')}
              >
                <Download size={14} aria-hidden="true" /> RIS
              </Button>
            </div>
          </div>
        </div>

        <div className="save-modal-savebar">
          {saveError && <p className="save-modal-save-error" role="alert">{copy.saveFailed}</p>}
          {confirmingDiscard && dirty ? (
            <div className="save-modal-discard" role="alert">
              <p>{copy.discardTitle}</p>
              <div className="save-modal-discard-actions">
                <Button variant="outline" size="sm" onClick={closeDialog}>
                  {copy.discard}
                </Button>
                <Button size="sm" onClick={() => setConfirmingDiscard(false)}>
                  {copy.keepEditing}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="w-full"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? copy.saving : copy.save}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
