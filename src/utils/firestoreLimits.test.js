import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { FIRESTORE_IN_FILTER_MAX } from './firestoreLimits.js';

test('the measured cap is the one the code was verified against', () => {
  // Emulator, real rules: 30 values return 30 documents, 31 returns
  // `invalid-argument: 'IN' supports up to 30 comparison values.`
  assert.equal(FIRESTORE_IN_FILTER_MAX, 30);
});

const SRC = new URL('../', import.meta.url);

async function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) out.push(...await sourceFiles(child));
    else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(child);
  }
  return out;
}

/**
 * The drift this file was created to end.
 *
 * `interactionProfileStore.js` batched by ten and said "the batch size is fixed
 * by the `in` operator". The lists screen batched by thirty and said the same
 * thing. Both were describing the same platform limit; one had been overtaken
 * by Firestore raising it, and nothing in the process could notice, because the
 * limit lived in two comments beside two magic numbers.
 *
 * So: anything that builds an `in` filter takes the cap from here. A file that
 * hardcodes its own is how the two numbers came to disagree in the first place.
 */
/** Modules whose batch size is defined as `FIRESTORE_IN_FILTER_MAX`. */
const CAP_OWNERS = /from '[^']*(firestoreLimits|listPaperMetadataPlan)(\.js)?'/;

test('SOURCE: every in-filter call site takes its cap from this module', async () => {
  const offenders = [];
  let callSites = 0;

  for (const file of await sourceFiles()) {
    const source = await readFile(file, 'utf8');
    const path = file.pathname.split('/src/').pop();

    // A hardcoded batch size is the drift itself, wherever it lives.
    for (const literal of source.match(/_BATCH_SIZE\s*=\s*\d+/g) || []) {
      offenders.push(`${path}: \`${literal}\` — derive it from FIRESTORE_IN_FILTER_MAX`);
    }

    // And so is prose. Two of the three stale claims were comments, not code:
    // "Ten ids per `in` query, so this is 60 queries" sat in FeedContext long
    // after the cap moved, and no check that looked only at constants could
    // see it. A comment that does the arithmetic is a comment that goes stale.
    const prose = [
      ...source.match(/\b(?:\w+)\s+ids per `in`/gi) || [],
      ...source.match(/MAX_RECORDS\s*\/\s*\d+/g) || [],
    ];
    for (const claim of prose) {
      offenders.push(`${path}: "${claim}" — restates the cap in prose; point at firestoreLimits.js instead`);
    }

    if (!source.includes('documentId()')) continue;
    callSites += 1;
    // Directly, or through a module that does: what matters is that no call
    // site carries a second opinion about the limit.
    if (!source.includes('FIRESTORE_IN_FILTER_MAX') && !CAP_OWNERS.test(source)) {
      offenders.push(`${path}: builds an 'in' filter without taking the cap from firestoreLimits.js`);
    }
  }

  assert.ok(callSites >= 2, 'expected to have found the in-filter call sites');
  assert.deepEqual(offenders, [], offenders.join('; '));
});
