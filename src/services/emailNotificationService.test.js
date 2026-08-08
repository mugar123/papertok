import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeFollowForNotifications,
  serializeUpdateForNotifications,
} from './emailNotificationService.js';

test('serializes only the follow metadata required by notification digests', () => {
  assert.deepEqual(serializeFollowForNotifications({
    type: 'institution',
    canonicalId: 'I1',
    displayName: 'University',
    externalIds: { ror: '01', ignored: 'secret' },
    metadata: { categoryIds: ['physics'], ignored: 'value' },
  }), {
    type: 'institution',
    canonicalId: 'I1',
    displayName: 'University',
    externalIds: { ror: '01' },
    metadata: { categoryIds: ['physics'] },
  });
});

test('round-trips bounded query-topic metadata without unrelated fields', () => {
  const serialized = serializeFollowForNotifications({
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Spatial transcriptomics',
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: ['bio.gen'],
      ignored: 'not part of the contract',
    },
  }, 'en');

  assert.deepEqual(serialized.metadata, {
    query: 'Spatial transcriptomics',
    source: 'pubmed',
    categoryIds: ['bio.gen'],
  });
  assert.deepEqual(Object.keys(serialized.metadata), ['query', 'source', 'categoryIds']);
});

test('never serializes an opaque query id as notification search metadata', () => {
  const serialized = serializeFollowForNotifications({
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Spatial transcriptomics',
    metadata: { query: 'query-1234abcd', source: 'provider', categoryIds: [] },
  });

  assert.deepEqual(serialized.metadata, { source: 'provider', categoryIds: [] });
});

test('serializes a compact paper preview with follow reasons', () => {
  const preview = serializeUpdateForNotifications({
    id: 'paper-1',
    title: 'A paper',
    abstract: 'This must not be sent to the email scheduler.',
    authors: [{ name: 'Ada' }],
    _followedEntityMatches: [{ type: 'topic', canonicalId: 'T1', displayName: 'Physics' }],
  });
  assert.equal(preview.abstract, undefined);
  assert.equal(preview.matches[0].displayName, 'Física');
});

test('localizes followed topics and institutions for English digests', () => {
  assert.equal(serializeFollowForNotifications({
    type: 'topic',
    canonicalId: 'astro-ph.GA',
    displayName: 'Astrofísica Galáctica',
  }, 'en').displayName, 'Astrophysics of Galaxies');

  assert.equal(serializeFollowForNotifications({
    type: 'institution',
    canonicalId: 'I1',
    displayName: 'Universidad de Salamanca',
    metadata: {
      localizedNames: {
        en: 'University of Salamanca',
        es: 'Universidad de Salamanca',
      },
    },
  }, 'en').displayName, 'University of Salamanca');
});

test('uses the requested language for paper follow reasons', () => {
  const preview = serializeUpdateForNotifications({
    id: 'paper-2',
    title: 'Another paper',
    _followedEntityMatches: [{
      type: 'topic',
      canonicalId: 'quant-ph',
      displayName: 'Física Cuántica',
    }],
  }, 'en');

  assert.equal(preview.matches[0].displayName, 'Quantum Physics');
});
