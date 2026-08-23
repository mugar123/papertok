import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAIExplanation } from './ai-explanation.js';
import { KimiBudgetLedger } from './kimi-budget-ledger.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

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

/** A daily AI quota ledger that always has room left, and remembers who asked. */
function requestQuotaLedger(remaining = 4) {
  const calls = [];
  return {
    calls,
    idFromName: name => name,
    get: periodKey => ({
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ periodKey, ...body });
        return new Response(JSON.stringify(
          body.action === 'release'
            ? { released: true, remaining: remaining + 1 }
            : { accepted: true, remaining },
        ));
      },
    }),
  };
}

/**
 * The real Durable Object over in-memory storage, so reservations and
 * settlements are accounted exactly as they are in production.
 */
function inMemoryKimiLedger(spentMicros = 0) {
  const store = new Map();
  if (spentMicros) store.set('spentMicros', spentMicros);
  const storage = {
    get: async key => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
    // Workers hands back a Map from `list`, verified against workerd.
    list: async ({ prefix = '' } = {}) => new Map(
      [...store].filter(([key]) => String(key).startsWith(prefix)),
    ),
  };
  storage.transaction = async run => run(storage);
  const ledger = new KimiBudgetLedger({ storage });
  return { store, fetch: (url, init) => ledger.fetch(new Request(url, init)) };
}

function kimiBudgetLedger({ spentMicros = 0 } = {}) {
  const ledger = inMemoryKimiLedger(spentMicros);
  return {
    store: ledger.store,
    idFromName: name => name,
    get: () => ({ fetch: ledger.fetch }),
  };
}

/** One ledger per month, so a reserve and a settle can land on different ones. */
function kimiBudgetLedgerByPeriod() {
  const ledgers = new Map();
  const asked = [];
  const ledgerFor = period => {
    if (!ledgers.has(period)) ledgers.set(period, inMemoryKimiLedger());
    return ledgers.get(period);
  };
  return {
    asked,
    storeFor: period => ledgerFor(period).store,
    idFromName: period => { asked.push(period); return period; },
    get: period => ({ fetch: ledgerFor(period).fetch }),
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
    headers: { authorization: `Bearer ${fakeIdToken()}`, 'content-type': 'application/json' },
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
  // The monthly cap and what is left of it are the operator's business: they
  // used to ride in the answer, which cached them for a week for everyone.
  assert.equal('budget' in result, false);
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
  assert.equal('budget' in cached, false);
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

  // The provider answered with an error, so it billed nothing. Charging the
  // whole reservation here meant ~180 failed attempts ate the $27 cap and left
  // the fallback dead for the rest of the month.
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('spentMicros'), 0);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('reservedMicros'), 0);
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

// ---------------------------------------------------------------------------
// What a failure costs (G3: F6, F8, F9, F12, F15).
// ---------------------------------------------------------------------------

const PDF_ONLY_PAPER = {
  id: 'arxiv:2608.09999',
  title: 'Sideband cooling without an abstract',
  pdfUrl: 'https://arxiv.org/pdf/2608.09999.pdf',
  year: 2026,
};

const ledgerActions = env => env.REQUEST_QUOTA_LEDGER.calls.map(call => call.action);

test('a Modal error that reports usage is charged for exactly that usage', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': () => json({
      error: { message: 'Generation stopped', type: 'server_error' },
      usage: { prompt_tokens: 900, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 300 } },
    }, 500),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_UNAVAILABLE',
  );

  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('spentMicros'), 17_700);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('reservedMicros'), 0);
});

test('a dead network still charges the reservation, because nothing was measured', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': () => { throw new TypeError('network error'); },
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_UNAVAILABLE',
  );

  // The opposite of the case above: with no answer there is no way to know what
  // ran on the other side, so the conservative estimate stands.
  assert.ok(env.KIMI_BUDGET_LEDGER.store.get('spentMicros') > 100_000);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('reservedMicros'), 0);
});

test('a provider outage gives the daily use back instead of spending it', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json({ error: { code: 500, message: 'Internal error' } }, 500),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_UNAVAILABLE',
  );

  assert.deepEqual(ledgerActions(env), ['reserve', 'release']);
  const [reserve, release] = env.REQUEST_QUOTA_LEDGER.calls;
  // Same day and same identity, or the refund lands on another ledger.
  assert.equal(release.periodKey, reserve.periodKey);
  assert.equal(release.subjectKey, reserve.subjectKey);
});

test('an unreachable PDF blames the source, not the paper, and refunds', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    'arxiv.org': () => new Response('down', { status: 500 }),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(PDF_ONLY_PAPER), env),
    error => error.code === 'AI_SOURCE_UNAVAILABLE' && error.status === 502,
  );

  assert.deepEqual(ledgerActions(env), ['reserve', 'release']);
});

test('a malformed answer keeps the use spent: the provider did the work', async () => {
  installCache();
  const env = envWith();
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_INVALID_RESPONSE',
  );

  // Refunding this would hand out unlimited free retries against the provider.
  assert.deepEqual(ledgerActions(env), ['reserve']);
});

test('a rejected Gemini request is not repeated on the lighter model', async () => {
  installCache();
  const env = envWith();
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json({
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' },
    }, 400),
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_INVALID_REQUEST_UPSTREAM' && error.status === 502,
  );

  assert.equal(calls.filter(call => call.url.includes('generativelanguage')).length, 1);
  assert.deepEqual(ledgerActions(env), ['reserve']);
});

test('a Gemini attempt that eats the request budget skips Kimi instead of charging it', async () => {
  installCache();
  const env = envWith();
  let clock = Date.parse('2026-08-23T10:00:00.000Z');
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => {
      clock += 55_000;
      return json(GEMINI_DAILY_QUOTA, 429);
    },
    'modal.run': kimiCompletion,
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env, { now: () => clock }),
    error => error.code === 'AI_QUOTA_EXHAUSTED' && error.quota.scope === 'provider',
  );

  // 55 s spent leaves 13 s of the browser's 70: not enough for Kimi's 52 s, and
  // starting it anyway would charge $0.15 for an answer nobody waits for.
  assert.equal(calls.some(call => call.url.includes('modal.run')), false);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.get('reservedMicros'), undefined);
  assert.deepEqual(ledgerActions(env), ['reserve', 'release']);
});

test('the same wall with room to spare still reaches Kimi', async () => {
  installCache();
  const env = envWith();
  let clock = Date.parse('2026-08-23T10:00:00.000Z');
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => {
      clock += 40_000;
      return json(GEMINI_DAILY_QUOTA, 429);
    },
    'modal.run': kimiCompletion,
  });

  const result = await handleAIExplanation(explainRequest(), env, { now: () => clock });

  assert.equal(result.provider, 'modal-kimi');
  assert.equal(calls.filter(call => call.url.includes('modal.run')).length, 1);
});

test('the monthly cap cannot be raised from configuration', async () => {
  installCache();
  const env = envWith({
    KIMI_MONTHLY_HARD_CAP_USD: '50',
    KIMI_BUDGET_LEDGER: kimiBudgetLedger({ spentMicros: 26_999_000 }),
  });
  const calls = stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': kimiCompletion,
  });

  // $27 is the ceiling on purpose: the variable can only lower it.
  await assert.rejects(
    handleAIExplanation(explainRequest(), env),
    error => error.code === 'AI_FALLBACK_BUDGET_EXHAUSTED',
  );
  assert.equal(calls.some(call => call.url.includes('modal.run')), false);
});

test('a month that rolls over between reserve and settle settles where it reserved', async () => {
  installCache();
  const env = envWith({ KIMI_BUDGET_LEDGER: kimiBudgetLedgerByPeriod() });
  let clock = Date.parse('2026-11-30T23:59:59.900Z');
  stubFetch({
    identitytoolkit: identityOk,
    generativelanguage: () => json(GEMINI_DAILY_QUOTA, 429),
    'modal.run': () => {
      clock += 200;
      return kimiCompletion();
    },
  });

  await handleAIExplanation(explainRequest(), env, { now: () => clock });

  // Recomputing the month per call settled against a ledger where the
  // reservation did not exist: the spend vanished and the reservation stayed.
  assert.deepEqual(env.KIMI_BUDGET_LEDGER.asked, ['2026-11', '2026-11']);
  assert.equal(env.KIMI_BUDGET_LEDGER.storeFor('2026-11').get('spentMicros'), 17_700);
  assert.equal(env.KIMI_BUDGET_LEDGER.storeFor('2026-11').get('reservedMicros'), 0);
  assert.equal(env.KIMI_BUDGET_LEDGER.storeFor('2026-12').size, 0);
});

test('a quota ledger that is merely unreachable is not «not configured»', async () => {
  installCache();
  stubFetch({ identitytoolkit: identityOk });

  const unreachable = envWith({
    REQUEST_QUOTA_LEDGER: {
      idFromName: name => name,
      get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    },
  });
  const missing = envWith({ REQUEST_QUOTA_LEDGER: undefined });

  // Transient: the reader gets a retry button instead of «not available yet».
  await assert.rejects(
    handleAIExplanation(explainRequest(), unreachable),
    error => error.code === 'AI_UNAVAILABLE' && error.status === 503,
  );
  await assert.rejects(
    handleAIExplanation(explainRequest(), missing),
    error => error.code === 'AI_NOT_CONFIGURED' && error.status === 503,
  );
});

test('Kimi as the primary provider does not reserve budget it cannot spend', async () => {
  installCache();
  const env = envWith({ AI_PROVIDER: 'modal-kimi', AI_FALLBACK_PROVIDER: '' });
  let clock = Date.parse('2026-08-23T10:00:00.000Z');
  const calls = stubFetch({
    identitytoolkit: () => {
      clock += 70_000;
      return identityOk();
    },
    'modal.run': kimiCompletion,
  });

  await assert.rejects(
    handleAIExplanation(explainRequest(), env, { now: () => clock }),
    error => error.code === 'AI_UNAVAILABLE',
  );

  assert.equal(calls.some(call => call.url.includes('modal.run')), false);
  assert.equal(env.KIMI_BUDGET_LEDGER.store.size, 0);
  assert.deepEqual(ledgerActions(env), ['reserve', 'release']);
});
