import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateLegacyArxivPapers, isLegacyArxivId } from './liked-paper-records.ts';

/**
 * A pre-2007 arXiv paper is keyed by an id with a slash (`hep-th/0603001`).
 * A like or save of one made before document names were encoded never got a
 * document, so the lists name it from arXiv itself.
 */

test('isLegacyArxivId names the pre-2007 shapes and nothing else', async () => {
  for (const id of ['hep-th/0603001', 'math.GT/0309136v2', 'arxiv:cond-mat/0101001']) {
    assert.equal(isLegacyArxivId(id), true, id);
  }
  for (const id of ['2401.01234', 'openalex:W1', 'doi:10.1103/physrevb.42.892', 'pmid:1', '']) {
    assert.equal(isLegacyArxivId(id), false, id);
  }
});

test('hydrateLegacyArxivPapers names the legacy ids from arXiv and reports a failure', async () => {
  const asked: unknown[] = [];
  const ok = await hydrateLegacyArxivPapers(['hep-th/0603001', 'openalex:W1'], {
    fetchArxivPapers: async (ids) => { asked.push(ids); return ([{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Named' }] as import('../models/paper.ts').Paper[]); },
  });
  assert.deepEqual(asked, [['hep-th/0603001']], 'only the legacy shapes go to arXiv');
  assert.equal(ok.failed, false);
  assert.deepEqual(ok.records.map(record => record.id), ['hep-th/0603001']);
  assert.equal(ok.records[0].data.paperTitle, 'Named');

  const down = await hydrateLegacyArxivPapers(['hep-th/0603001'], {
    fetchArxivPapers: async () => { throw new Error('arxiv down'); },
  });
  assert.equal(down.failed, true);
  assert.deepEqual(down.records, []);

  const nothing = await hydrateLegacyArxivPapers(['openalex:W1'], {
    fetchArxivPapers: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(nothing, { records: [], failed: false });
});

test('hydrateLegacyArxivPapers matches an arXiv answer back to the requested id, version suffix and prefix included', async () => {
  const { records } = await hydrateLegacyArxivPapers(['hep-th/0603001v2', 'arxiv:cond-mat/0101001'], {
    fetchArxivPapers: async () => ([
      { id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Versioned', authors: [{ name: 'A. Author' }] },
      { id: 'cond-mat/0101001', arxivId: 'cond-mat/0101001', title: 'Prefixed' },
    ] as import('../models/paper.ts').Paper[]),
  });
  assert.deepEqual(records.map(record => record.id), ['hep-th/0603001v2', 'arxiv:cond-mat/0101001'],
    'each record keeps the id the list holds, not the one arXiv answered with');
  assert.equal(records[0].data.paperTitle, 'Versioned');
  assert.equal(records[0].data.paper.title, 'Versioned');
  assert.deepEqual(records[0].data.paperAuthors, [{ name: 'A. Author' }]);
  assert.equal(records[1].data.paperTitle, 'Prefixed');
});
