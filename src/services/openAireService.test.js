import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import { fetchWithTimeout } from './openAireService.js';

test('the deadline covers an OpenAIRE body that never finishes', async () => {
  // The worst shape of the family: the response comes back unread and
  // `searchProjects` reads it some hundred and sixty lines away, so clearing the
  // timer here left that read with nothing bounding it.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout('https://api.openaire.eu/search/projects?keywords=deadline', 50);
        await response.json();
      }),
      'TimeoutError',
    );
  });
});

test('a caller signal does not take the OpenAIRE deadline away with it', async () => {
  // `SearchPage` aborts the in-flight project search on the next keystroke. That
  // signal is a cancellation, not a budget, so it has to add to the deadline
  // rather than replace it.
  const cancellation = new AbortController();
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout(
          'https://api.openaire.eu/search/projects?keywords=deadline',
          50,
          { signal: cancellation.signal },
        );
        await response.json();
      }),
      'TimeoutError',
    );
  });
});

test('a cancelled project search still reads as a cancellation', async () => {
  // `searchProjects` keeps quiet when `options.signal` aborted and logs
  // otherwise. Merging the deadline in must not turn a user cancellation into
  // something that looks like a timeout.
  const cancellation = new AbortController();
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout(
          'https://api.openaire.eu/search/projects?keywords=cancelled',
          60_000,
          { signal: cancellation.signal },
        );
        const body = response.json();
        cancellation.abort();
        await body;
      }),
      'AbortError',
    );
  });
});
