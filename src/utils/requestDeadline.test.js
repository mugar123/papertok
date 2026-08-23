import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestDeadline,
  withRequestDeadline,
} from './requestDeadline.js';

test('gives a caller without a signal one that fires on its own', async () => {
  const signal = requestDeadline({}, 20);
  assert.equal(signal.aborted, false);
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.reason.name, 'TimeoutError');
});

test('keeps the signal a caller brought instead of shortening its budget', () => {
  const controller = new AbortController();
  const options = withRequestDeadline({ signal: controller.signal, method: 'POST' }, 20);
  // The AI explanation is allowed seventy seconds; a default that overrode this
  // would cut it off at fifteen.
  assert.equal(options.signal, controller.signal);
  assert.equal(options.method, 'POST');
});

test('the deadline still covers a body that arrives after the headers', async () => {
  // The whole point of the helper: a response whose headers are already in hand
  // must still be cut if its body never finishes.
  const signal = requestDeadline({}, 20);
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }));

  await assert.rejects(() => response.text(), error => error.name === 'TimeoutError');
});

test('defaults to fifteen seconds, comfortably inside every caller budget', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);
});
