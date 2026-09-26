import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCountries, SUPPORTED_COUNTRY_CODES } from './countries.js';

test('country search ignores accents and prioritizes prefix matches', () => {
  assert.deepEqual(searchCountries('czéch')[0], { code: 'CZ', name: 'Czech Republic' });
  // "Denmark" and "Romania" contain "ma" and Denmark sorts first alphabetically,
  // but a name that starts with the query wins.
  assert.deepEqual(searchCountries('ma')[0], { code: 'MY', name: 'Malaysia' });
});

test('country search supports ISO codes and shares the map option set', () => {
  assert.deepEqual(searchCountries('es')[0], { code: 'ES', name: 'Spain' });
  assert.ok(SUPPORTED_COUNTRY_CODES.includes('ES'));
  assert.ok(!SUPPORTED_COUNTRY_CODES.includes('AF'));
});
