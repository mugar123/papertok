import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeProductEventParams } from '../services/analytics-service.ts';
import {
  forgetPmfSurveyAsked,
  pmfSurveyDue,
  pmfSurveyParams,
  recordPmfSurveyDay,
  recordPmfSurveyPaper,
  recordPmfSurveyShown,
} from './pmf-survey.ts';
import { clearUserScopedStorage, saveSeenPaperIds } from './user-scoped-storage.ts';

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

type Storage = ReturnType<typeof createStorage>;

const papers = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `W${from + index}`);

/** The account opened PaperTok on each of these local days, running `version`. */
function openOn(uid: string, days: string[], storage: Storage, version = '0.3.0') {
  for (const day of days) recordPmfSurveyDay(uid, new Date(`${day}T10:00:00`), version, storage);
}

/** Each paper stayed on the signed-in account's screen for at least a second. */
function dwellOn(uid: string, paperIds: string[], storage: Storage) {
  for (const paperId of paperIds) recordPmfSurveyPaper({ paperId, viewerId: uid, signedInUid: uid }, storage);
}

const noTrack = () => Promise.resolve(true);

/** The survey opened for the account and was answered or closed. */
function showSurvey(uid: string, version: string, storage: Storage) {
  recordPmfSurveyShown({ uid, surveyOpen: true, version, storage, track: noTrack })?.close();
}

test('a reader is asked once PaperTok was opened on three different days, not before', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'two days');
  openOn('reader', ['2026-11-19'], storage);
  recordPmfSurveyDay('reader', new Date('2026-11-19T23:30:00'), '0.3.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'the same day again is still two days');
  openOn('reader', ['2026-11-21'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'three days');
});

test('the first time, days opened on an earlier version count too', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19'], storage, '0.3.0');
  openOn('reader', ['2026-11-25'], storage, '0.4.0');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), true);
});

test('twenty papers kept on screen for a second qualify a reader on the first day, each paper once', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18'], storage);
  dwellOn('reader', papers(19), storage);
  dwellOn('reader', papers(19), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'nineteen papers, each on screen twice');
  dwellOn('reader', ['W20'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'twenty papers');
});

test('papers swiped past or passed over by a load, which the viewed list holds, do not count', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18'], storage);
  saveSeenPaperIds('reader', papers(40), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false);
});

test('a card that reports after its account signed out, or for another account, counts nothing', () => {
  const storage = createStorage();
  dwellOn('reader-a', papers(19), storage);
  clearUserScopedStorage('reader-a', storage);
  recordPmfSurveyPaper({ paperId: 'W20', viewerId: 'reader-a', signedInUid: undefined }, storage);
  recordPmfSurveyPaper({ paperId: 'W21', viewerId: 'reader-a', signedInUid: 'reader-b' }, storage);
  recordPmfSurveyPaper({ paperId: 'W22', viewerId: undefined, signedInUid: undefined }, storage);

  dwellOn('reader-a', papers(19, 100), storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), false, 'nineteen papers since signing in again');
  dwellOn('reader-b', papers(19, 100), storage);
  assert.equal(pmfSurveyDue('reader-b', '0.3.0', storage), false, 'the other account got none of them');
});

test('a reader asked for a version is asked again after two days opened on a later one', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  dwellOn('reader', papers(20), storage);
  showSurvey('reader', '0.3.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'asked for this version');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), false, 'days and papers from before the new version do not count');

  openOn('reader', ['2026-11-25'], storage, '0.4.0');
  openOn('reader', ['2026-11-25'], storage, '0.4.0');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), false, 'one day on the new version');
  openOn('reader', ['2026-11-27'], storage, '0.4.0');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), true, 'two days on the new version');

  showSurvey('reader', '0.4.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), false);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'a tab still on the previous release does not ask again');
});

test('a day opened on two versions counts for the later one, whichever tab writes last', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  showSurvey('reader', '0.3.0', storage);

  openOn('reader', ['2026-11-25'], storage, '0.3.0');
  openOn('reader', ['2026-11-25'], storage, '0.4.0');
  openOn('reader', ['2026-11-26'], storage, '0.4.0');
  openOn('reader', ['2026-11-26'], storage, '0.3.0');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), true);
});

test('versions compare as numbers, and a later version asked settles an earlier one', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage, '0.10.0');
  showSurvey('reader', '0.10.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.9.0', storage), false);
  showSurvey('reader', '0.9.0', storage);
  openOn('reader', ['2026-11-21', '2026-11-22'], storage, '0.10.0');
  assert.equal(pmfSurveyDue('reader', '0.10.0', storage), false, 'an older tab opening it later does not undo 0.10.0');

  openOn('other', ['2026-11-18', '2026-11-19', '2026-11-20'], storage, '0.4.0-rc.1');
  showSurvey('other', '0.4.0-rc.1', storage);
  assert.equal(pmfSurveyDue('other', '0.4.0-rc.1', storage), false, 'a version that is not only numbers settles itself');
});

test('signing out sweeps the use but keeps the version asked; deleting the account forgets it', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  showSurvey('reader', '0.3.0', storage);

  clearUserScopedStorage('reader', storage);
  openOn('reader', ['2026-11-21', '2026-11-22', '2026-11-23'], storage);
  dwellOn('reader', papers(20), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'signed in again, not asked twice for 0.3.0');

  openOn('reader', ['2026-11-24'], storage, '0.4.0');
  clearUserScopedStorage('reader', storage);
  openOn('reader', ['2026-11-25'], storage, '0.4.0');
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), false, 'the days on 0.4.0 count from the sign-in');

  forgetPmfSurveyAsked('reader', storage);
  openOn('reader', ['2026-11-26', '2026-11-27'], storage, '0.4.0');
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'forgotten, the first-time rule applies');
});

test('each account counts its own days and papers and keeps its own version asked', () => {
  const storage = createStorage();
  openOn('reader-a', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  dwellOn('reader-b', papers(5), storage);
  showSurvey('reader-c', '0.3.0', storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), true);
  assert.equal(pmfSurveyDue('reader-b', '0.3.0', storage), false, 'another account has used it too little');

  clearUserScopedStorage('reader-a', storage);
  forgetPmfSurveyAsked('reader-a', storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), false, 'the days start again from nothing');
  dwellOn('reader-b', papers(20), storage);
  assert.equal(pmfSurveyDue('reader-b', '0.3.0', storage), true, 'the other account keeps its record');
  openOn('reader-c', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  assert.equal(pmfSurveyDue('reader-c', '0.3.0', storage), false, 'and its version asked');
});

test('nobody is asked without an account, with storage blocked or from a garbled record', () => {
  const storage = createStorage();
  assert.equal(pmfSurveyDue(null, '0.3.0', storage), false);
  assert.equal(pmfSurveyDue('reader', '0.3.0', null), false);

  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  assert.doesNotThrow(() => recordPmfSurveyDay('reader', new Date(), '0.3.0', blocked));
  assert.doesNotThrow(() => recordPmfSurveyPaper({ paperId: 'W1', viewerId: 'reader', signedInUid: 'reader' }, blocked));
  assert.doesNotThrow(() => recordPmfSurveyShown({ uid: 'reader', surveyOpen: true, version: '0.3.0', storage: blocked, track: noTrack }));
  assert.doesNotThrow(() => forgetPmfSurveyAsked('reader', blocked));
  assert.equal(pmfSurveyDue('reader', '0.3.0', blocked), false);

  storage.setItem('papertok_pmfSurvey:reader', '{"days":');
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'the count starts over and goes on');

  storage.setItem('papertok_pmfSurvey:other', JSON.stringify({ days: ['2026-11-18', { day: '2026-11-19' }, null], papers: [1, null] }));
  dwellOn('other', papers(19), storage);
  assert.equal(pmfSurveyDue('other', '0.3.0', storage), false, 'entries of the wrong shape count for nothing');
});

test('opening the survey settles its version and sends one shown event, and nothing before it opens', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  const sent: unknown[] = [];
  const track = (eventName: string, params: Record<string, unknown>) => {
    sent.push([eventName, params]);
    return Promise.resolve(true);
  };

  assert.equal(recordPmfSurveyShown({ uid: 'reader', surveyOpen: false, version: '0.3.0', storage, track }), null);
  assert.equal(recordPmfSurveyShown({ uid: null, surveyOpen: true, version: '0.3.0', storage, track }), null);
  assert.deepEqual(sent, []);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'still due');

  recordPmfSurveyShown({ uid: 'reader', surveyOpen: true, version: '0.3.0', storage, track });
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false);
  assert.deepEqual(sent, [['pmf_survey_shown', { app_version: '0.3.0' }]]);
});

test('an opened survey sends its answer once, and a close nobody answered as a dismissal', () => {
  const sent: unknown[] = [];
  const track = (eventName: string, params: Record<string, unknown>) => {
    sent.push([eventName, params]);
    return Promise.resolve(true);
  };
  const open = () => recordPmfSurveyShown({ uid: 'reader', surveyOpen: true, version: '0.3.0', storage: createStorage(), track });

  const answered = open();
  answered?.answer({ disappointment: 'very', nps: 9 });
  answered?.answer('dismissed');
  answered?.close();
  const left = open();
  left?.close();
  left?.close();

  assert.deepEqual(sent, [
    ['pmf_survey_shown', { app_version: '0.3.0' }],
    ['pmf_survey', { disappointment: 'very', nps: 9, app_version: '0.3.0' }],
    ['pmf_survey_shown', { app_version: '0.3.0' }],
    ['pmf_survey', { disappointment: 'dismissed', app_version: '0.3.0' }],
  ]);
});

test('an answer reaches analytics as fixed labels, the score and the version, and nothing else', () => {
  const sent = (params: Record<string, unknown>) => sanitizeProductEventParams('pmf_survey', params, 'enabled');

  assert.deepEqual(sent(pmfSurveyParams({ disappointment: 'very', nps: 9 }, '0.4.0')), { disappointment: 'very', nps: 9, app_version: '0.4.0' });
  assert.deepEqual(sent(pmfSurveyParams({ disappointment: 'not', nps: 0 }, '0.4.0')), { disappointment: 'not', nps: 0, app_version: '0.4.0' });
  assert.deepEqual(sent(pmfSurveyParams({ disappointment: 'somewhat', nps: null }, '0.4.0')), { disappointment: 'somewhat', app_version: '0.4.0' }, 'a skipped score is absent');
  assert.deepEqual(sent(pmfSurveyParams('dismissed', '0.4.0')), { disappointment: 'dismissed', app_version: '0.4.0' });

  assert.deepEqual(sent({
    disappointment: 'furious',
    nps: 11,
    app_version: '3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49',
    activation_age: 'days_7_13',
    comment: 'I would miss the feed',
    uid: 'reader-a',
  }), { activation_age: 'days_7_13' }, 'an unknown label, a score out of range, a commit hash, text and an identifier are dropped');
  for (const nps of [-1, 7.5, '7', Number.NaN]) {
    assert.equal(Object.hasOwn(sent({ disappointment: 'very', nps }), 'nps'), false, String(nps));
  }
});

test('the survey opening reaches analytics as the version and the activation age only', () => {
  assert.deepEqual(
    sanitizeProductEventParams('pmf_survey_shown', { app_version: '0.3.0', activation_age: 'day_1', disappointment: 'very', nps: 5 }, 'enabled'),
    { app_version: '0.3.0', activation_age: 'day_1' },
  );
});
