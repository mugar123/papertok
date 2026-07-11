export const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

async function fetchWithTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/** Validate that a string is a plausible 3-letter ISO 4217 currency code */
function validCurrency(code) {
  if (!code || typeof code !== 'string') return 'EUR';
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : 'EUR';
}

/**
 * Extract funder info from the fundingtree structure.
 * fundingtree can be an array of objects or a single object,
 * and funder shortname/name use the {"$": "value"} pattern.
 */
function extractFunder(p) {
  let funderName = "Funder desconocido";
  let fundingStream = "";
  
  let tree = p.fundingtree;
  if (!tree) return { funderName, fundingStream };
  
  // Normalize to array
  if (!Array.isArray(tree)) tree = [tree];
  
  const first = tree[0];
  if (!first?.funder) return { funderName, fundingStream };
  
  const funder = first.funder;
  if (funder.shortname?.["$"]) funderName = funder.shortname["$"];
  else if (funder.name?.["$"]) funderName = funder.name["$"];
  
  if (first.funding_level_0?.name?.["$"]) fundingStream = first.funding_level_0.name["$"];
  
  return { funderName, fundingStream };
}

export async function getProjectDetails(projectId) {
  if (!projectId) return null;
  const url = `https://api.openaire.eu/search/projects?format=json&size=1&grantID=${encodeURIComponent(projectId)}`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.response?.results?.result) return null;
    
    let res = data.response.results.result;
    if (Array.isArray(res)) res = res[0];
    
    const p = res?.metadata?.["oaf:entity"]?.["oaf:project"];
    if (!p) return null;
    
    const { funderName, fundingStream } = extractFunder(p);

    // Use fundedamount as fallback when totalcost is 0
    const totalCost = parseFloat(p.totalcost?.["$"]) || 0;
    const fundedAmount = parseFloat(p.fundedamount?.["$"]) || 0;
    const budget = totalCost > 0 ? totalCost : fundedAmount;

    // Extract subjects/topics
    let subjects = [];
    if (p.subject) {
      const subArr = Array.isArray(p.subject) ? p.subject : [p.subject];
      subjects = [...new Set(subArr.map(s => s["$"]).filter(Boolean))];
    }

    // Extract participant organizations
    let participants = [];
    if (p.rels?.rel) {
      const rels = Array.isArray(p.rels.rel) ? p.rels.rel : [p.rels.rel];
      participants = rels
        .filter(r => r.to?.["@class"] === "hasParticipant")
        .map(r => ({
          name: r.legalshortname?.["$"] || r.legalname?.["$"] || "Unknown",
          country: r.country?.["@classname"] || null,
          website: r.websiteurl?.["$"] || null,
        }));
    }

    // Extract impact measures
    const measures = {};
    if (p.measure) {
      const mArr = Array.isArray(p.measure) ? p.measure : [p.measure];
      for (const m of mArr) {
        if (m["@id"] === "totalCitationCount") measures.citations = parseInt(m["@score"]) || 0;
        if (m["@id"] === "downloads") measures.downloads = parseInt(m["@count"]) || 0;
        if (m["@id"] === "views") measures.views = parseInt(m["@count"]) || 0;
        if (m["@id"] === "numOfInfluentialResults") measures.influentialResults = parseInt(m["@score"]) || 0;
      }
    }

    return {
      id: p.code?.["$"],
      title: p.title?.["$"] || "Unknown Project",
      acronym: p.acronym?.["$"] || null,
      funder: funderName,
      fundingStream,
      summary: p.summary?.["$"],
      startDate: p.startdate?.["$"],
      endDate: p.enddate?.["$"],
      budget,
      fundedAmount,
      currency: validCurrency(p.currency?.["$"]),
      callIdentifier: p.callidentifier?.["$"] || null,
      contractType: p.contracttype?.["@classname"] || null,
      websiteUrl: p.websiteurl?.["$"] || null,
      subjects,
      participants,
      measures,
      openAccess: p.oamandatepublications?.["$"] === true,
    };
  } catch (e) {
    console.error("Error fetching project details:", e);
    return null;
  }
}

/**
 * Get project info from OpenAIRE using arXiv ID or DOI
 */
export async function getProjectForPaper(arxivId, doi) {
  if (!arxivId && !doi) return null;
  
  const cacheKey = `project_${arxivId || doi}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }

  try {
    let url = 'https://api.openaire.eu/search/publications?format=json&size=1';
    if (doi) {
      url += `&doi=${encodeURIComponent(doi)}`;
    } else {
      url += `&pid=${encodeURIComponent(arxivId)}`;
    }

    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.response?.results?.result || data.response.results.result.length === 0) {
        if (doi && arxivId) {
             const urlArxiv = `https://api.openaire.eu/search/publications?format=json&size=1&pid=${encodeURIComponent(arxivId)}`;
             const resArxiv = await fetchWithTimeout(urlArxiv);
             if (resArxiv.ok) {
                 const dataArxiv = await resArxiv.json();
                 if (dataArxiv?.response?.results?.result?.length > 0) {
                     const proj = parseProjectFromResult(dataArxiv.response.results.result[0]);
                     if (proj) {
                        CACHE.set(cacheKey, { data: proj, timestamp: Date.now() });
                        return proj;
                     }
                 }
             }
        }
        return null;
    }

    const project = parseProjectFromResult(data.response.results.result[0]);
    if (project) {
        CACHE.set(cacheKey, { data: project, timestamp: Date.now() });
    }
    return project;
  } catch (err) {
    console.error("Error fetching OpenAIRE project:", err);
    return null;
  }
}

function parseProjectFromResult(result) {
  try {
    let rels = result?.metadata?.["oaf:entity"]?.["oaf:result"]?.rels?.rel;
    if (!rels) return null;
    
    if (!Array.isArray(rels)) rels = [rels];
    
    for (const rel of rels) {
      if (rel?.to?.["@type"] === "project") {
        const funding = rel.funding;
        let funderName = "Unknown Funder";
        if (funding?.funder?.["@shortname"]) {
            funderName = funding.funder["@shortname"];
        } else if (funding?.funder?.["@name"]) {
            funderName = funding.funder["@name"];
        }
        
        let funderLevel = "";
        if (funding?.funding_level_0?.["@name"]) {
            funderLevel = funding.funding_level_0["@name"];
            if (funderLevel.toLowerCase().includes('project') || funderLevel.toLowerCase() === 'programmes') {
                funderLevel = funderName;
            }
        }

        let title = rel.title?.["$"] || "Unknown Project Title";
        let acronym = rel.acronym?.["$"];
        
        if (!acronym) {
            acronym = title.length > 50 ? title.substring(0, 47) + '...' : title;
        }

        return {
          id: rel.to["$"], 
          code: rel.code?.["$"],
          acronym: acronym,
          title: title,
          funder: funderName,
          funderLevel: funderLevel || funderName
        };
      }
    }
  } catch (e) {
    console.error("Error parsing OpenAIRE project", e);
  }
  return null;
}

/**
 * Get papers (PIDs/DOIs) for a specific project
 */
export async function getPapersByProject(projectCode, page = 1) {
  if (!projectCode) return { arxivIds: [], dois: [], total: 0 };

  const cacheKey = `papers_proj_${projectCode}_${page}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }

  try {
    const paramName = projectCode.includes('::') ? 'openaireProjectID' : 'projectID';
    const url = `https://api.openaire.eu/search/publications?format=json&size=30&page=${page}&${paramName}=${encodeURIComponent(projectCode)}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) return { arxivIds: [], dois: [], total: 0 };

    const data = await response.json();
    if (!data?.response?.results?.result) return { arxivIds: [], dois: [], total: 0 };

    let results = data.response.results.result;
    if (!Array.isArray(results)) results = [results];

    const arxivIds = [];
    const dois = [];
    
    const total = data.response.header?.total?.["$"] ? parseInt(data.response.header.total["$"]) : 0;

    results.forEach(res => {
      let pids = res?.metadata?.["oaf:entity"]?.["oaf:result"]?.pid;
      if (!pids) return;
      if (!Array.isArray(pids)) pids = [pids];

      let foundArxiv = null;
      let foundDoi = null;

      for (const pid of pids) {
        const type = pid["@classname"]?.toLowerCase();
        if (type === "digital object identifier" || type === "doi") {
          foundDoi = pid["$"];
        }
      }

      for (const pid of pids) {
        const type = pid["@classname"]?.toLowerCase();
        // Sometimes arxiv IDs are under "arxiv" classname, sometimes in handling. We just look for "arxiv"
        if (type === "arxiv") {
          if (foundDoi && typeof foundDoi === 'string' && foundDoi.includes('arxiv.')) {
            foundArxiv = foundDoi.split('arxiv.')[1];
          } else {
            foundArxiv = String(pid["$"]);
          }
          break;
        }
      }
      
      if (foundArxiv) {
        arxivIds.push(foundArxiv);
      } else if (foundDoi) {
        dois.push(foundDoi);
      }
    });

    const resultData = { arxivIds, dois, total };
    CACHE.set(cacheKey, { data: resultData, timestamp: Date.now() });
    return resultData;

  } catch (e) {
    console.error("Error fetching OpenAIRE papers for project:", e);
    return { arxivIds: [], dois: [], total: 0 };
  }
}

/**
 * Search for projects by keywords
 */
export async function searchProjects(query, page = 1) {
  if (!query) return { projects: [], total: 0 };
  const url = `https://api.openaire.eu/search/projects?format=json&size=5&page=${page}&keywords=${encodeURIComponent(query)}`;
  
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return { projects: [], total: 0 };
    
    const data = await response.json();
    if (!data?.response?.results?.result) return { projects: [], total: 0 };
    
    let results = data.response.results.result;
    if (!Array.isArray(results)) results = [results];
    
    const projects = results.map(res => {
      const p = res?.metadata?.["oaf:entity"]?.["oaf:project"];
      if (!p) return null;
      
      const { funderName, fundingStream } = extractFunder(p);
      
      const totalCost = parseFloat(p.totalcost?.["$"]) || 0;
      const fundedAmount = parseFloat(p.fundedamount?.["$"]) || 0;
      const budget = totalCost > 0 ? totalCost : fundedAmount;

      return {
        id: p.code?.["$"] || res.header?.["dri:objIdentifier"]?.["$"],
        code: p.code?.["$"],
        title: p.title?.["$"] || "Unknown Project",
        acronym: p.acronym?.["$"] || null,
        funder: funderName,
        fundingStream,
        budget,
        currency: validCurrency(p.currency?.["$"]),
      };
    }).filter(Boolean);

    const total = data.response.header?.total?.["$"] ? parseInt(data.response.header.total["$"]) : 0;
    return { projects, total };
  } catch (e) {
    console.error("Error searching OpenAIRE projects:", e);
    return { projects: [], total: 0 };
  }
}
