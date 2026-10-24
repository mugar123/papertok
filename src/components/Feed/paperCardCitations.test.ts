import test from 'node:test';
import assert from 'node:assert/strict';
import { CITATION_GATE_MAX_WAIT_MS } from '../../utils/feedCitationGate.ts';

test('the cap is short enough to be a loading screen and long enough to be worth it', () => {
  assert.ok(CITATION_GATE_MAX_WAIT_MS <= 1500, 'past this the veil is the feature the reader notices');
  assert.ok(CITATION_GATE_MAX_WAIT_MS >= 600, 'under this it would rarely catch a normal response');
});
