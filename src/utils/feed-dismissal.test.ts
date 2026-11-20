import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissalFor } from './feed-dismissal.ts';
import type { Paper } from '../models/paper.ts';

const paper = { id: 'arxiv:2401.00001', title: 'A paper' } as Paper;

test('a feed that brings its own dismissal removes the paper without telling the account', () => {
  const calls: string[] = [];
  const account = { hide: () => { calls.push('account'); }, restore: () => { calls.push('account-restore'); } };
  const own = dismissalFor({ dismissal: { hide: () => { calls.push('feed'); }, restore: () => { calls.push('feed-restore'); }, label: 'Removed from this feed', hint: 'Remove it from this feed' } }, account);
  own.hide(paper); own.restore(paper, null);
  assert.deepEqual(calls, ['feed', 'feed-restore']);
  assert.equal(own.label, 'Removed from this feed');
  assert.equal(dismissalFor(null, account).label, 'Marked as not interested');
});

test('without a dismissal of its own, the feed tells the account, with the position to restore at', () => {
  const calls: unknown[] = [];
  const account = {
    hide: (p: Paper) => { calls.push(['hide', p.id]); },
    restore: (p: Paper, atIndex: number | null) => { calls.push(['restore', p.id, atIndex]); },
  };
  const fallback = dismissalFor({}, account);
  fallback.hide(paper); fallback.restore(paper, 3);
  assert.deepEqual(calls, [['hide', paper.id], ['restore', paper.id, 3]]);
  assert.equal(fallback.label, 'Marked as not interested');
});

test('the hint under "Not interested" is the feed\'s own, or the account\'s promise to show fewer like it', () => {
  const account = { hide: () => {}, restore: () => {} };
  const own = { hide: () => {}, restore: () => {}, label: 'Removed from this feed', hint: 'Remove it from this feed' };
  assert.equal(dismissalFor({ dismissal: own }, account).hint, 'Remove it from this feed');
  assert.equal(dismissalFor({}, account).hint, 'See fewer papers like this');
  assert.equal(dismissalFor(null, account).hint, 'See fewer papers like this');
});
