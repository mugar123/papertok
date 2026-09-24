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

// Europe PMC writes the section headings of a structured abstract as <h4> and
// leaves comparison signs unescaped. Deleting "<" to the next ">" as markup
// erased a p-value and a comparison from PMID 42629277 and glued the next
// heading onto the text ("… P ConclusionsPretransplant …", audit 2026-09-23).
test('a literal "<" in an abstract is text, and section headings become labels', () => {
  const record = mapEuropePmcRecord({
    id: '42629277',
    abstractText: '<h4>Background</h4>Acute renal allograft rejection remains a leading cause of graft loss.'
      + '<h4>Results</h4>Lower CALLY values were associated with rejection (AUC = 0.968, 95% CI 0.925-1.000, '
      + 'P < .001) compared with PNI and GPS.<h4>Conclusions</h4>Pretransplant CALLY index is a simple predictor.',
  });

  assert.equal(
    record.abstract,
    'Background: Acute renal allograft rejection remains a leading cause of graft loss. '
      + 'Results: Lower CALLY values were associated with rejection (AUC = 0.968, 95% CI 0.925-1.000, '
      + 'P < .001) compared with PNI and GPS. Conclusions: Pretransplant CALLY index is a simple predictor.',
  );
});

test('only known tags are markup: comparisons survive, inline tags keep their text', () => {
  assert.equal(
    mapEuropePmcRecord({ id: '1', abstractText: 'IC50 values x<y and y>z were seen <i>in vitro</i> and <sup>2</sup>H.' }).abstract,
    'IC50 values x<y and y>z were seen in vitro and 2H.',
  );
  assert.equal(
    mapEuropePmcRecord({ id: '2', abstractText: '<p>First paragraph.</p><p>Second paragraph.</p>' }).abstract,
    'First paragraph. Second paragraph.',
  );
  // A heading that already ends in its own punctuation keeps it.
  assert.equal(
    mapEuropePmcRecord({ id: '3', abstractText: '<h4>Objective:</h4>To test.' }).abstract,
    'Objective: To test.',
  );
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
