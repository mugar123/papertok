/**
 * The engine that keeps a published list's public copy up to date on its own
 * (P25), and the reason there is no Update button any more.
 *
 * It is a module singleton, not React state, and that is the requirement that
 * shapes everything else: the edit that most needs syncing is made in the
 * save-and-organize modal, which closes the instant it saves. A sync owned by
 * that component would be cancelled by its own success. So the queue lives
 * outside the tree, screens subscribe to it to render what it is doing, and it
 * carries on when they unmount.
 *
 * Three behaviours are worth naming, because each one replaces something the
 * manual button used to do by hand:
 *
 *  - **Coalescing.** Removing four papers from a list is four edits and one
 *    sync. Jobs merge by list: a request arriving while one is in flight marks
 *    the job dirty rather than racing it, and the hydrated papers accumulate,
 *    so a partial payload from the modal and a full one from the lists page
 *    add up instead of overwriting each other.
 *  - **Retry.** A failed sync is retried once on its own before the UI is told
 *    anything. Only a second failure surfaces.
 *  - **Giving up honestly.** When it does surface, the list stays marked dirty
 *    in Firestore (`updatedAt` > `publicSyncedAt`), so opening the list later
 *    reconciles it with no click. The engine never pretends a sync happened.
 *
 * Cost note: every sync spends one unit of the Worker's daily publish quota
 * (60 per account), which is why the debounce is real and why status
 * transitions never trigger a new request.
 */
import { syncPublicList } from './publicListService.js';

/** Long enough to swallow a burst of edits, short enough to survive a tab. */
export const PUBLIC_LIST_SYNC_DEBOUNCE_MS = 900;
export const PUBLIC_LIST_SYNC_RETRY_MS = 4_000;
/** How long "up to date" stays on screen before the badge goes quiet again. */
export const PUBLIC_LIST_SYNC_NOTICE_MS = 2_500;
export const PUBLIC_LIST_SYNC_ATTEMPTS = 2;

export function createPublicListSyncEngine(options = {}) {
  const {
    sync = syncPublicList,
    debounceMs = PUBLIC_LIST_SYNC_DEBOUNCE_MS,
    retryMs = PUBLIC_LIST_SYNC_RETRY_MS,
    noticeMs = PUBLIC_LIST_SYNC_NOTICE_MS,
    attempts: maxAttempts = PUBLIC_LIST_SYNC_ATTEMPTS,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (handle) => clearTimeout(handle),
    onError = (error) => console.error('A public list could not be synced:', error),
  } = options;

  const jobs = new Map();
  const listeners = new Set();

  function stateOf(job) {
    if (!job || job.status === 'idle') return null;
    // `listId` rides along so a subscriber can act on the list itself — the
    // lists page marks it synced locally, which keeps the freshness check
    // comparing two stamps from the same clock for the rest of the session.
    return { status: job.status, code: job.code || null, listId: job.listId };
  }

  function announce(key) {
    const state = stateOf(jobs.get(key));
    // A listener that throws is a rendering bug, not a reason to lose a sync.
    listeners.forEach((listener) => {
      try {
        listener(key, state);
      } catch (error) {
        onError(error);
      }
    });
  }

  function setStatus(job, status, code = null) {
    if (job.status === status && job.code === code) return;
    job.status = status;
    job.code = code;
    announce(job.key);
  }

  function schedule(job, delay) {
    if (job.timer !== null) clearTimer(job.timer);
    job.timer = setTimer(() => {
      job.timer = null;
      void run(job);
    }, delay);
  }

  function retire(job) {
    // The notice has been read; drop the job so the badge returns to plain
    // "Public" and the accumulated payload stops holding memory.
    job.timer = setTimer(() => {
      job.timer = null;
      if (jobs.get(job.key) === job && job.status === 'synced') {
        jobs.delete(job.key);
        announce(job.key);
      }
    }, noticeMs);
  }

  async function run(job) {
    if (job.running) {
      job.dirty = true;
      return;
    }
    job.running = true;
    job.dirty = false;
    setStatus(job, 'syncing');

    try {
      await sync(job.shareId, {
        listId: job.listId,
        title: job.title,
        description: job.description,
        language: job.language,
        paperIds: job.paperIds,
        papers: [...job.papers.values()],
      });
      job.running = false;
      if (job.cancelled) return;
      job.attempts = 0;
      if (job.dirty) {
        setStatus(job, 'pending');
        schedule(job, debounceMs);
        return;
      }
      // The public document now holds these papers, so the next sync can name
      // them by id alone and let the Worker's merge supply the rest.
      job.papers.clear();
      setStatus(job, 'synced');
      retire(job);
    } catch (error) {
      job.running = false;
      // The list was unpublished or deleted while this was in flight. Its
      // failure is expected and belongs to nobody.
      if (job.cancelled) return;
      job.attempts += 1;
      const code = error?.code || 'PUBLIC_LIST_SYNC_FAILED';
      if (job.dirty || job.attempts < maxAttempts) {
        setStatus(job, 'pending', null);
        schedule(job, retryMs);
        return;
      }
      onError(error);
      setStatus(job, 'error', code);
    }
  }

  /**
   * Ask for a sync. Safe to call on every edit: the debounce and the job merge
   * turn a burst into one request.
   */
  function queue(request) {
    const { key, shareId, listId } = request || {};
    if (!key || !shareId || !listId) return;

    let job = jobs.get(key);
    if (!job) {
      job = {
        key,
        papers: new Map(),
        status: 'idle',
        code: null,
        attempts: 0,
        running: false,
        dirty: false,
        timer: null,
      };
      jobs.set(key, job);
    }

    job.shareId = shareId;
    job.listId = listId;
    job.title = request.title;
    job.description = request.description;
    job.language = request.language;
    job.paperIds = [...(request.paperIds || [])];
    for (const paper of request.papers || []) {
      if (paper?.id) job.papers.set(paper.id, paper);
    }
    // A fresh edit earns fresh attempts: whatever failed last time is being
    // asked again with newer content.
    job.attempts = 0;

    if (job.running) {
      job.dirty = true;
      setStatus(job, 'syncing');
      return;
    }
    setStatus(job, 'pending');
    schedule(job, debounceMs);
  }

  /**
   * The list is gone — unpublished or deleted. Dropping the job is not an
   * optimization: the share id it holds no longer exists, so letting it fire
   * would report a failure about a list the owner has already dealt with.
   */
  function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    if (job.timer !== null) clearTimer(job.timer);
    // A request already in flight cannot be recalled; the flag keeps its
    // result from being announced, retried or logged.
    job.cancelled = true;
    job.dirty = false;
    jobs.delete(key);
    announce(key);
  }

  /** The only manual entry point, and only for a job that already failed. */
  function retry(key) {
    const job = jobs.get(key);
    if (!job || job.running) return;
    job.attempts = 0;
    setStatus(job, 'pending');
    schedule(job, 0);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState(key) {
    return stateOf(jobs.get(key));
  }

  /** Tests only: drop every job and timer without firing anything. */
  function reset() {
    jobs.forEach((job) => {
      if (job.timer !== null) clearTimer(job.timer);
    });
    jobs.clear();
  }

  return { queue, cancel, retry, subscribe, getState, reset };
}

const engine = createPublicListSyncEngine();

export const queuePublicListSync = (request) => engine.queue(request);
export const cancelPublicListSync = (key) => engine.cancel(key);
export const retryPublicListSync = (key) => engine.retry(key);
export const subscribeToPublicListSync = (listener) => engine.subscribe(listener);
export const getPublicListSyncState = (key) => engine.getState(key);
