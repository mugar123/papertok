async function run() {
  const arxivUrl = `https://export.arxiv.org/api/query?search_query=cat:physics.optics&start=0&max_results=15`;
  const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(arxivUrl)}`;
  const res = await fetch(proxyUrl);
  console.log("codetabs status:", res.status);
  if (res.status === 200) {
      const text = await res.text();
      console.log("Returned length:", text.length);
      console.log("Contains <entry>?:", text.includes("<entry>"));
  }
}
run();
