async function searchOpenAlex() {
  const url = `https://api.openalex.org/works?filter=concepts.id:C127413603&per-page=5&mailto=papertok@example.com`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("Response:", data.error || data.results?.length);
}
searchOpenAlex();
