import https from 'https';

async function search() {
  const url = "https://api.openaire.eu/search/projects?format=json&size=5&keywords=horizon";
  console.log("Fetching...");
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

search().then(data => {
  console.log("Success! Results:", data.response?.results?.result?.length);
  if (data.response?.results?.result) {
    const p = data.response.results.result[0].metadata["oaf:entity"]["oaf:project"];
    console.log(p.code?.["$"], p.acronym?.["$"], p.title?.["$"]);
  }
}).catch(console.error);
