import test from 'node:test';
import assert from 'node:assert/strict';
import { allFeedTabs, customFeedIdFromPath, customFeedPath, customFeedTabKey } from './feed-tabs.ts';

test('the tabs are the fixed ones and then the reader\'s feeds, in their order', () => {
  assert.deepEqual(allFeedTabs([{ id: 'abcd1234', name: 'Thesis' }]).map(tab => [tab.key, tab.path, tab.label]),
    [['home', '/feed', 'For you'], ['recent', '/recent', 'Most recent'], ['following', '/following', 'Following'], ['feed:abcd1234', '/feeds/abcd1234', 'Thesis']]);
  assert.equal(customFeedIdFromPath('/feeds/abcd1234/'), 'abcd1234');
  assert.equal(customFeedIdFromPath('/feeds'), null);
  assert.equal(customFeedIdFromPath('/feeds/a/b'), null);
});

test('Most recent sits between For you and Following', () => {
  assert.deepEqual(allFeedTabs([]).map(tab => tab.path), ['/feed', '/recent', '/following']);
});

test('a feed\'s address reads back as its id', () => {
  assert.equal(customFeedPath('abcd1234'), '/feeds/abcd1234');
  assert.equal(customFeedIdFromPath(customFeedPath('abcd1234')), 'abcd1234');
  assert.equal(customFeedIdFromPath('/feed'), null);
  assert.equal(customFeedIdFromPath('/following'), null);
});

test('a feed\'s tab key is the key the bar gives its tab', () => {
  assert.equal(customFeedTabKey('abc'), 'feed:abc');
  assert.equal(allFeedTabs([{ id: 'abc', name: 'Thesis' }]).at(-1)?.key, customFeedTabKey('abc'));
});
