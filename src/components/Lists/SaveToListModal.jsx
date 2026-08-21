import { useEffect, useMemo, useRef, useState } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove, setDoc, limit, query } from 'firebase/firestore';
import { patientRead } from '../../utils/boundedRead';
import { OWN_LISTS_PAGE_SIZE } from '../../services/userProfileService';
import { readOwnLists } from '../../utils/ownLists';
import {
  commitTagInput,
  diffListSelection,
  hasUnsavedChanges,
  removeTag,
} from '../../utils/saveOrganizeModel.js';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { getIcon, AVAILABLE_ICONS } from '../../utils/icons';
import ScientificText from '../ScientificText.js';
import { BookOpen, Check, Download, Plus, StickyNote, Tags, X } from 'lucide-react';
import { downloadCitationFile } from '../../utils/readingLibrary';
import './SaveToListModal.css';

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
  const { isEnglish } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const {
    markSaved, personalLibrary, ensurePersonalLibrary, toggleReadLater, saveReadingMetadata,
  } = useFeed();

  // The note and tags for this paper live in the reading library, which is
  // loaded on demand rather than with the feed.
  useEffect(() => {
    void ensurePersonalLibrary?.();
  }, [ensurePersonalLibrary]);

  const [lists, setLists] = useState([]);
  // Three outcomes, three states. 'loading' and 'unavailable' are deliberately
  // not the same thing as an empty 'ready': "we could not find out" must never
  // render as "you have no lists", which is the lie this modal used to tell.
  const [listsStatus, setListsStatus] = useState('loading');
  const [listsAttempt, setListsAttempt] = useState(0);

  // Server truth vs what the UI shows. Save writes the diff, both directions.
  const [initialListIds, setInitialListIds] = useState(() => new Set());
  const [pendingListIds, setPendingListIds] = useState(() => new Set());

  // Drafts are null until the user edits the field; while null, the field
  // shows the library baseline. This is what lets a library record that lands
  // AFTER the modal opens fill an untouched field — the old version seeded
  // once at mount, showed empty, and saving would have replaced a real note
  // with nothing.
  const [noteDraft, setNoteDraft] = useState(null);
  const [tagsDraft, setTagsDraft] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [readLaterDraft, setReadLaterDraft] = useState(null);
  const touchedLists = useRef(false);

  const [newListName, setNewListName] = useState('');
  const [newListIcon, setNewListIcon] = useState('Folder');
  // The creation form stays folded behind its button until asked for.
  const [creatingList, setCreatingList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dialogRef = useRef(null);

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

  /**
   * The account's custom lists: a bounded page, `patientRead` for the stall,
   * and an emptiness that is only believed when the server said it (see the
   * history of this read in ownLists.js).
   */
  useEffect(() => {
    if (!user) return undefined;
    let active = true;

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

    const apply = ({ lists: userLists, inLists, authoritative }) => {
      if (!active) return;
      if (!authoritative) {
        setListsStatus('unavailable');
        return;
      }
      setLists(userLists);
      setInitialListIds(new Set(inLists));
      // A late answer (patientRead's onLateResult) must not wipe toggles the
      // user already made on an earlier answer's rows.
      if (!touchedLists.current) setPendingListIds(new Set(inLists));
      setListsStatus('ready');
    };

    patientRead(IS_DEMO ? fromDemo : fromFirestore, {
      attempts: 2,
      label: 'lists',
      onLateResult: apply,
    })
      .then(apply)
      .catch((err) => {
        console.error('Error loading lists:', err);
        if (active) setListsStatus('unavailable');
      });

    return () => { active = false; };
  }, [user, paper.id, listsAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
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
    touchedLists.current = true;
    setPendingListIds((previous) => {
      const next = new Set(previous);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      return next;
    });
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

  const closeDialog = () => {
    dialogRef.current?.close();
    onClose();
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    closeDialog();
  };

  /* --- The two write sites, last by contract ------------------------------ */

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    const listId = `list_${Date.now()}`;
    // Created EMPTY: creating the list is this button's explicit act; the
    // paper joins it when Save commits the (auto-checked) selection.
    const newList = {
      id: listId, name: newListName.trim(), emoji: newListIcon,
      paperIds: [], createdAt: new Date().toISOString(),
    };

    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      allLists.push(newList);
      demoSet('lists', allLists);
    } else {
      try {
        const listRef = doc(db, 'users', user.uid, 'lists', listId);
        await setDoc(listRef, newList);
      } catch (err) {
        console.error('Error creating list:', err);
        return;
      }
    }

    setLists((previous) => [...previous, newList]);
    touchedLists.current = true;
    setPendingListIds((previous) => new Set([...previous, listId]));
    setNewListName('');
    setCreatingList(false);
  };

  const handleSave = async () => {
    if (saving || !dirty) return;
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
        // Sequential and retry-safe: arrayUnion of a present id and
        // arrayRemove of an absent one are no-ops, so a partial failure needs
        // no bookkeeping — pressing Save again redoes only what is missing.
        for (const listId of toAdd) {
          await updateDoc(doc(db, 'users', user.uid, 'lists', listId), { paperIds: arrayUnion(paper.id) });
        }
        for (const listId of toRemove) {
          await updateDoc(doc(db, 'users', user.uid, 'lists', listId), { paperIds: arrayRemove(paper.id) });
        }
        if (toAdd.length > 0) {
          markSaved(paper);
          // Every field null-coalesced: a paper arriving from a list row (the
          // pencil) carries fewer fields than one from the feed, and Firestore
          // rejects the whole write over a single `undefined`.
          await setDoc(doc(db, 'users', user.uid, 'savedPapers', paper.id), {
            title: paper.title ?? null,
            authors: paper.authors?.slice(0, 5) ?? null,
            primaryCategory: paper.primaryCategory ?? null,
            published: paper.published ?? null,
            arxivId: paper.arxivId ?? null,
            summary: (paper.summary || paper.abstract)?.substring(0, 500) ?? null,
            doi: paper.doi || null,
            landingPageUrl: paper.landingPageUrl || null,
            savedAt: new Date().toISOString(),
          }, { merge: true });
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
      setSaving(false);
    }
  };

  const copy = isEnglish ? {
    title: 'Save and organize',
    close: 'Close',
    saveTo: 'Save to',
    saveToHint: 'Applied when you press Save.',
    readLaterOn: 'In Read later',
    readLaterOff: 'Add to Read later',
    readLaterOnHint: 'Kept in your personal queue',
    readLaterOffHint: 'Keep this paper for another time',
    loadingLists: 'Loading lists...',
    listsUnavailable: 'Your lists could not be loaded. They are still there.',
    retry: 'Try again',
    noLists: 'No lists yet — create the first one right below.',
    newList: 'New list',
    newListCta: 'Create a new list',
    newListName: 'Name...',
    create: 'Create',
    cancel: 'Cancel',
    newListPrivacyNote: 'It starts private. Publish it from My lists once it has content.',
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
    title: 'Guardar y organizar',
    close: 'Cerrar',
    saveTo: 'Guardar en',
    saveToHint: 'Se aplica al pulsar Guardar.',
    readLaterOn: 'En Leer después',
    readLaterOff: 'Añadir a Leer después',
    readLaterOnHint: 'Guardado en tu cola personal',
    readLaterOffHint: 'Reserva este paper para otro momento',
    loadingLists: 'Cargando listas...',
    listsUnavailable: 'No se pudieron cargar tus listas. Siguen ahí.',
    retry: 'Reintentar',
    noLists: 'Aún no tienes listas: crea la primera aquí debajo.',
    newList: 'Nueva lista',
    newListCta: 'Crear nueva lista',
    newListName: 'Nombre...',
    create: 'Crear',
    cancel: 'Cancelar',
    newListPrivacyNote: 'Nace privada. Publícala desde Mis listas cuando tenga contenido.',
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
      className="save-modal-dialog"
      onClose={onClose}
      onCancel={(event) => {
        // Escape: through the same guard as every other close path.
        event.preventDefault();
        requestClose();
      }}
      onClick={(e) => { if (e.target === dialogRef.current) requestClose(); }}
    >
      <div className="save-modal glass-strong">
        <div className="save-modal-header">
          <h2>{copy.title}</h2>
          <button
            className="save-modal-close"
            onClick={requestClose}
            aria-label={copy.close}
          >✕</button>
        </div>
        {/* The same KaTeX pass the feed uses: a title like "$p$-adic
            $\text{GL}_n$" must not render as raw dollar signs here. */}
        <p className="save-modal-paper-title"><ScientificText>{paper.title}</ScientificText></p>

        <section className="save-modal-destinations" aria-label={copy.saveTo}>
          <div className="save-modal-section-head">
            <p className="save-modal-section-title">{copy.saveTo}</p>
            <p className="save-modal-section-hint">{copy.saveToHint}</p>
          </div>

          <button
            className={`save-modal-read-later ${pendingReadLater ? 'active' : ''}`}
            onClick={toggleReadLaterSelection}
            aria-pressed={pendingReadLater}
          >
            <BookOpen size={19} />
            <span>
              <strong>{pendingReadLater ? copy.readLaterOn : copy.readLaterOff}</strong>
              <small>{pendingReadLater ? copy.readLaterOnHint : copy.readLaterOffHint}</small>
            </span>
          </button>

          {listsStatus === 'loading' ? (
            <div className="save-modal-lists" aria-busy="true" aria-label={copy.loadingLists}>
              <div className="save-modal-list-skeleton" />
              <div className="save-modal-list-skeleton" />
            </div>
          ) : listsStatus === 'unavailable' ? (
            <div className="save-modal-loading" role="status">
              {copy.listsUnavailable}
              <button
                className="save-modal-retry"
                onClick={() => { setListsStatus('loading'); setListsAttempt((n) => n + 1); }}
              >
                {copy.retry}
              </button>
            </div>
          ) : (
            <div className="save-modal-lists">
              {lists.map((list) => {
                const selected = pendingListIds.has(list.id);
                return (
                  <label key={list.id} className={`save-modal-list-item${selected ? ' is-selected' : ''}`}>
                    <input type="checkbox" checked={selected}
                      onChange={() => toggleListSelection(list.id)} />
                    <span className="save-modal-checkbox" aria-hidden="true">
                      <Check size={14} strokeWidth={3.5} />
                    </span>
                    <span className="save-modal-list-emoji">
                      {(() => {
                        const Icon = getIcon(list.emoji);
                        return <Icon size={20} strokeWidth={1.5} />;
                      })()}
                    </span>
                    <span className="save-modal-list-name">{list.name}</span>
                    <span className="save-modal-list-count">{list.paperIds?.length || 0}</span>
                  </label>
                );
              })}
              {lists.length === 0 && (
                <p className="save-modal-empty">{copy.noLists}</p>
              )}
            </div>
          )}

          {!creatingList ? (
            <button
              type="button"
              className="save-modal-create-toggle"
              onClick={() => setCreatingList(true)}
            >
              <Plus size={16} aria-hidden="true" /> {copy.newListCta}
            </button>
          ) : (
            <div className="save-modal-create">
              <p className="save-modal-create-label" id="save-modal-icon-label">{copy.newList}</p>
              <div
                className="save-modal-emoji-picker"
                role="radiogroup"
                aria-labelledby="save-modal-icon-label"
              >
                {AVAILABLE_ICONS.map((iconName) => {
                  const Icon = getIcon(iconName);
                  return (
                    <button key={iconName}
                      type="button"
                      role="radio"
                      aria-checked={newListIcon === iconName}
                      aria-label={iconName}
                      className={`save-modal-emoji-btn ${newListIcon === iconName ? 'active' : ''}`}
                      onClick={() => setNewListIcon(iconName)}>
                      <Icon size={20} strokeWidth={1.5} />
                    </button>
                  );
                })}
              </div>
              <div className="save-modal-create-row">
                <input type="text" placeholder={copy.newListName} value={newListName}
                  autoFocus
                  onChange={(e) => setNewListName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateList();
                    if (e.key === 'Escape') {
                      // Folding the form is not closing the modal: keep the
                      // Escape from turning into the dialog's cancel event.
                      e.preventDefault();
                      e.stopPropagation();
                      setCreatingList(false);
                      setNewListName('');
                    }
                  }}
                  className="save-modal-input" />
                <button className="save-modal-create-btn" onClick={handleCreateList}
                  disabled={!newListName.trim()}>{copy.create}</button>
                <button
                  type="button"
                  className="save-modal-create-cancel"
                  onClick={() => { setCreatingList(false); setNewListName(''); }}
                >
                  {copy.cancel}
                </button>
              </div>
              <p className="save-modal-create-note">{copy.newListPrivacyNote}</p>
            </div>
          )}
        </section>

        <section className="save-modal-personal" aria-label={copy.noteAndTags}>
          <div className="save-modal-section-head">
            <p className="save-modal-section-title">{copy.noteAndTags}</p>
            <p className="save-modal-section-hint">{copy.noteAndTagsHint}</p>
          </div>
          <label className="save-modal-field">
            <span><StickyNote size={16} /> {copy.privateNote}</span>
            <textarea
              value={note}
              onChange={(event) => editNote(event.target.value)}
              placeholder={copy.notePlaceholder}
              maxLength={3000}
            />
          </label>
          <div className="save-modal-field">
            <span id="save-modal-tags-label"><Tags size={16} /> {copy.tags}</span>
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
                    <X size={12} strokeWidth={2.5} />
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

        <div className="save-modal-footer">
          <span className="save-modal-footer-label">{copy.exportCitation}</span>
          <div className="save-modal-export">
            <button onClick={() => downloadCitationFile([paper], 'bibtex', 'papertok-paper')} title="BibTeX">
              <Download size={15} /> BibTeX
            </button>
            <button onClick={() => downloadCitationFile([paper], 'ris', 'papertok-paper')} title="RIS">
              <Download size={15} /> RIS
            </button>
          </div>
        </div>

        <div className="save-modal-savebar">
          {saveError && <p className="save-modal-save-error" role="alert">{copy.saveFailed}</p>}
          {confirmingDiscard && dirty ? (
            <div className="save-modal-discard" role="alert">
              <p>{copy.discardTitle}</p>
              <div className="save-modal-discard-actions">
                <button type="button" className="save-modal-discard-btn" onClick={closeDialog}>
                  {copy.discard}
                </button>
                <button
                  type="button"
                  className="save-modal-keep-btn"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  {copy.keepEditing}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="save-modal-save-btn"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? copy.saving : copy.save}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
