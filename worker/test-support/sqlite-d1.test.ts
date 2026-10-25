import assert from 'node:assert/strict';
import test from 'node:test';

import { testD1 } from './sqlite-d1.ts';

// What local D1 refused on 2026-10-23 (Miniflare, workerd's SQLite): the
// double has to refuse it too, or the store's tests pass SQL production rejects.

const terms = (count: number) => Array.from({ length: count }, (_, index) => `SELECT ${index} AS n`).join(' UNION ALL ');

test('the D1 double refuses a compound SELECT of more than five terms', async () => {
  const { binding } = testD1();
  assert.equal((await binding.prepare(terms(5)).all()).results.length, 5);
  await assert.rejects(binding.prepare(terms(6)).all(), /too many terms in compound SELECT/);
  await assert.rejects(binding.prepare(terms(6)).first(), /too many terms in compound SELECT/);
  await assert.rejects(binding.batch([binding.prepare(terms(6))]), /too many terms in compound SELECT/);
});

test('the D1 double counts the terms of each compound SELECT, not of the statement', async () => {
  const { binding } = testD1();
  const two = `SELECT n FROM (${terms(5)}) UNION ALL SELECT n FROM (${terms(4)})`;
  assert.equal((await binding.prepare(two).all()).results.length, 9);
  const quoted = `SELECT 'a UNION b UNION c UNION d UNION e UNION f' AS n -- UNION UNION
    UNION ALL ${terms(4)}`;
  assert.equal((await binding.prepare(quoted).all()).results.length, 5);
});

test('the D1 double refuses more than 100 bound parameters', async () => {
  const { binding } = testD1();
  const columns = (count: number) => binding
    .prepare(`SELECT ${Array.from({ length: count }, (_, index) => `? AS c${index}`).join(', ')}`)
    .bind(...Array.from({ length: count }, (_, index) => index));
  assert.equal(Object.keys(await columns(100).first() ?? {}).length, 100);
  await assert.rejects(columns(101).first(), /too many SQL variables/);
  await assert.rejects(columns(101).run(), /too many SQL variables/);
  await assert.rejects(binding.batch([columns(101)]), /too many SQL variables/);
});
