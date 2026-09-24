import test from 'node:test';
import assert from 'node:assert/strict';
import { paperShareData, shareOrCopyLink } from './shareLink.js';

// The shape publicNavigation.js mints: a real path, no fragment. This helper
// never parses the URL — it hands it to the sheet or the clipboard whole — but
// a fixture that still said `#/` would read as if it did.
const URL_UNDER_TEST = 'https://example.test/public/list/abc';

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

// A shared paper used to leave as `{ title, url }`, and most share targets
// print only `text` and `url`: the message arrived as a bare link whose key
// nobody can read (audit 2026-09-23, issue 5). The title rides as `text`, as
// plain text, because no share target renders LaTeX.
test('a paper leaves with its title as plain text, for the target to print beside the link', () => {
  assert.deepEqual(
    paperShareData({ title: 'On commensurations of pro-$\\mathcal{C}$ groups', url: URL_UNDER_TEST }),
    {
      title: 'On commensurations of pro-C groups',
      text: 'On commensurations of pro-C groups',
      url: URL_UNDER_TEST,
    },
  );
  assert.deepEqual(paperShareData({ title: '   ', url: URL_UNDER_TEST }), { url: URL_UNDER_TEST });
});

test('the text reaches the native sheet with the title and the link', async () => {
  const calls = [];
  await shareOrCopyLink({
    url: URL_UNDER_TEST,
    title: 'Attention Is All You Need',
    text: 'Attention Is All You Need',
    share: async payload => calls.push(payload),
    copy: async () => {},
  });
  assert.deepEqual(calls, [{ title: 'Attention Is All You Need', text: 'Attention Is All You Need', url: URL_UNDER_TEST }]);
});
