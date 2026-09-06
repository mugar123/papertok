import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const source = async () => stripComments(await readFile(new URL('./ListsPage.jsx', import.meta.url), 'utf8'));

test('SOURCE: the lists read refuses a cache-served emptiness instead of calling it a failure', async () => {
  const code = await source();
  const call = code.match(/patientRead\(\(\) => getDocs\(listsRef\), \{[\s\S]*?\}\);/);
  assert.ok(call, 'the lists read is gone');
  assert.match(call[0], /isAnswer: snapshotIsAuthoritative/);
});

test('SOURCE: every metadata batch is a patient read with a real abort, never a bare getDocs under a deadline', async () => {
  const code = await source();
  assert.doesNotMatch(code, /settleWithin\(/, 'no read on this screen is bounded by a guillotine any more');
  const batch = code.match(/return patientRead\(\(\) => getDocs\(metadataQuery\), \{[\s\S]*?\}\)\.then\(/);
  assert.ok(batch, 'the metadata batch read is gone');
  assert.match(batch[0], /ms: PAPER_METADATA_LOAD_DEADLINE_MS/);
  assert.match(batch[0], /isAnswer: queryIsAuthoritative/);
  assert.match(batch[0], /signal: metadataAbort\.signal/);
  assert.match(batch[0], /onLateResult: settleLate/);
  // A newer open ends the previous one's retry loops, and so does leaving.
  assert.match(code, /metadataAbortRef\.current\?\.abort\(\);\s*const metadataAbort = new AbortController\(\);\s*metadataAbortRef\.current = metadataAbort;/);
  assert.match(code, /useEffect\(\(\) => \(\) => metadataAbortRef\.current\?\.abort\(\), \[\]\);/);
  // A deadline is "still running", a rejection is "answered": both settle the
  // rows they cover correctly.
  assert.match(code, /if \(isReadTimeout\(reason\)\) return \{ status: 'timed_out' \};\s*settleRequest\(requestDefinition\);\s*return \{ status: 'rejected', reason \};/);
});
