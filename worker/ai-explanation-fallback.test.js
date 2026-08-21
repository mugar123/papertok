import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAIExplanation } from './ai-explanation.js';
import { KimiBudgetLedger } from './kimi-budget-ledger.js';

const UID = 'ada-uid';
const KIMI_BASE_URL = 'https://papertok--kimi.modal.run/v1';

// ---------------------------------------------------------------------------
// Doubles.
// ---------------------------------------------------------------------------

/** `caches.default` is a Workers global; this is the in-memory equivalent. */
function installCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const body = store.get(key.url || String(key));
        return body === undefined ? undefined : new Response(body);
      },
      async put(key, response) {
        store.set(key.url || String(key), await response.text());
      },
    },
  };
  return store;
}

/** A daily AI quota ledger that always has room left. */
function requestQuotaLedger(remaining = 4) {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ accepted: true, remaining })),
    }),
  };
}

/**
 * The real Durable Object over in-memory storage, so reservations and
 * settlements are accounted exactly as they are in production.
 */
function kimiBudgetLedger({ spentMicros = 0 } = {}) {
  const store = new Map();
  if (spentMicros) store.set('spentMicros', spentMicros);
  const storage = {
    get: async key => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
  };
  storage.transaction = async run => run(storage);
  const ledger = new KimiBudgetLedger({ storage });
  return {
    store,
    idFromName: name => name,
    get: () => ({ fetch: (url, init) => ledger.fetch(new Request(url, init)) }),
  };
}

function envWith(overrides = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'web-key',
    GEMINI_API_KEY: 'gemini-key',
    AI_PROVIDER: 'gemini',
    AI_FALLBACK_PROVIDER: 'modal-kimi',
    AI_MODEL: 'gemini-3.5-flash',
    AI_FALLBACK_MODEL: 'gemini-3.5-flash-lite',
    MODAL_KIMI_MODEL: 'moonshotai/Kimi-K3',
    MODAL_KIMI_BASE_URL: KIMI_BASE_URL,
    MODAL_PROXY_TOKEN_ID: 'wk-test-id',
    MODAL_PROXY_TOKEN_SECRET: 'ws-test-secret',
    KIMI_MONTHLY_HARD_CAP_USD: '27',
    REQUEST_QUOTA_LEDGER: requestQuotaLedger(),
    KIMI_BUDGET_LEDGER: kimiBudgetLedger(),
    ...overrides,
  };
}

function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    const call = {
      url,
      headers: init.headers || {},
      body: (() => {
        try { return JSON.parse(init.body); } catch { return null; }
      })(),
    };
    calls.push(call);
    const match = Object.keys(handlers).find(fragment => url.includes(fragment));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    return handlers[match](call);
  };
  return calls;
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

// The shape Gemini returns once the free-tier requests-per-day allowance is gone.
const GEMINI_DAILY_QUOTA = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
    }],
  },
};

// The same status code, but a per-minute burst: Gemini still has daily quota.
const GEMINI_RATE_LIMIT = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Too many requests. Please retry shortly.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
  },
};

const EXPLANATION = {
  overview: 'El trabajo mide cómo se enfría un gas ultrafrío al aplicarle un campo alterno.',
  whyItMatters: 'Permite simular materiales cuánticos sin fabricarlos.',
  keyPoints: ['Enfriamiento en dos etapas', 'Campo alterno de 40 kHz', 'Vida media de 8 s'],
  methodology: 'Trampa magneto-óptica seguida de evaporación forzada.',
  results: 'La temperatura baja un 40 % frente al protocolo estático.',
  concepts: [{ term: 'Condensado de Bose-Einstein', explanation: 'Estado en el que los átomos comparten la misma función de onda.' }],
  limitations: ['Una sola especie atómica'],
  takeaway: 'El campo alterno mejora el enfriamiento sin coste de vida media.',
};

const kimiCompletion = () => json({
  id: 'chatcmpl-kimi',
  model: 'moonshotai/Kimi-K3',
  choices: [{
    index: 0,
    finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify(EXPLANATION) },
  }],
  usage: {
    prompt_tokens: 900,
    completion_tokens: 700,
    completion_tokens_details: { reasoning_tokens: 300 },
  },
});

const REQUIRED_FIELDS = [
  'overview', 'whyItMatters', 'keyPoints', 'methodology',
  'results', 'concepts', 'limitations', 'takeaway',
];

const PAPER = {
  id: 'arxiv:2608.01234',
  title: 'Alternating-field cooling of ultracold gases',
  abstract: 'We report a two-stage cooling protocol for ultracold rubidium in which an alternating magnetic field replaces the final evaporation ramp, reaching 40 % lower temperatures at equal lifetime.',
  authors: [{ name: 'Ada Lovelace' }],
  year: 2026,
  categories: ['cond-mat.quant-gas'],
};

function explainRequest(paper = PAPER, { level = 'university', language = 'es' } = {}) {
  return new Request('https://worker.test/ai/explain', {
    method: 'POST',
    headers: { authorization: 'Bearer id-token', 'content-type': 'application/json' },
    body: JSON.stringify({ level, language, paper }),
  });
}

const identityOk = () => json({ users: [{ localId: UID }] });

// ---------------------------------------------------------------------------
// The fallback itself.
// ---------------------------------------------------------------------------

test('an exhausted Gemini daily quota hands the explanation to Kimi K3', async () => {
  installCache();
  const env = envWith();
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': kimiCompletion,
  });

  const result = await handleAIExplanation(explainRequest(), env);

  assert.equal(result.provider, 'modal-kimi');
  assert.equal(result.model, 'moonshotai/Kimi-K3');
  assert.equal(result.sourceBasis, 'abstract');
  assert.equal(result.explanation.overview, EXPLANATION.overview);
  assert.deepEqual(result.explanation.keyPoints, EXPLANATION.keyPoints);
  assert.equal(result.explanation.concepts[0].term, EXPLANATION.concepts[0].term);

  // A daily quota error is final: no point retrying the same key on Flash Lite.
  assert.equal(calls.filter(call => call.url.includes('generativelanguage')).length, 1);

  const kimiCall = calls.find(call => call.url.includes('modal.run'));
  assert.equal(kimiCall.url, `${KIMI_BASE_URL}/chat/completions`);
  assert.equal(kimiCall.body.model, 'moonshotai/Kimi-K3');
  assert.equal(kimiCall.body.response_format.type, 'json_object');
  assert.equal(kimiCall.headers['Modal-Key'], 'wk-test-id');
  assert.equal(kimiCall.headers['Modal-Secret'], 'ws-test-secret');

  // Kimi gets no structural schema, so the field contract has to travel inside
  // the prompt or the keys become a coin flip.
  const kimiPrompt = kimiCall.body.messages.at(-1).content;
  for (const field of REQUIRED_FIELDS) assert.match(kimiPrompt, new RegExp(`"${field}"`));
  assert.match(kimiPrompt, /objetos con "term" y "explanation"/);
  assert.match(kimiPrompt, /No renombres, traduzcas, anides ni omitas claves/);

  // 900 prompt + (700 + 300) output tokens at $3 / $15 per million.
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('spentMicros'), 17_700);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('reservedMicros'), 0);
  assert.equal(result.budget.hardCapUsd, 27);
  assert.equal(result.budget.remainingUsd, 26.9823);
});

test('the Kimi answer is cached under the fallback pair, not under Gemini', async () => {
  installCache();
  const env = envWith();
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': kimiCompletion,
  });

  await handleAIExplanation(explainRequest(), env);
  const cached = await handleAIExplanation(explainRequest(), env);

  assert.equal(cached.cached, true);
  assert.equal(cached.provider, 'modal-kimi');
  assert.equal(cached.explanation.takeaway, EXPLANATION.takeaway);
  assert.equal(calls.filter(call => call.url.includes('modal.run')).length, 1);
});

test('a Gemini rate limit stays on Gemini and never spends Kimi budget', async () => {
  installCache();
  const env = envWith();
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_RATE_LIMIT, 429),
    'modal.run': kimiCompletion,
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_BUSY',
  );

  // Flash, then Flash Lite. Kimi is reserved for a real quota wall.
  assert.equal(calls.filter(call => call.url.includes('generativelanguage')).length, 2);
  assert.equal(calls.some(call => call.url.includes('modal.run')), false);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('spentMicros'), undefined);
});

test('the monthly hard cap stops the fallback before Modal is contacted', async () => {
  installCache();
  const env = envWith({ KIMI_BUDGET_LEDGER: kimiBudgetLedger({ spentMicros: 26_999_000 }) });
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': kimiCompletion,
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_FALLBACK_BUDGET_EXHAUSTED'
      && error.status === 429
      && error.quota.scope === 'fallback-budget',
  );
  assert.equal(calls.some(call => call.url.includes('modal.run')), false);
});

test('a model Modal does not serve surfaces the original Gemini quota error', async () => {
  installCache();
  const env = envWith({ MODAL_KIMI_MODEL: 'moonshotai/Kimi-K3-Typo' });
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': () => json({ error: { message: 'model not found', type: 'invalid_request_error' } }, 404),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_QUOTA_EXHAUSTED' && error.quota.scope === 'provider',
  );

  // The failed attempt still charges its reservation: a misconfigured model
  // silently eats the monthly safety budget instead of raising an alarm.
  assert.ok(env.KIMI_BUDGET_LEDGER.store.get('spentMicros') > 100_000);
});

test('the contract follows the requested language', async () => {
  installCache();
  const env = envWith();
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': kimiCompletion,
  });

  await handleAIExplanation(explainRequest(PAPER, { language: 'en' }), env);

  const kimiPrompt = calls.find(call => call.url.includes('modal.run')).body.messages.at(-1).content;
  for (const field of REQUIRED_FIELDS) assert.match(kimiPrompt, new RegExp(`"${field}"`));
  assert.match(kimiPrompt, /copied verbatim in English/);
});

test('translated keys from Kimi fail loudly instead of rendering half empty', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': () => json({
      choices: [{
        message: {
          content: JSON.stringify({
            resumen: 'El trabajo mide el enfriamiento de un gas ultrafrío.',
            conclusion: 'El campo alterno mejora el protocolo.',
          }),
        },
      }],
      usage: { prompt_tokens: 900, completion_tokens: 700 },
    }),
  });

  // What the contract prevents: without `overview` and `takeaway` there is no
  // explanation to render, and a 502 beats a screen with two empty sections.
  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_INVALID_RESPONSE' && error.status === 502,
  );
});
