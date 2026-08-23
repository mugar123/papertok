import { CATEGORIES } from '../../data/categories.js';
import { openAlexJson } from '../openAlexClient.js';
import { reconstructOpenAlexAbstract } from '../../utils/openAlexAbstract.js';
import { enrichPubmedIds } from '../europePmcService.js';
import { BaseAdapter } from './BaseAdapter.js';
import { readSourceCache, writeSourceCache } from '../../utils/sourceCache.js';
import { fetchWorkerSourceJson } from '../workerApiClient.js';

// E-utilities answer as three serial requests (esearch → esummary → efetch).
// Run from the browser that was 1.35–2.05 s per feed load measured in production,
// with nothing cacheable along the way — the constant floor under every guest
// load — and NCBI counts those requests against the caller's IP, so users behind
// one NAT rate-limited each other. The chain now runs in the Worker, which holds
// the NCBI key, caches the answer at the edge and reserves against a global
// per-minute ceiling. This cache stays as a second tier in front of that one:
// ten minutes of staleness is invisible in a paper feed, and a hit here costs no
// request at all.
const PUBMED_CACHE_TTL_MS = 10 * 60 * 1000;
const PUBMED_PAGE_SIZE = 25;

const PUBMED_CATEGORY_ALIASES = Object.freeze({
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

function normalizePubmedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCategoryDefinition(categoryId) {
  for (const area of Object.values(CATEGORIES)) {
    if (area.subcategories?.[categoryId]) return area.subcategories[categoryId];
  }
  return null;
}

function containsTerm(text, term) {
  return text && term && ` ${text} `.includes(` ${term} `);
}

export function classifyPubmedCategory(paper, internalCategories = []) {
  const candidates = [...new Set(internalCategories)]
    .filter(categoryId => getCategoryDefinition(categoryId));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const title = normalizePubmedText(paper?.title);
  const abstract = normalizePubmedText(paper?.abstract || paper?.summary);
  const subjects = normalizePubmedText([
    ...(paper?.categories || []),
    ...(paper?.keywords || []),
  ].join(' '));

  const ranked = candidates.map((categoryId, index) => {
    const definition = getCategoryDefinition(categoryId);
    const terms = [...new Set([
      definition?.labelEn,
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

function assignPubmedCategory(paper, internalCategories) {
  const categoryId = classifyPubmedCategory(paper, internalCategories);
  if (!categoryId) return null;

  const providerCategories = [...new Set([
    ...(paper.categories || []),
    ...(paper.allCategories || []),
  ].filter(Boolean))];

  return {
    ...paper,
    primaryCategory: categoryId,
    categories: [categoryId, ...providerCategories],
    allCategories: [categoryId, ...providerCategories],
  };
}

export class PubmedAdapter extends BaseAdapter {
  // `workerOptions` is the injection seam `openAlexClient` already uses:
  // `import.meta.env` does not exist under `node --test`, so without it this
  // adapter's network path could only be exercised in a browser.
  constructor(workerOptions = {}) {
    super('pubmed');
    this.workerOptions = workerOptions;
  }

  async search(query, page = 1, filters = {}) {
    const cacheKey = [
      'pubmed',
      query,
      page,
      filters?.type || '',
      [...(filters?.internalCategories || [])].sort().join(','),
    ].join('|');

    const cached = readSourceCache(cacheKey, PUBMED_CACHE_TTL_MS);
    if (cached) return cached;

    const result = await this.fetchSearch(query, page, filters);
    // Errors throw past this point uncached; an empty result is a real answer
    // from PubMed and caches like any other.
    writeSourceCache(cacheKey, result);
    return result;
  }

  async fetchSearch(query, page = 1, filters = {}) {
    try {
      let finalQuery = query;
      if (filters && filters.type === 'author') {
         finalQuery = `${query}[Author]`;
      }

      // 1. The whole E-utilities chain, in one call to the Worker. It returns the
      // three upstream payloads unchanged — esearch, esummary and the efetch XML —
      // so everything below maps exactly what it mapped when the browser fetched
      // them itself.
      const pubmedData = await fetchWorkerSourceJson('/sources/pubmed', {
        q: finalQuery,
        page,
        limit: PUBMED_PAGE_SIZE,
      }, this.workerOptions);

      const pmids = pubmedData?.esearchresult?.idlist || [];
      const total = parseInt(pubmedData?.esearchresult?.count || '0');

      if (pmids.length === 0) {
        return { papers: [], total };
      }

      const summaryData = { result: pubmedData?.result || {} };
      const results = pmids.map(pmid => summaryData.result[pmid]).filter(Boolean);
      let mappedPapers = results.map(item => this.mapToStandard(item));

      // 2. Enrich with EFetch, OpenAlex, and Europe PMC. Every source is optional.
      try {
          const enrichmentMap = {};
          if (pmids.length > 0) {
              // The Worker already fetched this alongside the summaries; an empty
              // string is its way of saying efetch was the half that failed.
              const fetchProm = Promise.resolve(pubmedData?.efetch || '');

              const oaUrl = `https://api.openalex.org/works?filter=ids.pmid:${pmids.join('|')}&select=ids,abstract_inverted_index,concepts`;
              const oaProm = openAlexJson(oaUrl, {
                  timeoutMs: 8000,
                  cacheTtlMs: 24 * 60 * 60 * 1000,
                  staleIfError: true,
              }).catch(() => null);

              const europePmcProm = enrichPubmedIds(pmids).catch(() => new Map());
              
              const [xmlText, oaData, europePmcData] = await Promise.all([fetchProm, oaProm, europePmcProm]);
              
              // Parse XML (EFetch)
              if (xmlText) {
                  const parser = new DOMParser();
                  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                  
                  const articles = xmlDoc.querySelectorAll('PubmedArticle');
                  articles.forEach(article => {
                      const pmidEl = article.querySelector('PMID');
                      if (!pmidEl) return;
                      const pmid = pmidEl.textContent;
                      
                      const abstractTexts = article.querySelectorAll('AbstractText');
                      const abstract = Array.from(abstractTexts).map(el => el.textContent).join(' ');
                      
                      const meshHeadings = article.querySelectorAll('MeshHeading > DescriptorName');
                      const categories = Array.from(meshHeadings).map(el => el.textContent);
                      
                      enrichmentMap[`pmid:${pmid}`] = { abstract, categories };
                  });
              }
              
              // Parse OpenAlex
              if (oaData && oaData.results) {
                  oaData.results.forEach(work => {
                      if (work.ids && work.ids.pmid) {
                          const pmid = work.ids.pmid.split('/').pop();
                          const pmidKey = `pmid:${pmid}`;
                          if (!enrichmentMap[pmidKey]) enrichmentMap[pmidKey] = { abstract: '', categories: [] };
                          
                          const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
                          const categories = work.concepts?.map(c => c.display_name) || [];
                          
                          // Merge (prefer efetch abstract if exists, prefer whichever has categories)
                          if (!enrichmentMap[pmidKey].abstract && abstract) {
                              enrichmentMap[pmidKey].abstract = abstract;
                          }
                          if (enrichmentMap[pmidKey].categories.length === 0 && categories.length > 0) {
                              enrichmentMap[pmidKey].categories = categories;
                          }
                      }
                  });
              }

              mappedPapers = mappedPapers.map(p => {
                const enrichment = enrichmentMap[p.id];
                if (enrichment) {
                  if (enrichment.abstract) p.abstract = enrichment.abstract;
                  if (enrichment.categories && enrichment.categories.length > 0) {
                    p.categories = enrichment.categories;
                    p.keywords = enrichment.categories;
                  }
                }

                const pmid = p.id.replace(/^pmid:/, '');
                const europePmc = europePmcData.get(pmid);
                if (europePmc) {
                  if (!p.abstract && europePmc.abstract) p.abstract = europePmc.abstract;
                  if (europePmc.biomedicalTerms.length > 0) {
                    p.categories = [...new Set([...(p.categories || []), ...europePmc.biomedicalTerms])];
                    p.keywords = [...new Set([...(p.keywords || []), ...europePmc.biomedicalTerms])];
                    p.biomedicalTerms = europePmc.biomedicalTerms;
                    p.concepts = europePmc.concepts;
                  }
                  p.citationsCount = Math.max(p.citationsCount || 0, europePmc.citationCount || 0);
                  p.pmcid = europePmc.pmcid;
                  p.europePmcUrl = europePmc.europePmcUrl;
                  p.openAccessPdfUrl = europePmc.openAccessPdfUrl;
                  p.license = europePmc.license;
                  p.hasReferences = europePmc.hasReferences;
                  p.hasData = europePmc.hasData;
                  p.hasSupplement = europePmc.hasSupplement;
                  if (europePmc.openAccess) {
                    p.openAccess = true;
                    p.accessSource = 'europepmc';
                    if (europePmc.landingPageUrl) p.landingPageUrl = europePmc.landingPageUrl;
                  }
                  p.sources = {
                    ...p.sources,
                    enrichedBy: [...new Set([...(p.sources?.enrichedBy || []), 'europepmc'])],
                  };
                }
                return p;
              });
          }
      } catch (err) {
        console.warn("PubmedAdapter enrichment failed:", err);
      }

      if (filters.internalCategories?.length > 0) {
        mappedPapers = mappedPapers
          .map(paper => assignPubmedCategory(paper, filters.internalCategories))
          .filter(Boolean);
      }

      return { papers: mappedPapers, total };

    } catch (error) {
      console.error("PubmedAdapter Error:", error);
      throw error;
    }
  }

  mapToStandard(raw) {
    let doi = null;
    let pmc = null;
    
    if (raw.articleids) {
       const doiObj = raw.articleids.find(id => id.idtype === 'doi');
       if (doiObj) doi = doiObj.value;
       
       const pmcObj = raw.articleids.find(id => id.idtype === 'pmc');
       if (pmcObj) pmc = pmcObj.value;
    }

    const id = raw.uid;
    
    let authors = [];
    if (raw.authors && Array.isArray(raw.authors)) {
      authors = raw.authors.map(a => ({ name: a.name }));
    }

    let pdfUrl = '';
    let isOpenAccess = false;
    
    if (pmc) {
      isOpenAccess = true;
      // We don't set pdfUrl because PMC PDFs block iframes (X-Frame-Options: SAMEORIGIN)
      // The landing page URL will be used instead, opening natively in a new tab.
    }

    const landingPageUrl = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;

    return {
      id: `pmid:${id}`,
      pmid: id,
      pmcid: pmc || undefined,
      sources: { primary: this.name, enrichedBy: [] },
      title: raw.title || 'Untitled',
      abstract: '', // E-utilities esummary doesn't return full abstract, EFetch is needed for that. We leave it empty and let OpenAlex enrich it if possible.
      authors,
      doi,
      journal: raw.source || '',
      year: raw.pubdate ? parseInt(raw.pubdate.substring(0, 4)) : new Date().getFullYear(),
      published: raw.pubdate || '',
      publicationStatus: 'published',
      openAccess: isOpenAccess,
      pdfUrl,
      landingPageUrl,
      citationsCount: 0,
      provider: this.name,
      raw
    };
  }
}
