async function run() {
  const cats1 = ['physics.optics'];
  const cats2 = ['cs.AI'];
  const cats3 = ['math.CO'];
  
  async function fetchIt(cats) {
    const searchQuery = `(${cats.map(c => `cat:${c}`).join(' OR ')})`;
    const params = new URLSearchParams({ search_query: searchQuery, start: '0', max_results: '15', sortBy: 'submittedDate', sortOrder: 'descending' });
    const cleanUrl = `https://export.arxiv.org/api/query?${params.toString()}`.replace(/[\(\)]/g, '');
    const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(cleanUrl)}`;
    
    console.log("Fetching...", cats[0]);
    const res = await fetch(proxyUrl);
    const data = await res.json();
    console.log("Status:", data.status, "Items:", data.items ? data.items.length : 0);
    if (data.status !== 'ok') console.log(data);
  }

  await fetchIt(cats1);
  await fetchIt(cats2);
  await fetchIt(cats3);
}
run();
