import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetCommentCount, loadCommentCount } from './useCommentCount.js';

/**
 * `{ id: 'doi:10.1/x', doi: '10.1/x' }` (the fixture this suite started from)
 * yields ZERO local thread keys: `DOI_PATTERN` in paperCanonicalKey.js needs
 * 4-9 digits between `10.` and the slash, and `1` is only one digit, so
 * `normalizeDoi` rejects it, `rawIdentity('doi:10.1/x')` also refuses (it
 * already wears a `doi:` prefix that failed the DOI grammar), and
 * `canonicalPaperIdentity` returns null. `Promise.all([])` then resolves to a
 * total of 0, so `first >= 2` would fail forever — not "pass trivially", it
 * would not pass at all, against a correct implementation or a broken one.
 * Verified empirically (`localThreadKeys(brief fixture)` -> `[]`) before
 * writing this file. This fixture carries a syntactically valid DOI
 * (`10.1000/xyz`, prefix `1000` has 4 digits) plus a distinct arXiv id, so it
 * exercises the actual "sum across local keys" path with two keys, not one.
 */
const paper = { id: 'doi:10.1000/xyz', doi: '10.1000/xyz', arxivId: '2401.12345' };

test('suma las claves locales y cachea por paper', async () => {
  forgetCommentCount(paper.id);
  let calls = 0;
  const countThread = async () => { calls += 1; return 2; };
  const first = await loadCommentCount(paper, { countThread, database: {} });
  const again = await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(first >= 2);
  assert.equal(again, first);
  const seen = calls;
  assert.ok(seen >= 1);
  forgetCommentCount(paper.id);
  await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(calls > seen, 'olvidar vuelve a contar');
});

test('un fallo de lectura devuelve null y no envenena la caché', async () => {
  forgetCommentCount(paper.id);
  const countThread = async () => { throw new Error('unavailable'); };
  assert.equal(await loadCommentCount(paper, { countThread, database: {} }), null);
  let ok = 0;
  await loadCommentCount(paper, { countThread: async () => { ok += 1; return 1; }, database: {} });
  assert.ok(ok >= 1);
});

/**
 * The feed's mount window unmounts and remounts the SAME `paper.id` constantly
 * (it slides on a 400ms idle timer). `useCommentCount` re-runs its effect on
 * every mount, but `loadCommentCount`'s `cache`/`inflight` are declared at
 * module scope — outside the hook function, so they are not component state
 * and a component unmount cannot clear them. This simulates three separate
 * mounts of the same paper (three independent `loadCommentCount` calls, no
 * shared closure between them, exactly what three separate effect runs would
 * do) and asserts only the first one actually reads.
 */
test('remontar la misma tarjeta no repite la lectura (la caché es de módulo, no de componente)', async () => {
  forgetCommentCount(paper.id);
  let calls = 0;
  const overrides = { countThread: async () => { calls += 1; return 3; }, database: {} };
  const mountedOnce = await loadCommentCount(paper, overrides);
  const callsAfterFirstMount = calls;
  assert.ok(callsAfterFirstMount >= 1, 'the first mount actually reads');
  const mountedAgain = await loadCommentCount(paper, overrides);
  const mountedYetAgain = await loadCommentCount(paper, overrides);
  assert.equal(mountedAgain, mountedOnce);
  assert.equal(mountedYetAgain, mountedOnce);
  assert.equal(calls, callsAfterFirstMount, 'a remount must not re-read');
});
