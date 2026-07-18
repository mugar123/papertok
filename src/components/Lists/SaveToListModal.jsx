import { useState, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove, setDoc } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
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
  const { markSaved, personalLibrary, toggleReadLater, saveReadingMetadata } = useFeed();
  const [lists, setLists] = useState([]);
  const [paperLists, setPaperLists] = useState(new Set());
  const [newListName, setNewListName] = useState('');
  const [newListIcon, setNewListIcon] = useState('Folder');
  const [loading, setLoading] = useState(true);
  const initialRecord = personalLibrary[paper.id] || {};
  const [note, setNote] = useState(initialRecord.note || '');
  const [tags, setTags] = useState((initialRecord.tags || []).join(', '));
  const [metadataSaved, setMetadataSaved] = useState(false);
  const dialogRef = useRef(null);
  const libraryRecord = personalLibrary[paper.id] || {};

  useEffect(() => {
    if (!user) return;

    const loadLists = async () => {
      try {
        let userLists = [];
        const inLists = new Set();

        if (IS_DEMO) {
          userLists = demoGet('lists', []);
          userLists.forEach((list) => {
            if (list.paperIds && list.paperIds.includes(paper.id)) {
              inLists.add(list.id);
            }
          });
        } else {
          const listsRef = collection(db, 'users', user.uid, 'lists');
          const snapshot = await getDocs(listsRef);
          snapshot.forEach((doc) => {
            const data = doc.data();
            userLists.push({ id: doc.id, ...data });
            if (data.paperIds && data.paperIds.includes(paper.id)) {
              inLists.add(doc.id);
            }
          });
        }
        setLists(userLists);
        setPaperLists(inLists);
      } catch (err) {
        console.error('Error loading lists:', err);
      } finally {
        setLoading(false);
      }
    };
    loadLists();
  }, [user, paper.id]);

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
      arxivId: paper.arxivId, summary: paper.summary?.substring(0, 500),
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
            arxivId: paper.arxivId, summary: paper.summary?.substring(0, 500),
            savedAt: new Date().toISOString(),
          }, { merge: true });
        }
      } catch (err) {
        console.error('Error updating list:', err);
      }
    }
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
      }
    }

    setLists((prev) => [...prev, newList]);
    setPaperLists((prev) => new Set([...prev, listId]));
    markSaved(paper);
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

  return (
    <dialog ref={dialogRef} className="save-modal-dialog" onClose={handleClose}
      onClick={(e) => { if (e.target === dialogRef.current) handleClose(); }}>
      <div className="save-modal glass-strong">
        <div className="save-modal-header">
          <h2>Guardar y organizar</h2>
          <button className="save-modal-close" onClick={handleClose}>✕</button>
        </div>
        <p className="save-modal-paper-title">{paper.title}</p>

        <section className="save-modal-personal" aria-label="Herramientas personales de lectura">
          <button
            className={`save-modal-read-later ${libraryRecord.readLater ? 'active' : ''}`}
            onClick={() => toggleReadLater(paper)}
            aria-pressed={Boolean(libraryRecord.readLater)}
          >
            <BookOpen size={19} />
            <span>
              <strong>{libraryRecord.readLater ? 'En Leer después' : 'Añadir a Leer después'}</strong>
              <small>{libraryRecord.readLater ? 'Guardado en tu cola personal' : 'Reserva este paper para otro momento'}</small>
            </span>
          </button>

          <label className="save-modal-field">
            <span><StickyNote size={16} /> Nota privada</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ideas, dudas o conclusiones..."
              maxLength={3000}
            />
          </label>
          <label className="save-modal-field">
            <span><Tags size={16} /> Etiquetas</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="tesis, revisar, metodología"
            />
            <small>Sepáralas con comas</small>
          </label>
          <div className="save-modal-personal-actions">
            <button className="save-modal-metadata-btn" onClick={handleSaveMetadata}>
              {metadataSaved ? 'Guardado' : 'Guardar nota y etiquetas'}
            </button>
            <div className="save-modal-export" aria-label="Exportar cita">
              <button onClick={() => downloadCitationFile([paper], 'bibtex', 'papertok-paper')} title="Exportar BibTeX">
                <Download size={15} /> BibTeX
              </button>
              <button onClick={() => downloadCitationFile([paper], 'ris', 'papertok-paper')} title="Exportar RIS">
                <Download size={15} /> RIS
              </button>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="save-modal-loading">Cargando listas...</div>
        ) : (
          <div className="save-modal-lists">
            <p className="save-modal-section-title">Listas personalizadas</p>
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
              <p className="save-modal-empty">Aún no tienes listas. ¡Crea una!</p>
            )}
          </div>
        )}

        <div className="save-modal-create">
          <div className="save-modal-emoji-picker">
            {AVAILABLE_ICONS.map((iconName) => {
              const Icon = getIcon(iconName);
              return (
                <button key={iconName}
                  className={`save-modal-emoji-btn ${newListIcon === iconName ? 'active' : ''}`}
                  onClick={() => setNewListIcon(iconName)}>
                  <Icon size={20} strokeWidth={1.5} />
                </button>
              );
            })}
          </div>
          <div className="save-modal-create-row">
            <input type="text" placeholder="Nueva lista..." value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
              className="save-modal-input" />
            <button className="save-modal-create-btn" onClick={handleCreateList}
              disabled={!newListName.trim()}>Crear</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
