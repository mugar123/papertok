import type { InteractionProfile, StoredInteractionProfile } from '../utils/interaction-profile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveRollbacks, takeBacksOnProfile } from './save-rollback.ts';
import { markChanges } from './write-mark.ts';
import { markThenConfirm } from '../hooks/quick-save-operation.ts';
import {
  createEmptyInteractionProfile, curatedIds, deserializeInteractionProfile, readProfileSignals, recordInteractionEvent, serializeInteractionProfile,
} from '../utils/interaction-profile.ts';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// One paper's saved mark on the reading profile, as FeedContext keeps it:
// markSaved marks an unsaved paper, tells the profile of a save on a notable
// For You card and writes `saved: true`; unmarkSaved takes a saved paper's
// mark off, tells the profile of an unsave and writes `saved: false`. `load`
// is the account's profile arriving from storage, read from the stored
// aggregate unless `source` says it was rebuilt from the interaction
// documents: the saved papers become the ones it holds, and the take-backs
// hear of it, as applyInteractionProfile sets them. `signOut` clears the
// marks as FeedContext does when the account leaves.
function savedMarkOnProfile() {
  const marks = markChanges();
  const rollbacks = saveRollbacks();
  const account = { profile: createEmptyInteractionProfile(), saved: new Set<string>(), written: [] as string[] };
  const markSaved = (write: Promise<void>) => {
    if (account.saved.has('p1')) return Promise.resolve();
    rollbacks.marked('p1');
    account.saved = new Set(account.saved).add('p1');
    recordInteractionEvent(account.profile, { paperId: 'p1', kind: 'save', category: 'cs.LG', notable: true }, NOW);
    return write.then(() => { account.written.push('saved: true'); });
  };
  const unmarkSaved = async ({ rollback = false } = {}) => {
    if (!account.saved.has('p1')) return;
    if (!rollbacks.comesOff('p1', rollback)) return;
    account.saved = new Set([...account.saved].filter((id) => id !== 'p1'));
    recordInteractionEvent(account.profile, { paperId: 'p1', kind: 'unsave', category: 'cs.LG' }, NOW);
    account.written.push('saved: false');
  };
  const load = (stored: StoredInteractionProfile, source: { rebuilt: boolean; reusedRebuild?: boolean } = { rebuilt: false }) => {
    account.profile = deserializeInteractionProfile(stored)!;
    account.saved = new Set(curatedIds(account.profile, 'saved'));
    takeBacksOnProfile({ marks, saves: rollbacks }, 'u1', { liked: new Set(), read: new Set(), saved: account.saved }, source);
  };
  const signOut = () => {
    marks.screenReplaced();
    rollbacks.screenReplaced();
    account.profile = createEmptyInteractionProfile();
    account.saved = new Set();
  };
  return { account, markSaved, unmarkSaved, load, signOut };
}

// The profile and what it stores: whether the paper is saved, and the counts
// and lean its save added.
function savedIn(profile: InteractionProfile) {
  const stored = deserializeInteractionProfile(serializeInteractionProfile(profile))!;
  return [profile, stored].map((each) => ({
    saved: curatedIds(each, 'saved').includes('p1'),
    temporal: readProfileSignals(each, NOW).temporal,
  }));
}

function storedProfile({ saved }: { saved: boolean }) {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'p0', kind: 'save', category: 'cs.LG', notable: false }, NOW);
  if (saved) recordInteractionEvent(profile, { paperId: 'p1', kind: 'save', category: 'cs.LG', notable: true }, NOW);
  return profile;
}

// The quick save (useQuickSave): the saved-paper document is issued, the
// mark follows, then Read later and the lists. Any of them may be refused,
// and markThenConfirm then takes the mark back.
const refusals = ['the saved-paper document', 'the saved mark', 'Read later or a list'] as const;
function quickSave(paper: ReturnType<typeof savedMarkOnProfile>) {
  const writes = { document: deferred(), mark: deferred(), confirm: deferred() };
  const pressed = markThenConfirm({
    alreadySaved: paper.account.saved.has('p1'),
    issued: writes.document.promise,
    mark: () => paper.markSaved(writes.mark.promise),
    unmark: () => paper.unmarkSaved({ rollback: true }),
    confirm: () => writes.confirm.promise,
    onSaved: () => {},
  }).then(() => 'saved', () => 'refused');
  const refuse = (refused: typeof refusals[number]) => {
    const answer = (write: ReturnType<typeof deferred>, refusedHere: boolean) => {
      if (refusedHere) write.reject(new Error('permission-denied'));
      else write.resolve();
    };
    answer(writes.document, refused === 'the saved-paper document');
    answer(writes.mark, refused === 'the saved mark');
    answer(writes.confirm, refused === 'Read later or a list');
  };
  return { pressed, refuse, writes };
}

// The paper is saved in storage, from a notable For You card, and shows
// unsaved while the profile loads. A Save tapped then is refused once the
// profile has arrived: the stored save keeps its counts and lean, also once
// stored, and nothing writes `saved: false` over it.
for (const refused of refusals) {
  test(`a save tapped while the profile loads, on a paper saved in storage, refused at ${refused} once the profile arrived, keeps the stored save`, async () => {
    const stored = storedProfile({ saved: true });
    const paper = savedMarkOnProfile();
    const save = quickSave(paper);
    paper.load(serializeInteractionProfile(stored));
    save.refuse(refused);
    assert.equal(await save.pressed, 'refused');
    assert.equal(paper.account.saved.has('p1'), true);
    assert.deepEqual(savedIn(paper.account.profile), savedIn(stored));
    assert.equal(savedIn(paper.account.profile)[1].temporal.notable.engaged, 1);
    assert.equal(paper.account.written.includes('saved: false'), false);
  });

  // The neighbouring states: a paper storage does not hold saved stays
  // unsaved, with nothing taken from the counts, and a refusal that lands
  // before the profile still takes the mark back.
  test(`a save tapped while the profile loads, on a paper not saved in storage, refused at ${refused} once the profile arrived, leaves the loaded profile as stored`, async () => {
    const stored = storedProfile({ saved: false });
    const paper = savedMarkOnProfile();
    const save = quickSave(paper);
    paper.load(serializeInteractionProfile(stored));
    save.refuse(refused);
    assert.equal(await save.pressed, 'refused');
    assert.equal(paper.account.saved.has('p1'), false);
    assert.deepEqual(savedIn(paper.account.profile), savedIn(stored));
  });

  test(`a save refused at ${refused} before the profile arrived takes its mark back`, async () => {
    const paper = savedMarkOnProfile();
    const save = quickSave(paper);
    save.refuse(refused);
    assert.equal(await save.pressed, 'refused');
    assert.equal(paper.account.saved.has('p1'), false);
    assert.equal(savedIn(paper.account.profile)[1].saved, false);
  });
}

// The list picker's Undo of a first save made while the profile loaded, on a
// paper saved in storage: the paper was saved before, and stays so. The
// reader's own removal once the profile is in still takes the save off.
test('the picker\'s Undo of a save made while the profile loads keeps a paper saved in storage, and a removal still unsaves it', async () => {
  const stored = storedProfile({ saved: true });
  const paper = savedMarkOnProfile();
  await paper.markSaved(Promise.resolve());
  paper.load(serializeInteractionProfile(stored));
  await paper.unmarkSaved({ rollback: true });
  assert.equal(paper.account.saved.has('p1'), true);
  assert.deepEqual(savedIn(paper.account.profile), savedIn(stored));
  assert.deepEqual(paper.account.written, ['saved: true']);

  await paper.unmarkSaved();
  assert.equal(paper.account.saved.has('p1'), false);
  assert.equal(savedIn(paper.account.profile)[1].temporal.notable.engaged, 0);
});

// A profile rebuilt from the interaction documents may hold the save itself:
// the rebuild reads the saved mark this session wrote, accepted or still
// waiting. It cannot say whether the paper was saved before the tap, so a
// refusal takes the mark off, and `saved: false` matches the missing list.
const rebuilds = [
  ['rebuilt from the interaction documents', { rebuilt: true }],
  ['rebuilt earlier in the session', { rebuilt: false, reusedRebuild: true }],
] as const;
for (const [rebuiltLabel, source] of rebuilds) {
  for (const refused of refusals) {
    test(`a save tapped while the profile loads, refused at ${refused} once a profile ${rebuiltLabel} showing the save arrived, takes its mark back`, async () => {
      const paper = savedMarkOnProfile();
      const save = quickSave(paper);
      paper.load(serializeInteractionProfile(storedProfile({ saved: true })), source);
      save.refuse(refused);
      assert.equal(await save.pressed, 'refused');
      assert.equal(paper.account.saved.has('p1'), false);
      assert.equal(savedIn(paper.account.profile)[1].saved, false);
      assert.equal(paper.account.written.at(-1), 'saved: false');
    });
  }
}

// The saved mark is accepted and a rebuild reads it; Read later is refused
// after the profile arrives. The paper does not stay saved with no Read
// later and no list.
test('a save accepted before a rebuilt profile read it, whose Read later is refused, is taken back', async () => {
  const paper = savedMarkOnProfile();
  const save = quickSave(paper);
  save.writes.document.resolve();
  save.writes.mark.resolve();
  await new Promise((settled) => { setImmediate(settled); });
  assert.deepEqual(paper.account.written, ['saved: true']);
  paper.load(serializeInteractionProfile(storedProfile({ saved: true })), { rebuilt: true });
  save.writes.confirm.reject(new Error('permission-denied'));
  assert.equal(await save.pressed, 'refused');
  assert.equal(paper.account.saved.has('p1'), false);
  assert.deepEqual(paper.account.written, ['saved: true', 'saved: false']);
});

// The save still waits when the reader signs out and back in. Signing out
// stored the profile with the save in it, so the profile that then arrives
// holds the save: a refusal still takes the mark back.
for (const refused of refusals) {
  test(`a save still waiting across a sign-out and back in, refused at ${refused} once the profile arrives holding it, takes its mark back`, async () => {
    const paper = savedMarkOnProfile();
    paper.load(serializeInteractionProfile(storedProfile({ saved: false })));
    const save = quickSave(paper);
    paper.signOut();
    paper.load(serializeInteractionProfile(storedProfile({ saved: true })));
    save.refuse(refused);
    assert.equal(await save.pressed, 'refused');
    assert.equal(paper.account.saved.has('p1'), false);
    assert.equal(savedIn(paper.account.profile)[1].saved, false);
    assert.equal(paper.account.written.at(-1), 'saved: false');
  });
}

// A save tapped once the reader has signed back in, while that profile
// loads, is a new mark: the profile that arrives says what storage held.
test('a save tapped after signing back in, while the profile loads, on a paper saved in storage, keeps the stored save when refused', async () => {
  const stored = storedProfile({ saved: true });
  const paper = savedMarkOnProfile();
  paper.load(serializeInteractionProfile(storedProfile({ saved: false })));
  paper.signOut();
  const save = quickSave(paper);
  paper.load(serializeInteractionProfile(stored));
  save.refuse('Read later or a list');
  assert.equal(await save.pressed, 'refused');
  assert.equal(paper.account.saved.has('p1'), true);
  assert.deepEqual(savedIn(paper.account.profile), savedIn(stored));
  assert.equal(paper.account.written.includes('saved: false'), false);
});
