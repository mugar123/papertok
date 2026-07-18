import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaperTopic, topicExplorerPath } from './topicNavigation.js';

test('resolves a PaperTok category id as a reliable topic', () => {
  const topic = resolvePaperTopic('astro-ph.CO');
  assert.deepEqual(topic, { id: 'astro-ph.CO', label: 'Cosmología', type: 'topic', reliable: true });
  assert.equal(topicExplorerPath(topic), '/explorer/topic/astro-ph.CO');
});

test('maps an OpenAlex concept name to the local taxonomy when possible', () => {
  const topic = resolvePaperTopic({ id: 'https://openalex.org/C123', display_name: 'Cosmology' });
  assert.equal(topic.id, 'astro-ph.CO');
  assert.equal(topic.reliable, true);
});

test('keeps a stable external concept navigable and rejects loose labels', () => {
  const external = resolvePaperTopic({ id: 'https://openalex.org/C987', display_name: 'Emergent topic' });
  assert.deepEqual(external, { id: 'C987', label: 'Emergent topic', type: 'concept', reliable: false });
  assert.equal(resolvePaperTopic('unverified free text'), null);
});
