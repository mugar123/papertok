import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotificationPreferencesPayload,
  serializeFollowForNotifications,
  serializeUpdateForNotifications,
} from './emailNotificationService.ts';

test('a preview names its paper\'s field the way the card does, or not at all', () => {
  // The digest inks each paper with its field, so it needs the card's answer.
  assert.equal(serializeUpdateForNotifications({ id: 'a', title: 'A', primaryCategory: 'cs.LG' }).area, 'cs');
  assert.equal(serializeUpdateForNotifications({
    id: 'b',
    title: 'B',
    primaryTopic: { field: { id: 'https://openalex.org/fields/26' } as import('../models/Paper.ts').PaperSubjectReference } as import('../models/Paper.ts').PaperSubject,
  }).area, 'math');
  assert.equal('area' in serializeUpdateForNotifications({ id: 'c', title: 'C' }), false);
});

test('asks the Worker for the weekly digest whatever the saved preference says', () => {
  // The frontend can ship before the Worker, whose old default is daily.
  const payload = buildNotificationPreferencesPayload({ enabled: true, frequency: 'daily', maxPapers: 10 });
  assert.equal(payload.frequency, 'weekly');
  assert.equal(payload.maxPapers, 10);
  assert.equal(buildNotificationPreferencesPayload({ enabled: true }).frequency, 'weekly');
});

test('marks a background sync, and only a background sync, for the Worker', () => {
  const follows = [{ type: 'author' as const, canonicalId: 'A1', displayName: 'Ada Lovelace' }];
  const choice = buildNotificationPreferencesPayload({ enabled: true, maxPapers: 10 }, follows);
  assert.equal('sync' in choice, false);

  const sync = buildNotificationPreferencesPayload({ enabled: true, maxPapers: 10 }, follows, [], { sync: true });
  assert.equal(sync.sync, true);
  // A Worker deployed before `sync` ignores it and saves the rest as a choice.
  assert.equal(sync.enabled, true);
  assert.equal(sync.maxPapers, 10);
  assert.deepEqual(sync.follows, choice.follows);
});

test('serializes only the follow metadata required by notification digests', () => {
  assert.deepEqual(serializeFollowForNotifications({
    type: 'institution',
    canonicalId: 'I1',
    displayName: 'University',
    externalIds: { ror: '01', ignored: 'secret' },
    metadata: { categoryIds: ['physics'], ignored: 'value' } as NonNullable<NonNullable<Parameters<typeof serializeFollowForNotifications>[0]>["metadata"]> & Record<string, unknown>,
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
    } as NonNullable<NonNullable<Parameters<typeof serializeFollowForNotifications>[0]>["metadata"]> & Record<string, unknown>,
  });

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
  assert.equal((preview as typeof preview & { abstract?: never }).abstract, undefined);
  assert.equal(preview.matches[0].displayName, 'Physics');
});

test('localizes followed topics and institutions for English digests', () => {
  assert.equal(serializeFollowForNotifications({
    type: 'topic',
    canonicalId: 'astro-ph.GA',
    displayName: 'Astrofísica Galáctica',
  }).displayName, 'Astrophysics of Galaxies');

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
  }).displayName, 'University of Salamanca');
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
  });

  assert.equal(preview.matches[0].displayName, 'Quantum Physics');
});
