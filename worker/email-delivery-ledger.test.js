import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailDeliveryLedger } from './email-delivery-ledger.js';

class MemoryDurableObjectStorage {
  constructor() {
    this.values = new Map();
    this.queue = Promise.resolve();
    this.alarmAt = null;
  }

  transaction(operation) {
    const run = this.queue.then(() => operation({
      get: async key => this.values.get(key),
      put: async (key, value) => { this.values.set(key, value); },
      delete: async (key) => { this.values.delete(key); },
    }));
    this.queue = run.catch(() => {});
    return run;
  }

  async setAlarm(timestamp) {
    this.alarmAt = timestamp;
  }

  async deleteAll() {
    this.values.clear();
    this.alarmAt = null;
  }
}

async function callLedger(ledger, payload) {
  const response = await ledger.fetch(new Request('https://papertok.internal/email-delivery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

function deliveryDraft(id = 'paper') {
  return {
    provider: 'brevo',
    recipient: { email: 'reader@example.com', displayName: 'Reader' },
    content: { subject: 'PaperTok digest', html: `<p>${id}</p>`, text: id },
    unsubscribeUrl: 'https://example.com/unsubscribe',
    delivery: {
      sentAt: '2026-08-09T07:00:00.000Z',
      paperCount: 1,
      paperKeys: [`id:${id}`],
    },
  };
}

test('serializes concurrent reservations against the daily delivery limit', async () => {
  const ledger = new EmailDeliveryLedger({ storage: new MemoryDurableObjectStorage() });
  const [first, second] = await Promise.all([
    callLedger(ledger, { action: 'reserve', reservationId: 'digest:user-a', limit: 1 }),
    callLedger(ledger, { action: 'reserve', reservationId: 'digest:user-b', limit: 1 }),
  ]);

  assert.equal([first.body.accepted, second.body.accepted].filter(Boolean).length, 1);
  assert.equal([first.body.accepted, second.body.accepted].filter(value => !value).length, 1);
  assert.equal(Math.max(first.body.reserved, second.body.reserved), 1);
});

test('returns duplicate reservations without consuming quota or committing twice', async () => {
  const ledger = new EmailDeliveryLedger({ storage: new MemoryDurableObjectStorage() });
  const reserved = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
  });
  const duplicatePending = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
  });
  const committed = await callLedger(ledger, {
    action: 'commit',
    reservationId: 'digest:user-a',
    delivery: {
      sentAt: '2026-08-09T07:00:00.000Z',
      paperCount: 1,
      paperKeys: ['doi:10.1/paper'],
    },
  });
  const duplicateCommitted = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
  });
  const secondCommit = await callLedger(ledger, {
    action: 'commit',
    reservationId: 'digest:user-a',
    delivery: { sentAt: '2026-08-09T08:00:00.000Z', paperCount: 2 },
  });

  assert.equal(reserved.body.duplicate, false);
  assert.equal(duplicatePending.body.duplicate, true);
  assert.equal(duplicatePending.body.status, 'reserved');
  assert.equal(committed.body.committedCount, 1);
  assert.equal(duplicateCommitted.body.duplicate, true);
  assert.equal(duplicateCommitted.body.status, 'committed');
  assert.deepEqual(duplicateCommitted.body.delivery.paperKeys, ['doi:10.1/paper']);
  assert.equal(secondCommit.body.duplicate, true);
  assert.equal(secondCommit.body.committedCount, 1);
});

test('allows one bounded retry for a pending reservation inside the provider idempotency window', async () => {
  const ledger = new EmailDeliveryLedger({ storage: new MemoryDurableObjectStorage() });
  const first = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
    now: '2026-08-09T07:00:00.000Z',
    retryMinAgeMs: 15 * 60 * 1000,
    retryWindowMs: 25 * 60 * 1000,
    draft: deliveryDraft(),
  });
  const retry = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
    now: '2026-08-09T07:20:00.000Z',
    retryMinAgeMs: 15 * 60 * 1000,
    retryWindowMs: 25 * 60 * 1000,
  });
  const thirdAttempt = await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
    now: '2026-08-09T07:21:00.000Z',
    retryMinAgeMs: 15 * 60 * 1000,
    retryWindowMs: 25 * 60 * 1000,
  });

  assert.equal(first.body.duplicate, false);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.retry, true);
  assert.equal(retry.body.attempts, 2);
  assert.equal(thirdAttempt.body.retry, false);
  assert.equal(thirdAttempt.body.attempts, 2);
  assert.equal(thirdAttempt.body.reserved, 1);
});

test('stores high-volume reservations in separate values below the Durable Object value limit', async () => {
  const storage = new MemoryDurableObjectStorage();
  const ledger = new EmailDeliveryLedger({ storage });
  const longKeys = Array.from({ length: 30 }, (_, index) => `work:${index}:${'x'.repeat(240)}`);

  for (let index = 0; index < 290; index += 1) {
    const reservationId = `digest-${String(index).padStart(3, '0')}`;
    const reserved = await callLedger(ledger, {
      action: 'reserve',
      reservationId,
      limit: 290,
      draft: deliveryDraft(reservationId),
    });
    assert.equal(reserved.body.accepted, true);
    const committed = await callLedger(ledger, {
      action: 'commit',
      reservationId,
      delivery: {
        sentAt: '2026-08-09T07:00:00.000Z',
        paperCount: 10,
        paperKeys: longKeys,
      },
    });
    assert.equal(committed.body.committed, true);
  }

  const sizes = [...storage.values.values()].map(value => (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
  ));
  assert.equal(storage.values.has('ledger'), false);
  assert.equal(storage.values.get('meta').committed, 290);
  assert.equal(storage.values.size, 291);
  assert.equal(Math.max(...sizes) < 2 * 1024 * 1024, true);
});

test('deletes the daily ledger after its retention alarm', async () => {
  const storage = new MemoryDurableObjectStorage();
  const ledger = new EmailDeliveryLedger({ storage });
  await callLedger(ledger, {
    action: 'reserve',
    reservationId: 'digest:user-a',
    limit: 2,
    draft: deliveryDraft(),
  });

  assert.equal(storage.values.size > 0, true);
  assert.equal(Number.isFinite(storage.alarmAt), true);
  await ledger.alarm();
  assert.equal(storage.values.size, 0);
});
