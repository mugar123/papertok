import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KimiBudgetLedger,
  RESERVATION_TTL_MS,
  calculateKimiUsageMicros,
  estimateKimiReservationMicros,
  getMonthlyBudgetReset,
  microsToUsd,
  usdToMicros,
} from './kimi-budget-ledger.js';

/** The Durable Object over in-memory storage, `list` included. */
function ledgerHarness(seed = {}) {
  const store = new Map(Object.entries(seed));
  const transaction = {
    get: async key => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => new Map(
      [...store].filter(([key]) => String(key).startsWith(prefix)),
    ),
  };
  const ledger = new KimiBudgetLedger({ storage: { transaction: run => run(transaction) } });
  return {
    store,
    call: payload => ledger
      .fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify(payload) }))
      .then(response => response.json()),
  };
}

test('reserves a conservative Kimi maximum before sending a request', () => {
  assert.equal(estimateKimiReservationMicros({
    promptBytes: 10_000,
    maxOutputTokens: 4_000,
    promptUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  }), 153_072);
});

test('prices cached, completion and reasoning tokens conservatively', () => {
  const costMicros = calculateKimiUsageMicros({
    prompt_tokens: 1_000,
    prompt_tokens_details: { cached_tokens: 200 },
    completion_tokens: 500,
    completion_tokens_details: { reasoning_tokens: 200 },
  });
  assert.equal(costMicros, 12_960);
  assert.equal(microsToUsd(costMicros), 0.01296);
});

test('converts dollar caps without losing sub-cent precision', () => {
  assert.equal(usdToMicros(27), 27_000_000);
  assert.equal(microsToUsd(27_000_000), 27);
});

test('resets the Kimi safety budget at the next UTC month', () => {
  assert.deepEqual(getMonthlyBudgetReset(Date.parse('2026-07-28T12:00:00.000Z')), {
    resetAt: '2026-08-01T00:00:00.000Z',
    retryAfterSeconds: 302_400,
  });
});

test('an expired reservation stops shrinking the monthly cap', async () => {
  const harness = ledgerHarness({
    reservedMicros: 150_000,
    'reservation:orphan': { amountMicros: 150_000, expiresAt: Date.now() - 1 },
  });

  // The invocation that opened `reservation:orphan` died between reserve and
  // settle, so nothing was ever going to delete it. Without the sweep this
  // reservation would not fit and the fallback would stay dead all month.
  const result = await harness.call({
    action: 'reserve',
    reservationId: 'fresh',
    amountMicros: 150_000,
    hardCapMicros: 200_000,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reservedMicros, 150_000);
  assert.equal(harness.store.get('reservedMicros'), 150_000);
  assert.equal(harness.store.has('reservation:orphan'), false);
});

test('a reservation still in flight is left alone', async () => {
  const harness = ledgerHarness({
    reservedMicros: 150_000,
    'reservation:live': { amountMicros: 150_000, expiresAt: Date.now() + RESERVATION_TTL_MS },
  });

  const result = await harness.call({
    action: 'reserve',
    reservationId: 'second',
    amountMicros: 150_000,
    hardCapMicros: 27_000_000,
  });

  assert.equal(result.reservedMicros, 300_000);
  assert.equal(harness.store.has('reservation:live'), true);
});

test('a reservation written before expiries existed is dated, not dropped', async () => {
  const harness = ledgerHarness({ reservedMicros: 150_000, 'reservation:legacy': 150_000 });

  const result = await harness.call({
    action: 'reserve',
    reservationId: 'fresh',
    amountMicros: 150_000,
    hardCapMicros: 27_000_000,
  });

  // Dropping it on sight would cancel a reservation that may still be in flight
  // during the deploy that introduced expiries.
  assert.equal(result.reservedMicros, 300_000);
  assert.ok(harness.store.get('reservation:legacy').expiresAt > Date.now());
  assert.equal(harness.store.get('reservation:legacy').amountMicros, 150_000);
});

test('settle understands both reservation shapes', async () => {
  const legacy = ledgerHarness({ reservedMicros: 150_000, 'reservation:legacy': 150_000 });
  const dated = ledgerHarness({
    reservedMicros: 150_000,
    'reservation:dated': { amountMicros: 150_000, expiresAt: Date.now() + RESERVATION_TTL_MS },
  });

  assert.deepEqual(await legacy.call({ action: 'settle', reservationId: 'legacy', chargedMicros: 17_700 }), {
    settled: true, spentMicros: 17_700, reservedMicros: 0, chargedMicros: 17_700,
  });
  assert.deepEqual(await dated.call({ action: 'settle', reservationId: 'dated', chargedMicros: 0 }), {
    settled: true, spentMicros: 0, reservedMicros: 0, chargedMicros: 0,
  });
});
