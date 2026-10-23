import type { Paper, PaperAuthor } from '../../models/Paper.ts';

export interface PubmedSummary {
  uid: string;
  title?: string;
  authors?: Array<{ name: string }>;
  articleids?: Array<{ idtype: string; value: string }>;
  source?: string;
  issn?: string;
  essn?: string;
  nlmuniqueid?: string;
  pubdate?: string;
  epubdate?: string;
  pubtype?: string | string[];
}
export interface PubmedResponse {
  esearchresult?: { idlist?: string[]; count?: string };
  result?: Record<string, PubmedSummary>;
  efetch?: string;
}

import { CATEGORIES } from '../../data/categoryTaxonomy.ts';
import { mergePubmedAuthors, readPubmedEfetch } from '../../utils/pubmedEfetch.ts';
import { PROTOCOL_SERIES_ISSNS, isAfterToday, isProtocolBookSeries } from '../../utils/medlineRecord.ts';

// PubMed's E-utilities payloads as the app's papers, for the browser's
// adapter and the Worker's paper store alike: neither fetch path lives here.

const PUBMED_CATEGORY_ALIASES: Readonly<Record<string, string[]>> = Object.freeze({
  'med.gen': ['internal medicine', 'general medicine', 'primary care', 'family medicine', 'multimorbidity'],
  'med.onco': ['oncology', 'cancer', 'tumor', 'tumour', 'carcinoma', 'neoplasm', 'chemotherapy'],
  'med.cardio': ['cardiology', 'cardiovascular', 'cardiac', 'heart disease', 'myocardial', 'coronary', 'arrhythmia'],
  'med.neuro': ['clinical neurology', 'neurological disorder', 'stroke', 'epilepsy', 'multiple sclerosis', 'parkinson disease'],
  'med.psych': ['psychiatry', 'mental health', 'depression', 'anxiety disorder', 'schizophrenia', 'bipolar disorder'],
  'med.pubh': ['public health', 'epidemiology', 'population health', 'disease burden', 'health policy', 'healthcare access'],
  'med.pharma': ['pharmacology', 'drug development', 'drug discovery', 'pharmacokinetics', 'pharmacodynamics', 'clinical trial'],
  'med.tox': ['toxicology', 'toxicity', 'toxic effect', 'poisoning', 'genotoxicity'],
  'med.peds': ['pediatrics', 'paediatrics', 'pediatric', 'paediatric', 'child health', 'neonatal'],
  'med.surg': ['surgery', 'surgical', 'postoperative', 'perioperative', 'operative treatment'],
  'med.immuno': ['clinical immunology', 'allergy', 'autoimmune disease', 'immunodeficiency', 'transplant rejection'],
  'med.endo': ['endocrinology', 'metabolic disease', 'diabetes', 'thyroid', 'hormone disorder'],
  'med.path': ['pathology', 'histopathology', 'pathological diagnosis', 'biopsy'],
  'med.radio': ['radiology', 'medical imaging', 'magnetic resonance imaging', 'computed tomography', 'ultrasound imaging'],
  'med.infect': ['infectious disease', 'infection', 'viral disease', 'bacterial disease', 'antimicrobial resistance'],
  'med.derma': ['dermatology', 'skin disease', 'cutaneous', 'melanoma', 'psoriasis'],
  'bio.gen': ['genetics', 'genetic variation', 'genome', 'genomic', 'heredity', 'gene expression'],
  'bio.mol': ['molecular biology', 'molecular mechanism', 'dna', 'rna', 'protein expression'],
  'bio.cell': ['cell biology', 'cellular biology', 'cell signaling', 'cell cycle', 'organelle'],
  'bio.neuro': ['neuroscience', 'neurobiology', 'neuron', 'neural circuit', 'synapse', 'brain function'],
  'bio.eco': ['ecology', 'ecosystem', 'biodiversity', 'ecological community', 'habitat'],
  'bio.evo': ['evolution', 'evolutionary biology', 'population dynamics', 'natural selection', 'phylogeny'],
  'bio.zoo': ['zoology', 'animal biology', 'animal behavior', 'animal physiology'],
  'bio.bot': ['botany', 'plant science', 'plant biology', 'plant physiology', 'photosynthesis'],
  'bio.micro': ['microbiology', 'microbial', 'bacteriology', 'virology', 'fungal biology', 'microbiome'],
  'bio.immuno': ['immunobiology', 'immune system', 'innate immunity', 'adaptive immunity', 't cell', 'b cell'],
  'bio.comp': ['bioinformatics', 'computational biology', 'sequence analysis', 'systems biology', 'biological database'],
  'bio.physio': ['physiology', 'physiological mechanism', 'homeostasis', 'organ function'],
  'bio.biochem': ['biochemistry', 'biochemical', 'metabolism', 'enzyme', 'protein structure'],
  'bio.marine': ['marine biology', 'marine ecosystem', 'ocean biology', 'marine organism'],
  'bio.biotech': ['biotechnology', 'bioengineering', 'synthetic biology', 'bioprocess', 'genetic engineering'],
});

function normalizePubmedText(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCategoryDefinition(categoryId: string|number) {
  for (const area of Object.values(CATEGORIES)) {
    if ((area.subcategories as Record<string, { label: string }>)?.[categoryId]) return (area.subcategories as Record<string, { label: string }>)[categoryId];
  }
  return null;
}

/**
 * The feed's PubMed query for a reader's categories. Each label is searched in
 * every field. Limited to title and abstract (`[tiab]`), the newest matches
 * were mostly reviews and papers that only name the discipline: on 2026-10-21
 * page 0 had 40 % on-target papers for molecular biology and 31 % for
 * neuroscience, against 63 % and 50 % with every field. Every field also
 * matches Methods in Molecular Biology, a protocol series added a volume at a
 * time, so the series is left out by its ISSNs. Only records with a
 * publication date (`[dp]`) by today (UTC) come back, so a recent-first lane
 * is not filled with issues printed next year.
 */
export function pubmedCategoryQuery(categoryIds: readonly string[]) {
  const labels = categoryIds.map(categoryId => getCategoryDefinition(categoryId)?.label).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  const protocolSeries = [...PROTOCOL_SERIES_ISSNS].map(issn => `"${issn}"[is]`).join(' OR ');
  return `(${labels.map(label => `"${label}"`).join(' OR ')}) AND 1800/01/01:${today}[dp] NOT (${protocolSeries})`;
}

function containsTerm(text: string, term: string) {
  return text && term && ` ${text} `.includes(` ${term} `);
}

export function classifyPubmedCategory(paper: Partial<Paper>, internalCategories: string[] = []) {
  const candidates = [...new Set(internalCategories)]
    .filter(categoryId => getCategoryDefinition(categoryId));

  if (candidates.length === 0) return null;

  const title = normalizePubmedText(paper?.title);
  const abstract = normalizePubmedText(paper?.abstract || paper?.summary);
  const subjects = normalizePubmedText([
    ...(paper?.categories || []),
    ...(paper?.keywords || []),
  ].join(' '));

  const ranked = candidates.map((categoryId, index) => {
    const definition = getCategoryDefinition(categoryId);
    const terms = [...new Set([
      definition?.label,
      definition?.label,
      ...(PUBMED_CATEGORY_ALIASES[categoryId] || []),
    ].map(normalizePubmedText).filter(Boolean))];

    const score = terms.reduce((total, term) => {
      const specificity = Math.min(4, term.split(' ').length);
      if (containsTerm(title, term)) total += 8 + specificity;
      if (containsTerm(subjects, term)) total += 10 + specificity;
      if (containsTerm(abstract, term)) total += 3 + specificity;
      return total;
    }, 0);

    return { categoryId, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  if (ranked[0].score <= 0) return null;
  if (ranked[1] && ranked[0].score === ranked[1].score) return null;
  return ranked[0].categoryId;
}

export function assignPubmedCategory(paper: Paper, internalCategories?: string[]) {
  const categoryId = classifyPubmedCategory(paper, internalCategories);
  if (!categoryId) return null;

  const providerCategories = [...new Set([
    ...(paper.categories || []),
    ...(paper.allCategories || []),
  ].filter(Boolean))];

  return {
    ...paper,
    _fetchedFor: internalCategories,
    primaryCategory: categoryId,
    categories: [categoryId, ...providerCategories],
    allCategories: [categoryId, ...providerCategories],
  };
}

// esummary reports the article's own `pubtype` list, which is the only thing in
// the payload that says what a record IS. Reading it is what keeps a peer
// reviewed article from arriving as a preprint: `PaperBuilder` used to default a
// missing type to `preprint`, and this adapter never filled one in.
//
// Ordered: `Preprint` wins over everything (PubMed tags preprints as such and
// nothing else about the record contradicts it), and `Review` before
// `Journal Article` because a review carries both.
const PUBTYPE_MAP: Array<[RegExp, string]> = [
  [/preprint/i, 'preprint'],
  [/review/i, 'review'],
  [/journal article/i, 'article'],
  [/letter|comment|editorial/i, 'letter'],
  [/clinical trial|randomized/i, 'article'],
];

function publicationTypeFromPubtype(pubtype: string | string[] | undefined) {
  const list = Array.isArray(pubtype) ? pubtype : (pubtype ? [pubtype] : []);
  for (const [pattern, type] of PUBTYPE_MAP) {
    if (list.some(entry => pattern.test(String(entry)))) return type;
  }
  return undefined; // unknown stays unknown; PaperBuilder must not default it
}

export function mapPubmedSummary(raw: PubmedSummary, provider = 'pubmed'): Paper {
  let doi: string | null = null;
  let pmc: string | null = null;
  
  if (raw.articleids) {
     const doiObj = raw.articleids.find(id => id.idtype === 'doi');
     if (doiObj) doi = doiObj.value;
     
     const pmcObj = raw.articleids.find(id => id.idtype === 'pmc');
     if (pmcObj) pmc = pmcObj.value;
  }

  const id = raw.uid;
  
  let authors: PaperAuthor[] = [];
  if (raw.authors && Array.isArray(raw.authors)) {
    authors = raw.authors.map(a => ({ name: a.name }));
  }

  const pdfUrl = '';
  // A PMC copy is proof of access; its absence is not proof of a paywall.
  // Deposit takes days to months, so a CC BY paper a day old has none, and a
  // `false` here was painted "Suscripción" (`paperStatus.js` reads an explicit
  // false as a paywall). Unknown lets OpenAlex, Europe PMC or the card's
  // open-access lookup say what it is.
  let isOpenAccess: boolean | undefined;

  if (pmc) {
    isOpenAccess = true;
    // We don't set pdfUrl because PMC PDFs block iframes (X-Frame-Options: SAMEORIGIN)
    // The landing page URL will be used instead, opening natively in a new tab.
  }

  const landingPageUrl = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
  // `pubdate` is the print issue's date, which can be after today for an
  // article already online; `epubdate` is the day it went online. A date
  // after today is never shown, and a record with no other date shows none.
  // An issue named by its year or month alone ("2026", "2026 Oct") reads as
  // that period's first day, so an online day in the same year comes first.
  const issueHasDay = /^\d{4} [a-z]{3} \d/i.test(raw.pubdate || '');
  const onlineFirst = !issueHasDay && raw.epubdate?.slice(0, 4) === raw.pubdate?.slice(0, 4);
  const dates = onlineFirst ? [raw.epubdate, raw.pubdate] : [raw.pubdate, raw.epubdate];
  const published = dates.find(date => date && !isAfterToday(date)) || '';
  const chapter = isProtocolBookSeries({ issn: raw.issn, essn: raw.essn, nlmId: raw.nlmuniqueid });

  return {
    id: `pmid:${id}`,
    pmid: id,
    pmcid: pmc || undefined,
    sources: { primary: provider, enrichedBy: [] },
    title: raw.title || 'Untitled',
    abstract: '', // E-utilities esummary doesn't return full abstract, EFetch is needed for that. We leave it empty and let OpenAlex enrich it if possible.
    authors,
    doi,
    journal: raw.source || '',
    year: parseInt(published.substring(0, 4)) || undefined,
    published,
    publicationStatus: 'published',
    // `book-series` is a venue `isFeedPublication` leaves out of the feed.
    publicationType: chapter ? 'book-chapter' : publicationTypeFromPubtype(raw.pubtype),
    sourceType: chapter ? 'book-series' : undefined,
    openAccess: isOpenAccess,
    pdfUrl,
    landingPageUrl,
    // citationsCount omitted on purpose: esummary has no citation data, and a
    // hard-coded 0 reads downstream as a CONFIRMED zero rather than a gap.
    provider: provider,
    raw
  };
}

type XmlDocumentLike = Parameters<typeof readPubmedEfetch>[0];

/**
 * The papers of one `/sources/pubmed` answer: the esummary records in esearch
 * order, with efetch's abstracts, authors and MeSH terms when `parseXml` can
 * read the efetch XML, filed under the asked categories when any are given.
 */
export function readPubmedPayload(
  pubmedData: PubmedResponse | null | undefined,
  { internalCategories = [], parseXml, provider = 'pubmed' }: { internalCategories?: string[]; parseXml: ((xml: string) => XmlDocumentLike) | null; provider?: string },
) {
  const pmids = pubmedData?.esearchresult?.idlist || [];
  if (pmids.length === 0) return [];
  const summaries = pubmedData?.result || {};
  let mappedPapers = pmids.map(pmid => summaries[pmid]).filter(Boolean).map(item => mapPubmedSummary(item, provider));

  // Abstracts live in the Worker's efetch payload already. Waiting here for
  // OpenAlex + Europe PMC used to keep PubMed last in the 4 s first-page
  // race; those sources still enrich the visible cards through the shared
  // feed/card paths after paint.
  try {
    const xmlText = pubmedData?.efetch || '';
    if (xmlText && parseXml) {
      const enrichmentMap = readPubmedEfetch(parseXml(xmlText));
      mappedPapers = mappedPapers.map((paper) => {
        const enrichment = enrichmentMap[paper.id];
        if (!enrichment) return paper;
        if (enrichment.abstract) paper.abstract = enrichment.abstract;
        // Full names, ORCIDs and affiliations ride with the card's
        // authors (names unchanged) so an author link can say who.
        if ((enrichment.authors?.length as number) > 0) paper.authors = mergePubmedAuthors(paper.authors, enrichment.authors);
        if ((enrichment.categories?.length as number) > 0) {
          paper.categories = enrichment.categories;
          paper.keywords = enrichment.categories;
        }
        return paper;
      });
    }
  } catch (err) {
    console.warn('PubMed efetch could not be read:', err);
  }

  if (internalCategories.length > 0) {
    return mappedPapers
      .map(paper => assignPubmedCategory(paper, internalCategories))
      .filter(Boolean) as Paper[];
  }
  return mappedPapers;
}
