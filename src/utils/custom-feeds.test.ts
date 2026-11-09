import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CustomFeedError,
  corpusRequestOf,
  feedNameProblem,
  ingredientFromFollow,
  ingredientKey,
  ingredientLabel,
  ingredientProblem,
  parseCustomFeeds,
  parseFeedIngredient,
  withFeedAdded,
  withFeedChanged,
  withFeedMoved,
  withFeedRemoved,
  type CustomFeed,
  type FeedIngredient,
} from './custom-feeds.ts';
import { followLane } from './follow-lanes.ts';

const WORDS = ['anyons', 'bosons', 'cavities', 'dimers', 'excitons', 'fermions', 'gluons', 'hadrons', 'isotopes', 'jets', 'kaons', 'leptons'];
const feedOf = (id: string, ingredients: FeedIngredient[], name = id): CustomFeed => ({ id, name, order: 'newest', ingredients });
const author = (n: number): FeedIngredient => ({ kind: 'author', id: `A${n}`, label: `Author ${n}` });
const topic = (n: number): FeedIngredient => ({ kind: 'topic', id: `T${n}`, label: `Topic ${n}` });
const keyword = (query: string): FeedIngredient => ({ kind: 'keyword', query });

test('a stored list keeps the feeds that are well formed and drops the rest', () => {
  const good = { id: 'abcd1234', name: 'Thesis', order: 'newest', ingredients: [{ kind: 'category', id: 'quant-ph' }] };
  const parsed = parseCustomFeeds([good, { id: 'x', name: 'bad id', order: 'newest', ingredients: [] }, 'nonsense', { ...good, id: 'abcd1235', order: 'sideways' }]);
  assert.deepEqual(parsed, [good]);
  assert.deepEqual(parseCustomFeeds(null), []);
});

test('a stored list is cut at eight feeds and twenty ingredients, and an unknown category goes', () => {
  const nine = Array.from({ length: 9 }, (_, index) => feedOf(`feed000${index}`, []));
  assert.deepEqual(parseCustomFeeds(nine).map(feed => feed.id), nine.slice(0, 8).map(feed => feed.id));

  const authors = Array.from({ length: 21 }, (_, index) => author(index + 1));
  const [crowded] = parseCustomFeeds([feedOf('abcd1234', [{ kind: 'category', id: 'not-a-leaf' }, ...authors])]);
  assert.deepEqual(crowded.ingredients, authors.slice(0, 20));
});

test('the account holds ten keywords across its feeds: the eleventh, in a later feed, is dropped', () => {
  const first = feedOf('abcd1234', WORDS.slice(0, 6).map(keyword));
  const second = feedOf('abcd1235', [keyword(WORDS[5]), ...WORDS.slice(6, 11).map(keyword)]);
  const [, parsedSecond] = parseCustomFeeds([first, second]);
  assert.deepEqual(parsedSecond.ingredients, [keyword(WORDS[5]), ...WORDS.slice(6, 10).map(keyword)]);

  const authors = feedOf('abcd1236', Array.from({ length: 20 }, (_, index) => author(index + 1)));
  const topics = feedOf('abcd1237', [author(1), ...Array.from({ length: 11 }, (_, index) => topic(index + 1))]);
  const [, parsedTopics] = parseCustomFeeds([authors, topics]);
  assert.deepEqual(parsedTopics.ingredients, [author(1), ...Array.from({ length: 10 }, (_, index) => topic(index + 1))]);
});

test('a stored list drops repeated ingredients and feeds, and keeps a feed left with none', () => {
  const parsed = parseCustomFeeds([
    { id: 'abcd1234', name: '  Thesis ', order: 'best', ingredients: [{ kind: 'area', id: 'physics' }, { kind: 'area', id: 'physics' }, { kind: 'area', id: 'constructor' }] },
    { id: 'abcd1234', name: 'Again', order: 'newest', ingredients: [] },
    { id: 'abcd1235', name: 'Empty', order: 'newest', ingredients: 'not a list' },
  ]);
  assert.deepEqual(parsed, [
    { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients: [{ kind: 'area', id: 'physics' }] },
    { id: 'abcd1235', name: 'Empty', order: 'newest', ingredients: [] },
  ]);
  assert.deepEqual(parseCustomFeeds({ abcd1234: { name: 'Thesis' } }), []);
});

test('an OpenAlex id may arrive as its URL, and a label must name something', () => {
  const [feed] = parseCustomFeeds([feedOf('abcd1234', [
    { kind: 'author', id: 'https://openalex.org/A5023888391', label: ' Aiko Sato ' },
    { kind: 'topic', id: 'https://openalex.org/C121332964', label: 'Physics' },
    { kind: 'author', id: 'https://api.openalex.org/authors/A5000000001', label: 'Ben Ito' },
    { kind: 'topic', id: 'https://openalex.org/topics/T10020', label: 'Quantum computing' },
    { kind: 'topic', id: 'T10020', label: '   ' },
    { kind: 'topic', id: 'X10020', label: 'Not a topic' },
    { kind: 'author', id: 'A1', label: 'x'.repeat(201) },
  ])]);
  assert.deepEqual(feed.ingredients, [
    { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' },
    { kind: 'topic', id: 'C121332964', label: 'Physics' },
    { kind: 'author', id: 'A5000000001', label: 'Ben Ito' },
    { kind: 'topic', id: 'T10020', label: 'Quantum computing' },
  ]);
});

test('one ingredient is validated and normalised on its own', () => {
  assert.deepEqual(parseFeedIngredient({ kind: 'area', id: 'physics' }), { kind: 'area', id: 'physics' });
  assert.deepEqual(parseFeedIngredient({ kind: 'category', id: 'quant-ph' }), { kind: 'category', id: 'quant-ph' });
  assert.deepEqual(parseFeedIngredient({ kind: 'topic', id: 'https://openalex.org/T10020', label: ' Quantum computing ' }), { kind: 'topic', id: 'T10020', label: 'Quantum computing' });
  assert.deepEqual(parseFeedIngredient({ kind: 'author', id: 'https://api.openalex.org/authors/A5023888391', label: 'Aiko Sato' }), { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' });
  assert.deepEqual(parseFeedIngredient({ kind: 'keyword', query: ' Surface  Code ' }), { kind: 'keyword', query: 'surface code' });
  assert.equal(parseFeedIngredient({ kind: 'journal', id: 'S123' }), null);
});

test('a name is counted by the characters a reader sees', () => {
  assert.equal(feedNameProblem('🧪'.repeat(32), []), null);
  assert.equal(feedNameProblem('🧪'.repeat(33), []), 'too-long');
  assert.equal(feedNameProblem('   ', []), 'empty');
  assert.equal(feedNameProblem('thesis', [{ id: 'abcd1234', name: 'Thesis', order: 'newest', ingredients: [] }]), 'taken');
  assert.equal(feedNameProblem('thesis', [{ id: 'abcd1234', name: 'Thesis', order: 'newest', ingredients: [] }], 'abcd1234'), null);
  assert.equal(feedNameProblem('فيزياء الكم', []), null);
});

test('a keyword is what a search can be made of', () => {
  const [feed] = parseCustomFeeds([feedOf('abcd1234', [keyword(' Surface   Code '), keyword('?'), keyword('a'), keyword('x'.repeat(121))])]);
  assert.deepEqual(feed.ingredients, [{ kind: 'keyword', query: 'surface code' }]);
});

test('a feed asks the corpus for its areas, categories and follows, in its order', () => {
  const feed = { id: 'abcd1234', name: 'Thesis', order: 'newest' as const, ingredients: [
    { kind: 'area' as const, id: 'physics' }, { kind: 'category' as const, id: 'cs.IT' },
    { kind: 'author' as const, id: 'A5023888391', label: 'Aiko Sato' }, { kind: 'keyword' as const, query: 'surface code' },
  ] };
  const request = corpusRequestOf(feed);
  assert.deepEqual(request.areas, ['physics']);
  assert.deepEqual(request.categories, ['cs.IT']);
  assert.equal(request.order, 'daily');
  assert.deepEqual(request.follows.map(follow => [follow.type, follow.displayName]), [['author', 'Aiko Sato'], ['topic', 'surface code']]);
  assert.equal(request.follows[1].metadata?.query, 'surface code');
});

test('every follow a feed asks for is served from a lane', () => {
  const request = corpusRequestOf({ ...feedOf('abcd1234', [
    { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' },
    { kind: 'topic', id: 'T10020', label: 'Quantum computing' },
    { kind: 'topic', id: 'C121332964', label: 'Physics' },
    keyword('surface code'),
  ]), order: 'best' });
  assert.equal(request.order, 'relevance');
  assert.deepEqual(request.follows.map(followLane), ['author:A5023888391', 'topic:T10020', 'concept:C121332964', 'query:surface code']);
});

test('a keyword no search can be made of is left out of the request', () => {
  const request = corpusRequestOf(feedOf('abcd1234', [keyword('?'), keyword('surface code')]));
  assert.deepEqual(request.follows.map(follow => follow.displayName), ['surface code']);
});

test('adding the ninth feed is refused; moving the first feed left changes nothing', () => {
  const eight = Array.from({ length: 8 }, (_, index) => feedOf(`feed000${index}`, []));
  assert.throws(
    () => withFeedAdded(eight, { name: 'Ninth', order: 'newest', ingredients: [] }, 'feed0008'),
    (error: unknown) => error instanceof CustomFeedError && error.code === 'feed-limit',
  );
  assert.deepEqual(withFeedMoved(eight, 'feed0000', -1), eight);
});

test('feeds are added, changed, moved and removed by id', () => {
  const added = withFeedAdded([], { name: ' Thesis ', order: 'newest', ingredients: [keyword('surface code')] }, 'abcd1234');
  assert.deepEqual(added, [feedOf('abcd1234', [keyword('surface code')], 'Thesis')]);

  const two = withFeedAdded(added, { name: 'Lab', order: 'best', ingredients: [] }, 'abcd1235');
  const changed = withFeedChanged(two, 'abcd1234', { name: ' Draft ', order: 'best', ingredients: [] });
  assert.deepEqual(changed.map(feed => [feed.id, feed.name, feed.order]), [['abcd1234', 'Draft', 'best'], ['abcd1235', 'Lab', 'best']]);
  assert.throws(
    () => withFeedChanged(two, 'missing1', { name: 'Gone', order: 'newest', ingredients: [] }),
    (error: unknown) => error instanceof CustomFeedError && error.code === 'missing',
  );

  assert.deepEqual(withFeedMoved(two, 'abcd1234', 1).map(feed => feed.id), ['abcd1235', 'abcd1234']);
  assert.deepEqual(withFeedMoved(two, 'abcd1235', 1), two);
  assert.deepEqual(withFeedRemoved(two, 'abcd1234').map(feed => feed.id), ['abcd1235']);
});

test('an ingredient is refused when it repeats, fills the feed or passes the account ceiling', () => {
  assert.equal(ingredientProblem(author(1), [author(1)], []), 'duplicate');
  assert.equal(ingredientProblem(author(21), Array.from({ length: 20 }, (_, index) => author(index + 1)), []), 'feed-full');

  const thirty = [feedOf('abcd1234', Array.from({ length: 20 }, (_, index) => author(index + 1))), feedOf('abcd1235', Array.from({ length: 10 }, (_, index) => topic(index + 1)))];
  assert.equal(ingredientProblem(topic(11), [], thirty), 'entities-full');
  assert.equal(ingredientProblem(author(1), [], thirty), null);

  const ten = [feedOf('abcd1234', WORDS.slice(0, 10).map(keyword))];
  assert.equal(ingredientProblem(keyword(WORDS[10]), [], ten), 'keywords-full');
  assert.equal(ingredientProblem(keyword(WORDS[0]), [], ten), null);
  assert.equal(ingredientProblem({ kind: 'category', id: 'quant-ph' }, [], [...thirty, ...ten]), null);
});

test('an ingredient is known by its key and named by its label', () => {
  assert.equal(ingredientKey({ kind: 'category', id: 'quant-ph' }), 'category:quant-ph');
  assert.equal(ingredientKey(keyword('surface code')), 'keyword:surface code');
  assert.equal(ingredientLabel({ kind: 'area', id: 'physics' }), 'Physics');
  assert.equal(ingredientLabel({ kind: 'category', id: 'quant-ph' }), 'Quantum Physics');
  assert.equal(ingredientLabel({ kind: 'category', id: 'physics.retired' }), 'physics.retired');
  assert.equal(ingredientLabel(keyword('surface code')), 'surface code');
  assert.equal(ingredientLabel(author(1)), 'Author 1');
});

test('a follow becomes the ingredient it names, or none', () => {
  assert.deepEqual(ingredientFromFollow({ type: 'topic', canonicalId: 'physics', displayName: 'Physics' }), { kind: 'area', id: 'physics' });
  assert.deepEqual(ingredientFromFollow({ type: 'topic', id: 'quant-ph', displayName: 'Quantum Physics' }), { kind: 'category', id: 'quant-ph' });
  assert.deepEqual(ingredientFromFollow({ type: 'topic', canonicalId: 'https://openalex.org/T10020', displayName: 'Quantum computing' }), { kind: 'topic', id: 'T10020', label: 'Quantum computing' });
  assert.deepEqual(ingredientFromFollow({ type: 'topic', canonicalId: 'query-1a2b3c4d', displayName: 'Surface Code', metadata: { query: 'Surface Code' } }), { kind: 'keyword', query: 'surface code' });
  assert.deepEqual(ingredientFromFollow({ type: 'author', canonicalId: 'A5023888391', displayName: 'Aiko Sato' }), { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' });
  assert.equal(ingredientFromFollow({ type: 'author', canonicalId: 'legacy:aiko sato', displayName: 'Aiko Sato' }), null);
  assert.equal(ingredientFromFollow({ type: 'institution', canonicalId: 'I1321305853', displayName: 'MIT' }), null);
  assert.equal(ingredientFromFollow({ type: 'topic', canonicalId: 'query-1a2b3c4d', displayName: '?', metadata: { query: '?' } }), null);
});
