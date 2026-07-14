async function test() {
  const fromStr = '2026-07-07';
  const toStr = '2026-07-14';
  const conceptFilter = 'concepts.id:C121332964';
  const filter = `from_publication_date:${fromStr},to_publication_date:${toStr},type:article,has_doi:true,${conceptFilter}`;
  const url = `https://api.openalex.org/works?filter=${filter}&sort=cited_by_count:desc&per-page=60&mailto=app@papertok.io`;
  
  console.log("URL:", url);
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log("Count:", data.meta.count);
    console.log("Results length:", data.results.length);
  } catch(e) {
    console.error(e);
  }
}
test();
