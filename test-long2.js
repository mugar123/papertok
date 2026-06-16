async function run() {
  const cats = [];
  for(let i=0; i<85; i++) cats.push('physics.optics'); // 85 * 25 chars ~ 2125 chars
  const searchQuery = `(${cats.map(c => `cat:${c}`).join(' OR ')})`;
  const params = new URLSearchParams({ search_query: searchQuery, start: '0', max_results: '15' });
  const arxivUrl = `https://export.arxiv.org/api/query?${params.toString()}`;
  console.log("Raw URL len:", arxivUrl.length);
  const res = await fetch(arxivUrl);
  console.log("Status:", res.status);
}
run();
