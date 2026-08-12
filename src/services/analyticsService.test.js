import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_CONSENT,
  ANALYTICS_CONSENT_KEY,
  normalizeAnalyticsPath,
  persistAnalyticsConsent,
  readAnalyticsConsent,
} from './analyticsService.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('persists only an explicit analytics consent choice', () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), null);
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.GRANTED, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.GRANTED);
  assert.equal(persistAnalyticsConsent('unknown', storage), false);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.GRANTED);
});

test('normalizes entity identifiers and strips query strings from analytics paths', () => {
  assert.equal(normalizeAnalyticsPath('/explorer/institution/02f40zc51'), '/explorer/institution/:id');
  assert.equal(normalizeAnalyticsPath('/explorer/topic/quantum-mechanics?source=openalex'), '/explorer/topic/:id');
  assert.equal(normalizeAnalyticsPath('/research/'), '/research');
  assert.equal(normalizeAnalyticsPath('/'), '/');
});
