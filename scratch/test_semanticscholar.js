async function searchSemanticScholar() {
  const query = "Aerospace Engineering";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,abstract,authors,year,isOpenAccess,openAccessPdf,url,venue,publicationTypes&limit=5`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Total:", data.total);
  console.log("First title:", data.data[0]?.title);
  console.log("First abstract:", data.data[0]?.abstract ? "Yes" : "No");
  if(data.data[0]?.abstract) console.log(data.data[0].abstract.substring(0, 100));
}
searchSemanticScholar();
