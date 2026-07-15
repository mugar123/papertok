import { useState, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove, setDoc } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { getIcon, AVAILABLE_ICONS } from '../../utils/icons';
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
  const { markSaved } = useFeed();
  const [lists, setLists] = useState([]);
  const [paperLists, setPaperLists] = useState(new Set());
  const [newListName, setNewListName] = useState('');
  const [newListIcon, setNewListIcon] = useState('Folder');
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef(null);

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

  const handleClose = () => { dialogRef.current?.close(); onClose(); };

  return (
    <dialog ref={dialogRef} className="save-modal-dialog" onClose={handleClose}
      onClick={(e) => { if (e.target === dialogRef.current) handleClose(); }}>
      <div className="save-modal glass-strong">
        <div className="save-modal-header">
          <h2>Guardar en lista</h2>
          <button className="save-modal-close" onClick={handleClose}>✕</button>
        </div>
        <p className="save-modal-paper-title">{paper.title}</p>

        {loading ? (
          <div className="save-modal-loading">Cargando listas...</div>
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
