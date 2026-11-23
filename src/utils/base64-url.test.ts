import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBase64Url, encodeBase64Url } from './base64-url.ts';

test('round-trips short ASCII and UTF-8 strings and rejects invalid base64url characters', () => {
  for (const input of ['', 'doi:10.1000/abc.123', 'café-🧪-漢字']) {
    const encoded = encodeBase64Url(input);
    assert.equal(encoded, Buffer.from(input, 'utf8').toString('base64url'));
    assert.equal(decodeBase64Url(encoded), input);
  }
  assert.equal(decodeBase64Url('not valid!'), '');
});

test('round-trips inputs larger than the JavaScript argument spread limit without throwing', () => {
  const largeAscii = `doi:10.1000/${'a'.repeat(150_000)}`;
  const encodedAscii = encodeBase64Url(largeAscii);
  assert.equal(encodedAscii.length, 200_016);
  assert.equal(encodedAscii, Buffer.from(largeAscii, 'utf8').toString('base64url'));
  assert.equal(decodeBase64Url(encodedAscii), largeAscii);

  // Place multi-byte UTF-8 sequences across the 0x8000-byte chunk boundary.
  const largeUtf8 = `${'a'.repeat(0x8000 - 1)}é🧪漢${'b'.repeat(0x8000)}`;
  const encodedUtf8 = encodeBase64Url(largeUtf8);
  assert.equal(encodedUtf8, Buffer.from(largeUtf8, 'utf8').toString('base64url'));
  assert.equal(decodeBase64Url(encodedUtf8), largeUtf8);
});
