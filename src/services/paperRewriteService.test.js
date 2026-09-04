import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNdjsonParser,
  PaperRewriteError,
  rewriteCacheKey,
  rewritePaper,
} from './paperRewriteService.js';

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
