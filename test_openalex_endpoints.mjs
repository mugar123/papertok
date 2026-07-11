async function testOpenAlexEndpoints() {
  const urls = [
    'https://api.openalex.org/institutions?search=mit&mailto=app@papertok.io',
    'https://api.openalex.org/authors?search=einstein&mailto=app@papertok.io',
    'https://api.openalex.org/works?search=physics&mailto=app@papertok.io'
  ];
  
  for (const url of urls) {
    console.log("Fetching", url);
    const res = await fetch(url);
    console.log("Status:", res.status);
    if (!res.ok) {
      const data = await res.json();
      console.log("Error:", data);
    }
  }
}
testOpenAlexEndpoints();
