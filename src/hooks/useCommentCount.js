import { useEffect, useState } from 'react';
import { COMMENT_COUNT_CAP, fetchCommentCount } from '../services/commentService.js';
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
 * thread key, and `candidateStubIdentities` returns at most two (the paper's
 * canonical identity, plus its arXiv id when the canonical one is a DOI), so
 * the ceiling is TWO reads per paper — but only for the one card the feed
 * says is active, and only once per paper for the whole session:
 * `cache`/`inflight` live at module scope, not inside the hook, so they
 * survive the mount/unmount churn of the feed's sliding mount window (a
 * card's `PaperCard` instance is torn down and rebuilt constantly; the count
 * it already paid for must not be re-billed each time).
 *
 * The only thing that buys another pair of reads is a real change to that
 * paper's thread: the viewer posting or deleting a comment, which is what
 * `forgetCommentCount` marks. Nothing else re-reads, ever.
 *
 * This module is also the channel between the sheet and the card. They are
 * siblings with no shared parent state, and the number on the button has to
 * answer "did my comment land?" the moment the sheet closes — so a card that
 * stays mounted through post → close subscribes here (`watchCommentCount`)
 * and is told when its own paper's count went stale.
 */

/** paper.id -> { count, capped }. The last answer; may have gone stale. */
const cache = new Map();
/** paper.id -> the generation the cached answer was read at. */
const stamps = new Map();
/** paper.id -> current generation. Bumped by every invalidation. */
const generations = new Map();
/** paper.id -> the read in flight, so two callers never bill two pairs. */
const inflight = new Map();
/** Mounted cards waiting to hear that a count moved. */
const watchers = new Set();

const generationOf = (paperId) => generations.get(paperId) ?? 0;
/** A cached answer counts only while it predates no invalidation. */
const isFresh = (paperId) => cache.has(paperId) && stamps.get(paperId) === generationOf(paperId);
/** A copy: a watcher is free to unsubscribe while being told. */
const announce = () => { for (const watcher of [...watchers]) watcher(); };

/**
 * The viewer's own post or delete changed this thread, so whatever is cached
 * for it is now a lie. Bumping the generation is what retires it: the old
 * answer stays in `cache` only so the button can keep painting a number
 * while the new one is fetched — `isFresh` refuses to serve it, and a read
 * already in flight when this lands (Firestore reads in this app have been
 * measured hanging for 96 s against a mute stream, so that window is wide)
 * will find the generation moved and throw its own answer away instead of
 * caching a pre-post total nothing would ever evict.
 */
export function forgetCommentCount(paperId) {
  if (!paperId) return;
  generations.set(paperId, generationOf(paperId) + 1);
  inflight.delete(paperId);
  announce();
}

/**
 * Sums the `count()` aggregation across every local key the paper could be
 * threaded under (a DOI-and-arXiv paper can have comments filed under either,
 * see `candidateStubIdentities`). Resolves `null` — never a bogus `0`, never
 * a stale total — on any failure, demo mode included (`fetchCommentCount`
 * throws `CommentUnsupportedError` there): a signed-out or offline viewer
 * must not have "no comments" cached as if it were a real answer, or a real
 * count would never be tried again for the rest of the session.
 *
 * `capped` rides along instead of being flattened away: the service caps each
 * key's aggregation at `COMMENT_COUNT_CAP`, so two capped keys would sum to a
 * nonsensical 2000. The total is clamped and the card renders `1000+`, the
 * same as the sheet's own header.
 */
export async function loadCommentCount(paper, overrides) {
  const paperId = paper?.id;
  if (!paperId) return null;
  if (isFresh(paperId)) return cache.get(paperId);
  const running = inflight.get(paperId);
  if (running) return running;
  const generation = generationOf(paperId);
  const keys = localThreadKeys(paper);
  const job = Promise.all(keys.map(key => fetchCommentCount(key, overrides)))
    .then((results) => {
      // An invalidation overtook this read: the answer in hand predates the
      // viewer's own comment. Drop it rather than cache it.
      if (generationOf(paperId) !== generation) return null;
      const total = results.reduce((sum, result) => sum + (result?.count ?? 0), 0);
      const answer = {
        count: Math.min(total, COMMENT_COUNT_CAP),
        capped: results.some(result => result?.capped === true),
      };
      cache.set(paperId, answer);
      stamps.set(paperId, generation);
      announce();
      return answer;
    })
    .catch(() => null)
    // Only if it is still ours: a forget already cleared this slot, and a
    // newer read may have claimed it.
    .finally(() => { if (inflight.get(paperId) === job) inflight.delete(paperId); });
  inflight.set(paperId, job);
  return job;
}

/**
 * One mounted card's subscription. Paints what is already known (even a stale
 * number — a badge flickering back to the word while the new count lands is
 * worse than a number a beat behind), asks for the count, and re-reads later
 * if and only if THIS paper's thread was invalidated. Returns its own
 * unsubscribe. Plain functions, no React: what the card does on a change is
 * the caller's business.
 */
export function watchCommentCount(paper, onCount, overrides) {
  const paperId = paper?.id;
  if (!paperId) return () => {};
  let generation = generationOf(paperId);
  const paint = () => { const known = cache.get(paperId); if (known) onCount(known); };
  const watcher = () => {
    paint();
    const current = generationOf(paperId);
    if (current === generation) return;
    generation = current;
    void loadCommentCount(paper, overrides);
  };
  watchers.add(watcher);
  paint();
  void loadCommentCount(paper, overrides);
  return () => { watchers.delete(watcher); };
}

/**
 * What a read OUTSIDE a subscription's own paint() may show. `enabled` cards
 * get the raw entry even when stale: `watchCommentCount`'s `paint()` reads
 * the same `cache.get` unconditionally, by design, so the badge does not
 * flicker back to the word while a re-read for THIS card is already in
 * flight — seeding or falling back to that same raw entry here just agrees
 * with what the subscription is about to paint anyway, not a second rule.
 *
 * A card that is not enabled has no subscription to correct it — and on
 * every surface but the feed (Lists, Search, `PublicPaperPage`, the
 * related-paper overlay: nowhere passes `isActive`) never will — so it may
 * only be handed a fresh entry. Anything stale would sit there, wrong, for
 * the rest of the session: `forgetCommentCount` deliberately leaves the old
 * answer in `cache` (see above), and a surface with no subscriber is the one
 * place nothing will ever ask again to correct it.
 */
export function paintableCommentCount(paperId, enabled) {
  if (!paperId) return null;
  if (enabled) return cache.get(paperId) ?? null;
  return isFresh(paperId) ? cache.get(paperId) : null;
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
 *
 * The painted value carries the id it belongs to, so a card handed a
 * different paper without being remounted cannot keep showing the previous
 * one's number: it falls back to what the cache knows about the new id —
 * through `paintableCommentCount`, so that fallback is held to the same
 * not-subscribed-means-fresh-only rule as the initial seed below.
 */
export function useCommentCount(paper, enabled) {
  const paperId = paper?.id ?? null;
  const [painted, setPainted] = useState(() => ({ id: paperId, entry: paintableCommentCount(paperId, enabled) }));
  useEffect(() => {
    if (!enabled || !paperId) return undefined;
    // One channel, no addressing: every card is told about every
    // invalidation, and the answers themselves are cached by reference. So
    // the same state object goes back unchanged when nothing about THIS card
    // moved, and React skips a render of a card that has nothing new to show.
    return watchCommentCount(paper, entry => setPainted(previous => (
      previous.id === paperId && previous.entry === entry ? previous : { id: paperId, entry }
    )));
    // `paper?.id` is the real dependency — identity, not the object. The feed
    // can hand a fresh `paper` reference across a re-render without the
    // paper itself changing, and re-running on that would tear the
    // subscription down and build it up again on every one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, paperId]);
  return painted.id === paperId ? painted.entry : paintableCommentCount(paperId, enabled);
}
