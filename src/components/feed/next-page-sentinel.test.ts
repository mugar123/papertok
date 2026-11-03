import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createNextPageSentinel, type NextPageRetries } from './next-page-sentinel.ts';

test.afterEach(() => mock.timers.reset());

/**
 * The end of the For You feed, wired the way FeedContainer wires it: every
 * load that starts or ends runs the sentinel effect again, and its new
 * observer reports at once whether the sentinel is in range. The retries are
 * FeedContainer's, kept across sentinels. A request stays out until the test
 * settles it, as a failure while `failing` is set. The clock starts at 0.
 */
function feedEnd({ inRange = true, failing = false } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const feed = { requests: [] as number[], attempts: [] as string[], loading: false, error: null as string | null, inRange, failing };
  const retries: NextPageRetries = { failedAt: null, used: 0 };
  const page = Object.assign(new EventTarget(), { hidden: false });
  let sentinel: ReturnType<typeof createNextPageSentinel> | null = null;
  const observe = () => {
    sentinel?.stop();
    sentinel = createNextPageSentinel({
      failed: Boolean(feed.error),
      hasMore: true,
      loading: feed.loading,
      loadMore: (attempt) => {
        feed.requests.push(Date.now());
        // What the load reports as its attempt; loadPapers defaults it to `original`.
        feed.attempts.push(attempt ?? 'original');
        feed.loading = true;
        feed.error = null;
        observe();
      },
      retries,
      page,
    });
    sentinel.report(feed.inRange);
  };
  // The reader switches to another tab or app, or comes back.
  const setHidden = (hidden: boolean) => {
    page.hidden = hidden;
    page.dispatchEvent(new Event('visibilitychange'));
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
  // The list changes with no load (a card dismissed, an abstract arriving):
  // `loadMore` is a new function, so the effect runs again.
  const rerender = observe;
  // Time passes, and each request is answered as soon as it goes out. A page
  // that lands puts the sentinel out of range, below the reader.
  const answer = () => {
    if (!feed.loading) return;
    if (!feed.failing) feed.inRange = false;
    settle();
  };
  // Steps of 100 ms, so each pause below ends on a step: the mocked clock
  // reads the end of a step inside the timers it runs.
  const wait = (ms: number) => {
    answer();
    for (let waited = 0; waited < ms; waited += 100) {
      mock.timers.tick(Math.min(100, ms - waited));
      answer();
    }
  };
  const gaps = () => feed.requests.slice(1).map((at, index) => at - feed.requests[index]);
  observe();
  return { feed, settle, scroll, rerender, setHidden, wait, gaps };
}

test('a failed next page is not asked for again each time its load ends while the reader stays near the end', () => {
  const end = feedEnd({ failing: true });
  assert.equal(end.feed.requests.length, 1, 'the reader reached the end');
  for (let failures = 0; failures < 10 && end.feed.loading; failures += 1) end.settle();
  assert.equal(end.feed.requests.length, 1, 'one request for the failure, not one per ended attempt');
  assert.equal(end.feed.error, 'FEED_LOAD_FAILED', 'the failure stays on the feed');
});

test('a reader parked at the end through an outage gets retries further and further apart, never more than two minutes', () => {
  const end = feedEnd({ failing: true });
  end.wait(10 * 60_000);
  assert.deepEqual(end.gaps(), [2_500, 5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
  end.wait(50 * 60_000);
  assert.equal(end.feed.requests.length, 35, 'an hour of outage, where a fixed 10 s pause sent 361 requests');
});

test('a page that lands starts the pauses again from the shortest', () => {
  const end = feedEnd({ failing: true });
  end.wait(17_500);
  assert.equal(end.feed.requests.length, 4, 'three retries, so the next pause would be 20 s');
  end.feed.failing = false;
  end.wait(20_000);
  assert.equal(end.feed.requests.length, 5);
  assert.equal(end.feed.error, null, 'the source recovered and the page landed');
  end.feed.failing = true;
  end.scroll(true);
  end.settle();
  end.wait(2_499);
  assert.equal(end.feed.requests.length, 6, 'the next page failed');
  end.wait(1);
  assert.equal(end.feed.requests.length, 7, 'its retry waits the first pause, not the fifth');
});

test('the pause counts from the failure, not from the last change to the list', () => {
  const end = feedEnd({ failing: true });
  end.settle();
  for (let change = 0; change < 4; change += 1) {
    end.wait(600);
    end.rerender();
  }
  end.wait(2_100);
  assert.deepEqual(end.feed.requests, [0, 2_500]);
});

test('a hidden tab sends no automatic retry; shown again, it asks at once if the pause is over and waits out the rest if not', () => {
  const end = feedEnd({ failing: true });
  end.settle();
  end.setHidden(true);
  end.wait(60 * 60_000);
  assert.equal(end.feed.requests.length, 1, 'an hour in the background');
  end.setHidden(false);
  assert.equal(end.feed.requests.length, 2, 'the retry that fell due while hidden');
  end.settle();
  end.setHidden(true);
  end.wait(1_000);
  end.setHidden(false);
  end.wait(3_999);
  assert.equal(end.feed.requests.length, 2, 'shown again before its 5 s pause was over');
  end.wait(1);
  assert.equal(end.feed.requests.length, 3);
});

test('the retries a pause makes count as automatic retries; the reader\'s retry and a new page count as original attempts', () => {
  const end = feedEnd({ failing: true });
  end.wait(2_500);
  end.scroll(false);
  end.scroll(true);
  end.settle();
  end.feed.failing = false;
  end.wait(5_000);
  end.scroll(true);
  assert.deepEqual(end.feed.attempts, ['original', 'automatic_retry', 'original', 'automatic_retry', 'original']);
});

test('a reader who scrolls back toward the end asks for the failed page again at once', () => {
  const end = feedEnd({ failing: true });
  end.settle();
  end.scroll(false);
  assert.equal(end.feed.requests.length, 1);
  end.scroll(true);
  assert.equal(end.feed.requests.length, 2);
});

test('the reader\'s own retries leave the automatic pauses as long as they had grown', () => {
  const end = feedEnd({ failing: true });
  end.wait(17_500);
  end.scroll(false);
  end.scroll(true);
  end.settle();
  assert.equal(end.feed.requests.length, 5, 'three automatic retries and one of the reader\'s');
  end.wait(19_999);
  assert.equal(end.feed.requests.length, 5);
  end.wait(1);
  assert.equal(end.feed.requests.length, 6);
});

test('a failed page that left the reader far from the end is asked for when the reader comes near', () => {
  const end = feedEnd({ failing: true });
  end.feed.inRange = false;
  end.settle();
  end.scroll(true);
  assert.equal(end.feed.requests.length, 2);
});

test('without a failure the feed loads as before: each time the sentinel comes in range, and again at once after a page that leaves it there', () => {
  const end = feedEnd({ inRange: false });
  assert.equal(end.feed.requests.length, 0, 'the sentinel is out of range');
  end.scroll(true);
  assert.equal(end.feed.requests.length, 1);
  end.scroll(false);
  end.settle();
  assert.equal(end.feed.requests.length, 1, 'the page landed below the reader');
  end.scroll(true);
  assert.equal(end.feed.requests.length, 2);
  end.settle();
  assert.equal(end.feed.requests.length, 3, 'a short page left the sentinel in range');
});
