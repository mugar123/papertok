import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewStatusForPaper,
  accessStatusForPaper,
  reviewTagForPaper,
  accessTagForPaper,
} from './paper-status.ts';
import { mapOpenAlexWork } from './open-alex-work.ts';
import { PaperBuilder } from '../services/paper-builder.ts';

test('either field naming a preprint makes it one', () => {
  assert.equal(reviewStatusForPaper({ publicationStatus: 'preprint' }), 'preprint');
  assert.equal(reviewStatusForPaper({ publicationType: 'preprint' }), 'preprint');
});

test('a work typed as an article can still be an unpublished preprint', () => {
  // The divergence that made the card and the report disagree. OpenAlex fills
  // `publicationStatus` from whether any location claims to be published, so a
  // work typed `article` whose only copy is a preprint server reads as one
  // here; the card, testing `publicationType` alone, called it Verified.
  assert.equal(
    reviewStatusForPaper({ type: 'article', publicationType: 'article', publicationStatus: 'preprint' } as Parameters<typeof reviewStatusForPaper>[0] & { type: string }),
    'preprint',
  );
});

test('a journal is enough to call a paper reviewed', () => {
  assert.equal(reviewStatusForPaper({ journal: 'Nature' }), 'verified');
  assert.equal(reviewStatusForPaper({ publicationStatus: 'published' }), 'verified');
});

test('an empty record claims nothing about peer review', () => {
  // Verified is the reassuring direction, so it is the worse one to guess wrong
  // in: a paper we know nothing about must not be given a badge saying it was
  // reviewed.
  assert.equal(reviewStatusForPaper({}), null);
  assert.equal(reviewStatusForPaper(null), null);
  assert.equal(reviewTagForPaper({}), null);
});

test('an explicit peerReviewed:false is never Verified, whatever the publication fields say', () => {
  // A record that states it was NOT reviewed is the strongest evidence there
  // is, and it was the one field the label ignored: a technical report typed
  // and published, or anything carrying a journal name, came out `verified`
  // over the top of its own denial.
  assert.equal(
    reviewStatusForPaper({ publicationStatus: 'published', publicationType: 'techreport', peerReviewed: false }),
    null,
  );
  assert.equal(reviewStatusForPaper({ journal: 'Some Journal', peerReviewed: false }), null);
});

test('a working paper carries its own tag, while a reviewed or unknown paper carries none', () => {
  // An IMF working paper as the OpenAlex mappers build it: published, typed
  // `article`, in a journal-like series.
  const workingPaper = reviewTagForPaper({
    journal: 'IMF Working Paper',
    publicationType: 'article',
    publicationStatus: 'published',
    peerReviewed: false,
    workingPaper: true,
  });
  assert.equal(workingPaper?.label, 'Working paper');

  assert.equal(reviewTagForPaper({ journal: 'Nature', publicationType: 'article', publicationStatus: 'published', peerReviewed: true }), null);
  // Another provider's `false` says nothing about the kind of record.
  assert.equal(reviewTagForPaper({ publicationStatus: 'published', publicationType: 'techreport', peerReviewed: false }), null);
  // A preprint stays a preprint whatever series holds it.
  assert.equal(reviewTagForPaper({ publicationStatus: 'preprint', peerReviewed: false, workingPaper: true })?.label, 'Preprint');
});

test('an arXiv copy outranks a publisher that says the paper is closed', () => {
  // OpenAlex reports `is_oa` for the published version. A paper that ran in a
  // subscription journal reads as closed there while its arXiv copy sits free,
  // and the card links that copy — the chip must not contradict the button
  // underneath it.
  assert.equal(accessStatusForPaper({ openAccess: false, arxivId: '2401.00001' }), 'open');
});

// OpenAlex's record of a ChemRxiv preprint it calls closed, as returned on
// 2026-10-27 (trimmed), and a synthetic closed journal version of it: same
// title and first author, so the corpus files the two as one paper.
const CHEMRXIV_WORK = {
  id: 'https://openalex.org/W7223561333',
  doi: 'https://doi.org/10.26434/chemrxiv.15010999/v1',
  title: 'Computational Interactions between the Endohedral Metallofullerene Gd@C60 and Human Toll-Like Receptor 3: A Molecular Docking and Molecular Dynamics Study',
  type: 'preprint',
  publication_date: '2026-10-25',
  publication_year: 2026,
  authorships: [{ author: { id: 'https://openalex.org/A5052942510', display_name: 'Satyavani Kaliamurthi' }, institutions: [] }],
  primary_location: {
    is_oa: false,
    landing_page_url: 'https://doi.org/10.26434/chemrxiv.15010999/v1',
    pdf_url: null,
    version: 'acceptedVersion',
    is_published: false,
    source: { id: 'https://openalex.org/S4393918830', display_name: 'ChemRxiv', type: 'repository' },
  },
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  cited_by_count: 0,
};
const JOURNAL_VERSION = {
  ...CHEMRXIV_WORK,
  id: 'https://openalex.org/W1000000001',
  doi: 'https://doi.org/10.1021/acs.jcim.6c00001',
  type: 'article',
  publication_date: '2026-10-26',
  primary_location: {
    is_oa: false,
    landing_page_url: 'https://doi.org/10.1021/acs.jcim.6c00001',
    pdf_url: null,
    version: 'publishedVersion',
    is_published: true,
    source: { id: 'https://openalex.org/S1000000001', display_name: 'Journal of Chemical Information and Modeling', type: 'journal' },
  },
};

test('a ChemRxiv preprint is open whatever OpenAlex says, and a journal article merged with it keeps its own answer', () => {
  const preprint = mapOpenAlexWork(CHEMRXIV_WORK)!;
  const article = mapOpenAlexWork(JOURNAL_VERSION)!;
  assert.equal(accessTagForPaper(preprint)?.label, 'Open access');
  assert.equal(accessTagForPaper(article)?.label, 'Closed access');
  // Whichever record the corpus stored first, the merged paper answers for
  // the DOI it keeps.
  const articleFirst = PaperBuilder.merge(article, preprint, preprint.provider);
  assert.deepEqual([articleFirst.doi, accessStatusForPaper(articleFirst)], ['10.1021/acs.jcim.6c00001', 'subscription']);
  const preprintFirst = PaperBuilder.merge(preprint, article, article.provider);
  assert.deepEqual([preprintFirst.doi, accessStatusForPaper(preprintFirst)], ['10.26434/chemrxiv.15010999/v1', 'open']);
  // A journal record without a DOI of its own takes the preprint's, whose page
  // the card then opens (paper-open-targets.ts).
  const withoutDoi = PaperBuilder.merge({ ...article, doi: null, landingPageUrl: 'https://pubmed.ncbi.nlm.nih.gov/40000001/' }, preprint, preprint.provider);
  assert.deepEqual([withoutDoi.doi, accessStatusForPaper(withoutDoi)], ['10.26434/chemrxiv.15010999/v1', 'open']);
});

test('only an explicit false is a paywall', () => {
  assert.equal(accessStatusForPaper({ openAccess: false }), 'subscription');
  assert.equal(accessStatusForPaper({}), null);
  assert.equal(accessStatusForPaper({ openAccess: undefined, title: 'x' }), null);
  assert.equal(accessTagForPaper({}), null);
});

// Copies as `mapUnpaywallResult` hands them over.
const REPOSITORY_COPY = { landingPageUrl: 'https://repository.example/paper', hostType: 'repository', version: 'acceptedVersion', accessSource: 'unpaywall' };
const PUBLISHER_COPY = { landingPageUrl: 'https://doi.org/10.1371/journal.pone.0358652', hostType: 'publisher', version: 'publishedVersion', license: 'cc-by', accessSource: 'unpaywall' };

test('a located free copy opens a paper the record called closed', () => {
  assert.equal(accessStatusForPaper({ openAccess: false }, { openCopy: REPOSITORY_COPY }), 'open');
});

test('a copy found in a repository is a weaker claim than open access, and says so', () => {
  const found = accessTagForPaper({ openAccess: false }, { openCopy: REPOSITORY_COPY });
  const native = accessTagForPaper({ openAccess: true });
  assert.equal(found!.label, 'Open version');
  assert.equal(native!.label, 'Open access');
  assert.notEqual(found!.key, native!.key);
  assert.equal(found!.tone, native!.tone);
});

test('the published version free at the publisher is open access, not a copy of it', () => {
  // A gold paper PubMed had no PMC for yet: Unpaywall found it at the
  // publisher, and "Open version" told the reader the published one was paid.
  const tag = accessTagForPaper({ openAccess: false }, { openCopy: PUBLISHER_COPY });
  assert.equal(tag!.key, 'open');
  assert.equal(tag!.label, 'Open access');
  // Bronze copies come without a version; the publisher's page is still the article.
  const bronze = { ...PUBLISHER_COPY, version: undefined, license: undefined };
  assert.equal(accessTagForPaper({}, { openCopy: bronze })!.key, 'open');
});

test('an accepted manuscript at the publisher is still only a version of the paper', () => {
  const manuscript = { ...PUBLISHER_COPY, version: 'acceptedVersion' };
  assert.equal(accessTagForPaper({ openAccess: false }, { openCopy: manuscript })!.key, 'openCopy');
});

test('the chip takes no word from the library: a paywalled paper reads Closed access for everyone', () => {
  // The library's way in is the button's to name (`PaperCard`).
  assert.equal(accessTagForPaper({ openAccess: false })!.label, 'Closed access');
  assert.equal(accessTagForPaper({}), null);
});

test('a downloadable pdf counts as open', () => {
  // A direct PDF link is evidence of an accessible copy.
  assert.equal(accessStatusForPaper({ pdfUrl: 'https://example.org/a.pdf' }), 'open');
  assert.equal(accessStatusForPaper({ openAccessPdfUrl: 'https://example.org/a.pdf' }), 'open');
});

test('every chip carries a tone, a word and an explanation', () => {
  const papers = [
    { publicationType: 'preprint', arxivId: '2401.00001' },
    { publicationStatus: 'published' as const, peerReviewed: false, workingPaper: true },
    { journal: 'Nature', openAccess: false },
  ];
  for (const paper of papers) {
    // `reviewTagForPaper` can return nothing: since 2026-09-12 only the
    // caveats (preprint, working paper) are tagged. Peer review is the norm
    // and is not marked.
    for (const tag of [reviewTagForPaper(paper), accessTagForPaper(paper)].filter(Boolean)) {
      assert.match(tag!.tone, /^(amber|blue|green|neutral)$/);
      assert.ok(tag!.label.length > 0 && tag!.hint.length > 0);
    }
  }
});

test('the chips use the English terms', () => {
  assert.equal(reviewTagForPaper({ publicationType: 'preprint' })!.label, 'Preprint');
  assert.equal(accessTagForPaper({ openAccess: false })!.label, 'Closed access');
  assert.equal(reviewTagForPaper({ journal: 'Nature' }), null,
    'lo revisado por pares no lleva distintivo: era la norma, no la excepción');
});

/**
 * El sello azul «Verificado» se retiró el 12-09-2026 de las tres superficies
 * que lo pintaban: la fila del explorador, la tarjeta del feed y la portada
 * del informe. El ESTADO sigue calculándose —los filtros lo usan— pero no
 * hay distintivo detrás de él.
 */
test('a peer-reviewed paper carries no review tag', () => {
  assert.equal(reviewTagForPaper({ journal: 'Nature' }), null);
  assert.equal(reviewTagForPaper({ publicationStatus: 'published' }), null);
  const preprint = reviewTagForPaper({ publicationType: 'preprint' });
  assert.ok(preprint && preprint.key === 'preprint', 'la salvedad sí se señala');
  assert.equal(reviewStatusForPaper({ journal: 'Nature' }), 'verified',
    'el hecho del registro no cambia, sólo deja de pintarse');
});
