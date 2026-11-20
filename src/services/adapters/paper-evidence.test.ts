import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { paperLegacyAdapter } from '../../models/paper.ts';
import { trialRegistrationUrl } from '../../models/paper-evidence.ts';
import { parseXmlDocument } from '../../test-support/xml-dom-shim.ts';
import { mergeOpenAlexEnrichment } from '../../utils/feed-enrichment.ts';
import { mapOpenAlexEnrichmentWork, mapOpenAlexWork } from '../../utils/open-alex-work.ts';
import { serializeLibraryPaper } from '../../utils/reading-library.ts';
import { PaperBuilder } from '../paper-builder.ts';
// Captured OpenAlex work W2588681363, with only the fields used in these tests.
import openAlexReview from './open-alex-evidence.fixture.json' with { type: 'json' };
import { mapPubmedSummary, readPubmedPayload } from './pubmed-records.ts';

const efetch = readFileSync(new URL('./pubmed-evidence.fixture.xml', import.meta.url), 'utf8');
const ids = ['32445440', '24352797', '43059205', '43059327', '36914411'];

function pubmedPapers(xml: string) {
  return readPubmedPayload({
    esearchresult: { idlist: ids },
    result: Object.fromEntries(ids.map(uid => [uid, { uid }])),
    efetch: xml,
  }, { parseXml: parseXmlDocument });
}

test('PubMed assigns the supported study types from publication types and links a secondary source ID', () => {
  const papers = pubmedPapers(efetch);
  assert.deepEqual(papers.map(paper => paper.studyType), [
    'randomized-controlled-trial', 'practice-guideline', 'meta-analysis', 'systematic-review', undefined,
  ]);
  assert.equal(trialRegistrationUrl(papers[0].trialRegistration), 'https://clinicaltrials.gov/study/NCT04280705');

  const summary = mapPubmedSummary({ uid: '24352797', pubtype: ['Journal Article', 'Practice Guideline'] });
  assert.equal(summary.studyType, 'practice-guideline');
  assert.equal(mapPubmedSummary({ uid: '24352797', title: 'A practice guideline' }).studyType, undefined);
});

test('PubMed rejects malformed accessions and abstract tokens and can fall back to a valid abstract ID', () => {
  const invalid = efetch.replace('NCT04280705', 'NCT042807051').replace('<DataBankList CompleteYN="Y">', [
    '<Abstract><AbstractText>NCT0428070 and NCT042807051 and XNCT04280705.</AbstractText></Abstract>',
    '<DataBankList CompleteYN="Y">',
  ].join(''));
  assert.equal(pubmedPapers(invalid)[0].trialRegistration, undefined);
  assert.equal(trialRegistrationUrl('NCT04280705/extra'), undefined);
  assert.equal(pubmedPapers(invalid.replace('XNCT04280705.', '(nct04280705).'))[0].trialRegistration, 'NCT04280705');
});

test('OpenAlex uses specific design IDs, and enrichment and deduplication preserve evidence', () => {
  const mapped = mapOpenAlexWork(openAlexReview)!;
  assert.equal(mapped.studyType, 'meta-analysis');
  const broad = mapOpenAlexWork({ ...openAlexReview, study_designs: [] })!;
  assert.equal(broad.studyType, undefined);

  const enrichment = mapOpenAlexEnrichmentWork(openAlexReview)!.enrichment;
  const pubmed = mapPubmedSummary({
    uid: '1',
    pubtype: ['Systematic Review'],
    articleids: [{ idtype: 'doi', value: '10.1159/000454668' }],
  });
  assert.equal(mergeOpenAlexEnrichment([pubmed], { 'doi:10.1159/000454668': enrichment })[0].studyType, 'meta-analysis');
  for (const batch of [[pubmed, mapped], [mapped, pubmed]]) {
    const papers = PaperBuilder.deduplicate(batch);
    assert.equal(papers.length, 1);
    assert.equal(papers[0].studyType, 'meta-analysis');
  }
});

test('the interaction copy keeps study type and registration outside the abstract', () => {
  const [paper] = pubmedPapers(efetch);
  const stored = serializeLibraryPaper(paper);
  const restored = paperLegacyAdapter(stored);
  assert.equal(restored.studyType, 'randomized-controlled-trial');
  assert.equal(restored.trialRegistration, 'NCT04280705');
});

test('a PubMed accession wins over a smaller ID mentioned in another source abstract', () => {
  const [paper] = pubmedPapers(efetch);
  const indexed = paperLegacyAdapter(serializeLibraryPaper(paper));
  const abstractRecord = PaperBuilder.create({
    id: paper.id,
    abstract: 'Related to trial NCT00000001.',
  });
  assert.equal(abstractRecord.trialRegistration, 'NCT00000001');
  for (const [base, other] of [[indexed, abstractRecord], [abstractRecord, indexed]]) {
    const merged = PaperBuilder.merge(base, other);
    assert.equal(merged.trialRegistration, 'NCT04280705');
  }
});
