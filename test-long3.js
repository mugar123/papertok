async function run() {
  const cats = [];
  for(let i=0; i<85; i++) cats.push('physics.optics'); // 85 * 25 chars ~ 2125 chars
  const searchQuery = `(${cats.map(c => `cat:${c}`).join(' OR ')})`;
  const params = new URLSearchParams({ search_query: searchQuery, start: '0', max_results: '15' });
  const arxivUrl = `https://export.arxiv.org/api/query?${params.toString()}`;
  
  const cleanUrl = arxivUrl.replace(/[\(\)]/g, '');
  const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(cleanUrl)}`;
  console.log("proxyUrl len:", proxyUrl.length);
  const res = await fetch(proxyUrl);
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Status from rss2json:", data.status, "message:", data.message);
}
run();
