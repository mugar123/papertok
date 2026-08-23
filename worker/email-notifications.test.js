import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailNotificationInternals,
  checkEmailProviderHealth,
  getEmailScheduleHealth,
  handleEmailNotificationRequest,
  handleEmailUnsubscribe,
  runEmailNotificationSchedule,
} from './email-notifications.js';

const {
  brevoSendErrorCode,
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
  saveSubscription,
  resendSendErrorCode,
  renderScientificHtml,
  renderDigest,
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
  assert.deepEqual(sanitizePreferences({ enabled: true, frequency: 'weekly', maxPapers: 10 }), {
    enabled: true,
    frequency: 'weekly',
    maxPapers: 10,
    language: 'es',
  });
  assert.equal(sanitizePreferences({ language: 'en' }).language, 'en');
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

test('sends daily subscriptions once per day and weekly subscriptions on Monday', () => {
  const monday = new Date('2026-07-27T07:00:00Z');
  const laterMonday = new Date('2026-07-27T11:00:00Z');
  const tuesday = new Date('2026-07-28T07:00:00Z');
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'daily' }, monday), true);
  assert.equal(isSubscriptionDue({
    enabled: true,
    frequency: 'daily',
    lastSentAt: monday.toISOString(),
  }, laterMonday), false);
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'weekly' }, monday), true);
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'weekly' }, tuesday), false);
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

test('scheduled digest fetches native arXiv follows before OpenAlex indexes them', async () => {
  const now = new Date('2026-07-29T07:00:00Z');
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
      lastSentAt: '2026-07-28T07:00:00Z',
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
    assert.equal(brevoPayload.subject, '1 novedad científica para ti');
    assert.equal(
      brevoPayload.htmlContent.includes('The evolution of galaxy dust scaling relations'),
      true,
    );
    const storedSubscription = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(storedSubscription.lastSentAt, now.toISOString());
    assert.equal(storedSubscription.sentPaperKeys.includes('id:2607.26058'), true);
    const rawSubscription = await kv.get(subscriptionKey, 'json');
    const deliveryState = await kv.get(`${deliveryStatePrefix}arxiv-reader`, 'json');
    assert.equal(rawSubscription.lastSentAt, '2026-07-28T07:00:00Z');
    assert.notEqual(rawSubscription.lastSentAt, now.toISOString());
    assert.equal(rawSubscription.lastDelivery, undefined);
    assert.equal(deliveryState.lastSentAt, now.toISOString());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled digest fetches and emails papers from every followed entity type', async () => {
  const now = new Date();
  now.setUTCHours(7, 0, 0, 0);
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
    assert.equal(brevoPayload.subject, '4 novedades científicas para ti');
    assert.equal(
      brevoPayload.htmlContent.includes('https://papertok-report-api.papertok-mugar123.workers.dev/notifications/unsubscribe?token=unsubscribe-token'),
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
  const url = `https://example.com/notifications/unsubscribe?token=${token}&lang=en`;

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
    `https://example.com/notifications/unsubscribe?token=${staleToken}&lang=en`,
    { method: 'POST' },
  ), { NOTIFICATION_STORE: kv });

  assert.equal(response.status, 400);
  assert.ok(await kv.get('notification:subscription:reader', 'json'));
  assert.equal(await kv.get(`notification:unsubscribe:${staleToken}`), null);
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
  const now = new Date('2026-08-09T07:00:00Z');
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
    updatedAt: '2026-08-09T07:00:01.000Z',
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
  const now = new Date('2026-08-02T07:00:02Z');
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
  const now = new Date('2026-08-09T07:00:00Z');
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
  const now = new Date('2026-08-09T07:20:00Z');
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

test('retries an empty daily selection in the next cron window and sends when papers appear', async () => {
  const firstWindow = new Date('2026-08-09T07:00:00Z');
  const retryWindow = new Date('2026-08-09T11:00:00Z');
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
  const now = new Date('2026-08-09T07:00:00Z');
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

test('two cron windows cannot duplicate a successful daily digest', async () => {
  const firstWindow = new Date('2026-08-09T07:00:00Z');
  const retryWindow = new Date('2026-08-09T07:20:00Z');
  const laterWindow = new Date('2026-08-09T11:00:00Z');
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
  const firstWindow = new Date('2026-08-09T07:00:00Z');
  const firstAttemptAt = new Date('2026-08-09T07:12:00Z');
  const retryWindow = new Date('2026-08-09T07:20:00Z');
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
  const firstWindow = new Date('2026-08-09T13:20:00Z');
  const firstAttemptAt = new Date('2026-08-09T13:32:00Z');
  const retryWindow = new Date('2026-08-09T13:40:00Z');
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
  const now = new Date('2026-08-09T13:40:00Z');
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

test('provider success followed by state reconciliation failure does not resend', async () => {
  const firstWindow = new Date('2026-08-09T11:00:00Z');
  const retryWindow = new Date('2026-08-10T07:00:00Z');
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

test('a settled digest yesterday does not swallow today digest', async () => {
  const firstWindow = new Date('2026-08-09T08:00:00Z');
  const secondWindow = new Date('2026-08-10T08:00:00Z');
  const subscriptionKey = 'notification:subscription:daily-reader';
  const kv = createMemoryKv({
    [subscriptionKey]: digestSubscription({
      uid: 'daily-reader',
      previewItems: [digestPaper({ id: 'paper-day-one', published: '2026-08-09' })],
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
    // A new day brings a new paper: yesterday's committed reservation must not
    // be replayed as a reconciliation instead of today's delivery.
    const stored = await kv.get(subscriptionKey, 'json');
    stored.previewItems = [digestPaper({ id: 'paper-day-two', published: '2026-08-10' })];
    await kv.put(subscriptionKey, JSON.stringify(stored));
    const second = await runEmailNotificationSchedule(emailEnvironment(kv), secondWindow.getTime());

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 1);
    assert.equal(second.reconciled, 0);
    assert.equal(providerCalls, 2);
    const state = await storedSubscriptionWithState(kv, subscriptionKey);
    assert.equal(state.lastSentAt, secondWindow.toISOString());
    assert.equal(state.lastDelivery.status, 'sent');
    assert.equal(state.sentPaperKeys.includes('id:paper-day-two'), true);
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
  const digest = renderDigest({ frequency: 'daily', displayName: '<Nico>' }, [{
    title: '<script>alert(1)</script>',
    authors: ['Ada'],
    matches: [],
  }], 'https://example.com/unsubscribe', true);
  assert.equal(digest.html.includes('<script>alert(1)</script>'), false);
  assert.equal(digest.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
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

test('renders every digest label in the subscription language', () => {
  const digest = renderDigest({
    frequency: 'weekly',
    language: 'en',
    displayName: 'Nicolas',
  }, [{
    title: 'A new result',
    authors: [],
    citationCount: 2,
    matches: [{ displayName: 'Quantum Physics' }],
  }], 'https://example.com/unsubscribe?lang=en', false);

  assert.equal(digest.subject, '1 scientific update for you');
  assert.equal(digest.html.includes('PAPERTOK · FOLLOWING UPDATES'), true);
  assert.equal(digest.html.includes('Because you follow Quantum Physics'), true);
  assert.equal(digest.html.includes('Authors unavailable'), true);
  assert.equal(digest.html.includes('2 citations'), true);
  assert.equal(digest.html.includes('Open my feed'), true);
  assert.equal(digest.html.includes('Unsubscribe'), true);
  assert.equal(digest.html.includes('Porque sigues'), false);
  assert.equal(digest.text.includes('This is your weekly selection.'), true);
});

test('localizes the test-email subject and empty state', () => {
  const digest = renderDigest({ frequency: 'daily', language: 'en' }, [], 'https://example.com/unsubscribe', true);
  assert.equal(digest.subject, 'PaperTok: test email');
  assert.equal(digest.html.includes('Your PaperTok email works'), true);
  assert.equal(digest.html.includes('We have not found recent publications'), true);
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
  const now = new Date('2026-08-09T08:00:00Z');
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
    const unsubscribeUrl = 'https://papertok-report-api.papertok-mugar123.workers.dev/notifications/unsubscribe?token=unsubscribe-token&lang=es';
    assert.equal(payload.headers['List-Unsubscribe'], `<${unsubscribeUrl}>`);
    assert.equal(payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.equal(typeof payload.headers.idempotencyKey, 'string');
    assert.equal(payload.textContent.includes(unsubscribeUrl), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refuses to run the schedule without an atomic delivery ledger', async () => {
  const now = new Date('2026-08-09T08:00:00Z');
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
