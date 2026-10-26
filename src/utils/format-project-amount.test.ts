import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProjectAmount } from './format-project-amount.ts';

test('a known currency is formatted as money', () => {
  assert.match(formatProjectAmount(90593, 'EUR', 'en-US'), /€\s?90,593/);
  assert.match(formatProjectAmount(90593, 'CHF', 'en-US'), /CHF\s?90,593/);
});

test('an unknown currency is never shown as euros', () => {
  for (const currency of [undefined, '', 'NOT-A-CODE']) {
    for (const locale of ['en-US', 'es-ES', 'de-DE']) {
      const text = formatProjectAmount(90593, currency, locale);
      assert.doesNotMatch(text, /€|EUR/, `${currency} ${locale}`);
      assert.match(text, /90.?593/, `${currency} ${locale}`);
    }
  }
});
