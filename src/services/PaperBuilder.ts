import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';
import { matchesAuthorName } from '../utils/authorNameMatch.ts';
import { normalizeArxivId, normalizeDoi } from '../utils/publicNavigation.ts';

import type { Paper, PaperAuthor } from '../models/Paper.ts';

// Below this many alphanumeric characters a title is not a fingerprint of a
// paper -- "editorial", "introduction", "lettertotheeditor" (17) -- and the
// order-blind author keys in `deduplicate` are not issued for it.
const HEURISTIC_LOOSE_TITLE_MIN_LENGTH = 20;

// OpenAlex calls a working paper `published` as readily as a journal article,
// so its mappers state peer review themselves (`openAlexPeerReviewed`) and a
// gap in that answer stays a gap. Every other provider's `published` is still
// read as a venue's acceptance.
function isOpenAlexRecord(record: Pick<Partial<Paper>, 'sources'>, sourceName?: string) {
  return sourceName === 'openalex' || record.sources?.primary === 'openalex';
}

// Versionless, as `deduplicate` keys it: 2601.00001v2 is the same work.
function arxivIdKey(value: unknown) {
  return normalizeArxivId(value).replace(/v\d+$/, '');
}

// A DOI a publisher issued. arXiv's own DataCite DOI (10.48550/arXiv.<id>)
// names the eprint, as the arXiv id does.
function isPublisherDoi(normalizedDoi: string) {
  return normalizedDoi !== '' && !normalizedDoi.startsWith('10.48550/arxiv.');
}

// The registrant prefix, `10.17016` in 10.17016/feds.2026.007r1.
function doiRegistrant(normalizedDoi: string) {
  return normalizedDoi.split('/')[0];
}

// `merge` lists in `enrichedBy` the source of each record it merges in.
function hasMerged(record: Pick<Partial<Paper>, 'sources'>) {
  return (record.sources?.enrichedBy?.length ?? 0) > 0;
}

// `arxivService` reads any DOI as publication, so an arXiv record without a
// journal reference has nothing else behind its `true`. A merged record that
// does not say the paper was reviewed leaves it so (OpenAlex's record of the
// eprint under arXiv's DOI), yet can give the row a DOI or a journal, "arXiv
// (Cornell University)" among them. So a record's own fields are read before
// its first merge, and `sources.arxivDoiOnly` carries the answer after it.
function restsOnArxivDoi(record: Pick<Partial<Paper>, 'sources' | 'journal' | 'doi'>) {
  return !hasMerged(record)
    ? record.sources?.primary === 'arxiv' && !record.journal && isPublisherDoi(normalizeDoi(record.doi))
    : record.sources?.arxivDoiOnly === true;
}

// A record without a type reads as a preprint, for its status and its answer.
function readsAsPreprint(record: Pick<Partial<Paper>, 'publicationStatus' | 'publicationType'>) {
  return record.publicationStatus === 'preprint'
    || record.publicationType === 'preprint'
    || !record.publicationType;
}

// The answer a record gives of itself, which `create` writes. Another
// provider's record is read from its own type and status. A record that has
// merged another holds the answer `merge` gave it, an unknown included: the
// Explorer deduplicates its rows again with each page, and deriving one
// turned that unknown into `true`.
function ownAnswer(record: Pick<Partial<Paper>, 'peerReviewed' | 'publicationStatus' | 'publicationType' | 'sources'>, sourceName?: string) {
  return record.peerReviewed
    ?? (isOpenAlexRecord(record, sourceName) || hasMerged(record) ? undefined : !readsAsPreprint(record));
}

// The DOI of a record that has merged no other and says of itself, on more
// than an arXiv DOI, that the paper was reviewed. A merged row's answer can
// come from one record and its DOI from another: OpenAlex's journal record
// without a DOI beside the paper's SSRN entry. An untyped Semantic Scholar
// record reads as a preprint by itself, though a row's type can make it read
// published in `merge`.
function ownReviewedDoi(record: Partial<Paper>, sourceName?: string) {
  return !hasMerged(record) && ownAnswer(record, sourceName) === true && !restsOnArxivDoi(record)
    ? normalizeDoi(record.doi)
    : '';
}

/**
 * Builder class for creating unified Paper objects from various adapters
 * and merging metadata from multiple sources.
 */
export class PaperBuilder {
  /**
   * Constructs a new Paper object from base data
   * @param {Partial<Paper>} data
   * @returns {Paper}
   */
  static create(data: Omit<Partial<Paper>, 'arxivId' | 'journal'> & { arxivId?: string | null; journal?: string | null }): Paper {
    // arXiv is the one source whose silence really does mean preprint. For
    // everyone else a missing type is a gap in the record, and writing
    // `preprint` into it turned every PubMed journal article into one.
    const publicationType = data.publicationType
      || ((data.sources?.primary === 'arxiv' || data.provider === 'arxiv') ? 'preprint' : undefined);

    // Normalize DOI
    let doi = data.doi;
    if (doi && doi.startsWith('https://doi.org/')) {
      doi = doi.replace('https://doi.org/', '');
    }
    // Canonical ID preference: Original ID > DOI
    // Using Original ID ensures arXiv IDs remain stable for internal fetching and navigation.
    const canonicalId = data.id || doi || `unknown-${Date.now()}`;
    return {
      id: canonicalId,
      sources: data.sources || { primary: 'unknown', enrichedBy: [] },
      title: data.title || 'Untitled',
      abstract: data.abstract || 'No abstract available.',
      authors: Array.isArray(data.authors) ? data.authors : [],
      arxivId: data.arxivId || undefined,
      pmid: data.pmid || undefined,
      pmcid: data.pmcid || undefined,
      doi: doi || undefined,
      scopusId: data.scopusId || undefined,
      scopusUrl: data.scopusUrl || undefined,
      scopusCitedByUrl: data.scopusCitedByUrl || undefined,
      scopusCitationCount: data.scopusCitationCount ?? undefined,
      adsBibcode: data.adsBibcode || undefined,
      adsUrl: data.adsUrl || undefined,
      inspireId: data.inspireId || undefined,
      inspireUrl: data.inspireUrl || undefined,
      openReviewId: data.openReviewId || undefined,
      openReviewUrl: data.openReviewUrl || undefined,
      openReviewVenueId: data.openReviewVenueId || undefined,
      huggingFaceId: data.huggingFaceId || undefined,
      huggingFaceUrl: data.huggingFaceUrl || undefined,
      huggingFaceUpvotes: data.huggingFaceUpvotes ?? undefined,
      journal: data.journal || undefined,
      conference: data.conference || undefined,
      year: data.year || undefined,
      publisher: data.publisher || undefined,
      publicationType,
      publicationStatus: data.publicationStatus || (readsAsPreprint(data) ? 'preprint' : 'published'),
      peerReviewed: ownAnswer(data),
      workingPaper: data.workingPaper || undefined,
      openAccess: data.openAccess !== undefined ? data.openAccess : true,
      pdfUrl: data.pdfUrl || undefined,
      openAccessPdfUrl: data.openAccessPdfUrl || undefined,
      landingPageUrl: data.landingPageUrl || '',
      europePmcUrl: data.europePmcUrl || undefined,
      accessSource: data.accessSource || undefined,
      license: data.license || undefined,
      citationCount: data.citationCount ?? data.citationsCount ?? 0,
      citationCountKnown: data.citationCountKnown
        ?? (data.citationCount !== undefined || data.citationsCount !== undefined),
      referenceCount: data.referenceCount || 0,
      concepts: data.concepts || [],
      topics: data.topics || [],
      primaryTopic: data.primaryTopic || data.primary_topic || null,
      keywords: data.keywords || [],
      biomedicalTerms: data.biomedicalTerms || [],
      categories: data.categories || [],
      allCategories: data.allCategories || data.categories || [],
      // A provider's own category or nothing. `categories[0]` is a concept
      // name on an OpenAlex record, and as the primary it went into the
      // interactions and the profile as if it were a category (PAP-60).
      primaryCategory: data.primaryCategory || '',
      institutions: data.institutions || [],
      projectIds: data.projectIds || [],
      hasReferences: Boolean(data.hasReferences),
      hasData: Boolean(data.hasData),
      hasSupplement: Boolean(data.hasSupplement),
      iciteMetrics: data.iciteMetrics || undefined,
      researchResources: data.researchResources || [],
      published: data.published || data.publishedDate || '',
      sourceType: data.sourceType || undefined,
      summary: data.summary || data.abstract || '',
      _followedEntityMatches: data._followedEntityMatches || [],
      _fetchedFor: data._fetchedFor?.length ? [...new Set(data._fetchedFor)].sort() : undefined,
      provider: data.provider || undefined,
    };
  }

  /**
   * Merges partial metadata from an enrichment source into an existing Paper.
   * @overload
   * @param {Paper} existingPaper 
   * @param {Partial<Paper>} enrichmentData
   * @param {string} [sourceName]
   * @returns {Paper} A new merged Paper object
   */
  /**
   * Partial records keep their missing fields; merge does not call create.
   * @overload
   * @param {Partial<Paper> & Pick<Paper, 'sources'>} existingPaper
   * @param {Partial<Paper>} enrichmentData
   * @param {string} [sourceName]
   * @returns {Partial<Paper> & Pick<Paper, 'sources'>}
   */
  /**
   * @param {Partial<Paper> & Pick<Paper, 'sources'>} existingPaper
   * @param {Partial<Paper>} enrichmentData
   * @param {string} [sourceName]
   */
  static merge(existingPaper: Paper, enrichmentData: Partial<Paper>, sourceName?: string): Paper;
  static merge(existingPaper: Partial<Paper> & Pick<Paper, 'sources'>, enrichmentData: Partial<Paper>, sourceName?: string): Partial<Paper> & Pick<Paper, 'sources'>;
  static merge(existingPaper: Partial<Paper> & Pick<Paper, 'sources'>, enrichmentData: Partial<Paper>, sourceName?: string) {
    const merged = { ...existingPaper };

    // Update traceability
    if (sourceName && !merged.sources.enrichedBy.includes(sourceName)) {
      merged.sources = {
        ...merged.sources,
        enrichedBy: [...merged.sources.enrichedBy, sourceName]
      };
    }

    // Evidence of publication reopens only a preprint's `false` or a missing
    // answer; a published record's answer stands.
    const reviewOpen = merged.peerReviewed === undefined
      || merged.publicationStatus === 'preprint'
      || merged.publicationType === 'preprint';

    // Normalize DOI from enrichment if existing doesn't have it
    let newDoi = enrichmentData.doi;
    if (newDoi && newDoi.startsWith('https://doi.org/')) {
      newDoi = newDoi.replace('https://doi.org/', '');
    }

    // A working paper's published `false` stands against a record that does
    // not deny review too, so the row stays the working paper and does not
    // take that record's publisher DOI either. The journal's DOI beside a
    // working paper's `false` would give one DOI two answers: the same pair
    // shows it reviewed when the journal version arrives first. Any other
    // `false` (an untyped Semantic Scholar record, a non-refereed ADS one)
    // says nothing about which work the row is, and the DOI fills its gap.
    const keepsOwnFalse = !reviewOpen && merged.peerReviewed === false
      && merged.workingPaper === true && enrichmentData.peerReviewed !== false;
    if (!merged.doi && newDoi && !(keepsOwnFalse && isPublisherDoi(normalizeDoi(newDoi)))) {
      merged.doi = newDoi;
      // NOTE: Do NOT overwrite merged.id here. The id must remain stable (arXiv ID)
      // so that all subsequent state updates can find the paper by its original ID.
    }

    // Every other provider identifier below is carried across; this one was
    // missed, and it decides whether a card can ever show the paper's figure.
    // It only fills a gap: a base that knows its own arXiv id keeps it.
    if (!merged.arxivId && enrichmentData.arxivId) {
      merged.arxivId = enrichmentData.arxivId;
    }

    // Only fills a gap: a source that supplied its own abstract keeps it, since
    // it is the publisher's text rather than a rebuild of OpenAlex's inverted
    // index. `hasUsableAIAbstract` is the criterion the UI and the AI
    // explanation already use for "there is no abstract here".
    if (!hasUsableAIAbstract(merged.abstract) && hasUsableAIAbstract(enrichmentData.abstract)) {
      merged.abstract = enrichmentData.abstract;
      if (!hasUsableAIAbstract(merged.summary)) merged.summary = enrichmentData.abstract;
    }

    if (sourceName === 'scopus') {
      if (!merged.scopusId && enrichmentData.scopusId) merged.scopusId = enrichmentData.scopusId;
      if (!merged.scopusUrl && enrichmentData.scopusUrl) merged.scopusUrl = enrichmentData.scopusUrl;
      if (!merged.scopusCitedByUrl && enrichmentData.scopusCitedByUrl) merged.scopusCitedByUrl = enrichmentData.scopusCitedByUrl;
      if (merged.scopusCitationCount === undefined && enrichmentData.scopusCitationCount !== undefined) {
        merged.scopusCitationCount = enrichmentData.scopusCitationCount;
      }
    }
    if (!merged.adsBibcode && enrichmentData.adsBibcode) merged.adsBibcode = enrichmentData.adsBibcode;
    if (!merged.adsUrl && enrichmentData.adsUrl) merged.adsUrl = enrichmentData.adsUrl;
    if (!merged.inspireId && enrichmentData.inspireId) merged.inspireId = enrichmentData.inspireId;
    if (!merged.inspireUrl && enrichmentData.inspireUrl) merged.inspireUrl = enrichmentData.inspireUrl;
    if (!merged.openReviewId && enrichmentData.openReviewId) merged.openReviewId = enrichmentData.openReviewId;
    if (!merged.openReviewUrl && enrichmentData.openReviewUrl) merged.openReviewUrl = enrichmentData.openReviewUrl;
    if (!merged.openReviewVenueId && enrichmentData.openReviewVenueId) merged.openReviewVenueId = enrichmentData.openReviewVenueId;
    if (!merged.huggingFaceId && enrichmentData.huggingFaceId) merged.huggingFaceId = enrichmentData.huggingFaceId;
    if (!merged.huggingFaceUrl && enrichmentData.huggingFaceUrl) merged.huggingFaceUrl = enrichmentData.huggingFaceUrl;
    if (merged.huggingFaceUpvotes === undefined && enrichmentData.huggingFaceUpvotes !== undefined) {
      merged.huggingFaceUpvotes = enrichmentData.huggingFaceUpvotes;
    }

    // A `false` and the working-paper tag describe the record that sent them,
    // so the row takes them only while it keeps that record's identity: the
    // base had no DOI, or both share a DOI, or the base's only DOI is arXiv's
    // own and both share an arXiv id. A shared eprint never outranks a
    // publisher's DOI on the base, whether the other record has a DOI or not.
    // `deduplicate` also joins a journal article and its working paper on
    // title and first author, or on an eprint both list: OpenAlex can file an
    // arXiv eprint among a FEDS paper's locations while arXiv lists the
    // journal's DOI for it. A row that keeps the article's DOI and journal is
    // not the working paper.
    // An arXiv record whose only claim is a DOI from a working paper's own
    // registrant is that working paper too: arXiv can list a FEDS revision,
    // 10.17016/feds.2026.007r1, for the paper OpenAlex files as
    // 10.17016/feds.2026.007. The evidence covers the listed series: in
    // Crossref on 2026-10-20, the prefix of each series in
    // `WORKING_PAPER_SOURCE_IDS` held only its institution's own
    // publications. `workingPaper` also marks every OpenAlex `report`, and
    // some report registrants issue journals too (the St. Louis Fed its Review
    // under 10.20955). An arXiv record that names its journal, has no DOI of
    // its own or has merged a record under that DOI saying, on more than an
    // arXiv DOI, that the paper was reviewed therefore keeps its own answer,
    // as does a record from another provider; an arXiv record listing the
    // Review's DOI without a journal reference still reads as the report.
    // Only a working paper gets this reading: Springer registers journal
    // articles and chapters alike under 10.1007.
    const baseDoi = normalizeDoi(existingPaper.doi);
    const enrichmentDoi = normalizeDoi(enrichmentData.doi);
    const baseArxivId = arxivIdKey(existingPaper.arxivId);
    const arxivDoiOnly = restsOnArxivDoi(existingPaper);
    const sameRecord = !existingPaper.doi
      || (baseDoi !== '' && baseDoi === enrichmentDoi)
      || (arxivDoiOnly && enrichmentData.workingPaper === true && enrichmentDoi !== ''
        && doiRegistrant(baseDoi) === doiRegistrant(enrichmentDoi))
      || (!isPublisherDoi(baseDoi)
        && baseArxivId !== '' && baseArxivId === arxivIdKey(enrichmentData.arxivId));
    // A working paper the row is not. Its `false` and tag stay off the row
    // (below), and so do its series name and institution.
    const otherWorkingPaper = enrichmentData.workingPaper === true
      && enrichmentData.peerReviewed === false && !sameRecord;

    // Merge string fields (prefer existing if they are solid, but enrichment might have better data like journal name)
    // A working paper that keeps its `false` takes neither the other record's
    // journal nor its publisher: like that record's DOI, they would put the
    // journal version's venue on the unreviewed working paper. Nor does a row
    // take the series and institution of a working paper it is not. A `false`
    // from a record that is no working paper (a non-refereed NASA ADS one)
    // still comes with the same work's venue.
    const takesVenue = !keepsOwnFalse && !otherWorkingPaper;
    if (!merged.journal && enrichmentData.journal && takesVenue) merged.journal = enrichmentData.journal;
    if (!merged.publisher && enrichmentData.publisher && takesVenue) merged.publisher = enrichmentData.publisher;
    if (!merged.conference && enrichmentData.conference) merged.conference = enrichmentData.conference;
    if (!merged.pmid && enrichmentData.pmid) merged.pmid = enrichmentData.pmid;
    if (!merged.pmcid && enrichmentData.pmcid) merged.pmcid = enrichmentData.pmcid;
    if (!merged.europePmcUrl && enrichmentData.europePmcUrl) merged.europePmcUrl = enrichmentData.europePmcUrl;
    if (!merged.openAccessPdfUrl && enrichmentData.openAccessPdfUrl) merged.openAccessPdfUrl = enrichmentData.openAccessPdfUrl;
    if (!merged.license && enrichmentData.license) merged.license = enrichmentData.license;
    if (!merged.accessSource && enrichmentData.accessSource) merged.accessSource = enrichmentData.accessSource;
    
    // Merge numbers
    // Adapters speak `citationsCount` and only `create` translates it, so a raw
    // duplicate arriving through `deduplicate` carried its count in the name
    // this branch never read.
    const incomingCount = enrichmentData.citationCount ?? enrichmentData.citationsCount;
    if (incomingCount !== undefined && incomingCount !== null) {
      merged.citationCount = Math.max(merged.citationCount || 0, incomingCount);
      merged.citationCountKnown = enrichmentData.citationCountKnown ?? true;
    }
    if (enrichmentData.referenceCount !== undefined) {
      merged.referenceCount = Math.max(merged.referenceCount || 0, enrichmentData.referenceCount);
    }

    // An author with an OpenAlex id opens their page in one request; without
    // one the explorer has to find them again from the name, which measured
    // 2462 ms against 433. arXiv never supplies ids, so this is where a card's
    // authors get theirs.
    //
    // The id is GRAFTED, never substituted: OpenAlex writes "Cuello, N." where
    // arXiv writes "Nicolás Cuello", and taking its list whole would rewrite
    // the names on a card seconds after it painted, in a different order. So
    // the name a paper already has is matched against the enrichment and only
    // the id travels. An author the enrichment does not name, or does not
    // disambiguate, is left exactly as it was.
    if (enrichmentData.authors?.length) {
      if (!merged.authors?.length) {
        merged.authors = enrichmentData.authors;
      } else {
        const candidates = enrichmentData.authors as Array<PaperAuthor>;
        // Same work, same order on both sides: when the lists are the same
        // length the POSITION is the identity, and the name only confirms it.
        // Otherwise a name may carry an id only when exactly one candidate
        // matches it — "J. Smith" against two Smiths keeps the slow door
        // rather than opening the wrong one (2026-09-09 review).
        const byPosition = candidates.length === merged.authors.length;
        merged.authors = merged.authors.map((author, index) => {
          if (typeof author === 'string' || author?.id) return author;
          const positional = byPosition ? candidates[index] : null;
          if (positional?.id && matchesAuthorName(author?.name, positional?.name)) {
            return { ...author, id: positional.id };
          }
          const matches = candidates.filter(candidate => candidate?.id
            && matchesAuthorName(author?.name, candidate?.name));
          return matches.length === 1 ? { ...author, id: matches[0].id } : author;
        });
      }
    }

    // Merge arrays
    if (enrichmentData.concepts && enrichmentData.concepts.length > 0) {
      // Deduplicate concepts by ID
      const existingConceptIds = new Set((merged.concepts || []).map(c => c.id));
      const newConcepts = enrichmentData.concepts.filter(c => !existingConceptIds.has(c.id));
      merged.concepts = [...(merged.concepts || []), ...newConcepts];
    }
    if ((enrichmentData.topics?.length as number) > 0) merged.topics = enrichmentData.topics;
    if (enrichmentData.primaryTopic || enrichmentData.primary_topic) {
      merged.primaryTopic = enrichmentData.primaryTopic || enrichmentData.primary_topic;
    }
    // arXiv's categories are the paper's own classification, so they are taken
    // whichever record arrived first. An OpenAlex base lists concept names as
    // categories ("Mutual information" for 2605.02209, which arXiv files under
    // cs.AI); they stay in `concepts`. A record without an arXiv primary, such
    // as the abstract recovery, changes no category.
    if (enrichmentData.sources?.primary === 'arxiv' && enrichmentData.primaryCategory) {
      merged.primaryCategory = enrichmentData.primaryCategory;
      merged.categories = enrichmentData.categories;
      merged.allCategories = enrichmentData.allCategories || enrichmentData.categories;
    }
    if (enrichmentData.institutions?.length) {
      const institutions = [...(merged.institutions || []), ...enrichmentData.institutions];
      merged.institutions = institutions.filter((institution, index) => {
        const key = institution.id || institution.ror || institution.displayName || institution.display_name;
        return institutions.findIndex(candidate => (candidate.id || candidate.ror || candidate.displayName || candidate.display_name) === key) === index;
      });
    }
    if (enrichmentData.projectIds?.length) {
      merged.projectIds = [...new Set([...(merged.projectIds || []), ...enrichmentData.projectIds])];
    }
    if (enrichmentData.biomedicalTerms?.length) {
      merged.biomedicalTerms = [...new Set([...(merged.biomedicalTerms || []), ...enrichmentData.biomedicalTerms])];
    }
    if (enrichmentData.researchResources?.length) {
      const resources = [...(merged.researchResources || []), ...enrichmentData.researchResources];
      const seenResources = new Set<string>();
      merged.researchResources = resources.filter(resource => {
        const key = `${resource?.kind || ''}:${resource?.url || resource?.id || ''}`.toLowerCase();
        if (!resource || !key || seenResources.has(key)) return false;
        seenResources.add(key);
        return true;
      });
    }
    if (enrichmentData.iciteMetrics) {
      merged.iciteMetrics = { ...(merged.iciteMetrics || {}), ...enrichmentData.iciteMetrics };
    }
    merged.hasReferences = Boolean(merged.hasReferences || enrichmentData.hasReferences);
    merged.hasData = Boolean(merged.hasData || enrichmentData.hasData);
    merged.hasSupplement = Boolean(merged.hasSupplement || enrichmentData.hasSupplement);

    // Upgrade publication status/type if enrichment indicates it's peer-reviewed/published
    const hasExplicitPublicationStatus = enrichmentData.publicationStatus !== undefined;
    const shouldUpgradePublication = enrichmentData.publicationStatus === 'published'
      || (!hasExplicitPublicationStatus
        && enrichmentData.publicationType
        && !['preprint', 'repository'].includes(enrichmentData.publicationType));
    // A merged row that shows another DOI can hold a record that said, under
    // this row's DOI, that the paper was reviewed (`sources.reviewedDoi`,
    // below). For this row it then answers as that record would, whatever its
    // own answer, which is about the DOI it shows: the followed feed joins
    // topic rows that began as the paper's SSRN entry, or as an arXiv record
    // listing a FEDS revision's DOI, with OpenAlex's journal article in them.
    // A row under this DOI already answers for it.
    const confirmsBaseDoi = baseDoi !== '' && enrichmentDoi !== baseDoi
      && enrichmentData.sources?.reviewedDoi === baseDoi;
    const incomingAnswer = confirmsBaseDoi ? true : enrichmentData.peerReviewed;
    // A published record that says outright it was not reviewed wins from
    // either side, so an IMF working paper that another provider also lists as
    // published stays unreviewed whichever record arrives first. It does not
    // replace an OpenAlex `true`, which is the base's own venue evidence
    // (`create` derives none for OpenAlex).
    const reviewDenied = incomingAnswer === false
      && !(merged.peerReviewed === true && isOpenAlexRecord(merged));
    if (shouldUpgradePublication) {
      merged.publicationType = enrichmentData.publicationType || merged.publicationType;
      merged.publicationStatus = 'published';
    }

    // Re-read only when the enrichment brought publication evidence of its own.
    // A merge that carried nothing but an abstract once overwrote an explicit
    // `peerReviewed: false` with `true`, and deriving an answer for a record
    // that had none turned OpenAlex's unknown into `true` the same way. Nor is
    // one derived for a record that has merged another, as in `create`: the
    // followed feed and the Explorer merge rows that are already merged.
    const enrichmentReview = shouldUpgradePublication
      ? incomingAnswer
        ?? (isOpenAlexRecord(enrichmentData, sourceName) || hasMerged(enrichmentData)
          ? undefined
          : merged.publicationType !== 'preprint')
      : undefined;
    // The row and the incoming record can both rest on an arXiv DOI: a topic
    // gets the same arXiv record from its category listing and its query, and
    // the followed feed joins a name-only author's arXiv records with a
    // topic's rows, which may already have merged a working paper. Neither
    // side's `true` says more than that DOI, so the incoming record does not
    // end `sources.arxivDoiOnly` (below), and an answer other than `true` on
    // either side stands: a record merged earlier, such as a working paper,
    // already read the DOI otherwise.
    const bothRestOnArxivDoi = arxivDoiOnly && restsOnArxivDoi(enrichmentData) && !confirmsBaseDoi;
    // A `true` speaks for the DOI it came with. OpenAlex files the eprint
    // among the locations of the journal version and of the FEDS paper alike,
    // while arXiv lists the FEDS revision's DOI. Beside a row whose `true`
    // rests on that DOI alone, the journal record's `true` is another
    // version's: it neither ends the reading (below) nor answers for a row
    // that reads unknown. A row showing arXiv's own DOI names the eprint
    // rather than a version, so any record's `true` still counts for it.
    const otherDoiTrue = arxivDoiOnly && enrichmentReview === true && !confirmsBaseDoi
      && isPublisherDoi(baseDoi) && enrichmentDoi !== baseDoi;
    // A `true` the row already reads on more than an arXiv DOI stands, and
    // another `true` adds nothing to it. A merged preprint row can reopen the
    // journal article's answer, and an arXiv record's DOI would otherwise
    // become all that answer rests on.
    const repeatsTrue = merged.peerReviewed === true && !arxivDoiOnly && enrichmentReview === true;
    const rereads = !repeatsTrue && !bothRestOnArxivDoi && !otherDoiTrue && Boolean(shouldUpgradePublication)
      && (reviewOpen || reviewDenied) && (incomingAnswer !== false || sameRecord);
    if (bothRestOnArxivDoi) {
      if (merged.peerReviewed === true) merged.peerReviewed = enrichmentData.peerReviewed;
    } else if (rereads) {
      merged.peerReviewed = enrichmentReview;
    }
    // A `false` the row does not take, a working paper's or a published
    // record's, still contradicts a `true` that rests on a DOI alone. The
    // published record can be a row that merged a working paper: OpenAlex can
    // file one without the eprint, so it joins OpenAlex's preprint record on
    // title and first author, and that row reads published but keeps the
    // preprint's `false` and no tag. The DOI may be the journal version's, the
    // paper's own SSRN entry or the working paper's when OpenAlex lists none,
    // so the answer is unknown rather than either record's. The `true` can
    // also come later: search lists OpenAlex's works (a journal DOI without a
    // source, which reads unknown, and the working paper) before arXiv's
    // record, and the followed feed puts an arXiv record before a topic row
    // that has already joined OpenAlex's journal article and the working
    // paper. So `sources.deniedElsewhere` records that the row left off such
    // a `false`, and the row takes it from a merged record that left one off.
    const deniedElsewhere = (enrichmentData.peerReviewed === false && !sameRecord
      && (otherWorkingPaper || Boolean(shouldUpgradePublication)))
      || existingPaper.sources.deniedElsewhere === true || enrichmentData.sources?.deniedElsewhere === true;
    // The working-paper tag explains a `false`. It comes with the `false` of
    // the same record, and with one taken above from a row that rests on an
    // arXiv DOI as this one does, though that row may show the DOI of
    // OpenAlex's preprint record. It stays while the answer is `false`, and
    // goes when a venue's `true` stands, as for the journal article whose
    // working paper merged in.
    const workingPaper = merged.peerReviewed === false
      && (merged.workingPaper === true
        || ((sameRecord || bothRestOnArxivDoi) && enrichmentData.workingPaper === true));
    // Written only when it changes: a merge that adds nothing must return a
    // paper equal to the one it got (`paperFieldsEqual`), key for key.
    if (workingPaper !== (merged.workingPaper === true)) merged.workingPaper = workingPaper || undefined;
    // A merged record whose own answer is `true` under the row's DOI, such as
    // OpenAlex's record of the journal article the arXiv record lists, backs
    // the row's; until one does, the `true` rests on the arXiv record's DOI
    // alone. Every other provider's `published` still counts (see
    // `isOpenAlexRecord`), an untyped Semantic Scholar record's or CORE's
    // included. A row that takes its answer from a record resting on an arXiv
    // DOI rests on it too, whatever record it began as: a topic with an
    // OpenAlex id lists OpenAlex's record of the eprint under arXiv's DOI
    // before the arXiv record. A record under the row's DOI that a merged row
    // holds backs it too, whatever that row's own answer.
    const stillArxivDoiOnly = !confirmsBaseDoi
      && ((arxivDoiOnly && (enrichmentReview !== true || otherDoiTrue || bothRestOnArxivDoi))
        || (rereads && restsOnArxivDoi(enrichmentData)));
    // After this merge's own answer, which may be such a `true`.
    if (deniedElsewhere && stillArxivDoiOnly && merged.peerReviewed === true) merged.peerReviewed = undefined;
    if (stillArxivDoiOnly !== (merged.sources.arxivDoiOnly === true)) {
      merged.sources = { ...merged.sources, arxivDoiOnly: stillArxivDoiOnly || undefined };
    }
    if (deniedElsewhere !== (merged.sources.deniedElsewhere === true)) {
      merged.sources = { ...merged.sources, deniedElsewhere: deniedElsewhere || undefined };
    }
    // `sources.reviewedDoi`, whatever the row's own answer and the DOI it
    // shows. The base's comes first, then the incoming row's.
    const reviewedDoi = existingPaper.sources.reviewedDoi || ownReviewedDoi(existingPaper)
      || enrichmentData.sources?.reviewedDoi || ownReviewedDoi(enrichmentData, sourceName) || undefined;
    if (reviewedDoi !== merged.sources.reviewedDoi) {
      merged.sources = { ...merged.sources, reviewedDoi };
    }

    // Open Access logic
    if (enrichmentData.openAccess !== undefined) {
      // If enrichment says it's NOT open access, but our base model thinks it IS (e.g. arXiv),
      // we usually trust the base model for preprints. But if it's a journal article, we might
      // trust the enrichment.
      if (merged.pdfUrl) {
        merged.openAccess = true; // If we have a PDF URL, it's definitely OA
      } else {
        merged.openAccess = enrichmentData.openAccess;
      }
    }

    if (!merged.pdfUrl && enrichmentData.pdfUrl) {
      merged.pdfUrl = enrichmentData.pdfUrl;
      merged.openAccess = true;
    }

    if (sourceName === 'openalex') {
      merged.openAlex = enrichmentData;
    }

    return merged;
  }

  /**
   * Deduplicates and merges an array of papers coming from different adapters.
   * Uses stable provider identifiers before Title + First Author as a fallback heuristic.
   * @param {Array<Partial<Paper> | null | undefined> | null | undefined} papers
   * @returns {Paper[]} Deduplicated and merged array
   */
  static deduplicate(papers: Array<Partial<Paper>|null|undefined>|null|undefined): Paper[] {
    if (!papers || papers.length === 0) return [];
    
    const mergedMap = new Map<string | undefined | null, Paper>(); // key -> merged paper

    for (const paper of papers) {
      if (!paper) continue;

      // 1. Determine stable deduplication keys before the title heuristic.
      let doiKey = paper.doi ? paper.doi.toLowerCase().trim() : null;
      if (doiKey && doiKey.startsWith('https://doi.org/')) {
        doiKey = doiKey.replace('https://doi.org/', '');
      }

      // Heuristic key: Alphanumeric title + first author's last name
      const cleanTitle = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const firstAuthorName = paper.authors && paper.authors.length > 0
        ? String((paper.authors[0] as PaperAuthor)?.name ?? paper.authors[0] ?? '')
        : '';
      const firstAuthor = firstAuthorName.toLowerCase().split(' ').pop();
      const heuristicKey = cleanTitle && firstAuthor ? `${cleanTitle}_${firstAuthor}` : null;
      // The same paper under two records of one provider, with the first
      // author's name in two orders: OpenAlex carries HQ-SAM (arXiv
      // 2306.01567) as a preprint by "Ke Jian Lei" and as a NeurIPS paper by
      // "Lei Ke", each under its own DOI, so neither the DOI nor the last
      // token of the name ("lei" / "ke") could join them, and the search
      // showed the paper twice (2026-09-22). One key per token of the name is
      // order-blind: any shared token on an identical title is a match, and
      // the bridging below folds the groups. Only for a title long enough to
      // be a fingerprint on its own -- "Editorial" or "Introduction" with a
      // shared "Wei" is not the same paper -- and never for a lone initial.
      const looseTitleKeys = cleanTitle.length >= HEURISTIC_LOOSE_TITLE_MIN_LENGTH
        ? [...new Set(
          firstAuthorName
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter(token => token.length >= 2),
        )].map(token => `${cleanTitle}~${token}`)
        : [];
      const idValue = String(paper.id || '');
      const normalizedArxivId = String(
        paper.arxivId
        || paper.huggingFaceId
        || (idValue.toLowerCase().startsWith('arxiv:') ? idValue : ''),
      )
        .trim()
        .replace(/^arxiv:/i, '')
        .replace(/v\d+$/i, '')
        .toLowerCase();
      const stableKeys = [
        doiKey,
        normalizedArxivId ? `arxiv:${normalizedArxivId}` : null,
        (paper.pmid || idValue.toLowerCase().startsWith('pmid:'))
          ? `pmid:${String(paper.pmid || idValue).replace(/^pmid:/i, '')}`
          : null,
        (paper.openReviewId || idValue.toLowerCase().startsWith('openreview:'))
          ? `openreview:${String(paper.openReviewId || idValue).replace(/^openreview:/i, '').toLowerCase()}`
          : null,
        paper.scopusId ? `scopus:${String(paper.scopusId).toLowerCase()}` : null,
        paper.adsBibcode ? `ads:${String(paper.adsBibcode).toLowerCase()}` : null,
        paper.inspireId ? `inspire:${String(paper.inspireId).toLowerCase()}` : null,
      ].filter(Boolean);
      const allKeys = [...stableKeys, heuristicKey, ...looseTitleKeys].filter(Boolean);

      // 2. Every group any of our keys already points at.
      //
      // A record carrying two identifiers is the BRIDGE between groups that had
      // no key in common — arXiv under its id, Crossref under its DOI, and the
      // OpenAlex work that knows both. Taking only the first matching key merged
      // into one group and then repointed the other group's keys at the result,
      // so that group fell out of the map and its paper was silently dropped.
      const groups = [...new Set(allKeys.map(key => mergedMap.get(key)).filter(Boolean) as Paper[])];

      // 3. Merge or Add
      if (groups.length > 0) {
        // Fold the groups into each other first, then the incoming record.
        // We use merge to combine them. The first group is the base, everything
        // else is the "enrichment": we might want to prefer arXiv's PDF, but
        // Elsevier's publication status.
        let base = groups[0];
        for (const other of groups.slice(1)) {
          base = this.merge(base, other, other.provider || other.sources?.primary);
        }
        const merged = this.merge(base, paper, paper.provider || paper.sources?.primary);
        for (const [key, value] of mergedMap.entries()) {
          if (groups.includes(value)) mergedMap.set(key, merged);
        }
        
        // Ensure both keys point to the same merged object to prevent future duplicates missing the link
        allKeys.forEach(key => mergedMap.set(key, merged));
      } else {
        // Create base paper using the builder to normalize
        const basePaper = this.create(paper);
        allKeys.forEach(key => mergedMap.set(key, basePaper));
        
        // If neither key exists (very rare, no title/author and no DOI), just use ID
        if (allKeys.length === 0) {
           mergedMap.set(paper.id, basePaper);
        }
      }
    }

    // Since multiple keys might point to the same object reference, we get unique values
    return Array.from(new Set(mergedMap.values()));
  }
}
