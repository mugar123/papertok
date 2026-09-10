import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRewritePaper,
  createNdjsonParser,
  getRewritablePdfUrl,
  PaperRewriteError,
  rewriteCacheKey,
  rewritePaper,
  toRewriteError,
} from './paperRewriteService.js';
import { WorkerApiAuthError } from './workerApiClient.js';

test('assembles events only once their line closes', () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"type":"meta","level":"unive'), []);
  const events = parser.push('rsity"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].level, 'university');
});

test('emits several events arriving in one chunk', () => {
  const parser = createNdjsonParser();
  const events = parser.push([
    '{"type":"meta"}',
    '{"type":"section","index":0}',
    '{"type":"section","index":1}',
    '',
  ].join('\n'));
  assert.deepEqual(events.map(event => event.type), ['meta', 'section', 'section']);
});

test('skips a corrupt line rather than losing the stream', () => {
  const parser = createNdjsonParser();
  const events = parser.push('{"type":"section"}\nnot json\n{"type":"done"}\n');
  assert.deepEqual(events.map(event => event.type), ['section', 'done']);
});

test('flush recovers a final line with no trailing newline', () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"type":"done","sectionCount":3}'), []);
  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].sectionCount, 3);
});

test('flush on an empty buffer yields nothing', () => {
  const parser = createNdjsonParser();
  parser.push('{"type":"done"}\n');
  assert.deepEqual(parser.flush(), []);
});

test('a byte split inside a multi-line chunk keeps order', () => {
  const parser = createNdjsonParser();
  const first = parser.push('{"type":"section","index":0}\n{"type":"sec');
  assert.equal(first.length, 1);
  const second = parser.push('tion","index":1}\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].index, 1);
});

/**
 * The cancellation path. `rewritePaper` subscribes to the caller's signal, and a
 * signal that already aborted never fires again — so without an upfront check
 * the POST went out anyway and spent one of the ten daily uses on a stream
 * nobody was waiting for.
 */
const READABLE_PAPER = { id: 'p1', title: 'A paper', openAccessPdfUrl: 'https://arxiv.org/pdf/2401.00001.pdf' };
const UNREADABLE_PAPER = { id: 'p2', title: 'Behind a paywall' };

function abortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

test('a signal that already aborted cancels before anything is requested', async () => {
  await assert.rejects(
    () => rewritePaper(READABLE_PAPER, 'university', {
      signal: abortedSignal(),
      onMeta: () => assert.fail('no metadata should arrive'),
      onSection: () => assert.fail('no section should arrive'),
    }),
    (error) => error instanceof PaperRewriteError && error.code === 'AI_CANCELLED',
  );
});

test('the abort check runs ahead of the full-text gate, so the reason stays cancellation', async () => {
  await assert.rejects(
    () => rewritePaper(UNREADABLE_PAPER, 'university', { signal: abortedSignal() }),
    (error) => error.code === 'AI_CANCELLED',
  );
});

test('a live signal is not mistaken for an aborted one', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => rewritePaper(UNREADABLE_PAPER, 'university', { signal: controller.signal }),
    (error) => error.code === 'AI_REWRITE_NEEDS_FULL_TEXT',
  );
  await assert.rejects(
    () => rewritePaper(UNREADABLE_PAPER, 'university', {}),
    (error) => error.code === 'AI_REWRITE_NEEDS_FULL_TEXT',
  );
});

test('an invalid level is still reported as such, aborted or not', async () => {
  await assert.rejects(
    () => rewritePaper(READABLE_PAPER, 'expert', { signal: abortedSignal() }),
    (error) => error.code === 'AI_INVALID_LEVEL',
  );
});

/**
 * The identity the reader leans on to tell a genuinely new request from the same
 * one wearing a new object. `PaperCard` rebuilds the paper it hands the reader
 * once the open-access copy resolves, and the reader must not read that as a
 * second rewrite to pay for.
 */
test('a rebuilt paper object keeps the same rewrite identity', () => {
  const original = { id: 'p1', title: 'A paper', pdfUrl: 'https://example.org/a.pdf' };
  const withOpenCopy = {
    ...original,
    openAccess: true,
    openAccessPdfUrl: 'https://arxiv.org/pdf/2401.00001.pdf',
  };

  assert.notEqual(original, withOpenCopy);
  assert.equal(
    rewriteCacheKey(original, 'university', 'es'),
    rewriteCacheKey(withOpenCopy, 'university', 'es'),
  );
});

test('level, language and paper are each enough to make it a different rewrite', () => {
  const paper = { id: 'p1', title: 'A paper' };
  const key = rewriteCacheKey(paper, 'university', 'es');

  assert.notEqual(key, rewriteCacheKey(paper, 'beginner', 'es'));
  assert.notEqual(key, rewriteCacheKey(paper, 'university', 'en'));
  assert.notEqual(key, rewriteCacheKey({ id: 'p2', title: 'A paper' }, 'university', 'es'));
});

test('the identity falls back through doi, arxiv id and title', () => {
  const level = 'university';
  assert.equal(
    rewriteCacheKey({ doi: '10.1/abc' }, level, 'es'),
    rewriteCacheKey({ doi: '10.1/abc', pdfUrl: 'https://example.org/b.pdf' }, level, 'es'),
  );
  assert.notEqual(
    rewriteCacheKey({ arxivId: '2401.00001' }, level, 'es'),
    rewriteCacheKey({ arxivId: '2401.00002' }, level, 'es'),
  );
  assert.notEqual(
    rewriteCacheKey({ title: 'One paper' }, level, 'es'),
    rewriteCacheKey({ title: 'Another paper' }, level, 'es'),
  );
});

/**
 * Where a PubMed paper is read from.
 *
 * `pmc.ncbi.nlm.nih.gov/articles/<id>/pdf/` answers a client without a browser
 * with a 1.8 KB HTML interstitial — a "preparing to download" page whose real
 * link is written by JavaScript — so the worker downloaded that, saw it was not
 * a PDF, and told every PubMed reader the paper had no full text. Europe PMC's
 * render of the same article serves `application/pdf` on the first response
 * (measured 10-09: 200, 5 087 489 bytes), which is what the worker can read.
 */
test('a paper with only a PMCID reads through Europe PMC, which serves the PDF bytes', () => {
  assert.equal(
    getRewritablePdfUrl({ pmcid: 'PMC10000000' }),
    'https://europepmc.org/articles/PMC10000000?pdf=render',
  );
  assert.equal(canRewritePaper({ pmcid: 'PMC10000000' }), true);
});

test('an arXiv copy still wins over the PubMed one', () => {
  assert.equal(
    getRewritablePdfUrl({ arxivId: '2401.00001', pmcid: 'PMC10000000' }),
    'https://arxiv.org/pdf/2401.00001.pdf',
  );
});

/* ============================================================
   What a failure is called by the time the reader sees it
   ============================================================ */

/**
 * The reader has copy for `AI_AUTH_REQUIRED` and hides the retry button behind
 * it, because retrying is exactly what cannot help. An expired Firebase session
 * fails inside `getIdToken`, never reaching the worker that would have named it,
 * and arrived as `AI_UNAVAILABLE` — "something broke, try again" — for a reader
 * whose only way forward was to sign in.
 */
test('an expired Firebase session maps to AI_AUTH_REQUIRED', () => {
  assert.equal(
    toRewriteError({ name: 'FirebaseError', code: 'auth/user-token-expired' }).code,
    'AI_AUTH_REQUIRED',
  );
  assert.equal(
    toRewriteError({ name: 'FirebaseError', code: 'auth/network-request-failed' }).code,
    'AI_AUTH_REQUIRED',
  );
  assert.equal(toRewriteError(new WorkerApiAuthError()).code, 'AI_AUTH_REQUIRED');
});

test('a rewrite error the stream already named is never renamed', () => {
  const named = new PaperRewriteError('AI_QUOTA_EXHAUSTED', { scope: 'provider' });
  assert.equal(toRewriteError(named), named);
  // The scope is what tells the reader's own ceiling from the provider's, and it
  // only survives if the error object does.
  assert.equal(toRewriteError(named).quota.scope, 'provider');
});

test('an abort is a timeout unless the caller asked for it', () => {
  assert.equal(toRewriteError({ name: 'AbortError' }).code, 'AI_TIMEOUT');
  assert.equal(toRewriteError({ name: 'AbortError' }, { cancelled: true }).code, 'AI_CANCELLED');
  assert.equal(toRewriteError(new TypeError('Failed to fetch')).code, 'AI_UNAVAILABLE');
});
