import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScopusSearchQuery } from './scopusQuery.js';

test('builds a bounded Scopus query without accepting query operators', () => {
  assert.equal(
    buildScopusSearchQuery({ terms: ['Robotics', 'Fluid Mechanics', 'Robotics', 'Energy OR ALL(*)'] }),
    'TITLE-ABS-KEY("Robotics") OR TITLE-ABS-KEY("Fluid Mechanics") OR TITLE-ABS-KEY("Energy ALL")',
  );
});

test('builds an author query and strips Scopus syntax characters', () => {
  assert.equal(
    buildScopusSearchQuery({ author: 'Ada (Researcher) OR AFFIL(secret)' }),
    'AUTH("Ada Researcher AFFIL secret")',
  );
});
