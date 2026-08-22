import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.js';

/**
 * Builder class for creating unified Paper objects from various adapters
 * and merging metadata from multiple sources.
 */
export class PaperBuilder {
  /**
   * Constructs a new Paper object from base data
   * @param {Object} data 
   * @returns {Paper}
   */
  static create(data) {
    const isPreprint = data.publicationStatus === 'preprint'
      || data.publicationType === 'preprint'
      || !data.publicationType;
    
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
      year: data.year || new Date().getFullYear(),
      publisher: data.publisher || undefined,
      publicationType: data.publicationType || 'preprint',
      publicationStatus: data.publicationStatus || (isPreprint ? 'preprint' : 'published'),
      peerReviewed: data.peerReviewed ?? !isPreprint,
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
      primaryCategory: data.primaryCategory || data.categories?.[0] || '',
      countryCodes: data.countryCodes || [],
      institutionCount: data.institutionCount || 0,
      institutions: data.institutions || [],
      projectIds: data.projectIds || [],
      hasReferences: Boolean(data.hasReferences),
      hasData: Boolean(data.hasData),
      hasSupplement: Boolean(data.hasSupplement),
      fwci: data.fwci ?? null,
      citationNormalizedPercentile: data.citationNormalizedPercentile || data.citation_normalized_percentile || null,
      citedByPercentileYear: data.citedByPercentileYear || data.cited_by_percentile_year || null,
      countsByYear: data.countsByYear || data.counts_by_year || [],
      iciteMetrics: data.iciteMetrics || undefined,
      researchResources: data.researchResources || [],
      published: data.published || data.publishedDate || '',
      sourceType: data.sourceType || undefined,
      summary: data.summary || data.abstract || '',
      _followedEntityMatches: data._followedEntityMatches || [],
      provider: data.provider || undefined,
    };
  }

  /**
   * Merges partial metadata from an enrichment source into an existing Paper.
   * @param {Paper} existingPaper 
   * @param {Object} enrichmentData - Partial paper data from OpenAlex, Elsevier, etc.
   * @param {string} sourceName - e.g., 'openalex'
   * @returns {Paper} A new merged Paper object
   */
  static merge(existingPaper, enrichmentData, sourceName) {
    const merged = { ...existingPaper };

    // Update traceability
    if (sourceName && !merged.sources.enrichedBy.includes(sourceName)) {
      merged.sources = {
        ...merged.sources,
        enrichedBy: [...merged.sources.enrichedBy, sourceName]
      };
    }

    // Normalize DOI from enrichment if existing doesn't have it
    let newDoi = enrichmentData.doi;
    if (newDoi && newDoi.startsWith('https://doi.org/')) {
      newDoi = newDoi.replace('https://doi.org/', '');
    }
    
    if (!merged.doi && newDoi) {
      merged.doi = newDoi;
      // NOTE: Do NOT overwrite merged.id here. The id must remain stable (arXiv ID)
      // so that all subsequent state updates can find the paper by its original ID.
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

    // Merge string fields (prefer existing if they are solid, but enrichment might have better data like journal name)
    if (!merged.journal && enrichmentData.journal) merged.journal = enrichmentData.journal;
    if (!merged.publisher && enrichmentData.publisher) merged.publisher = enrichmentData.publisher;
    if (!merged.conference && enrichmentData.conference) merged.conference = enrichmentData.conference;
    if (!merged.pmid && enrichmentData.pmid) merged.pmid = enrichmentData.pmid;
    if (!merged.pmcid && enrichmentData.pmcid) merged.pmcid = enrichmentData.pmcid;
    if (!merged.europePmcUrl && enrichmentData.europePmcUrl) merged.europePmcUrl = enrichmentData.europePmcUrl;
    if (!merged.openAccessPdfUrl && enrichmentData.openAccessPdfUrl) merged.openAccessPdfUrl = enrichmentData.openAccessPdfUrl;
    if (!merged.license && enrichmentData.license) merged.license = enrichmentData.license;
    if (!merged.accessSource && enrichmentData.accessSource) merged.accessSource = enrichmentData.accessSource;
    
    // Merge numbers
    if (enrichmentData.citationCount !== undefined) {
      merged.citationCount = Math.max(merged.citationCount || 0, enrichmentData.citationCount);
      merged.citationCountKnown = enrichmentData.citationCountKnown ?? true;
    }
    if (enrichmentData.referenceCount !== undefined) {
      merged.referenceCount = Math.max(merged.referenceCount || 0, enrichmentData.referenceCount);
    }

    // Merge arrays
    if (enrichmentData.concepts && enrichmentData.concepts.length > 0) {
      // Deduplicate concepts by ID
      const existingConceptIds = new Set((merged.concepts || []).map(c => c.id));
      const newConcepts = enrichmentData.concepts.filter(c => !existingConceptIds.has(c.id));
      merged.concepts = [...(merged.concepts || []), ...newConcepts];
    }
    if (enrichmentData.topics?.length > 0) merged.topics = enrichmentData.topics;
    if (enrichmentData.primaryTopic || enrichmentData.primary_topic) {
      merged.primaryTopic = enrichmentData.primaryTopic || enrichmentData.primary_topic;
    }
    if (Number.isFinite(enrichmentData.fwci)) merged.fwci = enrichmentData.fwci;
    if (enrichmentData.citationNormalizedPercentile || enrichmentData.citation_normalized_percentile) {
      merged.citationNormalizedPercentile = enrichmentData.citationNormalizedPercentile
        || enrichmentData.citation_normalized_percentile;
    }
    if (enrichmentData.countsByYear?.length || enrichmentData.counts_by_year?.length) {
      merged.countsByYear = enrichmentData.countsByYear || enrichmentData.counts_by_year;
    }
    if (Number.isFinite(enrichmentData.institutionCount)) {
      merged.institutionCount = Math.max(merged.institutionCount || 0, enrichmentData.institutionCount);
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
      const seenResources = new Set();
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
    if (shouldUpgradePublication) {
      merged.publicationType = enrichmentData.publicationType || merged.publicationType;
      merged.publicationStatus = 'published';
    }

    // Re-calculate deterministic fields
    merged.peerReviewed = merged.publicationStatus === 'published'
      && merged.publicationType !== 'preprint';

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
   * @param {Array<Object>} papers - Array of paper objects from adapters
   * @returns {Array<Object>} Deduplicated and merged array
   */
  static deduplicate(papers) {
    if (!papers || papers.length === 0) return [];
    
    const mergedMap = new Map(); // key -> merged paper

    for (const paper of papers) {
      if (!paper) continue;

      // 1. Determine stable deduplication keys before the title heuristic.
      let doiKey = paper.doi ? paper.doi.toLowerCase().trim() : null;
      if (doiKey && doiKey.startsWith('https://doi.org/')) {
        doiKey = doiKey.replace('https://doi.org/', '');
      }

      // Heuristic key: Alphanumeric title + first author's last name
      const cleanTitle = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const firstAuthor = paper.authors && paper.authors.length > 0 ? (paper.authors[0].name || '').toLowerCase().split(' ').pop() : '';
      const heuristicKey = cleanTitle && firstAuthor ? `${cleanTitle}_${firstAuthor}` : null;
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
      const allKeys = [...stableKeys, heuristicKey].filter(Boolean);

      // 2. Find existing match
      const matchKey = allKeys.find(key => mergedMap.has(key)) || null;

      // 3. Merge or Add
      if (matchKey) {
        const existing = mergedMap.get(matchKey);
        // We use merge to combine the two. existing is the base, paper is the "enrichment"
        // We might want to prefer arXiv's PDF, but Elsevier's publication status
        const merged = this.merge(existing, paper, paper.provider || paper.sources?.primary);
        for (const [key, value] of mergedMap.entries()) {
          if (value === existing) mergedMap.set(key, merged);
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
