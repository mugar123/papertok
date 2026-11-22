import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEmailNotificationService } from '../../tests/dom/email-notification-service.ts';
import {
  buildNotificationPreferencesPayload,
  hasDigestFollows,
  serializeFollowForNotifications,
  serializeUpdateForNotifications,
} from './email-notification-service.ts';

test('a preview names its paper\'s field the way the card does, or not at all', () => {
  // The digest inks each paper with its field, so it needs the card's answer.
  assert.equal(serializeUpdateForNotifications({ id: 'a', title: 'A', primaryCategory: 'cs.LG' }).area, 'ai');
  assert.equal(serializeUpdateForNotifications({
    id: 'b',
    title: 'B',
    primaryTopic: { field: { id: 'https://openalex.org/fields/26' } as import('../models/paper.ts').PaperSubjectReference } as import('../models/paper.ts').PaperSubject,
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

// ENG-163: the Worker fills the digest from the reader's chosen categories
// while nothing it covers is followed, so a save carries their ids, sorted so
// an unchanged set syncs as unchanged.
test('a save sends the reader\'s chosen categories as ids only', () => {
  const { interests } = buildNotificationPreferencesPayload({ enabled: true }, [], [], { interests: ['quant-ph', 'cs.LG', 'quant-ph'] });
  assert.deepEqual(interests, ['cs.LG', 'quant-ph']);
});

// Unconfirmed categories are left out, so the Worker keeps the stored ones
// instead of replacing them with the device's cache.
test('a save without confirmed categories leaves the field out', () => {
  assert.equal('interests' in buildNotificationPreferencesPayload({ enabled: true }, [], [], { sync: true }), false);
});

test('the digest leaves journals out before it cuts follows and previews', () => {
  const author = (index: number) => ({ type: 'author' as const, canonicalId: `A${index}`, displayName: `Author ${index}` });
  const topic = (index: number) => ({ type: 'topic' as const, canonicalId: `T${index}`, displayName: `Topic ${index}` });
  const journal = (index: number) => ({ type: 'journal' as const, canonicalId: `S${index}`, displayName: `Journal ${index}` });
  const follows = [
    ...Array.from({ length: 31 }, (_, index) => author(index)),
    ...Array.from({ length: 10 }, (_, index) => journal(index)),
    ...Array.from({ length: 9 }, (_, index) => topic(index)),
  ];
  const { follows: sent } = buildNotificationPreferencesPayload({ enabled: true }, follows);
  assert.equal(sent.filter(follow => follow.type === 'topic').length, 9);
  assert.equal(sent.some(follow => follow.type === 'journal'), false);

  const journalOnly = (index: number) => ({ id: `j${index}`, title: `J${index}`, _followedEntityMatches: [journal(index)] });
  const byAuthor = { id: 'a1', title: 'A1', _followedEntityMatches: [journal(1), author(1)] };
  const { previewItems } = buildNotificationPreferencesPayload({ enabled: true }, [], [...Array.from({ length: 20 }, (_, index) => journalOnly(index)), byAuthor] as never);
  assert.deepEqual(previewItems.map(item => item.id), ['a1']);
  assert.deepEqual(previewItems[0].matches.map(match => match.type), ['author']);

  // `_followedEntityMatches` may still hold a legacy string match: the paper
  // stays a preview, as it did before journals.
  const legacy = { id: 'p3', title: 'P3', _followedEntityMatches: ['project-3'] };
  assert.deepEqual(buildNotificationPreferencesPayload({ enabled: true }, [], [legacy]).previewItems.map(item => item.id), ['p3']);
});

// ENG-123 (D6): the email settings, the guest opt-in and the background sync
// ask whether the reader has follows before they write. Journals alone are
// none: the save would send `follows: []` and the Worker answers 409.
test('a reader who follows only journals has no follows for the digest', () => {
  const journal = { type: 'journal' as const, canonicalId: 'S23254222', displayName: 'American Economic Review' };
  const author = { type: 'author' as const, canonicalId: 'A5023888391', displayName: 'Ana Pérez' };
  assert.equal(hasDigestFollows([]), false);
  assert.equal(hasDigestFollows([journal]), false);
  assert.equal(buildNotificationPreferencesPayload({ enabled: true }, [journal]).follows.length, 0);
  assert.equal(hasDigestFollows([journal, author]), true);
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

// The request itself, through the app's own Worker client: loaded the way the
// build loads it, with a stub session and an answered `fetch`.
test('a yes from the welcome is posted to the opt-in route under the account that gave it, and never under another', async t => {
  const { service, signIn, close } = await loadEmailNotificationService();
  t.after(() => close());
  signIn('reader');
  const preferences = { enabled: true, frequency: 'weekly', maxPapers: 5, language: 'en', email: 'reader@example.com', lastSentAt: null, lastTestAt: null };
  const requests: Array<{ url: string; method?: string; authorization: string | null; body: unknown }> = [];
  let respond = () => Response.json({ outcome: 'created', preferences });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    requests.push({
      url: String(input),
      method: options?.method,
      authorization: new Headers(options?.headers).get('authorization'),
      body: JSON.parse(String(options?.body)),
    });
    return respond();
  });

  const answer = await service.startEmailDigestOptIn({ consent: 'topics-from-signup-1', interests: ['stat.ML', 'cs.LG', 'stat.ML'] }, 'reader');

  assert.deepEqual(answer, { outcome: 'created', preferences });
  assert.deepEqual(requests, [{
    url: 'https://api.papertok.app/notifications/opt-in',
    method: 'POST',
    authorization: 'Bearer reader-token',
    body: { consent: 'topics-from-signup-1', interests: ['cs.LG', 'stat.ML'] },
  }]);

  // A yes given under the earlier text sends the follows and previews exactly as a save does.
  const author = { type: 'author' as const, canonicalId: 'A1', displayName: 'Ada Author' };
  const follows = [author, { type: 'journal' as const, canonicalId: 'S1', displayName: 'A Journal' }];
  const previewItems = [{ id: 'p1', title: 'A paper', authors: [{ name: 'Ada Author' }], _followedEntityMatches: [author] }];
  // As the save's body reaches the Worker: JSON drops the fields a paper lacks.
  const saved = JSON.parse(JSON.stringify(service.buildNotificationPreferencesPayload({ enabled: true }, follows, previewItems)));
  respond = () => Response.json({ outcome: 'on', preferences });
  assert.equal((await service.startEmailDigestOptIn({ consent: 'first-follow-1', follows, previewItems, interests: [] }, 'reader')).outcome, 'on');
  assert.deepEqual(requests[1].body, { consent: 'first-follow-1', follows: saved.follows, previewItems: saved.previewItems, interests: [] });
  assert.equal(saved.follows.length, 1, 'the journal reached the digest');

  // A refusal keeps the Worker's code and status.
  respond = () => Response.json({ code: 'EMAIL_FOLLOWS_REQUIRED' }, { status: 409 });
  await assert.rejects(
    service.startEmailDigestOptIn({ consent: 'topics-from-signup-1', interests: [] }, 'reader'),
    (error: unknown) => (error as { code?: string }).code === 'EMAIL_FOLLOWS_REQUIRED' && (error as { status?: number }).status === 409,
  );

  // Firebase already holds another account: the yes is not sent under its token.
  signIn('someone-else');
  await assert.rejects(
    service.startEmailDigestOptIn({ consent: 'topics-from-signup-1', interests: ['cs.LG'] }, 'reader'),
    (error: unknown) => (error as { code?: string }).code === 'EMAIL_ACCOUNT_CHANGED',
  );
  assert.equal(requests.length, 3);
});
