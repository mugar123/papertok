import https from 'https';

async function search() {
  const url = "https://api.openaire.eu/search/publications?format=json&size=50&keywords=quantum+entanglement+arxiv";
  return new Promise(resolve => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
  });
}

search().then(data => {
  const results = data.response?.results?.result;
  if (!results) return console.log("No results");
  for (const r of results) {
    let rels = r.metadata?.["oaf:entity"]?.["oaf:result"]?.rels?.rel;
    if (!rels) continue;
    if (!Array.isArray(rels)) rels = [rels];
    const hasProj = rels.some(rel => rel.to?.["@type"] === "project");
    if (!hasProj) continue;

    let pids = r.metadata["oaf:entity"]["oaf:result"].pid;
    if (!pids) continue;
    if (!Array.isArray(pids)) pids = [pids];
    for (const p of pids) {
      if (p["@classname"].toLowerCase() === "arxiv") {
        console.log("Found funded arxiv ID:", p["$"]);
        return;
      }
    }
  }
  console.log("Not found");
});
