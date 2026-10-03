import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './report-api.js';
import {
  MAX_HOOK_CHARS,
  MAX_HOOK_PAPERS,
  buildHookPrompt,
  cleanHookSentence,
  handlePaperHooks,
  normalizeHookPapers,
  parseHookPayload,
} from './ai-hooks.js';

const ABSTRACT = 'We show that for any two finite-dimensional memoryless quantum channels, parallel, adaptive and general testing strategies achieve the same Stein exponent at every fixed type-I error tolerance, namely the regularized channel relative entropy. Adaptivity therefore provides no asymptotic advantage.';

function paper(id, overrides = {}) {
  return { id, title: `Paper ${id}`, abstract: ABSTRACT, ...overrides };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    match: async request => {
      const body = store.get(request.url);
      return body ? new Response(body) : undefined;
    },
    put: async (request, response) => { store.set(request.url, await response.text()); },
  };
}

function recordingLedger({ accepted = true } = {}) {
  const calls = [];
  return {
    calls,
    idFromName: () => 'quota-id',
    get: () => ({
      fetch: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ accepted }));
      },
    }),
  };
}

function geminiAnswer(items) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }],
  }));
}

function hooksRequest(papers, headers = {}) {
  return new Request('https://papertok-report-api.example/ai/hooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers },
    body: JSON.stringify({ papers }),
  });
}

function env(ledger, overrides = {}) {
  return { GEMINI_API_KEY: 'gemini-test-key', REQUEST_QUOTA_LEDGER: ledger, ...overrides };
}

test('papers without a real abstract, repeats, and extras are not sent to the model', () => {
  const papers = normalizeHookPapers([
    paper('a'),
    paper('a'),
    paper('stub', { abstract: 'Too short to say anything true about.' }),
    paper('untitled', { title: '' }),
    ...Array.from({ length: 10 }, (_, index) => paper(`p${index}`)),
  ]);
  assert.equal(papers.length, MAX_HOOK_PAPERS);
  assert.equal(papers[0].id, 'a');
  assert.ok(!papers.some(item => item.id === 'stub' || item.id === 'untitled'));
  assert.deepEqual(normalizeHookPapers('nope'), []);
});

test('the prompt asks for supported, plain, English claims and carries every id', () => {
  const prompt = buildHookPrompt([paper('arxiv:2609.01234'), paper('doi:10.1/x')]);
  assert.match(prompt, /Only claims the abstract supports/);
  assert.match(prompt, /in English/);
  assert.match(prompt, /id: arxiv:2609\.01234/);
  assert.match(prompt, /id: doi:10\.1\/x/);
});

test('answers map back to the ids asked for, and nothing else', () => {
  const asked = [paper('a'), paper('b')];
  const hooks = parseHookPayload({
    candidates: [{ content: { parts: [{ text: JSON.stringify([
      { id: 'a', whyItMatters: '  "Adaptive tricks will not beat a fixed plan."  ' },
      { id: 'intruder', whyItMatters: 'Not asked for.' },
      { id: 'b', whyItMatters: '' },
    ]) }] } }],
  }, asked);
  assert.deepEqual(hooks, { a: 'Adaptive tricks will not beat a fixed plan.' });
  assert.deepEqual(parseHookPayload({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }, asked), {});
});

test('a sentence past the cap is cut at a word and marked as cut', () => {
  const long = cleanHookSentence('word '.repeat(100));
  assert.ok(long.length <= MAX_HOOK_CHARS);
  assert.match(long, /word…$/);
});

test('uncached papers go to the model in one call, are paid for in papers, and are cached', async () => {
  const ledger = recordingLedger();
  const cache = memoryCache();
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const prompt = JSON.parse(options.body).contents[0].parts[0].text;
    assert.match(prompt, /id: a/);
    assert.match(prompt, /id: b/);
    return geminiAnswer([
      { id: 'a', whyItMatters: 'Changing strategy mid-test buys nothing.' },
      { id: 'b', whyItMatters: 'Fixed plans are as good as clever ones.' },
    ]);
  };

  const first = await handlePaperHooks(hooksRequest([paper('a'), paper('b')]), env(ledger), { fetchImpl, cache });
  assert.deepEqual(Object.keys(first.hooks).sort(), ['a', 'b']);
  assert.equal(calls, 1);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.calls[0].action, 'reserve');
  assert.equal(ledger.calls[0].amount, 2);

  // Anyone else scrolling past the same papers is served from the cache.
  const second = await handlePaperHooks(hooksRequest([paper('a'), paper('b')]), env(ledger), { fetchImpl, cache });
  assert.deepEqual(second.hooks, first.hooks);
  assert.equal(calls, 1, 'no second model call');
  assert.equal(ledger.calls.length, 1, 'no second reservation');
});

test('papers the model leaves unanswered are given back to the allowance', async () => {
  const ledger = recordingLedger();
  const fetchImpl = async () => geminiAnswer([{ id: 'a', whyItMatters: 'One answer out of three.' }]);
  const { hooks } = await handlePaperHooks(
    hooksRequest([paper('a'), paper('b'), paper('c')]),
    env(ledger),
    { fetchImpl, cache: memoryCache() },
  );
  assert.deepEqual(Object.keys(hooks), ['a']);
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount]), [['reserve', 3], ['release', 2]]);
});

test('a provider failure is an empty answer, and the whole reservation comes back', async () => {
  const ledger = recordingLedger();
  const fetchImpl = async () => new Response('{}', { status: 503 });
  const { hooks } = await handlePaperHooks(hooksRequest([paper('a')]), env(ledger), { fetchImpl, cache: memoryCache() });
  assert.deepEqual(hooks, {});
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount]), [['reserve', 1], ['release', 1]]);
});

test('an exhausted allowance, the kill switch, or no key never reach the model', async () => {
  const fetchImpl = async () => { throw new Error('the model must not be called'); };
  const refused = await handlePaperHooks(
    hooksRequest([paper('a')]),
    env(recordingLedger({ accepted: false })),
    { fetchImpl, cache: memoryCache() },
  );
  assert.deepEqual(refused.hooks, {});
  const disabled = await handlePaperHooks(
    hooksRequest([paper('a')]),
    env(recordingLedger(), { AI_HOOKS_DISABLED: 'true' }),
    { fetchImpl, cache: memoryCache() },
  );
  assert.deepEqual(disabled.hooks, {});
  const unconfigured = await handlePaperHooks(
    hooksRequest([paper('a')]),
    env(recordingLedger(), { GEMINI_API_KEY: '' }),
    { fetchImpl, cache: memoryCache() },
  );
  assert.deepEqual(unconfigured.hooks, {});
});

test('a ledger that cannot be reached grants nothing and is not an error', async () => {
  const broken = { idFromName: () => 'id', get: () => ({ fetch: async () => { throw new Error('ledger down'); } }) };
  const fetchImpl = async () => { throw new Error('the model must not be called'); };
  const { hooks } = await handlePaperHooks(hooksRequest([paper('a')]), env(broken), { fetchImpl, cache: memoryCache() });
  assert.deepEqual(hooks, {});
});

test('a guest is counted by connection, against a daily key', async () => {
  const ledger = recordingLedger();
  const fetchImpl = async () => geminiAnswer([{ id: 'a', whyItMatters: 'A sentence.' }]);
  await handlePaperHooks(hooksRequest([paper('a')]), env(ledger), {
    fetchImpl,
    cache: memoryCache(),
    now: () => new Date('2026-09-26T10:00:00Z'),
  });
  // The ledger hashes the subject before storing it; the fake sees the hash.
  assert.match(ledger.calls[0].subjectKey, /^[a-f0-9]{64}$/);
});

test('the router answers /ai/hooks, and refuses a foreign origin and a GET', async () => {
  const ledger = recordingLedger();
  const routed = await reportApi.fetch(
    hooksRequest([paper('a', { abstract: 'short' })], { origin: 'https://mugar123.github.io' }),
    env(ledger),
  );
  assert.equal(routed.status, 200);
  assert.deepEqual(await routed.json(), { hooks: {} });

  const foreign = await reportApi.fetch(hooksRequest([paper('a')], { origin: 'https://evil.example' }), env(ledger));
  assert.equal(foreign.status, 403);

  const get = await reportApi.fetch(new Request('https://papertok-report-api.example/ai/hooks'), env(ledger));
  assert.equal(get.status, 405);
});
