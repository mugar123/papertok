import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeErrorEvent } from './errorTelemetry.ts';

test('errors retain source locations and debug IDs without request, user or content data', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const event = sanitizeErrorEvent({
    type: undefined, event_id: 'event-id', environment: 'production', release: 'release-sha',
    message: 'Private title', user: { email: 'private@example.com' },
    request: { url: 'https://papertok.app/search?q=private', data: { quote: 'Private note' }, headers: { authorization: 'secret' } },
    extra: { paper_id: 'W123' }, breadcrumbs: [{ message: 'Private search' }],
    exception: { values: [{
      type: 'TypeError', value: 'Private title', mechanism: { type: 'auto.browser', handled: false, data: { secret: 'private' } },
      stacktrace: { frames: [
        { filename: 'https://papertok.app/assets/Reader-hash.js?token=private', lineno: 20, colno: 12, debug_id: id, function: 'private', vars: { note: 'Private note' }, context_line: 'Private context' },
        { filename: 'https://papertok.app/public/paper/W123', lineno: 1 },
        { filename: 'chrome-extension://private/content.js', lineno: 1 },
      ] },
    }] },
    tags: { operation: 'render', uid: 'private', query: 'private' },
    debug_meta: { images: [
      { type: 'sourcemap', code_file: 'https://papertok.app/assets/Reader-hash.js', debug_id: id },
      { type: 'sourcemap', code_file: 'https://outside.example/private.js', debug_id: id },
    ] },
  });
  assert.equal(event?.exception?.values?.[0].value, 'Application error (message redacted)');
  assert.deepEqual(event?.exception?.values?.[0].stacktrace?.frames, [{
    filename: 'https://papertok.app/assets/Reader-hash.js', abs_path: 'https://papertok.app/assets/Reader-hash.js', lineno: 20, colno: 12, debug_id: id,
  }]);
  assert.equal(event?.debug_meta?.images?.length, 1);
  assert.deepEqual(event?.tags, { operation: 'render' });
  assert.equal(event?.release, 'release-sha');
  assert.deepEqual(event?.user, { ip_address: '0.0.0.0' });
  assert.doesNotMatch(JSON.stringify(event), /private|W123|secret/i);
});

test('backend errors retain bundle coordinates and only approved status tags', () => {
  const event = sanitizeErrorEvent({
    type: undefined,
    exception: { values: [{ type: 'Provider says private', value: 'secret', stacktrace: { frames: [
      { filename: '/Users/developer/project/.wrangler/tmp/dev-abc/instrumentation.js', lineno: 500, colno: 42 },
    ] } }] },
    tags: { http_status: 503, operation: 'rewrite', token: 'secret' },
  });
  assert.deepEqual(event?.exception?.values?.[0].stacktrace?.frames, [{ filename: 'app:///instrumentation.js', abs_path: 'app:///instrumentation.js', lineno: 500, colno: 42 }]);
  assert.equal(event?.exception?.values?.[0].type, 'Error');
  assert.deepEqual(event?.tags, { http_status: 503, operation: 'rewrite' });
  assert.equal(sanitizeErrorEvent({ type: undefined, message: 'secret' }), null);
});
