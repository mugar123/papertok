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
      citationCount: data.citationCount || 0,
      referenceCount: data.referenceCount || 0,
      concepts: data.concepts || [],
      keywords: data.keywords || [],
      categories: data.categories || []
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

    return merged;
  }
}
