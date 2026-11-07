import test from 'node:test';
import assert from 'node:assert/strict';
import { startReaderTime } from './reader-time.ts';

function harness() {
  let clock = 1_000;
  let hidden = false;
  let listener: (() => void) | null = null;
  let context = 'enabled#0#0|A';
  const sent: number[] = [];
  const guards: (() => boolean)[] = [];
  const session = startReaderTime({
    now: () => clock,
    visibility: { hidden: () => hidden, subscribe: next => { listener = next; return () => { listener = null; }; } },
    context: () => context,
    send: (seconds, stillValid) => { sent.push(seconds); guards.push(stillValid); },
  });
  return {
    session,
    sent,
    guards,
    setContext: (next: string) => { context = next; },
    advance: (ms: number) => { clock += ms; },
    setHidden: (next: boolean) => { hidden = next; listener?.(); },
  };
}

test('an unchanged reading session sends its visible time once, leaving out a hidden tab', () => {
  const { session, sent, guards, advance, setHidden } = harness();
  advance(10_000);
  setHidden(true);
  advance(60_000);
  setHidden(false);
  advance(5_000);
  session.stop();
  session.stop();
  assert.deepEqual(sent, [15]);
  assert.equal(guards[0]?.(), true);
});

test('analytics turned off and on again before the reader closes sends no time from before', () => {
  const { session, sent, advance, setContext } = harness();
  advance(30_000);
  setContext('denied#1#1|A');
  session.check();
  advance(20_000);
  setContext('enabled#2#2|A');
  session.check();
  session.stop();
  assert.deepEqual(sent, []);
});

test('signing out and back into the same account while reading sends nothing', () => {
  const { session, sent, advance, setContext } = harness();
  advance(30_000);
  setContext('enabled#0#0|');
  session.check();
  setContext('enabled#0#0|A');
  session.check();
  session.stop();
  assert.deepEqual(sent, []);
});

test('a session opened under account A sends nothing once account B is signed in', () => {
  const { session, sent, advance, setContext } = harness();
  advance(30_000);
  setContext('enabled#0#0|B');
  session.stop();
  assert.deepEqual(sent, []);
});

test('a send still waiting for the SDK is dropped once the account changes', () => {
  const { session, guards, advance, setContext } = harness();
  advance(10_000);
  session.stop();
  setContext('enabled#0#0|B');
  assert.equal(guards[0]?.(), false);
  setContext('enabled#0#0|A');
  assert.equal(guards[0]?.(), false, 'the stale send stays dropped when account A comes back');
});
