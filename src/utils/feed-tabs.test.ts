import test from 'node:test';
import assert from 'node:assert/strict';
import { allFeedTabs, customFeedIdFromPath, customFeedPath } from './feed-tabs.ts';

test('the tabs are the fixed ones and then the reader\'s feeds, in their order', () => {
  assert.deepEqual(allFeedTabs([{ id: 'abcd1234', name: 'Thesis' }]).map(tab => [tab.key, tab.path, tab.label]),
    [['home', '/feed', 'For you'], ['following', '/following', 'Following'], ['feed:abcd1234', '/feeds/abcd1234', 'Thesis']]);
  assert.equal(customFeedIdFromPath('/feeds/abcd1234/'), 'abcd1234');
  assert.equal(customFeedIdFromPath('/feeds'), null);
  assert.equal(customFeedIdFromPath('/feeds/a/b'), null);
});

test('a feed\'s address reads back as its id', () => {
  assert.equal(customFeedPath('abcd1234'), '/feeds/abcd1234');
  assert.equal(customFeedIdFromPath(customFeedPath('abcd1234')), 'abcd1234');
  assert.equal(customFeedIdFromPath('/feed'), null);
  assert.equal(customFeedIdFromPath('/following'), null);
});
