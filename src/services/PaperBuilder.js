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
    const isPreprint = data.publicationType === 'preprint' || !data.publicationType;
    
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
      doi: doi || undefined,
      journal: data.journal || undefined,
      conference: data.conference || undefined,
      year: data.year || new Date().getFullYear(),
      publisher: data.publisher || undefined,
      publicationType: data.publicationType || 'preprint',
      publicationStatus: data.publicationStatus || (isPreprint ? 'preprint' : 'published'),
      peerReviewed: !isPreprint,
      openAccess: data.openAccess !== undefined ? data.openAccess : true,
      pdfUrl: data.pdfUrl || undefined,
      landingPageUrl: data.landingPageUrl || '',
      citationCount: data.citationCount ?? data.citationsCount ?? 0,
      referenceCount: data.referenceCount || 0,
      concepts: data.concepts || [],
      topics: data.topics || [],
      primaryTopic: data.primaryTopic || data.primary_topic || null,
      keywords: data.keywords || [],
      categories: data.categories || [],
      allCategories: data.allCategories || data.categories || [],
      primaryCategory: data.primaryCategory || data.categories?.[0] || '',
      countryCodes: data.countryCodes || [],
      institutionCount: data.institutionCount || 0,
      fwci: data.fwci ?? null,
      citationNormalizedPercentile: data.citationNormalizedPercentile || data.citation_normalized_percentile || null,
      citedByPercentileYear: data.citedByPercentileYear || data.cited_by_percentile_year || null,
      countsByYear: data.countsByYear || data.counts_by_year || [],
      published: data.published || data.publishedDate || '',
      sourceType: data.sourceType || undefined,
      summary: data.summary || data.abstract || '',
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

    // Merge string fields (prefer existing if they are solid, but enrichment might have better data like journal name)
    if (!merged.journal && enrichmentData.journal) merged.journal = enrichmentData.journal;
    if (!merged.publisher && enrichmentData.publisher) merged.publisher = enrichmentData.publisher;
    if (!merged.conference && enrichmentData.conference) merged.conference = enrichmentData.conference;
    
    // Merge numbers
    if (enrichmentData.citationCount !== undefined) {
      merged.citationCount = Math.max(merged.citationCount || 0, enrichmentData.citationCount);
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

    // Upgrade publication status/type if enrichment indicates it's peer-reviewed/published
    if (
      (enrichmentData.publicationType && enrichmentData.publicationType !== 'preprint') || 
      (enrichmentData.publicationStatus && enrichmentData.publicationStatus === 'published')
    ) {
      merged.publicationType = enrichmentData.publicationType || merged.publicationType;
      merged.publicationStatus = 'published';
    }

    // Re-calculate deterministic fields
    merged.peerReviewed = merged.publicationType !== 'preprint';

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
   * Uses DOI primarily, and Title + First Author as a fallback heuristic.
   * @param {Array<Object>} papers - Array of paper objects from adapters
   * @returns {Array<Object>} Deduplicated and merged array
   */
  static deduplicate(papers) {
    if (!papers || papers.length === 0) return [];
    
    const mergedMap = new Map(); // key -> merged paper

    for (const paper of papers) {
      if (!paper) continue;

      // 1. Determine deduplication keys
      let doiKey = paper.doi ? paper.doi.toLowerCase().trim() : null;
      if (doiKey && doiKey.startsWith('https://doi.org/')) {
        doiKey = doiKey.replace('https://doi.org/', '');
      }

      // Heuristic key: Alphanumeric title + first author's last name
      const cleanTitle = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const firstAuthor = paper.authors && paper.authors.length > 0 ? (paper.authors[0].name || '').toLowerCase().split(' ').pop() : '';
      const heuristicKey = cleanTitle && firstAuthor ? `${cleanTitle}_${firstAuthor}` : null;

      // 2. Find existing match
      let matchKey = null;
      if (doiKey && mergedMap.has(doiKey)) {
        matchKey = doiKey;
      } else if (heuristicKey && mergedMap.has(heuristicKey)) {
        matchKey = heuristicKey;
      }

      // 3. Merge or Add
      if (matchKey) {
        const existing = mergedMap.get(matchKey);
        // We use merge to combine the two. existing is the base, paper is the "enrichment"
        // We might want to prefer arXiv's PDF, but Elsevier's publication status
        const merged = this.merge(existing, paper, paper.provider);
        for (const [key, value] of mergedMap.entries()) {
          if (value === existing) mergedMap.set(key, merged);
        }
        
        // Ensure both keys point to the same merged object to prevent future duplicates missing the link
        if (doiKey) mergedMap.set(doiKey, merged);
        if (heuristicKey) mergedMap.set(heuristicKey, merged);
      } else {
        // Create base paper using the builder to normalize
        const basePaper = this.create(paper);
        if (doiKey) mergedMap.set(doiKey, basePaper);
        if (heuristicKey) mergedMap.set(heuristicKey, basePaper);
        
        // If neither key exists (very rare, no title/author and no DOI), just use ID
        if (!doiKey && !heuristicKey) {
           mergedMap.set(paper.id, basePaper);
        }
      }
    }

    // Since multiple keys might point to the same object reference, we get unique values
    return Array.from(new Set(mergedMap.values()));
  }
}
