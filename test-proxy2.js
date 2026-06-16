async function run() {
  const arxivUrl = `https://export.arxiv.org/api/query?search_query=cat:physics.optics&start=0&max_results=15`;
  const proxyUrl = `https://thingproxy.freeboard.io/fetch/${arxivUrl}`;
  try {
     const res = await fetch(proxyUrl);
     console.log("thingproxy status:", res.status);
     if (res.status === 200) {
         const text = await res.text();
         console.log("Returned length:", text.length);
     }
  } catch(e) { console.log(e); }
}
run();
