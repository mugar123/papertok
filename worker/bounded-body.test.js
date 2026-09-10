import assert from 'node:assert/strict';
import test from 'node:test';
import { readBoundedBytes, readBoundedJson } from './bounded-body.js';

const errors = {
  tooLarge: () => new Error('TOO_LARGE'),
  invalid: () => new Error('INVALID'),
};

/**
 * A body that arrives in pieces, which is the only shape that matters here: a
 * single `arrayBuffer()` has already spent the memory by the time anything can
 * look at how much of it there was.
 */
function chunked(bytes, size = 65_536) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
}

function chunkedRequest(bytes) {
  return new Request('https://w/ai/explain', { method: 'POST', body: chunked(bytes), duplex: 'half' });
}

test('a chunked body over the cap is rejected before it is buffered', { timeout: 10_000 }, async () => {
  const big = new TextEncoder().encode(JSON.stringify({ title: 'x'.repeat(4_000_000) }));
  await assert.rejects(readBoundedJson(chunkedRequest(big), 100_000, errors), /TOO_LARGE/);
});

test('a body that declares itself too large never gets read', { timeout: 10_000 }, async () => {
  // Hand-built rather than a real `Request`: undici starts pulling a stream body
  // the moment the request is constructed, which would hide whether the header
  // shortcut fired. The body here refuses to be read at all.
  const request = {
    headers: new Headers({ 'content-length': '400000' }),
    body: { getReader: () => { throw new Error('an honest oversized upload must not be read'); } },
  };
  await assert.rejects(readBoundedJson(request, 100_000, errors), /TOO_LARGE/);
});

test('a body inside the cap parses', { timeout: 10_000 }, async () => {
  const payload = { level: 'university', paper: { title: 'A study of things' } };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  assert.deepEqual(await readBoundedJson(chunkedRequest(bytes), 100_000, errors), payload);
});

test('a body that is not JSON raises the caller\'s invalid error', { timeout: 10_000 }, async () => {
  const bytes = new TextEncoder().encode('{ not json');
  await assert.rejects(readBoundedJson(chunkedRequest(bytes), 100_000, errors), /INVALID/);
});

test('readBoundedBytes stops a 9 MiB PDF at the cap', { timeout: 10_000 }, async () => {
  const response = new Response(chunked(new Uint8Array(9 * 1024 * 1024)));
  assert.equal(await readBoundedBytes(response, 8 * 1024 * 1024), null);
});

test('readBoundedBytes returns a PDF that fits, whole', { timeout: 10_000 }, async () => {
  const pdf = new Uint8Array(200_000).fill(7);
  const bytes = await readBoundedBytes(new Response(chunked(pdf)), 8 * 1024 * 1024);
  assert.equal(bytes.byteLength, 200_000);
  assert.equal(bytes[199_999], 7);
});
