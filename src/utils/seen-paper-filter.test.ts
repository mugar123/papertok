import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SEEN_FILTER_CHARS,
  SEEN_FILTER_BITS,
  SEEN_FILTER_CAPACITY,
  SEEN_FILTER_ERROR_RATE,
  SEEN_FILTER_HASHES,
  addSeenPaper,
  createSeenFilter,
  deserializeSeenFilter,
  feedSeenFilter,
  hasSeenPaper,
  isSeenFilterEmpty,
  readFeedSeenFilter,
  serializeSeenFilter,
} from './seen-paper-filter.ts';
import type { BloomFilter } from 'bloomfilter';

function paperId(index: number) {
  return `arxiv:24${String(index).padStart(6, '0')}`;
}

function fill(filter: BloomFilter|null|undefined, count: number, offset = 0) {
  for (let index = 0; index < count; index += 1) {
    addSeenPaper(filter, paperId(offset + index));
  }
  return filter;
}

test('is sized for a 1% false positive rate at the stated capacity', () => {
  // m = ceil(-n * log2(p) / ln2), k = ceil(ln2 * m / n)
  const expectedBits = Math.ceil(
    (-SEEN_FILTER_CAPACITY * Math.log2(SEEN_FILTER_ERROR_RATE)) / Math.LN2 / 32,
  ) * 32;
  assert.equal(SEEN_FILTER_BITS, expectedBits);
  assert.equal(SEEN_FILTER_BITS, 479264);
  assert.equal(SEEN_FILTER_HASHES, 7);
});

test('never reports a false negative for a known set', () => {
  const filter = fill(createSeenFilter(), SEEN_FILTER_CAPACITY);
  for (let index = 0; index < SEEN_FILTER_CAPACITY; index += 1) {
    assert.equal(hasSeenPaper(filter, paperId(index)), true, `missed ${paperId(index)}`);
  }
});

test('survives a round trip through base64 with no false negatives', () => {
  const filter = fill(createSeenFilter(), 5000);
  const restored = deserializeSeenFilter(serializeSeenFilter(filter));

  assert.equal(restored!.m, filter!.m);
  assert.equal(restored!.k, filter!.k);
  for (let index = 0; index < 5000; index += 1) {
    assert.equal(hasSeenPaper(restored, paperId(index)), true);
  }
});

test('keeps the false positive rate near its target at full capacity', () => {
  const filter = fill(createSeenFilter(), SEEN_FILTER_CAPACITY);

  let falsePositives = 0;
  const probes = 50000;
  for (let index = 0; index < probes; index += 1) {
    if (hasSeenPaper(filter, `arxiv:99${String(index).padStart(6, '0')}`)) falsePositives += 1;
  }

  const rate = falsePositives / probes;
  // Target is 1%. A generous ceiling still fails loudly if the sizing regresses.
  assert.ok(rate < 0.02, `false positive rate ${(rate * 100).toFixed(2)}% is above 2%`);
  assert.ok(rate > 0.001, `false positive rate ${(rate * 100).toFixed(3)}% is implausibly low`);
});

test('serialises inside the document size budget when full', () => {
  const filter = fill(createSeenFilter(), SEEN_FILTER_CAPACITY);
  const encoded = serializeSeenFilter(filter);

  assert.equal(encoded!.length, 79880);
  assert.ok(encoded!.length <= MAX_SEEN_FILTER_CHARS);
  // A Firestore document is capped at 1 MiB; the filter has to be a small part
  // of that, not most of it.
  assert.ok(encoded!.length < 0.1 * 1048576);
});

test('an empty filter serialises to nothing', () => {
  const filter = createSeenFilter();
  assert.equal(isSeenFilterEmpty(filter), true);
  assert.equal(serializeSeenFilter(filter), null);
});

test('degrades to empty rather than throwing on a corrupt payload', () => {
  assert.equal(deserializeSeenFilter('not base64 at all!!'), null);
  assert.equal(deserializeSeenFilter(''), null);
  assert.equal(deserializeSeenFilter(null), null);
  assert.equal(deserializeSeenFilter('a'.repeat(MAX_SEEN_FILTER_CHARS + 1)), null);
  // Right encoding, wrong number of bits: rejected instead of silently
  // answering with a filter that reports false negatives.
  assert.equal(deserializeSeenFilter(btoa('abcd')), null);
});

test('a feed request carries the seen papers in a few kilobytes, and the Worker reads back every one of them', () => {
  const seen = Array.from({ length: 2000 }, (_, index) => paperId(index));
  const encoded = feedSeenFilter(seen);
  // One size whatever it holds, well inside the 16 KB a feed request may be.
  assert.equal(feedSeenFilter([]).length, encoded.length);
  assert.ok(encoded.length <= 4096, `${encoded.length} characters`);

  const read = readFeedSeenFilter(encoded);
  assert.ok(seen.every(id => hasSeenPaper(read, id)), 'no seen paper reads as unseen');
  let falsePositives = 0;
  for (let index = 0; index < 20000; index += 1) {
    if (hasSeenPaper(read, `arxiv:99${String(index).padStart(6, '0')}`)) falsePositives += 1;
  }
  assert.ok(falsePositives / 20000 < 0.02, `${falsePositives} unseen papers read as seen`);

  assert.equal(readFeedSeenFilter(encoded.slice(4)), null, 'cut short');
  assert.equal(readFeedSeenFilter(`${encoded.slice(0, -4)}@@@@`), null, 'not base64');
  assert.equal(readFeedSeenFilter(serializeSeenFilter(fill(createSeenFilter(), 1))), null, "the profile's filter is another size");
});
