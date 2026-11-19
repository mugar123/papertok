import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeProductEventParams } from '../services/analytics-service.ts';
import { pmfSurveyDue, pmfSurveyParams, recordPmfSurveyDay, rememberPmfSurveyAsked } from './pmf-survey.ts';
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

const papers = (count: number) => Array.from({ length: count }, (_, index) => `W${index + 1}`);

/** The account opened PaperTok on each of these local days. */
function openOn(uid: string, days: string[], storage: ReturnType<typeof createStorage>) {
  for (const day of days) recordPmfSurveyDay(uid, new Date(`${day}T10:00:00`), storage);
}

test('a reader is asked once PaperTok was opened on three different days, not before', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18', '2026-11-19'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'two days');
  openOn('reader', ['2026-11-19'], storage);
  recordPmfSurveyDay('reader', new Date('2026-11-19T23:30:00'), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'the same day again is still two days');
  openOn('reader', ['2026-11-21'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'three days');
});

test('twenty papers viewed on their cards qualify a reader on the first day', () => {
  const storage = createStorage();
  openOn('reader', ['2026-11-18'], storage);
  saveSeenPaperIds('reader', papers(19), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'nineteen papers');
  saveSeenPaperIds('reader', papers(20), storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'twenty papers');
});

test('a reader shown the survey for a version is asked again only for a later one', () => {
  const storage = createStorage();
  saveSeenPaperIds('reader', papers(40), storage);
  rememberPmfSurveyAsked('reader', '0.3.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false);
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), true);

  rememberPmfSurveyAsked('reader', '0.4.0', storage);
  assert.equal(pmfSurveyDue('reader', '0.4.0', storage), false);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), false, 'a tab still on the previous release does not ask again');
  assert.equal(pmfSurveyDue('reader', '0.10.0', storage), true, 'versions compare as numbers');
});

test('each account counts its own days and papers, and signing out clears its count', () => {
  const storage = createStorage();
  openOn('reader-a', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  saveSeenPaperIds('reader-b', papers(5), storage);
  rememberPmfSurveyAsked('reader-b', '0.2.0', storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), true);
  assert.equal(pmfSurveyDue('reader-b', '0.3.0', storage), false, 'another account has used it too little');

  clearUserScopedStorage('reader-a', storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), false, 'the days start again from nothing');
  openOn('reader-a', ['2026-11-21'], storage);
  assert.equal(pmfSurveyDue('reader-a', '0.3.0', storage), false, 'one day after signing in again');
  saveSeenPaperIds('reader-b', papers(20), storage);
  assert.equal(pmfSurveyDue('reader-b', '0.3.0', storage), true, 'the other account keeps its record');
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
  assert.doesNotThrow(() => recordPmfSurveyDay('reader', new Date(), blocked));
  assert.doesNotThrow(() => rememberPmfSurveyAsked('reader', '0.3.0', blocked));
  assert.equal(pmfSurveyDue('reader', '0.3.0', blocked), false);

  storage.setItem('papertok_pmfSurvey:reader', '{"days":');
  openOn('reader', ['2026-11-18', '2026-11-19', '2026-11-20'], storage);
  assert.equal(pmfSurveyDue('reader', '0.3.0', storage), true, 'the count starts over and goes on');
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
