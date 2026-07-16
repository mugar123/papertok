import test from 'node:test';
import assert from 'node:assert/strict';
import { mapEuropePmcResult } from './europePmcService.js';

test('maps Europe PMC open full text and biomedical metadata', () => {
  const mapped = mapEuropePmcResult({
    id: '12345',
    pmcid: 'PMC12345',
    abstractText: 'A <i>useful</i> abstract &amp; result.',
    meshHeadingList: { meshHeading: [{ descriptorName: 'Heart Diseases' }] },
    keywordList: { keyword: ['Cardiology', 'Heart Diseases'] },
    fullTextUrlList: { fullTextUrl: [
      { availabilityCode: 'OA', documentStyle: 'html', url: 'https://europepmc.org/articles/PMC12345' },
      { availabilityCode: 'OA', documentStyle: 'pdf', url: 'https://europepmc.org/articles/PMC12345?pdf=render' },
    ] },
    isOpenAccess: 'Y',
    citedByCount: 17,
    hasReferences: 'Y',
    hasData: 'Y',
    hasSuppl: 'N',
    license: 'cc by',
  });

  assert.equal(mapped.abstract, 'A useful abstract & result.');
  assert.deepEqual(mapped.biomedicalTerms, ['Heart Diseases', 'Cardiology']);
  assert.equal(mapped.openAccess, true);
  assert.equal(mapped.citationCount, 17);
  assert.equal(mapped.hasReferences, true);
  assert.equal(mapped.hasData, true);
  assert.equal(mapped.hasSupplement, false);
  assert.equal(mapped.accessSource, 'europepmc');
  assert.match(mapped.openAccessPdfUrl, /pdf=render/);
});

test('ignores unsafe Europe PMC URLs', () => {
  const mapped = mapEuropePmcResult({
    id: '999',
    fullTextUrlList: { fullTextUrl: [
      { availabilityCode: 'OA', documentStyle: 'html', url: 'javascript:alert(1)' },
    ] },
  });

  assert.equal(mapped.landingPageUrl, undefined);
  assert.equal(mapped.openAccess, true);
});
