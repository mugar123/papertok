import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrcidHost, isValidOrcidId } from './orcid-id.ts';

test('accepts ORCID iDs whose check character is right, X included', () => {
  // Examples from ORCID's own documentation of the checksum.
  for (const id of ['0000-0002-1825-0097', '0000-0001-5109-3700', '0000-0002-1694-233X']) {
    assert.equal(isValidOrcidId(id), true, id);
  }
});

test('refuses an iD with a wrong check character, a lower-case x or another shape', () => {
  for (const value of ['0000-0002-1825-0098', '0000-0002-1694-233x', '0000-0002-1825-009', '0000000218250097', 'https://orcid.org/0000-0002-1825-0097', '', null, 18250097]) {
    assert.equal(isValidOrcidId(value), false, String(value));
  }
});

test('knows only the production registry and the sandbox', () => {
  assert.equal(isOrcidHost('orcid.org'), true);
  assert.equal(isOrcidHost('sandbox.orcid.org'), true);
  assert.equal(isOrcidHost('pub.orcid.org'), false);
  assert.equal(isOrcidHost('evil.example'), false);
});
