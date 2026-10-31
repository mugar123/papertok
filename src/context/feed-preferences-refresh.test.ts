import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { planPreferencesRefresh, scheduleRefresh } from './feed-preferences-refresh.ts';

const reader = { signature: 'cs.LG', ready: true, onFeedRoute: true, restored: false };

test.afterEach(() => mock.timers.reset());

test('an unapplied cold mount with interests plans a cold load for the current interests', () => {
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null }), { action: 'load', coldMount: true });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.AI|cs.LG', signature: 'cs.AI|cs.LG' }), { action: 'none' });
});

test('a first load cleaned up before its timer fired is planned and scheduled again, and applied once it runs', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const applied = { current: null as string | null };
  const loads: string[] = [];
  const effect = (signature: string) => {
    const plan = planPreferencesRefresh({ ...reader, signature, applied: applied.current });
    return plan.action === 'load' ? scheduleRefresh(applied, signature, () => loads.push(signature)) : null;
  };

  // The interests effect schedules the first page; a render before the 0 ms
  // timer fires (the account profile applying) runs its cleanup.
  const cleanup = effect('cs.LG');
  assert.ok(cleanup);
  cleanup();
  mock.timers.tick(0);
  assert.equal(applied.current, null);
  assert.deepEqual(loads, []);

  // The re-run, with the newest interests, still has a load to make.
  assert.ok(effect('cs.AI|cs.LG'));
  mock.timers.tick(0);
  assert.equal(applied.current, 'cs.AI|cs.LG');
  assert.deepEqual(loads, ['cs.AI|cs.LG']);
  assert.equal(effect('cs.AI|cs.LG'), null);
});

test('a cold start over the restored snapshot of these interests keeps it; changed interests replace the feed', () => {
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null, restored: true }), { action: 'keep-restored' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', signature: 'cs.AI', restored: true }), { action: 'load', coldMount: false });
});

test('no profile or no interests forgets what was applied; off the feed nothing is planned', () => {
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', ready: false }), { action: 'forget' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', signature: '' }), { action: 'forget' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null, onFeedRoute: false }), { action: 'none' });
});
