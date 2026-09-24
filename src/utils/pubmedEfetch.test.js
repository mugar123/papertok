import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmlDocument } from '../test-support/xmlDomShim.js';
import { mergePubmedAuthors, pubmedAbstractText, pubmedAuthors, readPubmedEfetch } from './pubmedEfetch.js';

// Trimmed from efetch for PMID 42775314 (2026-09-24): the English abstract is
// four labelled sections under Article/Abstract, and the publisher's Serbian
// translation sits beside Article as OtherAbstract, with its own labels.
const STRUCTURED_WITH_TRANSLATION = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM">
    <PMID Version="1">42775314</PMID>
    <Article PubModel="Print">
      <ArticleTitle>H-FABP in heart failure.</ArticleTitle>
      <Abstract>
        <AbstractText Label="BACKGROUND" NlmCategory="UNASSIGNED">Heart failure is common.</AbstractText>
        <AbstractText Label="METHODS" NlmCategory="UNASSIGNED">We measured H-FABP in <i>serum</i>.</AbstractText>
        <AbstractText Label="RESULTS" NlmCategory="UNASSIGNED">Levels were higher (P &lt; 0.05).</AbstractText>
      </Abstract>
    </Article>
    <OtherAbstract Type="Publisher" Language="srp">
      <AbstractText Label="UVOD" NlmCategory="UNASSIGNED">Cilj je bio da se analizira zna&#x10d;aj H-FABP.</AbstractText>
    </OtherAbstract>
    <MeshHeadingList>
      <MeshHeading><DescriptorName UI="D006333" MajorTopicYN="Y">Heart Failure</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation Status="MEDLINE" Owner="NLM">
    <PMID Version="1">111</PMID>
    <Article PubModel="Print">
      <Abstract>
        <AbstractText>A single unlabelled paragraph.</AbstractText>
      </Abstract>
    </Article>
  </MedlineCitation>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation Status="MEDLINE" Owner="NLM">
    <PMID Version="1">222</PMID>
    <Article PubModel="Print">
      <ArticleTitle>An editorial with no abstract.</ArticleTitle>
    </Article>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`;

const articles = () => parseXmlDocument(STRUCTURED_WITH_TRANSLATION).querySelectorAll('PubmedArticle');

test('a structured abstract keeps its section labels and never the translation beside it', () => {
  assert.equal(
    pubmedAbstractText(articles()[0]),
    'BACKGROUND: Heart failure is common. METHODS: We measured H-FABP in serum. RESULTS: Levels were higher (P < 0.05).',
  );
});

test('an unlabelled abstract is its text, and a missing one stays missing', () => {
  assert.equal(pubmedAbstractText(articles()[1]), 'A single unlabelled paragraph.');
  assert.equal(pubmedAbstractText(articles()[2]), '');
});

// "Humans", "Female", "Aged" are the NLM check tags indexed on almost every
// record; they were the first chips of most PubMed cards (47 of 57 records
// with MeSH led with one; audit 2026-09-23, issue 7).
test('MeSH subjects come without check tags, major topics first', () => {
  const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM">
    <PMID Version="1">333</PMID>
    <Article PubModel="Print"><Abstract><AbstractText>Text.</AbstractText></Abstract></Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName UI="D006801" MajorTopicYN="N">Humans</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName UI="D000368" MajorTopicYN="N">Aged</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName UI="D019210" MajorTopicYN="N">Troponin I</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName UI="D006333" MajorTopicYN="N">Heart Failure</DescriptorName><QualifierName UI="Q000097" MajorTopicYN="Y">blood</QualifierName></MeshHeading>
      <MeshHeading><DescriptorName UI="D005260" MajorTopicYN="N">Female</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName UI="D015415" MajorTopicYN="Y">Biomarkers</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation></PubmedArticle></PubmedArticleSet>`;

  assert.deepEqual(readPubmedEfetch(parseXmlDocument(xml))['pmid:333'].categories, ['Heart Failure', 'Biomarkers', 'Troponin I']);
});

test('the efetch reader keys each article by its own PMID', () => {
  const records = readPubmedEfetch(parseXmlDocument(STRUCTURED_WITH_TRANSLATION));

  assert.deepEqual(Object.keys(records), ['pmid:42775314', 'pmid:111', 'pmid:222']);
  assert.match(records['pmid:42775314'].abstract, /^BACKGROUND: Heart failure is common\./);
  assert.doesNotMatch(records['pmid:42775314'].abstract, /Cilj je bio/);
  assert.equal(records['pmid:222'].abstract, '');
});

// The efetch record names every author in full, with an affiliation and
// sometimes an ORCID; the adapter kept esummary's "Li WN" and threw the rest
// away, which left the explorer only a name to guess from (203 of 203
// authors in a 25-record sample had a first name and an affiliation, 15 an
// ORCID; audit 2026-09-23, issue 4).
const AUTHORS = `<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM">
  <PMID Version="1">42774036</PMID>
  <Article PubModel="Electronic-eCollection">
    <AuthorList CompleteYN="Y">
      <Author ValidYN="Y"><LastName>Pidugu</LastName><ForeName>Vijaya Kumar</ForeName><Initials>VK</Initials>
        <AffiliationInfo><Affiliation>Department of Surgery, Houston Methodist, Houston, TX, United States.</Affiliation></AffiliationInfo></Author>
      <Author ValidYN="Y"><LastName>Huang</LastName><ForeName>Hsiang-Ching</ForeName><Initials>HC</Initials></Author>
      <Author ValidYN="Y"><LastName>Li</LastName><ForeName>Wan-Ning</ForeName><Initials>WN</Initials>
        <Identifier Source="ORCID">https://orcid.org/0000-0002-1825-0097</Identifier>
        <AffiliationInfo><Affiliation>National Cancer Institute, Bethesda, MD, United States.</Affiliation></AffiliationInfo>
        <AffiliationInfo><Affiliation>Second affiliation.</Affiliation></AffiliationInfo></Author>
      <Author ValidYN="Y"><CollectiveName>The Endocrine Consortium</CollectiveName></Author>
    </AuthorList>
  </Article>
</MedlineCitation></PubmedArticle></PubmedArticleSet>`;

test('the efetch record keeps each author\'s full name, first affiliation and ORCID', () => {
  const [article] = parseXmlDocument(AUTHORS).querySelectorAll('PubmedArticle');

  assert.deepEqual(pubmedAuthors(article), [
    { name: 'Pidugu VK', fullName: 'Vijaya Kumar Pidugu', affiliation: 'Department of Surgery, Houston Methodist, Houston, TX, United States.' },
    { name: 'Huang HC', fullName: 'Hsiang-Ching Huang' },
    { name: 'Li WN', fullName: 'Wan-Ning Li', orcid: '0000-0002-1825-0097', affiliation: 'National Cancer Institute, Bethesda, MD, United States.' },
    { name: 'The Endocrine Consortium', fullName: 'The Endocrine Consortium' },
  ]);
});

test('the card\'s authors get those identifiers, by position or by name, and keep their names', () => {
  const [article] = parseXmlDocument(AUTHORS).querySelectorAll('PubmedArticle');
  const fromEfetch = pubmedAuthors(article);

  const merged = mergePubmedAuthors([{ name: 'Pidugu VK' }, { name: 'Huang HC' }, { name: 'Li WN' }, { name: 'The Endocrine Consortium' }], fromEfetch);
  assert.equal(merged[2].name, 'Li WN');
  assert.equal(merged[2].orcid, '0000-0002-1825-0097');
  assert.equal(merged[2].fullName, 'Wan-Ning Li');

  // esummary sometimes drops the collective author: then names decide.
  const byName = mergePubmedAuthors([{ name: 'Li WN' }, { name: 'Pidugu VK' }], fromEfetch);
  assert.deepEqual(byName.map(author => author.fullName), ['Wan-Ning Li', 'Vijaya Kumar Pidugu']);
  assert.deepEqual(mergePubmedAuthors([{ name: 'Someone Else' }], fromEfetch), [{ name: 'Someone Else' }]);
});
