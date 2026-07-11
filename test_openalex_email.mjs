async function testOpenAlexEndpoints() {
  const urls = [
    'https://api.openalex.org/institutions?search=mit&mailto=random123456789@example.com'
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
