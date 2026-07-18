import { useState, useEffect, useMemo } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { collection, getDocs, doc, deleteDoc, updateDoc, arrayRemove } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { getCategoryLabel } from '../../data/categories';
import { getIcon } from '../../utils/icons';
import { paperLegacyAdapter } from '../../models/Paper';
import { Download, Pencil, X } from 'lucide-react';
import { downloadCitationFile } from '../../utils/readingLibrary';
import './ListsPage.css';

function demoGet(key, fallback) {
  try { const v = localStorage.getItem(`papertok_${key}`); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

function demoSet(key, value) {
  try { localStorage.setItem(`papertok_${key}`, JSON.stringify(value)); }
  catch (err) { console.error('Error in demoSet', err); }
}



export default function ListsPage({ onOpenPdf, onEditPaper }) {
  const { user } = useAuth();
  const { unmarkAsRead, toggleLike, personalLibrary, toggleReadLater } = useFeed();
  const [lists, setLists] = useState([]);
  const [savedPapers, setSavedPapers] = useState({});
  const [expandedList, setExpandedList] = useState(null);
  const [loading, setLoading] = useState(true);

  const displayLists = useMemo(() => {
    const readLaterIds = Object.values(personalLibrary)
      .filter((record) => record.readLater)
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .map((record) => record.paperId);
    const normalized = lists.map((list) => list.id === '__read__'
      ? {
          ...list,
          name: 'Historial de lectura',
          paperIds: [...list.paperIds].sort((a, b) => new Date(personalLibrary[b]?.readAt || 0) - new Date(personalLibrary[a]?.readAt || 0)),
        }
      : list);
    const insertAt = Math.min(1, normalized.length);
    return [
      ...normalized.slice(0, insertAt),
      { id: '__read_later__', name: 'Leer después', emoji: 'BookOpen', paperIds: readLaterIds, createdAt: 'default' },
      ...normalized.slice(insertAt),
    ];
  }, [lists, personalLibrary]);

  const getPaper = (paperId) => savedPapers[paperId] || personalLibrary[paperId]?.paper;

  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      try {
        let userLists = [];
        let papers = {};
        let likedPaperIds = [];
        let readPaperIds = [];

        if (IS_DEMO) {
          userLists = demoGet('lists', []);
          papers = demoGet('savedPapersData', {});
          likedPaperIds = demoGet('likedPaperIds', []);
          readPaperIds = demoGet('readPaperIds', []);
        } else {
          const listsRef = collection(db, 'users', user.uid, 'lists');
          const listsSnapshot = await getDocs(listsRef);
          listsSnapshot.forEach((d) => { userLists.push({ id: d.id, ...d.data() }); });

          const papersRef = collection(db, 'users', user.uid, 'savedPapers');
          const papersSnapshot = await getDocs(papersRef);
          papersSnapshot.forEach((d) => { papers[d.id] = paperLegacyAdapter({ id: d.id, ...d.data() }); });

          const interactionsRef = collection(db, 'users', user.uid, 'interactions');
          const intSnapshot = await getDocs(interactionsRef);
          intSnapshot.forEach((doc) => {
            const data = doc.data();
            if (data.liked) {
              likedPaperIds.push(doc.id);
              if (!papers[doc.id]) {
                papers[doc.id] = paperLegacyAdapter({ id: doc.id, title: data.paperTitle || doc.id,
                  authors: data.paperAuthors || [], primaryCategory: data.paperCategory || '',
                  published: data.timestamp, arxivId: doc.id });
              }
            }
            if (data.read) {
              readPaperIds.push(doc.id);
              if (!papers[doc.id]) {
                papers[doc.id] = paperLegacyAdapter({ id: doc.id, title: data.paperTitle || doc.id,
                  authors: data.paperAuthors || [], primaryCategory: data.paperCategory || '',
                  published: data.timestamp, arxivId: doc.id });
              }
            }
          });
        }

        const allLists = [
          { id: '__favorites__', name: 'Favoritos', emoji: 'Heart',
            paperIds: likedPaperIds, createdAt: 'default' },
          { id: '__read__', name: 'Leídos', emoji: 'Eye',
            paperIds: readPaperIds, createdAt: 'default' },
          ...userLists,
        ];
        
        setLists(allLists);
        setSavedPapers(papers);
      } catch (err) {
        console.error('Error loading lists:', err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user]);

  const handleDeleteList = async (listId) => {
    if (listId === '__favorites__' || listId === '__read__' || listId === '__read_later__') return;
    if (IS_DEMO) {
      const allLists = demoGet('lists', []).filter((l) => l.id !== listId);
      localStorage.setItem('papertok_lists', JSON.stringify(allLists));
    } else {
      await deleteDoc(doc(db, 'users', user.uid, 'lists', listId));
    }
    setLists((prev) => prev.filter((l) => l.id !== listId));
    if (expandedList === listId) setExpandedList(null);
  };

  const handleUnmarkAsRead = (e, paperId) => {
    e.stopPropagation();
    unmarkAsRead(paperId);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__read__') {
        return { ...list, paperIds: list.paperIds.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleUnlike = async (e, paperId, paper) => {
    e.stopPropagation();
    await toggleLike(paper);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__favorites__') {
        return { ...list, paperIds: list.paperIds.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleRemoveFromCustomList = async (e, listId, paperId) => {
    e.stopPropagation();
    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      const idx = allLists.findIndex((l) => l.id === listId);
      if (idx !== -1) {
        allLists[idx].paperIds = (allLists[idx].paperIds || []).filter((id) => id !== paperId);
        demoSet('lists', allLists);
      }
    } else {
      try {
        const listRef = doc(db, 'users', user.uid, 'lists', listId);
        await updateDoc(listRef, { paperIds: arrayRemove(paperId) });
      } catch (err) {
        console.error('Error removing paper from custom list:', err);
      }
    }
    setLists((prev) => prev.map((list) => {
      if (list.id === listId) {
        return { ...list, paperIds: list.paperIds.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };



  if (loading) {
    return (
      <div className="lists-page">
        <div className="lists-loading">
          <div className="lists-loading-spinner" />
          <p>Cargando tus listas...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lists-page">
      <div className="lists-header"><h1>Mis Listas</h1></div>

      {expandedList ? (
        <div className="lists-expanded">
          <button className="lists-back-btn" onClick={() => setExpandedList(null)}>← Volver a listas</button>
          {(() => {
            const list = displayLists.find((l) => l.id === expandedList);
            if (!list) return null;
            const exportPapers = (list.paperIds || []).map(getPaper).filter(Boolean);
            return (
              <>
                <div className="lists-expanded-heading">
                  <h2 className="lists-expanded-title">
                    {(() => {
                      const Icon = getIcon(list.emoji);
                      return <Icon size={24} strokeWidth={2} />;
                    })()}
                    {list.name}
                  </h2>
                  {exportPapers.length > 0 && (
                    <div className="lists-export-actions">
                      <button onClick={() => downloadCitationFile(exportPapers, 'bibtex', `papertok-${list.name}`)}><Download size={16} /> BibTeX</button>
                      <button onClick={() => downloadCitationFile(exportPapers, 'ris', `papertok-${list.name}`)}><Download size={16} /> RIS</button>
                    </div>
                  )}
                </div>
                <div className="lists-expanded-papers">
                  {(list.paperIds || []).map((paperId) => {
                    const paper = getPaper(paperId);
                    const record = personalLibrary[paperId];
                    if (!paper) return (
                      <div key={paperId} className="lists-paper-item">
                        <p className="lists-paper-title">{paperId}</p>
                      </div>
                    );
                    return (
                      <div key={paperId} className="lists-paper-item"
                        onClick={() => onOpenPdf({ ...paper, arxivId: paper.arxivId || paper.id })}>
                        <div className="lists-paper-item-content">
                          {paper.categories && paper.categories.length > 0 && (
                            <span className="lists-paper-cat">{getCategoryLabel(paper.categories[0])}</span>
                          )}
                          <p className="lists-paper-title">{paper.title}</p>
                          {paper.authors && (
                            <p className="lists-paper-authors">
                              {paper.authors.slice(0, 3).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ')}{paper.authors.length > 3 && ' et al.'}
                            </p>
                          )}
                          {paper.year && <span className="lists-paper-date">{paper.year}</span>}
                          {record?.tags?.length > 0 && (
                            <div className="lists-paper-tags">
                              {record.tags.map((tag) => <span key={tag}>{tag}</span>)}
                            </div>
                          )}
                          {record?.note && <p className="lists-paper-note">{record.note}</p>}
                        </div>
                        <div className="lists-paper-actions">
                          <button className="lists-paper-edit-btn" onClick={(e) => { e.stopPropagation(); onEditPaper?.(paper); }} title="Editar nota y etiquetas">
                            <Pencil size={17} />
                          </button>
                          <button
                            className="lists-paper-unmark-btn"
                            onClick={(e) => {
                              if (list.id === '__read__') {
                                handleUnmarkAsRead(e, paperId);
                              } else if (list.id === '__favorites__') {
                                handleUnlike(e, paperId, paper);
                              } else if (list.id === '__read_later__') {
                                e.stopPropagation();
                                toggleReadLater(paper);
                              } else {
                                handleRemoveFromCustomList(e, list.id, paperId);
                              }
                            }}
                            title="Quitar de la lista"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {(!list.paperIds || list.paperIds.length === 0) && (
                    <p className="lists-empty-text">Esta lista está vacía</p>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ) : displayLists.length === 0 ? (
        <div className="lists-empty-state">
          <div className="lists-empty-state-icon">📚</div>
          <h3>Aún no tienes listas</h3>
          <p>Guarda papers o marca algunos como leídos para organizarlos aquí.</p>
        </div>
      ) : (
        <div className="lists-grid">
          {displayLists.map((list, idx) => (
            <div key={list.id} className="list-card glass" onClick={() => setExpandedList(list.id)} style={{ '--stagger-index': idx }}>
              <div className="list-card-top">
                <span className="list-card-emoji">
                  {(() => {
                    const Icon = getIcon(list.emoji);
                    return <Icon size={32} strokeWidth={1.5} />;
                  })()}
                </span>
                {!['__favorites__', '__read__', '__read_later__'].includes(list.id) && (
                  <button className="list-card-delete" onClick={(e) => { e.stopPropagation(); handleDeleteList(list.id); }}
                    title="Eliminar lista">✕</button>
                )}
              </div>
              <h3 className="list-card-name">{list.name}</h3>
              <span className="list-card-count">{list.paperIds?.length || 0} papers</span>
              {list.paperIds && list.paperIds.length > 0 && (
                <div className="list-card-preview">
                  {list.paperIds.slice(0, 2).map((paperId) => {
                    const paper = getPaper(paperId);
                    return <p key={paperId} className="list-card-preview-title">{paper?.title || paperId}</p>;
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
