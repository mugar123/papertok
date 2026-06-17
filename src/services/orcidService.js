/**
 * ORCID API Service
 * Fetches data from the ORCID Public API (v3.0)
 */

// A simple fetch with timeout, similar to openAlexService
const fetchWithTimeout = async (url, options = {}, timeout = 8000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

/**
 * Validates and extracts a clean ORCID ID from a string or URL.
 * @param {string} input 
 * @returns {string|null} Clean ORCID or null if invalid
 */
export function extractOrcid(input) {
  if (!input) return null;
  const match = input.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Fetch full ORCID record (biography, employments, education, works)
 * @param {string} orcidId 
 * @returns {Promise<Object|null>}
 */
export async function getOrcidRecord(orcidId) {
  const cleanOrcid = extractOrcid(orcidId);
  if (!cleanOrcid) return null;

  const url = `https://pub.orcid.org/v3.0/${cleanOrcid}/record`;
  
  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.warn(`ORCID fetch failed for ${cleanOrcid}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return formatOrcidData(data, cleanOrcid);
  } catch (err) {
    console.error("ORCID fetch exception", err);
    return null;
  }
}

/**
 * Transforms the raw ORCID API response into a more usable format for the UI
 */
function formatOrcidData(data, orcidId) {
  const person = data.person || {};
  const activities = data['activities-summary'] || {};

  // Name
  const nameObj = person.name || {};
  const firstName = nameObj['given-names']?.value || '';
  const lastName = nameObj['family-name']?.value || '';
  const displayName = `${firstName} ${lastName}`.trim();

  // Biography
  const biography = person.biography?.content || null;

  // External URLs
  const researcherUrls = person['researcher-urls']?.['researcher-url']?.map(u => ({
    name: u['url-name'],
    url: u.url?.value
  })) || [];

  // Employments — ORCID v3 uses group.summaries[0]['employment-summary']
  const employments = activities.employments?.['affiliation-group']?.flatMap(group => {
    const items = group['summaries'] || [group]; // v3 uses 'summaries', fallback for older shape
    return items.map(item => {
      const summary = item['employment-summary'];
      if (!summary) return null;
      return {
        organization: summary.organization?.name,
        role: summary['role-title'],
        startDate: summary['start-date']?.year?.value,
        endDate: summary['end-date']?.year?.value || 'Presente'
      };
    });
  }).filter(Boolean) || [];

  // Educations — same structure change
  const educations = activities.educations?.['affiliation-group']?.flatMap(group => {
    const items = group['summaries'] || [group];
    return items.map(item => {
      const summary = item['education-summary'];
      if (!summary) return null;
      return {
        organization: summary.organization?.name,
        role: summary['role-title'],
        startDate: summary['start-date']?.year?.value,
        endDate: summary['end-date']?.year?.value
      };
    });
  }).filter(Boolean) || [];

  // Top Works (just getting titles and years of a few recent works to show activity)
  const worksGroups = activities.works?.group || [];
  const works = worksGroups.map(group => {
    const summary = group['work-summary']?.[0];
    if (!summary) return null;
    return {
      title: summary.title?.title?.value,
      year: summary['publication-date']?.year?.value,
      type: summary.type,
      doi: summary['external-ids']?.['external-id']?.find(id => id['external-id-type'] === 'doi')?.['external-id-value']
    };
  }).filter(Boolean).sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 5);

  return {
    orcid: orcidId,
    displayName,
    biography,
    researcherUrls,
    employments,
    educations,
    works
  };
}
