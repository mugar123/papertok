import { URL } from 'url';

const apiKey = process.env.VITE_ELSEVIER_API_KEY;

async function testElsevier() {
  const url = new URL('https://api.elsevier.com/content/search/scopus');
  url.searchParams.append('query', 'TITLE-ABS-KEY("Physics")');
  url.searchParams.append('count', 2);
  url.searchParams.append('apiKey', apiKey);

  console.log("Fetching: " + url.toString());

  try {
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' }
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Data keys:", Object.keys(data));
    if (data['search-results']) {
      const papers = data['search-results'].entry;
      if (papers && papers.length > 0) {
        console.log("First paper:", papers[0]['dc:title']);
        console.log("OpenAccess:", papers[0].openaccess);
      } else {
        console.log("No papers found in search-results.entry", JSON.stringify(data));
      }
    } else {
      console.log("No search-results:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}
testElsevier();
