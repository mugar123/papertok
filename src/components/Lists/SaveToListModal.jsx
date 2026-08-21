import { useState, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove, setDoc, limit, query } from 'firebase/firestore';
import { patientRead } from '../../utils/boundedRead';
import { OWN_LISTS_PAGE_SIZE } from '../../services/userProfileService';
import { readOwnLists } from '../../utils/ownLists';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { getIcon, AVAILABLE_ICONS } from '../../utils/icons';
import { BookOpen, Download, StickyNote, Tags } from 'lucide-react';
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

export default function SaveToListModal({ paper, onClose }) {
  const { user } = useAuth();
  const { isEnglish } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const {
    markSaved, personalLibrary, ensurePersonalLibrary, toggleReadLater, saveReadingMetadata,
  } = useFeed();

  // The note and tags for this paper live in the reading library, which is now
  // loaded on demand rather than with the feed.
  useEffect(() => {
    void ensurePersonalLibrary?.();
  }, [ensurePersonalLibrary]);
  const [lists, setLists] = useState([]);
  const [paperLists, setPaperLists] = useState(new Set());
  const [newListName, setNewListName] = useState('');
  const [newListIcon, setNewListIcon] = useState('Folder');
  // Three outcomes, three states. 'loading' and 'unavailable' are deliberately
  // not the same thing as an empty 'ready': "we could not find out" must never
  // render as "you have no lists", which is the lie this modal used to tell.
  const [listsStatus, setListsStatus] = useState('loading');
  const [listsAttempt, setListsAttempt] = useState(0);
  const initialRecord = personalLibrary[paper.id] || {};
  const [note, setNote] = useState(initialRecord.note || '');
  const [tags, setTags] = useState((initialRecord.tags || []).join(', '));
  const [metadataSaved, setMetadataSaved] = useState(false);
  const dialogRef = useRef(null);
  const libraryRecord = personalLibrary[paper.id] || {};

  /**
   * The account's custom lists.
   *
   * This read used to be the only one in the client with none of the three
   * guards the rest of the app grew, and it failed in both directions that
   * cost this app a bug before:
   *
   * - No bound. A stalled connection leaves `getDocs` pending forever and the
   *   modal sits on "Loading lists..." with no way out but a reload. Measured:
   *   a healthy read answers in 43-147 ms (p50 72), a stalled one never.
   * - No cache authority. With the backend unreachable, `getDocs` does not
   *   reject — it resolves against the in-memory cache, and on a fresh page
   *   that is an empty *success*. Measured: 0 documents, `fromCache: true`, in
   *   0.5 ms. Rendering that emptied the list picker for an account with four
   *   lists and invited the user to create one they already had.
   * - No ceiling. `collection(...)` raw, so an account with thousands of lists
   *   read all of them.
   *
   * So: a bounded page, `patientRead` for the stall, and an emptiness that is
   * only believed when the server is the one saying it.
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
      setPaperLists(inLists);
      setListsStatus('ready');
    };

    // No reset to 'loading' here: the state already starts there, and the retry
    // button is what puts it back before bumping the attempt counter.
    patientRead(IS_DEMO ? fromDemo : fromFirestore, {
      attempts: 2,
      label: 'lists',
      // A late answer still heals the picker with no user action.
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

  const savePaperMetadata = () => {
    if (!IS_DEMO) return;
    const allSaved = demoGet('savedPapersData', {});
    allSaved[paper.id] = {
      title: paper.title, authors: paper.authors?.slice(0, 5),
      primaryCategory: paper.primaryCategory, published: paper.published,
      arxivId: paper.arxivId, summary: (paper.summary || paper.abstract)?.substring(0, 500),
      doi: paper.doi, landingPageUrl: paper.landingPageUrl,
    };
    demoSet('savedPapersData', allSaved);
  };

  const handleToggleList = async (listId) => {
    const isInList = paperLists.has(listId);
    const newPaperLists = new Set(paperLists);
    if (isInList) newPaperLists.delete(listId);
    else newPaperLists.add(listId);
    setPaperLists(newPaperLists);

    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      const idx = allLists.findIndex((l) => l.id === listId);
      if (idx !== -1) {
        if (isInList) {
          allLists[idx].paperIds = (allLists[idx].paperIds || []).filter((id) => id !== paper.id);
        } else {
          allLists[idx].paperIds = [...(allLists[idx].paperIds || []), paper.id];
          markSaved(paper);
          savePaperMetadata();
        }
        demoSet('lists', allLists);
        setLists([...allLists]);
      }
    } else {
      try {
        const listRef = doc(db, 'users', user.uid, 'lists', listId);
        if (isInList) {
          await updateDoc(listRef, { paperIds: arrayRemove(paper.id) });
        } else {
          await updateDoc(listRef, { paperIds: arrayUnion(paper.id) });
          markSaved(paper);
          const savedRef = doc(db, 'users', user.uid, 'savedPapers', paper.id);
          await setDoc(savedRef, {
            title: paper.title, authors: paper.authors?.slice(0, 5),
            primaryCategory: paper.primaryCategory, published: paper.published,
            arxivId: paper.arxivId, summary: (paper.summary || paper.abstract)?.substring(0, 500),
            doi: paper.doi || null,
            landingPageUrl: paper.landingPageUrl || null,
            savedAt: new Date().toISOString(),
          }, { merge: true });
        }
      } catch (err) {
        console.error('Error updating list:', err);
        setPaperLists(paperLists);
        return;
      }
    }
    trackEvent('save_change', {
      action: isInList ? 'remove' : 'add',
      surface: 'lists',
    });
    if (!isInList) markActivation();
  };

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    const listId = `list_${Date.now()}`;
    const newList = {
      id: listId, name: newListName.trim(), emoji: newListIcon,
      paperIds: [paper.id], createdAt: new Date().toISOString(),
    };

    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      allLists.push(newList);
      demoSet('lists', allLists);
      savePaperMetadata();
    } else {
      try {
        const listRef = doc(db, 'users', user.uid, 'lists', listId);
        await setDoc(listRef, newList);
      } catch (err) {
        console.error('Error creating list:', err);
        return;
      }
    }

    setLists((prev) => [...prev, newList]);
    setPaperLists((prev) => new Set([...prev, listId]));
    markSaved(paper);
    trackEvent('save_change', { action: 'add', surface: 'lists' });
    markActivation();
    setNewListName('');
  };

  const handleSaveMetadata = async () => {
    await saveReadingMetadata(paper, {
      note,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    });
    setMetadataSaved(true);
    setTimeout(() => setMetadataSaved(false), 1800);
  };

  const handleClose = () => { dialogRef.current?.close(); onClose(); };

  // Two sections with two different save models, each saying which one it is:
  // destinations save on tap; the note and tags wait for their button. Before
  // this everything sat in one column and nothing said what saved when.
  return (
    <dialog ref={dialogRef} className="save-modal-dialog" onClose={handleClose}
      onClick={(e) => { if (e.target === dialogRef.current) handleClose(); }}>
      <div className="save-modal glass-strong">
        <div className="save-modal-header">
          <h2>{isEnglish ? 'Save and organize' : 'Guardar y organizar'}</h2>
          <button
            className="save-modal-close"
            onClick={handleClose}
            aria-label={isEnglish ? 'Close' : 'Cerrar'}
          >✕</button>
        </div>
        <p className="save-modal-paper-title">{paper.title}</p>

        <section className="save-modal-destinations" aria-label={isEnglish ? 'Save to' : 'Guardar en'}>
          <div className="save-modal-section-head">
            <p className="save-modal-section-title">{isEnglish ? 'Save to' : 'Guardar en'}</p>
            <p className="save-modal-section-hint">
              {isEnglish ? 'Changes here save instantly.' : 'Aquí los cambios se guardan al momento.'}
            </p>
          </div>

          <button
            className={`save-modal-read-later ${libraryRecord.readLater ? 'active' : ''}`}
            onClick={() => toggleReadLater(paper)}
            aria-pressed={Boolean(libraryRecord.readLater)}
          >
            <BookOpen size={19} />
            <span>
              <strong>{libraryRecord.readLater
                ? (isEnglish ? 'In Read later' : 'En Leer después')
                : (isEnglish ? 'Add to Read later' : 'Añadir a Leer después')}</strong>
              <small>{libraryRecord.readLater
                ? (isEnglish ? 'Saved in your personal queue' : 'Guardado en tu cola personal')
                : (isEnglish ? 'Keep this paper for another time' : 'Reserva este paper para otro momento')}</small>
            </span>
          </button>

          {listsStatus === 'loading' ? (
            <div className="save-modal-lists" aria-busy="true" aria-label={isEnglish ? 'Loading lists...' : 'Cargando listas...'}>
              <div className="save-modal-list-skeleton" />
              <div className="save-modal-list-skeleton" />
            </div>
          ) : listsStatus === 'unavailable' ? (
            <div className="save-modal-loading" role="status">
              {isEnglish
                ? 'Your lists could not be loaded. They are still there.'
                : 'No se pudieron cargar tus listas. Siguen ahí.'}
              <button
                className="save-modal-retry"
                onClick={() => { setListsStatus('loading'); setListsAttempt((n) => n + 1); }}
              >
                {isEnglish ? 'Try again' : 'Reintentar'}
              </button>
            </div>
          ) : (
            <div className="save-modal-lists">
              {lists.map((list) => (
                <label key={list.id} className="save-modal-list-item">
                  <input type="checkbox" checked={paperLists.has(list.id)}
                    onChange={() => handleToggleList(list.id)} />
                  <span className="save-modal-checkbox" />
                  <span className="save-modal-list-emoji">
                    {(() => {
                      const Icon = getIcon(list.emoji);
                      return <Icon size={20} strokeWidth={1.5} />;
                    })()}
                  </span>
                  <span className="save-modal-list-name">{list.name}</span>
                  <span className="save-modal-list-count">{list.paperIds?.length || 0}</span>
                </label>
              ))}
              {lists.length === 0 && (
                <p className="save-modal-empty">
                  {isEnglish
                    ? 'No lists yet — create the first one right below.'
                    : 'Aún no tienes listas: crea la primera aquí debajo.'}
                </p>
              )}
            </div>
          )}

          <div className="save-modal-create">
            <p className="save-modal-create-label" id="save-modal-icon-label">
              {isEnglish ? 'New list' : 'Nueva lista'}
            </p>
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
              <input type="text" placeholder={isEnglish ? 'Name...' : 'Nombre...'} value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
                className="save-modal-input" />
              <button className="save-modal-create-btn" onClick={handleCreateList}
                disabled={!newListName.trim()}>{isEnglish ? 'Create' : 'Crear'}</button>
            </div>
          </div>
        </section>

        <section className="save-modal-personal" aria-label={isEnglish ? 'Private note and tags' : 'Nota privada y etiquetas'}>
          <div className="save-modal-section-head">
            <p className="save-modal-section-title">{isEnglish ? 'Note and tags' : 'Nota y etiquetas'}</p>
            <p className="save-modal-section-hint">
              {isEnglish ? 'Private to you; saved with the button.' : 'Solo tú los ves; se guardan con el botón.'}
            </p>
          </div>
          <label className="save-modal-field">
            <span><StickyNote size={16} /> {isEnglish ? 'Private note' : 'Nota privada'}</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={isEnglish ? 'Ideas, questions, or conclusions...' : 'Ideas, dudas o conclusiones...'}
              maxLength={3000}
            />
          </label>
          <label className="save-modal-field">
            <span><Tags size={16} /> {isEnglish ? 'Tags' : 'Etiquetas'}</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={isEnglish ? 'thesis, review, methodology' : 'tesis, revisar, metodología'}
            />
            <small>{isEnglish ? 'Separate them with commas' : 'Sepáralas con comas'}</small>
          </label>
          <button className="save-modal-metadata-btn" onClick={handleSaveMetadata}>
            {metadataSaved
              ? (isEnglish ? 'Saved' : 'Guardado')
              : (isEnglish ? 'Save note and tags' : 'Guardar nota y etiquetas')}
          </button>
        </section>

        <div className="save-modal-footer">
          <span className="save-modal-footer-label">{isEnglish ? 'Export citation' : 'Exportar cita'}</span>
          <div className="save-modal-export">
            <button onClick={() => downloadCitationFile([paper], 'bibtex', 'papertok-paper')} title={isEnglish ? 'Export BibTeX' : 'Exportar BibTeX'}>
              <Download size={15} /> BibTeX
            </button>
            <button onClick={() => downloadCitationFile([paper], 'ris', 'papertok-paper')} title={isEnglish ? 'Export RIS' : 'Exportar RIS'}>
              <Download size={15} /> RIS
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
