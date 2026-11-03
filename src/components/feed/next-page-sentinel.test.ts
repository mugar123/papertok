import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { NEXT_PAGE_RETRY_MS, createNextPageSentinel } from './next-page-sentinel.ts';

test.afterEach(() => mock.timers.reset());

/**
 * The end of the For You feed, wired the way FeedContainer wires it: every
 * load that starts or ends runs the sentinel effect again, and its new
 * observer reports at once whether the sentinel is in range. A request stays
 * out until the test settles it, as a failure while `failing` is set.
 */
function feedEnd({ inRange = true, failing = false } = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const feed = { requests: 0, loading: false, error: null as string | null, inRange, failing };
  let sentinel: ReturnType<typeof createNextPageSentinel> | null = null;
  const observe = () => {
    sentinel?.stop();
    sentinel = createNextPageSentinel({
      failed: Boolean(feed.error),
      hasMore: true,
      loading: feed.loading,
      loadMore: () => {
        feed.requests += 1;
        feed.loading = true;
        feed.error = null;
        observe();
      },
    });
    sentinel.report(feed.inRange);
  };
  const settle = () => {
    feed.loading = false;
    feed.error = feed.failing ? 'FEED_LOAD_FAILED' : null;
    observe();
  };
  // The reader moves the sentinel into or out of range; the observer reports it.
  const scroll = (toRange: boolean) => {
    feed.inRange = toRange;
    sentinel?.report(toRange);
  };
  observe();
  return { feed, settle, scroll };
}

test('a failed next page is not asked for again each time its load ends while the reader stays near the end', () => {
  const end = feedEnd({ failing: true });
  assert.equal(end.feed.requests, 1, 'the reader reached the end');
  for (let failures = 0; failures < 10 && end.feed.loading; failures += 1) end.settle();
  assert.equal(end.feed.requests, 1, 'one request for the failure, not one per ended attempt');
  assert.equal(end.feed.error, 'FEED_LOAD_FAILED', 'the failure stays on the feed');
});

test('a failed next page is asked for again once its pause is over, and a new failure waits a whole pause again', () => {
  const end = feedEnd({ failing: true });
  end.settle();
  mock.timers.tick(NEXT_PAGE_RETRY_MS - 1);
  assert.equal(end.feed.requests, 1);
  mock.timers.tick(1);
  assert.equal(end.feed.requests, 2, 'one retry after the pause');
  end.settle();
  mock.timers.tick(NEXT_PAGE_RETRY_MS - 1);
  assert.equal(end.feed.requests, 2);
  end.feed.failing = false;
  mock.timers.tick(1);
  assert.equal(end.feed.requests, 3);
  end.settle();
  assert.equal(end.feed.error, null, 'the source recovered and the page landed');
});

test('a reader who scrolls back toward the end asks for the failed page again at once', () => {
  const end = feedEnd({ failing: true });
  end.settle();
  end.scroll(false);
  assert.equal(end.feed.requests, 1);
  end.scroll(true);
  assert.equal(end.feed.requests, 2);
});

test('a failed page that left the reader far from the end is asked for when the reader comes near', () => {
  const end = feedEnd({ failing: true });
  end.feed.inRange = false;
  end.settle();
  end.scroll(true);
  assert.equal(end.feed.requests, 2);
});

test('without a failure the feed loads as before: each time the sentinel comes in range, and again at once after a page that leaves it there', () => {
  const end = feedEnd({ inRange: false });
  assert.equal(end.feed.requests, 0, 'the sentinel is out of range');
  end.scroll(true);
  assert.equal(end.feed.requests, 1);
  end.scroll(false);
  end.settle();
  assert.equal(end.feed.requests, 1, 'the page landed below the reader');
  end.scroll(true);
  assert.equal(end.feed.requests, 2);
  end.settle();
  assert.equal(end.feed.requests, 3, 'a short page left the sentinel in range');
});
