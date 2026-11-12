import assert from 'node:assert/strict';
import test from 'node:test';
import { admitIngredients, FEED_FORM_INITIAL, feedFormProblem, feedFormReducer, otherFeedsOf } from './feed-form-model.ts';
import { ingredientProblem, type CustomFeed, type FeedIngredient } from './custom-feeds.ts';

const quantPh: FeedIngredient = { kind: 'category', id: 'quant-ph' };
const eightFeeds: CustomFeed[] = Array.from({ length: 8 }, (_, index) => ({
  id: `feed000${index}`,
  name: `Feed ${index}`,
  order: 'newest',
  ingredients: [{ kind: 'category', id: 'cs.CR' }],
}));
const author = (n: number): FeedIngredient => ({ kind: 'author', id: `A${n}`, label: `Author ${n}` });

test('the form adds an ingredient once, removes it by its key and resets when opened', () => {
  const once = feedFormReducer(FEED_FORM_INITIAL, { type: 'add', ingredient: quantPh });
  const twice = feedFormReducer(once, { type: 'add', ingredient: { kind: 'category', id: 'quant-ph' } });
  assert.deepEqual(twice.ingredients, [quantPh]);

  const removed = feedFormReducer(twice, { type: 'remove', key: 'category:quant-ph' });
  assert.deepEqual(removed.ingredients, []);

  const used = { ...FEED_FORM_INITIAL, name: 'Old', order: 'best' as const, ingredients: [quantPh], busy: true, failed: true, saved: true };
  const opened = feedFormReducer(used, { type: 'open', preset: { name: 'Thesis', ingredients: [{ kind: 'keyword', query: 'qubits' }] } });
  assert.deepEqual(opened, { name: 'Thesis', order: 'newest', ingredients: [{ kind: 'keyword', query: 'qubits' }], busy: false, failed: false, saved: false });
  assert.deepEqual(feedFormReducer(used, { type: 'open' }), FEED_FORM_INITIAL);
});

test('sending marks the form busy once, and a failure frees it with the failure shown until the next edit', () => {
  const ready = { ...FEED_FORM_INITIAL, name: 'Thesis', ingredients: [quantPh] };
  const sending = feedFormReducer(ready, { type: 'submit' });
  assert.equal(sending.busy, true);
  assert.equal(feedFormReducer(sending, { type: 'submit' }), sending);

  const failed = feedFormReducer(sending, { type: 'failed' });
  assert.deepEqual({ busy: failed.busy, failed: failed.failed }, { busy: false, failed: true });
  assert.equal(feedFormReducer(failed, { type: 'name', value: 'Thesis 2' }).failed, false);
  assert.equal(feedFormReducer(failed, { type: 'order', value: 'best' }).order, 'best');
});

test('a form with a name and an ingredient can be sent; each problem has its name', () => {
  const state = { ...FEED_FORM_INITIAL, name: 'Thesis', ingredients: [{ kind: 'category' as const, id: 'quant-ph' }] };
  assert.equal(feedFormProblem(state, []), null);
  assert.equal(feedFormProblem({ ...state, ingredients: [] }, []), 'no-ingredients');
  assert.equal(feedFormProblem(state, eightFeeds), 'feed-limit');
  assert.equal(feedFormProblem(state, eightFeeds, eightFeeds[0].id), null);
  assert.equal(feedFormProblem({ ...state, name: '   ' }, []), 'empty');
  assert.equal(feedFormProblem({ ...state, name: 'x'.repeat(33) }, []), 'too-long');
  assert.equal(feedFormProblem({ ...state, name: ' feed 3 ' }, eightFeeds.slice(0, 7)), 'taken');
  assert.equal(feedFormProblem({ ...state, name: 'Feed 3' }, eightFeeds, eightFeeds[3].id), null);
});

test('a saved form reports no problem whatever the feeds become, and is not sent again', () => {
  const ready = { ...FEED_FORM_INITIAL, name: 'Feed 6', ingredients: [quantPh] };
  const saved = feedFormReducer(feedFormReducer(ready, { type: 'submit' }), { type: 'saved' });
  assert.deepEqual({ busy: saved.busy, failed: saved.failed, saved: saved.saved }, { busy: true, failed: false, saved: true });
  // The list the write committed holds the new feed: its name, and the eighth place.
  assert.equal(feedFormProblem(ready, eightFeeds), 'feed-limit');
  assert.equal(feedFormProblem(ready, eightFeeds.slice(0, 7), 'other'), 'taken');
  assert.equal(feedFormProblem(saved, eightFeeds), null);
  assert.equal(feedFormProblem(feedFormReducer(ready, { type: 'submit' }), eightFeeds), null);
  assert.equal(feedFormProblem(saved, eightFeeds.slice(0, 7), 'other'), null);
  assert.equal(feedFormReducer(saved, { type: 'submit' }), saved);
});

test('a preset keeps the ingredients the account can hold and names the first ceiling it met', () => {
  const thirtyAuthors: CustomFeed[] = [{ id: 'feed0000', name: 'People', order: 'newest', ingredients: Array.from({ length: 30 }, (_, n) => author(n)) }];
  const admitted = admitIngredients([
    { kind: 'author', id: 'https://openalex.org/A3', label: ' Author 3 ' },
    quantPh,
    { kind: 'category', id: 'quant-ph' },
    author(99),
    { kind: 'area', id: 'not-an-area' },
  ], thirtyAuthors);
  assert.deepEqual(admitted, { ingredients: [author(3), quantPh], refused: 'entities-full' });
  assert.deepEqual(admitIngredients([quantPh], []), { ingredients: [quantPh], refused: null });
});

test('a new feed whose create landed after its deadline is the form\'s own: not taken, not over the limit or a ceiling', () => {
  const keyword = (n: number): FeedIngredient => ({ kind: 'keyword', query: `word ${n}` });
  const pending: CustomFeed = { id: 'pending00001', name: 'Thesis', order: 'newest', ingredients: Array.from({ length: 10 }, (_, n) => keyword(n)) };
  const feeds = [...eightFeeds.slice(0, 7), pending];
  // The reader took the tenth keyword out and adds another: ten in all once written.
  const form = { ...FEED_FORM_INITIAL, name: 'thesis', ingredients: pending.ingredients.slice(0, 9) };
  assert.equal(feedFormProblem(form, feeds, 'pending00001'), null);
  assert.equal(ingredientProblem(keyword(10), form.ingredients, otherFeedsOf(feeds, 'pending00001')), null);
  // Without its id the same list is full and the name taken.
  assert.equal(feedFormProblem(form, feeds), 'feed-limit');
  assert.equal(feedFormProblem(form, feeds.slice(1)), 'taken');
  assert.equal(ingredientProblem(keyword(10), form.ingredients, otherFeedsOf(feeds)), 'keywords-full');
});
