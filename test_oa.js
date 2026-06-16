const authorName = "C. J. Clarke";
const arxivId = "astro-ph/9912012v1";

async function fetchWithTimeout(url) {
  const res = await fetch(url);
  return { ok: res.ok, json: async () => await res.json() };
}

async function test() {
    const cleanArxivId = arxivId.replace(/v\d+$/, '');
    const workUrl = `https://api.openalex.org/works/doi:10.48550/arxiv.${cleanArxivId}`;
    let workResponse = await fetchWithTimeout(workUrl).catch(() => null);

    if (!workResponse || !workResponse.ok) {
       const searchUrl = `https://api.openalex.org/works?filter=doi:10.48550/arxiv.${cleanArxivId}`;
       const searchRes = await fetchWithTimeout(searchUrl).catch(() => null);
       if (searchRes && searchRes.ok) {
          const data = await searchRes.json();
          if (data.results && data.results.length > 0) {
             workResponse = { ok: true, json: async () => data.results[0] };
          }
       }
    }
    
    if (workResponse.ok) {
      const workData = await workResponse.json();
      console.log("Found work", workData.id);
      
      if (workData.authorships) {
        const reqParts = authorName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
        console.log("Req parts:", reqParts);
        
        let bestMatch = null;
        for (const authorship of workData.authorships) {
           const authorDisplayName = authorship.author.display_name;
           if (!authorDisplayName) continue;
           
           const oaParts = authorDisplayName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
           console.log("Comparing against:", authorDisplayName, oaParts);
           
           const reqInOa = reqParts.length > 0 && reqParts.every(p => oaParts.some(o => o.includes(p) || p.includes(o)));
           const oaInReq = oaParts.length > 0 && oaParts.every(o => reqParts.some(p => p.includes(o) || o.includes(p)));
           
           if (reqInOa || oaInReq) {
              bestMatch = authorship.author;
              break;
           }
        }
        
        if (bestMatch && bestMatch.id) {
           console.log("Found best match", bestMatch.id);
           const authorProfileUrl = bestMatch.id;
           const profileResponse = await fetchWithTimeout(authorProfileUrl);
           if (profileResponse.ok) {
              const author = await profileResponse.json();
              console.log("Author:", author.display_name, "Works:", author.works_count, "Citations:", author.cited_by_count);
              return;
           }
        } else {
           console.log("No best match found");
        }
      }
    }
}
test();
