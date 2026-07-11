async function searchCrossref() {
  const url = `https://api.crossref.org/works?query.title="Aerospace Engineering"&select=DOI,title,abstract,author,issued,URL,subject,link&rows=5&mailto=papertok@example.com`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Total:", data.message['total-results']);
  console.log("First title:", data.message.items[0]?.title?.[0]);
  console.log("First abstract:", data.message.items[0]?.abstract ? "Yes" : "No");
}
searchCrossref();
