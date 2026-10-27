import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeExceptionProperties } from './error-telemetry.ts';

test('errors retain code locations and chunk ids without request, user or content data', () => {
  const properties = sanitizeExceptionProperties({
    $exception_list: [{
      type: 'TypeError', value: 'Private title', mechanism: { type: 'onerror', handled: false, synthetic: false, source: 'private' },
      stacktrace: { type: 'raw', frames: [
        { platform: 'web:javascript', filename: 'https://papertok.app/assets/Reader-hash.js?token=private', function: 'renderReader', lineno: 20, colno: 12, in_app: true, chunk_id: 'chunk-1', context_line: 'Private context', vars: { note: 'Private note' } },
        { platform: 'web:javascript', filename: 'https://papertok.app/public/paper/W123', function: 'x', lineno: 1 },
        { platform: 'web:javascript', filename: 'chrome-extension://private/content.js', function: 'x', lineno: 1 },
      ] },
    }],
    $exception_message: 'Private title', $exception_personURL: 'https://eu.posthog.com/person/private',
    $current_url: 'https://papertok.app/search?q=private', email: 'private@example.com', paper_id: 'W123',
    operation: 'render', uid: 'private', $release_id: '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d',
  });
  assert.deepEqual(properties, {
    $exception_level: 'error',
    $exception_list: [{
      type: 'TypeError',
      value: 'Application error (message redacted)',
      mechanism: { type: 'generic', handled: false, synthetic: false },
      stacktrace: { type: 'raw', frames: [{
        platform: 'web:javascript', filename: 'https://papertok.app/assets/Reader-hash.js', function: 'renderReader', in_app: true, lineno: 20, colno: 12, chunk_id: 'chunk-1',
      }] },
    }],
    $release_id: '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d',
    operation: 'render',
  });
});

test('backend errors retain bundle coordinates and only approved status labels', () => {
  const properties = sanitizeExceptionProperties({
    $exception_list: [{ type: 'Provider says private', value: 'secret', stacktrace: { type: 'raw', frames: [
      { platform: 'node:javascript', filename: '/Users/developer/project/.wrangler/tmp/dev-abc/instrumentation.js', function: 'private words here!', lineno: 500, colno: 42 },
    ] } }],
    http_status: 503, operation: 'rewrite', token: 'secret',
  });
  assert.deepEqual(properties?.$exception_list[0].stacktrace.frames, [
    { platform: 'node:javascript', filename: 'app:///instrumentation.js', function: '?', in_app: true, lineno: 500, colno: 42 },
  ]);
  assert.equal(properties?.$exception_list[0].type, 'Error');
  assert.equal(properties?.http_status, 503);
  assert.equal(properties?.operation, 'rewrite');
  assert.doesNotMatch(JSON.stringify(properties), /private|secret/i);
  assert.equal(sanitizeExceptionProperties({ $exception_message: 'secret' }), null);
});

test('email capacity errors retain only the safe alert label', () => {
  const properties = sanitizeExceptionProperties({
    $exception_list: [{ type: 'Error', value: 'recipient@example.com' }],
    operation: 'schedule', email_limit: 'reached', recipient: 'recipient@example.com',
  });
  assert.equal(properties?.operation, 'schedule');
  assert.equal(properties?.email_limit, 'reached');
  assert.doesNotMatch(JSON.stringify(properties), /recipient@example.com/);
});
