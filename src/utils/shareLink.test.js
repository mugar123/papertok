import test from 'node:test';
import assert from 'node:assert/strict';
import { shareOrCopyLink } from './shareLink.js';

const URL_UNDER_TEST = 'https://example.test/#/public/list/abc';

test('prefers the native sheet and never touches the clipboard when it works', async () => {
  const calls = [];
  const outcome = await shareOrCopyLink({
    url: URL_UNDER_TEST,
    title: 'Reading list',
    share: async payload => calls.push(['share', payload]),
    copy: async () => calls.push(['copy']),
  });
  assert.equal(outcome, 'shared');
  assert.deepEqual(calls, [['share', { title: 'Reading list', url: URL_UNDER_TEST }]]);
});

test('a dismissed sheet is not an error and does not copy behind the user', async () => {
  // Closing the share sheet means "never mind" — silently copying anyway
  // would put the link on the clipboard against an explicit decision.
  const calls = [];
  const outcome = await shareOrCopyLink({
    url: URL_UNDER_TEST,
    share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    copy: async () => calls.push(['copy']),
  });
  assert.equal(outcome, 'aborted');
  assert.deepEqual(calls, []);
});

test('falls back to the clipboard when the sheet refuses', async () => {
  // Transient activation expires while a publish request is awaited, and the
  // sheet then throws NotAllowedError; the link must still leave the app.
  const copied = [];
  const outcome = await shareOrCopyLink({
    url: URL_UNDER_TEST,
    share: async () => { throw Object.assign(new Error('no activation'), { name: 'NotAllowedError' }); },
    copy: async url => copied.push(url),
  });
  assert.equal(outcome, 'copied');
  assert.deepEqual(copied, [URL_UNDER_TEST]);
});

test('copies directly when there is no native sheet', async () => {
  const copied = [];
  const outcome = await shareOrCopyLink({
    url: URL_UNDER_TEST,
    share: null,
    copy: async url => copied.push(url),
  });
  assert.equal(outcome, 'copied');
  assert.deepEqual(copied, [URL_UNDER_TEST]);
});

test('a clipboard failure propagates to the caller that knows how to render it', async () => {
  await assert.rejects(
    shareOrCopyLink({
      url: URL_UNDER_TEST,
      share: null,
      copy: async () => { throw new Error('clipboard unavailable'); },
    }),
    /clipboard unavailable/,
  );
});

test('requires the copy fallback up front', async () => {
  await assert.rejects(shareOrCopyLink({ url: URL_UNDER_TEST, share: null }), TypeError);
});
