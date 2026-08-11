import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCountries, SUPPORTED_COUNTRY_CODES } from './countries.js';

test('country search ignores accents and prioritizes prefix matches', () => {
  assert.deepEqual(searchCountries('japon', 'es')[0], { code: 'JP', name: 'Japón' });
  assert.deepEqual(searchCountries('republica', 'es')[0], { code: 'CZ', name: 'República Checa' });
});

test('country search supports ISO codes and shares the map option set', () => {
  assert.deepEqual(searchCountries('es', 'en')[0], { code: 'ES', name: 'Spain' });
  assert.ok(SUPPORTED_COUNTRY_CODES.includes('ES'));
  assert.ok(!SUPPORTED_COUNTRY_CODES.includes('AF'));
});
