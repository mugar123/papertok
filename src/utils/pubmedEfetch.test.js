import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmlDocument } from '../test-support/xmlDomShim.js';
import { pubmedAbstractText, readPubmedEfetch } from './pubmedEfetch.js';

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

test('the efetch reader keys each article by its own PMID', () => {
  const records = readPubmedEfetch(parseXmlDocument(STRUCTURED_WITH_TRANSLATION));

  assert.deepEqual(Object.keys(records), ['pmid:42775314', 'pmid:111', 'pmid:222']);
  assert.match(records['pmid:42775314'].abstract, /^BACKGROUND: Heart failure is common\./);
  assert.doesNotMatch(records['pmid:42775314'].abstract, /Cilj je bio/);
  assert.equal(records['pmid:222'].abstract, '');
});
