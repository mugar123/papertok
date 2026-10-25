import test from 'node:test';
import assert from 'node:assert/strict';
import { markThenConfirm, runOneAtATime, unmarkThenConfirm, writeSaveDestinations } from './quick-save-operation.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('taps on a paper while its operation runs are dropped, and the paper is free once it settles', async () => {
  const inFlight = new Set<string>();
  const write = deferred();
  let started = 0;
  const tap = () => runOneAtATime(inFlight, '2401.00001', () => { started += 1; return write.promise; });

  const taps = [tap(), tap(), tap()];
  assert.equal(started, 1, 'no second chain of writes');
  write.resolve();
  await Promise.all(taps);
  await runOneAtATime(inFlight, '2401.00001', async () => { started += 1; });
  assert.equal(started, 2);
});

test('a refused operation frees the paper too, and another paper never waits on it', async () => {
  const inFlight = new Set<string>();
  const write = deferred();
  const first = runOneAtATime(inFlight, 'a', () => write.promise);
  let other = 0;
  await runOneAtATime(inFlight, 'b', async () => { other += 1; });
  assert.equal(other, 1);
  write.reject(new Error('permission-denied'));
  await assert.rejects(first, /permission-denied/);
  assert.equal(inFlight.size, 0);
});

function save({ alreadySaved = false } = {}) {
  const calls: string[] = [];
  const document = deferred();
  const pending = markThenConfirm({
    alreadySaved,
    issued: document.promise,
    mark: async () => { calls.push('mark'); },
    unmark: async () => { calls.push('unmark'); },
    confirm: async () => { calls.push('confirm'); },
    onSaved: () => { calls.push('saved'); },
  });
  return { calls, document, pending };
}

test('a save fills the button before Firestore answers', async () => {
  const s = save();
  assert.deepEqual(s.calls, ['mark']);
  s.document.resolve();
  await s.pending;
  assert.deepEqual(s.calls, ['mark', 'confirm', 'saved']);
});

test('a refused save puts the button back and reports the refusal', async () => {
  const s = save();
  s.document.reject(new Error('permission-denied'));
  await assert.rejects(s.pending, /permission-denied/);
  assert.deepEqual(s.calls, ['mark', 'unmark']);
});

test('a refused Undo on a paper saved again by hand leaves that save alone', async () => {
  const s = save({ alreadySaved: true });
  s.document.reject(new Error('unavailable'));
  await assert.rejects(s.pending, /unavailable/);
  assert.deepEqual(s.calls, ['mark']);
});

test('a confirmed new save reports once after both writes, while a refused confirmation reports nothing', async () => {
  const document = deferred();
  const membership = deferred();
  const events: string[] = [];
  const pending = markThenConfirm({
    alreadySaved: false,
    issued: document.promise,
    mark: async () => {},
    unmark: async () => {},
    confirm: () => membership.promise,
    onSaved: () => { events.push('saved'); },
  });
  assert.deepEqual(events, []);
  document.resolve();
  await Promise.resolve();
  assert.deepEqual(events, []);
  membership.resolve();
  await pending;
  assert.deepEqual(events, ['saved']);

  const refusedEvents: string[] = [];
  await assert.rejects(markThenConfirm({
    alreadySaved: false,
    issued: null,
    mark: async () => {},
    unmark: async () => {},
    confirm: async () => { throw new Error('permission-denied'); },
    onSaved: () => { refusedEvents.push('saved'); },
  }), /permission-denied/);
  assert.deepEqual(refusedEvents, []);
});

test('restoring an already saved paper does not report another save', async () => {
  const events: string[] = [];
  await markThenConfirm({
    alreadySaved: true,
    issued: null,
    mark: async () => {},
    unmark: async () => {},
    confirm: async () => {},
    onSaved: () => { events.push('saved'); },
  });
  assert.deepEqual(events, []);
});

test('a save waits for its interaction write and never reports a refused saved mark', async () => {
  const interaction = deferred();
  const events: string[] = [];
  const pending = markThenConfirm({
    alreadySaved: false,
    issued: Promise.resolve(),
    mark: () => interaction.promise,
    unmark: async () => { events.push('unmarked'); },
    confirm: async () => {},
    onSaved: () => { events.push('saved'); },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, []);
  interaction.resolve();
  await pending;
  assert.deepEqual(events, ['saved']);

  const refusedEvents: string[] = [];
  const refusal = new Error('interaction-write-refused');
  const refused = Promise.reject(refusal);
  void refused.catch(() => {});
  await assert.rejects(markThenConfirm({
    alreadySaved: false,
    issued: Promise.resolve(),
    mark: () => refused,
    unmark: async () => { refusedEvents.push('unmarked'); },
    confirm: async () => {},
    onSaved: () => { refusedEvents.push('saved'); },
  }), error => error === refusal);
  assert.deepEqual(refusedEvents, ['unmarked']);
});

test('removal waits for the saved-state write even when no list holds the paper', async () => {
  const interaction = deferred();
  const events: string[] = [];
  const pending = unmarkThenConfirm({
    unmark: () => interaction.promise,
    confirm: async () => { events.push('confirmed'); return true; },
    restore: async () => { events.push('restored'); },
    onRemoved: () => { events.push('removed'); },
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  interaction.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(events, ['confirmed', 'removed']);
});

test('a refused saved-state write restores the mark and never reports removal', async () => {
  const events: string[] = [];
  const refusal = new Error('permission-denied');
  const interaction = Promise.reject(refusal);
  void interaction.catch(() => {});
  await assert.rejects(unmarkThenConfirm({
    unmark: () => interaction,
    confirm: async () => true,
    restore: async () => { events.push('restored'); },
    onRemoved: () => { events.push('removed'); },
  }), error => error === refusal);
  assert.deepEqual(events, ['restored']);
});

test('a refused Read later write or incomplete list lookup does not report removal', async () => {
  for (const incomplete of [false, true]) {
    const events: string[] = [];
    const pending = unmarkThenConfirm({
      unmark: async () => {},
      confirm: async () => {
        if (incomplete) return null;
        throw new Error('read-later-write-refused');
      },
      restore: async () => { events.push('restored'); },
      onRemoved: () => { events.push('removed'); },
    });
    if (incomplete) assert.equal(await pending, null);
    else await assert.rejects(pending, /read-later-write-refused/);
    assert.deepEqual(events, ['restored']);
  }
});

test('a refused Read later write leaves persisted list memberships intact for removal and Undo', async () => {
  for (const removing of [false, true]) {
    const lists = new Set(removing ? ['reading'] : []);
    await assert.rejects(writeSaveDestinations({
      previousReadLater: removing,
      nextReadLater: !removing,
      writeReadLater: async () => { throw new Error('read-later-refused'); },
      writeLists: async () => {
        if (removing) lists.delete('reading');
        else lists.add('reading');
      },
    }), /read-later-refused/);
    assert.deepEqual([...lists], removing ? ['reading'] : []);
  }
});

test('a refused list batch restores the previous persisted Read later value for removal and Undo', async () => {
  for (const previousReadLater of [false, true]) {
    let readLater = previousReadLater;
    await assert.rejects(writeSaveDestinations({
      previousReadLater,
      nextReadLater: !previousReadLater,
      writeReadLater: async value => { readLater = value; },
      writeLists: async () => { throw new Error('membership-refused'); },
    }), /membership-refused/);
    assert.equal(readLater, previousReadLater);
  }
});
