import type { Paper } from '../models/Paper.ts';
import type { EuropePmcRecord } from '../utils/europePmcRecord.ts';

import { mapEuropePmcRecord } from '../utils/europePmcRecord.ts';
import { PaperBuilder } from './PaperBuilder.ts';
import { paperFieldsEqual } from '../utils/feedEnrichment.ts';

export type EuropePmcEnrichment = NonNullable<ReturnType<typeof mapEuropePmcResult>>;
type Enrichment = EuropePmcEnrichment;

// One reader for the payload, shared with the domain-source search mapper:
// `src/utils/europePmcRecord.ts` explains why. What stays here is the shape the
// enrichment path needs -- a patch to merge onto a paper, keyed by PMID.
export function mapEuropePmcResult(result: EuropePmcRecord): (Partial<Paper> & { pmid: string }) | null {
  const record = mapEuropePmcRecord(result);
  const pmid = record.pmid || record.providerId;
  if (!pmid) return null;

  return {
    pmid,
    pmcid: record.pmcid || undefined,
    abstract: record.abstract,
    biomedicalTerms: record.terms,
    concepts: record.terms.map((name, index) => ({
      id: `epmc:${pmid}:${index}`,
      display_name: name,
      level: 2,
    })),
    citationCount: record.citationCount,
    openAccess: record.openAccess,
    landingPageUrl: record.openAccess ? (record.europePmcUrl || undefined) : undefined,
    openAccessPdfUrl: record.pdfUrl || undefined,
    europePmcUrl: record.europePmcUrl || undefined,
    license: record.license,
    hasReferences: record.hasReferences,
    hasData: record.hasData,
    hasSupplement: record.hasSupplement,
    accessSource: record.openAccess ? 'europepmc' : undefined,
  };
}

const CLOSED_RECORD_ACCESS_FIELDS = ['openAccess', 'accessSource', 'landingPageUrl'] as const;

const normalizePmid = (value: unknown) => String(value || '').trim().replace(/^pmid:/i, '');

function unionStrings(base: string[] | undefined, extra: string[] | undefined) {
  return [...new Set([...(base || []), ...(extra || [])].filter(Boolean))];
}

/**
 * Late merge of Europe PMC records into an already painted page.
 *
 * ade641a took this enrichment out of PubmedAdapter.fetchSearch so PubMed
 * would stop losing the first-page race, and nothing picked it up again:
 * PubMed cards lost open access, the PMC PDF, citations and the biomedical
 * terms (audit 2026-09-02, A2). Same identity discipline as
 * mergeICiteEnrichment: a record that changes nothing returns the same
 * object, so memo(PaperCard) keeps its IntersectionObserver.
 */
export function mergeEuropePmcEnrichment(papers: Paper[], recordsByPmid: Map<string, Enrichment> | Record<string, Enrichment>) {
  const lookup = recordsByPmid instanceof Map
    ? recordsByPmid
    : new Map(Object.entries(recordsByPmid || {}));
  if (lookup.size === 0) return papers;

  return papers.map((paper) => {
    const pmid = normalizePmid(paper?.pmid);
    const record = pmid ? lookup.get(pmid) : null;
    if (!record) return paper;

    // Access only ever goes UP, as the adapter code ade641a removed did:
    // PubMed marks a card open the moment a PMC id exists, and an embargoed
    // author manuscript answers isOpenAccess 'N' — handing that to
    // PaperBuilder.merge would flip the card closed a second after it
    // painted. When the record IS open, its landing page replaces PubMed's.
    let patch = record;
    if (!record.openAccess) {
      patch = { ...record };
      for (const field of CLOSED_RECORD_ACCESS_FIELDS) delete patch[field];
    }
    const merged = PaperBuilder.merge(paper, patch, 'europepmc');
    if (record.openAccess && record.landingPageUrl) merged.landingPageUrl = record.landingPageUrl;
    if ((record.biomedicalTerms?.length as number) > 0) {
      // PaperBuilder.merge unions the terms; the categories and keywords the
      // classifier reads are unioned here, the way the old adapter did.
      merged.biomedicalTerms = record.biomedicalTerms;
      merged.categories = unionStrings(merged.categories, record.biomedicalTerms);
      merged.keywords = unionStrings(merged.keywords, record.biomedicalTerms);
    }
    return paperFieldsEqual(merged, paper) ? paper : merged;
  });
}
