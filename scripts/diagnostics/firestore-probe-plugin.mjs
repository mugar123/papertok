/**
 * Diagnostic instrumentation for Firestore reads — not part of the app.
 *
 * Wraps `firebase/firestore` in dev only, so every read the client makes is
 * timed at the one layer that knows: Firestore rides a WebChannel, so the
 * network panel cannot tell you how many documents a screen actually asked
 * for, nor whether the answer came from the server or the in-memory cache.
 *
 * Zero product-code changes: the alias is installed by a Vite plugin that only
 * applies to `serve`, so it can never reach a production build. NOT wired in by
 * default. To use it, add two lines to vite.config.js and take them out again
 * when you are done:
 *
 *   import { firestoreProbe } from './scripts/diagnostics/firestore-probe-plugin.mjs'
 *   plugins: [react(), firestoreProbe()],
 *
 * This is what produced the numbers behind the save-and-organize fix: that a
 * stalled `getDocs` against an uncached target answers with an empty SUCCESS in
 * 0.5 ms rather than rejecting, which is invisible from the network panel
 * because Firestore traffic rides a WebChannel.
 *
 * Exposes window.__ptProbe:
 *   .reset()            clear the log
 *   .log                [{ op, path, ms, fromCache, docs, at, stack }]
 *   .summary()          per-call-site aggregation
 *   .inflight           reads started and not yet answered
 *   .subscriptions      onSnapshot calls per target — a listener that is torn
 *                       down and rebuilt shows up here and nowhere else
 */
const VIRTUAL = '\0papertok:firestore-probe';

const PROBE_SOURCE = `
import * as real from 'firebase/firestore';
export * from 'firebase/firestore';

const state = (globalThis.__ptProbe ??= {
  log: [],
  inflight: 0,
  maxInflight: 0,
  seq: 0,
  reset() { this.log = []; this.maxInflight = 0; this.seq = 0; return 'reset'; },
  summary() {
    const byLabel = new Map();
    for (const entry of this.log) {
      const key = entry.op + ' ' + entry.path;
      const bucket = byLabel.get(key) || { calls: 0, docs: 0, totalMs: 0, maxMs: 0, fromCache: 0 };
      bucket.calls++;
      bucket.docs += entry.docs;
      bucket.totalMs += entry.ms;
      bucket.maxMs = Math.max(bucket.maxMs, entry.ms);
      if (entry.fromCache) bucket.fromCache++;
      byLabel.set(key, bucket);
    }
    return [...byLabel.entries()]
      .map(([key, b]) => ({ key, ...b, avgMs: +(b.totalMs / b.calls).toFixed(1) }))
      .sort((a, b) => b.totalMs - a.totalMs);
  },
});

function describe(target) {
  try {
    if (target?.path) return target.path;
    if (target?._query) {
      const p = target._query.path?.canonicalString?.() ?? '';
      const filters = target._query.filters?.length ?? 0;
      const limit = target._query.limit ?? null;
      return p + '?filters=' + filters + '&limit=' + (limit ?? 'NONE');
    }
    return String(target?.type || 'unknown');
  } catch { return 'unknown'; }
}

function instrument(name, fn, countDocs) {
  return async (...args) => {
    const path = describe(args[0]);
    const started = performance.now();
    const seq = ++state.seq;
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try {
      const result = await fn(...args);
      const ms = +(performance.now() - started).toFixed(1);
      state.log.push({
        seq, op: name, path, ms,
        fromCache: Boolean(result?.metadata?.fromCache),
        docs: countDocs(result),
        at: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const ms = +(performance.now() - started).toFixed(1);
      state.log.push({ seq, op: name, path, ms, error: error?.code || String(error), docs: 0, fromCache: null, at: new Date().toISOString() });
      throw error;
    } finally {
      state.inflight--;
    }
  };
}

function instrumentWrite(name, fn) {
  return async (...args) => {
    const path = describe(args[0]);
    // Payload size matters: the interaction aggregate is rewritten whole on a
    // debounce, and it grows with every curated id.
    let bytes = 0;
    try { bytes = JSON.stringify(args[1] ?? {}).length; } catch { bytes = -1; }
    const started = performance.now();
    const seq = ++state.seq;
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try {
      const result = await fn(...args);
      state.log.push({ seq, op: name, path, ms: +(performance.now() - started).toFixed(1), bytes, docs: 0, fromCache: null, at: new Date().toISOString() });
      return result;
    } catch (error) {
      state.log.push({ seq, op: name, path, ms: +(performance.now() - started).toFixed(1), bytes, error: error?.code || String(error), docs: 0, at: new Date().toISOString() });
      throw error;
    } finally { state.inflight--; }
  };
}

// Handle on the raw SDK, so a diagnosis can force the conditions the family
// is about (a stalled connection) instead of waiting for one to happen.
globalThis.__ptReal = real;

// Subscriptions, counted per target. A listener that is torn down and rebuilt
// costs a full re-read of its collection every time, and nothing about it is
// visible in the UI — the count is the only way to see it.
export function onSnapshot(...args) {
  const path = describe(args[0]);
  state.subscriptions ??= {};
  state.subscriptions[path] = (state.subscriptions[path] || 0) + 1;
  return real.onSnapshot(...args);
}

export const setDoc = instrumentWrite('setDoc', real.setDoc);
export const updateDoc = instrumentWrite('updateDoc', real.updateDoc);
export const deleteDoc = instrumentWrite('deleteDoc', real.deleteDoc);

export const getDocs = instrument('getDocs', real.getDocs, r => r?.size ?? 0);
export const getDoc = instrument('getDoc', real.getDoc, r => (r?.exists?.() ? 1 : 0));
export const getDocsFromCache = instrument('getDocsFromCache', real.getDocsFromCache, r => r?.size ?? 0);
export const getCountFromServer = instrument('getCountFromServer', real.getCountFromServer, () => 1);
`;

export function firestoreProbe() {
  return {
    name: 'papertok-firestore-probe',
    enforce: 'pre',
    apply: 'serve',
    resolveId(source, importer) {
      if (source !== 'firebase/firestore') return null;
      // The probe itself must reach the real package.
      if (importer === VIRTUAL) return null;
      return VIRTUAL;
    },
    load(id) {
      return id === VIRTUAL ? PROBE_SOURCE : null;
    },
  };
}
