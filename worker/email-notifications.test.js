import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailNotificationInternals,
  checkEmailProviderHealth,
  runEmailNotificationSchedule,
} from './email-notifications.js';

const {
  brevoSendErrorCode,
  buildResendIdempotencyKey,
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
    async list({ prefix = '' } = {}) {
      return {
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      };
    },
  };
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

test('sends daily subscriptions once per day and weekly subscriptions on Monday', () => {
  const monday = new Date('2026-07-27T07:00:00Z');
  const tuesday = new Date('2026-07-28T07:00:00Z');
  assert.equal(isSubscriptionDue({ enabled: true, frequency: 'daily' }, monday), true);
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
    const storedSubscription = await kv.get(subscriptionKey, 'json');
    assert.equal(storedSubscription.lastSentAt, now.toISOString());
    assert.equal(storedSubscription.sentPaperKeys.includes('id:2607.26058'), true);
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
    }, now.getTime());

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.empty, 0);
    assert.deepEqual(brevoPayload.sender, { name: 'PaperTok', email: 'papertok@example.com' });
    assert.deepEqual(brevoPayload.to, [{ email: 'reader@example.com', name: 'Reader' }]);
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

    const storedSubscription = await kv.get(subscriptionKey, 'json');
    assert.equal(storedSubscription.lastSentAt, now.toISOString());
    assert.equal(storedSubscription.lastCheckedAt, now.toISOString());
    assert.equal(storedSubscription.sentPaperKeys.includes('doi:10.1234/author'), true);
    assert.equal(
      [...kv.values.entries()].some(([key, value]) => key.startsWith('notification:send-count:') && value === '1'),
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

test('records an empty no-send run without calling a provider', async () => {
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
    }, now.getTime());

    assert.equal(result.sent, 0);
    assert.equal(result.empty, 1);
    assert.equal(result.failed, 0);
    const storedSubscription = await kv.get(subscriptionKey, 'json');
    assert.equal(storedSubscription.lastCheckedAt, now.toISOString());
    assert.equal(storedSubscription.lastSentAt, undefined);
    assert.equal([...kv.values.keys()].some(key => key.startsWith('notification:send-count:')), false);
    const storedOutcome = await kv.get(scheduleStatusKey, 'json');
    assert.equal(storedOutcome.scheduledAt, now.toISOString());
    assert.equal(storedOutcome.empty, 1);
    assert.equal(storedOutcome.failed, 0);
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

test('reports the resend.dev recipient restriction instead of an invalid credential', () => {
  const code = resendSendErrorCode(403, {
    name: 'validation_error',
    message: 'You can only send testing emails to your own email address. Please verify a domain.',
  });
  assert.equal(code, 'EMAIL_TEST_RECIPIENT_RESTRICTED');
  assert.equal(resendSendErrorCode(403, { name: 'forbidden', message: 'Account suspended' }), 'EMAIL_PROVIDER_AUTH_FAILED');
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
