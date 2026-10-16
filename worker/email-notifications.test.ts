import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CATEGORIES } from '../src/data/categoryTaxonomy.js';
import { dribblingFetch, settleWithin, withStubbedFetch } from '../src/test-support/deadlineHarness.js';
import {
  emailNotificationInternals,
  checkEmailProviderHealth,
  getEmailScheduleHealth,
  handleEmailNotificationRequest,
  handleEmailUnsubscribe,
  runEmailNotificationSchedule,
} from './email-notifications.ts';

const {
  brevoSendErrorCode,
  fetchDigestSource,
  fetchOpenAlexDigestPayload,
  fetchWithDeadline,
  buildDeliveryReservationId,
  buildProviderIdempotencyKey,
  buildResendIdempotencyKey,
  collectDigestPapers,
  configuredEmailProvider,
  sanitizeFollow,
  sanitizePreferences,
  topicSearchQuery,
  fetchOpenAlexUpdates,
  mergePapers,
  arxivCategoriesForFollow,
  parseArxivDigestFeed,
  selectDigestPapers,
  isSubscriptionDue,
  isSubscriptionCalendarDue,
  saveSubscription,
  resendSendErrorCode,
  renderScientificHtml,
  renderDigest,
  fieldInks,
  digestFollowsForWindow,
  providerOutcomeDefinitelyRejected,
  deliveryLedgerPrefix,
  deliveryStatePrefix,
  scheduleHistoryPrefix,
  scheduleCursorKey,
  scheduleStatusKey,
} = emailNotificationInternals;

function stubFetch(response) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function textResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

function createMemoryKv(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]));

  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, String(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix = '', cursor, limit = 1_000 } = {}) {
      const matchingKeys = [...values.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = Math.max(0, Number(cursor) || 0);
      const end = Math.min(matchingKeys.length, start + limit);
      return {
        keys: matchingKeys.slice(start, end).map(name => ({ name })),
        list_complete: end >= matchingKeys.length,
        ...(end < matchingKeys.length ? { cursor: String(end) } : {}),
      };
    },
  };
}

function digestFollow(canonicalId = 'A1', displayName = 'Ada Author') {
  return {
    type: 'author',
    canonicalId,
    displayName,
    externalIds: {},
    metadata: { categoryIds: [] },
  };
}

function digestPaper({
  id = 'backlog-paper',
  published = '2026-08-06',
  matches = [digestFollow()],
  citationCount = 4,
} = {}) {
  return {
    id,
    doi: '',
    title: `Strong paper ${id}`,
    authors: ['Ada Lovelace'],
    published,
    journal: 'PaperTok Journal',
    citationCount,
    openAccess: true,
    url: `https://example.com/${id}`,
    matches,
  };
}

function digestSubscription(overrides = {}) {
  return {
    uid: 'reader-1',
    email: 'reader@example.com',
    enabled: true,
    frequency: 'daily',
    maxPapers: 5,
    unsubscribeToken: 'unsubscribe-token',
    follows: [digestFollow()],
    previewItems: [],
    sentPaperKeys: [],
    ...overrides,
  };
}

function emailEnvironment(kv) {
  return {
    NOTIFICATION_STORE: kv,
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_FROM_EMAIL: 'papertok@example.com',
    // Tests run the KV emulation of the delivery ledger, which production must
    // never fall back to silently.
    EMAIL_DELIVERY_LEDGER_FALLBACK: 'kv',
  };
}

async function storedSubscriptionWithState(kv, subscriptionKey) {
  const subscription = await kv.get(subscriptionKey, 'json');
  if (!subscription) return null;
  const uid = subscriptionKey.replace(/^notification:subscription:/, '');
  const stateKey = subscription.stateId
    ? `${deliveryStatePrefix}${uid}:${subscription.stateId}`
    : `${deliveryStatePrefix}${uid}`;
  const state = await kv.get(stateKey, 'json');
  return { ...subscription, ...(state || {}) };
}

test('sanitizes notification preferences and followed entities', () => {
  // The digest is weekly for everyone: a client that still asks for daily
  // emails is stored as weekly.
  assert.deepEqual(sanitizePreferences({ enabled: true, frequency: 'daily', maxPapers: 10 }), {
    enabled: true,
    frequency: 'weekly',
    maxPapers: 10,
    language: 'en',
  });
  assert.equal(sanitizePreferences({ enabled: true }).frequency, 'weekly');
  assert.equal(sanitizePreferences({ language: 'en' }).language, 'en');
  // A legacy Spanish preference from an old client is stored as English.
  assert.equal(sanitizePreferences({ language: 'es' }).language, 'en');
  assert.deepEqual(sanitizeFollow({
    type: 'institution',
    canonicalId: 'https://ror.org/02f40zc51',
    displayName: 'Leiden University',
    externalIds: { ror: 'https://ror.org/02f40zc51' },
  }), {
    type: 'institution',
    canonicalId: '02f40zc51',
    displayName: 'Leiden University',
    externalIds: { ror: '02f40zc51' },
    metadata: { categoryIds: [] },
  });
});

test('round-trips bounded query-topic metadata and rejects malformed query ids', () => {
  assert.deepEqual(sanitizeFollow({
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Spatial transcriptomics',
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: ['bio.gen'],
      ignored: 'not persisted',
    },
  }), {
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Spatial transcriptomics',
    externalIds: {},
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: ['bio.gen'],
    },
  });
  assert.equal(sanitizeFollow({
    type: 'topic',
    canonicalId: 'query-not-valid',
    displayName: 'query-not-valid',
  }), null);
});

test('uses stored query metadata before legacy display names and never uses a query id', () => {
  assert.equal(topicSearchQuery({
    canonicalId: 'query-1234abcd',
    displayName: 'Legacy display',
    metadata: { query: 'Stored scientific query' },
  }), 'Stored scientific query');
  assert.equal(topicSearchQuery({
    canonicalId: 'legacy-topic',
    displayName: 'Legacy display',
    metadata: {},
  }), 'Legacy display');
  assert.equal(topicSearchQuery({
    canonicalId: 'query-1234abcd',
    displayName: 'query-1234abcd',
    metadata: {},
  }), '');
});

test('relevance-filters query-topic OpenAlex results before attaching a match', async () => {
  const follow = {
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Legacy display',
    externalIds: {},
    metadata: { query: 'Spatial transcriptomics', source: 'pubmed', categoryIds: [] },
  };
  const originalFetch = globalThis.fetch;
  let requestedSearch = '';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedSearch = url.searchParams.get('search') || '';
    return jsonResponse(200, {
      results: [
        {
          id: 'https://openalex.org/W1',
          display_name: 'A tissue atlas',
          publication_date: '2026-08-01',
          authorships: [{ author: { display_name: 'Ada Lovelace' } }],
          primary_location: { landing_page_url: 'https://example.com/relevant' },
          concepts: [{ display_name: 'Spatial transcriptomics' }],
        },
        {
          id: 'https://openalex.org/W2',
          display_name: 'Spatial statistics for urban mobility',
          publication_date: '2026-08-01',
          authorships: [{ author: { display_name: 'Grace Hopper' } }],
          primary_location: { landing_page_url: 'https://example.com/unrelated' },
          concepts: [{ display_name: 'Urban planning' }],
        },
      ],
    });
  };

  try {
    const papers = await fetchOpenAlexUpdates(follow, {}, Date.parse('2026-08-03T07:00:00Z'));
    assert.equal(requestedSearch, 'Spatial transcriptomics');
    assert.deepEqual(papers.map(paper => paper.id), ['W1']);
    assert.equal(papers[0].matches[0].canonicalId, 'query-1234abcd');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function invertedIndex(text) {
  const index = {};
  text.split(' ').forEach((word, position) => {
    (index[word] ||= []).push(position);
  });
  return index;
}

test('an OpenAlex work carries its field and a usable abstract into the digest', async () => {
  const abstract = 'Sparse models train faster with learned optimisers than with hand-tuned schedules.';
  const restore = stubFetch(jsonResponse(200, {
    results: [
      {
        id: 'https://openalex.org/WFIELD',
        type: 'article',
        display_name: 'Learned optimisers for sparse models',
        publication_date: '2026-08-01',
        authorships: [{ author: { display_name: 'Ada Lovelace' } }],
        primary_location: { landing_page_url: 'https://example.com/field' },
        primary_topic: {
          display_name: 'Stochastic Gradient Optimization Techniques',
          field: { id: 'https://openalex.org/fields/17', display_name: 'Computer Science' },
        },
        abstract_inverted_index: invertedIndex(abstract),
      },
      {
        // Chemistry (field 16) has no ink of its own; the topic's name does.
        // And an editorial's inverted index is its body, not an abstract.
        id: 'https://openalex.org/WNAMED',
        type: 'editorial',
        display_name: 'Polymer membranes for water',
        publication_date: '2026-08-01',
        authorships: [{ author: { display_name: 'Grace Hopper' } }],
        primary_location: { landing_page_url: 'https://example.com/named' },
        primary_topic: {
          display_name: 'Polymer Membranes for Desalination',
          field: { id: 'https://openalex.org/fields/16', display_name: 'Chemistry' },
        },
        abstract_inverted_index: invertedIndex(abstract),
      },
    ],
  }));

  try {
    const papers = await fetchOpenAlexUpdates(digestFollow(), {}, Date.parse('2026-08-03T07:00:00Z'));
    const byId = Object.fromEntries(papers.map(paper => [paper.id, paper]));
    assert.equal(byId.WFIELD.area, 'cs');
    assert.equal(byId.WFIELD.abstract, abstract);
    assert.equal(byId.WNAMED.area, 'chemeng');
    assert.equal('abstract' in byId.WNAMED, false);
  } finally {
    restore();
  }
});

test('the app may name a paper\'s field, but only one the digest knows', async () => {
  const kv = createMemoryKv();
  const request = new Request('https://example.com/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      follows: [digestFollow()],
      previewItems: [
        { id: 'known', title: 'Known field', area: 'bio' },
        { id: 'unknown', title: 'Unknown field', area: 'astrology' },
        { id: 'injected', title: 'Injected field', area: '<b>bio</b>' },
      ],
    }),
  });

  await saveSubscription(request, { NOTIFICATION_STORE: kv }, {
    uid: 'field-reader',
    email: 'reader@example.com',
    displayName: 'Reader',
  });

  const stored = await kv.get('notification:subscription:field-reader', 'json');
  assert.deepEqual(stored.previewItems.map(paper => paper.area), ['bio', undefined, undefined]);
});

test('merging two records of one paper keeps the field and the longer abstract', () => {
  const fresh = {
    id: 'W1',
    title: 'Paper',
    abstract: 'The abstract the source returned for this paper.',
    area: 'cs',
    matches: [],
  };
  // arXiv's summary and OpenAlex's rebuilt index rarely agree on length.
  const preview = { id: 'W1', title: 'Paper', abstract: 'A shorter abstract.', matches: [] };
  for (const order of [[fresh, preview], [preview, fresh]]) {
    const [merged] = mergePapers(order);
    assert.equal(merged.abstract, fresh.abstract);
    assert.equal(merged.area, 'cs');
  }
});

test('deduplicates digest papers while preserving every follow reason', () => {
  const papers = mergePapers([
    { id: 'one', doi: '10.1/same', title: 'Paper', matches: [{ type: 'author', canonicalId: 'A1', displayName: 'Ada' }] },
    { id: 'two', doi: 'https://doi.org/10.1/SAME', title: 'Paper', citationCount: 8, matches: [{ type: 'topic', canonicalId: 'T1', displayName: 'Physics' }] },
  ]);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].citationCount, 8);
  assert.deepEqual(papers[0].matches.map(match => match.type), ['author', 'topic']);
});

test('deduplicates newsletter records with different provider ids by title and author', () => {
  const papers = mergePapers([
    {
      id: 'openalex:W1',
      title: 'On the Origin of the Universe',
      authors: ['Francisco Anderson de Sousa Oliveira'],
      matches: [{ type: 'topic', canonicalId: 'T1', displayName: 'Astrophysics' }],
    },
    {
      id: 'zenodo:1',
      title: 'On the Origin of the Universe',
      authors: ['Francisco Anderson de Sousa Oliveira'],
      citationCount: 4,
      matches: [{ type: 'institution', canonicalId: 'I1', displayName: 'CERN' }],
    },
  ]);

  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, 'openalex:W1');
  assert.equal(papers[0].citationCount, 4);
  assert.deepEqual(papers[0].matches.map(match => match.type), ['topic', 'institution']);
});

test('treats the configured paper count as a maximum and does not backfill weak results', () => {
  const now = Date.parse('2026-07-28T07:00:00Z');
  const followedMatch = [{ type: 'topic', canonicalId: 'T1', displayName: 'Astrophysics' }];
  const qualityPaper = {
    authors: ['Ada Lovelace'],
    published: '2026-07-28',
    url: 'https://example.com/paper',
    matches: followedMatch,
  };
  const selected = selectDigestPapers([
    { ...qualityPaper, id: 'one', title: 'First strong paper', citationCount: 3 },
    { ...qualityPaper, id: 'duplicate-provider', title: 'First strong paper', citationCount: 8 },
    { ...qualityPaper, id: 'two', title: 'Second strong paper', citationCount: 2 },
    { ...qualityPaper, id: 'future', title: 'Future metadata error', published: '2028-01-01', citationCount: 99 },
    { ...qualityPaper, id: 'missing-link', title: 'Incomplete paper', url: '', citationCount: 99 },
    { ...qualityPaper, id: 'unfollowed', title: 'Unrelated paper', matches: [], citationCount: 99 },
  ], { limit: 5, now });

  assert.deepEqual(selected.map(paper => paper.title), ['First strong paper', 'Second strong paper']);
});

test('only admits a bounded exploration paper with a strong scientific signal', () => {
  const now = Date.parse('2026-07-28T07:00:00Z');
  const base = {
    authors: ['Grace Hopper'],
    published: '2026-07-28',
    journal: 'Relevant Journal',
    url: 'https://example.com/discovery',
    matches: [],
  };
  assert.equal(selectDigestPapers([
    { ...base, id: 'strong', title: 'Strong discovery', citationCount: 12 },
    { ...base, id: 'weak', title: 'Weak discovery', citationCount: 0 },
  ], { limit: 1, now, exploration: true })[0].id, 'strong');
  assert.deepEqual(selectDigestPapers([
    { ...base, id: 'weak', title: 'Weak discovery', citationCount: 0 },
  ], { limit: 1, now, exploration: true }), []);
});

test('selects unsent preview backlog inside the rolling window despite a newer lastSentAt', async () => {
  const now = Date.parse('2026-08-09T07:00:00Z');
  const backlog = digestPaper({ id: 'weekend-backlog', published: '2026-08-06' });
  const restoreFetch = stubFetch(jsonResponse(200, { results: [] }));
  try {
    const result = await collectDigestPapers(digestSubscription({
      lastSentAt: '2026-08-08T07:00:00Z',
      previewItems: [backlog],
    }), {}, { now });

    assert.deepEqual(result.papers.map(paper => paper.id), ['weekend-backlog']);
  } finally {
    restoreFetch();
  }
});

test('excludes sent preview backlog throughout the rolling freshness window', async () => {
  const now = Date.parse('2026-08-09T07:00:00Z');
  const backlog = digestPaper({ id: 'already-sent', published: '2026-08-06' });
  const restoreFetch = stubFetch(jsonResponse(200, { results: [] }));
  try {
    const result = await collectDigestPapers(digestSubscription({
      lastSentAt: '2026-08-08T07:00:00Z',
      previewItems: [backlog],
      sentPaperKeys: ['id:already-sent'],
    }), {}, { now });

    assert.deepEqual(result.papers, []);
  } finally {
    restoreFetch();
  }
});

test('uses at most one strong exploration paper when followed selection is empty', async () => {
  const now = Date.parse('2026-08-09T07:00:00Z');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if ((url.searchParams.get('filter') || '').includes('author.id:A1')) {
      return jsonResponse(200, { results: [] });
    }
    return jsonResponse(200, {
      results: [
        {
          id: 'https://openalex.org/WEXPLORE',
          display_name: 'High quality exploration',
          publication_date: '2026-08-09',
          cited_by_count: 12,
          authorships: [{ author: { display_name: 'Grace Hopper' } }],
          primary_location: {
            source: { display_name: 'Discovery Journal' },
            landing_page_url: 'https://example.com/exploration',
          },
          open_access: { is_oa: true },
        },
      ],
    });
  };

  try {
    const result = await collectDigestPapers(digestSubscription(), {}, { now });
    assert.deepEqual(result.papers.map(paper => paper.id), ['WEXPLORE']);
    assert.equal(result.papers[0].matches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every subscription is due once on Monday, including one saved as daily', () => {
  const monday = new Date('2026-07-27T07:00:00Z');
  const laterMonday = new Date('2026-07-27T11:00:00Z');
  const tuesday = new Date('2026-07-28T07:00:00Z');
  const sunday = new Date('2026-08-02T07:00:00Z');
  const nextMonday = new Date('2026-08-03T07:00:00Z');
  const sentOnMonday = { enabled: true, frequency: 'weekly', lastSentAt: monday.toISOString() };
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'weekly' }, monday), true);
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'weekly' }, tuesday), false);
  assert.equal(isSubscriptionDue(sentOnMonday, laterMonday), false);
  assert.equal(isSubscriptionDue(sentOnMonday, nextMonday), true);
  // Daily was a choice until 2026-10; a subscription that stored it is weekly now.
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'daily' }, monday), true);
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'daily' }, tuesday), false);
  assert.equal(isSubscriptionDue({
    enabled: true,
    frequency: 'daily',
    lastSentAt: '2026-08-01T07:00:00Z',
  }, sunday), false);
});

test('maps native arXiv categories to their exact followed topics', () => {
  const galacticFollow = {
    type: 'topic',
    canonicalId: 'astro-ph.GA',
    displayName: 'Astrofísica Galáctica',
    metadata: { categoryIds: ['astro-ph.GA'] },
  };
  const quantumFollow = {
    type: 'topic',
    canonicalId: 'quant-ph',
    displayName: 'Física Cuántica',
    metadata: { categoryIds: ['quant-ph'] },
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2607.26058v1</id>
        <title>The evolution of galaxy dust scaling relations</title>
        <published>2026-07-28T17:59:59Z</published>
        <updated>2026-07-28T17:59:59Z</updated>
        <link href="https://arxiv.org/abs/2607.26058v1" rel="alternate" type="text/html"/>
        <category term="astro-ph.GA"/>
        <author><name>Aswin P. Vijayan</name></author>
      </entry>
    </feed>`;

  assert.deepEqual(arxivCategoriesForFollow(galacticFollow), ['astro-ph.GA']);
  const papers = parseArxivDigestFeed(xml, [galacticFollow, quantumFollow]);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, '2607.26058');
  assert.equal(papers[0].published, '2026-07-28T17:59:59Z');
  assert.equal(papers[0].matches[0].canonicalId, 'astro-ph.GA');
  assert.equal(papers[0].url, 'https://arxiv.org/abs/2607.26058v1');
});

test('an arXiv entry carries its primary field and its summary into the digest', () => {
  const follows = [
    { type: 'topic', canonicalId: 'math-ph', displayName: 'Mathematical Physics', metadata: { categoryIds: ['math-ph'] } },
    { type: 'topic', canonicalId: 'cs.LG', displayName: 'Machine Learning', metadata: { categoryIds: ['cs.LG'] } },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2608.00001v1</id>
        <title>Integrable spin chains</title>
        <summary>  Integrable spin chains admit
          exact solutions.  </summary>
        <published>2026-08-01T17:59:59Z</published>
        <link href="https://arxiv.org/abs/2608.00001v1" rel="alternate" type="text/html"/>
        <arxiv:primary_category term="math-ph"/>
        <category term="math-ph"/>
        <category term="math.MP"/>
        <author><name>Emmy Noether</name></author>
      </entry>
      <entry>
        <id>http://arxiv.org/abs/2608.00002v1</id>
        <title>Sparse optimisers</title>
        <published>2026-08-01T17:59:59Z</published>
        <link href="https://arxiv.org/abs/2608.00002v1" rel="alternate" type="text/html"/>
        <arxiv:primary_category term="cs.LG"/>
        <category term="stat.ML"/>
        <category term="cs.LG"/>
        <author><name>Alan Turing</name></author>
      </entry>
    </feed>`;

  const byId = Object.fromEntries(parseArxivDigestFeed(xml, follows).map(paper => [paper.id, paper]));
  // math-ph is filed under physics, though its name starts with "math".
  assert.equal(byId['2608.00001'].area, 'physics');
  assert.equal(byId['2608.00001'].abstract, 'Integrable spin chains admit exact solutions.');
  // The primary category decides, not the cross-list that happens to come first.
  assert.equal(byId['2608.00002'].area, 'cs');
  assert.equal('abstract' in byId['2608.00002'], false);
});

test('scheduled digest fetches native arXiv follows before OpenAlex indexes them', async () => {
  const now = new Date('2026-08-03T07:00:00Z');
  const subscriptionKey = 'notification:subscription:arxiv-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: {
      uid: 'arxiv-reader',
      email: 'reader@example.com',
      displayName: 'Reader',
      enabled: true,
      frequency: 'daily',
      maxPapers: 5,
      unsubscribeToken: 'unsubscribe-token',
      lastSentAt: '2026-07-27T07:00:00Z',
      sentPaperKeys: [],
      follows: [{
        type: 'topic',
        canonicalId: 'astro-ph.GA',
        displayName: 'Astrofísica Galáctica',
        externalIds: {},
        metadata: { categoryIds: ['astro-ph.GA'] },
      }],
      previewItems: [],
    },
  });
  const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/2607.26058v1</id>
        <title>The evolution of galaxy dust scaling relations</title>
        <published>2026-07-28T17:59:59Z</published>
        <updated>2026-07-28T17:59:59Z</updated>
        <link href="https://arxiv.org/abs/2607.26058v1" rel="alternate" type="text/html"/>
        <category term="astro-ph.GA"/>
        <author><name>Aswin P. Vijayan</name></author>
      </entry>
    </feed>`;
  let arxivQuery = '';
  let brevoPayload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'export.arxiv.org') {
      arxivQuery = url.searchParams.get('search_query') || '';
      return textResponse(200, arxivXml);
    }
    if (url.hostname === 'api.openalex.org') return jsonResponse(200, { results: [] });
    if (url.hostname === 'api.brevo.com' && url.pathname === '/v3/smtp/email') {
      brevoPayload = JSON.parse(options.body);
      return jsonResponse(201, { messageId: 'arxiv-email-id' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await runEmailNotificationSchedule({
      NOTIFICATION_STORE: kv,
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'papertok@example.com',
      EMAIL_DELIVERY_LEDGER_FALLBACK: 'kv',
    }, now.getTime());

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.empty, 0);
    assert.equal(arxivQuery, 'cat:astro-ph.GA');
    assert.equal(brevoPayload.subject, 'The evolution of galaxy dust scaling relations');
    assert.equal(
      brevoPayload.htmlContent.includes('The evolution of galaxy dust scaling relations'),
      true,
    );
    const storedSubscription = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(storedSubscription.lastSentAt, now.toISOString());
    assert.equal(storedSubscription.sentPaperKeys.includes('id:2607.26058'), true);
    const rawSubscription = await kv.get(subscriptionKey, 'json');
    const deliveryState = await kv.get(`${deliveryStatePrefix}arxiv-reader`, 'json');
    assert.equal(rawSubscription.lastSentAt, '2026-07-27T07:00:00Z');
    assert.notEqual(rawSubscription.lastSentAt, now.toISOString());
    assert.equal(rawSubscription.lastDelivery, undefined);
    assert.equal(deliveryState.lastSentAt, now.toISOString());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled digest fetches and emails papers from every followed entity type', async () => {
  const now = new Date('2026-08-10T07:00:00Z');
  const publicationDate = now.toISOString().slice(0, 10);
  const subscriptionKey = 'notification:subscription:user-1';
  const kv = createMemoryKv({
    [subscriptionKey]: {
      uid: 'user-1',
      email: 'reader@example.com',
      displayName: 'Reader',
      enabled: true,
      frequency: 'daily',
      maxPapers: 10,
      unsubscribeToken: 'unsubscribe-token',
      follows: [
        { type: 'author', canonicalId: 'A1', displayName: 'Ada Author', externalIds: {}, metadata: { categoryIds: [] } },
        { type: 'institution', canonicalId: 'I2', displayName: 'Research University', externalIds: {}, metadata: { categoryIds: [] } },
        { type: 'topic', canonicalId: 'T3', displayName: 'Cosmology', externalIds: {}, metadata: { categoryIds: [] } },
        { type: 'project', canonicalId: 'project-4', displayName: 'Discovery Project', externalIds: {}, metadata: { categoryIds: [] } },
      ],
      previewItems: [],
    },
  });
  const requests = [];
  let brevoPayload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requests.push(url.toString());

    if (url.hostname === 'api.openaire.eu') {
      return jsonResponse(200, {
        response: {
          results: {
            result: [{
              metadata: {
                'oaf:entity': {
                  'oaf:result': {
                    pid: [{ '@classname': 'doi', $: '10.1234/project-paper' }],
                  },
                },
              },
            }],
          },
        },
      });
    }

    if (url.hostname === 'api.openalex.org') {
      const filter = url.searchParams.get('filter') || '';
      const source = filter.includes('author.id:A1')
        ? 'Author'
        : filter.includes('institutions.id:I2')
          ? 'Institution'
          : filter.includes('topics.id:T3')
            ? 'Topic'
            : 'Project';
      return jsonResponse(200, {
        results: [{
          id: `https://openalex.org/W${source.length}`,
          doi: `https://doi.org/10.1234/${source.toLowerCase()}`,
          display_name: `${source} followed paper`,
          publication_date: publicationDate,
          cited_by_count: source.length,
          authorships: [{ author: { display_name: `${source} Researcher` } }],
          primary_location: {
            source: { display_name: 'PaperTok Journal' },
            landing_page_url: `https://example.com/${source.toLowerCase()}`,
          },
          open_access: { is_oa: true },
        }],
      });
    }

    if (url.hostname === 'api.brevo.com' && url.pathname === '/v3/smtp/email') {
      brevoPayload = JSON.parse(options.body);
      return jsonResponse(201, { messageId: 'email-provider-id' });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await runEmailNotificationSchedule({
      NOTIFICATION_STORE: kv,
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'papertok@example.com',
      EMAIL_DELIVERY_LEDGER_FALLBACK: 'kv',
    }, now.getTime());

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.empty, 0);
    assert.deepEqual(brevoPayload.sender, { name: 'PaperTok', email: 'papertok@example.com' });
    assert.deepEqual(brevoPayload.to, [{ email: 'reader@example.com', name: 'Reader' }]);
    assert.match(
      brevoPayload.headers.idempotencyKey,
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The most cited of the four leads the edition: Institution, 11 citations.
    assert.equal(brevoPayload.subject, 'Institution followed paper, and 3 more');
    assert.equal(
      brevoPayload.htmlContent.includes('https://api.papertok.app/notifications/unsubscribe?token=unsubscribe-token'),
      true,
    );
    ['Author', 'Institution', 'Topic', 'Project'].forEach(source => {
      assert.equal(brevoPayload.htmlContent.includes(`${source} followed paper`), true);
    });
    assert.equal(requests.filter(url => url.startsWith('https://api.openalex.org/works')).length, 5);
    assert.equal(requests.filter(url => url.startsWith('https://api.openaire.eu/')).length, 1);
    assert.equal(requests.filter(url => url.startsWith('https://api.brevo.com/v3/smtp/email')).length, 1);

    const storedSubscription = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(storedSubscription.lastSentAt, now.toISOString());
    assert.equal(storedSubscription.lastCheckedAt, now.toISOString());
    assert.equal(storedSubscription.sentPaperKeys.includes('doi:10.1234/author'), true);
    assert.equal(
      [...kv.values.keys()].some(key => key.startsWith(deliveryLedgerPrefix)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- One schedule run shares identical OpenAlex requests between readers ----

const DIGEST_RUN = new Date('2026-08-10T07:00:00.000Z');

function scheduledFollow(type, canonicalId, displayName, metadata = {}) {
  return { type, canonicalId, displayName, externalIds: {}, metadata: { categoryIds: [], ...metadata } };
}

function readerSubscription(uid, overrides = {}) {
  return digestSubscription({
    uid,
    email: `${uid}@example.com`,
    unsubscribeToken: `unsubscribe-${uid}`,
    ...overrides,
  });
}

function readersKv(readers) {
  return createMemoryKv(Object.fromEntries(Object.entries(readers).map(([uid, overrides]) => [
    `notification:subscription:${uid}`,
    readerSubscription(uid, overrides),
  ])));
}

function recentOpenAlexWork(entityId, overrides = {}) {
  return {
    id: `https://openalex.org/W${entityId}`,
    display_name: `Recent paper for ${entityId}`,
    publication_date: '2026-08-09',
    cited_by_count: 2,
    authorships: [{ author: { display_name: `Researcher ${entityId}` } }],
    primary_location: {
      source: { display_name: 'PaperTok Journal' },
      landing_page_url: `https://example.com/${entityId}`,
    },
    open_access: { is_oa: true },
    ...overrides,
  };
}

// The question a digest's OpenAlex request asks: the exploration pick, a
// search string, or the last filter clause (the followed entity or DOI list).
function digestOpenAlexQuery(url) {
  const filter = url.searchParams.get('filter') || '';
  if (filter.includes('is_retracted:false')) return 'exploration';
  const search = url.searchParams.get('search');
  return search ? `search:${search}` : filter.split(',').at(-1);
}

function answerWithOneRecentWork(url, query) {
  if (!query) throw new Error(`Unexpected request: ${url}`);
  if (query === 'exploration') return jsonResponse(200, { results: [] });
  return jsonResponse(200, { results: [recentOpenAlexWork(query.split(':').at(-1))] });
}

// Counts every OpenAlex request by the question it asks, keeps each digest
// email by recipient, and hands every other request to `respond`.
async function withDigestUpstream(respond, callback) {
  const upstream = { openAlex: { total: 0, byQuery: {} }, emailsTo: {}, hosts: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    upstream.hosts.push(url.hostname);
    if (url.hostname === 'api.brevo.com') {
      const email = JSON.parse(options.body);
      upstream.emailsTo[email.to[0].email] = email;
      return jsonResponse(201, { messageId: `digest-${email.to[0].email}` });
    }
    if (url.hostname !== 'api.openalex.org') return respond(url, null);
    const query = digestOpenAlexQuery(url);
    upstream.openAlex.total += 1;
    upstream.openAlex.byQuery[query] = (upstream.openAlex.byQuery[query] || 0) + 1;
    return respond(url, query);
  };
  try {
    return await callback(upstream);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('one schedule run asks OpenAlex once for a query that several subscribers share', async () => {
  // Five daily readers whose follows overlap: three of them follow A1, three
  // follow T1, and all five have room for the exploration pick, whose URL
  // depends only on the run date. Every distinct question is worth one request
  // per run; what each reader sees is decided after the response arrives.
  const kv = readersKv({
    'reader-1': { follows: [scheduledFollow('author', 'A1', 'Ada Author'), scheduledFollow('topic', 'T1', 'Topic One')] },
    'reader-2': { follows: [scheduledFollow('author', 'A1', 'Ada Author'), scheduledFollow('topic', 'T2', 'Topic Two')] },
    'reader-3': { follows: [scheduledFollow('topic', 'T1', 'Topic One'), scheduledFollow('institution', 'I1', 'Institution One')] },
    'reader-4': { follows: [scheduledFollow('author', 'A2', 'Alan Author')] },
    'reader-5': { follows: [scheduledFollow('topic', 'T1', 'Topic One'), scheduledFollow('author', 'A1', 'Ada Author')] },
  });

  await withDigestUpstream(answerWithOneRecentWork, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());

    assert.equal(summary.sent, 5);
    assert.equal(summary.failed, 0);
    assert.deepEqual(upstream.openAlex, {
      total: 6,
      byQuery: {
        'author.id:A1': 1,
        'author.id:A2': 1,
        'topics.id:T1': 1,
        'topics.id:T2': 1,
        'institutions.id:I1': 1,
        exploration: 1,
      },
    });
    // The questions are still counted per reader; only the HTTP calls behind
    // them are shared, and the source report says how many were made.
    assert.equal(summary.sources.bySource.openalex.attempted, 14);
    assert.equal(summary.sources.bySource.openalex.requestAttempts, 6);
    assert.equal(summary.sources.requestAttempts, 6);
  });
});

test('readers in one page share an OpenAlex request that is still in flight', async () => {
  // A slow answer keeps the first request open while the other two readers of
  // the page reach the same question, so only sharing the pending request --
  // not a cache of finished answers -- keeps this to one call.
  const kv = readersKv(Object.fromEntries(['reader-1', 'reader-2', 'reader-3'].map(uid => [
    uid,
    { follows: [scheduledFollow('author', 'A1', 'Ada Author')] },
  ])));
  const slowly = async (url, query) => {
    if (query === 'author.id:A1') await new Promise(resolve => setTimeout(resolve, 25));
    return answerWithOneRecentWork(url, query);
  };

  await withDigestUpstream(slowly, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());

    assert.equal(summary.sent, 3);
    assert.deepEqual(upstream.openAlex.byQuery, { 'author.id:A1': 1, exploration: 1 });
  });
});

test('a failed shared request is dropped so a later page asks again, and every HTTP attempt is counted', async () => {
  // OpenAlex refuses A1 twice. The first page's shared request spends both of
  // `fetchDigestSource`'s attempts on those refusals, so its three readers fail
  // together, as they would have failed alone. The failed entry is dropped, and
  // the second page's question goes upstream again and gets an answer.
  const kv = readersKv(Object.fromEntries(['reader-1', 'reader-2', 'reader-3', 'reader-4', 'reader-5'].map(uid => [
    uid,
    { follows: [scheduledFollow('author', 'A1', 'Ada Author')] },
  ])));
  let refusalsLeft = 2;
  const refusingTwice = (url, query) => {
    if (query === 'author.id:A1' && refusalsLeft > 0) {
      refusalsLeft -= 1;
      return jsonResponse(503, {});
    }
    return answerWithOneRecentWork(url, query);
  };

  await withDigestUpstream(refusingTwice, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());

    assert.equal(summary.failed, 3);
    assert.equal(summary.sent, 2);
    // The first page's attempt and its retry, the second page's single
    // attempt, and one exploration request for the two readers with papers.
    assert.deepEqual(upstream.openAlex.byQuery, { 'author.id:A1': 3, exploration: 1 });
    assert.deepEqual(summary.sources.bySource.openalex, {
      attempted: 7,
      succeeded: 4,
      failed: 3,
      requestAttempts: 4,
      retried: 1,
    });
    assert.equal(summary.sources.requestAttempts, 4);
    assert.equal(summary.sources.retried, 1);
  });
});

test('malformed shared OpenAlex payloads are dropped so a later page can recover', async (t) => {
  for (const [name, payload] of [
    ['null payload', null],
    ['missing results', {}],
    ['non-array results', { results: {} }],
  ]) {
    await t.test(name, async () => {
      const kv = readersKv(Object.fromEntries(['reader-1', 'reader-2', 'reader-3', 'reader-4', 'reader-5'].map(uid => [
        uid,
        { follows: [scheduledFollow('author', 'A1', 'Ada Author')] },
      ])));
      let malformed = true;
      const malformedThenHealthy = async (url, query) => {
        if (query === 'author.id:A1' && malformed) {
          malformed = false;
          await new Promise(resolve => setTimeout(resolve, 25));
          return jsonResponse(200, payload);
        }
        return answerWithOneRecentWork(url, query);
      };

      await withDigestUpstream(malformedThenHealthy, async (upstream) => {
        const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());

        assert.equal(summary.failed, 3);
        assert.equal(summary.sent, 2);
        assert.deepEqual(upstream.openAlex.byQuery, { 'author.id:A1': 2, exploration: 1 });
        assert.equal(summary.failureCodes.EMAIL_SOURCE_OPENALEX_INVALID_RESPONSE, 3);
        assert.equal(summary.sources.bySource.openalex.requestAttempts, 3);
        assert.equal(summary.sources.bySource.openalex.retried, 0);
      });
    });
  }
});

test('readers who share an OpenAlex answer keep their own follow names and sent history', async () => {
  const kv = readersKv({
    'reader-1': { follows: [scheduledFollow('author', 'A1', 'Ada Lovelace')] },
    'reader-2': { follows: [scheduledFollow('author', 'A1', 'Countess of Lovelace')] },
    // Already received the A1 paper, so only the T2 paper is new for this reader.
    'reader-3': {
      follows: [scheduledFollow('author', 'A1', 'Ada Lovelace'), scheduledFollow('topic', 'T2', 'Topic Two')],
      sentPaperKeys: ['id:wa1'],
    },
  });

  await withDigestUpstream(answerWithOneRecentWork, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());
    const html = uid => upstream.emailsTo[`${uid}@example.com`].htmlContent;

    assert.equal(summary.sent, 3);
    assert.equal(upstream.openAlex.byQuery['author.id:A1'], 1);
    assert.match(html('reader-1'), /You follow Ada Lovelace/);
    assert.doesNotMatch(html('reader-1'), /Countess of Lovelace/);
    assert.match(html('reader-2'), /You follow Countess of Lovelace/);
    assert.doesNotMatch(html('reader-2'), /Ada Lovelace/);
    assert.match(html('reader-3'), /Recent paper for T2/);
    assert.doesNotMatch(html('reader-3'), /Recent paper for A1/);
  });
});

test('readers who share an OpenAlex search keep their own relevance filter', async () => {
  // The same search string, so one request. Only the first reader's topic
  // carries the category the second work declares, so only that reader may
  // receive it -- the filter runs per reader, after the answer is shared.
  const query = 'Spatial transcriptomics';
  const kv = readersKv({
    'reader-1': {
      follows: [scheduledFollow('topic', 'query-1234abcd', query, { query, categoryIds: ['genomics-lab'] })],
    },
    'reader-2': { follows: [scheduledFollow('topic', 'query-5678abcd', query, { query })] },
  });
  const searchAnswer = (url, question) => {
    if (question !== `search:${query}`) return answerWithOneRecentWork(url, question);
    return jsonResponse(200, {
      results: [
        recentOpenAlexWork('PHRASE', { display_name: 'Spatial transcriptomics of the mouse brain' }),
        recentOpenAlexWork('CATEGORY', {
          display_name: 'A cell atlas of the developing heart',
          categories: ['genomics-lab'],
        }),
      ],
    });
  };

  await withDigestUpstream(searchAnswer, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());
    const html = uid => upstream.emailsTo[`${uid}@example.com`].htmlContent;

    assert.equal(summary.sent, 2);
    assert.equal(upstream.openAlex.byQuery[`search:${query}`], 1);
    assert.match(html('reader-1'), /Spatial transcriptomics of the mouse brain/);
    assert.match(html('reader-1'), /A cell atlas of the developing heart/);
    assert.match(html('reader-2'), /Spatial transcriptomics of the mouse brain/);
    assert.doesNotMatch(html('reader-2'), /A cell atlas of the developing heart/);
  });
});

test('each schedule run starts without shared OpenAlex answers', async () => {
  // Same day, same question in both runs: a map that outlived the first run
  // would answer the second one from memory.
  const kv = readersKv({ 'reader-1': { follows: [scheduledFollow('author', 'A1', 'Ada Author')] } });

  await withDigestUpstream(answerWithOneRecentWork, async (upstream) => {
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());
    await kv.put('notification:subscription:reader-2', JSON.stringify(readerSubscription('reader-2', {
      follows: [scheduledFollow('author', 'A1', 'Ada Author')],
    })));
    const second = await runEmailNotificationSchedule(
      emailEnvironment(kv),
      DIGEST_RUN.getTime() + 20 * 60 * 1000,
    );

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 1);
    assert.deepEqual(upstream.openAlex.byQuery, { 'author.id:A1': 2, exploration: 2 });
  });
});

test('readers who follow the same project share its OpenAlex lookup', async () => {
  // OpenAIRE is still asked once per reader -- the sharing covers OpenAlex
  // only -- but it returns the same DOIs, so the OpenAlex lookup is the same.
  const kv = readersKv({
    'reader-1': { follows: [scheduledFollow('project', 'project-4', 'Discovery Project')] },
    'reader-2': { follows: [scheduledFollow('project', 'project-4', 'Discovery Project')] },
  });
  const projectAnswer = (url, query) => {
    if (url.hostname === 'api.openaire.eu') {
      return jsonResponse(200, {
        response: {
          results: {
            result: [{
              metadata: {
                'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'doi', $: '10.1234/project-paper' }] } },
              },
            }],
          },
        },
      });
    }
    if (query === 'doi:10.1234/project-paper') {
      return jsonResponse(200, { results: [recentOpenAlexWork('PROJECT')] });
    }
    return answerWithOneRecentWork(url, query);
  };

  await withDigestUpstream(projectAnswer, async (upstream) => {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), DIGEST_RUN.getTime());

    assert.equal(summary.sent, 2);
    assert.equal(upstream.hosts.filter(host => host === 'api.openaire.eu').length, 2);
    assert.deepEqual(upstream.openAlex.byQuery, { 'doi:10.1234/project-paper': 1, exploration: 1 });
  });
});

test('the shared OpenAlex map stops growing at its limit and never keys on the API key', async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return jsonResponse(200, { results: [] });
  };
  const requests = new Map();
  const first = new URL('https://api.openalex.org/works?filter=author.id:A1&api_key=secret-key');
  const second = new URL('https://api.openalex.org/works?filter=author.id:A2&api_key=secret-key');

  try {
    await fetchOpenAlexDigestPayload(first, null, requests, 1);
    await fetchOpenAlexDigestPayload(second, null, requests, 1);
    await fetchOpenAlexDigestPayload(second, null, requests, 1);
    await fetchOpenAlexDigestPayload(first, null, requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Past the limit a question is asked unshared, every time, exactly as it was
  // before sharing existed; what is already shared stays shared.
  assert.equal(requests.size, 1);
  assert.equal(requested.filter(url => url.includes('author.id:A1')).length, 1);
  assert.equal(requested.filter(url => url.includes('author.id:A2')).length, 2);
  assert.equal([...requests.keys()].some(key => key.includes('secret-key')), false);
});

test('does not overwrite an enabled subscription when the client sends zero follows', async () => {
  const subscriptionKey = 'notification:subscription:user-1';
  const existing = {
    uid: 'user-1',
    email: 'reader@example.com',
    enabled: true,
    frequency: 'daily',
    maxPapers: 5,
    follows: [{ type: 'topic', canonicalId: 'T1', displayName: 'Physics' }],
    previewItems: [],
    unsubscribeToken: 'existing-token',
  };
  const kv = createMemoryKv({ [subscriptionKey]: existing });
  const request = new Request('https://example.com/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, frequency: 'daily', maxPapers: 5, follows: [] }),
  });

  await assert.rejects(
    () => saveSubscription(request, { NOTIFICATION_STORE: kv }, {
      uid: 'user-1',
      email: 'reader@example.com',
      displayName: 'Reader',
    }),
    error => error?.code === 'EMAIL_FOLLOWS_REQUIRED' && error?.status === 409,
  );
  assert.deepEqual(await kv.get(subscriptionKey, 'json'), existing);
});

test('rejects oversized notification preference payloads before parsing them', async () => {
  const request = new Request('https://example.com/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, padding: 'x'.repeat(100_000) }),
  });

  await assert.rejects(
    () => saveSubscription(request, { NOTIFICATION_STORE: createMemoryKv() }, {
      uid: 'reader',
      email: 'reader@example.com',
      displayName: 'Reader',
    }),
    error => error?.code === 'EMAIL_REQUEST_TOO_LARGE' && error?.status === 413,
  );
});

test('unsubscribe GET confirms without mutating and POST removes the subscription', async () => {
  const token = 'valid-unsubscribe-token';
  const subscription = {
    uid: 'reader',
    email: 'reader@example.com',
    enabled: true,
    language: 'en',
    unsubscribeToken: token,
  };
  const kv = createMemoryKv({
    'notification:subscription:reader': subscription,
    [`notification:unsubscribe:${token}`]: 'reader',
  });
  const url = `https://example.com/notifications/unsubscribe?token=${token}`;

  const confirmation = await handleEmailUnsubscribe(new Request(url), { NOTIFICATION_STORE: kv });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Confirm unsubscribe/);
  assert.deepEqual(await kv.get('notification:subscription:reader', 'json'), subscription);

  const result = await handleEmailUnsubscribe(new Request(url, { method: 'POST' }), {
    NOTIFICATION_STORE: kv,
  });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /Emails disabled/);
  assert.equal(await kv.get('notification:subscription:reader'), null);
  assert.equal(await kv.get(`notification:unsubscribe:${token}`), null);
});

test('a stale unsubscribe token cannot delete a newer subscription generation', async () => {
  const staleToken = 'stale-unsubscribe-token';
  const currentToken = 'current-unsubscribe-token';
  const kv = createMemoryKv({
    'notification:subscription:reader': {
      uid: 'reader',
      email: 'reader@example.com',
      enabled: true,
      language: 'en',
      unsubscribeToken: currentToken,
    },
    [`notification:unsubscribe:${staleToken}`]: 'reader',
  });

  const response = await handleEmailUnsubscribe(new Request(
    `https://example.com/notifications/unsubscribe?token=${staleToken}`,
    { method: 'POST' },
  ), { NOTIFICATION_STORE: kv });

  assert.equal(response.status, 400);
  assert.ok(await kv.get('notification:subscription:reader', 'json'));
  assert.equal(await kv.get(`notification:unsubscribe:${staleToken}`), null);
});

test('the unsubscribe confirmation is a plain form whose native button posts back to its own link', async () => {
  const token = 'form-unsubscribe-token';
  const kv = createMemoryKv({
    'notification:subscription:reader': {
      uid: 'reader',
      email: 'reader@example.com',
      enabled: true,
      language: 'en',
      unsubscribeToken: token,
    },
    [`notification:unsubscribe:${token}`]: 'reader',
  });
  const pageUrl = `https://example.com/notifications/unsubscribe?token=${token}`;
  const page = await (await handleEmailUnsubscribe(new Request(pageUrl), { NOTIFICATION_STORE: kv })).text();

  // What a browser without script submits, read from the markup.
  const [, formAttributes = '', formBody = ''] = page.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/) || [];
  assert.match(formAttributes, /\bmethod="post"/);
  assert.match(formBody, /<button\b(?![^>]*\btype="(?:button|reset)")[^>]*>\s*Disable emails\s*<\/button>/);
  const action = new URL(formAttributes.match(/\baction="([^"]*)"/)?.[1].replaceAll('&amp;', '&') ?? '', pageUrl);
  assert.equal(action.href, pageUrl);

  const submitted = await handleEmailUnsubscribe(new Request(action, { method: 'POST' }), { NOTIFICATION_STORE: kv });
  assert.equal(submitted.status, 200);
  assert.match(await submitted.text(), /<h1[^>]*>Emails disabled<\/h1>/);
  assert.equal(await kv.get('notification:subscription:reader'), null);
});

test('an unusable unsubscribe link explains itself on a locked-down page with nothing to submit', async () => {
  // An already-used link: its token no longer resolves to a subscription.
  const response = await handleEmailUnsubscribe(
    new Request('https://example.com/notifications/unsubscribe?token=already-used-unsubscribe-token'),
    { NOTIFICATION_STORE: createMemoryKv() },
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type') || '', /^text\/html/);
  const policy = response.headers.get('content-security-policy') || '';
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /script-src/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  // The token is in this page's URL; the way out must not carry it along.
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

  const page = await response.text();
  assert.match(page, /<title>[^<]*Invalid unsubscribe link[^<]*<\/title>/);
  assert.match(page, /<h1[^>]*>Invalid unsubscribe link<\/h1>/);
  assert.doesNotMatch(page, /<form\b/);
  assert.match(page, /<a\b[^>]*\bhref="https:\/\/papertok\.app\//);
});

test('keeps delivery state separate and intact when notification preferences change', async () => {
  const subscriptionKey = 'notification:subscription:state-reader';
  const deliveryStateKey = `${deliveryStatePrefix}state-reader`;
  const deliveryState = {
    lastSentAt: '2026-08-08T07:00:00.000Z',
    sentPaperKeys: ['id:already-sent'],
    lastDelivery: { status: 'sent', at: '2026-08-08T07:00:00.000Z', paperCount: 1 },
  };
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({ uid: 'state-reader' }),
    [deliveryStateKey]: deliveryState,
  });
  const newerDeliveryState = {
    ...deliveryState,
    lastSentAt: '2026-08-09T07:00:00.000Z',
    sentPaperKeys: ['id:already-sent', 'id:newer-send'],
  };
  const basePut = kv.put.bind(kv);
  let injectedConcurrentDelivery = false;
  kv.put = async (key, value, options) => {
    if (!injectedConcurrentDelivery && key === subscriptionKey) {
      injectedConcurrentDelivery = true;
      await basePut(deliveryStateKey, JSON.stringify(newerDeliveryState));
    }
    return basePut(key, value, options);
  };
  const request = new Request('https://example.com/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      frequency: 'weekly',
      maxPapers: 3,
      language: 'en',
      follows: [digestFollow()],
      previewItems: [],
    }),
  });

  await saveSubscription(request, { NOTIFICATION_STORE: kv }, {
    uid: 'state-reader',
    email: 'reader@example.com',
    displayName: 'Reader',
  });

  const rawSubscription = await kv.get(subscriptionKey, 'json');
  assert.equal(rawSubscription.frequency, 'weekly');
  assert.equal(rawSubscription.lastSentAt, undefined);
  assert.equal(rawSubscription.lastDelivery, undefined);
  assert.deepEqual(await kv.get(deliveryStateKey, 'json'), newerDeliveryState);
});

test('does not attach a completed send from an old subscription generation to a resubscription', async () => {
  const now = new Date('2026-08-10T07:00:00Z');
  const subscriptionKey = 'notification:subscription:resubscribed-reader';
  const oldStateKey = `${deliveryStatePrefix}resubscribed-reader:old-generation`;
  const newStateKey = `${deliveryStatePrefix}resubscribed-reader:new-generation`;
  const oldSubscription = digestSubscription({
    uid: 'resubscribed-reader',
    stateId: 'old-generation',
    updatedAt: '2026-08-08T12:00:00.000Z',
    previewItems: [digestPaper({ id: 'old-generation-paper', published: '2026-08-09' })],
  });
  const newSubscription = digestSubscription({
    uid: 'resubscribed-reader',
    stateId: 'new-generation',
    updatedAt: '2026-08-10T07:00:01.000Z',
    previewItems: [],
  });
  const kv = createMemoryKv({ [subscriptionKey]: oldSubscription });
  const basePut = kv.put.bind(kv);
  let resubscribedDuringOldStateWrite = false;
  kv.put = async (key, value, options) => {
    if (!resubscribedDuringOldStateWrite && key === oldStateKey) {
      resubscribedDuringOldStateWrite = true;
      await basePut(subscriptionKey, JSON.stringify(newSubscription));
    }
    return basePut(key, value, options);
  };
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: 'old-generation-delivery' });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.sent, 1);
    assert.equal(providerCalls, 1);
    assert.equal(resubscribedDuringOldStateWrite, true);
    assert.equal((await kv.get(oldStateKey, 'json')).lastDelivery.status, 'sent');
    assert.equal(await kv.get(newStateKey, 'json'), null);
    const current = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(current.stateId, 'new-generation');
    assert.equal(current.lastSentAt, undefined);
    assert.deepEqual(current.sentPaperKeys, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rotates oversized follow sets so every follow can contribute to later digests', () => {
  const follows = Array.from({ length: 40 }, (_, index) => digestFollow(`A${index + 1}`));
  const first = digestFollowsForWindow(follows, Date.parse('2026-08-09T07:00:00.000Z'));
  const next = digestFollowsForWindow(follows, Date.parse('2026-08-10T07:00:00.000Z'));

  assert.equal(first.length, 24);
  assert.equal(next.length, 24);
  assert.notEqual(first[0].canonicalId, next[0].canonicalId);
  assert.equal(new Set([...first, ...next].map(follow => follow.canonicalId)).size > 24, true);
});

test('records subscriptions deferred by the cron processing budget', async () => {
  const now = new Date('2026-08-09T07:00:00.000Z');
  const kv = createMemoryKv(Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
    `notification:subscription:deferred-${index}`,
    digestSubscription({ uid: `deferred-${index}`, enabled: false }),
  ])));
  const originalDateNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ === 0 ? 1_000 : 20 * 60 * 1000);

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.scanned, 0);
    assert.equal(result.processed, 0);
    assert.equal(result.deferred, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failureCodes, { EMAIL_SCHEDULE_TIME_BUDGET: 1 });
  } finally {
    Date.now = originalDateNow;
  }
});

test('resumes a deferred subscription scan from its persisted cursor', async () => {
  const now = new Date('2026-08-09T07:00:00.000Z');
  const kv = createMemoryKv(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `notification:subscription:cursor-${index}`,
    digestSubscription({ uid: `cursor-${index}`, enabled: false }),
  ])));
  const originalDateNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ < 2 ? 1_000 : 10 * 60 * 1000);

  try {
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());
    assert.equal(first.processed, 3);
    assert.equal(first.deferred, 1);
    assert.equal(await kv.get(scheduleCursorKey), '3');

    Date.now = originalDateNow;
    const second = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());
    assert.equal(second.processed, 3);
    assert.equal(second.deferred, 0);
    assert.equal(await kv.get(scheduleCursorKey), null);
  } finally {
    Date.now = originalDateNow;
  }
});

test('marks a legacy enabled subscription with zero follows invalid without calling a provider', async () => {
  const now = new Date('2026-08-03T07:00:02Z');
  const subscriptionKey = 'notification:subscription:empty-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: {
      uid: 'empty-reader',
      email: 'reader@example.com',
      enabled: true,
      frequency: 'daily',
      maxPapers: 5,
      follows: [],
      previewItems: [],
      unsubscribeToken: 'unsubscribe-token',
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No network call expected'); };

  try {
    const result = await runEmailNotificationSchedule({
      NOTIFICATION_STORE: kv,
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'papertok@example.com',
      EMAIL_DELIVERY_LEDGER_FALLBACK: 'kv',
    }, now.getTime());

    assert.equal(result.sent, 0);
    assert.equal(result.empty, 0);
    assert.equal(result.invalid, 1);
    assert.equal(result.failed, 0);
    const storedSubscription = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(storedSubscription.lastCheckedAt, now.toISOString());
    assert.equal(storedSubscription.lastSentAt, undefined);
    assert.equal(storedSubscription.lastDelivery.status, 'invalid');
    assert.equal([...kv.values.keys()].some(key => key.startsWith(deliveryLedgerPrefix)), false);
    const storedOutcome = await kv.get(scheduleStatusKey, 'json');
    assert.equal(storedOutcome.scheduledAt, now.toISOString());
    assert.equal(storedOutcome.invalid, 1);
    assert.equal(storedOutcome.failed, 0);
    assert.equal(
      [...kv.values.keys()].some(key => key.startsWith(scheduleHistoryPrefix)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('counts all required source failures as failed rather than empty and never calls the provider', async () => {
  const now = new Date('2026-08-10T07:00:00Z');
  const subscriptionKey = 'notification:subscription:source-failure';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({ uid: 'source-failure' }),
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') providerCalls += 1;
    return jsonResponse(503, { message: 'temporarily unavailable' });
  };

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.failed, 1);
    assert.equal(result.empty, 0);
    assert.equal(result.sent, 0);
    assert.equal(providerCalls, 0);
    assert.equal(result.failureCodes.EMAIL_DIGEST_SOURCES_UNAVAILABLE, 1);
    assert.equal(result.sources.requiredFailed, 1);
    assert.equal(result.sources.failed, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'failed');
    assert.equal(stored.lastDelivery.code, 'EMAIL_DIGEST_SOURCES_UNAVAILABLE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('counts authoritative successful source responses with no papers as empty', async () => {
  const now = new Date('2026-08-10T07:20:00Z');
  const subscriptionKey = 'notification:subscription:authoritative-empty';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({ uid: 'authoritative-empty' }),
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') providerCalls += 1;
    return jsonResponse(200, { results: [] });
  };

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.empty, 1);
    assert.equal(result.failed, 0);
    assert.equal(providerCalls, 0);
    assert.equal(result.sources.succeeded, 2);
    assert.equal(result.sources.failed, 0);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'empty');
    assert.equal(stored.lastDelivery.sources.succeeded, 2);
    assert.equal(stored.lastDelivery.sources.failed, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries an empty weekly selection in a later cron window and sends when papers appear', async () => {
  const firstWindow = new Date('2026-08-10T07:00:00Z');
  const retryWindow = new Date('2026-08-10T11:00:00Z');
  const subscriptionKey = 'notification:subscription:empty-then-ready';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({ uid: 'empty-then-ready' }),
  });
  let papersAvailable = false;
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: 'retry-delivery' });
    }
    const filter = url.searchParams.get('filter') || '';
    if (papersAvailable && filter.includes('author.id:A1')) {
      return jsonResponse(200, {
        results: [{
          id: 'https://openalex.org/WRETRY',
          display_name: 'Paper discovered during the retry window',
          publication_date: '2026-08-09',
          cited_by_count: 2,
          authorships: [{ author: { display_name: 'Retry Researcher' } }],
          primary_location: {
            source: { display_name: 'PaperTok Journal' },
            landing_page_url: 'https://example.com/retry-paper',
          },
          open_access: { is_oa: true },
        }],
      });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime());
    papersAvailable = true;
    const retry = await runEmailNotificationSchedule(emailEnvironment(kv), retryWindow.getTime());

    assert.equal(first.empty, 1);
    assert.equal(first.sent, 0);
    assert.equal(retry.sent, 1);
    assert.equal(retry.empty, 0);
    assert.equal(providerCalls, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastSentAt, retryWindow.toISOString());
    assert.equal(stored.lastDelivery.status, 'sent');
    assert.equal(stored.sentPaperKeys.includes('id:wretry'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends usable papers after a partial source failure and records the partial outcome', async () => {
  const now = new Date('2026-08-10T07:00:00Z');
  const subscriptionKey = 'notification:subscription:partial-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'partial-reader',
      follows: [digestFollow('A1', 'Unavailable Author'), digestFollow('A2', 'Available Author')],
    }),
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: 'partial-delivery' });
    }
    const filter = url.searchParams.get('filter') || '';
    if (filter.includes('author.id:A1')) return jsonResponse(503, {});
    if (filter.includes('author.id:A2')) {
      return jsonResponse(200, {
        results: [{
          id: 'https://openalex.org/WPARTIAL',
          display_name: 'Usable paper from the available source',
          publication_date: '2026-08-09',
          cited_by_count: 5,
          authorships: [{ author: { display_name: 'Available Researcher' } }],
          primary_location: {
            source: { display_name: 'PaperTok Journal' },
            landing_page_url: 'https://example.com/partial-paper',
          },
          open_access: { is_oa: true },
        }],
      });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.partial, 1);
    assert.equal(providerCalls, 1);
    assert.equal(result.failureCodes.EMAIL_SOURCE_OPENALEX_UNAVAILABLE, 1);
    assert.equal(result.sources.failed, 1);
    assert.equal(result.sources.requiredFailed, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'sent');
    assert.equal(stored.lastDelivery.partial, true);
    assert.equal(stored.lastDelivery.sources.requiredFailed, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses a fresh idempotency key for each allowed email test window', () => {
  const subscription = { uid: 'user-123' };
  const first = buildResendIdempotencyKey(subscription, { test: true, now: Date.parse('2026-07-27T18:05:10Z') });
  const retry = buildResendIdempotencyKey(subscription, { test: true, now: Date.parse('2026-07-27T18:05:50Z') });
  const nextAttempt = buildResendIdempotencyKey(subscription, { test: true, now: Date.parse('2026-07-27T18:06:11Z') });
  assert.equal(first, retry);
  assert.notEqual(first, nextAttempt);
});

test('keeps scheduled digest idempotency stable for the UTC day', () => {
  const subscription = { uid: 'user-123' };
  const morning = buildResendIdempotencyKey(subscription, { now: Date.parse('2026-07-27T07:00:00Z') });
  const evening = buildResendIdempotencyKey(subscription, { now: Date.parse('2026-07-27T20:00:00Z') });
  assert.equal(morning, evening);
});

test('builds a deterministic UUID provider idempotency key per user and UTC day', async () => {
  const subscription = { uid: 'user-123' };
  const morning = await buildProviderIdempotencyKey(subscription, {
    now: Date.parse('2026-08-09T07:00:00Z'),
  });
  const retry = await buildProviderIdempotencyKey(subscription, {
    now: Date.parse('2026-08-09T11:00:00Z'),
  });
  const nextDay = await buildProviderIdempotencyKey(subscription, {
    now: Date.parse('2026-08-10T07:00:00Z'),
  });

  assert.equal(morning, retry);
  assert.notEqual(morning, nextDay);
  assert.match(morning, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('two cron windows cannot duplicate a successful weekly digest', async () => {
  const firstWindow = new Date('2026-08-10T07:00:00Z');
  const retryWindow = new Date('2026-08-10T07:20:00Z');
  const laterWindow = new Date('2026-08-10T11:00:00Z');
  const subscriptionKey = 'notification:subscription:concurrent-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'concurrent-reader',
      previewItems: [digestPaper({ id: 'concurrent-paper', published: '2026-08-08' })],
    }),
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return jsonResponse(201, { messageId: 'single-delivery' });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const [first, retry] = await Promise.all([
      runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime()),
      runEmailNotificationSchedule(emailEnvironment(kv), retryWindow.getTime()),
    ]);
    const later = await runEmailNotificationSchedule(emailEnvironment(kv), laterWindow.getTime());

    assert.equal(first.sent + retry.sent, 1);
    assert.equal(providerCalls, 1);
    assert.equal(later.sent, 0);
    assert.equal(later.skipped, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries one unknown provider outcome inside the idempotency window', async () => {
  const firstWindow = new Date('2026-08-10T07:00:00Z');
  const firstAttemptAt = new Date('2026-08-10T07:12:00Z');
  const retryWindow = new Date('2026-08-10T07:20:00Z');
  const subscriptionKey = 'notification:subscription:network-retry-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'network-retry-reader',
      previewItems: [digestPaper({ id: 'network-retry-paper', published: '2026-08-08' })],
    }),
  });
  const providerKeys = [];
  const providerBodies = [];
  let rejectSourceCalls = false;
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      const body = JSON.parse(options.body);
      providerBodies.push(body);
      providerKeys.push(body.headers.idempotencyKey);
      if (providerKeys.length === 1) throw new TypeError('simulated response loss');
      return jsonResponse(201, { messageId: 'accepted-on-safe-retry' });
    }
    if (rejectSourceCalls) throw new Error('No source call expected while replaying a reserved delivery');
    return jsonResponse(200, { results: [] });
  };

  try {
    Date.now = () => firstAttemptAt.getTime();
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime());
    const changed = await kv.get(subscriptionKey, 'json');
    changed.previewItems = [digestPaper({ id: 'different-paper', published: '2026-08-09' })];
    await kv.put(subscriptionKey, JSON.stringify(changed));
    rejectSourceCalls = true;
    Date.now = () => retryWindow.getTime();
    const retry = await runEmailNotificationSchedule(emailEnvironment(kv), retryWindow.getTime());

    assert.equal(first.failed, 1);
    assert.equal(retry.sent, 1);
    assert.equal(providerKeys.length, 2);
    assert.equal(providerKeys[0], providerKeys[1]);
    assert.deepEqual(providerBodies[0], providerBodies[1]);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'sent');
    assert.equal(stored.lastSentAt, firstWindow.toISOString());
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test('uses the final cron window only to replay a late uncertain provider response', async () => {
  const firstWindow = new Date('2026-08-10T13:20:00Z');
  const firstAttemptAt = new Date('2026-08-10T13:32:00Z');
  const retryWindow = new Date('2026-08-10T13:40:00Z');
  const subscriptionKey = 'notification:subscription:late-provider-retry';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'late-provider-retry',
      previewItems: [digestPaper({ id: 'late-retry-paper', published: '2026-08-09' })],
    }),
  });
  const providerBodies = [];
  let rejectSourceCalls = false;
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerBodies.push(JSON.parse(options.body));
      return providerBodies.length === 1
        ? jsonResponse(503, { message: 'upstream response uncertain' })
        : jsonResponse(201, { messageId: 'late-retry-delivery' });
    }
    if (rejectSourceCalls) throw new Error('No source call expected in the final retry-only window');
    return jsonResponse(200, { results: [] });
  };

  try {
    Date.now = () => firstAttemptAt.getTime();
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime());
    rejectSourceCalls = true;
    Date.now = () => retryWindow.getTime();
    const retry = await runEmailNotificationSchedule(emailEnvironment(kv), retryWindow.getTime());

    assert.equal(first.failed, 1);
    assert.equal(retry.sent, 1);
    assert.equal(providerBodies.length, 2);
    assert.deepEqual(providerBodies[0], providerBodies[1]);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test('does not start a new digest in the final recovery-only cron window', async () => {
  const now = new Date('2026-08-10T13:40:00Z');
  const subscriptionKey = 'notification:subscription:final-window-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'final-window-reader',
      previewItems: [digestPaper({ id: 'final-window-paper', published: '2026-08-09' })],
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('The recovery-only window must not query sources or contact the provider');
  };

  try {
    const result = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(result.sent, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.due, 0);
    assert.equal(result.skipped, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastSentAt, undefined);
    assert.equal(stored.lastDelivery, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- A weekly digest whose sources failed this week may retry on Tuesday ----

const SCHEDULED_WORK = {
  id: 'https://openalex.org/WWEEKLY',
  display_name: 'A paper published before the outage',
  publication_date: '2026-07-26',
  cited_by_count: 2,
  authorships: [{ author: { display_name: 'Weekly Researcher' } }],
  primary_location: {
    source: { display_name: 'PaperTok Journal' },
    landing_page_url: 'https://example.com/weekly',
  },
  open_access: { is_oa: true },
};

// One reader following one author, run cron window by cron window. Each test
// switches OpenAlex on and off and scripts what Brevo answers. `Date.now` is
// pinned to the window because reservation recovery measures age with it.
function digestScheduleHarness(subscription = {}) {
  const subscriptionKey = 'notification:subscription:schedule-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({ uid: 'schedule-reader', frequency: 'weekly', ...subscription }),
  });
  const upstream = {
    sourcesUp: false,
    sourceRequests: 0,
    providerBodies: [],
    provider: () => jsonResponse(201, { messageId: 'scheduled-digest' }),
  };
  async function fetchUpstream(input, options = {}) {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      upstream.providerBodies.push(JSON.parse(options.body));
      return upstream.provider();
    }
    if (url.hostname !== 'api.openalex.org') throw new Error(`Unexpected request: ${url}`);
    upstream.sourceRequests += 1;
    if (!upstream.sourcesUp) return jsonResponse(503, {});
    const followed = (url.searchParams.get('filter') || '').includes('author.id:A1');
    return jsonResponse(200, { results: followed ? [SCHEDULED_WORK] : [] });
  }
  async function run(isoWindow) {
    const at = Date.parse(isoWindow);
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    globalThis.fetch = fetchUpstream;
    Date.now = () => at;
    try {
      return await runEmailNotificationSchedule(emailEnvironment(kv), at);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalDateNow;
    }
  }
  return { upstream, run, state: () => storedSubscriptionWithState(kv, subscriptionKey) };
}

function weeklySubscriptionState(lastDelivery, extra = {}) {
  return { enabled: true, frequency: 'weekly', lastDelivery, ...extra };
}

test('a weekly digest whose sources failed late on Monday is retried on Tuesday', async () => {
  // A weekly reader is due on Monday, and a source failure is retried after 40
  // minutes. A failure at 13:00 has no Monday window left that may start a
  // delivery: 13:20 is too soon and 13:40 is recovery-only. The collection
  // failed before any delivery was reserved, so there is nothing to recover
  // either. OpenAlex is back at 13:20, so only the schedule stands between the
  // reader and this week's digest.
  const { upstream, run, state } = digestScheduleHarness();

  const failedMonday = await run('2026-07-27T13:00:00Z');
  const failure = (await state()).lastDelivery;
  upstream.sourcesUp = true;
  const tooSoon = await run('2026-07-27T13:20:00Z');
  const recoveryOnly = await run('2026-07-27T13:40:00Z');
  const requestsOnMonday = upstream.sourceRequests;
  const tuesday = await run('2026-07-28T07:00:00Z');

  // Monday, as the schedule is designed: one failed attempt (both of its
  // OpenAlex requests refused), then two windows that may not start one.
  assert.equal(failedMonday.failed, 1);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.code, 'EMAIL_DIGEST_SOURCES_UNAVAILABLE');
  assert.equal(requestsOnMonday, 2);
  assert.equal(tooSoon.sent + recoveryOnly.sent, 0);
  // Tuesday: the sources answer, so the week's digest goes out -- once.
  assert.deepEqual({
    tuesdaySent: tuesday.sent,
    tuesdaySkipped: tuesday.skipped,
    askedSourcesOnTuesday: upstream.sourceRequests > requestsOnMonday,
    emailsThisWeek: upstream.providerBodies.length,
  }, {
    tuesdaySent: 1,
    tuesdaySkipped: 0,
    askedSourcesOnTuesday: true,
    emailsThisWeek: 1,
  });
  assert.equal((await state()).lastSentAt, '2026-07-28T07:00:00.000Z');
});

test('a Tuesday retry that fails on its sources again waits the usual 40 minutes', async () => {
  const { upstream, run } = digestScheduleHarness();

  await run('2026-07-27T13:00:00Z');
  const firstTuesday = await run('2026-07-28T07:00:00Z');
  upstream.sourcesUp = true;
  const requestsBefore = upstream.sourceRequests;
  const tooSoon = await run('2026-07-28T07:20:00Z');
  const askedTooSoon = upstream.sourceRequests > requestsBefore;
  const retried = await run('2026-07-28T07:40:00Z');

  assert.equal(firstTuesday.failed, 1);
  assert.equal(tooSoon.skipped, 1);
  assert.equal(askedTooSoon, false);
  assert.equal(retried.sent, 1);
  assert.equal(upstream.providerBodies.length, 1);
});

test('a weekly digest whose sources failed is not retried from Wednesday on', async () => {
  // Monday and Tuesday both fail on their sources. The sources are back on
  // Wednesday, but the retry does not reach it: the digest waits for Monday.
  const { upstream, run } = digestScheduleHarness();

  await run('2026-07-27T13:00:00Z');
  const tuesday = await run('2026-07-28T13:00:00Z');
  upstream.sourcesUp = true;
  const requestsBefore = upstream.sourceRequests;
  const wednesday = await run('2026-07-29T07:00:00Z');

  assert.equal(tuesday.failed, 1);
  assert.equal(wednesday.skipped, 1);
  assert.equal(upstream.sourceRequests, requestsBefore);
  assert.equal(upstream.providerBodies.length, 0);
  const failedTuesday = weeklySubscriptionState({
    status: 'failed',
    code: 'EMAIL_DIGEST_SOURCES_UNAVAILABLE',
    at: '2026-07-28T13:00:00.000Z',
  });
  for (const day of ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']) {
    assert.equal(isSubscriptionDue(failedTuesday, new Date(`${day}T07:00:00Z`)), false, day);
  }
  assert.equal(isSubscriptionDue(failedTuesday, new Date('2026-08-03T07:00:00Z')), true);
});

test('a weekly send failure is never retried on Tuesday as a new digest', () => {
  // Only a collection failure is known to have sent nothing. A failure at or
  // after the provider may have delivered, and a Tuesday reservation would
  // carry a new idempotency key, so the provider could not tell it was a
  // repeat.
  const tuesday = new Date('2026-07-28T07:00:00Z');
  const failedMonday = code => weeklySubscriptionState({
    status: 'failed',
    kind: 'digest',
    at: '2026-07-27T13:00:00.000Z',
    ...(code ? { code } : {}),
  });

  assert.equal(isSubscriptionDue(failedMonday('EMAIL_DIGEST_SOURCES_UNAVAILABLE'), tuesday), true);
  for (const code of [
    'EMAIL_SEND_OUTCOME_UNKNOWN',
    'EMAIL_SEND_FAILED',
    'EMAIL_PROVIDER_LIMIT',
    'EMAIL_PROVIDER_AUTH_FAILED',
    'EMAIL_SENDER_NOT_VERIFIED',
    'EMAIL_SCHEDULE_PROCESSING_FAILED',
    '',
  ]) {
    assert.equal(isSubscriptionDue(failedMonday(code), tuesday), false, code || 'no code');
  }
  // An authoritative empty selection is an answer, not a failure.
  assert.equal(isSubscriptionDue(weeklySubscriptionState({
    status: 'empty',
    code: 'EMAIL_DIGEST_SOURCES_UNAVAILABLE',
    at: '2026-07-27T13:00:00.000Z',
  }), tuesday), false);
});

test('a Monday send with an unknown outcome is reconciled on Tuesday, not resent', async () => {
  // The provider's answer is lost at 13:20, so the email may have gone out.
  // Tuesday's existing recovery reconciles the reservation as uncertain, and
  // the source-failure retry never fires for it.
  const { upstream, run, state } = digestScheduleHarness();
  upstream.sourcesUp = true;
  upstream.provider = () => {
    throw new TypeError('simulated response loss');
  };

  const monday = await run('2026-07-27T13:20:00Z');
  const failure = (await state()).lastDelivery;
  upstream.provider = () => jsonResponse(201, { messageId: 'must-not-be-sent' });
  const requestsBefore = upstream.sourceRequests;
  const tuesday = await run('2026-07-28T07:00:00Z');
  const laterTuesday = await run('2026-07-28T07:40:00Z');

  assert.equal(monday.failed, 1);
  assert.equal(failure.code, 'EMAIL_SEND_OUTCOME_UNKNOWN');
  assert.equal(tuesday.uncertain, 1);
  assert.equal(laterTuesday.sent + laterTuesday.uncertain, 0);
  assert.equal(upstream.sourceRequests, requestsBefore);
  assert.equal(upstream.providerBodies.length, 1);
  assert.equal((await state()).lastDelivery.status, 'uncertain');
});

test('a weekly digest sent this week is not sent again on Tuesday', async () => {
  // Monday's first attempt fails on its sources and the 40-minute retry sends.
  // A source failure from this week does not outrank a send from this week.
  const { upstream, run } = digestScheduleHarness();

  await run('2026-07-27T07:00:00Z');
  upstream.sourcesUp = true;
  const retried = await run('2026-07-27T07:40:00Z');
  const requestsBefore = upstream.sourceRequests;
  const tuesday = await run('2026-07-28T07:00:00Z');

  assert.equal(retried.sent, 1);
  assert.equal(tuesday.skipped, 1);
  assert.equal(upstream.sourceRequests, requestsBefore);
  assert.equal(upstream.providerBodies.length, 1);
  assert.equal(isSubscriptionDue(weeklySubscriptionState({
    status: 'failed',
    code: 'EMAIL_DIGEST_SOURCES_UNAVAILABLE',
    at: '2026-07-27T13:00:00.000Z',
  }, { lastSentAt: '2026-07-27T07:40:00.000Z' }), new Date('2026-07-28T07:00:00Z')), false);
});

test('a daily digest keeps its schedule around a Monday source failure', async () => {
  // Daily readers were already due again on Tuesday; none of this changes them.
  const { upstream, run } = digestScheduleHarness({ frequency: 'daily' });

  const monday = await run('2026-07-27T13:00:00Z');
  upstream.sourcesUp = true;
  const tooSoon = await run('2026-07-27T13:20:00Z');
  const tuesday = await run('2026-07-28T07:00:00Z');
  const laterTuesday = await run('2026-07-28T07:40:00Z');

  assert.equal(monday.failed, 1);
  assert.equal(tooSoon.skipped, 1);
  assert.equal(tuesday.sent, 1);
  assert.equal(laterTuesday.skipped, 1);
  assert.equal(upstream.providerBodies.length, 1);
});

test('a weekly source failure from an earlier week is not retried on Tuesday', () => {
  const tuesday = new Date('2026-07-28T07:00:00Z');
  const failedAt = at => weeklySubscriptionState({
    status: 'failed',
    code: 'EMAIL_DIGEST_SOURCES_UNAVAILABLE',
    at,
  }, { lastSentAt: '2026-07-13T07:00:00.000Z' });

  assert.equal(isSubscriptionDue(failedAt('2026-07-27T13:00:00.000Z'), tuesday), true);
  // Last week's Monday, and the Sunday just before this week began.
  assert.equal(isSubscriptionDue(failedAt('2026-07-20T13:00:00.000Z'), tuesday), false);
  assert.equal(isSubscriptionDue(failedAt('2026-07-26T13:00:00.000Z'), tuesday), false);
});

test('a weekly source failure stamped after now does not make Tuesday due', () => {
  // Checked on the calendar rule itself: `isSubscriptionDue` would refuse a
  // future failure anyway, because its 40-minute spacing sees negative time.
  const tuesday = new Date('2026-07-28T07:00:00Z');
  const failedAt = at => weeklySubscriptionState({
    status: 'failed',
    code: 'EMAIL_DIGEST_SOURCES_UNAVAILABLE',
    at,
  });

  assert.equal(isSubscriptionCalendarDue(failedAt('2026-07-27T13:00:00.000Z'), tuesday), true);
  assert.equal(isSubscriptionCalendarDue(failedAt('2026-07-28T07:00:00.001Z'), tuesday), false);
  assert.equal(isSubscriptionCalendarDue(failedAt('2026-07-29T07:00:00.000Z'), tuesday), false);
});

test('a Tuesday retry whose email provider fails keeps the existing duplicate protection', async () => {
  // Monday fails on its sources. Tuesday's retry reserves a delivery and the
  // provider's answer is lost. The next window replays the same reserved draft
  // under the same idempotency key without collecting papers again, and no
  // later window sends a second email.
  const { upstream, run, state } = digestScheduleHarness();

  await run('2026-07-27T13:00:00Z');
  upstream.sourcesUp = true;
  upstream.provider = () => {
    throw new TypeError('simulated response loss');
  };
  const tuesday = await run('2026-07-28T07:00:00Z');
  const failure = (await state()).lastDelivery;
  upstream.provider = () => jsonResponse(201, { messageId: 'scheduled-digest' });
  const requestsBefore = upstream.sourceRequests;
  const replay = await run('2026-07-28T07:20:00Z');
  const afterwards = [
    await run('2026-07-28T07:40:00Z'),
    await run('2026-07-28T13:40:00Z'),
    await run('2026-07-29T07:00:00Z'),
  ];

  assert.equal(tuesday.failed, 1);
  assert.equal(failure.code, 'EMAIL_SEND_OUTCOME_UNKNOWN');
  assert.equal(replay.sent, 1);
  assert.equal(upstream.sourceRequests, requestsBefore);
  assert.equal(upstream.providerBodies.length, 2);
  assert.equal(
    upstream.providerBodies[0].headers.idempotencyKey,
    upstream.providerBodies[1].headers.idempotencyKey,
  );
  assert.deepEqual(upstream.providerBodies[0], upstream.providerBodies[1]);
  assert.equal(afterwards.reduce((total, summary) => total + summary.sent + summary.uncertain, 0), 0);
  assert.equal((await state()).lastSentAt, '2026-07-28T07:00:00.000Z');
});

test('a late Tuesday delivery with an unknown outcome is reconciled on Wednesday without repeating papers', async () => {
  const { upstream, run, state } = digestScheduleHarness();

  await run('2026-07-27T13:00:00Z');
  upstream.sourcesUp = true;
  upstream.provider = () => {
    throw new TypeError('simulated response loss');
  };
  const tuesday = await run('2026-07-28T13:20:00Z');
  const finalTuesday = await run('2026-07-28T13:40:00Z');
  const requestsBeforeRecovery = upstream.sourceRequests;
  upstream.provider = () => jsonResponse(201, { messageId: 'must-not-repeat' });
  const wednesday = await run('2026-07-29T07:00:00Z');
  const recovered = await state();
  const laterWednesday = await run('2026-07-29T07:40:00Z');

  assert.equal(tuesday.failed, 1);
  assert.equal(finalTuesday.failed, 1);
  assert.equal(wednesday.uncertain, 1);
  assert.equal(wednesday.sent, 0);
  assert.equal(upstream.sourceRequests, requestsBeforeRecovery);
  assert.equal(upstream.providerBodies.length, 2);
  assert.deepEqual(upstream.providerBodies[0], upstream.providerBodies[1]);
  assert.equal(recovered.lastDelivery.status, 'uncertain');
  assert.equal(recovered.lastSentAt, '2026-07-28T13:20:00.000Z');
  assert.ok(recovered.sentPaperKeys.length > 0);
  assert.equal(laterWednesday.skipped, 1);

  // The same paper is still in next Monday's rolling publication window,
  // but the recovered identity history must prevent sending it again.
  const nextMonday = await run('2026-08-03T07:00:00Z');
  assert.equal(nextMonday.empty, 1);
  assert.equal(nextMonday.sent, 0);
  assert.equal(upstream.providerBodies.length, 2);
});

test('provider success followed by state reconciliation failure does not resend', async () => {
  const firstWindow = new Date('2026-08-10T11:00:00Z');
  const retryWindow = new Date('2026-08-11T07:00:00Z');
  const subscriptionKey = 'notification:subscription:reconcile-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'reconcile-reader',
      previewItems: [digestPaper({ id: 'reconcile-paper', published: '2026-08-08' })],
    }),
  });
  const basePut = kv.put.bind(kv);
  const stateKey = `${deliveryStatePrefix}reconcile-reader`;
  let rejectDeliveryStateWrites = true;
  kv.put = async (key, value, options) => {
    if (rejectDeliveryStateWrites && key === stateKey) {
      throw new Error('simulated delivery-state write failure');
    }
    return basePut(key, value, options);
  };
  let providerCalls = 0;
  let rejectSourceCalls = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: 'accepted-before-kv-failure' });
    }
    if (rejectSourceCalls) throw new Error('No source call expected during reconciliation');
    return jsonResponse(200, { results: [] });
  };

  try {
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime());
    rejectDeliveryStateWrites = false;
    rejectSourceCalls = true;
    const retry = await runEmailNotificationSchedule(emailEnvironment(kv), retryWindow.getTime());

    assert.equal(first.failed, 1);
    assert.equal(retry.reconciled, 1);
    assert.equal(providerCalls, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastDelivery.status, 'reconciled');
    assert.equal(stored.lastSentAt, firstWindow.toISOString());
    assert.equal(stored.sentPaperKeys.includes('id:reconcile-paper'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a settled Monday digest is not replayed on Tuesday and does not swallow the next one', async () => {
  const firstWindow = new Date('2026-08-10T08:00:00Z');
  const tuesdayWindow = new Date('2026-08-11T08:00:00Z');
  const secondWindow = new Date('2026-08-17T08:00:00Z');
  const subscriptionKey = 'notification:subscription:weekly-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'weekly-reader',
      previewItems: [digestPaper({ id: 'paper-week-one', published: '2026-08-09' })],
    }),
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: `delivery-${providerCalls}` });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const first = await runEmailNotificationSchedule(emailEnvironment(kv), firstWindow.getTime());
    // Tuesday looks back at Monday's ledger. A reservation the delivery state
    // already records must be left alone, not replayed as a reconciliation.
    const tuesday = await runEmailNotificationSchedule(emailEnvironment(kv), tuesdayWindow.getTime());
    const stored = await kv.get(subscriptionKey, 'json');
    stored.previewItems = [digestPaper({ id: 'paper-week-two', published: '2026-08-16' })];
    await kv.put(subscriptionKey, JSON.stringify(stored));
    const second = await runEmailNotificationSchedule(emailEnvironment(kv), secondWindow.getTime());

    assert.equal(first.sent, 1);
    assert.equal(tuesday.sent, 0);
    assert.equal(tuesday.reconciled, 0);
    assert.equal(second.sent, 1);
    assert.equal(second.reconciled, 0);
    assert.equal(providerCalls, 2);
    const state = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(state.lastSentAt, secondWindow.toISOString());
    assert.equal(state.lastDelivery.status, 'sent');
    assert.equal(state.sentPaperKeys.includes('id:paper-week-two'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired reservation already reflected in delivery state does not replace today digest', async () => {
  const staleWindow = new Date('2026-08-09T07:00:00Z');
  const todayWindow = new Date('2026-08-10T08:00:00Z');
  const uid = 'stale-reservation-reader';
  const subscriptionKey = `notification:subscription:${uid}`;
  const subscription = digestSubscription({
    uid,
    previewItems: [digestPaper({ id: 'paper-today', published: '2026-08-10' })],
  });
  const staleReservationId = await buildDeliveryReservationId(subscription, {
    now: staleWindow.getTime(),
  });
  const kv = createMemoryKv({
    [subscriptionKey]: subscription,
    // Yesterday's reservation never committed, but its delivery is already
    // settled in the subscription state: replaying it would push lastSentAt
    // backwards and cost the reader today's digest.
    [`${deliveryLedgerPrefix}2026-08-09`]: {
      committed: 0,
      reserved: 1,
      reservations: {
        [staleReservationId]: {
          status: 'reserved',
          reservedAt: staleWindow.toISOString(),
          attempts: 2,
          draft: {
            provider: 'brevo',
            recipient: { email: 'reader@example.com', displayName: '' },
            content: { subject: 'Yesterday digest', html: '<p>y</p>', text: 'y' },
            unsubscribeUrl: 'https://worker.example/notifications/unsubscribe?token=unsubscribe-token',
            delivery: {
              kind: 'digest',
              sentAt: staleWindow.toISOString(),
              paperCount: 1,
              paperKeys: ['id:paper-yesterday'],
              partial: false,
              sources: {},
            },
          },
        },
      },
    },
    [`${deliveryStatePrefix}${uid}`]: {
      lastCheckedAt: staleWindow.toISOString(),
      lastSentAt: staleWindow.toISOString(),
      sentPaperKeys: ['id:paper-yesterday'],
      lastDelivery: { status: 'sent', kind: 'digest', at: staleWindow.toISOString(), paperCount: 1, partial: false },
    },
  });
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      providerCalls += 1;
      return jsonResponse(201, { messageId: 'today-delivery' });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), todayWindow.getTime());

    assert.equal(summary.sent, 1);
    assert.equal(summary.uncertain, 0);
    assert.equal(providerCalls, 1);
    const state = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(state.lastSentAt, todayWindow.toISOString());
    assert.equal(state.sentPaperKeys.includes('id:paper-today'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports the resend.dev recipient restriction instead of an invalid credential', () => {
  const code = resendSendErrorCode(403, {
    name: 'validation_error',
    message: 'You can only send testing emails to your own email address. Please verify a domain.',
  });
  assert.equal(code, 'EMAIL_TEST_RECIPIENT_RESTRICTED');
  assert.equal(resendSendErrorCode(403, { name: 'forbidden', message: 'Account suspended' }), 'EMAIL_PROVIDER_AUTH_FAILED');
});

test('retains uncertain provider outcomes but releases definitive request rejections', () => {
  assert.equal(providerOutcomeDefinitelyRejected(500), false);
  assert.equal(providerOutcomeDefinitelyRejected(503), false);
  assert.equal(providerOutcomeDefinitelyRejected(408), false);
  assert.equal(providerOutcomeDefinitelyRejected(409), false);
  assert.equal(providerOutcomeDefinitelyRejected(425), false);
  assert.equal(providerOutcomeDefinitelyRejected(400), true);
  assert.equal(providerOutcomeDefinitelyRejected(401), true);
  assert.equal(providerOutcomeDefinitelyRejected(422), true);
  assert.equal(providerOutcomeDefinitelyRejected(429), true);
});

test('prefers a fully configured Brevo provider and keeps Resend as fallback', () => {
  assert.equal(configuredEmailProvider({
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_FROM_EMAIL: 'papertok@example.com',
    RESEND_API_KEY: 're_test',
  }), 'brevo');
  assert.equal(configuredEmailProvider({ RESEND_API_KEY: 're_test' }), 'resend');
  assert.equal(configuredEmailProvider({
    EMAIL_PROVIDER: 'brevo',
    RESEND_API_KEY: 're_test',
  }), '');
});

test('maps Brevo authentication, sender and quota failures', () => {
  assert.equal(brevoSendErrorCode(401, { code: 'unauthorized' }), 'EMAIL_PROVIDER_AUTH_FAILED');
  assert.equal(brevoSendErrorCode(400, { message: 'Sender not valid' }), 'EMAIL_SENDER_NOT_VERIFIED');
  assert.equal(brevoSendErrorCode(429, { code: 'rate_limit' }), 'EMAIL_PROVIDER_LIMIT');
});

test('reports Brevo as available only when the configured sender is active', async () => {
  const restore = stubFetch(jsonResponse(200, {
    senders: [
      { active: true, email: 'papertok@example.com' },
      { active: false, email: 'disabled@example.com' },
    ],
  }));
  try {
    const health = await checkEmailProviderHealth({
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'papertok@example.com',
    });
    assert.equal(health.available, true);
    assert.equal(health.provider, 'brevo');
    assert.equal(health.senderMode, 'brevo-verified-sender');

    const inactiveHealth = await checkEmailProviderHealth({
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'missing@example.com',
    });
    assert.equal(inactiveHealth.available, false);
    assert.equal(inactiveHealth.code, 'EMAIL_SENDER_NOT_VERIFIED');
  } finally {
    restore();
  }
});

test('treats a restricted (send-only) Resend key as available, not an auth failure', async () => {
  const restore = stubFetch(jsonResponse(401, {
    statusCode: 401,
    name: 'restricted_api_key',
    message: 'This API key is restricted to only send emails.',
  }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_restricted_key' });
    assert.equal(health.available, true);
    assert.equal(health.permissionLimited, true);
    assert.equal(health.code, undefined);
    assert.equal(health.senderMode, 'resend-test');
  } finally {
    restore();
  }
});

test('reports verified-domain sender mode for a restricted key with a custom from address', async () => {
  const restore = stubFetch(jsonResponse(401, { name: 'restricted_api_key', message: 'restricted' }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_x', RESEND_FROM_EMAIL: 'PaperTok <hi@papertok.io>' });
    assert.equal(health.available, true);
    assert.equal(health.senderMode, 'verified-domain');
  } finally {
    restore();
  }
});

test('still fails closed for a genuinely invalid Resend key', async () => {
  const restore = stubFetch(jsonResponse(401, {
    statusCode: 401,
    name: 'invalid_api_key',
    message: 'API key is invalid',
  }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_bad_key' });
    assert.equal(health.available, false);
    assert.equal(health.code, 'EMAIL_PROVIDER_AUTH_FAILED');
  } finally {
    restore();
  }
});

test('fails closed for a bare 403 with no restricted marker (blocked or suspended key)', async () => {
  const restore = stubFetch(jsonResponse(403, { name: 'forbidden', message: 'Account suspended' }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_blocked' });
    assert.equal(health.available, false);
    assert.equal(health.code, 'EMAIL_PROVIDER_AUTH_FAILED');
  } finally {
    restore();
  }
});

test('still detects a restricted key when Resend reports it as 403', async () => {
  const restore = stubFetch(jsonResponse(403, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails.' }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_restricted' });
    assert.equal(health.available, true);
    assert.equal(health.permissionLimited, true);
  } finally {
    restore();
  }
});

test('fails closed when a 401 body is not valid JSON', async () => {
  const restore = stubFetch({
    status: 401,
    ok: false,
    json: async () => { throw new Error('not json'); },
  });
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_weird' });
    assert.equal(health.available, false);
    assert.equal(health.code, 'EMAIL_PROVIDER_AUTH_FAILED');
  } finally {
    restore();
  }
});

test('marks a verified domain as available with a full-access key', async () => {
  const restore = stubFetch(jsonResponse(200, { data: [{ status: 'verified' }] }));
  try {
    const health = await checkEmailProviderHealth({ RESEND_API_KEY: 're_full' });
    assert.equal(health.available, true);
    assert.equal(health.senderMode, 'verified-domain');
  } finally {
    restore();
  }
});

test('is not configured without an email provider key', async () => {
  const health = await checkEmailProviderHealth({});
  assert.equal(health.configured, false);
  assert.equal(health.available, false);
  assert.equal(health.code, 'EMAIL_NOT_CONFIGURED');
});

test('exposes a PII-free freshness summary for the latest newsletter schedule', async () => {
  const kv = createMemoryKv({
    [scheduleStatusKey]: {
      scheduledAt: '2026-08-09T07:00:00.000Z',
      completedAt: '2026-08-09T07:00:30.000Z',
      scanned: 3,
      processed: 2,
      deferred: 1,
      due: 2,
      sent: 1,
      empty: 0,
      invalid: 1,
      reconciled: 0,
      partial: 1,
      skipped: 1,
      failed: 0,
      failureCodes: { EMAIL_SOURCE_OPENALEX_UNAVAILABLE: 1 },
    },
  });

  const health = await getEmailScheduleHealth({ NOTIFICATION_STORE: kv }, Date.parse('2026-08-09T08:00:00.000Z'));

  assert.equal(health.available, true);
  assert.equal(health.fresh, true);
  assert.equal(health.sent, 1);
  assert.equal(health.processed, 2);
  assert.equal(health.deferred, 1);
  assert.equal(health.invalid, 1);
  assert.deepEqual(health.failureCodes, { EMAIL_SOURCE_OPENALEX_UNAVAILABLE: 1 });
  assert.equal(Object.hasOwn(health, 'email'), false);
  assert.equal(Object.hasOwn(health, 'uid'), false);
});

test('escapes paper metadata in email HTML', () => {
  const digest = renderDigest({ displayName: '<Nico>' }, [{
    title: '<script>alert(1)</script>',
    authors: ['Ada'],
    abstract: 'An abstract with <img src=x onerror=alert(1)> inside.',
    matches: [],
  }], 'https://example.com/unsubscribe', true);
  assert.equal(digest.html.includes('<script>alert(1)</script>'), false);
  assert.equal(digest.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(digest.html.includes('<img src=x'), false);
  assert.equal(digest.html.includes('<Nico>'), false);
});

const UNSUBSCRIBE_URL = 'https://example.com/unsubscribe';
const ON_A_MONDAY = { now: Date.parse('2026-08-10T07:00:00Z') };

// The page as read: the hidden preheader above the nameplate repeats the
// headlines, so order is measured from the nameplate down.
function pageBody(html) {
  return html.slice(html.indexOf('<h1'));
}

function frontPagePaper(overrides = {}) {
  return {
    id: 'lead',
    title: 'Below-threshold surface-code memory',
    authors: ['A. Rivera', 'M. Okafor', 'L. Chen', 'P. Ito'],
    published: '2026-08-04',
    journal: 'arXiv',
    citationCount: 0,
    openAccess: true,
    url: 'https://example.com/lead',
    area: 'physics',
    abstract: 'Quantum error correction only pays off once adding qubits lowers the error rate.',
    matches: [{ type: 'topic', canonicalId: 'quant-ph', displayName: 'Quantum Computing' }],
    ...overrides,
  };
}

function briefPaper(overrides = {}) {
  return frontPagePaper({
    id: 'brief',
    title: 'Sparse attention at scale',
    authors: ['J. Park'],
    published: '2026-08-03',
    journal: 'NeurIPS',
    citationCount: 4,
    openAccess: false,
    url: 'https://example.com/brief',
    area: 'cs',
    abstract: 'A brief keeps its abstract to itself.',
    matches: [{ type: 'topic', canonicalId: 'cs.LG', displayName: 'Machine Learning' }],
    ...overrides,
  });
}

test('the weekly digest is set as a front page: nameplate, dateline, lead story, briefs', () => {
  const digest = renderDigest(
    { displayName: 'Nicolás Muñoz' },
    [frontPagePaper(), briefPaper()],
    UNSUBSCRIBE_URL,
    false,
    ON_A_MONDAY,
  );

  assert.match(digest.html, /^<!doctype html><html lang="en">/);
  assert.match(digest.html, /<h1[^>]*>The PaperTok Weekly<\/h1>/);
  assert.equal(digest.html.includes('Monday, 10 August 2026'), true);
  assert.equal(digest.html.includes('Weekly edition for Nicolás'), true);
  assert.match(digest.html, /<h2[^>]*><a [^>]*href="https:\/\/example\.com\/lead"[^>]*>Below-threshold surface-code memory<\/a><\/h2>/);
  assert.match(digest.html, /<h3[^>]*><a [^>]*href="https:\/\/example\.com\/brief"[^>]*>Sparse attention at scale<\/a><\/h3>/);
  // Only the lead story carries an excerpt of its abstract.
  assert.equal(digest.html.includes('Quantum error correction only pays off'), true);
  assert.equal(digest.html.includes('A brief keeps its abstract to itself.'), false);
  assert.equal(digest.html.includes('By A. Rivera, M. Okafor, L. Chen and others'), true);
  assert.equal(digest.html.includes('4 Aug 2026 · arXiv · Open access'), true);
  assert.equal(digest.html.includes('3 Aug 2026 · NeurIPS · 4 citations'), true);
  const page = pageBody(digest.html);
  assert.ok(page.indexOf('Below-threshold') < page.indexOf('Also in this edition'));
  assert.ok(page.indexOf('Also in this edition') < page.indexOf('Sparse attention at scale'));
  assert.equal(digest.html.includes(`href="${UNSUBSCRIBE_URL}"`), true);

  assert.match(digest.text, /^THE PAPERTOK WEEKLY\nMonday, 10 August 2026 · Weekly edition for Nicolás\n/);
  assert.equal(digest.text.includes('Quantum error correction only pays off'), true);
  assert.equal(digest.text.includes('A brief keeps its abstract to itself.'), false);
  assert.equal(digest.text.includes(`Unsubscribe: ${UNSUBSCRIBE_URL}`), true);
});

test('each paper wears its field ink and name; one of no known field wears ink and no name', () => {
  const unknown = briefPaper({
    id: 'unknown',
    title: 'Annual report on photonic interconnects',
    url: 'https://example.com/unknown',
    area: undefined,
    matches: [{ type: 'project', canonicalId: 'P1', displayName: 'QUANTERA' }],
  });
  const digest = renderDigest({}, [frontPagePaper(), unknown], UNSUBSCRIBE_URL, false, ON_A_MONDAY);

  // The field's name is set in the field's ink, as is the rule above the story.
  assert.match(digest.html, /color:#4f46e5[^"]*">Physics</);
  assert.equal(digest.html.includes('background:#4f46e5'), true);
  const page = pageBody(digest.html);
  const beforeUnknownTitle = page.slice(
    page.indexOf('Also in this edition'),
    page.indexOf('Annual report on photonic interconnects'),
  );
  assert.ok(beforeUnknownTitle.length > 0);
  assert.equal(beforeUnknownTitle.includes('background:#111318'), true);
  assert.doesNotMatch(beforeUnknownTitle, /Physics|Computer Science|Engineering/);

  assert.equal(digest.text.includes('PHYSICS · You follow Quantum Computing\nBelow-threshold'), true);
  assert.equal(digest.text.includes('\nYou follow QUANTERA\nAnnual report on photonic interconnects'), true);
});

test('the discovery pick is boxed after the briefs and says it is outside the follows', () => {
  const discovery = briefPaper({
    id: 'discovery',
    title: 'A single-dose mRNA vaccine',
    url: 'https://example.com/discovery',
    area: 'med',
    matches: [],
  });
  const digest = renderDigest({}, [frontPagePaper(), briefPaper(), discovery], UNSUBSCRIBE_URL, false, ON_A_MONDAY);

  const page = pageBody(digest.html);
  assert.ok(page.indexOf('Sparse attention at scale') < page.indexOf('Outside your follows'));
  assert.ok(page.indexOf('Outside your follows') < page.indexOf('A single-dose mRNA vaccine'));
  assert.equal(digest.text.includes('OUTSIDE YOUR FOLLOWS · MEDICINE\nA single-dose mRNA vaccine'), true);
});

test('a discovery that is the whole edition leads it and still says where it comes from', () => {
  const digest = renderDigest({}, [frontPagePaper({ matches: [] })], UNSUBSCRIBE_URL, false, ON_A_MONDAY);

  assert.equal(digest.text.includes('OUTSIDE YOUR FOLLOWS · PHYSICS\nBelow-threshold'), true);
  assert.equal(digest.html.includes('Also in this edition'), false);
});

test('the subject is the lead headline and how many papers follow it', () => {
  const papers = [
    frontPagePaper(),
    briefPaper(),
    briefPaper({ id: 'third', title: 'Third paper', url: 'https://example.com/third' }),
  ];
  const subjectOf = list => renderDigest({}, list, UNSUBSCRIBE_URL, false, ON_A_MONDAY).subject;

  assert.equal(subjectOf(papers), 'Below-threshold surface-code memory, and 2 more');
  assert.equal(subjectOf(papers.slice(0, 1)), 'Below-threshold surface-code memory');
  const long = subjectOf([frontPagePaper({ title: 'Quantum '.repeat(30).trim() }), briefPaper()]);
  assert.ok(long.length <= 90, long);
  assert.match(long, /^Quantum( Quantum)*…, and 1 more$/);
  assert.equal(subjectOf([frontPagePaper({ title: 'High-Resolution ($2560^3$) Simulation' })]).includes('$'), false);
});

test('the lead excerpt ends on a whole word and never inside a formula', () => {
  const abstract = 'word $x^{2}$ '.repeat(100).trim();
  const digest = renderDigest({}, [frontPagePaper({ abstract })], UNSUBSCRIBE_URL, false, ON_A_MONDAY);
  const plainAbstract = 'word x^2 '.repeat(100).trim();
  const excerpt = digest.text.split('\n').find(line => line.startsWith('word'));

  assert.ok(excerpt.endsWith('…'), excerpt);
  const kept = excerpt.slice(0, -1);
  assert.ok(plainAbstract.startsWith(kept), excerpt);
  assert.equal(plainAbstract[kept.length], ' ');
  assert.ok(kept.length < plainAbstract.length);
  const leadHtml = digest.html.slice(digest.html.indexOf('<h2'), digest.html.indexOf('By A. Rivera'));
  assert.equal(leadHtml.includes('$'), false);
  assert.equal(leadHtml.split('<sup>').length, leadHtml.split('</sup>').length);
});

test('a lead without an abstract goes straight from headline to byline', () => {
  const digest = renderDigest({}, [frontPagePaper({ abstract: undefined })], UNSUBSCRIBE_URL, false, ON_A_MONDAY);
  assert.equal(digest.text.includes('Below-threshold surface-code memory\nBy A. Rivera'), true);
});

test('keeps the spaces around a formula in email HTML and text', () => {
  assert.equal(renderScientificHtml('A $x$ b').replace(/<[^>]+>/g, ''), 'A x b');
  const digest = renderDigest({}, [frontPagePaper({
    title: 'Density of $\\Omega_m$ at high redshift',
  })], UNSUBSCRIBE_URL, false, ON_A_MONDAY);
  assert.equal(digest.text.includes('Density of Ω_m at high redshift'), true);
  assert.equal(digest.subject, 'Density of Ω_m at high redshift');
});

test('a full edition stays inside the delivery ledger draft limits', () => {
  // A reservation keeps the exact draft for one retry, cut at 120 000 / 40 000
  // characters; a template that outgrew them would retry a truncated email.
  const papers = Array.from({ length: 10 }, (_, index) => frontPagePaper({
    id: `paper-${index}`,
    title: `${'Title '.repeat(82)}${index}`,
    authors: Array.from({ length: 6 }, () => 'A'.repeat(120)),
    journal: 'J'.repeat(200),
    citationCount: 999,
    abstract: 'word '.repeat(120).trim(),
    url: `https://example.com/${'p'.repeat(200)}${index}`,
    matches: Array.from({ length: 4 }, (_, follow) => ({
      type: 'topic',
      canonicalId: `T${follow}`,
      displayName: 'F'.repeat(200),
    })),
  }));
  const digest = renderDigest({ displayName: 'N'.repeat(160) }, papers, UNSUBSCRIBE_URL, false, ON_A_MONDAY);
  assert.ok(digest.html.length < 120_000, `${digest.html.length} characters of HTML`);
  assert.ok(digest.text.length < 40_000, `${digest.text.length} characters of text`);
});

test('the field inks are the app\'s own light-theme inks', async () => {
  const css = await readFile(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
  const lightStart = css.indexOf(':root {');
  const lightTheme = css.slice(lightStart, css.indexOf('\n}', lightStart));
  assert.ok(lightTheme.includes('--bg-primary: #fbf8f0'), 'the first :root block is the light theme');
  for (const [area, { gradient }] of Object.entries(CATEGORIES)) {
    const token = gradient.match(/var\((--gradient-[a-z]+)\)/)[1];
    const value = lightTheme.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    assert.equal(fieldInks[area], value?.toLowerCase(), area);
  }
  assert.deepEqual(Object.keys(fieldInks).sort(), Object.keys(CATEGORIES).sort());
});

test('renders common LaTeX in email-safe HTML without exposing delimiters', () => {
  const rendered = renderScientificHtml('High-Resolution ($2560^3$) with $\\Omega_m$');
  assert.equal(rendered.includes('$'), false);
  assert.equal(rendered.includes('2560<sup>3</sup>'), true);
  assert.equal(rendered.includes('Ω<sub>m</sub>'), true);

  const digest = renderDigest({ frequency: 'daily' }, [{
    title: 'High-Resolution ($2560^3$) Simulation',
    authors: ['Ada'],
    matches: [],
  }], 'https://example.com/unsubscribe', false);
  assert.equal(digest.html.includes('2560<sup>3</sup>'), true);
  assert.equal(digest.text.includes('$2560^3$'), false);
});

test('renders every digest label in English', () => {
  const digest = renderDigest({
    language: 'en',
    displayName: 'Nicolas',
  }, [{
    title: 'A new result',
    authors: [],
    citationCount: 2,
    matches: [{ displayName: 'Quantum Physics' }],
  }], 'https://example.com/unsubscribe', false, ON_A_MONDAY);

  assert.equal(digest.subject, 'A new result');
  assert.equal(digest.html.includes('The PaperTok Weekly'), true);
  assert.equal(digest.html.includes('You follow Quantum Physics'), true);
  assert.equal(digest.html.includes('Authors unavailable'), true);
  assert.equal(digest.html.includes('2 citations'), true);
  assert.equal(digest.html.includes('Open my feed'), true);
  assert.equal(digest.html.includes('Unsubscribe'), true);
  assert.equal(digest.html.includes('Porque sigues'), false);
  assert.equal(digest.text.includes('Weekly edition for Nicolas'), true);
});

test('a subscription stored with legacy Spanish still gets an English digest', () => {
  const digest = renderDigest({
    frequency: 'daily',
    language: 'es',
    displayName: 'Nicolas',
  }, [{
    title: 'A new result',
    authors: [],
    citationCount: 1,
    matches: [{ displayName: 'Quantum Physics' }],
  }], 'https://example.com/unsubscribe', false, ON_A_MONDAY);

  assert.equal(digest.subject, 'A new result');
  assert.match(digest.html, /^<!doctype html><html lang="en">/);
  assert.equal(digest.html.includes('You follow Quantum Physics'), true);
  assert.equal(digest.html.includes('1 citation'), true);
  assert.equal(digest.text.includes('Weekly edition for Nicolas'), true);
  for (const spanish of ['Porque sigues', 'novedad', 'Darme de baja', 'selección']) {
    assert.equal(digest.html.includes(spanish), false, spanish);
    assert.equal(digest.text.includes(spanish), false, spanish);
  }
});

test('the unsubscribe page is English even for legacy Spanish links and browsers', async () => {
  const token = 'legacy-spanish-unsubscribe-token';
  const kv = createMemoryKv({
    'notification:subscription:reader': {
      uid: 'reader',
      email: 'reader@example.com',
      enabled: true,
      language: 'es',
      unsubscribeToken: token,
    },
    [`notification:unsubscribe:${token}`]: 'reader',
  });
  // Links in emails sent before the change carried `&lang=es`.
  const url = `https://example.com/notifications/unsubscribe?token=${token}&lang=es`;
  const headers = { 'accept-language': 'es-ES,es;q=0.9' };

  const confirmation = await handleEmailUnsubscribe(new Request(url, { headers }), { NOTIFICATION_STORE: kv });
  assert.equal(confirmation.status, 200);
  const page = await confirmation.text();
  assert.match(page, /<html lang="en">/);
  assert.match(page, /Confirm unsubscribe/);
  assert.match(page, /Disable emails/);
  assert.doesNotMatch(page, /Confirmar baja|lang=es/);

  const invalid = await handleEmailUnsubscribe(
    new Request('https://example.com/notifications/unsubscribe?token=bad&lang=es', { headers }),
    { NOTIFICATION_STORE: kv },
  );
  assert.equal(invalid.status, 400);
  const invalidPage = await invalid.text();
  assert.match(invalidPage, /<html lang="en">/);
  assert.match(invalidPage, /<h1[^>]*>Invalid unsubscribe link<\/h1>/);

  const unavailable = await handleEmailUnsubscribe(new Request(url, { headers }), {});
  assert.equal(unavailable.status, 503);
  const unavailablePage = await unavailable.text();
  assert.match(unavailablePage, /<html lang="en">/);
  assert.match(unavailablePage, /<h1[^>]*>Service unavailable<\/h1>/);
});

test('the test email is the same edition, says it is a test, and keeps its own subject', () => {
  const empty = renderDigest({ language: 'en' }, [], UNSUBSCRIBE_URL, true, ON_A_MONDAY);
  assert.equal(empty.subject, 'PaperTok: test email');
  assert.match(empty.html, /<h1[^>]*>The PaperTok Weekly<\/h1>/);
  assert.equal(empty.html.includes('Your PaperTok email works'), true);
  assert.equal(empty.html.includes('We have not found recent publications'), true);

  const withPaper = renderDigest({}, [frontPagePaper()], UNSUBSCRIBE_URL, true, ON_A_MONDAY);
  assert.equal(withPaper.subject, 'PaperTok: test email');
  assert.equal(withPaper.html.includes('Your PaperTok email works'), true);
  assert.match(withPaper.html, /<h2[^>]*><a [^>]*>Below-threshold surface-code memory<\/a><\/h2>/);
});

function identityEnvironment(kv) {
  return { ...emailEnvironment(kv), FIREBASE_WEB_API_KEY: 'firebase-web-key' };
}

function preferencesRequest() {
  return new Request('https://worker.example/notifications/preferences', {
    headers: { authorization: 'Bearer id-token' },
  });
}

async function readPreferencesAs(account) {
  const restore = stubFetch(jsonResponse(200, { users: [account] }));
  try {
    return await handleEmailNotificationRequest(
      preferencesRequest(),
      identityEnvironment(createMemoryKv()),
      '/notifications/preferences',
    );
  } finally {
    restore();
  }
}

test('refuses to configure notifications for an address the account never proved', async () => {
  // FIREBASE_WEB_API_KEY is public, so a console that ever accepts password or
  // unverified-IdP sign-up would let anyone subscribe a stranger's inbox.
  await assert.rejects(
    () => readPreferencesAs({ localId: 'attacker', email: 'victim@example.com' }),
    error => error.code === 'EMAIL_ADDRESS_NOT_VERIFIED' && error.status === 403,
  );
  await assert.rejects(
    () => readPreferencesAs({
      localId: 'attacker',
      email: 'victim@example.com',
      emailVerified: false,
      providerUserInfo: [{ providerId: 'google.com', email: 'attacker@example.com' }],
    }),
    error => error.code === 'EMAIL_ADDRESS_NOT_VERIFIED' && error.status === 403,
  );
});

test('accepts a verified address or a federated provider that owns it', async () => {
  const verified = await readPreferencesAs({
    localId: 'reader',
    email: 'reader@example.com',
    emailVerified: true,
  });
  assert.equal(verified.preferences.email, 'reader@example.com');
  // With no stored subscription the reported language is English, never the old Spanish default.
  assert.equal(verified.preferences.language, 'en');

  // Firebase does not always mark federated sign-ins as verified, so the
  // provider that vouched for the address counts as proof of possession.
  const federated = await readPreferencesAs({
    localId: 'reader',
    email: 'Reader@Example.com',
    emailVerified: false,
    providerUserInfo: [{ providerId: 'github.com', email: 'reader@example.com' }],
  });
  assert.equal(federated.preferences.email, 'Reader@Example.com');
});

test('reports a subscription saved as daily as weekly', async () => {
  const kv = createMemoryKv({
    'notification:subscription:reader': digestSubscription({ uid: 'reader', frequency: 'daily' }),
  });
  const restore = stubFetch(jsonResponse(200, {
    users: [{ localId: 'reader', email: 'reader@example.com', emailVerified: true }],
  }));
  try {
    const { preferences } = await handleEmailNotificationRequest(
      preferencesRequest(),
      identityEnvironment(kv),
      '/notifications/preferences',
    );
    assert.equal(preferences.enabled, true);
    assert.equal(preferences.frequency, 'weekly');
  } finally {
    restore();
  }
});

test('an older client that still asks for daily emails is subscribed weekly', async () => {
  const kv = createMemoryKv();
  const request = new Request('https://example.com/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      frequency: 'daily',
      maxPapers: 5,
      follows: [digestFollow()],
      previewItems: [],
    }),
  });

  const saved = await saveSubscription(request, { NOTIFICATION_STORE: kv }, {
    uid: 'old-client',
    email: 'reader@example.com',
    displayName: 'Reader',
  });

  assert.equal(saved.frequency, 'weekly');
  assert.equal((await kv.get('notification:subscription:old-client', 'json')).frequency, 'weekly');
});

test('gives the identity lookup and both provider probes a deadline', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ host: url.hostname, signal: options.signal });
    if (url.hostname === 'identitytoolkit.googleapis.com') {
      return jsonResponse(200, {
        users: [{ localId: 'reader', email: 'reader@example.com', emailVerified: true }],
      });
    }
    if (url.hostname === 'api.brevo.com') {
      return jsonResponse(200, { senders: [{ active: true, email: 'papertok@example.com' }] });
    }
    return jsonResponse(200, { data: [] });
  };

  try {
    await handleEmailNotificationRequest(
      preferencesRequest(),
      identityEnvironment(createMemoryKv()),
      '/notifications/preferences',
    );
    await checkEmailProviderHealth(emailEnvironment(createMemoryKv()));
    await checkEmailProviderHealth({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test-key' });

    assert.deepEqual(calls.map(call => call.host), [
      'identitytoolkit.googleapis.com',
      'api.brevo.com',
      'api.resend.com',
    ]);
    // A hung identity or health upstream used to hold the subrequest open with
    // nothing to cut it, in front of every notification route.
    calls.forEach((call) => {
      assert.ok(call.signal instanceof AbortSignal, `${call.host} was called without a deadline`);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends the Brevo digest with one-click unsubscribe headers', async () => {
  const now = new Date('2026-08-10T08:00:00Z');
  const subscriptionKey = 'notification:subscription:brevo-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'brevo-reader',
      previewItems: [digestPaper({ id: 'brevo-paper', published: '2026-08-09' })],
    }),
  });
  let payload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.brevo.com') {
      payload = JSON.parse(options.body);
      return jsonResponse(201, { messageId: 'brevo-delivery' });
    }
    return jsonResponse(200, { results: [] });
  };

  try {
    const summary = await runEmailNotificationSchedule(emailEnvironment(kv), now.getTime());

    assert.equal(summary.sent, 1);
    // Gmail and Yahoo score sender reputation on RFC 8058 one-click, which the
    // Resend branch already sent and the production Brevo branch did not.
    const unsubscribeUrl = 'https://api.papertok.app/notifications/unsubscribe?token=unsubscribe-token';
    assert.equal(payload.headers['List-Unsubscribe'], `<${unsubscribeUrl}>`);
    assert.equal(payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.equal(typeof payload.headers.idempotencyKey, 'string');
    assert.equal(payload.textContent.includes(unsubscribeUrl), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refuses to run the schedule without an atomic delivery ledger', async () => {
  const now = new Date('2026-08-10T08:00:00Z');
  const subscriptionKey = 'notification:subscription:unprotected-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'unprotected-reader',
      previewItems: [digestPaper({ id: 'unprotected-paper', published: '2026-08-09' })],
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No delivery may be attempted without the delivery ledger binding');
  };

  try {
    // Without the Durable Object the daily limit degrades to a per-isolate lock
    // that cannot stop two isolates from sending twice: fail loud, not silently.
    const summary = await runEmailNotificationSchedule({
      NOTIFICATION_STORE: kv,
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'xkeysib-test',
      BREVO_FROM_EMAIL: 'papertok@example.com',
    }, now.getTime());

    assert.equal(summary.disabled, true);
    assert.equal(summary.sent, 0);
    assert.equal(summary.scanned, 0);
    assert.equal(summary.failureCodes.EMAIL_DELIVERY_LEDGER_MISSING, 1);
    const stored = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(stored.lastSentAt, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- F2 residue: the deadline must cover the body, not just the headers ------
// Both helpers below used to arm an `AbortController` and clear its timer in a
// `finally`. `fetch` resolves when the *headers* arrive, so the timer was gone
// before a single byte of the body had been read, and every caller reads the
// body afterwards. An upstream that answers its headers and then dribbles hung
// exactly as one that never answered at all. `AbortSignal.timeout` has no timer
// to clear: it stays armed through the read. The harness is the same one the
// client-side F2 sweep built, so both halves of the tree describe a stalled
// upstream the same way.

test('fetchDigestSource cuts a dribbling body, not only the headers', async () => {
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchDigestSource('https://upstream.example/', {}, {
      source: 'openalex',
      timeoutMs: 25,
    });
    await response.text();
  }));

  assert.equal(outcome, 'TimeoutError');
});

test('fetchWithDeadline cuts a dribbling body, not only the headers', async () => {
  // This is the helper behind the Identity Toolkit lookup that guards every
  // protected email route, both provider sends and both `/health/email` probes.
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchWithDeadline('https://upstream.example/', {}, 25);
    await response.json();
  }));

  assert.equal(outcome, 'TimeoutError');
});

test('fetchWithDeadline enforces its deadline even when the caller brings a signal', async () => {
  // The mutant this kills: `init.signal ?? deadline`. A caller signal here is a
  // *cancellation*, not a budget, and says nothing about how long the upstream
  // may take -- letting it replace the deadline would hand the next caller that
  // passes one an unbounded wait, which is the whole failure this helper exists
  // to remove.
  const caller = new AbortController(); // never fires
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchWithDeadline('https://upstream.example/', { signal: caller.signal }, 25);
    await response.text();
  }));

  assert.equal(outcome, 'TimeoutError');
});

test('fetchWithDeadline still tells a caller cancellation from its own deadline', async () => {
  // The guard on over-correcting: adding the deadline to a caller signal must
  // not relabel a hang-up as a timeout. `AbortSignal.any` keeps whichever fired
  // first as the reason.
  const caller = new AbortController();
  caller.abort(new DOMException('the caller gave up', 'AbortError'));
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchWithDeadline('https://upstream.example/', { signal: caller.signal }, 25);
    await response.text();
  }));

  assert.equal(outcome, 'AbortError');
});

test('a source that runs out of deadline is still reported as a TIMEOUT', async () => {
  // The subtle half of the fix. `AbortSignal.timeout` raises `TimeoutError`,
  // not `AbortError`, and the controller whose `.aborted` flag used to answer
  // this question is gone -- so a fix that stopped here would quietly recode
  // every real deadline as `_UNAVAILABLE` and lose the signal the digest report
  // publishes.
  const timingOut = async () => {
    throw new DOMException('the deadline passed', 'TimeoutError');
  };
  await withStubbedFetch(timingOut, () => assert.rejects(
    fetchDigestSource('https://upstream.example/', {}, { source: 'openalex', timeoutMs: 25 }),
    error => error.code === 'EMAIL_SOURCE_OPENALEX_TIMEOUT',
  ));
});
