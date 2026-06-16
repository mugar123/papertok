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
        if (funding?.funding_level_0?.["@name"]) funderLevel = funding.funding_level_0["@name"];

        return {
          id: rel.to["$"], 
          code: rel.code?.["$"],
          acronym: rel.acronym?.["$"] || "Project",
          title: rel.title?.["$"] || "Unknown Project Title",
          funder: funderName,
          funderLevel: funderLevel
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
    const url = `https://api.openaire.eu/search/publications?format=json&size=30&page=${page}&projectID=${encodeURIComponent(projectCode)}`;
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

      let foundArxiv = false;
      let foundDoi = null;

      for (const pid of pids) {
        const type = pid["@classname"]?.toLowerCase();
        // Sometimes arxiv IDs are under "arxiv" classname, sometimes in handling. We just look for "arxiv"
        if (type === "arxiv") {
          arxivIds.push(pid["$"]);
          foundArxiv = true;
          break;
        }
        if (type === "digital object identifier" || type === "doi") {
          foundDoi = pid["$"];
        }
      }
      if (!foundArxiv && foundDoi) {
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
  const url = `https://api.openaire.eu/search/projects?format=json&size=20&page=${page}&keywords=${encodeURIComponent(query)}`;
  
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
      
      const funding = p.fundingtree?.funder || p.funding?.funder;
      let funderName = "Unknown Funder";
      if (funding?.["@shortname"]) {
          funderName = funding["@shortname"];
      } else if (funding?.["@name"]) {
          funderName = funding["@name"];
      }

      return {
        id: p.code?.["$"], // We use the code as ID for navigation
        title: p.title?.["$"] || "Unknown Project",
        acronym: p.acronym?.["$"] || "Project",
        funder: funderName,
      };
    }).filter(Boolean);

    const total = data.response.header?.total?.["$"] ? parseInt(data.response.header.total["$"]) : 0;
    return { projects, total };
  } catch (e) {
    console.error("Error searching OpenAIRE projects:", e);
    return { projects: [], total: 0 };
  }
}
