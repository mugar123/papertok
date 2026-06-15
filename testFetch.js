import fetch from 'node-fetch';

async function test() {
  const categoriesOrQuery = ['cs.AI', 'cs.CL'];
  let searchQuery = `(${categoriesOrQuery.map((cat) => `cat:${cat}`).join('+OR+')})`;
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: '2',
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });

  const url = `http://export.arxiv.org/api/query?${params.toString()}`;
  console.log("URL:", url);

  const cleanUrl = url.replace(/[\(\)]/g, '');
  const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(cleanUrl)}`;
  
  console.log("Fetching:", proxyUrl);
  const response = await fetch(proxyUrl);
  const data = await response.json();
  
  console.log(JSON.stringify(data, null, 2));
}
test();
