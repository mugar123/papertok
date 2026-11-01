import assert from 'node:assert/strict';
import test from 'node:test';
import { fullTextQuery } from './full-text-service.ts';

test('asks the Worker by every identifier the paper has, and not at all without one', () => {
  assert.equal(
    fullTextQuery({ arxivId: 'arxiv:1706.03762v7', pmcid: 'PMC1762328', doi: '10.1371/journal.pone.0000001' })?.toString(),
    'arxiv_id=1706.03762&pmcid=PMC1762328&doi=10.1371%2Fjournal.pone.0000001',
  );
  assert.equal(fullTextQuery({ doi: '10.1101/2024.01.01.000001' })?.toString(), 'doi=10.1101%2F2024.01.01.000001');
  assert.equal(fullTextQuery({ arxivId: 'not an id', title: 'A paper' }), null);
  assert.equal(fullTextQuery(null), null);
});
