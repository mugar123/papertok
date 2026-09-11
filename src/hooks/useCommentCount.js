import { useEffect, useState } from 'react';
import { fetchCommentCount } from '../services/commentService.js';
import { localThreadKeys } from '../services/threadAnchorClient.js';

/**
 * How many comments a paper has, shown on the card's own Comments button
 * before the thread is ever opened.
 *
 * The count endpoint that already exists at the edge cannot serve this: its
 * cache is unbound (`wrangler.toml`'s KV binding for it is commented out, so
 * there is no cache at all) and a miss spends part of the 120/min Firestore
 * quota every visitor shares. Routing every visible card through it would
 * exhaust that quota in a normal scroll. So this reads Firestore's `count()`
 * aggregation straight from the browser instead — one billed read per local
 * thread key (at most a handful, see `localThreadKeys`) — but only for the
 * one card the feed says is active, and only once per paper for the whole
 * session: `cache`/`inflight` live at module scope, not inside the hook, so
 * they survive the mount/unmount churn of the feed's sliding mount window
 * (a card's `PaperCard` instance is torn down and rebuilt constantly; the
 * count it already paid for must not be re-billed each time).
 */

const cache = new Map();      // paper.id → number
const inflight = new Map();   // paper.id → Promise<number|null>

/** Drops a paper's cached count, e.g. after the viewer posts or deletes. */
export function forgetCommentCount(paperId) { cache.delete(paperId); inflight.delete(paperId); }

/**
 * Sums the `count()` aggregation across every local key the paper could be
 * threaded under (a DOI-and-arXiv paper can have comments filed under either,
 * see `candidateStubIdentities`). Resolves `null` — never a bogus `0` — on
 * any failure, demo mode included (`fetchCommentCount` throws
 * `CommentUnsupportedError` there): a signed-out or offline viewer must not
 * have "no comments" cached as if it were a real answer, or a real count
 * would never be tried again for the rest of the session.
 */
export async function loadCommentCount(paper, overrides) {
  if (!paper?.id) return null;
  if (cache.has(paper.id)) return cache.get(paper.id);
  if (inflight.has(paper.id)) return inflight.get(paper.id);
  const keys = localThreadKeys(paper);
  const job = Promise.all(keys.map(key => fetchCommentCount(key, overrides)))
    .then(results => {
      const total = results.reduce((sum, r) => sum + (r?.count ?? 0), 0);
      cache.set(paper.id, total);
      return total;
    })
    .catch(() => null)
    .finally(() => inflight.delete(paper.id));
  inflight.set(paper.id, job);
  return job;
}

/**
 * `enabled` is the card's own `isActive && canOpenComments`: off by default
 * everywhere `isActive` is not wired up (every surface but the feed), and off
 * for a paper with nowhere to anchor a thread. Tolerates `enabled` arriving
 * late or flipping more than once — the feed's mount window can leave a card
 * mounted for a while before it is the active one, and can make it active
 * more than once — because `loadCommentCount` itself is idempotent per
 * `paper.id` (the cache/inflight guards above), so a second or third call
 * here never costs a second read.
 */
export function useCommentCount(paper, enabled) {
  const [count, setCount] = useState(() => (paper?.id && cache.has(paper.id) ? cache.get(paper.id) : null));
  useEffect(() => {
    if (!enabled || !paper?.id) return undefined;
    let alive = true;
    loadCommentCount(paper).then(value => { if (alive && value !== null) setCount(value); });
    return () => { alive = false; };
    // `paper?.id` is the real dependency — identity, not the object. The feed
    // can hand a fresh `paper` reference across a re-render without the
    // paper itself changing, and re-running on that would cost a lookup
    // (cache-served, but still a promise and a state check) on every one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, paper?.id]);
  return count;
}
