import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeInteractionPapers,
  definedFields,
  selectSemanticProfilePositiveIds,
  SEMANTIC_PROFILE_POSITIVE_CAP,
} from './feedInteractions.js';

test('caps liked+saved ids used for the OpenAlex semantic overlay', () => {
  const liked = Array.from({ length: 40 }, (_, index) => `liked-${index}`);
  const saved = ['liked-0', 'saved-a', 'saved-b'];
  const selected = selectSemanticProfilePositiveIds(liked, saved, 24);

  assert.equal(selected.length, 24);
  assert.equal(selected[0], 'liked-0');
  assert.ok(!selected.includes('saved-a'));
  assert.equal(SEMANTIC_PROFILE_POSITIVE_CAP, 24);
});

test('skips blank ids when building the semantic overlay sample', () => {
  assert.deepEqual(
    selectSemanticProfilePositiveIds(['', '  ', 'a'], [null, 'a', 'b'], 10),
    ['a', 'b'],
  );
});

test('deduplicates queued paper interactions while preserving their order', () => {
  const first = { id: 'paper-1', title: 'First' };
  const second = { id: 'paper-2', title: 'Second' };

  assert.deepEqual(
    dedupeInteractionPapers([first, second, { ...first, title: 'Duplicate' }]),
    [first, second],
  );
});

test('ignores interactions without a stable paper id', () => {
  assert.deepEqual(
    dedupeInteractionPapers([null, {}, { id: '  ' }, { id: 'paper-1' }]),
    [{ id: 'paper-1' }],
  );
});

test('drops fields with no value so an incomplete paper cannot reject the write', () => {
  const storedCopyWithoutCategory = { id: 'arxiv:1309.4761', title: 'Stored copy' };

  assert.deepEqual(
    definedFields({
      skip: 1,
      paperCategory: storedCopyWithoutCategory.primaryCategory,
      paperAuthors: storedCopyWithoutCategory.authors?.slice(0, 3),
      timestamp: '2026-08-27T10:00:00.000Z',
    }),
    { skip: 1, timestamp: '2026-08-27T10:00:00.000Z' },
  );
});

test('keeps values Firestore accepts, including the falsy ones', () => {
  assert.deepEqual(
    definedFields({ paperCategory: '', viewTime: 0, read: false, readAt: null }),
    { paperCategory: '', viewTime: 0, read: false, readAt: null },
  );
});

test('passes field sentinels through untouched', () => {
  const increment = { _methodName: 'increment', _operand: 1 };
  const nested = { primaryCategory: '' };

  const fields = definedFields({ skip: increment, paper: nested });

  assert.equal(fields.skip, increment);
  assert.equal(fields.paper, nested);
});
