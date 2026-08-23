import test from 'node:test';
import assert from 'node:assert/strict';
import { mapEuropePmcRecord } from './europePmcRecord.js';
import { mapEuropePmcResult } from '../services/europePmcService.js';
import { mapEuropePmcSearchResult } from '../services/domainSourceService.js';

// The four places where the two copies of this reader had drifted apart. Each
// assertion here was true on exactly one side before they were merged.
test('counts free full text as readable, not just the open-access flag', () => {
  const byCode = mapEuropePmcRecord({
    id: '1',
    isOpenAccess: 'N',
    fullTextUrlList: { fullTextUrl: [{ availabilityCode: 'F', documentStyle: 'pdf', url: 'https://europepmc.org/a?pdf=render' }] },
  });
  const byAvailabilityText = mapEuropePmcRecord({
    id: '2',
    fullTextUrlList: { fullTextUrl: [{ availability: 'Open access', documentStyle: 'html', url: 'https://europepmc.org/b' }] },
  });
  const closed = mapEuropePmcRecord({
    id: '3',
    isOpenAccess: 'N',
    fullTextUrlList: { fullTextUrl: [{ availabilityCode: 'S', documentStyle: 'html', url: 'https://publisher.example/c' }] },
  });

  assert.equal(byCode.openAccess, true);
  assert.equal(byCode.pdfUrl, 'https://europepmc.org/a?pdf=render');
  assert.equal(byAvailabilityText.openAccess, true);
  assert.equal(byAvailabilityText.htmlUrl, 'https://europepmc.org/b');
  assert.equal(closed.openAccess, false);
  assert.equal(closed.htmlUrl, '');
});

test('decodes HTML entities in the abstract on both paths', () => {
  const record = mapEuropePmcRecord({ id: '1', abstractText: 'Sodium &amp; potassium &lt;i&gt;in vivo&lt;/i&gt;' });
  assert.equal(record.abstract, 'Sodium & potassium <i>in vivo</i>');
});

test('reads MeSH descriptors in all three shapes and dedupes terms case-insensitively', () => {
  const record = mapEuropePmcRecord({
    id: '1',
    meshHeadingList: { meshHeading: [
      { descriptorName: 'Heart Diseases' },
      { descriptorName: { $: 'Arrhythmias' } },
      { descriptorName: { value: 'Cardiac Imaging' } },
    ] },
    keywordList: { keyword: ['heart diseases', 'Cardiology'] },
  });

  assert.deepEqual(record.terms, ['Heart Diseases', 'Arrhythmias', 'Cardiac Imaging', 'Cardiology']);
});

test('refuses a full-text URL that is not http(s)', () => {
  const record = mapEuropePmcRecord({
    id: '1',
    pmcid: 'PMC1',
    fullTextUrlList: { fullTextUrl: [{ availabilityCode: 'OA', documentStyle: 'html', url: 'javascript:alert(1)' }] },
  });

  assert.equal(record.htmlUrl, '');
  assert.equal(record.europePmcUrl, 'https://europepmc.org/articles/PMC1');
});

// The point of the shared reader: one payload, one verdict, two output shapes.
test('gives the enrichment patch and the feed paper the same verdict', () => {
  const raw = {
    id: '77',
    pmid: '77',
    pmcid: 'PMC77',
    title: 'A shared record',
    abstractText: 'Sodium &amp; potassium',
    isOpenAccess: 'N',
    fullTextUrlList: { fullTextUrl: [{ availabilityCode: 'F', documentStyle: 'pdf', url: 'https://europepmc.org/d?pdf=render' }] },
    keywordList: { keyword: ['Cardiology', 'cardiology'] },
    citedByCount: 4,
  };

  const patch = mapEuropePmcResult(raw);
  const paper = mapEuropePmcSearchResult(raw, ['bio.physio']);

  assert.equal(patch.openAccess, paper.openAccess);
  assert.equal(patch.abstract, paper.abstract);
  assert.equal(patch.openAccessPdfUrl, paper.openAccessPdfUrl);
  assert.equal(patch.citationCount, paper.citationCount);
  assert.deepEqual(patch.biomedicalTerms, paper.biomedicalTerms);
  assert.deepEqual(patch.biomedicalTerms, ['Cardiology']);
});
