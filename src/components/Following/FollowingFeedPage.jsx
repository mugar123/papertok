import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, CheckCheck, Search } from 'lucide-react';
import FeedContainer from '../Feed/FeedContainer';
import { useFollowing } from '../../context/FollowingContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useLanguage } from '../../context/LanguageContext';
import { FOLLOWING_ORDER_STORAGE_KEY } from '../../utils/followingOrderStorage.js';
import {
  followingFirstLoadPending,
  mergeOrderedPapers,
  orderFollowingFeedPapers,
  orderKeysOf,
  resumeOrderedPapers,
} from '../../utils/followingFeed';
import './FollowingFeedPage.css';

// The order the page left with, as keys, in the tab's own storage: a reload
// of the tab (which it gives itself after a deploy, see main.jsx) keeps the
// items in localStorage but loses `lastOrder` below with the module, and a
// fresh ranking then moved the card the reader was on. sessionStorage, so a
// new tab still ranks afresh — and a reload the READER asked for clears it,
// which `utils/appReload.js` does before this module ever reads it.
const ORDER_STORAGE_KEY = FOLLOWING_ORDER_STORAGE_KEY;

function readStoredOrderKeys() {
  try {
    const keys = JSON.parse(sessionStorage.getItem(ORDER_STORAGE_KEY) || 'null');
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredOrderKeys(keys) {
  try {
    if (keys.length) sessionStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(keys));
    else sessionStorage.removeItem(ORDER_STORAGE_KEY);
  } catch {
    // A full or locked storage means the order lives only until the reload.
  }
}

/**
 * The Following feed: the same experience as For You (vertical cards, gestures,
 * actions, AI explanation) fed EXCLUSIVELY with papers proven to belong to a
 * followed author, topic, institution or project. Content selection lives in
 * followingUpdatesService (stable-id matching, dedupe across entities); this
 * page applies one relevance-and-diversity ranking across every follow and
 * hands it to the shared container, so no feed mechanics are duplicated.
 */
// The order the page left with, for the next mount to resume — module scope,
// because the page is remounted on every visit and the feed the reader left
// must be the feed they come back to (`resumeOrderedPapers`).
const lastOrder = { items: null, ordered: [] };
lastOrder.orderKeys = readStoredOrderKeys();

export default function FollowingFeedPage({ onOpenPdf, onSaveToList, onOpenComments = null }) {
  const navigate = useNavigate();
  const { isEnglish } = useLanguage();
  const { followedEntities } = useFollowing();
  const { items, seenIds, loading, refreshing, error, lastUpdatedAt, refresh, markSeen } = useFollowingUpdates();

  // Ranked on the first render, not in an effect after it: the state used to
  // start empty and be filled by an effect, so the page's first paint was the
  // "nothing new from what you follow" state for a frame, and the cards then
  // replaced it — the first of the pops the reader saw on entering.
  //
  // And resumed, not re-ranked: the order the reader left is the order they
  // come back to (`resumeOrderedPapers`), so the card they were on is still
  // where they left it and the container can scroll back to it. Ranking
  // captures the seen-set only when the item list itself changes: marking
  // cards as seen mid-scroll must never reshuffle under the thumb. A refresh
  // that lands while the cards are on screen keeps their order
  // (`mergeOrderedPapers`) and appends what is new.
  const [orderedPapers, setOrderedPapers] = useState(() => resumeOrderedPapers(lastOrder, items, seenIds));
  const lastItemsRef = useRef(items);
  useEffect(() => {
    if (lastItemsRef.current === items) return;
    lastItemsRef.current = items;
    setOrderedPapers(current => mergeOrderedPapers(current, orderFollowingFeedPapers(items, seenIds)));
  }, [items, seenIds]);
  useEffect(() => {
    lastOrder.items = items;
    lastOrder.ordered = orderedPapers;
    writeStoredOrderKeys(orderKeysOf(orderedPapers));
  }, [items, orderedPapers]);

  const hasFollows = followedEntities.length > 0;

  const emptyState = useMemo(() => hasFollows ? (
    <div className="ff-empty" role="status">
      <CheckCheck size={30} aria-hidden="true" />
      <h2>{isEnglish ? 'No new publications from what you follow' : 'No hay publicaciones nuevas de tus seguimientos'}</h2>
      <p>{isEnglish
        ? 'This feed collects recent work from what you follow and will update when new papers appear.'
        : 'La bandeja recoge trabajos recientes de lo que sigues y se actualizará cuando aparezcan.'}</p>
      <button className="feed-retry-btn" onClick={() => refresh()}>
        {isEnglish ? 'Check for updates' : 'Buscar novedades'}
      </button>
    </div>
  ) : (
    <div className="ff-empty" role="status">
      <BellRing size={30} aria-hidden="true" />
      <h2>{isEnglish
        ? 'You are not following any authors, topics, institutions, or projects yet'
        : 'Aún no sigues autores, temas, instituciones o proyectos'}</h2>
      <p>{isEnglish
        ? 'Follow anything from a paper or its page and its publications will appear here.'
        : 'Sigue cualquier entidad desde un paper o desde su página y sus publicaciones aparecerán aquí.'}</p>
      <div className="ff-empty-actions">
        <button className="feed-retry-btn" onClick={() => navigate('/')}>
          {isEnglish ? 'Discover papers' : 'Descubrir papers'}
        </button>
        <button className="feed-retry-btn ff-empty-secondary" onClick={() => navigate('/search')}>
          <Search size={15} aria-hidden="true" /> {isEnglish ? 'Search entities' : 'Buscar entidades'}
        </button>
      </div>
    </div>
  ), [hasFollows, isEnglish, navigate, refresh]);

  const source = useMemo(() => ({
    papers: orderedPapers,
    loading,
    // The first wait is For You's discovery screen, not a skeleton card: the
    // container reads this instead of guessing from `loading`, which is false
    // for the tick before the first refresh starts.
    initialLoadPending: followingFirstLoadPending({ items, loading, lastUpdatedAt, error }),
    error: error && orderedPapers.length === 0 ? 'FOLLOWING_LOAD_FAILED' : null,
    hasMore: false,
    loadMore: () => {},
    refresh,
    isRefreshing: refreshing,
    emptyState,
    showFollowReason: true,
    onPaperViewed: markSeen,
  }), [orderedPapers, items, loading, lastUpdatedAt, error, refresh, refreshing, emptyState, markSeen]);

  return (
    <FeedContainer
      onOpenPdf={onOpenPdf}
      onSaveToList={onSaveToList}
      onOpenComments={onOpenComments}
      source={source}
      scrollKey="following"
    />
  );
}
