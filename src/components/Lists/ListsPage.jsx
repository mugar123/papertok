import { useState, useEffect } from 'react';
import { IS_DEMO, db } from '../../services/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { getCategoryLabel } from '../../data/categories';
import { getIcon } from '../../utils/icons';
import { EyeOff } from 'lucide-react';
import './ListsPage.css';

function demoGet(key, fallback) {
  try { const v = localStorage.getItem(`papertok_${key}`); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

export default function ListsPage({ onOpenPdf }) {
  const { user } = useAuth();
  const { unmarkAsRead } = useFeed();
  const [lists, setLists] = useState([]);
  const [savedPapers, setSavedPapers] = useState({});
  const [expandedList, setExpandedList] = useState(null);
  const [loading, setLoading] = useState(true);

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
          const { collection, getDocs } = await import('firebase/firestore');
          const listsRef = collection(db, 'users', user.uid, 'lists');
          const listsSnapshot = await getDocs(listsRef);
          listsSnapshot.forEach((doc) => { userLists.push({ id: doc.id, ...doc.data() }); });

          const papersRef = collection(db, 'users', user.uid, 'savedPapers');
          const papersSnapshot = await getDocs(papersRef);
          papersSnapshot.forEach((doc) => { papers[doc.id] = { id: doc.id, ...doc.data() }; });

          const interactionsRef = collection(db, 'users', user.uid, 'interactions');
          const intSnapshot = await getDocs(interactionsRef);
          intSnapshot.forEach((doc) => {
            const data = doc.data();
            if (data.liked) {
              likedPaperIds.push(doc.id);
              if (!papers[doc.id]) {
                papers[doc.id] = { id: doc.id, title: data.paperTitle || doc.id,
                  authors: data.paperAuthors || [], primaryCategory: data.paperCategory || '',
                  published: data.timestamp, arxivId: doc.id };
              }
            }
            if (data.read) {
              readPaperIds.push(doc.id);
              if (!papers[doc.id]) {
                papers[doc.id] = { id: doc.id, title: data.paperTitle || doc.id,
                  authors: data.paperAuthors || [], primaryCategory: data.paperCategory || '',
                  published: data.timestamp, arxivId: doc.id };
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
    if (listId === '__favorites__' || listId === '__read__') return;
    if (IS_DEMO) {
      const allLists = demoGet('lists', []).filter((l) => l.id !== listId);
      localStorage.setItem('papertok_lists', JSON.stringify(allLists));
    } else {
      const { doc, deleteDoc } = await import('firebase/firestore');
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

  const formatDate = (dateStr) => {
    try { return new Date(dateStr).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return ''; }
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
            const list = lists.find((l) => l.id === expandedList);
            if (!list) return null;
            return (
              <>
                <h2 className="lists-expanded-title">
                  {(() => {
                    const Icon = getIcon(list.emoji);
                    return <Icon size={24} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' }} />;
                  })()}
                  {list.name}
                </h2>
                <div className="lists-expanded-papers">
                  {(list.paperIds || []).map((paperId) => {
                    const paper = savedPapers[paperId];
                    if (!paper) return (
                      <div key={paperId} className="lists-paper-item">
                        <p className="lists-paper-title">{paperId}</p>
                      </div>
                    );
                    return (
                      <div key={paperId} className="lists-paper-item"
                        onClick={() => onOpenPdf({ ...paper, arxivId: paper.arxivId || paper.id })}>
                        <div className="lists-paper-item-content">
                          {paper.primaryCategory && (
                            <span className="lists-paper-cat">{getCategoryLabel(paper.primaryCategory)}</span>
                          )}
                          <p className="lists-paper-title">{paper.title}</p>
                          {paper.authors && (
                            <p className="lists-paper-authors">
                              {paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 && ' et al.'}
                            </p>
                          )}
                          {paper.published && <span className="lists-paper-date">{formatDate(paper.published)}</span>}
                        </div>
                        {list.id === '__read__' && (
                          <button 
                            className="lists-paper-unmark-btn"
                            onClick={(e) => handleUnmarkAsRead(e, paperId)}
                            title="Devolver al feed"
                          >
                            <EyeOff size={18} />
                          </button>
                        )}
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
      ) : (
        <div className="lists-grid">
          {lists.map((list) => (
            <div key={list.id} className="list-card glass" onClick={() => setExpandedList(list.id)}>
              <div className="list-card-top">
                <span className="list-card-emoji">
                  {(() => {
                    const Icon = getIcon(list.emoji);
                    return <Icon size={32} strokeWidth={1.5} />;
                  })()}
                </span>
                {list.id !== '__favorites__' && (
                  <button className="list-card-delete" onClick={(e) => { e.stopPropagation(); handleDeleteList(list.id); }}
                    title="Eliminar lista">✕</button>
                )}
              </div>
              <h3 className="list-card-name">{list.name}</h3>
              <span className="list-card-count">{list.paperIds?.length || 0} papers</span>
              {list.paperIds && list.paperIds.length > 0 && (
                <div className="list-card-preview">
                  {list.paperIds.slice(0, 2).map((paperId) => {
                    const paper = savedPapers[paperId];
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
